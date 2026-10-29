import * as service from '../services/lectures.js'
import { badRequest } from '../lib/errors.js'
import { body, id, integer, string, slug, object, list, choice } from '../lib/validate.js'
import { parseCover } from '../lib/lecture-cover.js'

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
      body(section, ['occurrence_id','slug','tag','title','summary','source'], ['slug'])
      occurrence(section.occurrence_id)
      string(section.slug, 100)
      if (section.source !== undefined) string(section.source, 200000, true)
      else if (!section.occurrence_id) throw badRequest('新小节必须提供源码')
      for (const field of ['tag','title','summary']) if (section[field] !== undefined) string(section[field], 5000, true)
      if (++count > 2000) throw badRequest('讲义小节数量超出限制')
    }
  }
}

function validateImport(data) {
  body(data, ['type','schema_version','lecture','chapters'], ['type','schema_version','lecture','chapters'])
  if (data.type !== 'maki-lecture' || data.schema_version !== 1) throw badRequest('讲义文件类型或版本不支持')
  const lecture = body(data.lecture, ['slug','title','subtitle','summary','typst_version','metadata'], ['slug','title','subtitle','summary','typst_version','metadata'])
  slug(lecture.slug)
  string(lecture.title, 200)
  string(lecture.subtitle, 500, true)
  string(lecture.summary, 5000, true)
  string(lecture.typst_version, 50)
  object(lecture.metadata)
  const chapterSlugs = new Set()
  let count = 0
  for (const chapter of list(data.chapters, 100)) {
    body(chapter, ['slug','tag','title','summary','sections'], ['slug','tag','title','summary','sections'])
    string(chapter.slug, 100)
    if (chapterSlugs.has(chapter.slug)) throw badRequest('章节标识重复')
    chapterSlugs.add(chapter.slug)
    for (const field of ['tag','title','summary']) string(chapter[field], 5000, true)
    const sectionSlugs = new Set()
    for (const section of list(chapter.sections, 200)) {
      body(section, ['slug','tag','title','summary','source'], ['slug','tag','title','summary','source'])
      string(section.slug, 100)
      if (sectionSlugs.has(section.slug)) throw badRequest('小节标识重复')
      sectionSlugs.add(section.slug)
      for (const field of ['tag','title','summary']) string(section[field], 5000, true)
      string(section.source, 200000, true)
      if (++count > 2000) throw badRequest('讲义小节数量超出限制')
    }
  }
  return data
}

export default async function lectureRoutes(app) {
  app.get('/lectures', async () => service.publicList())
  app.get('/lectures/mine', { preHandler: [app.requireLogin] }, async req => service.mine(req.user))
  app.get('/lectures/manage', { preHandler: [app.requireAdmin] }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    return service.manage(req.user)
  })
  app.get('/lectures/owned', { preHandler: [app.requireLogin] }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    return service.owned(req.user)
  })
  app.get('/lectures/by-slug/:slug/outline', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    slug(req.params.slug)
    const revisionId = req.query.revision_id === undefined ? null : id(req.query.revision_id)
    return service.lectureOutline(req.user, req.params.slug, revisionId)
  })
  app.get('/lectures/by-slug/:slug/revisions/:revisionId/chapters/:chapterSlug/sections/:sectionSlug', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    slug(req.params.slug)
    string(req.params.chapterSlug, 100)
    string(req.params.sectionSlug, 100)
    return service.lectureSection(req.user, req.params.slug, id(req.params.revisionId), req.params.chapterSlug, req.params.sectionSlug, id(req.query.edit_version))
  })
  app.post('/lectures', { preHandler: [app.requireLogin] }, async (req, reply) => {
    const d = body(req.body, ['slug','title'], ['slug','title'])
    slug(d.slug)
    string(d.title, 200)
    const result = await service.create(req.user, d)
    reply.code(201)
    return result
  })
  app.post('/lectures/import', { preHandler: [app.requireLogin] }, async (req, reply) => {
    const result = await service.importLecture(req.user, validateImport(req.body))
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
  app.get('/lecture-revisions/:id/export', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    return service.exportRevision(req.user, id(req.params.id))
  })
  app.get('/lecture-revisions/:id/cover', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    return service.getCover(req.user, id(req.params.id))
  })
  app.put('/lecture-revisions/:id/cover', { preHandler: [app.requireLogin] }, async req => {
    const d = body(req.body, ['edit_version','cover'], ['edit_version','cover'])
    return service.setCover(req.user, id(req.params.id), integer(d.edit_version, 1), parseCover(d.cover))
  })
  app.delete('/lecture-revisions/:id/cover', { preHandler: [app.requireLogin] }, async req =>
    service.setCover(req.user, id(req.params.id), id(req.query.edit_version), null))
  app.put('/lecture-revisions/:id/sections/:occurrenceId', { preHandler: [app.requireLogin] }, async req => {
    occurrence(req.params.occurrenceId)
    const fields = ['edit_version','slug','tag','title','summary','source']
    const d = body(req.body, fields, fields)
    integer(d.edit_version, 1)
    string(d.slug, 100)
    for (const field of ['tag','title','summary']) string(d[field], 5000, true)
    string(d.source, 200000, true)
    return service.saveSection(req.user, id(req.params.id), req.params.occurrenceId, d)
  })
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
  app.post('/lectures/:id/restore', { preHandler: [app.requireLogin] }, async req =>
    service.restore(req.user, id(req.params.id)))
  app.delete('/lectures/:id', { preHandler: [app.requireAdmin] }, async (req, reply) => {
    await service.deleteArchived(req.user, id(req.params.id))
    reply.code(204)
  })
}
