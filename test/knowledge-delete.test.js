import test from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../src/db/pool.js'
import { deletePoint, deleteKnowledgeCategory } from '../src/services/knowledge.js'

const admin = { id: 1, role: 'super_admin' }

test('知识点删除拒绝关联并回滚', async () => {
  const original = pool.connect
  const calls = []
  pool.connect = async () => ({
    async query(sql) {
      calls.push(sql)
      if (sql.startsWith('SELECT id FROM knowledge_points')) return { rows: [{ id: 3 }] }
      if (sql.startsWith('SELECT category_id')) return { rows: [{ category_id: 4 }] }
      if (sql.startsWith('SELECT prerequisite_id')) return { rows: [{ prerequisite_id: 5 }] }
      if (sql.startsWith('SELECT knowledge_point_id')) return { rows: [{ knowledge_point_id: 6 }] }
      return { rows: [] }
    },
    release() {},
  })
  try {
    await assert.rejects(() => deletePoint(admin, 3), err => err.status === 409 && err.details.category_ids[0] === 4 && err.details.prerequisite_ids[0] === 5 && err.details.dependent_ids[0] === 6)
    assert.equal(calls.at(-1), 'ROLLBACK')
    assert.equal(calls.some(sql => sql.startsWith('DELETE FROM knowledge_points')), false)
    await assert.rejects(() => deletePoint({ id: 2, role: 'editor' }, 3), { status: 403 })
  } finally {
    pool.connect = original
  }
})

test('知识分类删除先锁定分类图并拒绝子分类和知识点', async () => {
  const original = pool.connect
  const calls = []
  pool.connect = async () => ({
    async query(sql) {
      calls.push(sql)
      if (sql.startsWith('SELECT id FROM knowledge_categories WHERE id')) return { rows: [{ id: 4 }] }
      if (sql.startsWith('SELECT id FROM knowledge_categories WHERE parent_id')) return { rows: [{ id: 5 }] }
      if (sql.startsWith('SELECT knowledge_point_id')) return { rows: [{ knowledge_point_id: 6 }] }
      return { rows: [] }
    },
    release() {},
  })
  try {
    await assert.rejects(() => deleteKnowledgeCategory(admin, 4), err => err.status === 409 && err.details.child_category_ids[0] === 5 && err.details.knowledge_point_ids[0] === 6)
    assert.match(calls[1], /^UPDATE content_graph_locks/)
    assert.match(calls[2], /FOR UPDATE$/)
    assert.equal(calls.at(-1), 'ROLLBACK')
    assert.equal(calls.some(sql => sql.startsWith('DELETE FROM knowledge_categories')), false)
  } finally {
    pool.connect = original
  }
})

test('无关联的知识点在事务中删除', async () => {
  const original = pool.connect
  const calls = []
  pool.connect = async () => ({
    async query(sql) {
      calls.push(sql)
      if (sql.startsWith('SELECT id FROM knowledge_points')) return { rows: [{ id: 3 }] }
      return { rows: [] }
    },
    release() {},
  })
  try {
    await deletePoint(admin, 3)
    assert.ok(calls.some(sql => sql.startsWith('DELETE FROM knowledge_points')))
    assert.equal(calls.at(-1), 'COMMIT')
  } finally {
    pool.connect = original
  }
})
