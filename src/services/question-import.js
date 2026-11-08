import { tx } from '../db/pool.js'
import { badRequest, conflict, notFound } from '../lib/errors.js'
import { validateQuestionImport } from '../lib/question-import.js'
import { requireAdmin } from './access.js'

export async function importQuestions(user, categoryId, data) {
  requireAdmin(user)
  const batch = validateQuestionImport(data)
  return tx(async db => {
    const lock = await db.query("UPDATE content_graph_locks SET generation=generation+1 WHERE scope='question_categories' RETURNING generation")
    if (!lock.rowCount) throw conflict('题库关系锁不存在')
    if (!(await db.query('SELECT id FROM question_categories WHERE id=$1 FOR UPDATE', [categoryId])).rowCount) throw notFound('题目来源目录')
    const knowledgeSlugs = [...new Set(batch.questions.flatMap(item => item.knowledge_slugs))].sort()
    const knowledgeRows = (await db.query('SELECT id,slug FROM knowledge_points WHERE slug=ANY($1::text[]) ORDER BY id FOR SHARE', [knowledgeSlugs])).rows
    const knowledge = new Map(knowledgeRows.map(row => [row.slug,row.id]))
    const missing = knowledgeSlugs.filter(value => !knowledge.has(value))
    if (missing.length) throw badRequest('导入知识点不存在', { field: 'knowledge_slugs', missing })
    const categories = new Map()
    for (const localId of batch.categoryOrder) {
      const item = batch.categories.get(localId)
      try {
        const row = (await db.query('INSERT INTO question_categories(parent_id,slug,name,pos) VALUES ($1,$2,$3,$4) RETURNING id',
          [item.parent_id === null ? categoryId : categories.get(item.parent_id),item.slug,item.name,item.pos])).rows[0]
        categories.set(localId,row.id)
      } catch (err) {
        if (err.code === '23505') throw conflict('导入目录标识或同级名称已存在', { field: 'categories', index: item.index, slug: item.slug })
        throw err
      }
    }
    const questions = []
    const questionIds = [], pointIds = [], sourceQuestionIds = [], sourceCategoryIds = [], sourceNumbers = [], sourcePositions = []
    for (const item of batch.questions) {
      let row
      try {
        row = (await db.query(`INSERT INTO questions(slug,difficulty,stem_source,focus_source,solution_source,conclusion_source,pitfalls_source,created_by,updated_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id`,
        [item.slug,item.difficulty,item.stem_source,item.focus_source,item.solution_source,item.conclusion_source,item.pitfalls_source,user.id])).rows[0]
      } catch (err) {
        if (err.code === '23505') throw conflict('导入题目标识已存在', { field: 'questions', index: item.index, slug: item.slug })
        throw err
      }
      questions.push({ slug: item.slug, question_id: row.id })
      for (const value of item.knowledge_slugs) { questionIds.push(row.id); pointIds.push(knowledge.get(value)) }
      for (const source of item.sources) {
        sourceQuestionIds.push(row.id)
        sourceCategoryIds.push(source.category_id === null ? categoryId : categories.get(source.category_id))
        sourceNumbers.push(source.source_number)
        sourcePositions.push(source.pos)
      }
    }
    if (questionIds.length) await db.query('INSERT INTO question_knowledge_points(question_id,knowledge_point_id) SELECT * FROM unnest($1::bigint[],$2::bigint[])', [questionIds,pointIds])
    await db.query('INSERT INTO question_entries(question_id,category_id,source_number,pos) SELECT * FROM unnest($1::bigint[],$2::bigint[],$3::text[],$4::integer[])',
      [sourceQuestionIds,sourceCategoryIds,sourceNumbers,sourcePositions])
    return { category_id: categoryId, counts: { categories: categories.size, questions: questions.length, entries: batch.entryCount },
      categories: [...categories].map(([id, category_id]) => ({ id, category_id })), questions }
  })
}
