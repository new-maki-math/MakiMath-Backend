import { query } from '../db/pool.js'

// 提取关键词命中语句节选
function extractSentenceExcerpt(source = '', summary = '', keyword = '') {
  const content = source || summary || ''
  if (!content) return ''
  const clean = content.replace(/[\n\r]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!keyword) {
    return clean.slice(0, 60) + (clean.length > 60 ? '...' : '')
  }

  const lowerContent = clean.toLowerCase()
  const lowerKw = keyword.toLowerCase()
  const idx = lowerContent.indexOf(lowerKw)

  if (idx === -1) {
    return clean.slice(0, 60) + (clean.length > 60 ? '...' : '')
  }

  const beforeChars = 14
  const afterChars = 46
  const start = Math.max(0, idx - beforeChars)
  const end = Math.min(clean.length, idx + keyword.length + afterChars)

  const prefix = start > 0 ? '...' : ''
  const suffix = end < clean.length ? '...' : ''

  return prefix + clean.slice(start, end).trim() + suffix
}

export default async function searchRoutes(app) {
  // 搜索推荐接口：随机推荐 6 个小节（跨所有分类、课程、章节，格式与搜索结果一致）
  app.get('/search/recommendations', async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 6), 1), 20)

    const res = await query(
      `SELECT s.id,
              s.slug,
              s.title,
              s.tag,
              s.summary,
              s.source,
              ch.id AS chapter_id,
              ch.title AS chapter_title,
              c.id AS course_id,
              c.slug AS course_slug,
              c.title AS course_title
         FROM sections s
         JOIN chapters ch ON ch.id = s.chapter_id
         JOIN courses c ON c.id = ch.course_id
        WHERE c.status != 'hidden' AND c.status != 'archived'
        ORDER BY random()
        LIMIT $1`,
      [limit],
    )

    const hits = res.rows.map((row) => ({
      id: Number(row.id),
      slug: row.slug,
      title: row.title,
      tag: row.tag || '',
      summary: row.summary || '',
      chapterId: Number(row.chapter_id),
      chapterTitle: row.chapter_title,
      courseId: Number(row.course_id),
      courseSlug: row.course_slug,
      courseTitle: row.course_title,
      excerpt: extractSentenceExcerpt(row.source, row.summary, ''),
      // 前端路由是 /course/:courseId/doc/:sectionId，必须用数字 id 而非 slug
      path: `/course/${encodeURIComponent(row.course_id)}/doc/${encodeURIComponent(row.id)}`,
      score: 0,
    }))

    return {
      q: '',
      count: hits.length,
      hits,
    }
  })

  // 基于小节标题与正文的全文检索服务接口
  app.get('/search', async (req) => {
    const rawQ = String(req.query.q ?? '').trim()
    if (!rawQ) {
      return { q: '', count: 0, hits: [] }
    }

    const limit = Math.min(Math.max(Number(req.query.limit ?? 20), 1), 50)
    const escapedLike = `%${rawQ.replace(/[\\%_]/g, (c) => '\\' + c)}%`

    // 在小节标题和内容正文中执行全文与子串混合检索
    const res = await query(
      `SELECT s.id,
              s.slug,
              s.title,
              s.tag,
              s.summary,
              s.source,
              ch.id AS chapter_id,
              ch.title AS chapter_title,
              c.id AS course_id,
              c.slug AS course_slug,
              c.title AS course_title,
              (
                COALESCE(ts_rank(
                  '{0.1, 0.2, 0.4, 1.0}',
                  setweight(to_tsvector('simple', coalesce(s.title, '')), 'A') ||
                  setweight(to_tsvector('simple', coalesce(left(s.source, 2000), '')), 'B'),
                  plainto_tsquery('simple', $1)
                ), 0) * 15.0
                + (CASE WHEN lower(s.title) = lower($1) THEN 40.0
                        WHEN lower(s.title) LIKE lower($1) || '%' THEN 20.0
                        WHEN s.title ILIKE $2 THEN 10.0
                        ELSE 0.0 END)
                + (CASE WHEN s.source ILIKE $2 THEN 3.0 ELSE 0.0 END)
              ) AS score
         FROM sections s
         JOIN chapters ch ON ch.id = s.chapter_id
         JOIN courses c ON c.id = ch.course_id
        WHERE c.status != 'hidden' AND c.status != 'archived'
          AND (
            (setweight(to_tsvector('simple', coalesce(s.title, '')), 'A') ||
             setweight(to_tsvector('simple', coalesce(left(s.source, 2000), '')), 'B')
            ) @@ plainto_tsquery('simple', $1)
            OR s.title ILIKE $2
            OR s.source ILIKE $2
          )
        ORDER BY score DESC, c.id ASC, ch.pos ASC, s.pos ASC
        LIMIT $3`,
      [rawQ, escapedLike, limit],
    )

    const hits = res.rows.map((row) => {
      return {
        id: Number(row.id),
        slug: row.slug,
        title: row.title,
        tag: row.tag || '',
        summary: row.summary || '',
        chapterId: Number(row.chapter_id),
        chapterTitle: row.chapter_title,
        courseId: Number(row.course_id),
        courseSlug: row.course_slug,
        courseTitle: row.course_title,
        excerpt: extractSentenceExcerpt(row.source, row.summary, rawQ),
        // 前端路由是 /course/:courseId/doc/:sectionId，必须用数字 id 而非 slug
        path: `/course/${encodeURIComponent(row.course_id)}/doc/${encodeURIComponent(row.id)}`,
        score: Number(row.score ?? 0),
      }
    })

    return {
      q: rawQ,
      count: hits.length,
      hits,
    }
  })
}
