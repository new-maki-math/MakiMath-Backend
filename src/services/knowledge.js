import { query, tx } from '../db/pool.js'
import { badRequest, conflict, notFound } from '../lib/errors.js'
import { requireAdmin, requireUser, knowledgeDraftAccess } from './access.js'

export async function listPublic() {
  return (await query(
    `SELECT p.id, p.slug, p.status, r.id AS revision_id, r.title, r.summary
       FROM knowledge_points p JOIN knowledge_revisions r ON r.id = p.public_revision_id
      WHERE p.status = 'active' AND r.status = 'approved' ORDER BY p.id`,
  )).rows
}

export async function getPublic(pointId) {
  const row = (await query(
    `SELECT p.id, p.slug, r.id AS revision_id, r.revision_no, r.title, r.summary, r.source, r.animation, r.metadata
       FROM knowledge_points p JOIN knowledge_revisions r ON r.id = p.public_revision_id
      WHERE p.id = $1 AND p.status = 'active' AND r.status = 'approved'`, [pointId],
  )).rows[0]
  if (!row) throw notFound('知识点')
  const categories = (await query(
    `SELECT c.id,c.slug,c.name FROM knowledge_point_categories pc
       JOIN knowledge_categories c ON c.id=pc.category_id
      WHERE pc.knowledge_point_id=$1 AND c.status='active' ORDER BY c.pos,c.id`, [pointId],
  )).rows
  return { ...row, categories }
}

export async function getPublicRevision(pointId, revisionId) {
  const row = (await query(
    `SELECT p.id,p.slug,r.id AS revision_id,r.revision_no,r.title,r.summary,r.source,r.animation,r.metadata
       FROM knowledge_points p JOIN knowledge_revisions r ON r.knowledge_point_id=p.id
      WHERE p.id=$1 AND r.id=$2 AND p.status='active' AND r.status='approved'`, [pointId,revisionId],
  )).rows[0]
  if (!row) throw notFound('知识点版本')
  return row
}

export async function create(user, data) {
  requireUser(user)
  return tx(async (db) => {
    const point = (await db.query('INSERT INTO knowledge_points(slug, created_by) VALUES ($1,$2) RETURNING *', [data.slug, user.id])).rows[0]
    const revision = (await db.query(
      'INSERT INTO knowledge_revisions(knowledge_point_id, revision_no, title, source, contributor_id) VALUES ($1,1,$2,$3,$4) RETURNING *',
      [point.id, data.title, data.source, user.id],
    )).rows[0]
    return { point, revision }
  })
}

