import { randomUUID } from 'node:crypto'
import { query, tx } from '../db/pool.js'
import { conflict, forbidden, notFound } from '../lib/errors.js'
import { requireUser, requireAdmin, lectureAccess, requireUnarchived } from './access.js'

async function snapshot(db, revisionId) {
  const revision = (await db.query('SELECT * FROM lecture_revisions WHERE id=$1', [revisionId])).rows[0]
  if (!revision) throw notFound('讲义版本')
  const chapters = (await db.query('SELECT * FROM lecture_chapters WHERE lecture_revision_id=$1 ORDER BY pos,id', [revisionId])).rows
  const sections = (await db.query('SELECT * FROM lecture_sections WHERE lecture_revision_id=$1 ORDER BY pos,id', [revisionId])).rows
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

export async function owned(user) {
  requireUser(user)
  const rows = (await query(
    `SELECT l.id AS lecture_id,l.slug,l.publication_status,l.public_revision_id,
            r.id AS revision_id,r.revision_no,r.source_draft_id,r.status,r.title,r.subtitle,r.updated_at
       FROM lectures l LEFT JOIN lecture_revisions r ON r.lecture_id=l.id
      WHERE l.owner_id=$1
      ORDER BY COALESCE(MAX(r.updated_at) OVER (PARTITION BY l.id),l.updated_at) DESC,l.id DESC,
               CASE WHEN r.status='draft' AND r.source_draft_id IS NULL THEN 0 ELSE 1 END,
               r.revision_no DESC NULLS LAST,r.id DESC NULLS LAST`, [user.id],
  )).rows
  const lectures = new Map()
  for (const row of rows) {
    if (!lectures.has(row.lecture_id)) {
      lectures.set(row.lecture_id, {
        id: row.lecture_id, slug: row.slug, publication_status: row.publication_status,
        public_revision_id: row.public_revision_id, versions: [],
      })
    }
    if (row.revision_id === null) continue
    lectures.get(row.lecture_id).versions.push({
      revision_id: row.revision_id, revision_no: row.revision_no,
      kind: row.status === 'draft' && row.source_draft_id === null ? 'working_draft' : 'snapshot',
      status: row.status, title: row.title, subtitle: row.subtitle, updated_at: row.updated_at,
      is_public: row.publication_status === 'published' && row.public_revision_id === row.revision_id && row.status === 'approved',
    })
  }
  return [...lectures.values()]
}

export async function publicList() {
  return (await query(
    `SELECT l.id,l.slug,l.is_recommended,r.id AS revision_id,r.title,r.subtitle,r.descr,r.category_id
       FROM lectures l JOIN lecture_revisions r ON r.id=l.public_revision_id
      WHERE l.publication_status='published' AND r.status='approved' ORDER BY l.id`,
  )).rows
}

export async function lectureBySlug(user, lectureSlug, requestedRevisionId = null) {
  return tx(async db => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const row = (await db.query(
      'SELECT id,slug,owner_id,publication_status,public_revision_id,is_recommended FROM lectures WHERE slug=$1', [lectureSlug],
    )).rows[0]
    if (!row) throw notFound('讲义')
    let authorized = Boolean(user && (user.role === 'super_admin' || user.id === row.owner_id))
    if (user && !authorized) {
      authorized = Boolean((await db.query('SELECT 1 FROM lecture_collaborators WHERE lecture_id=$1 AND user_id=$2', [row.id,user.id])).rows[0])
    }
    let revisionId = requestedRevisionId
    if (revisionId === null && row.publication_status === 'published') revisionId = row.public_revision_id
    if (revisionId === null) {
      if (!authorized) throw notFound('讲义')
      const drafts = (await db.query(
        "SELECT id,title,status,updated_at FROM lecture_revisions WHERE lecture_id=$1 AND status='draft' AND source_draft_id IS NULL ORDER BY updated_at DESC,id DESC", [row.id],
      )).rows
      if (drafts.length !== 1) throw conflict('请选择讲义版本', { lecture_id: row.id, drafts })
      revisionId = drafts[0].id
    }
    const selected = (await db.query('SELECT id,status FROM lecture_revisions WHERE id=$1 AND lecture_id=$2', [revisionId,row.id])).rows[0]
    const published = Boolean(selected && row.publication_status === 'published' && row.public_revision_id === selected.id && selected.status === 'approved')
    if (!selected || (!authorized && !published)) throw notFound('讲义')
    const lecture = { id: row.id, slug: row.slug, public_revision_id: row.public_revision_id, is_recommended: row.is_recommended }
    return { lecture, ...(await snapshot(db, selected.id)) }
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
  for (const [i, chapter] of chapters.entries()) {
    const ch = (await db.query(
      `INSERT INTO lecture_chapters(lecture_revision_id,occurrence_id,slug,tag,title,summary,pos)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [revisionId, chapter.occurrence_id ?? randomUUID(), chapter.slug, chapter.tag ?? '', chapter.title ?? '', chapter.summary ?? '', i],
    )).rows[0]
    for (const [j, section] of chapter.sections.entries()) {
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
    const lecture = await lectureAccess(db, lectureId, user, 'edit', true)
    requireUnarchived(lecture)
    const draft = (await db.query("SELECT id FROM lecture_revisions WHERE lecture_id=$1 AND status='draft' AND source_draft_id IS NULL", [lectureId])).rows[0]
    if (draft) throw conflict('讲义已有工作草稿', { draft_id: draft.id })
    const base = (await db.query('SELECT * FROM lecture_revisions WHERE id=$1 AND lecture_id=$2 FOR UPDATE', [baseId, lectureId])).rows[0]
    if (!base) throw notFound('讲义版本')
    if (base.status === 'draft') throw conflict('只能复制已提交的版本')
    const tree = await snapshot(db, base.id)
    const n = (await db.query('SELECT COALESCE(max(revision_no),0)+1 AS n FROM lecture_revisions WHERE lecture_id=$1', [lectureId])).rows[0].n
    const createdDraft = (await db.query(
      `INSERT INTO lecture_revisions(lecture_id,revision_no,based_on_id,category_id,title,subtitle,descr,typst_version,metadata,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [lectureId,n,base.id,base.category_id,base.title,base.subtitle,base.descr,base.typst_version,base.metadata,user.id],
    )).rows[0]
    await insertTree(db, createdDraft.id, tree.chapters)
    return snapshot(db, createdDraft.id)
  })
}

export async function save(user, revisionId, data) {
  requireUser(user)
  return tx(async (db) => {
    const initial = (await db.query('SELECT lecture_id FROM lecture_revisions WHERE id=$1', [revisionId])).rows[0]
    if (!initial) throw notFound('讲义版本')
    const lecture = await lectureAccess(db, initial.lecture_id, user, 'edit', true)
    requireUnarchived(lecture)
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
    return snapshot(db, revisionId)
  })
}

export async function submit(user, revisionId, version) {
  requireUser(user)
  return tx(async (db) => {
    const initial = (await db.query('SELECT lecture_id FROM lecture_revisions WHERE id=$1', [revisionId])).rows[0]
    if (!initial) throw notFound('讲义版本')
    const lecture = await lectureAccess(db, initial.lecture_id, user, 'edit', true)
    requireUnarchived(lecture)
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
    requireUnarchived(lecture)
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
    const lecture = await lectureAccess(db, lectureId, user, 'owner', true)
    requireUnarchived(lecture)
    await db.query('DELETE FROM lecture_collaborators WHERE lecture_id=$1 AND user_id=$2', [lectureId,targetId])
  })
}

export async function publication(user, lectureId, status, recommended) {
  requireUser(user)
  return tx(async (db) => {
    const lecture = await lectureAccess(db, lectureId, user, 'owner', true)
    requireUnarchived(lecture)
    if (recommended !== undefined && user.role !== 'super_admin') throw forbidden('推荐状态由管理员管理')
    const next = status ?? lecture.publication_status
    if (next === 'published' && !lecture.public_revision_id) throw conflict('讲义没有审核通过的版本')
    const flag = next === 'published' ? (recommended ?? lecture.is_recommended) : false
    return (await db.query('UPDATE lectures SET publication_status=$1,is_recommended=$2 WHERE id=$3 RETURNING *', [next,flag,lectureId])).rows[0]
  })
}

export async function restore(user, lectureId) {
  requireUser(user)
  return tx(async db => {
    const lecture = await lectureAccess(db, lectureId, user, 'owner', true)
    if (lecture.publication_status !== 'archived') throw conflict('讲义未归档')
    const status = lecture.public_revision_id ? 'withdrawn' : 'unpublished'
    return (await db.query('UPDATE lectures SET publication_status=$1,is_recommended=false WHERE id=$2 RETURNING *', [status,lectureId])).rows[0]
  })
}

export async function deleteArchived(user, lectureId) {
  requireAdmin(user)
  return tx(async db => {
    const lecture = await lectureAccess(db, lectureId, user, 'owner', true)
    if (lecture.publication_status !== 'archived') throw conflict('只有已归档的讲义可以永久删除')
    await db.query("SELECT set_config('maki.lecture_delete_id', $1, true)", [String(lectureId)])
    await db.query('UPDATE lectures SET public_revision_id=NULL WHERE id=$1', [lectureId])
    await db.query('DELETE FROM lecture_reviews WHERE lecture_revision_id IN (SELECT id FROM lecture_revisions WHERE lecture_id=$1)', [lectureId])
    await db.query('DELETE FROM lecture_sections WHERE lecture_revision_id IN (SELECT id FROM lecture_revisions WHERE lecture_id=$1)', [lectureId])
    await db.query('DELETE FROM lecture_chapters WHERE lecture_revision_id IN (SELECT id FROM lecture_revisions WHERE lecture_id=$1)', [lectureId])
    await db.query('DELETE FROM lecture_revisions WHERE lecture_id=$1', [lectureId])
    await db.query('DELETE FROM lecture_collaborators WHERE lecture_id=$1', [lectureId])
    await db.query('DELETE FROM lectures WHERE id=$1', [lectureId])
  })
}
