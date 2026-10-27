import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { pool } from '../src/db/pool.js'
import { setPrerequisites } from '../src/services/knowledge.js'

const enabled = process.env.MAKIMATH_INTEGRATION === '1'

test('并发替换前置关系只保留一次完整提交', { skip: !enabled, timeout: 15000 }, async () => {
  if (!process.env.PGDATABASE || !/^[a-z0-9_]+_test$/i.test(process.env.PGDATABASE)) {
    throw new Error('集成验证必须显式指定名称以测试后缀结尾的独立数据库')
  }
  const suffix = randomBytes(6).toString('hex')
  let blocker
  let pending
  try {
    const check = await pool.query("SELECT current_database() AS name, to_regclass('public.knowledge_prerequisites') IS NOT NULL AS ready")
    assert.equal(check.rows[0].name, process.env.PGDATABASE)
    assert.equal(check.rows[0].ready, true)
    const admin = (await pool.query(
      "INSERT INTO users(username,password_hash,role) VALUES ($1,'test','super_admin') RETURNING id",
      ['prerequisites-' + suffix],
    )).rows[0]
    const points = (await pool.query(
      "INSERT INTO knowledge_points(slug,title,source,created_by,updated_by) VALUES ($1,'测试','正文',$5,$5),($2,'测试','正文',$5,$5),($3,'测试','正文',$5,$5),($4,'测试','正文',$5,$5) RETURNING id",
      ['target-' + suffix, 'old-' + suffix, 'first-' + suffix, 'second-' + suffix, admin.id],
    )).rows.map(row => row.id)
    const [pointId, oldId, firstId, secondId] = points
    await pool.query(
      'INSERT INTO knowledge_prerequisites(knowledge_point_id,prerequisite_id,created_by) VALUES ($1,$2,$3)',
      [pointId, oldId, admin.id],
    )

    blocker = await pool.connect()
    await blocker.query('BEGIN')
    await blocker.query("UPDATE content_graph_locks SET generation=generation+1 WHERE scope='knowledge_prerequisites'")
    const user = { id: admin.id, role: 'super_admin' }
    pending = Promise.allSettled([
      setPrerequisites(user, pointId, [firstId]),
      setPrerequisites(user, pointId, [secondId]),
    ])

    let waiting = false
    for (let attempt = 0; attempt < 200; attempt++) {
      const activity = await pool.query(
        `SELECT count(*) AS count FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'
            AND (query LIKE 'UPDATE content_graph_locks SET generation=generation+1 WHERE scope=%'
              OR query LIKE 'DELETE FROM knowledge_prerequisites%'
              OR query LIKE 'SELECT id FROM knowledge_points WHERE id=%FOR UPDATE%')`,
      )
      if (Number(activity.rows[0].count) >= 2) {
        waiting = true
        break
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.equal(waiting, true, '两个替换事务未进入预期的并发等待')

    await blocker.query('COMMIT')
    blocker.release()
    blocker = null
    const results = await pending
    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled'])
    const rows = (await pool.query(
      'SELECT prerequisite_id FROM knowledge_prerequisites WHERE knowledge_point_id=$1 ORDER BY prerequisite_id',
      [pointId],
    )).rows.map(row => row.prerequisite_id)
    assert.ok(
      (rows.length === 1 && rows[0] === firstId) || (rows.length === 1 && rows[0] === secondId),
      '最终前置集合必须完整对应其中一次提交',
    )
  } finally {
    if (blocker) {
      await blocker.query('ROLLBACK').catch(() => {})
      blocker.release()
    }
    if (pending) await pending
    await pool.end()
  }
})
