import { query, tx } from '../db/pool.js'
import { badRequest, conflict, notFound } from '../lib/errors.js'
import { requireAdmin } from './access.js'
import { nextPosition } from './question-order.js'

const stamp = `to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at`
const categoryFields = `id,parent_id,slug,name,pos,created_at,${stamp}`
const questionFields = `id,slug,difficulty,stem_source,focus_source,solution_source,conclusion_source,pitfalls_source,created_by,updated_by,created_at,${stamp}`
const entryFields = `id,category_id,question_id,source_number,pos,created_at,${stamp}`

async function lockWrites(db) {
  const result = await db.query("UPDATE content_graph_locks SET generation=generation+1 WHERE scope='question_categories' RETURNING generation")
  if (!result.rowCount) throw conflict('题库关系锁不存在')
}

async function category(db, categoryId, lock = false) {
  const row = (await db.query(`SELECT ${categoryFields} FROM question_categories WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [categoryId])).rows[0]
  if (!row) throw notFound('题目来源目录')
  return row
}

async function question(db, questionId, lock = false) {
  const row = (await db.query(`SELECT ${questionFields} FROM questions WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [questionId])).rows[0]
  if (!row) throw notFound('题目')
  return row
}

async function subtree(db, categoryId) {
  const rows = (await db.query(`WITH RECURSIVE tree AS (
    SELECT id,parent_id,0 AS depth FROM question_categories WHERE id=$1
    UNION ALL SELECT c.id,c.parent_id,t.depth+1 FROM question_categories c JOIN tree t ON c.parent_id=t.id
  ) SELECT id,depth FROM tree ORDER BY depth DESC,id`, [categoryId])).rows
  if (!rows.length) throw notFound('题目来源目录')
  return rows
}

async function breadcrumbs(db, categoryId) {
  if (categoryId === null) return []
  return (await db.query(`WITH RECURSIVE path AS (
    SELECT id,parent_id,slug,name,0 AS depth FROM question_categories WHERE id=$1
    UNION ALL SELECT c.id,c.parent_id,c.slug,c.name,p.depth+1 FROM question_categories c JOIN path p ON p.parent_id=c.id
  ) SELECT id,slug,name FROM path ORDER BY depth DESC`, [categoryId])).rows
}

async function attachDetails(db, rows) {
  if (!rows.length) return []
  const ids = rows.map(row => row.id)
  const points = (await db.query(`SELECT q.question_id,p.slug,p.title
    FROM question_knowledge_points q JOIN knowledge_points p ON p.id=q.knowledge_point_id
    WHERE q.question_id=ANY($1::bigint[]) ORDER BY q.question_id,p.slug`, [ids])).rows
  const sources = (await db.query(`WITH RECURSIVE paths AS (
    SELECT e.id AS entry_id,e.question_id,e.category_id,e.source_number,c.id,c.parent_id,c.slug,c.name,0 AS depth
      FROM question_entries e JOIN question_categories c ON c.id=e.category_id WHERE e.question_id=ANY($1::bigint[])
    UNION ALL SELECT p.entry_id,p.question_id,p.category_id,p.source_number,c.id,c.parent_id,c.slug,c.name,p.depth+1
      FROM paths p JOIN question_categories c ON c.id=p.parent_id
  ) SELECT * FROM paths ORDER BY question_id,entry_id,depth DESC`, [ids])).rows
  const byQuestion = new Map(rows.map(row => [row.id, { question: row, knowledge_points: [], sources: [] }]))
  for (const point of points) {
    const { question_id, ...value } = point
    byQuestion.get(question_id).knowledge_points.push(value)
  }
  let last = null
  for (const row of sources) {
    if (!last || last.entry_id !== row.entry_id) {
      last = { entry_id: row.entry_id, category_id: row.category_id, source_number: row.source_number, path: [] }
      byQuestion.get(row.question_id).sources.push(last)
    }
    last.path.push({ id: row.id, slug: row.slug, name: row.name })
  }
  return rows.map(row => byQuestion.get(row.id))
}

async function replaceKnowledge(db, questionId, slugs) {
  const rows = (await db.query(
    'SELECT id,slug FROM knowledge_points WHERE slug=ANY($1::text[]) ORDER BY id FOR SHARE', [slugs],
  )).rows
  if (rows.length !== slugs.length) throw badRequest('知识点不存在')
  await db.query('DELETE FROM question_knowledge_points WHERE question_id=$1', [questionId])
  if (rows.length) await db.query('INSERT INTO question_knowledge_points(question_id,knowledge_point_id) SELECT $1,unnest($2::bigint[])', [questionId,rows.map(row => row.id)])
}

export async function categories() {
  return (await query(`SELECT ${categoryFields} FROM question_categories ORDER BY parent_id NULLS FIRST,pos,id`)).rows
}

export async function createCategory(user, data) {
  requireAdmin(user)
  return tx(async db => {
    await lockWrites(db)
    if (data.parent_id !== null) await category(db,data.parent_id,true)
    const pos = data.pos === null ? await nextPosition(db,'question_categories','parent_id',data.parent_id) : data.pos
    return (await db.query(`INSERT INTO question_categories(parent_id,slug,name,pos) VALUES ($1,$2,$3,$4) RETURNING ${categoryFields}`, [data.parent_id,data.slug,data.name,pos])).rows[0]
  })
}

