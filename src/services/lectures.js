import { randomUUID } from 'node:crypto'
import { query, tx } from '../db/pool.js'
import { conflict, forbidden, notFound } from '../lib/errors.js'
import { requireUser, lectureAccess } from './access.js'
import { extractKnowledgeReferences } from '../lib/knowledge-references.js'

// 解析各小节源码并检查整个版本的实例标识
export function parseSections(sections, normalize = false) {
  const seen = new Set()
  return sections.map(section => {
    const parsed = extractKnowledgeReferences(section.source)
    if (!normalize && parsed.source !== section.source) throw conflict('已保存的知识点引用缺少实例标识')
    for (const ref of parsed.references) {
      if (seen.has(ref.occurrence_id)) throw conflict('讲义中的知识点引用实例标识重复', { section: section.slug, occurrence_id: ref.occurrence_id, source_offset: ref.source_offset })
      seen.add(ref.occurrence_id)
    }
    return { ...section, source: parsed.source, references: parsed.references }
  })
}

// 批量读取当前公开知识点
export async function resolveReferences(db, sections) {
  const ids = [...new Set(sections.flatMap(section => section.references.map(ref => ref.knowledge_point_id)))]
  const rows = ids.length ? (await db.query(
    `SELECT p.id,p.slug AS knowledge_slug,r.id AS revision_id,r.title AS knowledge_title,
            r.summary AS knowledge_summary,r.source AS knowledge_source,r.animation AS knowledge_animation,
            r.metadata AS knowledge_metadata
       FROM knowledge_points p JOIN knowledge_revisions r ON r.id=p.public_revision_id AND r.status='approved'
      WHERE p.id=ANY($1::bigint[]) AND p.status='active'`, [ids],
  )).rows : []
  const points = new Map(rows.map(row => [row.id, row]))
  return sections.map(section => ({ ...section, references: section.references.map(ref => {
    const point = points.get(ref.knowledge_point_id)
    return { ...ref, section_id: section.id, lecture_revision_id: section.lecture_revision_id,
      knowledge_slug: point?.knowledge_slug ?? null, revision_id: point?.revision_id ?? null,
      knowledge_title: point?.knowledge_title ?? null, knowledge_summary: point?.knowledge_summary ?? null,
      knowledge_source: point?.knowledge_source ?? null, knowledge_animation: point?.knowledge_animation ?? null,
      knowledge_metadata: point?.knowledge_metadata ?? null, availability: point ? 'available' : 'unavailable' }
  }) }))
}

async function snapshot(db, revisionId) {
  const revision = (await db.query('SELECT * FROM lecture_revisions WHERE id=$1', [revisionId])).rows[0]
  if (!revision) throw notFound('讲义版本')
  const chapters = (await db.query('SELECT * FROM lecture_chapters WHERE lecture_revision_id=$1 ORDER BY pos,id', [revisionId])).rows
  const sections = await resolveReferences(db, parseSections((await db.query('SELECT * FROM lecture_sections WHERE lecture_revision_id=$1 ORDER BY pos,id', [revisionId])).rows))
  return { revision, chapters: chapters.map(chapter => ({ ...chapter, sections: sections.filter(section => section.chapter_id === chapter.id) })) }
}

export async function create(user, data) {
  requireUser(user)
  return tx(async (db) => {
    const lecture = (await db.query('INSERT INTO lectures(slug,owner_id) VALUES ($1,$2) RETURNING *', [data.slug, user.id])).rows[0]
    const revision = (await db.query(
      'INSERT INTO lecture_revisions(lecture_id,revision_no,title,created_by) VALUES ($1,1,$2,$3) RETURNING *',
      [lecture.id, data.title, user.id],
    )).rows[0]
    return { lecture, revision }
  })
}

export async function mine(user) {
  requireUser(user)
  return (await query(
    `SELECT DISTINCT l.* FROM lectures l LEFT JOIN lecture_collaborators c ON c.lecture_id=l.id
      WHERE l.owner_id=$1 OR c.user_id=$1 OR $2='super_admin' ORDER BY l.id`, [user.id, user.role],
  )).rows
}

