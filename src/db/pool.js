import pg from 'pg'
import { config } from '../config.js'

// 数据库整数必须在安全范围内
const toNumber = (v) => {
  if (v === null) return null
  const n = Number(v)
  if (!Number.isSafeInteger(n)) throw new Error('数据库整数超出安全范围')
  return n
}
pg.types.setTypeParser(pg.types.builtins.INT8, toNumber)

export const pool = new pg.Pool({ ...config.db, max: 10 })

pool.on('error', (err) => {
  console.error('[db] 空闲连接出错：', err.message)
})

// 普通查询使用连接池
export function query(text, params) {
  return pool.query(text, params)
}

// 事务内共用同一数据库连接
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
