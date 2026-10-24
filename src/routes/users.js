import bcrypt from 'bcryptjs'
import { query } from '../db/pool.js'
import { badRequest, notFound, conflict } from '../lib/errors.js'

export default async function userRoutes(app) {
  // 1. 用户列表（仅超管）
  app.get('/users', { preHandler: [app.requireAdmin] }, async () => {
    const { rows } = await query(
      `SELECT id, username, display_name, role, status, last_login_at, created_at, updated_at
       FROM users
       ORDER BY id ASC`,
    )
    return rows
  })

  // 2. 创建用户（默认编者，也可指定 super_admin）（仅超管）
  app.post('/users', { preHandler: [app.requireAdmin] }, async (req, reply) => {
    const { username, password, displayName = '', role = 'editor' } = req.body ?? {}
    if (!username || !password) {
      throw badRequest('用户名和初始密码为必填项')
    }
    if (!['super_admin', 'editor'].includes(role)) {
      throw badRequest("角色必须是 'super_admin' 或 'editor'")
    }

    const trimmedUser = username.trim()
    const passwordHash = await bcrypt.hash(password, 10)

    try {
      const { rows } = await query(
        `INSERT INTO users (username, password_hash, display_name, role)
         VALUES ($1, $2, $3, $4)
         RETURNING id, username, display_name, role, status, created_at`,
        [trimmedUser, passwordHash, displayName.trim(), role],
      )
      reply.code(201)
      return rows[0]
    } catch (err) {
      if (err.code === '23505') {
        throw conflict(`用户名 "${trimmedUser}" 已存在`)
      }
      throw err
    }
  })

  // 3. 修改用户信息（修改密码、状态 active/disabled、角色）（仅超管）
  app.patch('/users/:id', { preHandler: [app.requireAdmin] }, async (req) => {
    const userId = Number(req.params.id)
    const { password, displayName, role, status } = req.body ?? {}

    const updates = []
    const values = [userId]
    let paramIdx = 2

    if (password) {
      const passwordHash = await bcrypt.hash(password, 10)
      updates.push(`password_hash = $${paramIdx++}`)
      values.push(passwordHash)
    }
    if (displayName !== undefined) {
      updates.push(`display_name = $${paramIdx++}`)
      values.push(displayName.trim())
    }
    if (role !== undefined) {
      if (!['super_admin', 'editor'].includes(role)) {
        throw badRequest("角色必须是 'super_admin' 或 'editor'")
      }
      updates.push(`role = $${paramIdx++}`)
      values.push(role)
    }
    if (status !== undefined) {
      if (!['active', 'disabled'].includes(status)) {
        throw badRequest("状态必须是 'active' 或 'disabled'")
      }
      updates.push(`status = $${paramIdx++}`)
      values.push(status)
    }

    if (updates.length === 0) {
      throw badRequest('没有提供任何需要更新的字段')
    }

    updates.push('updated_at = now()')

    const { rows } = await query(
      `UPDATE users
       SET ${updates.join(', ')}
       WHERE id = $1
       RETURNING id, username, display_name, role, status, updated_at`,
      values,
    )

    if (rows.length === 0) {
      throw notFound('用户')
    }

    return rows[0]
  })

  // 4. 删除用户（仅超管，且不能删除自己）
  app.delete('/users/:id', { preHandler: [app.requireAdmin] }, async (req, reply) => {
    const userId = Number(req.params.id)
    if (userId === req.user.id) {
      throw badRequest('不能删除当前登录的管理员账号')
    }

    const { rowCount } = await query('DELETE FROM users WHERE id = $1', [userId])
    if (rowCount === 0) {
      throw notFound('用户')
    }

    reply.code(204)
    return null
  })

  // 5. 课程协作者管理：为课程指派编者（仅超管）
  app.post('/courses/:id/editors', { preHandler: [app.requireAdmin] }, async (req, reply) => {
    const courseId = Number(req.params.id)
    const { userId } = req.body ?? {}
    if (!userId) {
      throw badRequest('必须指定 userId')
    }

    await query(
      `INSERT INTO course_editors (course_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (course_id, user_id) DO NOTHING`,
      [courseId, userId],
    )

    reply.code(201)
    return { ok: true, courseId, userId }
  })

  // 6. 移除课程的编者（仅超管）
  app.delete('/courses/:id/editors/:userId', { preHandler: [app.requireAdmin] }, async (req, reply) => {
    const courseId = Number(req.params.id)
    const userId = Number(req.params.userId)

    await query('DELETE FROM course_editors WHERE course_id = $1 AND user_id = $2', [
      courseId,
      userId,
    ])

    reply.code(204)
    return null
  })

  // 7. 查询某课程的协作者列表
  app.get('/courses/:id/editors', { preHandler: [app.requireLogin] }, async (req) => {
    const courseId = Number(req.params.id)
    const { rows } = await query(
      `SELECT u.id, u.username, u.display_name, u.role, ce.created_at AS assigned_at
       FROM course_editors ce
       JOIN users u ON ce.user_id = u.id
       WHERE ce.course_id = $1
       ORDER BY u.id ASC`,
      [courseId],
    )
    return rows
  })

  // 8 审计日志查询列表仅超管
  app.get('/audit-logs', { preHandler: [app.requireAdmin] }, async (req) => {
    const rawPage = Number(req.query?.page)
    const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1
    const rawLimit = Number(req.query?.limit)
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(100, Math.floor(rawLimit)) : 20
    const offset = (page - 1) * limit

    const where = []
    const params = []

    if (req.query?.userId) {
      params.push(Number(req.query.userId))
      where.push(`user_id = $${params.length}`)
    }
    if (req.query?.method) {
      params.push(String(req.query.method).toUpperCase())
      where.push(`method = $${params.length}`)
    }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : ''

    const countRes = await query(`SELECT count(*) FROM audit_logs ${whereClause}`, params)
    const total = Number(countRes.rows[0].count)

    params.push(limit, offset)
    const listRes = await query(
      `SELECT id, user_id, username, user_role, method, path, status_code, duration_ms,
              ip_address, user_agent, payload, created_at
       FROM audit_logs
       ${whereClause}
       ORDER BY created_at DESC
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
}
