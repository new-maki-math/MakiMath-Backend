import fp from 'fastify-plugin'
import fastifyJwt from '@fastify/jwt'
import fastifyCookie from '@fastify/cookie'
import { config } from '../config.js'
import { query } from '../db/pool.js'
import { unauthorized, forbidden } from '../lib/errors.js'
import { normalizeIp } from '../lib/util.js'

// 敏感字段脱敏工具
function sanitizePayload(data) {
  if (!data || typeof data !== 'object') return {}
  if (Array.isArray(data)) return data.map(sanitizePayload)

  const SENSITIVE_KEYS = new Set(['password', 'password_hash', 'token', 'refreshToken', 'secret'])
  const copy = {}
  for (const [k, v] of Object.entries(data)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      copy[k] = '***'
    } else if (v && typeof v === 'object') {
      copy[k] = sanitizePayload(v)
    } else {
      copy[k] = v
    }
  }
  return copy
}

// 权限守卫：必须登录（超管或编者）
export async function requireLogin(req) {
  req.needsAudit = true
  if (!req.user) {
    throw unauthorized('请先登录后再进行此操作')
  }
}

// 权限守卫：必须超级管理员
export async function requireAdmin(req) {
  req.needsAudit = true
  if (!req.user) {
    throw unauthorized('请先登录后再进行此操作')
  }
  if (req.user.role !== 'super_admin') {
    throw forbidden('需要超级管理员权限')
  }
}

// 权限守卫：检查编者是否有某课程的编辑权限（超管直接放行）
export async function requireCourseEditor(req) {
  req.needsAudit = true
  if (!req.user) {
    throw unauthorized('请先登录后再进行此操作')
  }
  if (req.user.role === 'super_admin') {
    return
  }

  const courseId = Number(
    req.params.courseId ?? req.params.id ?? req.body?.course_id ?? req.query?.course_id,
  )
  if (!courseId) {
    throw forbidden('无法确定目标课程')
  }

  const { rowCount } = await query(
    'SELECT 1 FROM course_editors WHERE course_id = $1 AND user_id = $2',
    [courseId, req.user.id],
  )
  if (rowCount === 0) {
    throw forbidden('您未被授权编辑该课程')
  }
}

async function authPlugin(app) {
  // 1. 注册 Cookie 支持
  await app.register(fastifyCookie)

  // 2. 注册 JWT 支持
  await app.register(fastifyJwt, {
    secret: config.jwt.secret,
    sign: {
      expiresIn: config.jwt.expiresIn,
    },
  })

  // 3. 挂载 user 和 审计标记 到 request
  if (!app.hasRequestDecorator('user')) {
    app.decorateRequest('user', null)
  }
  if (!app.hasRequestDecorator('needsAudit')) {
    app.decorateRequest('needsAudit', false)
  }
  if (!app.hasRequestDecorator('startTime')) {
    app.decorateRequest('startTime', 0)
  }

  // 4. 记录请求进入时间戳
  app.addHook('onRequest', async (req) => {
    req.startTime = Date.now()
  })

  // 5. 软认证 Hook：无论有无 token 均不中断，有合法 token 时注入 req.user
  app.addHook('preHandler', async (req) => {
    const authHeader = req.headers.authorization
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const decoded = await req.jwtVerify()
        req.user = decoded
      } catch {
        req.user = null
      }
    }
  })

  // 6. 操作审计 Hook：凡是标记需要认证的接口，在响应结束时异步落库
  app.addHook('onResponse', async (req, reply) => {
    if (!req.needsAudit) return

    const duration = Date.now() - (req.startTime || Date.now())
    const userId = req.user?.id ?? null
    const username = req.user?.username ?? (typeof req.body?.username === 'string' ? req.body.username.trim() : '')
    const userRole = req.user?.role ?? ''
    const method = req.method
    const path = req.url.split('?')[0]
    const statusCode = reply.statusCode
    const ipAddress = normalizeIp(req.ip)
    const userAgent = req.headers['user-agent'] ?? ''
    const payload = sanitizePayload(req.body)

    // 异步插入审计表，防止日志写入拖慢主业务
    query(
      `INSERT INTO audit_logs (user_id, username, user_role, method, path, status_code, duration_ms, ip_address, user_agent, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
      [
        userId,
        username,
        userRole,
        method,
        path,
        statusCode,
        duration,
        ipAddress,
        userAgent,
        JSON.stringify(payload),
      ],
    ).catch((err) => {
      req.log.error(`[audit] 审计日志写入失败: ${err.message}`)
    })
  })

  // 7. 挂载装饰器供整个 Fastify 实例及子路由访问
  app.decorate('requireLogin', requireLogin)
  app.decorate('requireAdmin', requireAdmin)
  app.decorate('requireCourseEditor', requireCourseEditor)
}

export default fp(authPlugin, { name: 'auth-plugin' })
