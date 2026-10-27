import * as service from '../services/knowledge.js'
import { knowledgeMap } from '../services/knowledge-map.js'
import { body, id, integer, string, slug, list, choice } from '../lib/validate.js'

export default async function knowledgeRoutes(app) {
  app.get('/knowledge-map', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    return knowledgeMap(req.query.category_id === undefined ? null : id(req.query.category_id))
  })
  app.get('/knowledge-points', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    return service.listPublic()
  })
  app.get('/knowledge-points/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    return service.getPublic(id(req.params.id))
  })
  app.get('/knowledge-points/manage', { preHandler: [app.requireLogin] }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    return service.manage(req.user)
  })
  app.get('/knowledge-points/manage/:id', { preHandler: [app.requireLogin] }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    return service.getManaged(req.user, id(req.params.id))
  })
  app.post('/knowledge-points/import', { preHandler: [app.requireLogin] }, async (req, reply) => {
    const d = body(req.body, ['category_id','data'], ['category_id','data'])
    const result = await service.importPoints(req.user, id(d.category_id), d.data)
    reply.code(201)
    return result
  })
  app.post('/knowledge-points', { preHandler: [app.requireLogin] }, async (req, reply) => {
    const d = body(req.body, ['slug','title','source'], ['slug','title','source'])
    slug(d.slug)
    string(d.title, 200)
    string(d.source, 200000)
    const result = await service.create(req.user, d)
    reply.code(201)
    return result
  })
  app.put('/knowledge-points/:id', { preHandler: [app.requireLogin] }, async req => {
    const d = body(req.body, ['title','source'], ['title','source'])
    string(d.title, 200)
    string(d.source, 200000)
    return service.save(req.user, id(req.params.id), d)
  })
  app.delete('/knowledge-points/:id', { preHandler: [app.requireLogin] }, async (req, reply) => {
    await service.deletePoint(req.user, id(req.params.id))
    reply.code(204)
  })
  app.delete('/categories/knowledge/:id', { preHandler: [app.requireLogin] }, async (req, reply) => {
    await service.deleteKnowledgeCategory(req.user, id(req.params.id))
    reply.code(204)
  })
  app.get('/categories/:kind', async req =>
    service.categories(choice(req.params.kind, ['knowledge','lecture'])))
  app.post('/categories/:kind', { preHandler: [app.requireLogin] }, async (req, reply) => {
    const kind = choice(req.params.kind, ['knowledge','lecture'])
    const d = body(req.body, ['parent_id','slug','name','descr','pos'], ['slug','name'])
    if (d.parent_id != null) id(d.parent_id)
    slug(d.slug)
    string(d.name, 200)
    if (d.descr !== undefined) string(d.descr, 5000, true)
    if (d.pos !== undefined) integer(d.pos)
    const result = await service.createCategory(req.user, kind, d)
    reply.code(201)
    return result
  })
  app.put('/categories/:kind/:id', { preHandler: [app.requireLogin] }, async req => {
    const d = body(req.body, ['parent_id','name','descr','pos','status'], ['parent_id','name','descr','pos','status'])
    if (d.parent_id !== null) id(d.parent_id)
    string(d.name, 200)
    string(d.descr, 5000, true)
    integer(d.pos)
    choice(d.status, ['active','archived'])
    return service.updateCategory(req.user, choice(req.params.kind, ['knowledge','lecture']), id(req.params.id), d)
  })
  app.patch('/knowledge-points/:id/status', { preHandler: [app.requireLogin] }, async req => {
    const d = body(req.body, ['status'], ['status'])
    return service.setPointStatus(req.user, id(req.params.id), choice(d.status, ['active','archived']))
  })
  app.put('/knowledge-points/:id/prerequisites', { preHandler: [app.requireLogin] }, async req => {
    const d = body(req.body, ['prerequisites'], ['prerequisites'])
    return service.setPrerequisites(req.user, id(req.params.id), list(d.prerequisites, 100).map(id))
  })
  app.get('/knowledge-points/:id/prerequisites', async req => service.getPrerequisites(id(req.params.id)))
  app.put('/knowledge-points/:id/categories', { preHandler: [app.requireLogin] }, async req => {
    const d = body(req.body, ['categories'], ['categories'])
    return service.setCategories(req.user, id(req.params.id), list(d.categories, 100).map(id))
  })
}
