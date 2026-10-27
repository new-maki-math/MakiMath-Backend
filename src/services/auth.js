import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { query, tx } from '../db/pool.js'
import { badRequest, conflict, unauthorized } from '../lib/errors.js'
import { requireAdmin, requireUser } from './access.js'
import { config } from '../config.js'

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex')
const publicUser = (user) => ({ id: user.id, username: user.username, display_name: user.display_name, role: user.role })

export async function register(data) {
  return tx(async (db) => {
    const invite = (await db.query('SELECT * FROM invitations WHERE code = $1 FOR UPDATE', [data.invite_code])).rows[0]
    if (!invite || invite.status !== 'active' || invite.used_count >= invite.max_uses ||
        (invite.expires_at && invite.expires_at <= new Date())) throw badRequest('邀请码无效或已过期')
    const passwordHash = await bcrypt.hash(data.password, 12)
    const user = (await db.query(
      'INSERT INTO users(username, password_hash, display_name, role, invitation_id) VALUES ($1,$2,$3,$4,$5) RETURNING id, username, display_name, role',
      [data.username, passwordHash, data.display_name ?? '', invite.role, invite.id],
    )).rows[0]
    await db.query(
      "UPDATE invitations SET used_count = used_count + 1, status = CASE WHEN used_count + 1 >= max_uses THEN 'exhausted' ELSE status END WHERE id = $1",
      [invite.id],
    )
    return user
  })
}

export async function login(data, context) {
  const user = (await query('SELECT * FROM users WHERE username = $1', [data.username])).rows[0]
  if (!user || user.status !== 'active' || !(await bcrypt.compare(data.password, user.password_hash))) {
    throw unauthorized('用户名或密码错误或账号不可用')
  }
  const refreshToken = crypto.randomBytes(32).toString('hex')
  const sessionId = await tx(async (db) => {
    const current = (await db.query('SELECT status, password_hash FROM users WHERE id = $1 FOR UPDATE', [user.id])).rows[0]
    if (!current || current.status !== 'active' || current.password_hash !== user.password_hash) throw unauthorized('账号已失效')
    await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id])
    const session = await db.query(
      "INSERT INTO user_sessions(user_id, token_hash, user_agent, ip_address, expires_at) VALUES ($1,$2,$3,$4,now() + $5::int * interval '1 second') RETURNING id",
      [user.id, hash(refreshToken), context.userAgent, context.ip, config.jwt.refreshTtlSeconds],
    )
    return session.rows[0].id
  })
  return { user: publicUser(user), refresh_token: refreshToken, session_id: sessionId }
}

export async function refresh(token, context) {
  return tx(async (db) => {
    const result = await db.query(
      `SELECT s.id AS session_id, u.id, u.username, u.display_name, u.role, u.status
         FROM user_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now() FOR UPDATE OF s, u`,
      [hash(token)],
    )
    const user = result.rows[0]
    if (!user || user.status !== 'active') throw unauthorized('会话无效或已过期')
    const refreshToken = crypto.randomBytes(32).toString('hex')
    await db.query(
      "UPDATE user_sessions SET token_hash = $1, user_agent = $2, ip_address = $3, expires_at = now() + $5::int * interval '1 second' WHERE id = $4",
      [hash(refreshToken), context.userAgent, context.ip, user.session_id, config.jwt.refreshTtlSeconds],
    )
    return { user: publicUser(user), refresh_token: refreshToken, session_id: user.session_id }
  })
}

export async function logout(user, token) {
  requireUser(user)
  await query('DELETE FROM user_sessions WHERE user_id = $1 AND token_hash = $2', [user.id, hash(token)])
}

export async function updateProfile(user, displayName) {
  requireUser(user)
  return (await query(
    'UPDATE users SET display_name=$1 WHERE id=$2 RETURNING id,username,display_name,role,status',
    [displayName, user.id],
  )).rows[0]
}

export async function changePassword(user, oldPassword, newPassword) {
  requireUser(user)
  return tx(async db => {
    const row = (await db.query('SELECT password_hash FROM users WHERE id=$1 FOR UPDATE', [user.id])).rows[0]
    if (!row || !(await bcrypt.compare(oldPassword, row.password_hash))) throw unauthorized('原密码错误')
    await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(newPassword, 12), user.id])
    await db.query('DELETE FROM user_sessions WHERE user_id=$1', [user.id])
  })
}

export async function createInvitation(user, data) {
  requireAdmin(user)
  const code = 'MK-' + crypto.randomBytes(6).toString('hex').toUpperCase()
  return (await query(
    'INSERT INTO invitations(code, role, created_by, max_uses, note, expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [code, data.role, user.id, data.max_uses, data.note ?? '', data.expires_at ?? null],
  )).rows[0]
}

export async function listUsers(user) {
  requireAdmin(user)
  return (await query('SELECT id, username, display_name, role, status, last_login_at, created_at FROM users ORDER BY id')).rows
}

export async function listInvitations(user) {
  requireAdmin(user)
  return (await query('SELECT * FROM invitations ORDER BY id DESC LIMIT 200')).rows
}

export async function revokeInvitation(user, inviteId) {
  requireAdmin(user)
  const row = (await query("UPDATE invitations SET status='revoked' WHERE id=$1 RETURNING *", [inviteId])).rows[0]
  if (!row) throw badRequest('邀请码不存在')
  return row
}

export async function auditLogs(user, limit) {
  requireAdmin(user)
  return (await query(
    'SELECT id,user_id,username,user_role,method,path,status_code,duration_ms,ip_address,user_agent,payload,created_at FROM audit_logs ORDER BY id DESC LIMIT $1',
    [limit],
  )).rows
}

export async function setUserStatus(user, targetId, status) {
  requireAdmin(user)
  if (targetId === user.id && status !== 'active') throw conflict('不能停用当前账号')
  return tx(async (db) => {
    const row = (await db.query('UPDATE users SET status = $1 WHERE id = $2 RETURNING id, username, display_name, role, status', [status, targetId])).rows[0]
    if (!row) throw badRequest('用户不存在')
    if (status === 'disabled') await db.query('DELETE FROM user_sessions WHERE user_id = $1', [targetId])
    return row
  })
}
