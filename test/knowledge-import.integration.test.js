import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { buildApp } from '../src/app.js'
import { pool } from '../src/db/pool.js'
import { encryptPayload, decryptPayload } from '../src/lib/crypto.js'

const enabled = process.env.MAKIMATH_INTEGRATION === '1'

test('知识点批量导入保持层级前置方向和事务回滚', { skip: !enabled }, async () => {
  if (!process.env.PGDATABASE || !/^[a-z0-9_]+_test$/i.test(process.env.PGDATABASE)) throw new Error('集成验证必须显式指定名称以测试后缀结尾的独立数据库')
  const app = await buildApp({ logger: false })
  const suffix = randomBytes(6).toString('hex')
  const password = 'example-pass-2026'
  try {
    const database = (await pool.query('SELECT current_database() AS name')).rows[0].name
    assert.equal(database, process.env.PGDATABASE)
    const hash = await bcrypt.hash(password, 12)
    const users = (await pool.query(
      "INSERT INTO users(username,password_hash,role) VALUES ($1,$3,'super_admin'),($2,$3,'editor') RETURNING id,username",
      ['import-admin-' + suffix,'import-editor-' + suffix,hash],
    )).rows
    const target = (await pool.query("INSERT INTO knowledge_categories(slug,name) VALUES ($1,'目标') RETURNING id", ['import-target-' + suffix])).rows[0]
    await app.ready()
    async function call(method, url, payload, token) {
      const response = await app.inject({ method, url: '/api' + url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(payload === undefined ? {} : { payload: encryptPayload(payload) }) })
      const body = response.body ? response.json() : null
      return { status: response.statusCode, data: response.statusCode < 300 && body?.d ? decryptPayload(body) : body }
    }
    const admin = await call('POST', '/auth/login', { username: users[0].username, password })
    const editor = await call('POST', '/auth/login', { username: users[1].username, password })
    const batch = {
      schema_version: 1,
      categories: [
        { id: 'c2', parent_id: 'c1', slug: 'import-child-' + suffix, name: '子分类', pos: 0 },
        { id: 'c1', parent_id: null, slug: 'import-root-' + suffix, name: '根分类', pos: 0 },
      ],
      points: [
        { id: 'a', slug: 'import-point-a-' + suffix, title: '甲', source: '正文甲', category_ids: ['c2'] },
        { id: 'b', slug: 'import-point-b-' + suffix, title: '乙', source: '正文乙', category_ids: [] },
      ],
      edges: [{ source: 'a', target: 'b' }],
    }
    const payload = { category_id: target.id, data: batch }
    assert.equal((await call('POST', '/knowledge-points/import', payload, editor.data.access_token)).status, 403)
    const response = await call('POST', '/knowledge-points/import', payload, admin.data.access_token)
    assert.equal(response.status, 201, JSON.stringify(response.data))
    assert.deepEqual(response.data.counts, { categories: 2, points: 2, edges: 1 })
    const categories = new Map(response.data.categories.map(item => [item.id,item.category_id]))
    const points = new Map(response.data.points.map(item => [item.id,item.point_id]))
    const hierarchy = (await pool.query('SELECT id,parent_id FROM knowledge_categories WHERE id=ANY($1::bigint[])', [[categories.get('c1'),categories.get('c2')]])).rows
    assert.equal(hierarchy.find(row => row.id === categories.get('c1')).parent_id, target.id)
    assert.equal(hierarchy.find(row => row.id === categories.get('c2')).parent_id, categories.get('c1'))
    const links = (await pool.query('SELECT knowledge_point_id,category_id FROM knowledge_point_categories WHERE knowledge_point_id=ANY($1::bigint[]) ORDER BY knowledge_point_id', [[points.get('a'),points.get('b')]])).rows
    assert.deepEqual(links, [{ knowledge_point_id: points.get('a'), category_id: categories.get('c2') }, { knowledge_point_id: points.get('b'), category_id: target.id }])
    const edge = (await pool.query('SELECT knowledge_point_id,prerequisite_id FROM knowledge_prerequisites WHERE knowledge_point_id=$1', [points.get('b')])).rows
    assert.deepEqual(edge, [{ knowledge_point_id: points.get('b'), prerequisite_id: points.get('a') }])
    const invalidTarget = await call('POST', '/knowledge-points/import', { category_id: categories.get('c2'), data: batch }, admin.data.access_token)
    assert.equal(invalidTarget.status, 409)
    const conflicting = structuredClone(batch)
    conflicting.categories[0].slug = 'new-child-' + suffix
    conflicting.categories[1].slug = 'new-root-' + suffix
    const repeated = await call('POST', '/knowledge-points/import', { category_id: target.id, data: conflicting }, admin.data.access_token)
    assert.equal(repeated.status, 409)
    assert.equal(repeated.data.details.field, 'points')
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM knowledge_categories WHERE slug=ANY($1::text[])', [[conflicting.categories[0].slug,conflicting.categories[1].slug]])).rows[0].n), 0)
    const invalid = structuredClone(batch)
    invalid.edges[0].source = 'unknown'
    assert.equal((await call('POST', '/knowledge-points/import', { category_id: target.id, data: invalid }, admin.data.access_token)).status, 400)
  } finally {
    await app.close()
    await pool.end()
  }
})
