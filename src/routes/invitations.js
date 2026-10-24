import crypto from 'node:crypto'
import { query } from '../db/pool.js'
import { badRequest, notFound } from '../lib/errors.js'

// 生成易读、不混淆的随机邀请码（如 MK-7B9X2M）
function generateInviteCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
  let result = 'MK-'
  const bytes = crypto.randomBytes(6)
  for (let i = 0; i < 6; i++) {
    result += chars[bytes[i] % chars.length]
  }
  return result
}

export default async function invitationRoutes(app) {
  // 1. 生成邀请码（仅超级管理员）
  app.post('/invitations', { preHandler: [app.requireAdmin] }, async (req, reply) => {
    const {
      role = 'editor',
      maxUses = 1,
      expiresInDays,
      expiresInHours,
      expiresAt: customExpiresAt,
      note = '',
    } = req.body ?? {}

    if (!['super_admin', 'editor'].includes(role)) {
      throw badRequest("角色必须是 'super_admin' 或 'editor'")
    }

    const uses = Math.max(1, Number(maxUses) || 1)
    let expiresAt = null

    // 优先支持具体截止时间 expiresAt
    if (customExpiresAt) {
      const d = new Date(customExpiresAt)
      if (isNaN(d.getTime())) throw badRequest('无效的 expiresAt 时间格式')
      expiresAt = d
    } else if (expiresInHours !== undefined && expiresInHours !== null) {
      // 支持按小时设置（如 2 小时后过期）
      const hours = Number(expiresInHours)
      if (hours > 0) expiresAt = new Date(Date.now() + hours * 3600 * 1000)
    } else if (expiresInDays !== undefined && expiresInDays !== null) {
      // 支持按天设置（如 7 天后过期）
      const days = Number(expiresInDays)
      if (days > 0) expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000)
    } else if (expiresInDays === undefined) {
      // 默认 7 天有效
      expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000)
    }
    // 若显式传入 expiresInDays: null 或 0，则 expiresAt 保持为 null（永久有效）

    // 生成唯一邀请码，最多尝试 5 次防撞
    let code = ''
    for (let i = 0; i < 5; i++) {
      const candidate = generateInviteCode()
      const exist = await query('SELECT 1 FROM invitations WHERE code = $1', [candidate])
      if (exist.rowCount === 0) {
        code = candidate
        break
      }
    }
    if (!code) {
      code = `MK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`
    }

    const { rows } = await query(
      `INSERT INTO invitations (code, role, created_by, max_uses, note, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, code, role, max_uses, used_count, status, note, expires_at, created_at`,
      [code, role, req.user.id, uses, String(note).trim(), expiresAt],
    )

    reply.code(201)
    return rows[0]
  })

  // 2. 邀请码列表（仅超级管理员）
  app.get('/invitations', { preHandler: [app.requireAdmin] }, async (req) => {
    const page = Math.max(1, Number(req.query?.page ?? 1))
    const limit = Math.min(100, Math.max(1, Number(req.query?.limit ?? 20)))
    const offset = (page - 1) * limit

    const where = []
    const params = []

    if (req.query?.status) {
      params.push(String(req.query.status))
      where.push(`i.status = $${params.length}`)
    }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : ''

    const countRes = await query(`SELECT count(*) FROM invitations i ${whereClause}`, params)
    const total = Number(countRes.rows[0].count)

    params.push(limit, offset)
    const listRes = await query(
      `SELECT i.id, i.code, i.role, i.max_uses, i.used_count, i.status, i.note,
              i.expires_at, i.created_at, u.username AS creator_username
       FROM invitations i
       LEFT JOIN users u ON i.created_by = u.id
       ${whereClause}
       ORDER BY i.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )

    return {
      total,
      page,
      limit,
      items: listRes.rows,
    }
  })

  // 3. 作废邀请码（仅超级管理员）
  app.delete('/invitations/:id', { preHandler: [app.requireAdmin] }, async (req) => {
    const id = Number(req.params.id)
    const { rows } = await query(
      `UPDATE invitations
       SET status = 'revoked', updated_at = now()
       WHERE id = $1
       RETURNING id, code, status`,
      [id],
    )

    if (rows.length === 0) {
      throw notFound('邀请码')
    }

    return { ok: true, message: '邀请码已成功作废', invitation: rows[0] }
  })
}