export async function publicList() {
  return (await query(
    `SELECT l.id,l.slug,l.is_recommended,r.id AS revision_id,r.title,r.subtitle,r.descr,r.category_id
       FROM lectures l JOIN lecture_revisions r ON r.id=l.public_revision_id
      WHERE l.publication_status='published' AND r.status='approved' ORDER BY l.id`,
  )).rows
}

export async function publicLecture(lectureId) {
  return tx(async db => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const row = (await db.query(
      `SELECT l.id,l.slug,l.public_revision_id,l.is_recommended FROM lectures l
       JOIN lecture_revisions r ON r.id=l.public_revision_id AND r.status='approved'
       WHERE l.id=$1 AND l.publication_status='published'`, [lectureId],
    )).rows[0]
    if (!row) throw notFound('讲义')
    return { lecture: row, ...(await snapshot(db, row.public_revision_id)) }
  })
}

export async function revision(user, revisionId) {
  requireUser(user)
  return tx(async (db) => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    const row = (await db.query('SELECT lecture_id FROM lecture_revisions WHERE id=$1', [revisionId])).rows[0]
    if (!row) throw notFound('讲义版本')
    await lectureAccess(db, row.lecture_id, user)
    await db.query('SELECT id FROM lecture_revisions WHERE id=$1 FOR SHARE', [revisionId])
    return snapshot(db, revisionId)
  })
}

export async function revisions(user, lectureId) {
  requireUser(user)
  await lectureAccess({ query }, lectureId, user)
  return (await query('SELECT * FROM lecture_revisions WHERE lecture_id=$1 ORDER BY revision_no DESC', [lectureId])).rows
}

async function insertTree(db, revisionId, chapters) {
  const sections = parseSections(chapters.flatMap(chapter => chapter.sections), true)
  const ids = [...new Set(sections.flatMap(section => section.references.map(ref => ref.knowledge_point_id)))]
  const points = ids.length ? (await db.query('SELECT id FROM knowledge_points WHERE id=ANY($1::bigint[]) ORDER BY id FOR KEY SHARE', [ids])).rows : []
  const existing = new Set(points.map(point => point.id))
  for (const section of sections) {
    const missing = section.references.find(ref => !existing.has(ref.knowledge_point_id))
    if (missing) throw conflict('引用的知识点不存在', { section: section.slug, knowledge_point_id: missing.knowledge_point_id, source_offset: missing.source_offset })
  }
  let index = 0
  for (const [i, chapter] of chapters.entries()) {
    const ch = (await db.query(
      `INSERT INTO lecture_chapters(lecture_revision_id,occurrence_id,slug,tag,title,summary,pos)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [revisionId, chapter.occurrence_id ?? randomUUID(), chapter.slug, chapter.tag ?? '', chapter.title ?? '', chapter.summary ?? '', i],
    )).rows[0]
    for (const [j] of chapter.sections.entries()) {
      const section = sections[index++]
      await db.query(
        `INSERT INTO lecture_sections(lecture_revision_id,chapter_id,occurrence_id,slug,tag,title,summary,source,pos)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [revisionId, ch.id, section.occurrence_id ?? randomUUID(), section.slug, section.tag ?? '', section.title ?? '', section.summary ?? '', section.source, j],
      )
    }
  }
}

