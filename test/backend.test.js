import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { pool } from '../src/db/pool.js'
import { encryptPayload } from '../src/lib/crypto.js'
import { lectureAccess } from '../src/services/access.js'
import { submit as submitLecture } from '../src/services/lectures.js'
import { setPrerequisites, create as createKnowledge, manage as manageKnowledge } from '../src/services/knowledge.js'
import { normalizeIp } from '../src/lib/util.js'
import { animation } from '../src/lib/validate.js'

test('讲义权限区分所有者与查看和编辑协作者', async () => {
  const db = {
    async query(sql, params) {
      if (sql.includes('FROM lectures')) return { rows: [{ id: 1, owner_id: 10 }] }
      return { rows: params[1] === 20 ? [{ permission: 'view' }] : params[1] === 30 ? [{ permission: 'edit' }] : [] }
    },
  }
  await lectureAccess(db, 1, { id: 10, role: 'editor' }, 'owner', true)
  await lectureAccess(db, 1, { id: 20, role: 'editor' }, 'view')
  await assert.rejects(() => lectureAccess(db, 1, { id: 20, role: 'editor' }, 'edit'), { status: 403 })
  await lectureAccess(db, 1, { id: 30, role: 'editor' }, 'edit')
  await assert.rejects(() => lectureAccess(db, 1, { id: 30, role: 'editor' }, 'owner'), { status: 403 })
  await assert.rejects(() => lectureAccess(db, 1, { id: 40, role: 'editor' }, 'view'), { status: 403 })
  await lectureAccess(db, 1, { id: 40, role: 'super_admin' }, 'owner')
})

test('知识点维护只允许管理员操作', async () => {
  await assert.rejects(() => createKnowledge({ id: 10, role: 'editor' }, {}), { status: 403 })
  await assert.rejects(() => createKnowledge(null, {}), { status: 401 })
})

test('知识点管理列表返回全部分类并转换整数', async () => {
  const originalQuery = pool.query
  pool.query = async () => ({ rows: [
    { id: 1, status: 'disabled', category_ids: ['2', '3'] },
    { id: 2, status: 'archived', category_ids: [] },
  ] })
  try {
    const rows = await manageKnowledge({ id: 1, role: 'super_admin' })
    assert.deepEqual(rows.map(row => row.category_ids), [[2, 3], []])
    await assert.rejects(() => manageKnowledge({ id: 2, role: 'editor' }), { status: 403 })
  } finally {
    pool.query = originalQuery
  }
})

test('客户端地址转换', () => {
  assert.equal(normalizeIp('[::1]:8000'), '::1')
  assert.equal(normalizeIp('127.0.0.1:8000'), '127.0.0.1')
  assert.equal(normalizeIp('invalid'), null)
})

test('动画配置拒绝可执行场景代码', () => {
  assert.deepEqual(animation({ steps: [{ title: '示例' }] }), { steps: [{ title: '示例' }] })
  assert.throws(() => animation({ scenes_code: 'return 1' }), { status: 400 })
  assert.throws(() => animation({ steps: [{ scenesCode: 'return 1' }] }), { status: 400 })
})

test('讲义提交拒绝旧版本和重复提交', async () => {
  const originalConnect = pool.connect
  let status = 'draft'
  let version = 2
  const client = {
    async query(sql) {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] }
      if (sql.startsWith('SELECT lecture_id')) return { rows: [{ lecture_id: 1 }] }
      if (sql.startsWith('SELECT * FROM lectures')) return { rows: [{ id: 1, owner_id: 10 }] }
      if (sql.startsWith('SELECT permission')) return { rows: [] }
      if (sql.startsWith('SELECT * FROM lecture_revisions')) return { rows: [{ id: 1, status, source_draft_id: null, edit_version: version }] }
      if (sql.startsWith('SELECT id FROM lecture_revisions WHERE lecture_id')) return { rows: [{ id: 9 }] }
      if (sql.startsWith('UPDATE lecture_revisions')) {
        status = 'pending'
        version++
        return { rows: [{ id: 1, status, source_draft_id: null, edit_version: version }] }
      }
      throw new Error('出现未预期的数据库操作')
    },
    release() {},
  }
  pool.connect = async () => client
  try {
    const user = { id: 10, role: 'editor' }
    await assert.rejects(() => submitLecture(user, 1, 1), { status: 409 })
    await assert.rejects(() => submitLecture(user, 1, 2), { status: 409 })
  } finally {
    pool.connect = originalConnect
  }
})

