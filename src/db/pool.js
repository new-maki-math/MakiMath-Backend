import pg from 'pg'
import { config } from '../config.js'

// pg 默认把 int8 解析成字符串，这里统一转成 Number
const toNumber = (v) => (v === null ? null : Number(v))
pg.types.setTypeParser(pg.types.builtins.INT8, toNumber)

// int8[]，用于 prereqs 列
pg.types.setTypeParser(1016, (v) =>
  v === null ? null : v.slice(1, -1).split(',').filter((s) => s.length > 0).map(Number),
)

export const pool = new pg.Pool({ ...config.db, max: 10 })

pool.on('error', (err) => {
  console.error('[db] 空闲连接出错：', err.message)
})

// 单条查询，自动取还连接
export function query(text, params) {
  return pool.query(text, params)
}

// 事务。pos 重排依赖 DEFERRABLE 唯一约束，必须在事务内执行
export async function tx(fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// 探活
export async function ping() {
  const res = await pool.query('SELECT current_database() AS db, version() AS ver')
  return { database: res.rows[0].db, version: res.rows[0].ver.split(' ').slice(0, 2).join(' ') }
}
