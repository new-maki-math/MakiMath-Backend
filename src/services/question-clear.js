import { tx } from '../db/pool.js'
import { conflict } from '../lib/errors.js'
import { requireAdmin } from './access.js'

export async function clearOrphaned(user) {
  requireAdmin(user)
  return tx(async db => {
    const lock = await db.query("UPDATE content_graph_locks SET generation=generation+1 WHERE scope='question_categories' RETURNING generation")
    if (!lock.rowCount) throw conflict('题库关系锁不存在')
    const candidates = (await db.query(`SELECT q.id FROM questions q
      WHERE NOT EXISTS (SELECT 1 FROM question_entries e WHERE e.question_id=q.id)
      ORDER BY q.id FOR UPDATE`)).rows.map(row => row.id)
    if (!candidates.length) return { deleted: 0 }
    const ids = (await db.query(`SELECT q.id FROM questions q WHERE q.id=ANY($1::bigint[])
      AND NOT EXISTS (SELECT 1 FROM question_entries e WHERE e.question_id=q.id) ORDER BY q.id`, [candidates])).rows.map(row => row.id)
    if (!ids.length) return { deleted: 0 }
    await db.query('DELETE FROM question_knowledge_points WHERE question_id=ANY($1::bigint[])', [ids])
    const removed = await db.query('DELETE FROM questions WHERE id=ANY($1::bigint[])', [ids])
    return { deleted: removed.rowCount }
  })
}
