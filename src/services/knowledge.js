import { query, tx } from '../db/pool.js'
import { badRequest, conflict, notFound } from '../lib/errors.js'
import { requireAdmin } from './access.js'
import { validateKnowledgeImport } from '../lib/knowledge-import.js'

export async function listPublic() {
  return (await query("SELECT id,slug,title FROM knowledge_points WHERE status='active' ORDER BY id")).rows
}

export async function getPublic(pointId) {
  const row = (await query(
    "SELECT id,slug,title,source FROM knowledge_points WHERE id=$1 AND status='active'", [pointId],
  )).rows[0]
  return publicDetail(row)
}

export async function getPublicBySlug(pointSlug) {
  const row = (await query(
    "SELECT id,slug,title,source FROM knowledge_points WHERE slug=$1 AND status='active'", [pointSlug],
  )).rows[0]
  return publicDetail(row)
}

async function publicDetail(row) {
  if (!row) throw notFound('知识点')
  const categories = (await query(
    `SELECT c.id,c.slug,c.name FROM knowledge_point_categories pc
       JOIN knowledge_categories c ON c.id=pc.category_id
      WHERE pc.knowledge_point_id=$1 AND c.status='active' ORDER BY c.pos,c.id`, [row.id],
  )).rows
  return { ...row, categories }
}

export async function manage(user) {
  requireAdmin(user)
  const rows = (await query(
    `SELECT p.id,p.slug,p.title,p.status,p.created_by,p.updated_by,p.created_at,p.updated_at,
            COALESCE(array_agg(pc.category_id ORDER BY pc.category_id)
              FILTER (WHERE pc.category_id IS NOT NULL), '{}'::bigint[]) AS category_ids
       FROM knowledge_points p LEFT JOIN knowledge_point_categories pc ON pc.knowledge_point_id=p.id
      GROUP BY p.id ORDER BY p.id`,
  )).rows
  return rows.map(row => ({ ...row, category_ids: row.category_ids.map(value => {
    const categoryId = Number(value)
    if (!Number.isSafeInteger(categoryId)) throw new Error('数据库整数超出安全范围')
    return categoryId
  }) }))
}

export async function getManaged(user, pointId) {
  requireAdmin(user)
  const row = (await query('SELECT * FROM knowledge_points WHERE id=$1', [pointId])).rows[0]
  if (!row) throw notFound('知识点')
  return row
}

export async function create(user, data) {
  requireAdmin(user)
  return (await query(
    'INSERT INTO knowledge_points(slug,title,source,created_by,updated_by) VALUES ($1,$2,$3,$4,$4) RETURNING *',
    [data.slug,data.title,data.source,user.id],
  )).rows[0]
}

export async function save(user, pointId, data) {
  requireAdmin(user)
  const row = (await query(
    'UPDATE knowledge_points SET title=$1,source=$2,updated_by=$3 WHERE id=$4 RETURNING *',
    [data.title,data.source,user.id,pointId],
  )).rows[0]
  if (!row) throw notFound('知识点')
  return row
}

