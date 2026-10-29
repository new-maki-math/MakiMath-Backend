import { badRequest } from './errors.js'
import { createHash } from 'node:crypto'

export function parseCover(value) {
  if (typeof value !== 'string') throw badRequest('封面格式不合法')
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
  if (!match || match[2].length > 699052) throw badRequest('封面格式不合法或超过大小限制')
  const data = Buffer.from(match[2], 'base64')
  if (!data.length || data.length > 524288 || data.toString('base64') !== match[2]) throw badRequest('封面格式不合法或超过大小限制')
  const png = data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
  const jpeg = data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255
  const webp = data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP'
  if (!(match[1] === 'image/png' && png || match[1] === 'image/jpeg' && jpeg || match[1] === 'image/webp' && webp)) throw badRequest('封面类型与图片内容不匹配')
  return { mime: match[1], data }
}

export function coverDataUrl(cover) {
  return `data:${cover.mime};base64,${cover.data.toString('base64')}`
}

export function coverHash(data) {
  return createHash('sha256').update(data).digest('hex')
}

export function legacyCoverHash(value) {
  try { return coverHash(parseCover(value).data) } catch { return null }
}
