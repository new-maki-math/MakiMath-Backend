import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import multipart from '@fastify/multipart'
import { config } from './config.js'
import { ping, setPoolLogger } from './db/pool.js'
import { errorHandler } from './lib/errors.js'
import authPlugin from './plugins/auth.js'
import payloadCryptoPlugin from './plugins/crypto.js'
import authRoutes from './routes/auth.js'
import knowledgeRoutes from './routes/knowledge.js'
import bookRoutes from './routes/books.js'
import reviewRoutes from './routes/review.js'
import searchRoutes from './routes/search.js'
import resourceRoutes from './routes/resources.js'
import questionRoutes from './routes/questions.js'

export async function buildApp(options = {}) {
  const logger = { level: process.env.LOG_LEVEL ?? 'info' }
  if (process.argv.includes('--pretty') && process.env.NODE_ENV !== 'production') {
    logger.transport = {
      target: 'pino-pretty',
      options: {
        colorize: process.stdout.isTTY,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    }
  }
  const app = Fastify({
    logger: options.logger ?? logger,
    trustProxy: config.trustProxy,
    bodyLimit: 4 * 1024 * 1024,
  })
  setPoolLogger(app.log)
  app.setErrorHandler(errorHandler)
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: '接口不存在' }))
  await app.register(cors, { origin: true, exposedHeaders: ['Content-Range','Accept-Ranges','Content-Disposition'] })
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' })
  await app.register(multipart, { limits: { fileSize: 33554432, files: 1, fields: 4, parts: 5 } })
  await app.register(payloadCryptoPlugin)
  await app.register(authPlugin)
  app.get('/health', async () => ({ ok: true, ...(await ping()), uptime: Math.round(process.uptime()) }))
  await app.register(async api => {
    await api.register(authRoutes)
    await api.register(knowledgeRoutes)
    await api.register(bookRoutes)
    await api.register(reviewRoutes)
    await api.register(searchRoutes)
    await api.register(resourceRoutes)
    await api.register(questionRoutes)
  }, { prefix: '/api' })
  return app
}
