import * as service from '../services/questions.js'
import { importQuestions } from '../services/question-import.js'
import { clearOrphaned } from '../services/question-clear.js'
import { moveCategory, moveEntry } from '../services/question-order.js'
import { badRequest } from '../lib/errors.js'
import { body, choice, id, integer, list, slug, string } from '../lib/validate.js'
import { IMPORT_BODY_MAX, IMPORT_DATA_MAX } from '../lib/import-limits.js'

const optionalParent = value => value === undefined || value === null ? null : id(value)
const text = (value, max = IMPORT_DATA_MAX) => string(value, max, true)
const name = value => string(value, 200).trim()
const timestamp = value => string(value, 40)

function pagination(query) {
  const limit = query.limit === undefined ? 50 : Number(query.limit)
  const offset = query.offset === undefined ? 0 : Number(query.offset)
  return { limit: integer(limit,1,100), offset: integer(offset,0,1000000), q: query.q === undefined ? '' : text(query.q,200).trim() }
}

function slugs(value) {
  const values = list(value,Number.MAX_SAFE_INTEGER).map(slug)
  if (new Set(values).size !== values.length) throw badRequest('知识点标识不能重复')
  return values
}

function moveData(value) {
  const d = body(value,['direction','updated_at','neighbor_id','neighbor_updated_at'],['direction','updated_at','neighbor_id','neighbor_updated_at'])
  return { direction: choice(d.direction,['up','down']), updated_at: timestamp(d.updated_at),
    neighbor_id: id(d.neighbor_id), neighbor_updated_at: timestamp(d.neighbor_updated_at) }
}

function questionData(data, create) {
  const fields = ['difficulty','stem_source','focus_source','solution_source','conclusion_source','pitfalls_source','knowledge_slugs']
  const required = ['difficulty','stem_source','knowledge_slugs']
  const extra = create ? ['slug','category_id','source_number'] : ['updated_at']
  const d = body(data,[...fields,...extra],create ? [...required,'slug','category_id'] : [...fields.filter(field => field !== 'focus_source'),'updated_at'])
  integer(d.difficulty,1,5)
  string(d.stem_source,IMPORT_DATA_MAX)
  if (d.focus_source !== undefined) d.focus_source = text(d.focus_source)
  else if (create) d.focus_source = ''
  for (const field of ['solution_source','conclusion_source','pitfalls_source']) d[field] = d[field] === undefined ? '' : text(d[field])
  d.knowledge_slugs = slugs(d.knowledge_slugs)
  if (create) {
    slug(d.slug)
    d.category_id = id(d.category_id)
    d.source_number = d.source_number === undefined ? '' : text(d.source_number,200)
  } else timestamp(d.updated_at)
  return d
}

