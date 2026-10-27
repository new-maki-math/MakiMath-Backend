import { query, tx } from '../db/pool.js'
import { conflict, notFound } from '../lib/errors.js'
import { requireAdmin } from './access.js'
import { animation } from '../lib/validate.js'
import { ensureReferencesAvailable } from './lectures.js'
import { extractKnowledgeReferences } from '../lib/knowledge-references.js'

export async function pending(user, kind) {
  requireAdmin(user)
  const table = kind === 'knowledge' ? 'knowledge_revisions' : 'lecture_revisions'
  return (await query(`SELECT * FROM ${table} WHERE status='pending' ORDER BY submitted_at, id`)).rows
}

export async function decide(user, kind, revisionId, data) {
  requireAdmin(user)
  return tx(async (db) => {
    const knowledge = kind === 'knowledge'
    const table = knowledge ? 'knowledge_revisions' : 'lecture_revisions'
    const parent = knowledge ? 'knowledge_points' : 'lectures'
    const parentKey = knowledge ? 'knowledge_point_id' : 'lecture_id'
    const reviewTable = knowledge ? 'knowledge_reviews' : 'lecture_reviews'
    const reviewKey = knowledge ? 'knowledge_revision_id' : 'lecture_revision_id'
    const initial = (await db.query(`SELECT ${parentKey} FROM ${table} WHERE id=$1`, [revisionId])).rows[0]
    if (!initial) throw notFound('版本')
    const parentRow = (await db.query(`SELECT * FROM ${parent} WHERE id=$1 FOR UPDATE`, [initial[parentKey]])).rows[0]
    const row = (await db.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`, [revisionId])).rows[0]
    if (row.status !== 'pending') throw conflict('该版本不处于待审核状态')
    if (data.decision === 'approved') {
      if (knowledge && row.animation !== null) animation(row.animation)
      if (knowledge) extractKnowledgeReferences(row.source, { forbid: true })
      else await ensureReferencesAvailable(db, revisionId)
      const ancestor = (await db.query(
        `WITH RECURSIVE history AS (
           SELECT id,based_on_id,status,0 AS depth FROM ${table} WHERE id=$1
           UNION ALL
           SELECT r.id,r.based_on_id,r.status,h.depth+1 FROM ${table} r JOIN history h ON r.id=h.based_on_id
         ) SELECT id FROM history WHERE status='approved' ORDER BY depth LIMIT 1`, [row.based_on_id],
      )).rows[0]
      if ((ancestor?.id ?? null) !== (parentRow.public_revision_id ?? null)) {
        throw conflict('公开版本已变更请基于最新公开版本重新提交')
      }
    }
    const review = (await db.query(
      `INSERT INTO ${reviewTable}(${reviewKey},reviewer_id,decision,comment) VALUES ($1,$2,$3,$4) RETURNING *`,
      [revisionId, user.id, data.decision, data.comment],
    )).rows[0]
    if (data.decision === 'approved') {
      if (knowledge) {
        await db.query('UPDATE knowledge_points SET public_revision_id=$1 WHERE id=$2', [revisionId, row.knowledge_point_id])
      } else {
        await db.query("UPDATE lectures SET public_revision_id=$1, publication_status='published' WHERE id=$2", [revisionId, row.lecture_id])
        if (row.source_draft_id) await db.query("UPDATE lecture_revisions SET based_on_id=$1,edit_version=edit_version+1 WHERE id=$2 AND status='draft'", [revisionId,row.source_draft_id])
      }
    }
    return review
  })
}
