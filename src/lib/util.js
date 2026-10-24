import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { badRequest } from './errors.js'

// sections.source_hash 用
export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

// 允许大写，小节 slug 形如 L01
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function checkSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw badRequest('slug 只能用字母、数字、点、下划线、连字符，且以字母或数字开头')
  }
  return slug
}

// 转成正整数，非法则 400
export function toId(value, what = 'id') {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`${what} 必须是正整数`)
  return n
}

// 挑出允许修改的字段
export function pick(body, allowed) {
  const out = {}
  for (const key of allowed) {
    if (body[key] !== undefined) out[key] = body[key]
  }
  return out
}

// 生成 UPDATE 的 SET 子句。obj 的键必须来自调用方硬编码的白名单
export function setClause(obj, startAt = 1) {
  const cols = Object.keys(obj)
  const text = cols.map((c, i) => `${c} = $${startAt + i}`).join(', ')
  return { text, params: cols.map((c) => obj[c]) }
}

// 规整 bigint[] 参数，去重并校验元素
export function toIdArray(value, what = 'prereqs') {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw badRequest(`${what} 必须是数组`)
  const out = []
  for (const v of value) {
    const n = Number(v)
    if (!Number.isInteger(n) || n <= 0) throw badRequest(`${what} 里含非法 id：${v}`)
    if (!out.includes(n)) out.push(n)
  }
  return out
}

// 校验并规整客户端 IP，供 inet 列入库。
// X-Forwarded-For 由客户端可控，脏值直接写 inet 会抛 22P02，
// 因此非法的值一律降级为 null，绝不能让它影响主流程。
export function normalizeIp(value) {
  if (typeof value !== 'string') return null
  let ip = value.trim()
  if (!ip) return null

  // 多级代理可能残留 "1.2.3.4, 5.6.7.8"，取最左侧的原始客户端
  const comma = ip.indexOf(',')
  if (comma !== -1) ip = ip.slice(0, comma).trim()

  // IPv4 映射的 IPv6 统一还原成 IPv4
  if (ip.startsWith('::ffff:')) {
    const v4 = ip.slice(7)
    if (isIP(v4) === 4) return v4
  }
  // 去掉可能的端口后缀，如 1.2.3.4:5678
  const bracketed = /^\[(.+)](?::\d+)?$/.exec(ip)
  if (bracketed) ip = bracketed[1]
  else if (isIP(ip) === 0 && (ip.match(/:/g) || []).length === 1) {
    const [host, port] = ip.split(':')
    if (isIP(host) === 4 && /^\d+$/.test(port)) ip = host
  }

  return isIP(ip) ? ip : null
}
