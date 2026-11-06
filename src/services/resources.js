import { createHash, createHmac } from 'node:crypto'
import { PDFDocument } from 'pdf-lib'
import { query, tx } from '../db/pool.js'
import { badRequest, conflict, forbidden, HttpError, notFound } from '../lib/errors.js'
import { requireAdmin } from './access.js'
import { normalizeIp } from '../lib/util.js'
import { config } from '../config.js'

const fields = `id,parent_id,kind,name,description,is_system,size_bytes,content_hash,CASE WHEN kind='pdf' THEN download_count ELSE NULL END AS download_count,created_at,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at`
const limit = 524288000
const windowSeconds = 43200
const lockTree = db => db.query('SELECT pg_advisory_xact_lock(1296124745,1)')

async function get(db, resourceId, lock = false) {
  const row = (await db.query(`SELECT ${fields} FROM resources WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [resourceId])).rows[0]
  if (!row) throw notFound('资源')
  return row
}

async function parent(db, parentId) {
  if (parentId === null) return null
  const row = await get(db, parentId, true)
  if (row.kind !== 'folder') throw conflict('目标资源不是文件夹')
  return row
}

async function ancestors(db, resourceId) {
  return (await db.query(`WITH RECURSIVE path AS (
    SELECT id,parent_id,name,kind,is_system,0 AS depth FROM resources WHERE id=$1
    UNION ALL SELECT r.id,r.parent_id,r.name,r.kind,r.is_system,p.depth+1 FROM resources r JOIN path p ON r.id=p.parent_id
  ) SELECT id,name,kind,is_system FROM path ORDER BY depth DESC`, [resourceId])).rows
}

export async function list(user, options) {
  return tx(async db => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    let current = null
    let breadcrumbs = []
    if (options.parentId !== null) {
      current = await get(db, options.parentId)
      if (current.kind !== 'folder') throw notFound('文件夹')
      breadcrumbs = await ancestors(db, current.id)
    }
    const column = options.sort === 'name' ? 'lower(name)' : 'updated_at'
    const direction = options.order === 'asc' ? 'ASC' : 'DESC'
    const params = [options.parentId, options.limit, options.offset]
    const items = (await db.query(`SELECT ${fields} FROM resources WHERE parent_id IS NOT DISTINCT FROM $1
      ORDER BY CASE WHEN is_system THEN 1 ELSE 0 END,CASE WHEN kind='folder' THEN 0 ELSE 1 END,${column} ${direction},id ASC LIMIT $2 OFFSET $3`, params)).rows
    const total = (await db.query('SELECT count(*) AS n FROM resources WHERE parent_id IS NOT DISTINCT FROM $1', [options.parentId])).rows[0].n
    return { current, breadcrumbs, items, pagination: { offset: options.offset, limit: options.limit, total } }
  })
}

export async function detail(user, resourceId) {
  return tx(async db => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const resource = await get(db, resourceId)
    return { resource, breadcrumbs: await ancestors(db, resourceId) }
  })
}

export async function validatePdf(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || buffer.length > 33554432 || buffer.subarray(0,5).toString('ascii') !== '%PDF-') throw badRequest('文件必须是有效 PDF 且不超过 32 MiB')
  try { const pdf = await PDFDocument.load(buffer, { throwOnInvalidObject: true }); if (pdf.getPageCount() < 1) throw new Error('empty') }
  catch { throw badRequest('PDF 文件无法解析或没有页面') }
  return { data: buffer, hash: createHash('sha256').update(buffer).digest('hex') }
}

export async function create(user, data, pdf = null) {
  requireAdmin(user)
  return tx(async db => {
    await lockTree(db)
    await parent(db, data.parent_id)
    return (await db.query(`INSERT INTO resources(parent_id,kind,name,description,size_bytes,content_hash,content)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${fields}`,
      [data.parent_id,pdf ? 'pdf' : 'folder',data.name,data.description,pdf?.data.length ?? null,pdf?.hash ?? null,pdf?.data ?? null])).rows[0]
  })
}

export async function update(user, resourceId, data, pdf = null) {
  requireAdmin(user)
  return tx(async db => {
    await lockTree(db)
    const row = await get(db, resourceId, true)
    if (row.is_system) throw conflict('系统目录不可编辑')
    if (row.updated_at !== data.updated_at) throw conflict('资源已修改请重新加载')
    if (pdf && row.kind !== 'pdf') throw conflict('文件夹不能替换正文')
    return (await db.query(`UPDATE resources SET name=$2,description=$3,size_bytes=CASE WHEN $4::bytea IS NULL THEN size_bytes ELSE octet_length($4::bytea) END,
       content=COALESCE($4::bytea,content),content_hash=COALESCE($5,content_hash) WHERE id=$1 RETURNING ${fields}`,
      [resourceId,data.name ?? row.name,data.description ?? row.description,pdf?.data ?? null,pdf?.hash ?? null])).rows[0]
  })
}

export async function move(user, resourceId, destination) {
  requireAdmin(user)
  return tx(async db => {
    await lockTree(db)
    const row = await get(db, resourceId, true)
    if (row.is_system) throw conflict('系统目录不可移动')
    await parent(db, destination)
    return (await db.query(`UPDATE resources SET parent_id=$2 WHERE id=$1 RETURNING ${fields}`, [resourceId,destination])).rows[0]
  })
}

export async function copy(user, resourceId, destination, name) {
  requireAdmin(user)
  return tx(async db => {
    await lockTree(db)
    const source = await get(db, resourceId, true)
    await parent(db, destination)
    const rows = (await db.query(`WITH RECURSIVE tree AS (
      SELECT id,parent_id,0 AS depth FROM resources WHERE id=$1
      UNION ALL SELECT r.id,r.parent_id,t.depth+1 FROM resources r JOIN tree t ON r.parent_id=t.id
    ) SELECT id,parent_id,depth FROM tree ORDER BY depth,id`, [resourceId])).rows
    const copies = new Map()
    for (const item of rows) {
      const parentId = item.id === resourceId ? destination : copies.get(item.parent_id)
      const row = (await db.query(`INSERT INTO resources(parent_id,kind,name,description,size_bytes,content_hash,content)
        SELECT $2,kind,CASE WHEN id=$3 THEN $4 ELSE name END,description,size_bytes,content_hash,content FROM resources WHERE id=$1 RETURNING ${fields}`,
        [item.id,parentId,resourceId,name])).rows[0]
      copies.set(item.id,row.id)
      if (item.id === resourceId) copies.set('root',row)
    }
    return copies.get('root')
  })
}

export async function remove(user, resourceId) {
  requireAdmin(user)
  return tx(async db => {
    await lockTree(db)
    const row = await get(db, resourceId, true)
    if (row.is_system) throw conflict('系统目录不可删除')
    const rows = (await db.query(`WITH RECURSIVE tree AS (
      SELECT id,0 AS depth FROM resources WHERE id=$1
      UNION ALL SELECT r.id,t.depth+1 FROM resources r JOIN tree t ON r.parent_id=t.id
    ) SELECT id,depth FROM tree ORDER BY depth DESC,id`, [resourceId])).rows
    for (const item of rows) await db.query('DELETE FROM resources WHERE id=$1', [item.id])
    return { deleted: rows.length }
  })
}

function quotaIdentity(user, ip) {
  if (user) return { userId: user.id, anonymousKey: null }
  const normalized = normalizeIp(ip)
  if (!normalized) throw badRequest('无法识别访问来源')
  const canonical = normalized.includes(':') ? new URL(`http://[${normalized}]/`).hostname : normalized
  return { userId: null, anonymousKey: createHmac('sha256', config.jwt.secret).update(`resource-quota:${canonical}`).digest('hex') }
}

async function quotaInfo(db, identity) {
  const column = identity.userId !== null ? 'user_id' : 'anonymous_key'
  const value = identity.userId ?? identity.anonymousKey
  const row = (await db.query(`SELECT COALESCE(sum(bytes),0) AS used_bytes,min(created_at)+interval '12 hours' AS next_available_at
      FROM resource_download_usage WHERE ${column}=$1 AND bytes > 0 AND created_at > clock_timestamp()-interval '12 hours'`, [value])).rows[0]
  return { unlimited: false, limit_bytes: limit, used_bytes: Number(row.used_bytes), remaining_bytes: Math.max(0,limit-Number(row.used_bytes)), window_seconds: windowSeconds, next_available_at: row.next_available_at }
}

export async function quota(user, ip) {
  const identity = quotaIdentity(user, ip)
  const account = user ? (await query("SELECT role FROM users WHERE id=$1 AND status='active'", [user.id])).rows[0] : null
  if (user && !account) throw forbidden('账号不可用')
  const usage = await quotaInfo({ query },identity)
  return account?.role === 'super_admin' ? { ...usage, unlimited: true, limit_bytes: null, remaining_bytes: null, next_available_at: null } : usage
}

export async function content(user, resourceId, range, head = false, ip) {
  const identity = quotaIdentity(user, ip)
  return tx(async db => {
    if (!head && !range) await lockTree(db)
    let account = null
    if (user) {
      account = (await db.query("SELECT id,role FROM users WHERE id=$1 AND status='active' FOR UPDATE", [user.id])).rows[0]
      if (!account) throw forbidden('账号不可用')
    } else {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [identity.anonymousKey])
    }
    const row = await get(db, resourceId, true)
    if (row.kind !== 'pdf') throw notFound('资源')
    const size = row.size_bytes
    let start = 0, end = size - 1
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range)
      if (!m || (!m[1] && !m[2])) throw new HttpError(416, '不支持的字节范围', { size })
      if (!m[1]) { const suffix = Number(m[2]); if (!Number.isSafeInteger(suffix) || suffix < 1) throw new HttpError(416,'字节范围无效',{ size }); start = Math.max(0,size-suffix) }
      else { start = Number(m[1]); if (m[2]) end = Number(m[2]); if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) throw new HttpError(416,'字节范围无效',{ size }); end = Math.min(end,size-1) }
    }
    const length = end-start+1
    if (head) return { resource: row, size, start, end, partial: Boolean(range), data: null }
    const column = identity.userId !== null ? 'user_id' : 'anonymous_key'
    await db.query(`DELETE FROM resource_download_usage WHERE ${column}=$1 AND created_at <= clock_timestamp()-interval '12 hours'`, [identity.userId ?? identity.anonymousKey])
    if (account?.role !== 'super_admin') {
      const current = await quotaInfo(db,identity)
      if (length > current.remaining_bytes) throw new HttpError(429, '下载额度不足', { code: 'DOWNLOAD_QUOTA_EXCEEDED', ...current })
    }
    const data = (await db.query('SELECT substring(content FROM $2 FOR $3) AS data FROM resources WHERE id=$1', [resourceId,start+1,length])).rows[0].data
    if (account?.role !== 'super_admin') await db.query('INSERT INTO resource_download_usage(user_id,anonymous_key,bytes) VALUES ($1,$2,$3)', [identity.userId,identity.anonymousKey,length])
    if (!range) await db.query('UPDATE resources SET download_count=download_count+1 WHERE id=$1', [resourceId])
    return { resource: row, size, start, end, partial: Boolean(range), data }
  })
}

