import { isIP } from 'node:net'

export function normalizeIp(value) {
  if (typeof value !== 'string') return null
  let ip = value.trim()
  if (!ip) return null
  const comma = ip.indexOf(',')
  if (comma !== -1) ip = ip.slice(0, comma).trim()
  if (ip.startsWith('::ffff:')) {
    const v4 = ip.slice(7)
    if (isIP(v4) === 4) return v4
  }
  const bracketed = /^\[(.+)](?::\d+)?$/.exec(ip)
  if (bracketed) ip = bracketed[1]
  else if (isIP(ip) === 0 && (ip.match(/:/g) || []).length === 1) {
    const [host, port] = ip.split(':')
    if (isIP(host) === 4 && /^\d+$/.test(port)) ip = host
  }
  return isIP(ip) ? ip : null
}