export async function copyRevision(user, lectureId, baseId) {
  requireUser(user)
  return tx(async (db) => {
    await lectureAccess(db, lectureId, user, 'edit', true)
    const base = (await db.query('SELECT * FROM lecture_revisions WHERE id=$1 AND lecture_id=$2 FOR UPDATE', [baseId, lectureId])).rows[0]
    if (!base) throw notFound('讲义版本')
    if (base.status === 'draft') throw conflict('只能复制已提交的版本')
    const tree = await snapshot(db, base.id)
    const n = (await db.query('SELECT COALESCE(max(revision_no),0)+1 AS n FROM lecture_revisions WHERE lecture_id=$1', [lectureId])).rows[0].n
    const draft = (await db.query(
      `INSERT INTO lecture_revisions(lecture_id,revision_no,based_on_id,category_id,title,subtitle,descr,typst_version,metadata,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [lectureId,n,base.id,base.category_id,base.title,base.subtitle,base.descr,base.typst_version,base.metadata,user.id],
    )).rows[0]
    await insertTree(db, draft.id, tree.chapters)
    return snapshot(db, draft.id)
  })
}

export async function save(user, revisionId, data) {
  requireUser(user)
  return tx(async (db) => {
    const initial = (await db.query('SELECT lecture_id FROM lecture_revisions WHERE id=$1', [revisionId])).rows[0]
    if (!initial) throw notFound('讲义版本')
    await lectureAccess(db, initial.lecture_id, user, 'edit', true)
    const revision = (await db.query('SELECT * FROM lecture_revisions WHERE id=$1 FOR UPDATE', [revisionId])).rows[0]
    if (revision.status !== 'draft') throw conflict('只有草稿可以编辑')
    if (revision.edit_version !== data.edit_version) throw conflict('草稿已被修改请重新加载')
    await db.query('DELETE FROM lecture_sections WHERE lecture_revision_id=$1', [revisionId])
    await db.query('DELETE FROM lecture_chapters WHERE lecture_revision_id=$1', [revisionId])
    await db.query(
      `UPDATE lecture_revisions SET title=$1,subtitle=$2,descr=$3,category_id=$4,typst_version=$5,
       metadata=$6,change_note=$7,edit_version=edit_version+1 WHERE id=$8`,
      [data.title,data.subtitle,data.descr,data.category_id,data.typst_version,data.metadata,data.change_note,revisionId],
    )
    await insertTree(db, revisionId, data.chapters)
    const result = await snapshot(db, revisionId)
    result.warnings = result.chapters.flatMap(ch => ch.sections.flatMap(sec => sec.references.filter(ref => ref.availability === 'unavailable').map(ref => ({ section_id: sec.id, occurrence_id: ref.occurrence_id, knowledge_point_id: ref.knowledge_point_id, source_offset: ref.source_offset }))))
    return result
  })
}

// 检查引用并锁定知识点直到事务结束
export async function ensureReferencesAvailable(db, revisionId) {
  const sections = parseSections((await db.query('SELECT id,slug,source FROM lecture_sections WHERE lecture_revision_id=$1 ORDER BY id', [revisionId])).rows)
  const ids = [...new Set(sections.flatMap(section => section.references.map(ref => ref.knowledge_point_id)))].sort((a,b) => a-b)
  if (!ids.length) return
  const points = (await db.query('SELECT id,status,public_revision_id FROM knowledge_points WHERE id=ANY($1::bigint[]) ORDER BY id FOR SHARE', [ids])).rows
  const revisions = (await db.query("SELECT id FROM knowledge_revisions WHERE id=ANY($1::bigint[]) AND status='approved'", [points.map(point => point.public_revision_id).filter(Boolean)])).rows
  const approved = new Set(revisions.map(row => row.id))
  if (points.length !== ids.length || points.some(point => point.status !== 'active' || !approved.has(point.public_revision_id))) {
    throw conflict('讲义包含不可用的知识点引用')
  }
}

export async function submit(user, revisionId, version) {
  requireUser(user)
  return tx(async (db) => {
    const initial = (await db.query('SELECT lecture_id FROM lecture_revisions WHERE id=$1', [revisionId])).rows[0]
    if (!initial) throw notFound('讲义版本')
    const lecture = await lectureAccess(db, initial.lecture_id, user, 'edit', true)
    const row = (await db.query('SELECT * FROM lecture_revisions WHERE id=$1 FOR UPDATE', [revisionId])).rows[0]
    if (row.status !== 'draft' || row.source_draft_id !== null) throw conflict('只能提交工作草稿')
    if (row.edit_version !== version) throw conflict('草稿已被修改请重新加载')
    const pending = (await db.query("SELECT id FROM lecture_revisions WHERE lecture_id=$1 AND status='pending'", [row.lecture_id])).rows
    if (pending.length) throw conflict('讲义已有待审核快照')
    const ancestor = (await db.query(
      `WITH RECURSIVE history AS (
         SELECT id,based_on_id,status,0 AS depth FROM lecture_revisions WHERE id=$1
         UNION ALL
         SELECT r.id,r.based_on_id,r.status,h.depth+1 FROM lecture_revisions r JOIN history h ON r.id=h.based_on_id
       ) SELECT id FROM history WHERE status='approved' ORDER BY depth LIMIT 1`, [row.based_on_id],
    )).rows[0]
    if ((ancestor?.id ?? null) !== (lecture.public_revision_id ?? null)) throw conflict('公开版本已变更请基于最新公开版本重新整理')
    await ensureReferencesAvailable(db, revisionId)
    const tree = await snapshot(db, revisionId)
    const n = (await db.query('SELECT COALESCE(max(revision_no),0)+1 AS n FROM lecture_revisions WHERE lecture_id=$1', [row.lecture_id])).rows[0].n
    const saved = (await db.query(
      `INSERT INTO lecture_revisions(lecture_id,revision_no,based_on_id,source_draft_id,category_id,title,subtitle,descr,typst_version,metadata,change_note,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [row.lecture_id,n,lecture.public_revision_id,row.id,row.category_id,row.title,row.subtitle,row.descr,row.typst_version,row.metadata,row.change_note,user.id],
    )).rows[0]
    await insertTree(db, saved.id, tree.chapters)
    const submitted = (await db.query("UPDATE lecture_revisions SET status='pending' WHERE id=$1 RETURNING *", [saved.id])).rows[0]
    return { snapshot: submitted, draft_edit_version: row.edit_version }
  })
}

export async function setCollaborator(user, lectureId, targetId, permission) {
  requireUser(user)
  return tx(async (db) => {
    const lecture = await lectureAccess(db, lectureId, user, 'owner', true)
    if (lecture.owner_id === targetId) throw conflict('所有者不需要协作者授权')
    const target = (await db.query("SELECT id FROM users WHERE id=$1 AND status='active'", [targetId])).rows[0]
    if (!target) throw notFound('有效用户')
    return (await db.query(
      `INSERT INTO lecture_collaborators(lecture_id,user_id,permission,invited_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (lecture_id,user_id) DO UPDATE SET permission=EXCLUDED.permission,invited_by=EXCLUDED.invited_by RETURNING *`,
      [lectureId,targetId,permission,user.id],
    )).rows[0]
  })
}

export async function collaborators(user, lectureId) {
  requireUser(user)
  await lectureAccess({ query }, lectureId, user)
  return (await query(
    `SELECT c.user_id,c.permission,c.created_at,u.username,u.display_name
       FROM lecture_collaborators c JOIN users u ON u.id=c.user_id
      WHERE c.lecture_id=$1 ORDER BY c.user_id`, [lectureId],
  )).rows
}

export async function removeCollaborator(user, lectureId, targetId) {
  requireUser(user)
  return tx(async (db) => {
    await lectureAccess(db, lectureId, user, 'owner', true)
    await db.query('DELETE FROM lecture_collaborators WHERE lecture_id=$1 AND user_id=$2', [lectureId,targetId])
  })
}

export async function publication(user, lectureId, status, recommended) {
  requireUser(user)
  return tx(async (db) => {
    const lecture = await lectureAccess(db, lectureId, user, 'owner', true)
    if (recommended !== undefined && user.role !== 'super_admin') throw forbidden('推荐状态由管理员管理')
    const next = status ?? lecture.publication_status
    if (next === 'published' && !lecture.public_revision_id) throw conflict('讲义没有审核通过的版本')
    const flag = next === 'published' ? (recommended ?? lecture.is_recommended) : false
    return (await db.query('UPDATE lectures SET publication_status=$1,is_recommended=$2 WHERE id=$3 RETURNING *', [next,flag,lectureId])).rows[0]
  })
}
