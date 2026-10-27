import { query } from '../db/pool.js'

export async function search(term, limit) {
  const rows = (await query(
    `SELECT 'knowledge' AS type,p.id,p.slug,NULL::bigint AS revision_id,p.title,NULL::text AS descr
       FROM knowledge_points p
      WHERE p.status='active'
        AND (strpos(lower(p.title),lower($1))>0 OR strpos(lower(p.source),lower($1))>0)
      UNION ALL
     SELECT 'lecture' AS type,l.id,l.slug,r.id AS revision_id,r.title,r.descr
       FROM lectures l JOIN lecture_revisions r ON r.id=l.public_revision_id
      WHERE l.publication_status='published' AND r.status='approved'
        AND (strpos(lower(r.title),lower($1))>0 OR strpos(lower(r.descr),lower($1))>0 OR EXISTS (
          SELECT 1 FROM lecture_sections s WHERE s.lecture_revision_id=r.id AND strpos(lower(s.source),lower($1))>0
        ))
      ORDER BY type,id LIMIT $2`, [term, limit],
  )).rows
  return rows.map(row => {
    if (row.type !== 'knowledge') return row
    const { revision_id, descr, ...point } = row
    return point
  })
}
