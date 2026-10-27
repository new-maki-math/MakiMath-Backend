import test from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../src/db/pool.js'
import { deletePoint, deleteKnowledgeCategory } from '../src/services/knowledge.js'

const admin = { id: 1, role: 'super_admin' }

test('知识点删除在事务内清理关联', async () => {
  const original = pool.connect
  const calls = []
  pool.connect = async () => ({
    async query(sql, params) {
      calls.push({ sql, params })
      if (sql.startsWith('SELECT id FROM knowledge_points')) return { rows: [{ id: 3 }] }
      return { rows: [] }
    },
    release() {},
  })
  try {
    await deletePoint(admin, 3)
    assert.match(calls[1].sql, /^UPDATE content_graph_locks/)
    assert.match(calls[2].sql, /FOR UPDATE$/)
    assert.match(calls[3].sql, /^DELETE FROM knowledge_point_categories/)
    assert.match(calls[4].sql, /^DELETE FROM knowledge_prerequisites.*knowledge_point_id=\$1 OR prerequisite_id=\$1/)
    assert.match(calls[5].sql, /^DELETE FROM knowledge_points/)
    assert.equal(calls.at(-1).sql, 'COMMIT')
    await assert.rejects(() => deletePoint({ id: 2, role: 'editor' }, 3), { status: 403 })
  } finally {
    pool.connect = original
  }
})

test('分类删除仅删除分类树内的专属知识点', async () => {
  const original = pool.connect
  const calls = []
  pool.connect = async () => ({
    async query(sql, params) {
      calls.push({ sql, params })
      if (sql.includes('WITH RECURSIVE subtree')) return { rows: [{ id: 5, depth: 1 }, { id: 4, depth: 0 }] }
      if (sql.startsWith('SELECT p.id FROM knowledge_points')) return { rows: [{ id: 10 }, { id: 11 }] }
      if (sql.startsWith('SELECT knowledge_point_id,category_id')) return { rows: [
        { knowledge_point_id: 10, category_id: 5 },
        { knowledge_point_id: 11, category_id: 4 },
        { knowledge_point_id: 11, category_id: 40 },
      ] }
      return { rows: [] }
    },
    release() {},
  })
  try {
    await deleteKnowledgeCategory(admin, 4)
    assert.match(calls[1].sql, /knowledge_categories/)
    assert.match(calls[2].sql, /knowledge_prerequisites/)
    const deletePoints = calls.find(call => call.sql.startsWith('DELETE FROM knowledge_points'))
    assert.deepEqual(deletePoints.params, [[10]])
    const deleteEdges = calls.find(call => call.sql.startsWith('DELETE FROM knowledge_prerequisites'))
    assert.deepEqual(deleteEdges.params, [[10]])
    assert.deepEqual(calls.filter(call => call.sql === 'DELETE FROM knowledge_categories WHERE id=$1').map(call => call.params[0]), [5,4])
    assert.equal(calls.at(-1).sql, 'COMMIT')
  } finally {
    pool.connect = original
  }
})

test('知识点删除失败时回滚全部清理', async () => {
  const original = pool.connect
  const calls = []
  pool.connect = async () => ({
    async query(sql) {
      calls.push(sql)
      if (sql.startsWith('SELECT id FROM knowledge_points')) return { rows: [{ id: 3 }] }
      if (sql.startsWith('DELETE FROM knowledge_points')) throw new Error('删除失败')
      return { rows: [] }
    },
    release() {},
  })
  try {
    await assert.rejects(() => deletePoint(admin, 3), /删除失败/)
    assert.ok(calls.some(sql => sql.startsWith('DELETE FROM knowledge_point_categories')))
    assert.equal(calls.at(-1), 'ROLLBACK')
  } finally {
    pool.connect = original
  }
})
