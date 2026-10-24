import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { query, tx } from '../db/pool.js'
import { badRequest, unauthorized, forbidden, conflict } from '../lib/errors.js'
import { SERVER_PUB_B64 } from '../lib/crypto.js'
import { normalizeIp } from '../lib/util.js'

export default async function authRoutes(app) {
  // 0. 获取服务端 ECDH 协商公钥（公开端点，供客户端初次协商握手）
  app.get('/auth/pubkey', async () => {
    return { ok: true, pubkey: SERVER_PUB_B64 }
  })

  // 1. 用户登录
  app.post('/auth/login', async (req, reply) => {
    req.needsAudit = true
    const { username, password } = req.body ?? {}
    if (!username || !password) {
      throw badRequest('用户名和密码不能为空')
    }

    const { rows } = await query(
      'SELECT id, username, password_hash, display_name, role, status FROM users WHERE username = $1',
      [username.trim()],
    )

    const user = rows[0]
    if (!user) {
      throw unauthorized('用户名或密码错误')
    }

    if (user.status !== 'active') {
      throw forbidden('账号已被禁用，请联系管理员')
    }

    const matched = await bcrypt.compare(password, user.password_hash)
    if (!matched) {
      throw unauthorized('用户名或密码错误')
    }

    // 更新最后登录时间
    await query('UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1', [
      user.id,
    ])

    // 签发 Access Token (短期)
    const tokenPayload = {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
    }
    req.user = tokenPayload
    const accessToken = app.jwt.sign(tokenPayload)

    // 生成 Refresh Token (长期随机字串) 并记录 session
    const rawRefreshToken = crypto.randomBytes(32).toString('hex')
    const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex')
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000) // 7天过期

    const userAgent = req.headers['user-agent'] ?? ''
    const ipAddress = normalizeIp(req.ip)

    await query(
      `INSERT INTO user_sessions (user_id, token_hash, user_agent, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.id, tokenHash, userAgent, ipAddress, expiresAt],
    )

    return {
      ok: true,
      token: accessToken,
      refreshToken: rawRefreshToken,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
      },
    }
  })

  // 2. 获取当前登录者身份
  app.get('/auth/me', { preHandler: [app.requireLogin] }, async (req) => {
    const { rows } = await query(
      'SELECT id, username, display_name, role, status, last_login_at, created_at FROM users WHERE id = $1',
      [req.user.id],
    )
    const user = rows[0]
    if (!user) {
      throw unauthorized('用户不存在或已失效')
    }
    return { ok: true, user }
  })

  // 2.1 修改当前登录用户基本信息
  app.patch('/auth/profile', { preHandler: [app.requireLogin] }, async (req) => {
    req.needsAudit = true
    const { displayName } = req.body ?? {}
    if (displayName === undefined || typeof displayName !== 'string') {
      throw badRequest('昵称不能为空')
    }
    const trimmed = displayName.trim()
    const { rows } = await query(
      `UPDATE users
       SET display_name = $1, updated_at = now()
       WHERE id = $2
       RETURNING id, username, display_name, role, status, last_login_at, created_at, updated_at`,
      [trimmed, req.user.id],
    )
    return { ok: true, user: rows[0] }
  })

  // 2.2 修改当前登录用户密码
  app.patch('/auth/password', { preHandler: [app.requireLogin] }, async (req) => {
    req.needsAudit = true
    const { oldPassword, newPassword } = req.body ?? {}
    if (!oldPassword || !newPassword) {
      throw badRequest('原密码和新密码均为必填项')
    }
    if (String(newPassword).length < 6) {
      throw badRequest('新密码至少需要 6 个字符')
    }
    const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id])
    const current = rows[0]
    if (!current) {
      throw unauthorized('用户不存在')
    }
    const matched = await bcrypt.compare(oldPassword, current.password_hash)
    if (!matched) {
      throw badRequest('原密码错误')
    }
    const newHash = await bcrypt.hash(newPassword, 10)
    await query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [
      newHash,
      req.user.id,
    ])
    return { ok: true, message: '密码修改成功' }
  })

  // 2.3 查询当前用户的操作审计日志
  app.get('/auth/audit-logs', { preHandler: [app.requireLogin] }, async (req) => {
    const page = Math.max(1, Number(req.query?.page ?? 1))
    const limit = Math.min(100, Math.max(1, Number(req.query?.limit ?? 20)))
    const offset = (page - 1) * limit
    const countRes = await query('SELECT count(*) FROM audit_logs WHERE user_id = $1', [req.user.id])
    const total = Number(countRes.rows[0].count)
    const listRes = await query(
      `SELECT id, user_id, username, user_role, method, path, status_code, duration_ms,
              ip_address, user_agent, payload, created_at
       FROM audit_logs
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset],
    )
    return {
      total,
      page,
      limit,
      items: listRes.rows,
    }
  })

  // 3. 刷新 Token
  app.post('/auth/refresh', async (req) => {
    const { refreshToken } = req.body ?? {}
    if (!refreshToken) {
      throw badRequest('缺少 refreshToken')
    }

    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex')
    const { rows } = await query(
      `SELECT s.id AS session_id, u.id, u.username, u.display_name, u.role, u.status, s.expires_at
       FROM user_sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.token_hash = $1`,
      [tokenHash],
    )

    const session = rows[0]
    if (!session || new Date(session.expires_at) < new Date()) {
      if (session) {
        await query('DELETE FROM user_sessions WHERE id = $1', [session.session_id])
      }
      throw unauthorized('Refresh Token 已失效或过期，请重新登录')
    }

    if (session.status !== 'active') {
      throw forbidden('账号已被禁用')
    }

    // 签发新 Access Token
    const accessToken = app.jwt.sign({
      id: session.id,
      username: session.username,
      displayName: session.display_name,
      role: session.role,
    })

    return { ok: true, token: accessToken }
  })

  // 4. 退出登录（注销当前 session）
  app.post('/auth/logout', { preHandler: [app.requireLogin] }, async (req) => {
    const { refreshToken } = req.body ?? {}
    if (refreshToken) {
      const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex')
      await query('DELETE FROM user_sessions WHERE token_hash = $1', [tokenHash])
    } else {
      // 若未传 refreshToken，删除该用户所有过期或所有 session
      await query('DELETE FROM user_sessions WHERE user_id = $1', [req.user.id])
    }
    return { ok: true }
  })

  // 5. 校验邀请码是否有效（公开，供注册页实时检测）
  app.get('/auth/check-invite', async (req) => {
    const code = String(req.query?.code ?? '').trim().toUpperCase()
    if (!code) {
      throw badRequest('缺少邀请码')
    }

    const { rows } = await query(
      `SELECT id, code, role, max_uses, used_count, status, note, expires_at
       FROM invitations
       WHERE code = $1`,
      [code],
    )

    const inv = rows[0]
    if (!inv) {
      return { ok: true, valid: false, message: '邀请码不存在' }
    }

    if (inv.status !== 'active') {
      return {
        ok: true,
        valid: false,
        message: inv.status === 'revoked' ? '邀请码已被作废' : '邀请码使用次数已达上限',
      }
    }

    if (inv.used_count >= inv.max_uses) {
      return { ok: true, valid: false, message: '邀请码使用次数已达上限' }
    }

    if (inv.expires_at && new Date(inv.expires_at) < new Date()) {
      return { ok: true, valid: false, message: '邀请码已过期' }
    }

    return {
      ok: true,
      valid: true,
      role: inv.role,
      note: inv.note,
    }
  })

  // 6. 凭邀请码注册（公开接口，强制需有效邀请码）
  app.post('/auth/register', async (req, reply) => {
    req.needsAudit = true
    const { username, password, displayName = '', inviteCode } = req.body ?? {}
    if (!username || !password || !inviteCode) {
      throw badRequest('用户名、密码和邀请码均为必填项')
    }

    const trimmedUser = String(username).trim()
    const trimmedCode = String(inviteCode).trim().toUpperCase()

    if (trimmedUser.length < 3) {
      throw badRequest('用户名至少需要 3 个字符')
    }
    if (String(password).length < 6) {
      throw badRequest('密码至少需要 6 个字符')
    }

    return tx(async (client) => {
      // 1. 行级锁查询邀请码，防止并发超额使用
      const invRes = await client.query('SELECT * FROM invitations WHERE code = $1 FOR UPDATE', [
        trimmedCode,
      ])
      const inv = invRes.rows[0]
      if (!inv) {
        throw badRequest('邀请码不存在')
      }
      if (inv.status !== 'active' || inv.used_count >= inv.max_uses) {
        throw badRequest('邀请码已失效或已达使用上限')
      }
      if (inv.expires_at && new Date(inv.expires_at) < new Date()) {
        throw badRequest('邀请码已过期')
      }

      // 2. 检查用户名唯一性
      const userExist = await client.query('SELECT 1 FROM users WHERE username = $1', [trimmedUser])
      if (userExist.rowCount > 0) {
        throw conflict(`用户名 "${trimmedUser}" 已被注册`)
      }

      // 3. 密码加盐哈希入库
      const passwordHash = await bcrypt.hash(password, 10)
      const insRes = await client.query(
        `INSERT INTO users (username, password_hash, display_name, role, invitation_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, username, display_name, role, status, created_at`,
        [trimmedUser, passwordHash, String(displayName).trim(), inv.role, inv.id],
      )
      const newUser = insRes.rows[0]

      // 4. 更新邀请码使用次数与状态
      const nextUsed = inv.used_count + 1
      const nextStatus = nextUsed >= inv.max_uses ? 'exhausted' : 'active'
      await client.query(
        'UPDATE invitations SET used_count = $1, status = $2, updated_at = now() WHERE id = $3',
        [nextUsed, nextStatus, inv.id],
      )

      // 5. 注册成功后自动签发 Token 直接登录
      const tokenPayload = {
        id: newUser.id,
        username: newUser.username,
        displayName: newUser.display_name,
        role: newUser.role,
      }
      const accessToken = app.jwt.sign(tokenPayload)

      reply.code(201)
      return {
        ok: true,
        message: '注册成功',
        token: accessToken,
        user: newUser,
      }
    })
  })
}
