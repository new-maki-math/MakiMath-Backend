import { query, tx } from '../db/pool.js'
import { badRequest, notFound } from '../lib/errors.js'
import { reorder } from '../lib/order.js'
import { checkSlug, pick, setClause, toId } from '../lib/util.js'

const META = ['slug', 'name', 'pos']

export default async function categoryRoutes(app) {
  // 全局讲义工作台目录树接口（一次性聚合 分类 -> 课程 -> 章节 -> 小节 的轻量元数据）
  const getTreeHandler = async () => {
    const [catsRes, coursesRes, chaptersRes, sectionsRes] = await Promise.all([
      query(`SELECT c.id, c.slug, c.name, c.pos FROM categories c ORDER BY c.pos, c.id`),
      query(`SELECT k.id, k.category_id, k.slug, k.title, k.status, k.pos FROM courses k ORDER BY k.pos, k.id`),
      query(`SELECT ch.id, ch.course_id, ch.slug, ch.tag, ch.title, ch.pos
               FROM chapters ch ORDER BY ch.pos, ch.id`),
      query(`SELECT s.id, s.chapter_id, s.slug, s.tag, s.title, s.pos,
                    (s.source IS NOT NULL AND s.source <> '') AS has_source,
                    length(s.source) AS source_len
               FROM sections s ORDER BY s.pos, s.id`),
    ])

    const sectionMap = new Map()
    for (const s of sectionsRes.rows) {
      if (!sectionMap.has(s.chapter_id)) sectionMap.set(s.chapter_id, [])
      sectionMap.get(s.chapter_id).push({
        type: 'section',
        id: s.id,
        label: s.title,
        tag: s.tag,
        slug: s.slug,
        hasSource: s.has_source,
        sourceLen: s.source_len,
      })
    }

    const chapterMap = new Map()
    for (const ch of chaptersRes.rows) {
      if (!chapterMap.has(ch.course_id)) chapterMap.set(ch.course_id, [])
      chapterMap.get(ch.course_id).push({
        type: 'chapter',
        id: ch.id,
        label: ch.title,
        tag: ch.tag,
        slug: ch.slug,
        children: sectionMap.get(ch.id) ?? [],
      })
    }

    const courseMap = new Map()
    for (const k of coursesRes.rows) {
      if (!courseMap.has(k.category_id)) courseMap.set(k.category_id, [])
      const chList = chapterMap.get(k.id) ?? []
      courseMap.get(k.category_id).push({
        type: 'course',
        id: k.id,
        label: k.title,
        slug: k.slug,
        status: k.status,
        chapterCount: chList.length,
        sectionCount: chList.reduce((acc, c) => acc + (c.children?.length ?? 0), 0),
        children: chList,
      })
    }

    return catsRes.rows.map((c) => {
      const coList = courseMap.get(c.id) ?? []
      return {
        type: 'category',
        id: c.id,
        label: c.name,
        slug: c.slug,
        courseCount: coList.length,
        children: coList,
      }
    })
  }

  app.get('/workbench/tree', { preHandler: [app.requireLogin] }, getTreeHandler)

  // 列表，带课程数
  app.get('/categories', async () => {
    const res = await query(`
      SELECT c.*,
             (SELECT count(*) FROM courses k WHERE k.category_id = c.id) AS course_count
        FROM categories c
       ORDER BY c.pos, c.id
    `)
    return res.rows
  })

  app.get('/categories/:id', async (req) => {
    const res = await query('SELECT * FROM categories WHERE id = $1', [toId(req.params.id)])
    if (res.rowCount === 0) throw notFound('分类')
    return res.rows[0]
  })

  // 新建，pos 未给则排到末尾（仅超级管理员）
  app.post('/categories', { preHandler: [app.requireAdmin] }, async (req, reply) => {
    const b = req.body ?? {}
    checkSlug(b.slug)
    if (!b.name) throw badRequest('name 必填')

    const res = await query(
      `INSERT INTO categories (slug, name, pos)
       VALUES ($1, $2,
               coalesce($3::integer, (SELECT coalesce(max(pos), -1) + 1 FROM categories)))
       RETURNING *`,
      [b.slug, b.name, b.pos ?? null],
    )
    return reply.code(201).send(res.rows[0])
  })

  // 修改分类（仅超级管理员）
  app.patch('/categories/:id', { preHandler: [app.requireAdmin] }, async (req) => {
    const fields = pick(req.body ?? {}, META)
    if (fields.slug !== undefined) checkSlug(fields.slug)
    if (Object.keys(fields).length === 0) throw badRequest('没有可更新的字段')

    const set = setClause(fields)
    const res = await query(
      `UPDATE categories SET ${set.text}, updated_at = now()
        WHERE id = $${set.params.length + 1} RETURNING *`,
      [...set.params, toId(req.params.id)],
    )
    if (res.rowCount === 0) throw notFound('分类')
    return res.rows[0]
  })

  // 删除。分类下有课程时被外键 RESTRICT 拒绝（仅超级管理员）
  app.delete('/categories/:id', { preHandler: [app.requireAdmin] }, async (req, reply) => {
    const res = await query('DELETE FROM categories WHERE id = $1 RETURNING id', [
      toId(req.params.id),
    ])
    if (res.rowCount === 0) throw notFound('分类')
    return reply.code(204).send()
  })

  // 整组重排，传新的完整顺序（仅超级管理员）
  app.put('/categories/order', { preHandler: [app.requireAdmin] }, async (req) => {
    const ids = (req.body?.ids ?? []).map((v) => toId(v, 'ids 里的元素'))
    await tx((client) => reorder(client, 'categories', null, ids))
    return { ok: true, count: ids.length }
  })
}
