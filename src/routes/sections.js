import { query, tx } from '../db/pool.js'
import { badRequest, notFound } from '../lib/errors.js'
import { reorder } from '../lib/order.js'
import { parseTypst } from '../lib/typst-to-json.js'
import { checkSlug, pick, setClause, sha256, toId, toIdArray } from '../lib/util.js'

// source 与 source_hash 走单独的 PUT /sections/:id/source
const META = ['slug', 'tag', 'title', 'summary', 'pos']

// 生成章节内不冲突的唯一 slug
async function resolveUniqueSlug(client, chapterId, baseSlug) {
  let candidate = baseSlug
  let counter = 1
  while (true) {
    const res = await client.query(
      'SELECT id FROM sections WHERE chapter_id = $1 AND slug = $2',
      [chapterId, candidate]
    )
    if (res.rowCount === 0) return candidate
    candidate = `${baseSlug}-${counter}`
    counter++
  }
}

// 校验小节 id 都存在
async function checkSectionIds(ids) {
  if (ids.length === 0) return []
  const res = await query('SELECT id FROM sections WHERE id = ANY($1::bigint[])', [ids])
  const found = new Set(res.rows.map((r) => r.id))
  const missing = ids.filter((id) => !found.has(id))
  if (missing.length > 0) throw badRequest(`这些小节的 id 不存在：${missing.join(', ')}`)
  return ids
}

