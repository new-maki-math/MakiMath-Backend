import { tx } from '../db/pool.js'
import { parseSections } from './lectures.js'

export async function search(term, limit) {
  return tx(async db => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const knowledge = (await db.query(
      `SELECT 'knowledge' AS type,p.id,p.slug,r.id AS revision_id,r.title,r.summary AS descr
         FROM knowledge_points p JOIN knowledge_revisions r ON r.id=p.public_revision_id
        WHERE p.status='active' AND r.status='approved'
          AND (strpos(lower(r.title),lower($1))>0 OR strpos(lower(r.source),lower($1))>0)
        ORDER BY p.id`, [term],
    )).rows
    const contentMatches = (await db.query(
      `SELECT p.id FROM knowledge_points p JOIN knowledge_revisions r ON r.id=p.public_revision_id
        WHERE p.status='active' AND r.status='approved' AND strpos(lower(r.source),lower($1))>0`, [term],
    )).rows
    const matchedIds = new Set(contentMatches.map(point => point.id))
    const rows = (await db.query(
      `SELECT l.id,l.slug,r.id AS revision_id,r.title,r.descr,s.id AS section_id,s.slug AS section_slug,s.source,
              (strpos(lower(r.title),lower($1))>0 OR strpos(lower(r.descr),lower($1))>0 OR strpos(lower(COALESCE(s.source,'')),lower($1))>0) AS matched
         FROM lectures l JOIN lecture_revisions r ON r.id=l.public_revision_id AND r.status='approved'
         LEFT JOIN lecture_sections s ON s.lecture_revision_id=r.id
        WHERE l.publication_status='published' ORDER BY l.id,s.id`, [term],
    )).rows
    const lectures = new Map()
    for (const row of rows) {
      let entry = lectures.get(row.id)
      if (!entry) {
        entry = { type: 'lecture', id: row.id, slug: row.slug, revision_id: row.revision_id, title: row.title, descr: row.descr, matched: false, sections: [] }
        lectures.set(row.id, entry)
      }
      entry.matched ||= row.matched
      if (row.section_id !== null) entry.sections.push({ id: row.section_id, slug: row.section_slug, source: row.source })
    }
    const hits = []
    for (const entry of lectures.values()) {
      const sections = parseSections(entry.sections)
      if (entry.matched || sections.some(section => section.references.some(ref => matchedIds.has(ref.knowledge_point_id)))) {
        const { matched, sections: discarded, ...hit } = entry
        hits.push(hit)
      }
    }
    return [...knowledge, ...hits].slice(0, limit)
  })
}