export default async function questionRoutes(app) {
  app.get('/question-categories', async (req,reply) => {
    reply.header('Cache-Control','no-store')
    return service.categories()
  })
  app.post('/question-categories', { preHandler: [app.requireAdmin] }, async (req, reply) => {
    const d = body(req.body,['parent_id','slug','name','pos'],['slug','name'])
    slug(d.slug)
    const result = await service.createCategory(req.user,{ parent_id: optionalParent(d.parent_id), slug: d.slug, name: name(d.name), pos: d.pos === undefined ? null : integer(d.pos) })
    return reply.code(201).send(result)
  })
  app.put('/question-categories/:id', { preHandler: [app.requireAdmin] }, async req => {
    const d = body(req.body,['parent_id','name','pos','updated_at'],['parent_id','name','pos','updated_at'])
    return service.updateCategory(req.user,id(req.params.id),{ parent_id: optionalParent(d.parent_id), name: name(d.name), pos: integer(d.pos), updated_at: timestamp(d.updated_at) })
  })
  app.post('/question-categories/:id/reorder', { preHandler: [app.requireAdmin] }, async req =>
    moveCategory(req.user,id(req.params.id),moveData(req.body)))
  app.get('/question-categories/:id/delete-impact', { preHandler: [app.requireAdmin] }, async req => service.previewCategoryDelete(req.user,id(req.params.id)))
  app.delete('/question-categories/:id', { preHandler: [app.requireAdmin] }, async req => service.deleteCategory(req.user,id(req.params.id)))

  app.get('/question-entries', async (req,reply) => {
    reply.header('Cache-Control','no-store')
    return service.listEntries({ ...pagination(req.query), categoryId: optionalParent(req.query.category_id) })
  })
  app.get('/question-entries/:id/neighbors', async (req,reply) => {
    reply.header('Cache-Control','no-store')
    return service.entryNeighbors(id(req.params.id))
  })
  app.post('/question-entries', { preHandler: [app.requireAdmin] }, async (req,reply) => {
    const d = body(req.body,['question_slug','category_id','source_number'],['question_slug','category_id'])
    const result = await service.createEntry(req.user,{ question_slug: slug(d.question_slug), category_id: id(d.category_id), source_number: d.source_number === undefined ? '' : text(d.source_number,200) })
    return reply.code(201).send(result)
  })
  app.patch('/question-entries/:id', { preHandler: [app.requireAdmin] }, async req => {
    const d = body(req.body,['category_id','source_number','pos','updated_at'],['category_id','source_number','pos','updated_at'])
    return service.updateEntry(req.user,id(req.params.id),{ category_id: id(d.category_id), source_number: text(d.source_number,200), pos: integer(d.pos), updated_at: timestamp(d.updated_at) })
  })
  app.post('/question-entries/:id/reorder', { preHandler: [app.requireAdmin] }, async req =>
    moveEntry(req.user,id(req.params.id),moveData(req.body)))
  app.delete('/question-entries/:id', { preHandler: [app.requireAdmin] }, async (req,reply) => {
    await service.deleteEntry(req.user,id(req.params.id))
    return reply.code(204).send()
  })

  app.get('/questions', { preHandler: [app.requireAdmin] }, async req => {
    if (req.query.orphaned !== 'true') throw badRequest('仅支持查询无来源题目')
    return service.orphaned(req.user,pagination(req.query))
  })
  app.post('/questions/orphaned/clear', { preHandler: [app.requireAdmin] }, async req => {
    if (req.body !== undefined && req.body !== null) body(req.body,[])
    return clearOrphaned(req.user)
  })
  app.get('/questions/by-slug/:slug', async (req,reply) => {
    reply.header('Cache-Control','no-store')
    return service.details('slug',slug(req.params.slug))
  })
  app.get('/questions/:id/delete-impact', { preHandler: [app.requireAdmin] }, async req => service.previewQuestionDelete(req.user,id(req.params.id)))
  app.get('/questions/:id', async (req,reply) => {
    reply.header('Cache-Control','no-store')
    return service.details('id',id(req.params.id))
  })
  app.post('/questions/batch', async (req,reply) => {
    reply.header('Cache-Control','no-store')
    const d = body(req.body,['slugs'],['slugs'])
    const values = [...new Set(list(d.slugs,100).map(slug))]
    return service.batch(values)
  })
  app.post('/questions/import', { bodyLimit: IMPORT_BODY_MAX, preHandler: [app.requireAdmin] }, async (req,reply) => {
    const d = body(req.body,['category_id','data'],['category_id','data'])
    const result = await importQuestions(req.user,id(d.category_id),d.data)
    return reply.code(201).send(result)
  })
  app.post('/questions', { bodyLimit: IMPORT_BODY_MAX, preHandler: [app.requireAdmin] }, async (req,reply) => {
    const result = await service.createQuestion(req.user,questionData(req.body,true))
    return reply.code(201).send(result)
  })
  app.put('/questions/:id', { bodyLimit: IMPORT_BODY_MAX, preHandler: [app.requireAdmin] }, async req => service.updateQuestion(req.user,id(req.params.id),questionData(req.body,false)))
  app.delete('/questions/:id', { preHandler: [app.requireAdmin] }, async req => service.deleteQuestion(req.user,id(req.params.id)))
}