export default async function sectionRoutes(app) {
  // 按章节列出，不含 source
  app.get('/sections', async (req) => {
    const chapterId = toId(req.query.chapter_id, 'chapter_id')
    const res = await query(
      `SELECT id, chapter_id, slug, tag, title, summary, pos, prereqs, source_hash,
              length(source) AS source_len,
              (source IS NOT NULL AND source <> '') AS has_source,
              created_at, updated_at
         FROM sections WHERE chapter_id = $1 ORDER BY pos, id`,
      [chapterId],
    )
    return res.rows
  })

  // 详情，含原始 Typst 源码
  app.get('/sections/:id', async (req) => {
    const res = await query(
      `SELECT s.*, ch.course_id, ch.title AS chapter_title, ch.pos AS chapter_pos,
              c.title AS course_title, c.status AS course_status
         FROM sections s
         JOIN chapters ch ON ch.id = s.chapter_id
         JOIN courses  c  ON c.id  = ch.course_id
        WHERE s.id = $1`,
      [toId(req.params.id)],
    )
    if (res.rowCount === 0) throw notFound('小节')
    const row = res.rows[0]
    if (!req.user && row.course_status !== 'live') throw notFound('小节')
    return row
  })

  // 获取小节讲义正文与 AST
  app.get('/sections/:id/doc', async (req) => {
    const res = await query(
      `SELECT s.*, ch.course_id, ch.title AS chapter_title, ch.tag AS chapter_tag,
              ch.pos AS chapter_pos, c.slug AS course_slug, c.title AS course_title,
              c.status AS course_status
         FROM sections s
         JOIN chapters ch ON ch.id = s.chapter_id
         JOIN courses  c  ON c.id  = ch.course_id
        WHERE s.id = $1`,
      [toId(req.params.id)],
    )
    if (res.rowCount === 0) throw notFound('小节')
    const { course_status, ...meta } = res.rows[0]
    if (!req.user && course_status !== 'live') throw notFound('小节')
    return { ...meta, doc: parseTypst(meta.source || '') }
  })

  // 新建，pos 未给则排到末尾
  app.post('/sections', { preHandler: [app.requireLogin] }, async (req, reply) => {
    const b = req.body ?? {}
    checkSlug(b.slug)
    if (!b.title) throw badRequest('title 必填')
    const chapterId = toId(b.chapter_id, 'chapter_id')

    const source = typeof b.source === 'string' ? b.source : String(b.source ?? '')
    const hash = sha256(source)

    const res = await query(
      `INSERT INTO sections (chapter_id, slug, tag, title, summary, pos, source, source_hash, updated_by)
       VALUES ($1, $2, $3, $4, $5,
               coalesce($6::integer,
                        (SELECT coalesce(max(pos), -1) + 1 FROM sections WHERE chapter_id = $1)),
               $7, $8, $9)
       RETURNING id, chapter_id, slug, tag, title, summary, pos, prereqs,
                 source_hash, length(source) AS source_len, created_at, updated_at`,
      [chapterId, b.slug, b.tag ?? '', b.title, b.summary ?? '', b.pos ?? null, source, hash, req.user?.id ?? null],
    )
    return reply.code(201).send(res.rows[0])
  })

  app.patch('/sections/:id', { preHandler: [app.requireLogin] }, async (req) => {
    const fields = pick(req.body ?? {}, META)
    if (fields.slug !== undefined) checkSlug(fields.slug)
    if (Object.keys(fields).length === 0) throw badRequest('没有可更新的字段')

    fields.updated_by = req.user?.id ?? null
    const set = setClause(fields)
    const res = await query(
      `UPDATE sections SET ${set.text}, updated_at = now()
        WHERE id = $${set.params.length + 1}
       RETURNING id, chapter_id, slug, tag, title, summary, pos, prereqs,
                 source_hash, length(source) AS source_len, updated_at`,
      [...set.params, toId(req.params.id)],
    )
    if (res.rowCount === 0) throw notFound('小节')
    return res.rows[0]
  })

  // 保存原始 Typst 源码，自动计算 sha256 hash
  app.put('/sections/:id/source', { preHandler: [app.requireLogin] }, async (req) => {
    const source = typeof req.body?.source === 'string' ? req.body.source : String(req.body?.source ?? '')
    const hash = sha256(source)

    const res = await query(
      `UPDATE sections SET source = $1, source_hash = $2, updated_by = $3, updated_at = now()
        WHERE id = $4
       RETURNING id, source_hash, length(source) AS source_len, updated_at`,
      [source, hash, req.user?.id ?? null, toId(req.params.id)],
    )
    if (res.rowCount === 0) throw notFound('小节')
    return res.rows[0]
  })

  // 保存前置小节，数组列无外键，这里校验
  app.put('/sections/:id/prereqs', { preHandler: [app.requireLogin] }, async (req) => {
    const id = toId(req.params.id)
    const prereqs = toIdArray(req.body?.prereqs, 'prereqs')

    if (prereqs.includes(id)) throw badRequest('不能把自己设为前置小节')
    await checkSectionIds(prereqs)

    const res = await query(
      'UPDATE sections SET prereqs = $1::bigint[], updated_by = $2, updated_at = now() WHERE id = $3 RETURNING id, prereqs',
      [prereqs, req.user?.id ?? null, id],
    )
    if (res.rowCount === 0) throw notFound('小节')
    return res.rows[0]
  })

  app.delete('/sections/:id', { preHandler: [app.requireLogin] }, async (req, reply) => {
    const res = await query('DELETE FROM sections WHERE id = $1 RETURNING id', [toId(req.params.id)])
    if (res.rowCount === 0) throw notFound('小节')
    return reply.code(204).send()
  })

  // 批量删除小节
  app.post('/sections/batch-delete', { preHandler: [app.requireLogin] }, async (req) => {
    const ids = toIdArray(req.body?.ids, 'ids')
    if (ids.length === 0) return { ok: true, count: 0, ids: [] }

    const res = await query(
      'DELETE FROM sections WHERE id = ANY($1::bigint[]) RETURNING id',
      [ids]
    )
    return { ok: true, count: res.rowCount, ids: res.rows.map((r) => r.id) }
  })

  // 批量移动小节到目标章节
  app.post('/sections/batch-move', { preHandler: [app.requireLogin] }, async (req) => {
    const ids = toIdArray(req.body?.ids, 'ids')
    const targetChapterId = toId(req.body?.target_chapter_id, 'target_chapter_id')
    if (ids.length === 0) return { ok: true, count: 0 }

    return tx(async (client) => {
      const ch = await client.query('SELECT id FROM chapters WHERE id = $1', [targetChapterId])
      if (ch.rowCount === 0) throw notFound('目标章节')

      const secRes = await client.query(
        'SELECT id, chapter_id, slug FROM sections WHERE id = ANY($1::bigint[]) ORDER BY pos, id',
        [ids]
      )
      if (secRes.rowCount === 0) return { ok: true, count: 0 }

      const posRes = await client.query(
        'SELECT coalesce(max(pos), -1) AS max_pos FROM sections WHERE chapter_id = $1',
        [targetChapterId]
      )
      let curPos = posRes.rows[0].max_pos

      for (const row of secRes.rows) {
        curPos++
        let targetSlug = row.slug
        if (row.chapter_id !== targetChapterId) {
          targetSlug = await resolveUniqueSlug(client, targetChapterId, row.slug)
        }
        await client.query(
          'UPDATE sections SET chapter_id = $1, slug = $2, pos = $3, updated_by = $4, updated_at = now() WHERE id = $5',
          [targetChapterId, targetSlug, curPos, req.user?.id ?? null, row.id]
        )
      }
      return { ok: true, count: secRes.rowCount, target_chapter_id: targetChapterId }
    })
  })

  // 批量复制小节（可复制到本章节或其他章节）
  app.post('/sections/batch-copy', { preHandler: [app.requireLogin] }, async (req) => {
    const ids = toIdArray(req.body?.ids, 'ids')
    const targetChapterId = req.body?.target_chapter_id ? toId(req.body.target_chapter_id, 'target_chapter_id') : null
    if (ids.length === 0) return { ok: true, count: 0, new_ids: [] }

    return tx(async (client) => {
      const secRes = await client.query(
        'SELECT * FROM sections WHERE id = ANY($1::bigint[]) ORDER BY pos, id',
        [ids]
      )
      if (secRes.rowCount === 0) return { ok: true, count: 0, new_ids: [] }

      const newIds = []
      for (const row of secRes.rows) {
        const destChapterId = targetChapterId ?? row.chapter_id

        const ch = await client.query('SELECT id FROM chapters WHERE id = $1', [destChapterId])
        if (ch.rowCount === 0) throw notFound('目标章节')

        const posRes = await client.query(
          'SELECT coalesce(max(pos), -1) + 1 AS next_pos FROM sections WHERE chapter_id = $1',
          [destChapterId]
        )
        const nextPos = posRes.rows[0].next_pos

        const baseSlug = (destChapterId === row.chapter_id) ? `${row.slug}-copy` : row.slug
        const uniqueSlug = await resolveUniqueSlug(client, destChapterId, baseSlug)
        const newTitle = (destChapterId === row.chapter_id) ? `${row.title} (副本)` : row.title

        const insRes = await client.query(
          `INSERT INTO sections (chapter_id, slug, tag, title, summary, pos, source, source_hash, prereqs, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id`,
          [
            destChapterId,
            uniqueSlug,
            row.tag,
            newTitle,
            row.summary,
            nextPos,
            row.source,
            row.source_hash,
            row.prereqs,
            req.user?.id ?? null,
          ]
        )
        newIds.push(insRes.rows[0].id)
      }
      return { ok: true, count: newIds.length, new_ids: newIds }
    })
  })

  app.put('/sections/order', { preHandler: [app.requireLogin] }, async (req) => {
    const chapterId = toId(req.body?.chapter_id, 'chapter_id')
    const ids = (req.body?.ids ?? []).map((v) => toId(v, 'ids 里的元素'))
    await tx((client) => reorder(client, 'sections', chapterId, ids))
    return { ok: true, count: ids.length }
  })
}
