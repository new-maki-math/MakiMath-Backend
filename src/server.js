import { config } from './config.js'
import { ping, pool } from './db/pool.js'
import { buildApp } from './app.js'

const app = await buildApp()

try {
  const info = await ping()
  const schema = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='book_revisions' AND column_name='edit_version'
     ) AND EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='books' AND column_name='kind'
     ) AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='book_revisions' AND column_name='typst_version'
     ) AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='book_revisions' AND column_name='kind'
     ) AND EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='knowledge_points' AND column_name='source'
     ) AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='knowledge_points' AND column_name='status'
     ) AND to_regclass(format('%I.question_categories', current_schema())) IS NOT NULL
       AND to_regclass(format('%I.questions', current_schema())) IS NOT NULL
       AND to_regclass(format('%I.question_entries', current_schema())) IS NOT NULL
       AND to_regclass(format('%I.question_knowledge_points', current_schema())) IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema=current_schema() AND table_name='questions' AND column_name='focus_source'
       )
       AS ready`,
  )
  if (!schema.rows[0].ready) throw new Error('数据库尚未应用新的初始化结构')
  app.log.info(`数据库已连接 ${info.database}`)
  await app.listen({ host: config.host, port: config.port })
} catch (err) {
  app.log.error(err, '服务启动失败')
  await app.close()
  await pool.end()
  process.exit(1)
}

let closing = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (closing) return
    closing = true
    await app.close()
    await pool.end()
    process.exit(0)
  })
}
