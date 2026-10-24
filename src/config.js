import process from 'node:process'
import { fileURLToPath } from 'node:url'

// 项目根目录，带结尾分隔符
const root = fileURLToPath(new URL('..', import.meta.url))

// 反向代理信任级别：决定 req.ip 取 X-Forwarded-For 的哪一跳。
//   'loopback' （默认）只信任本机回环地址发来的代理请求（nginx 与后端同机部署）。
//              取 XFF 最右侧由 nginx 追加的那一项，即真实客户端 IP，客户端无法伪造。
//   'true'     信任全部跳数，取 XFF 最左侧；客户端可自带 XFF 伪造 IP，不要在生产使用。
//   'false'    不信任任何代理，req.ip 恒为直连地址（本地直连、没有 nginx 时用）。
//   其他       可传 IP / CIDR 列表，如 "10.0.0.0/8"（后端与代理不在同一台机器时）。
// 注意：不要用数字（1/2/3）表示跳数——在本项目实测中数字形式不会读取 XFF。
function parseTrustProxy(raw) {
  if (raw === undefined || raw === '') return 'loopback'
  const val = String(raw).trim().toLowerCase()
  if (val === 'false' || val === '0' || val === 'no' || val === 'off') return false
  if (val === 'true') return true
  return val
}

export const config = {
  root,
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

  typstBin: process.env.TYPST_BIN ?? 'typst',
  cacheDir: process.env.CACHE_DIR ?? root + 'cache',
  uploadDir: process.env.UPLOAD_DIR ?? root + 'uploads',

  jwt: {
    secret: process.env.JWT_SECRET ?? 'maki-math-secret-dev-key-2026',
    expiresIn: process.env.JWT_EXPIRES_IN ?? '2h',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '7d',
  },

  // Payload 加密配置 (AES-256-GCM 32字节密钥)
  crypto: {
    secretKey: process.env.PAYLOAD_SECRET_KEY ?? (
      process.env.NODE_ENV === 'production'
        ? (() => { throw new Error('生产环境必须在环境变量中显式配置 PAYLOAD_SECRET_KEY！') })()
        : 'makimath-2026-secret-aes-key-32b'
    ),
    headerFlag: 'x-payload-encrypted',
  },
}