export async function updateCategory(user, categoryId, data) {
  requireAdmin(user)
  return tx(async db => {
    await lockWrites(db)
    const row = await category(db,categoryId,true)
    if (row.updated_at !== data.updated_at) throw conflict('来源目录已修改请重新加载')
    if (data.parent_id !== null) await category(db,data.parent_id,true)
    return (await db.query(`UPDATE question_categories SET parent_id=$1,name=$2,pos=$3 WHERE id=$4 RETURNING ${categoryFields}`, [data.parent_id,data.name,data.pos,categoryId])).rows[0]
  })
}

async function categoryImpact(db, categoryId) {
  const nodes = await subtree(db,categoryId)
  const ids = nodes.map(item => item.id)
  const count = (await db.query('SELECT count(*) AS count FROM question_entries WHERE category_id=ANY($1::bigint[])', [ids])).rows[0].count
  return { categories: nodes.length, entries: count, nodes }
}

export async function previewCategoryDelete(user, categoryId) {
  requireAdmin(user)
  return tx(async db => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const { categories, entries } = await categoryImpact(db,categoryId)
    return { categories, entries }
  })
}

export async function deleteCategory(user, categoryId) {
  requireAdmin(user)
  return tx(async db => {
    await lockWrites(db)
    const impact = await categoryImpact(db,categoryId)
    const ids = impact.nodes.map(row => row.id)
    await db.query('DELETE FROM question_entries WHERE category_id=ANY($1::bigint[])', [ids])
    for (const node of impact.nodes) await db.query('DELETE FROM question_categories WHERE id=$1', [node.id])
    return { categories: impact.categories, entries: impact.entries }
  })
}

export async function listEntries(options) {
  return tx(async db => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const current_category = options.categoryId === null ? null : await category(db,options.categoryId)
    const children = (await db.query(`SELECT ${categoryFields} FROM question_categories WHERE parent_id IS NOT DISTINCT FROM $1 ORDER BY pos,id`, [options.categoryId])).rows
    const path = await breadcrumbs(db,options.categoryId)
    const searching = Boolean(options.q)
    if (!searching && options.categoryId === null) return { current_category, breadcrumbs: path, children, items: [], pagination: { total: 0, limit: options.limit, offset: options.offset }, search_scope: 'root' }
    const predicate = searching ? `($1::bigint IS NULL OR e.category_id IN (SELECT id FROM scope)) AND (strpos(lower(q.slug),lower($2))>0 OR strpos(lower(q.stem_source),lower($2))>0 OR strpos(lower(e.source_number),lower($2))>0)` : 'e.category_id=$1 AND $2::text IS NOT NULL'
    const cte = `WITH RECURSIVE scope AS (SELECT id FROM question_categories WHERE id=$1 UNION ALL SELECT c.id FROM question_categories c JOIN scope s ON c.parent_id=s.id)`
    const params = [options.categoryId,options.q,options.limit,options.offset]
    const items = (await db.query(`${cte} SELECT e.id,e.category_id,e.question_id,e.source_number,e.pos,${stamp.replace('updated_at','e.updated_at')},q.slug,q.difficulty,left(q.stem_source,200) AS stem_summary
      FROM question_entries e JOIN questions q ON q.id=e.question_id WHERE ${predicate} ORDER BY e.pos,e.id LIMIT $3 OFFSET $4`, params)).rows
    const total = (await db.query(`${cte} SELECT count(*) AS count FROM question_entries e JOIN questions q ON q.id=e.question_id WHERE ${predicate}`, params.slice(0,2))).rows[0].count
    return { current_category, breadcrumbs: path, children, items, pagination: { total, limit: options.limit, offset: options.offset }, search_scope: searching ? (options.categoryId === null ? 'all' : 'subtree') : 'category' }
  })
}

export async function createQuestion(user, data) {
  requireAdmin(user)
  return tx(async db => {
    await lockWrites(db)
    await category(db,data.category_id,true)
    const row = (await db.query(`INSERT INTO questions(slug,difficulty,stem_source,focus_source,solution_source,conclusion_source,pitfalls_source,created_by,updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING ${questionFields}`, [data.slug,data.difficulty,data.stem_source,data.focus_source,data.solution_source,data.conclusion_source,data.pitfalls_source,user.id])).rows[0]
    await replaceKnowledge(db,row.id,data.knowledge_slugs)
    const pos = await nextPosition(db,'question_entries','category_id',data.category_id)
    const entry = (await db.query(`INSERT INTO question_entries(category_id,question_id,source_number,pos) VALUES ($1,$2,$3,$4) RETURNING ${entryFields}`, [data.category_id,row.id,data.source_number,pos])).rows[0]
    return { question: row, entry }
  })
}

