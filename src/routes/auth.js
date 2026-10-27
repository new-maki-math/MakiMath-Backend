import * as service from '../services/auth.js'
import { body, string, id, integer, choice } from '../lib/validate.js'
import { normalizeIp } from '../lib/util.js'
import { SERVER_PUB_B64 } from '../lib/crypto.js'
import { badRequest } from '../lib/errors.js'

const context = req => ({ userAgent: String(req.headers['user-agent'] ?? '').slice(0, 1000), ip: normalizeIp(req.ip) })
const password = value => {
  string(value, 200)
  if (value.length < 8) throw badRequest('密码至少需要八个字符')
  if (Buffer.byteLength(value, 'utf8') > 72) throw badRequest('密码长度超出限制')
  return value
}

export default async function authRoutes(app) {
  app.get('/auth/pubkey', async () => ({ ok: true, pubkey: SERVER_PUB_B64 }))

  app.post('/auth/register', async (req, reply) => {
    const d = body(req.body, ['username','password','display_name','invite_code'], ['username','password','invite_code'])
    string(d.username, 80)
    password(d.password)
    string(d.invite_code, 100)
    if (d.display_name !== undefined) string(d.display_name, 100, true)
    req.needsAudit = true
    const user = await service.register(d)
    reply.code(201)
    return { user }
  })

  app.post('/auth/login', async (req) => {
    const d = body(req.body, ['username','password'], ['username','password'])
    string(d.username, 80)
    string(d.password, 200)
    req.needsAudit = true
    const result = await service.login(d, context(req))
    req.user = result.user
    return { user: result.user, refresh_token: result.refresh_token, access_token: app.jwt.sign({ id: result.user.id, sid: result.session_id }) }
  })

  app.post('/auth/refresh', async (req) => {
    const d = body(req.body, ['refresh_token'], ['refresh_token'])
    string(d.refresh_token, 200)
    const result = await service.refresh(d.refresh_token, context(req))
    req.user = result.user
    req.needsAudit = true
    return { user: result.user, refresh_token: result.refresh_token, access_token: app.jwt.sign({ id: result.user.id, sid: result.session_id }) }
  })

  app.post('/auth/logout', { preHandler: [app.requireLogin] }, async (req, reply) => {
    const d = body(req.body, ['refresh_token'], ['refresh_token'])
    string(d.refresh_token, 200)
    await service.logout(req.user, d.refresh_token)
    reply.code(204)
  })

  app.get('/auth/me', { preHandler: [app.requireLogin] }, async req => ({ user: req.user }))

  app.patch('/auth/profile', { preHandler: [app.requireLogin] }, async req => {
    const d = body(req.body, ['display_name'], ['display_name'])
    return { user: await service.updateProfile(req.user, string(d.display_name, 100, true)) }
  })

  app.patch('/auth/password', { preHandler: [app.requireLogin] }, async (req, reply) => {
    const d = body(req.body, ['old_password','new_password'], ['old_password','new_password'])
    string(d.old_password, 200)
    password(d.new_password)
    await service.changePassword(req.user, d.old_password, d.new_password)
    reply.code(204)
  })

  app.post('/invitations', { preHandler: [app.requireLogin] }, async (req, reply) => {
    const d = body(req.body, ['role','max_uses','note','expires_at'], ['role','max_uses'])
    choice(d.role, ['editor','super_admin'])
    integer(d.max_uses, 1, 1000)
    if (d.note !== undefined) string(d.note, 1000, true)
    if (d.expires_at !== undefined && d.expires_at !== null && (typeof d.expires_at !== 'string' || Number.isNaN(Date.parse(d.expires_at)))) throw badRequest('过期时间不合法')
    const result = await service.createInvitation(req.user, d)
    reply.code(201)
    return result
  })

  app.get('/invitations', { preHandler: [app.requireLogin] }, async req => service.listInvitations(req.user))
  app.delete('/invitations/:id', { preHandler: [app.requireLogin] }, async req =>
    service.revokeInvitation(req.user, id(req.params.id)))
  app.get('/audit-logs', { preHandler: [app.requireLogin] }, async req => {
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit)
    return service.auditLogs(req.user, integer(limit, 1, 100))
  })

  app.get('/users', { preHandler: [app.requireLogin] }, async req => service.listUsers(req.user))
  app.patch('/users/:id/status', { preHandler: [app.requireLogin] }, async req => {
    const d = body(req.body, ['status'], ['status'])
    return service.setUserStatus(req.user, id(req.params.id), choice(d.status, ['active','disabled']))
  })
}
