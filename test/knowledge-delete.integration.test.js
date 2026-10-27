import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { pool } from '../src/db/pool.js'
import { deletePoint, deleteKnowledgeCategory, setCategories, setPrerequisites } from '../src/services/knowledge.js'

const enabled = process.env.MAKIMATH_INTEGRATION === '1'

test('并发调整关联时删除不会误删已共享知识点或留下悬空前置', { skip: !enabled, timeout: 20000 }, async () => {
  if (!process.env.PGDATABASE || !/^[a-z0-9_]+_test$/i.test(process.env.PGDATABASE)) throw new Error('集成验证必须显式指定名称以测试后缀结尾的独立数据库')
  const suffix = randomBytes(6).toString('hex')
  let blocker
  let pending
  try {
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, process.env.PGDATABASE)
    const admin = (await pool.query("INSERT INTO users(username,password_hash,role) VALUES ($1,'test','super_admin') RETURNING id", ['delete-race-' + suffix])).rows[0]
    const categories = (await pool.query("INSERT INTO knowledge_categories(slug,name) VALUES ($1,'待删分类'),($2,'外部分类') RETURNING id", ['delete-tree-' + suffix,'outside-tree-' + suffix])).rows
    const points = (await pool.query("INSERT INTO knowledge_points(slug,title,source,created_by,updated_by) VALUES ($1,'甲','正文',$4,$4),($2,'乙','正文',$4,$4),($3,'丙','正文',$4,$4) RETURNING id", ['race-a-' + suffix,'race-b-' + suffix,'race-c-' + suffix,admin.id])).rows
    const user = { id: admin.id, role: 'super_admin' }
    await pool.query('INSERT INTO knowledge_point_categories(knowledge_point_id,category_id) VALUES ($1,$2)', [points[0].id,categories[0].id])
    blocker = await pool.connect()
    await blocker.query('BEGIN')
    await blocker.query("UPDATE content_graph_locks SET generation=generation+1 WHERE scope='knowledge_categories'")
    pending = Promise.allSettled([
      deleteKnowledgeCategory(user, categories[0].id),
      setCategories(user, points[0].id, [categories[0].id,categories[1].id]),
    ])
    let waiting = false
    for (let attempt = 0; attempt < 200; attempt++) {
      const activity = await pool.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE content_graph_locks SET generation=generation+1 WHERE scope=%'")
      if (Number(activity.rows[0].n) >= 2) { waiting = true; break }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.equal(waiting, true)
    await blocker.query('COMMIT')
    blocker.release()
    blocker = null
    const results = await pending
    pending = null
    assert.equal(results[0].status, 'fulfilled')
    const remaining = (await pool.query('SELECT id FROM knowledge_points WHERE id=$1', [points[0].id])).rows
    if (results[1].status === 'fulfilled') {
      assert.equal(remaining.length, 1)
      assert.deepEqual((await pool.query('SELECT category_id FROM knowledge_point_categories WHERE knowledge_point_id=$1', [points[0].id])).rows.map(row => row.category_id), [categories[1].id])
    } else {
      assert.equal(remaining.length, 0)
    }
    await pool.query('INSERT INTO knowledge_prerequisites(knowledge_point_id,prerequisite_id,created_by) VALUES ($1,$2,$3)', [points[2].id,points[1].id,admin.id])
    blocker = await pool.connect()
    await blocker.query('BEGIN')
    await blocker.query("UPDATE content_graph_locks SET generation=generation+1 WHERE scope='knowledge_prerequisites'")
    pending = Promise.allSettled([
      deletePoint(user, points[1].id),
      setPrerequisites(user, points[2].id, [points[1].id]),
    ])
    waiting = false
    for (let attempt = 0; attempt < 200; attempt++) {
      const activity = await pool.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE content_graph_locks SET generation=generation+1 WHERE scope=%'")
      if (Number(activity.rows[0].n) >= 2) { waiting = true; break }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.equal(waiting, true)
    await blocker.query('COMMIT')
    blocker.release()
    blocker = null
    const relationResults = await pending
    pending = null
    assert.equal(relationResults[0].status, 'fulfilled')
    assert.equal((await pool.query('SELECT id FROM knowledge_points WHERE id=$1', [points[1].id])).rowCount, 0)
    assert.equal((await pool.query('SELECT id FROM knowledge_points WHERE id=$1', [points[2].id])).rowCount, 1)
    assert.equal((await pool.query('SELECT 1 FROM knowledge_prerequisites WHERE knowledge_point_id=$1 OR prerequisite_id=$1', [points[1].id])).rowCount, 0)
  } finally {
    if (blocker) { await blocker.query('ROLLBACK').catch(() => {}); blocker.release() }
    if (pending) await pending
    await pool.end()
  }
})
