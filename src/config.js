import process from 'node:process'
// 解析可信反向代理范围
function parseTrustProxy(raw) {
  if (raw === undefined || raw === '') return 'loopback'
  const val = String(raw).trim().toLowerCase()
  if (val === 'false' || val === '0' || val === 'no' || val === 'off') return false
  if (val === 'true') return true
  return val
}

function refreshSeconds(raw) {
  const match = /^([1-9][0-9]*)(s|m|h|d)$/.exec(raw)
  if (!match) throw new Error('刷新会话有效期格式错误')
  const seconds = Number(match[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[match[2]]
  if (!Number.isSafeInteger(seconds) || seconds > 365 * 86400) throw new Error('刷新会话有效期超出范围')
  return seconds
}

function jwtSecret() {
  const secret = process.env.JWT_SECRET
  if (process.env.NODE_ENV === 'production' && (!secret || Buffer.byteLength(secret, 'utf8') < 32)) {
    throw new Error('生产环境必须设置足够长度的会话密钥')
  }
  return secret ?? 'maki-math-secret-dev-key-2026'
}

export const config = {
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 3000),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),

  db: {
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD ?? '',
    database: process.env.PGDATABASE ?? 'maki_math_dev',
  },

  jwt: {
    secret: jwtSecret(),
    expiresIn: process.env.JWT_EXPIRES_IN ?? '2h',
    refreshTtlSeconds: refreshSeconds(process.env.JWT_REFRESH_EXPIRES_IN ?? '7d'),
  },

  // 配置通信加密密钥
  crypto: {
    secretKey: process.env.PAYLOAD_SECRET_KEY ?? (
      process.env.NODE_ENV === 'production'
        ? (() => { throw new Error('生产环境必须在环境变量中显式配置 PAYLOAD_SECRET_KEY！') })()
        : 'makimath-2026-secret-aes-key-32b'
    ),
  },
}