export async function details(field, value) {
  return tx(async db => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const column = field === 'id' ? 'id' : 'slug'
    const rows = (await db.query(`SELECT ${questionFields} FROM questions WHERE ${column}=$1`, [value])).rows
    if (!rows.length) throw notFound('题目')
    return (await attachDetails(db,rows))[0]
  })
}

export async function batch(slugs) {
  return tx(async db => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const rows = (await db.query(`SELECT ${questionFields} FROM questions WHERE slug=ANY($1::text[]) ORDER BY slug`, [slugs])).rows
    const found = new Set(rows.map(row => row.slug))
    const items = await attachDetails(db,rows)
    if (Buffer.byteLength(JSON.stringify(items),'utf8') > 16 * 1024 * 1024) throw badRequest('题目内容过大请缩小批次')
    return { items, missing_slugs: slugs.filter(value => !found.has(value)) }
  })
}

export async function updateQuestion(user, questionId, data) {
  requireAdmin(user)
  return tx(async db => {
    await lockWrites(db)
    const old = await question(db,questionId,true)
    if (old.updated_at !== data.updated_at) throw conflict('题目已修改请重新加载')
    const row = (await db.query(`UPDATE questions SET difficulty=$1,stem_source=$2,focus_source=$3,solution_source=$4,conclusion_source=$5,pitfalls_source=$6,updated_by=$7 WHERE id=$8 RETURNING ${questionFields}`,
      [data.difficulty,data.stem_source,data.focus_source ?? old.focus_source,data.solution_source,data.conclusion_source,data.pitfalls_source,user.id,questionId])).rows[0]
    await replaceKnowledge(db,questionId,data.knowledge_slugs)
    return (await attachDetails(db,[row]))[0]
  })
}

export async function orphaned(user, options) {
  requireAdmin(user)
  return tx(async db => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const where = `NOT EXISTS (SELECT 1 FROM question_entries e WHERE e.question_id=q.id) AND ($1='' OR strpos(lower(q.slug),lower($1))>0 OR strpos(lower(q.stem_source),lower($1))>0)`
    const rows = (await db.query(`SELECT q.id,q.slug,q.difficulty,left(q.stem_source,200) AS stem_summary,q.created_at FROM questions q WHERE ${where} ORDER BY q.id LIMIT $2 OFFSET $3`, [options.q,options.limit,options.offset])).rows
    const total = (await db.query(`SELECT count(*) AS count FROM questions q WHERE ${where}`, [options.q])).rows[0].count
    return { items: rows, pagination: { total, limit: options.limit, offset: options.offset } }
  })
}

export async function createEntry(user, data) {
  requireAdmin(user)
  return tx(async db => {
    await lockWrites(db)
    await category(db,data.category_id,true)
    const row = (await db.query('SELECT id FROM questions WHERE slug=$1 FOR UPDATE', [data.question_slug])).rows[0]
    if (!row) throw notFound('题目')
    const pos = await nextPosition(db,'question_entries','category_id',data.category_id)
    return (await db.query(`INSERT INTO question_entries(category_id,question_id,source_number,pos) VALUES ($1,$2,$3,$4) RETURNING ${entryFields}`, [data.category_id,row.id,data.source_number,pos])).rows[0]
  })
}

export async function updateEntry(user, entryId, data) {
  requireAdmin(user)
  return tx(async db => {
    await lockWrites(db)
    const old = (await db.query(`SELECT ${entryFields} FROM question_entries WHERE id=$1 FOR UPDATE`, [entryId])).rows[0]
    if (!old) throw notFound('题目来源')
    if (old.updated_at !== data.updated_at) throw conflict('题目来源已修改请重新加载')
    await category(db,data.category_id,true)
    return (await db.query(`UPDATE question_entries SET category_id=$1,source_number=$2,pos=$3 WHERE id=$4 RETURNING ${entryFields}`, [data.category_id,data.source_number,data.pos,entryId])).rows[0]
  })
}

export async function deleteEntry(user, entryId) {
  requireAdmin(user)
  return tx(async db => {
    await lockWrites(db)
    const result = await db.query('DELETE FROM question_entries WHERE id=$1 RETURNING id', [entryId])
    if (!result.rowCount) throw notFound('题目来源')
  })
}

export async function previewQuestionDelete(user, questionId) {
  requireAdmin(user)
  return tx(async db => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const row = await question(db,questionId)
    const [detail] = await attachDetails(db,[row])
    return { question_id: row.id, slug: row.slug, sources: detail.sources, knowledge_points: detail.knowledge_points }
  })
}

export async function deleteQuestion(user, questionId) {
  requireAdmin(user)
  return tx(async db => {
    await lockWrites(db)
    await question(db,questionId,true)
    const entries = await db.query('DELETE FROM question_entries WHERE question_id=$1 RETURNING id', [questionId])
    const points = await db.query('DELETE FROM question_knowledge_points WHERE question_id=$1 RETURNING knowledge_point_id', [questionId])
    await db.query('DELETE FROM questions WHERE id=$1', [questionId])
    return { question_id: questionId, entries: entries.rowCount, knowledge_points: points.rowCount }
  })
}
