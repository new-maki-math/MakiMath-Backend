import * as service from '../services/review.js'
import { body, choice, id, string } from '../lib/validate.js'

export default async function reviewRoutes(app) {
  app.get('/reviews/:kind/pending', { preHandler: [app.requireLogin] }, async req =>
    service.pending(req.user, choice(req.params.kind, ['knowledge','lecture'])))
  app.post('/reviews/:kind/:id', { preHandler: [app.requireLogin] }, async (req, reply) => {
    const d = body(req.body, ['decision','comment'], ['decision','comment'])
    choice(d.decision, ['approved','rejected'])
    string(d.comment, 5000, true)
    const result = await service.decide(req.user, choice(req.params.kind, ['knowledge','lecture']), id(req.params.id), d)
    reply.code(201)
    return result
  })
}
