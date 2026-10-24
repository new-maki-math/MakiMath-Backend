import { query, tx } from '../db/pool.js'
import { badRequest, notFound } from '../lib/errors.js'
import { reorder } from '../lib/order.js'
import { parseTypst } from '../lib/typst-to-json.js'
import { checkSlug, pick, setClause, toId, toIdArray } from '../lib/util.js'

const META = ['slug', 'category_id', 'title', 'subtitle', 'descr', 'status', 'pos', 'typst_version']
const STATUSES = ['draft', 'live', 'hidden', 'archived']

// 校验课程 id 都存在
async function checkCourseIds(ids) {
  if (ids.length === 0) return []
  const res = await query('SELECT id FROM courses WHERE id = ANY($1::bigint[])', [ids])
  const found = new Set(res.rows.map((r) => r.id))
  const missing = ids.filter((id) => !found.has(id))
  if (missing.length > 0) throw badRequest(`这些课程 id 不存在：${missing.join(', ')}`)
  return ids
}

// 课程连同分类名，前端课程页要显示分类
const COURSE_WITH_CATEGORY = `SELECT c.*, cat.name AS category
   FROM courses c JOIN categories cat ON cat.id = c.category_id`

// 小节前置上卷成章节级边：小节 s 依赖 p，就得到 chapter(p) -> chapter(s)。
// 图谱是章节粒度的，而前置关系记在小节上，这里做一次归并（同章内部不算边）。
function rollupEdges(sections) {
  const chapterOf = new Map(sections.map((s) => [s.id, s.chapter_id]))
  const seen = new Set()
  const edges = []
  for (const s of sections) {
    for (const p of s.prereqs ?? []) {
      const from = chapterOf.get(p)
      if (from == null || from === s.chapter_id) continue
      const key = `${from}->${s.chapter_id}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push([from, s.chapter_id])
    }
  }
  return edges
}

// 课程树构建函数
async function buildCourseTree(course) {
  const meta = course

  const chapters = (
    await query(
      `SELECT id, slug, tag, title, summary, pos
         FROM chapters WHERE course_id = $1 ORDER BY pos, id`,
      [course.id],
    )
  ).rows

  const sections = (
    await query(
      `SELECT s.id, s.chapter_id, s.slug, s.tag, s.title, s.summary, s.pos, s.prereqs,
              s.source_hash, length(s.source) AS source_len,
              (s.source IS NOT NULL AND s.source <> '') AS has_source,
              s.updated_at
         FROM sections s
         JOIN chapters ch ON ch.id = s.chapter_id
        WHERE ch.course_id = $1
        ORDER BY ch.pos, s.pos, s.id`,
      [course.id],
    )
  ).rows

  const nodes = new Map(chapters.map((ch) => [ch.id, { ...ch, sections: [] }]))
  for (const s of sections) nodes.get(s.chapter_id)?.sections.push(s)

  return {
    ...meta,
    chapters: [...nodes.values()],
    edges: rollupEdges(sections),
  }
}


export default async function courseRoutes(app) {
  // 列表，可按分类和状态过滤
  app.get('/courses', async (req) => {
    const { category_id: categoryId, status } = req.query
    const where = []
    const params = []

    if (categoryId !== undefined) {
      params.push(toId(categoryId, 'category_id'))
      where.push(`c.category_id = $${params.length}`)
    }
    if (!req.user) {
      // 普通免登读者只能看到 live 状态
      where.push("c.status = 'live'")
    } else if (status !== undefined) {
      if (!STATUSES.includes(status)) throw badRequest(`status 只能是 ${STATUSES.join(' / ')}`)
      params.push(status)
      where.push(`c.status = $${params.length}`)
    }

    const res = await query(
      `SELECT c.id, c.slug, c.category_id, c.title, c.subtitle, c.descr, c.status, c.pos,
              c.typst_version, c.prereqs, c.created_at, c.updated_at,
              (SELECT count(*) FROM chapters ch WHERE ch.course_id = c.id) AS chapter_count,
              (SELECT count(*) FROM sections s
                 JOIN chapters ch ON ch.id = s.chapter_id
                WHERE ch.course_id = c.id) AS section_count
         FROM courses c
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY c.category_id, c.pos, c.id`,
      params,
    )
    return res.rows
  })

  // 课程详情接口
  app.get('/courses/:id', async (req) => {
    const id = toId(req.params.id)
    const res = await query(
      `SELECT c.*,
              (SELECT count(*) FROM chapters ch WHERE ch.course_id = c.id) AS chapter_count
         FROM courses c WHERE c.id = $1`,
      [id],
    )
    if (res.rowCount === 0) throw notFound('课程')
    const course = res.rows[0]
    if (!req.user && course.status !== 'live') throw notFound('课程')
    return course
  })

  // 目录树接口
  app.get('/courses/:id/tree', async (req) => {
    const res = await query(`${COURSE_WITH_CATEGORY} WHERE c.id = $1`, [toId(req.params.id)])
    if (res.rowCount === 0) throw notFound('课程')
    if (!req.user && res.rows[0].status !== 'live') throw notFound('课程')
    return buildCourseTree(res.rows[0])
  })


  // 新建课程（仅超级管理员）
  app.post('/courses', { preHandler: [app.requireAdmin] }, async (req, reply) => {
    const b = req.body ?? {}
    checkSlug(b.slug)
    if (!b.title) throw badRequest('title 必填')
    if (b.status !== undefined && !STATUSES.includes(b.status)) {
      throw badRequest(`status 只能是 ${STATUSES.join(' / ')}`)
    }
    const categoryId = toId(b.category_id, 'category_id')

    const res = await query(
      `INSERT INTO courses (slug, category_id, title, subtitle, descr, status, pos, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6,
               coalesce($7::integer,
                        (SELECT coalesce(max(pos), -1) + 1 FROM courses WHERE category_id = $2)),
               $8, $8)
       RETURNING *`,
      [b.slug, categoryId, b.title, b.subtitle ?? '', b.descr ?? '', b.status ?? 'draft', b.pos ?? null, req.user?.id ?? null],
    )
    return reply.code(201).send(res.rows[0])
  })

  app.patch('/courses/:id', { preHandler: [app.requireLogin] }, async (req) => {
    const id = toId(req.params.id)
    const fields = pick(req.body ?? {}, META)
    if (fields.slug !== undefined) checkSlug(fields.slug)
    if (fields.status !== undefined && !STATUSES.includes(fields.status)) {
      throw badRequest(`status 只能是 ${STATUSES.join(' / ')}`)
    }
    if (fields.category_id !== undefined) fields.category_id = toId(fields.category_id, 'category_id')
    if (Object.keys(fields).length === 0) throw badRequest('没有可更新的字段')

    fields.updated_by = req.user?.id ?? null

    return tx(async (client) => {
      // 换分类且没显式给 pos 时，pos 要在目标分类里重新排到末尾。
      // 否则会沿用旧分类的 pos，撞上 UNIQUE (category_id, pos)。
      // 读当前分类与算新 pos 必须在同一事务里，避免并发换分类时算重。
      if (fields.category_id !== undefined && fields.pos == null) {
        const cur = await client.query('SELECT category_id FROM courses WHERE id = $1', [id])
        if (cur.rowCount === 0) throw notFound('课程')

        if (cur.rows[0].category_id !== fields.category_id) {
          const next = await client.query(
            'SELECT coalesce(max(pos), -1) + 1 AS pos FROM courses WHERE category_id = $1',
            [fields.category_id],
          )
          fields.pos = next.rows[0].pos
        }
      }

      const set = setClause(fields)
      const res = await client.query(
        `UPDATE courses SET ${set.text}, updated_at = now()
          WHERE id = $${set.params.length + 1}
         RETURNING *`,
        [...set.params, id],
      )
      if (res.rowCount === 0) throw notFound('课程')
      return res.rows[0]
    })
  })

  // 保存前置课程，数组列无外键，这里校验
  app.put('/courses/:id/prereqs', { preHandler: [app.requireLogin] }, async (req) => {
    const id = toId(req.params.id)
    const prereqs = toIdArray(req.body?.prereqs, 'prereqs')

    if (prereqs.includes(id)) throw badRequest('不能把自己设为前置课程')
    await checkCourseIds(prereqs)

    const res = await query(
      'UPDATE courses SET prereqs = $1::bigint[], updated_by = $2, updated_at = now() WHERE id = $3 RETURNING id, prereqs',
      [prereqs, req.user?.id ?? null, id],
    )
    if (res.rowCount === 0) throw notFound('课程')
    return res.rows[0]
  })

  app.delete('/courses/:id', { preHandler: [app.requireAdmin] }, async (req, reply) => {
    const res = await query('DELETE FROM courses WHERE id = $1 RETURNING id', [toId(req.params.id)])
    if (res.rowCount === 0) throw notFound('课程')
    return reply.code(204).send()
  })

  // 批量删除课程
  app.post('/courses/batch-delete', { preHandler: [app.requireAdmin] }, async (req) => {
    const ids = toIdArray(req.body?.ids, 'ids')
    if (ids.length === 0) return { ok: true, count: 0, ids: [] }

    const res = await query(
      'DELETE FROM courses WHERE id = ANY($1::bigint[]) RETURNING id',
      [ids]
    )
    return { ok: true, count: res.rowCount, ids: res.rows.map((r) => r.id) }
  })

  app.put('/courses/order', { preHandler: [app.requireLogin] }, async (req) => {
    const categoryId = toId(req.body?.category_id, 'category_id')
    const ids = (req.body?.ids ?? []).map((v) => toId(v, 'ids 里的元素'))
    await tx((client) => reorder(client, 'courses', categoryId, ids))
    return { ok: true, count: ids.length }
  })
}