test('替换前置关系时先锁定知识点并使用同一事务', async () => {
  const originalConnect = pool.connect
  const calls = []
  let released = false
  const client = {
    async query(sql, params) {
      calls.push({ sql, params })
      if (sql.startsWith('SELECT id FROM knowledge_points')) return { rowCount: 1 }
      return { rows: [] }
    },
    release() { released = true },
  }
  pool.connect = async () => client
  try {
    const result = await setPrerequisites({ id: 7, role: 'super_admin' }, 12, [21, 22])
    assert.deepEqual(result, { knowledge_point_id: 12, prerequisites: [21, 22] })
    assert.match(calls[1].sql, /^SELECT id FROM knowledge_points WHERE id\s*=\s*\$1 FOR UPDATE$/)
    assert.deepEqual(calls[1].params, [12])
    assert.equal(calls[0].sql, 'BEGIN')
    assert.match(calls[2].sql, /^DELETE FROM knowledge_prerequisites/)
    assert.equal(calls.filter(call => call.sql.startsWith('INSERT INTO knowledge_prerequisites')).length, 2)
    assert.equal(calls.at(-1).sql, 'COMMIT')
    assert.equal(released, true)
  } finally {
    pool.connect = originalConnect
  }
})

test('路由鉴权和参数检查拒绝无权请求', async () => {
  const originalQuery = pool.query
  pool.query = async (sql, params) => {
    if (sql.includes('JOIN user_sessions')) {
      return { rows: params[1] === 1 ? [{ id: 10, username: 'editor', display_name: '', role: 'editor' }] : [] }
    }
    if (sql.startsWith('INSERT INTO audit_logs')) return { rows: [] }
    throw new Error('测试不能访问真实数据库')
  }
  const app = await buildApp({ logger: false })
  try {
    await app.ready()
    const token = app.jwt.sign({ id: 10, sid: 1, role: 'super_admin' })
    const missing = await app.inject({ method: 'POST', url: '/api/lectures', payload: encryptPayload({ slug: 'demo', title: '讲义' }) })
    assert.equal(missing.statusCode, 401)
    const forbidden = await app.inject({ method: 'GET', url: '/api/reviews/lecture/pending', headers: { authorization: `Bearer ${token}` } })
    assert.equal(forbidden.statusCode, 403)
    const expiredToken = app.jwt.sign({ id: 10, sid: 2, role: 'super_admin' })
    const expired = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${expiredToken}` } })
    assert.equal(expired.statusCode, 401)
    const legacyToken = app.jwt.sign({ id: 10, role: 'super_admin' })
    const legacy = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${legacyToken}` } })
    assert.equal(legacy.statusCode, 401)
    const invalid = await app.inject({
      method: 'POST', url: '/api/lectures', headers: { authorization: `Bearer ${token}` },
      payload: encryptPayload({ slug: 'demo', title: '讲义', owner_id: 999 }),
    })
    assert.equal(invalid.statusCode, 400)
    const old = await app.inject({ method: 'GET', url: '/api/courses' })
    assert.equal(old.statusCode, 404)
    const pubkey = await app.inject({ method: 'GET', url: '/api/auth/pubkey' })
    assert.equal(pubkey.statusCode, 200)
    assert.ok(pubkey.json().pubkey)
  } finally {
    await app.close()
    pool.query = originalQuery
  }
})