export async function createRevision(user, pointId, baseId) {
  requireUser(user)
  return tx(async (db) => {
    const point = (await db.query('SELECT * FROM knowledge_points WHERE id = $1 FOR UPDATE', [pointId])).rows[0]
    if (!point) throw notFound('知识点')
    if (point.status !== 'active') throw conflict('知识点不可编辑')
    const base = (await db.query('SELECT * FROM knowledge_revisions WHERE id = $1 AND knowledge_point_id = $2', [baseId, pointId])).rows[0]
    if (!base) throw notFound('知识点版本')
    if (base.status !== 'approved') knowledgeDraftAccess(base, user)
    if (base.status === 'draft') throw conflict('只能复制已提交的版本')
    const n = (await db.query('SELECT COALESCE(max(revision_no),0) + 1 AS n FROM knowledge_revisions WHERE knowledge_point_id = $1', [pointId])).rows[0].n
    return (await db.query(
      `INSERT INTO knowledge_revisions(knowledge_point_id, revision_no, based_on_id, title, summary, source, animation, metadata, contributor_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [pointId, n, base.id, base.title, base.summary, base.source, base.animation, base.metadata, user.id],
    )).rows[0]
  })
}

export async function getRevision(user, revisionId) {
  requireUser(user)
  const revision = (await query('SELECT * FROM knowledge_revisions WHERE id = $1', [revisionId])).rows[0]
  if (!revision) throw notFound('知识点版本')
  if (revision.status !== 'approved') knowledgeDraftAccess(revision, user)
  return revision
}

export async function myRevisions(user) {
  requireUser(user)
  return (await query(
    `SELECT r.id,r.knowledge_point_id,r.revision_no,r.title,r.status,r.edit_version,r.submitted_at,r.updated_at
       FROM knowledge_revisions r WHERE r.contributor_id=$1 ORDER BY r.updated_at DESC`, [user.id],
  )).rows
}

export async function save(user, revisionId, data) {
  requireUser(user)
  return tx(async (db) => {
    const revision = (await db.query('SELECT * FROM knowledge_revisions WHERE id = $1 FOR UPDATE', [revisionId])).rows[0]
    if (!revision) throw notFound('知识点版本')
    knowledgeDraftAccess(revision, user)
    if (revision.status !== 'draft') throw conflict('只有草稿可以编辑')
    if (revision.edit_version !== data.edit_version) throw conflict('草稿已被修改请重新加载')
    return (await db.query(
      `UPDATE knowledge_revisions SET title=$1, summary=$2, source=$3, animation=$4, metadata=$5, change_note=$6, edit_version=edit_version+1
        WHERE id=$7 RETURNING *`,
      [data.title, data.summary, data.source, data.animation, data.metadata, data.change_note, revisionId],
    )).rows[0]
  })
}

export async function submit(user, revisionId, version) {
  requireUser(user)
  return tx(async (db) => {
    const row = (await db.query('SELECT * FROM knowledge_revisions WHERE id = $1 FOR UPDATE', [revisionId])).rows[0]
    if (!row) throw notFound('知识点版本')
    knowledgeDraftAccess(row, user)
    if (row.status !== 'draft') throw conflict('该版本已提交')
    if (row.edit_version !== version) throw conflict('草稿已被修改请重新加载')
    return (await db.query("UPDATE knowledge_revisions SET status='pending', edit_version=edit_version+1 WHERE id=$1 RETURNING *", [revisionId])).rows[0]
  })
}

export async function categories(kind) {
  const table = kind === 'knowledge' ? 'knowledge_categories' : 'lecture_categories'
  return (await query(`SELECT id, parent_id, slug, name, descr, pos FROM ${table} WHERE status='active' ORDER BY pos,id`)).rows
}

export async function createCategory(user, kind, data) {
  requireAdmin(user)
  const table = kind === 'knowledge' ? 'knowledge_categories' : 'lecture_categories'
  return (await query(
    `INSERT INTO ${table}(parent_id,slug,name,descr,pos) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [data.parent_id ?? null, data.slug, data.name, data.descr ?? '', data.pos ?? 0],
  )).rows[0]
}

export async function updateCategory(user, kind, categoryId, data) {
  requireAdmin(user)
  const table = kind === 'knowledge' ? 'knowledge_categories' : 'lecture_categories'
  return tx(async (db) => {
    const current = (await db.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`, [categoryId])).rows[0]
    if (!current) throw notFound('分类')
    return (await db.query(
      `UPDATE ${table} SET parent_id=$1,name=$2,descr=$3,pos=$4,status=$5 WHERE id=$6 RETURNING *`,
      [data.parent_id, data.name, data.descr, data.pos, data.status, categoryId],
    )).rows[0]
  })
}

export async function setPointStatus(user, pointId, status) {
  requireAdmin(user)
  const row = (await query('UPDATE knowledge_points SET status=$1 WHERE id=$2 RETURNING *', [status,pointId])).rows[0]
  if (!row) throw notFound('知识点')
  return row
}

export async function setPrerequisites(user, pointId, ids) {
  requireAdmin(user)
  if (new Set(ids).size !== ids.length) throw badRequest('前置知识点不能重复')
  return tx(async (db) => {
    if (!(await db.query('SELECT 1 FROM knowledge_points WHERE id = $1', [pointId])).rowCount) throw notFound('知识点')
    await db.query('DELETE FROM knowledge_prerequisites WHERE knowledge_point_id = $1', [pointId])
    for (const prereq of ids) {
      await db.query('INSERT INTO knowledge_prerequisites(knowledge_point_id,prerequisite_id,created_by) VALUES ($1,$2,$3)', [pointId, prereq, user.id])
    }
    return { knowledge_point_id: pointId, prerequisites: ids }
  })
}

export async function getPrerequisites(pointId) {
  await getPublic(pointId)
  return (await query(
    `SELECT p.id,p.slug,r.id AS revision_id,r.title
       FROM knowledge_prerequisites d JOIN knowledge_points p ON p.id=d.prerequisite_id
       JOIN knowledge_revisions r ON r.id=p.public_revision_id
      WHERE d.knowledge_point_id=$1 AND p.status='active' AND r.status='approved' ORDER BY p.id`, [pointId],
  )).rows
}

export async function setCategories(user, pointId, ids) {
  requireAdmin(user)
  if (new Set(ids).size !== ids.length) throw badRequest('知识分类不能重复')
  return tx(async (db) => {
    if (!(await db.query('SELECT id FROM knowledge_points WHERE id=$1 FOR UPDATE', [pointId])).rowCount) throw notFound('知识点')
    await db.query('DELETE FROM knowledge_point_categories WHERE knowledge_point_id=$1', [pointId])
    for (const categoryId of ids) {
      await db.query('INSERT INTO knowledge_point_categories(knowledge_point_id,category_id) VALUES ($1,$2)', [pointId,categoryId])
    }
    return { knowledge_point_id: pointId, categories: ids }
  })
}
