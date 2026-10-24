import { query, tx } from '../db/pool.js'
import { badRequest, notFound } from '../lib/errors.js'
import { reorder } from '../lib/order.js'
import { checkSlug, pick, setClause, toId, toIdArray } from '../lib/util.js'

const META = ['slug', 'tag', 'title', 'summary', 'pos']

export default async function chapterRoutes(app) {
  // 按课程列出，带小节数
  app.get('/chapters', async (req) => {
    const courseId = toId(req.query.course_id, 'course_id')
    const res = await query(
      `SELECT ch.*,
              (SELECT count(*) FROM sections s WHERE s.chapter_id = ch.id) AS section_count
         FROM chapters ch
        WHERE ch.course_id = $1
        ORDER BY ch.pos, ch.id`,
      [courseId],
    )
    return res.rows
  })

  app.get('/chapters/:id', async (req) => {
    const res = await query('SELECT * FROM chapters WHERE id = $1', [toId(req.params.id)])
    if (res.rowCount === 0) throw notFound('章节')
    return res.rows[0]
  })

  // 新建，pos 未给则排到末尾
  app.post('/chapters', { preHandler: [app.requireLogin] }, async (req, reply) => {
    const b = req.body ?? {}
    checkSlug(b.slug)
    if (!b.title) throw badRequest('title 必填')
    const courseId = toId(b.course_id, 'course_id')

    const res = await query(
      `INSERT INTO chapters (course_id, slug, tag, title, summary, pos, updated_by)
       VALUES ($1, $2, $3, $4, $5,
               coalesce($6::integer,
                        (SELECT coalesce(max(pos), -1) + 1 FROM chapters WHERE course_id = $1)),
               $7)
       RETURNING *`,
      [courseId, b.slug, b.tag ?? '', b.title, b.summary ?? '', b.pos ?? null, req.user?.id ?? null],
    )
    return reply.code(201).send(res.rows[0])
  })

  app.patch('/chapters/:id', { preHandler: [app.requireLogin] }, async (req) => {
    const fields = pick(req.body ?? {}, META)
    if (fields.slug !== undefined) checkSlug(fields.slug)
    if (Object.keys(fields).length === 0) throw badRequest('没有可更新的字段')

    fields.updated_by = req.user?.id ?? null
    const set = setClause(fields)
    const res = await query(
      `UPDATE chapters SET ${set.text}, updated_at = now()
        WHERE id = $${set.params.length + 1} RETURNING *`,
      [...set.params, toId(req.params.id)],
    )
    if (res.rowCount === 0) throw notFound('章节')
    return res.rows[0]
  })

  app.delete('/chapters/:id', { preHandler: [app.requireLogin] }, async (req, reply) => {
    const res = await query('DELETE FROM chapters WHERE id = $1 RETURNING id', [toId(req.params.id)])
    if (res.rowCount === 0) throw notFound('章节')
    return reply.code(204).send()
  })

  // 批量删除章节
  app.post('/chapters/batch-delete', { preHandler: [app.requireLogin] }, async (req) => {
    const ids = toIdArray(req.body?.ids, 'ids')
    if (ids.length === 0) return { ok: true, count: 0, ids: [] }

    const res = await query(
      'DELETE FROM chapters WHERE id = ANY($1::bigint[]) RETURNING id',
      [ids]
    )
    return { ok: true, count: res.rowCount, ids: res.rows.map((r) => r.id) }
  })

  app.put('/chapters/order', { preHandler: [app.requireLogin] }, async (req) => {
    const courseId = toId(req.body?.course_id, 'course_id')
    const ids = (req.body?.ids ?? []).map((v) => toId(v, 'ids 里的元素'))
    await tx((client) => reorder(client, 'chapters', courseId, ids))
    return { ok: true, count: ids.length }
  })
}
