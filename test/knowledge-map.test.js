import test from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../src/db/pool.js'
import { knowledgeMap } from '../src/services/knowledge-map.js'

test('知识地图使用同一只读快照返回节点和边', async () => {
  const original = pool.connect
  const calls = []
  pool.connect = async () => ({
    async query(sql, params) {
      calls.push({ sql, params })
      if (sql.startsWith('SELECT id FROM knowledge_categories')) return { rows: [{ id: 1 }] }
      if (sql.startsWith('SELECT id,parent_id')) return { rows: [{ id: 1, parent_id: null, slug: 'a', name: '分类', pos: 0 }] }
      if (sql.includes('WITH RECURSIVE subtree')) return { rows: [{ id: 10, slug: 'p', title: '知识点', category_ids: ['1'] }] }
      if (sql.includes('FROM knowledge_prerequisites')) return { rows: [] }
      return { rows: [] }
    },
    release() {},
  })
  try {
    const map = await knowledgeMap(1)
    assert.deepEqual(map.nodes[0].category_ids, [1])
    assert.deepEqual(map.stats, { category_count: 1, node_count: 1, edge_count: 0 })
    assert.deepEqual(map.filter, { category_id: 1, include_descendants: true })
    assert.equal(calls[0].sql, 'BEGIN')
    assert.equal(calls[1].sql, 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    assert.deepEqual(calls.find(call => call.sql.includes('FROM knowledge_prerequisites')).params, [[10]])
    assert.equal(calls.at(-1).sql, 'COMMIT')
  } finally {
    pool.connect = original
  }
})

test('地图拒绝无效的筛选分类', async () => {
  const original = pool.connect
  const calls = []
  pool.connect = async () => ({
    async query(sql) { calls.push(sql); return { rows: [] } },
    release() {},
  })
  try {
    await assert.rejects(() => knowledgeMap(7), { status: 404 })
    assert.equal(calls.at(-1), 'ROLLBACK')
  } finally {
    pool.connect = original
  }
})
