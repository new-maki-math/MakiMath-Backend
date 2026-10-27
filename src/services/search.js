import { query } from '../db/pool.js'

export async function search(term, limit) {
  const result = await query(
    `SELECT 'knowledge' AS type,p.id,p.slug,r.id AS revision_id,r.title,r.summary AS descr
       FROM knowledge_points p JOIN knowledge_revisions r ON r.id=p.public_revision_id
      WHERE p.status='active' AND r.status='approved'
        AND (strpos(lower(r.title),lower($1))>0 OR strpos(lower(r.source),lower($1))>0)
      UNION ALL
     SELECT 'lecture' AS type,l.id,l.slug,r.id AS revision_id,r.title,r.descr
       FROM lectures l JOIN lecture_revisions r ON r.id=l.public_revision_id
      WHERE l.publication_status='published' AND r.status='approved'
        AND (strpos(lower(r.title),lower($1))>0 OR strpos(lower(r.descr),lower($1))>0 OR EXISTS (
          SELECT 1 FROM lecture_blocks b
          LEFT JOIN knowledge_revisions k ON k.id=b.knowledge_revision_id
          WHERE b.lecture_revision_id=r.id
            AND (strpos(lower(COALESCE(b.source,'')),lower($1))>0
              OR strpos(lower(COALESCE(k.source,'')),lower($1))>0)
        ))
      ORDER BY type,id LIMIT $2`, [term, limit],
  )
  return result.rows
}
