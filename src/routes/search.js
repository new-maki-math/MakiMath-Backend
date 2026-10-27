import { search } from '../services/search.js'
import { badRequest } from '../lib/errors.js'
import { string } from '../lib/validate.js'

export default async function searchRoutes(app) {
  app.get('/search', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    const term = string(req.query.q, 100).trim()
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw badRequest('搜索数量不合法')
    return { hits: await search(term, limit) }
  })
}