export async function importPoints(user, categoryId, data) {
  requireAdmin(user)
  const batch = validateKnowledgeImport(data)
  return tx(async db => {
    await db.query("UPDATE content_graph_locks SET generation=generation+1 WHERE scope='knowledge_categories'")
    const target = (await db.query('SELECT id,parent_id,status FROM knowledge_categories WHERE id=$1 FOR SHARE', [categoryId])).rows[0]
    if (!target || target.parent_id !== null || target.status !== 'active') throw conflict('目标分类必须是有效的一级知识分类', { field: 'category_id', id: categoryId })
    const categories = new Map()
    for (const localId of batch.categoryOrder) {
      const category = batch.categoryById.get(localId)
      let row
      try {
        row = (await db.query(
          'INSERT INTO knowledge_categories(parent_id,slug,name,pos) VALUES ($1,$2,$3,$4) RETURNING id',
          [category.parent_id === null ? categoryId : categories.get(category.parent_id),category.slug,category.name,category.pos],
        )).rows[0]
      } catch (err) {
        if (err.code === '23505' && err.constraint === 'knowledge_categories_slug_key') throw conflict('分类别名已存在', { field: 'categories', index: category.index, id: localId, slug: category.slug })
        throw err
      }
      categories.set(localId, row.id)
    }
    const points = new Map()
    const pointIds = []
    const categoryIds = []
    for (const point of batch.pointById.values()) {
      let row
      try {
        row = (await db.query(
          'INSERT INTO knowledge_points(slug,title,source,created_by,updated_by) VALUES ($1,$2,$3,$4,$4) RETURNING id',
          [point.slug,point.title,point.source,user.id],
        )).rows[0]
      } catch (err) {
        if (err.code === '23505' && err.constraint === 'knowledge_points_slug_key') throw conflict('知识点别名已存在', { field: 'points', index: point.index, id: point.id, slug: point.slug })
        throw err
      }
      points.set(point.id, row.id)
      for (const localId of point.category_ids.length ? point.category_ids : [null]) {
        pointIds.push(row.id)
        categoryIds.push(localId === null ? categoryId : categories.get(localId))
      }
    }
    await db.query(
      'INSERT INTO knowledge_point_categories(knowledge_point_id,category_id) SELECT * FROM unnest($1::bigint[],$2::bigint[])',
      [pointIds,categoryIds],
    )
    if (batch.edges.length) {
      await db.query(
        `INSERT INTO knowledge_prerequisites(knowledge_point_id,prerequisite_id,created_by)
         SELECT target_id,source_id,$3 FROM unnest($1::bigint[],$2::bigint[]) AS e(source_id,target_id)`,
        [batch.edges.map(edge => points.get(edge.source)),batch.edges.map(edge => points.get(edge.target)),user.id],
      )
    }
    return {
      category_id: categoryId,
      counts: { categories: categories.size, points: points.size, edges: batch.edges.length },
      categories: [...categories].map(([id, category_id]) => ({ id, category_id })),
      points: [...points].map(([id, point_id]) => ({ id, point_id })),
    }
  })
}

export async function categories(kind) {
  const table = kind === 'knowledge' ? 'knowledge_categories' : 'lecture_categories'
  return (await query(`SELECT id, parent_id, slug, name, descr, pos FROM ${table} WHERE status='active' ORDER BY pos,id`)).rows
}

export async function createCategory(user, kind, data) {
  requireAdmin(user)
  const table = kind === 'knowledge' ? 'knowledge_categories' : 'lecture_categories'
  return (await query(
    `INSERT INTO ${table}(parent_id,slug,name,descr,pos) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [data.parent_id ?? null, data.slug, data.name, data.descr ?? '', data.pos ?? 0],
  )).rows[0]
}

export async function updateCategory(user, kind, categoryId, data) {
  requireAdmin(user)
  const table = kind === 'knowledge' ? 'knowledge_categories' : 'lecture_categories'
  return tx(async (db) => {
    const current = (await db.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`, [categoryId])).rows[0]
    if (!current) throw notFound('分类')
    return (await db.query(
      `UPDATE ${table} SET parent_id=$1,name=$2,descr=$3,pos=$4,status=$5 WHERE id=$6 RETURNING *`,
      [data.parent_id, data.name, data.descr, data.pos, data.status, categoryId],
    )).rows[0]
  })
}

export async function setPointStatus(user, pointId, status) {
  requireAdmin(user)
  if (!['active','archived'].includes(status)) throw badRequest('知识点状态不合法')
  const row = (await query('UPDATE knowledge_points SET status=$1,updated_by=$2 WHERE id=$3 RETURNING *', [status,user.id,pointId])).rows[0]
  if (!row) throw notFound('知识点')
  return row
}

// 永久删除知识点及其分类和前置关联
export async function deletePoint(user, pointId) {
  requireAdmin(user)
  return tx(async db => {
    await db.query("UPDATE content_graph_locks SET generation=generation+1 WHERE scope='knowledge_prerequisites'")
    const point = (await db.query('SELECT id FROM knowledge_points WHERE id=$1 FOR UPDATE', [pointId])).rows[0]
    if (!point) throw notFound('知识点')
    await db.query('DELETE FROM knowledge_point_categories WHERE knowledge_point_id=$1', [pointId])
    await db.query('DELETE FROM knowledge_prerequisites WHERE knowledge_point_id=$1 OR prerequisite_id=$1', [pointId])
    await db.query('DELETE FROM knowledge_points WHERE id=$1', [pointId])
  })
}

