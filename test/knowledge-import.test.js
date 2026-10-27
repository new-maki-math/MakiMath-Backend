import test from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../src/db/pool.js'
import { validateKnowledgeImport } from '../src/lib/knowledge-import.js'
import { importPoints } from '../src/services/knowledge.js'

const sample = () => ({
  schema_version: 1,
  categories: [
    { id: 'child', parent_id: 'root', slug: 'child', name: '子分类', pos: 0 },
    { id: 'root', parent_id: null, slug: 'root', name: '分类', pos: 0 },
  ],
  points: [
    { id: 'a', slug: 'point-a', title: '甲', source: '正文甲', category_ids: ['child'] },
    { id: 'b', slug: 'point-b', title: '乙', source: '正文乙', category_ids: [] },
  ],
  edges: [{ source: 'a', target: 'b' }],
})

test('导入校验分类顺序和文件内局部标识', () => {
  assert.deepEqual(validateKnowledgeImport(sample()).categoryOrder, ['root','child'])
  const unknown = sample()
  unknown.edges[0].source = '999'
  assert.throws(() => validateKnowledgeImport(unknown), { status: 400 })
  const cycle = sample()
  cycle.edges.push({ source: 'b', target: 'a' })
  assert.throws(() => validateKnowledgeImport(cycle), { status: 400 })
  const categoryCycle = sample()
  categoryCycle.categories[1].parent_id = 'child'
  assert.throws(() => validateKnowledgeImport(categoryCycle), { status: 400 })
  const duplicate = sample()
  duplicate.points[1].slug = duplicate.points[0].slug
  assert.throws(() => validateKnowledgeImport(duplicate), { status: 409 })
})

test('导入使用同一事务并正确映射前置方向', async () => {
  const originalConnect = pool.connect
  const calls = []
  let categoryId = 10
  let pointId = 20
  pool.connect = async () => ({
    async query(sql, params) {
      calls.push({ sql, params })
      if (sql.startsWith('SELECT id,parent_id,status')) return { rows: [{ id: 1, parent_id: null, status: 'active' }] }
      if (sql.startsWith('INSERT INTO knowledge_categories')) return { rows: [{ id: categoryId++ }] }
      if (sql.startsWith('INSERT INTO knowledge_points')) return { rows: [{ id: pointId++ }] }
      return { rows: [] }
    },
    release() {},
  })
  try {
    const result = await importPoints({ id: 4, role: 'super_admin' }, 1, sample())
    assert.deepEqual(result.counts, { categories: 2, points: 2, edges: 1 })
    const categories = calls.filter(call => call.sql.startsWith('INSERT INTO knowledge_categories'))
    assert.deepEqual(categories.map(call => call.params[0]), [1,10])
    const associations = calls.find(call => call.sql.startsWith('INSERT INTO knowledge_point_categories'))
    assert.deepEqual(associations.params, [[20,21],[11,1]])
    const edges = calls.find(call => call.sql.startsWith('INSERT INTO knowledge_prerequisites'))
    assert.deepEqual(edges.params, [[20],[21],4])
    assert.equal(calls.at(-1).sql, 'COMMIT')
    await assert.rejects(() => importPoints({ id: 3, role: 'editor' }, 1, sample()), { status: 403 })
  } finally {
    pool.connect = originalConnect
  }
})

test('导入别名冲突回滚并返回条目位置', async () => {
  const originalConnect = pool.connect
  const calls = []
  pool.connect = async () => ({
    async query(sql) {
      calls.push(sql)
      if (sql.startsWith('SELECT id,parent_id,status')) return { rows: [{ id: 1, parent_id: null, status: 'active' }] }
      if (sql.startsWith('INSERT INTO knowledge_categories')) throw Object.assign(new Error('duplicate'), { code: '23505', constraint: 'knowledge_categories_slug_key' })
      return { rows: [] }
    },
    release() {},
  })
  try {
    await assert.rejects(() => importPoints({ id: 4, role: 'super_admin' }, 1, sample()), err => err.status === 409 && err.details.index === 1)
    assert.equal(calls.at(-1), 'ROLLBACK')
  } finally {
    pool.connect = originalConnect
  }
})
