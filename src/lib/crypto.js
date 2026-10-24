import crypto from 'node:crypto'
import { config } from '../config.js'

export const KEY_BUFFER = Buffer.from(config.crypto.secretKey, 'utf8')
if (KEY_BUFFER.length !== 32) {
  throw new Error(`[crypto] PAYLOAD_SECRET_KEY 必须严格为 32 字节 (当前: ${KEY_BUFFER.length} 字节)`)
}

// ==========================================
// P-256 ECDH 非对称密钥协商配置
// ==========================================
const DEFAULT_SERVER_PRIV_PKCS8 =
  'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgY4iTK+pV9KWsmD3JY6NHq4XmGH1jGdjnuoLi7R8JCEKhRANCAAToaroHfEZQt5qcWLvKLEKRjj5/923ZddI8n+gNQqXCZN7efpSFnKygmFZw0ImiKo5qAtyyFyEs4vHeZeIlwIHN'

export const SERVER_PUB_B64 =
  'BOhqugd8RlC3mpxYu8osQpGOPn/3bdl10jyf6A1CpcJk3t5+lIWcrKCYVnDQiaIqjmoC3LIXISzi8d5l4iXAgc0='

let serverPrivKeyObj = null

async function getServerPrivKey() {
  if (serverPrivKeyObj) return serverPrivKeyObj
  const privPkcs8B64 = process.env.ECDH_SERVER_PRIVATE_KEY ?? DEFAULT_SERVER_PRIV_PKCS8
  const privBuf = Buffer.from(privPkcs8B64, 'base64')
  serverPrivKeyObj = await globalThis.crypto.subtle.importKey(
    'pkcs8',
    privBuf,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits']
  )
  return serverPrivKeyObj
}

// 内存协商会话密钥缓存 (ClientPubBase64 -> DerivedKeyBuffer)
const keyCache = new Map()

/**
 * 根据客户端临时公钥，利用服务端私钥执行 ECDH 协商出 256 位动态会话密钥
 */
export async function deriveServerSessionKey(clientPubB64) {
  if (!clientPubB64 || typeof clientPubB64 !== 'string') {
    throw new Error('invalid client pubkey')
  }

  if (keyCache.has(clientPubB64)) {
    return keyCache.get(clientPubB64)
  }

  const clientPubBuf = Buffer.from(clientPubB64, 'base64')
  if (clientPubBuf.length !== 65) {
    throw new Error('invalid client pubkey length')
  }

  const clientPubKeyObj = await globalThis.crypto.subtle.importKey(
    'raw',
    clientPubBuf,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  )

  const serverPriv = await getServerPrivKey()
  const sharedBits = await globalThis.crypto.subtle.deriveBits(
    { name: 'ECDH', public: clientPubKeyObj },
    serverPriv,
    256
  )

  const derivedKey = Buffer.from(sharedBits)

  // LRU 简易防溢出
  if (keyCache.size > 5000) {
    const firstKey = keyCache.keys().next().value
    keyCache.delete(firstKey)
  }
  keyCache.set(clientPubB64, derivedKey)

  return derivedKey
}

/**
 * 混淆加密：将 12 字节 IV + 16 字节 Tag + 密文紧凑拼合为单个二进制流
 * 报文结构伪装为普通单字段：{ d: '...' }，不暴露任何密码学术语
 */
export function encryptPayload(data, key = KEY_BUFFER) {
  const jsonStr = typeof data === 'string' ? data : JSON.stringify(data)
  const iv = crypto.randomBytes(12) // 12 字节
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)

  const cipherText = Buffer.concat([cipher.update(jsonStr, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag() // 16 字节

  // 紧凑打包：[12B IV][16B Tag][NB CipherText]
  const combined = Buffer.concat([iv, tag, cipherText])
  return { d: combined.toString('base64') }
}

/**
 * 紧凑报文解密
 */
export function decryptPayload(envelope, key = KEY_BUFFER) {
  const rawBase64 = typeof envelope === 'string' ? envelope : envelope?.d
  if (!rawBase64 || typeof rawBase64 !== 'string') {
    throw new Error('invalid')
  }

  const buf = Buffer.from(rawBase64, 'base64')
  if (buf.length < 28) {
    // 至少需要 12B IV + 16B Tag
    throw new Error('invalid')
  }

  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const cipherText = buf.subarray(28)

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)

  const decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf8')

  try {
    return JSON.parse(decrypted)
  } catch {
    return decrypted
  }
}
