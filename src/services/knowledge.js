import { query, tx } from '../db/pool.js'
import { badRequest, conflict, notFound } from '../lib/errors.js'
import { requireAdmin } from './access.js'

export async function listPublic() {
  return (await query("SELECT id,slug,title FROM knowledge_points WHERE status='active' ORDER BY id")).rows
}

export async function getPublic(pointId) {
  const row = (await query(
    "SELECT id,slug,title,source FROM knowledge_points WHERE id=$1 AND status='active'", [pointId],
  )).rows[0]
  if (!row) throw notFound('知识点')
  const categories = (await query(
    `SELECT c.id,c.slug,c.name FROM knowledge_point_categories pc
       JOIN knowledge_categories c ON c.id=pc.category_id
      WHERE pc.knowledge_point_id=$1 AND c.status='active' ORDER BY c.pos,c.id`, [pointId],
  )).rows
  return { ...row, categories }
}

export async function manage(user) {
  requireAdmin(user)
  return (await query('SELECT id,slug,title,status,created_by,updated_by,created_at,updated_at FROM knowledge_points ORDER BY id')).rows
}

export async function getManaged(user, pointId) {
  requireAdmin(user)
  const row = (await query('SELECT * FROM knowledge_points WHERE id=$1', [pointId])).rows[0]
  if (!row) throw notFound('知识点')
  return row
}

export async function create(user, data) {
  requireAdmin(user)
  return (await query(
    'INSERT INTO knowledge_points(slug,title,source,created_by,updated_by) VALUES ($1,$2,$3,$4,$4) RETURNING *',
    [data.slug,data.title,data.source,user.id],
  )).rows[0]
}

export async function save(user, pointId, data) {
  requireAdmin(user)
  const row = (await query(
    'UPDATE knowledge_points SET title=$1,source=$2,updated_by=$3 WHERE id=$4 RETURNING *',
    [data.title,data.source,user.id,pointId],
  )).rows[0]
  if (!row) throw notFound('知识点')
  return row
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
  const row = (await query('UPDATE knowledge_points SET status=$1,updated_by=$2 WHERE id=$3 RETURNING *', [status,user.id,pointId])).rows[0]
  if (!row) throw notFound('知识点')
  return row
}

export async function setPrerequisites(user, pointId, ids) {
  requireAdmin(user)
  if (new Set(ids).size !== ids.length) throw badRequest('前置知识点不能重复')
  return tx(async (db) => {
    if (!(await db.query('SELECT id FROM knowledge_points WHERE id=$1 FOR UPDATE', [pointId])).rowCount) throw notFound('知识点')
    await db.query('DELETE FROM knowledge_prerequisites WHERE knowledge_point_id = $1', [pointId])
    for (const prereq of ids) {
      await db.query('INSERT INTO knowledge_prerequisites(knowledge_point_id,prerequisite_id,created_by) VALUES ($1,$2,$3)', [pointId, prereq, user.id])
    }
    await db.query('UPDATE knowledge_points SET updated_by=$1 WHERE id=$2', [user.id,pointId])
    return { knowledge_point_id: pointId, prerequisites: ids }
  })
}

export async function getPrerequisites(pointId) {
  await getPublic(pointId)
  return (await query(
    `SELECT p.id,p.slug,p.title
       FROM knowledge_prerequisites d JOIN knowledge_points p ON p.id=d.prerequisite_id
      WHERE d.knowledge_point_id=$1 AND p.status='active' ORDER BY p.id`, [pointId],
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
    await db.query('UPDATE knowledge_points SET updated_by=$1 WHERE id=$2', [user.id,pointId])
    return { knowledge_point_id: pointId, categories: ids }
  })
}
