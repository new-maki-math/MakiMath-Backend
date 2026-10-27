import * as service from '../services/lectures.js'
import { badRequest } from '../lib/errors.js'
import { body, id, integer, string, slug, object, list, choice, animation } from '../lib/validate.js'

function occurrence(value) {
  if (value !== undefined && (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))) {
    throw badRequest('内容实例标识不合法')
  }
}

function validateTree(chapters) {
  let count = 0
  for (const chapter of list(chapters, 100)) {
    body(chapter, ['occurrence_id','slug','tag','title','summary','sections'], ['slug','sections'])
    occurrence(chapter.occurrence_id)
    string(chapter.slug, 100)
    for (const field of ['tag','title','summary']) if (chapter[field] !== undefined) string(chapter[field], 5000, true)
    for (const section of list(chapter.sections, 200)) {
      body(section, ['occurrence_id','slug','tag','title','summary','blocks'], ['slug','blocks'])
      occurrence(section.occurrence_id)
      string(section.slug, 100)
      for (const field of ['tag','title','summary']) if (section[field] !== undefined) string(section[field], 5000, true)
      for (const block of list(section.blocks, 500)) {
        count++
        if (count > 2000) throw badRequest('讲义内容块数量超出限制')
        body(block, ['occurrence_id','block_type','source','knowledge_point_id','knowledge_revision_id','animation'], ['block_type'])
        occurrence(block.occurrence_id)
        choice(block.block_type, ['author','knowledge_reference'])
        if (block.block_type === 'author') {
          string(block.source, 200000, true)
          if (block.knowledge_point_id != null || block.knowledge_revision_id != null) throw badRequest('作者内容不能包含知识点引用')
          if (block.animation != null) animation(block.animation)
        } else {
          id(block.knowledge_point_id)
          id(block.knowledge_revision_id)
          if (block.source != null || block.animation != null) throw badRequest('知识点引用不能包含正文和动画副本')
        }
      }
    }
  }
}

export default async function lectureRoutes(app) {
  app.get('/lectures', async () => service.publicList())
  app.get('/lectures/mine', { preHandler: [app.requireLogin] }, async req => service.mine(req.user))
  app.get('/lectures/:id', async req => service.publicLecture(id(req.params.id)))
  app.post('/lectures', { preHandler: [app.requireLogin] }, async (req, reply) => {
    const d = body(req.body, ['slug','title'], ['slug','title'])
    slug(d.slug)
    string(d.title, 200)
    const result = await service.create(req.user, d)
    reply.code(201)
    return result
  })
  app.get('/lectures/:id/revisions', { preHandler: [app.requireLogin] }, async req =>
    service.revisions(req.user, id(req.params.id)))
  app.post('/lectures/:id/revisions', { preHandler: [app.requireLogin] }, async (req, reply) => {
    const d = body(req.body, ['based_on_id'], ['based_on_id'])
    const result = await service.copyRevision(req.user, id(req.params.id), id(d.based_on_id))
    reply.code(201)
    return result
  })
  app.get('/lecture-revisions/:id', { preHandler: [app.requireLogin] }, async req =>
    service.revision(req.user, id(req.params.id)))
  app.put('/lecture-revisions/:id', { preHandler: [app.requireLogin] }, async req => {
    const fields = ['edit_version','title','subtitle','descr','category_id','typst_version','metadata','change_note','chapters']
    const d = body(req.body, fields, fields)
    integer(d.edit_version, 1)
    string(d.title, 200)
    string(d.subtitle, 500, true)
    string(d.descr, 5000, true)
    if (d.category_id !== null) id(d.category_id)
    string(d.typst_version, 50)
    object(d.metadata)
    string(d.change_note, 2000, true)
    validateTree(d.chapters)
    return service.save(req.user, id(req.params.id), d)
  })
  app.post('/lecture-revisions/:id/submit', { preHandler: [app.requireLogin] }, async req => {
    const d = body(req.body, ['edit_version'], ['edit_version'])
    return service.submit(req.user, id(req.params.id), integer(d.edit_version, 1))
  })
  app.put('/lectures/:id/collaborators/:userId', { preHandler: [app.requireLogin] }, async req => {
    const d = body(req.body, ['permission'], ['permission'])
    return service.setCollaborator(req.user, id(req.params.id), id(req.params.userId), choice(d.permission, ['view','edit']))
  })
  app.get('/lectures/:id/collaborators', { preHandler: [app.requireLogin] }, async req =>
    service.collaborators(req.user, id(req.params.id)))
  app.delete('/lectures/:id/collaborators/:userId', { preHandler: [app.requireLogin] }, async (req, reply) => {
    await service.removeCollaborator(req.user, id(req.params.id), id(req.params.userId))
    reply.code(204)
  })
  app.patch('/lectures/:id/publication', { preHandler: [app.requireLogin] }, async req => {
    const d = body(req.body, ['publication_status','is_recommended'])
    if (d.publication_status !== undefined) choice(d.publication_status, ['published','withdrawn','archived'])
    if (d.is_recommended !== undefined && typeof d.is_recommended !== 'boolean') throw badRequest('推荐标记必须为布尔值')
    return service.publication(req.user, id(req.params.id), d.publication_status, d.is_recommended)
  })
}