// 删除分类树并保留关联其他分类的知识点
export async function deleteKnowledgeCategory(user, categoryId) {
  requireAdmin(user)
  return tx(async db => {
    await db.query("UPDATE content_graph_locks SET generation=generation+1 WHERE scope='knowledge_categories'")
    await db.query("UPDATE content_graph_locks SET generation=generation+1 WHERE scope='knowledge_prerequisites'")
    const tree = (await db.query(
      `WITH RECURSIVE subtree AS (
         SELECT id,parent_id,0 AS depth FROM knowledge_categories WHERE id=$1
         UNION ALL
         SELECT c.id,c.parent_id,s.depth+1 FROM knowledge_categories c JOIN subtree s ON c.parent_id=s.id
       ) SELECT id,depth FROM subtree ORDER BY depth DESC,id`, [categoryId],
    )).rows
    if (!tree.length) throw notFound('知识分类')
    const categoryIds = tree.map(category => category.id)
    await db.query('SELECT id FROM knowledge_categories WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE', [categoryIds])
    const candidates = (await db.query(
      `SELECT p.id FROM knowledge_points p WHERE EXISTS (
         SELECT 1 FROM knowledge_point_categories pc WHERE pc.knowledge_point_id=p.id AND pc.category_id=ANY($1::bigint[])
       ) ORDER BY p.id FOR UPDATE`, [categoryIds],
    )).rows.map(point => point.id)
    const associations = candidates.length ? (await db.query(
      'SELECT knowledge_point_id,category_id FROM knowledge_point_categories WHERE knowledge_point_id=ANY($1::bigint[]) ORDER BY knowledge_point_id,category_id FOR UPDATE',
      [candidates],
    )).rows : []
    const inside = new Set(categoryIds)
    const groups = new Map()
    for (const row of associations) {
      if (!groups.has(row.knowledge_point_id)) groups.set(row.knowledge_point_id, [])
      groups.get(row.knowledge_point_id).push(row.category_id)
    }
    const removedPoints = [...groups].filter(([, ids]) => ids.some(id => inside.has(id)) && ids.every(id => inside.has(id))).map(([id]) => id)
    await db.query('DELETE FROM knowledge_point_categories WHERE category_id=ANY($1::bigint[])', [categoryIds])
    if (removedPoints.length) {
      await db.query('DELETE FROM knowledge_prerequisites WHERE knowledge_point_id=ANY($1::bigint[]) OR prerequisite_id=ANY($1::bigint[])', [removedPoints])
      await db.query('DELETE FROM knowledge_points WHERE id=ANY($1::bigint[])', [removedPoints])
    }
    for (const category of tree) await db.query('DELETE FROM knowledge_categories WHERE id=$1', [category.id])
  })
}

export async function setPrerequisites(user, pointId, ids) {
  requireAdmin(user)
  if (new Set(ids).size !== ids.length) throw badRequest('前置知识点不能重复')
  return tx(async (db) => {
    await db.query("UPDATE content_graph_locks SET generation=generation+1 WHERE scope='knowledge_prerequisites'")
    if (!(await db.query('SELECT id FROM knowledge_points WHERE id=$1 FOR UPDATE', [pointId])).rowCount) throw notFound('知识点')
    await db.query('DELETE FROM knowledge_prerequisites WHERE knowledge_point_id = $1', [pointId])
    for (const prereq of ids) {
      await db.query('INSERT INTO knowledge_prerequisites(knowledge_point_id,prerequisite_id,created_by) VALUES ($1,$2,$3)', [pointId, prereq, user.id])
    }
    await db.query('UPDATE knowledge_points SET updated_by=$1 WHERE id=$2', [user.id,pointId])
    return { knowledge_point_id: pointId, prerequisites: ids }
  })
}

export async function getPrerequisites(pointId) {
  await getPublic(pointId)
  return (await query(
    `SELECT p.id,p.slug,p.title
       FROM knowledge_prerequisites d JOIN knowledge_points p ON p.id=d.prerequisite_id
      WHERE d.knowledge_point_id=$1 AND p.status='active' ORDER BY p.id`, [pointId],
  )).rows
}

export async function setCategories(user, pointId, ids) {
  requireAdmin(user)
  if (new Set(ids).size !== ids.length) throw badRequest('知识分类不能重复')
  return tx(async (db) => {
    await db.query("UPDATE content_graph_locks SET generation=generation+1 WHERE scope='knowledge_categories'")
    if (!(await db.query('SELECT id FROM knowledge_points WHERE id=$1 FOR UPDATE', [pointId])).rowCount) throw notFound('知识点')
    await db.query('DELETE FROM knowledge_point_categories WHERE knowledge_point_id=$1', [pointId])
    for (const categoryId of ids) {
      await db.query('INSERT INTO knowledge_point_categories(knowledge_point_id,category_id) VALUES ($1,$2)', [pointId,categoryId])
    }
    await db.query('UPDATE knowledge_points SET updated_by=$1 WHERE id=$2', [user.id,pointId])
    return { knowledge_point_id: pointId, categories: ids }
  })
}
