import { randomUUID } from 'node:crypto'
import { query, tx } from '../db/pool.js'
import { conflict, forbidden, notFound } from '../lib/errors.js'
import { requireUser, lectureAccess } from './access.js'

async function snapshot(db, revisionId) {
  const revision = (await db.query('SELECT * FROM lecture_revisions WHERE id=$1', [revisionId])).rows[0]
  if (!revision) throw notFound('讲义版本')
  const chapters = (await db.query('SELECT * FROM lecture_chapters WHERE lecture_revision_id=$1 ORDER BY pos,id', [revisionId])).rows
  const sections = (await db.query('SELECT * FROM lecture_sections WHERE lecture_revision_id=$1 ORDER BY pos,id', [revisionId])).rows
  const blocks = (await db.query(
    `SELECT b.*, k.title AS knowledge_title, k.summary AS knowledge_summary,
            k.source AS knowledge_source, k.animation AS knowledge_animation, k.metadata AS knowledge_metadata
       FROM lecture_blocks b LEFT JOIN knowledge_revisions k ON k.id=b.knowledge_revision_id
      WHERE b.lecture_revision_id=$1 ORDER BY b.pos,b.id`, [revisionId],
  )).rows
  return {
    revision,
    chapters: chapters.map(chapter => ({
      ...chapter,
      sections: sections.filter(s => s.chapter_id === chapter.id).map(section => ({
        ...section, blocks: blocks.filter(b => b.section_id === section.id),
      })),
    })),
  }
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
  const row = (await query(
    `SELECT id,slug,public_revision_id,is_recommended FROM lectures
      WHERE id=$1 AND publication_status='published'`, [lectureId],
  )).rows[0]
  if (!row) throw notFound('讲义')
  return { lecture: row, ...(await snapshot({ query }, row.public_revision_id)) }
}

export async function revision(user, revisionId) {
  requireUser(user)
  return tx(async (db) => {
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
      const sec = (await db.query(
        `INSERT INTO lecture_sections(lecture_revision_id,chapter_id,occurrence_id,slug,tag,title,summary,pos)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [revisionId, ch.id, section.occurrence_id ?? randomUUID(), section.slug, section.tag ?? '', section.title ?? '', section.summary ?? '', j],
      )).rows[0]
      for (const [k, block] of section.blocks.entries()) {
        await db.query(
          `INSERT INTO lecture_blocks(lecture_revision_id,section_id,occurrence_id,block_type,source,knowledge_point_id,knowledge_revision_id,animation,pos)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [revisionId, sec.id, block.occurrence_id ?? randomUUID(), block.block_type, block.source ?? null,
            block.knowledge_point_id ?? null, block.knowledge_revision_id ?? null, block.animation ?? null, k],
        )
      }
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
    await db.query('DELETE FROM lecture_blocks WHERE lecture_revision_id=$1', [revisionId])
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
    await lectureAccess(db, initial.lecture_id, user, 'edit', true)
    const row = (await db.query('SELECT * FROM lecture_revisions WHERE id=$1 FOR UPDATE', [revisionId])).rows[0]
    if (row.status !== 'draft') throw conflict('该版本已提交')
    if (row.edit_version !== version) throw conflict('草稿已被修改请重新加载')
    return (await db.query("UPDATE lecture_revisions SET status='pending',edit_version=edit_version+1 WHERE id=$1 RETURNING *", [revisionId])).rows[0]
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
