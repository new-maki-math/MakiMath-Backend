import fp from 'fastify-plugin'
import fastifyJwt from '@fastify/jwt'
import fastifyCookie from '@fastify/cookie'
import { config } from '../config.js'
import { query } from '../db/pool.js'
import { unauthorized, forbidden } from '../lib/errors.js'
import { normalizeIp } from '../lib/util.js'

const sensitive = new Set([
  'password', 'passwordhash', 'oldpassword', 'newpassword', 'token', 'refreshtoken', 'accesstoken',
  'secret', 'invitecode', 'source', 'animation', 'metadata', 'chapters',
])

function sanitizePayload(data) {
  if (Array.isArray(data)) return data.map(sanitizePayload)
  if (!data || typeof data !== 'object') return data
  const result = {}
  for (const [key, value] of Object.entries(data)) {
    result[key] = sensitive.has(key.replace(/[_-]/g, '').toLowerCase()) ? '***' : sanitizePayload(value)
  }
  return result
}

export async function requireLogin(req) {
  req.needsAudit = true
  if (!req.user) throw unauthorized('请先登录后再进行此操作')
}

export async function requireAdmin(req) {
  req.needsAudit = true
  if (!req.user) throw unauthorized('请先登录后再进行此操作')
  if (req.user.role !== 'super_admin') throw forbidden('需要管理员权限')
}

async function authPlugin(app) {
  await app.register(fastifyCookie)
  await app.register(fastifyJwt, { secret: config.jwt.secret, sign: { expiresIn: config.jwt.expiresIn } })
  if (!app.hasRequestDecorator('user')) app.decorateRequest('user', null)
  app.decorateRequest('needsAudit', false)
  app.decorateRequest('startTime', 0)

  app.addHook('onRequest', async req => {
    req.startTime = Date.now()
  })

  app.addHook('preHandler', async req => {
    if (!req.headers.authorization?.startsWith('Bearer ')) return
    let decoded
    try {
      decoded = await req.jwtVerify()
    } catch {
      req.user = null
      return
    }
    req.user = null
    if (!Number.isSafeInteger(decoded.id) || decoded.id <= 0 || !Number.isSafeInteger(decoded.sid) || decoded.sid <= 0) return
    const { rows } = await query(
      `SELECT u.id, u.username, u.display_name, u.role FROM users u
       JOIN user_sessions s ON s.user_id = u.id
       WHERE u.id = $1 AND s.id = $2 AND u.status = 'active' AND s.expires_at > now()`,
      [decoded.id, decoded.sid],
    )
    req.user = rows[0] ?? null
  })

  app.addHook('onResponse', async (req, reply) => {
    if (!req.needsAudit) return
    const payload = sanitizePayload(req.body ?? {})
    query(
      `INSERT INTO audit_logs(user_id,username,user_role,method,path,status_code,duration_ms,ip_address,user_agent,payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [req.user?.id ?? null, req.user?.username ?? '', req.user?.role ?? '', req.method,
        req.url.split('?')[0], reply.statusCode, Date.now() - req.startTime, normalizeIp(req.ip),
        req.headers['user-agent'] ?? '', JSON.stringify(payload)],
    ).catch(err => req.log.error({ err }, '审计记录写入失败'))
  })

  app.decorate('requireLogin', requireLogin)
  app.decorate('requireAdmin', requireAdmin)
}

export default fp(authPlugin, { name: 'auth-plugin' })
