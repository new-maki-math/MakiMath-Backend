import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { config } from './config.js'
import { ping } from './db/pool.js'
import { errorHandler } from './lib/errors.js'
import authPlugin from './plugins/auth.js'
import payloadCryptoPlugin from './plugins/crypto.js'
import authRoutes from './routes/auth.js'
import knowledgeRoutes from './routes/knowledge.js'
import lectureRoutes from './routes/lectures.js'
import reviewRoutes from './routes/review.js'
import searchRoutes from './routes/search.js'

export async function buildApp(options = {}) {
  const app = Fastify({
    logger: options.logger ?? { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: config.trustProxy,
    bodyLimit: 4 * 1024 * 1024,
  })
  app.setErrorHandler(errorHandler)
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: '接口不存在' }))
  await app.register(cors, { origin: true })
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' })
  await app.register(payloadCryptoPlugin)
  await app.register(authPlugin)
  app.get('/health', async () => ({ ok: true, ...(await ping()), uptime: Math.round(process.uptime()) }))
  await app.register(async api => {
    await api.register(authRoutes)
    await api.register(knowledgeRoutes)
    await api.register(lectureRoutes)
    await api.register(reviewRoutes)
    await api.register(searchRoutes)
  }, { prefix: '/api' })
  return app
}
