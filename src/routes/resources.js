import * as service from '../services/resources.js'
import { badRequest } from '../lib/errors.js'
import { body, choice, id, integer, string } from '../lib/validate.js'

const optionalParent = value => value === undefined || value === null || value === '' ? null : id(value)
const name = value => string(value, 200).trim()
const description = value => value === undefined ? '' : string(value, 5000, true)

async function upload(req, replacement = false) {
  let file = null
  const fields = {}
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      if (file || part.fieldname !== 'file') throw badRequest('必须提供一个 PDF 文件')
      file = await part.toBuffer()
      if (part.file.truncated) throw badRequest('PDF 文件超过大小限制')
    } else {
      if (Object.hasOwn(fields, part.fieldname)) throw badRequest('表单字段不能重复')
      fields[part.fieldname] = part.value
    }
  }
  if (!file) throw badRequest('必须提供一个 PDF 文件')
  const allowed = replacement ? ['updated_at'] : ['parent_id','name','description']
  if (Object.keys(fields).some(key => !allowed.includes(key))) throw badRequest('存在不支持的字段')
  const pdf = await service.validatePdf(file)
  if (replacement) return { pdf, data: { updated_at: string(fields.updated_at, 40) } }
  return { pdf, data: { parent_id: optionalParent(fields.parent_id), name: name(fields.name), description: description(fields.description) } }
}

export default async function resourceRoutes(app) {
  app.get('/resources', async req => {
    if (req.query.scope !== undefined) throw badRequest('资源目录不支持范围参数')
    const sort = choice(req.query.sort ?? 'name', ['name','updated_at'])
    const order = choice(req.query.order ?? 'asc', ['asc','desc'])
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit)
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset)
    return service.list(req.user, { parentId: optionalParent(req.query.parent_id), sort, order, limit: integer(limit,1,100), offset: integer(offset,0,1000000) })
  })
  app.get('/resources/download-quota', async (req, reply) => {
    reply.header('Cache-Control','private, no-store')
    return service.quota(req.user,req.ip)
  })
  app.get('/resources/:id', async req => service.detail(req.user, id(req.params.id)))
  app.post('/resources/folders', { preHandler: [app.requireAdmin] }, async (req, reply) => {
    const d = body(req.body,['parent_id','name','description'],['name'])
    const result = await service.create(req.user,{ parent_id: optionalParent(d.parent_id), name: name(d.name), description: description(d.description) })
    reply.code(201)
    return result
  })
  app.post('/resources/files', { config: { rawResource: true }, preHandler: [app.requireAdmin] }, async (req, reply) => {
    const { data, pdf } = await upload(req)
    const result = await service.create(req.user,data,pdf)
    reply.code(201)
    return result
  })
  app.patch('/resources/:id', { preHandler: [app.requireAdmin] }, async req => {
    const d = body(req.body,['name','description','updated_at'],['updated_at'])
    if (d.name !== undefined) d.name = name(d.name)
    if (d.description !== undefined) d.description = description(d.description)
    string(d.updated_at, 40)
    return service.update(req.user,id(req.params.id),d)
  })
  app.put('/resources/:id/content', { config: { rawResource: true }, preHandler: [app.requireAdmin] }, async req => {
    const { data, pdf } = await upload(req,true)
    return service.update(req.user,id(req.params.id),data,pdf)
  })
  app.post('/resources/:id/move', { preHandler: [app.requireAdmin] }, async req => {
    const d = body(req.body,['parent_id'],['parent_id'])
    return service.move(req.user,id(req.params.id),optionalParent(d.parent_id))
  })
  app.post('/resources/:id/copy', { preHandler: [app.requireAdmin] }, async (req, reply) => {
    const d = body(req.body,['parent_id','name'],['parent_id','name'])
    const result = await service.copy(req.user,id(req.params.id),optionalParent(d.parent_id),name(d.name))
    reply.code(201)
    return result
  })
  app.delete('/resources/:id', { preHandler: [app.requireAdmin] }, async req => service.remove(req.user,id(req.params.id)))
  const sendContent = async (req, reply) => {
    reply.header('Cache-Control','private, no-store')
    const mode = choice(req.query.disposition ?? 'inline', ['inline','attachment'])
    let result
    try { result = await service.content(req.user,id(req.params.id),req.headers.range,req.method === 'HEAD',req.ip) }
    catch (err) { if (err.status === 416 && err.details?.size) reply.header('Content-Range',`bytes */${err.details.size}`); throw err }
    reply.header('Accept-Ranges','bytes')
    reply.header('X-Content-Type-Options','nosniff')
    reply.header('Content-Disposition',`${mode}; filename="document.pdf"; filename*=UTF-8''${encodeURIComponent(result.resource.name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`)
    reply.header('Content-Length',String(result.end-result.start+1))
    reply.type('application/pdf')
    if (result.partial) reply.code(206).header('Content-Range',`bytes ${result.start}-${result.end}/${result.size}`)
    return req.method === 'HEAD' ? reply.send() : reply.send(result.data)
  }
  app.route({ method: 'GET', url: '/resources/:id/content', exposeHeadRoute: false, handler: sendContent })
  app.head('/resources/:id/content', sendContent)
}
