import process from 'node:process'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'

import { config } from './config.js'
import { ping, pool } from './db/pool.js'
import { errorHandler } from './lib/errors.js'
import authPlugin from './plugins/auth.js'
import payloadCryptoPlugin from './plugins/crypto.js'
import authRoutes from './routes/auth.js'
import userRoutes from './routes/users.js'
import invitationRoutes from './routes/invitations.js'
import categoryRoutes from './routes/categories.js'
import courseRoutes from './routes/courses.js'
import chapterRoutes from './routes/chapters.js'
import sectionRoutes from './routes/sections.js'
import searchRoutes from './routes/search.js'

// trustProxy 必须开启，否则经 nginx 反代后 req.ip 永远是 127.0.0.1，
// 审计日志与 user_sessions 记录下来的 IP 全是代理地址。
const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  trustProxy: config.trustProxy,
})

app.setErrorHandler(errorHandler)
app.setNotFoundHandler((req, reply) => {
  reply.code(404).send({ error: `没有这个接口：${req.method} ${req.url}` })
})

await app.register(cors, { origin: true })
await app.register(multipart, { limits: { fileSize: 32 * 1024 * 1024 } })
await app.register(rateLimit, {
  max: 300,
  timeWindow: '1 minute',
})
await app.register(payloadCryptoPlugin)
await app.register(authPlugin)

app.get('/health', async () => {
  const info = await ping()
  return { ok: true, ...info, uptime: Math.round(process.uptime()) }
})

await app.register(
  async (api) => {
    await api.register(authRoutes)
    await api.register(userRoutes)
    await api.register(invitationRoutes)
    await api.register(categoryRoutes)
    await api.register(courseRoutes)
    await api.register(chapterRoutes)
    await api.register(sectionRoutes)
    await api.register(searchRoutes)
  },
  { prefix: '/api' },
)

// 启动前探活，连不上直接退出
try {
  const info = await ping()
  app.log.info(`数据库已连接：${info.database}（${info.version}）`)
} catch (err) {
  app.log.error(`连不上数据库：${err.message}`)
  await pool.end().catch(() => {})
  process.exit(1)
}

await app.listen({ host: config.host, port: config.port })

let closing = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (closing) return
    closing = true
    app.log.info(`收到 ${signal}，正在关闭`)
    await app.close()
    await pool.end().catch(() => {})
    process.exit(0)
  })
}
