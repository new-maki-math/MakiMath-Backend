import { query, tx } from '../db/pool.js'
import { conflict, notFound } from '../lib/errors.js'
import { requireAdmin } from './access.js'

export async function pending(user) {
  requireAdmin(user)
  return (await query("SELECT * FROM lecture_revisions WHERE status='pending' ORDER BY submitted_at,id")).rows
}

export async function decide(user, kind, revisionId, data) {
  requireAdmin(user)
  return tx(async db => {
    const initial = (await db.query('SELECT lecture_id FROM lecture_revisions WHERE id=$1', [revisionId])).rows[0]
    if (!initial) throw notFound('讲义版本')
    const lecture = (await db.query('SELECT * FROM lectures WHERE id=$1 FOR UPDATE', [initial.lecture_id])).rows[0]
    const revision = (await db.query('SELECT * FROM lecture_revisions WHERE id=$1 FOR UPDATE', [revisionId])).rows[0]
    if (revision.status !== 'pending') throw conflict('该版本不处于待审核状态')
    if (data.decision === 'approved') {
      const ancestor = (await db.query(
        `WITH RECURSIVE history AS (
           SELECT id,based_on_id,status,0 AS depth FROM lecture_revisions WHERE id=$1
           UNION ALL
           SELECT r.id,r.based_on_id,r.status,h.depth+1 FROM lecture_revisions r JOIN history h ON r.id=h.based_on_id
         ) SELECT id FROM history WHERE status='approved' ORDER BY depth LIMIT 1`, [revision.based_on_id],
      )).rows[0]
      if ((ancestor?.id ?? null) !== (lecture.public_revision_id ?? null)) throw conflict('公开版本已变更请基于最新公开版本重新提交')
    }
    const review = (await db.query(
      'INSERT INTO lecture_reviews(lecture_revision_id,reviewer_id,decision,comment) VALUES ($1,$2,$3,$4) RETURNING *',
      [revisionId,user.id,data.decision,data.comment],
    )).rows[0]
    if (data.decision === 'approved') {
      await db.query("UPDATE lectures SET public_revision_id=$1,publication_status='published' WHERE id=$2", [revisionId,revision.lecture_id])
      if (revision.source_draft_id) await db.query("UPDATE lecture_revisions SET based_on_id=$1,edit_version=edit_version+1 WHERE id=$2 AND status='draft'", [revisionId,revision.source_draft_id])
    }
    return review
  })
}
