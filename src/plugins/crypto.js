import fp from 'fastify-plugin'
import {
  encryptPayload,
  decryptPayload,
  deriveServerSessionKey,
  KEY_BUFFER,
} from '../lib/crypto.js'
import { badRequest } from '../lib/errors.js'

async function payloadCryptoPlugin(app) {
  if (!app.hasRequestDecorator('sessionKey')) {
    app.decorateRequest('sessionKey', null)
  }

  // 1. 请求入口解密：所有向 /api 发送的数据变更请求，强制要求密文
  app.addHook('preValidation', async (req) => {
    // 忽略公钥端点
    if (!req.url.startsWith('/api') || req.url === '/api/auth/pubkey') return

    // 1.1 检查是否携带客户端 ECDH 临时公钥
    const clientPubB64 = req.headers['x-cp']
    if (clientPubB64) {
      try {
        req.sessionKey = await deriveServerSessionKey(clientPubB64)
      } catch {
        throw badRequest('无效请求')
      }
    } else {
      // 允许使用默认配置密钥（兼容本地脚本与基础测试）
      req.sessionKey = KEY_BUFFER
    }

    // 1.2 拦截写操作，执行密文解密
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      if (req.body != null) {
        const isEncryptedBody =
          typeof req.body === 'object' && typeof req.body.d === 'string' && req.body.d.length >= 40

        if (!isEncryptedBody) {
          throw badRequest('无效请求')
        }

        try {
          // 使用当前会话协商出的动态密钥解密
          req.body = decryptPayload(req.body, req.sessionKey)
        } catch {
          throw badRequest('无效请求')
        }
      }
    }
  })

  // 2. 响应出口加密：/api 下的所有 2xx 响应无条件输出紧凑二进制密文流
  app.addHook('onSend', async (req, reply, payload) => {
    // 忽略公钥端点
    if (!req.url.startsWith('/api') || req.url === '/api/auth/pubkey') return payload

    if (reply.statusCode >= 200 && reply.statusCode < 300) {
      if (typeof payload === 'string' && payload.length > 0) {
        try {
          const parsed = JSON.parse(payload)
          // 避免重复加密
          if (parsed && typeof parsed === 'object' && typeof parsed.d === 'string') {
            return payload
          }
          const keyToUse = req.sessionKey || KEY_BUFFER
          const encrypted = encryptPayload(parsed, keyToUse)
          reply.header('content-type', 'application/json; charset=utf-8')
          return JSON.stringify(encrypted)
        } catch {
          return payload
        }
      }
    }
    return payload
  })
}

export default fp(payloadCryptoPlugin, { name: 'payload-crypto-plugin' })
