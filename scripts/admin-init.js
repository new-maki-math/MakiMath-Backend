import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import bcrypt from 'bcryptjs'

const dbConfig = {
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? '',
  database: process.env.PGDATABASE ?? 'maki_math_dev',
}

export class AdminInitError extends Error {}

function validateIdentity(username, displayName) {
  if (typeof username !== 'string' || !username.trim() || username !== username.trim() ||
      username.length > 80 || /[\x00-\x1f\x7f]/.test(username)) {
    throw new AdminInitError('用户名不能为空或包含首尾空白和控制字符且不能超过八十个字符')
  }
  if (typeof displayName !== 'string' || displayName.length > 100 || /[\x00-\x1f\x7f]/.test(displayName)) {
    throw new AdminInitError('昵称不能包含控制字符或超过一百个字符')
  }
}

export function validateAdminInput(username, displayName, password, confirmation) {
  validateIdentity(username, displayName)
  if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new AdminInitError('密码至少需要八个字符且不能超过七十二字节')
  }
  if (password !== confirmation) throw new AdminInitError('两次输入的密码不一致')
}

export async function ensureEligible(db, username) {
  const result = await db.query(
    `SELECT EXISTS(SELECT 1 FROM users WHERE username=$1) AS username_exists,
            EXISTS(SELECT 1 FROM users WHERE role='super_admin' AND status='active') AS admin_exists`,
    [username],
  )
  const reasons = []
  if (result.rows[0].username_exists) reasons.push('用户名已存在')
  if (result.rows[0].admin_exists) reasons.push('数据库已有有效管理员')
  if (reasons.length) throw new AdminInitError(reasons.join('，') + '，不会修改现有账号')
}

export async function initializeAdmin(db, username, displayName, password, signal) {
  const passwordHash = await bcrypt.hash(password, 12)
  if (signal?.aborted) throw new AdminInitError('已取消管理员初始化')
  await db.query('BEGIN')
  try {
    await db.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE')
    await ensureEligible(db, username)
    if (signal?.aborted) throw new AdminInitError('已取消管理员初始化')
    const result = await db.query(
      `INSERT INTO users(username,display_name,password_hash,role,status)
       VALUES ($1,$2,$3,'super_admin','active') RETURNING id,username,display_name`,
      [username, displayName, passwordHash],
    )
    if (signal?.aborted) throw new AdminInitError('已取消管理员初始化')
    await db.query('COMMIT')
    return result.rows[0]
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {})
    throw err
  }
}

export function createPrompt(input, output) {
  if (!input.isTTY || !output.isTTY) throw new AdminInitError('请在交互式终端中运行初始化命令')
  let muted = false
  const destination = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) output.write(chunk)
      callback()
    },
  })
  const rl = createInterface({ input, output: destination, terminal: true, historySize: 0 })
  const controller = new AbortController()
  rl.on('SIGINT', () => controller.abort())
  rl.on('close', () => controller.abort())

  return {
    signal: controller.signal,
    async ask(label, hidden = false) {
      output.write(label)
      muted = hidden
      try {
        return await rl.question('', { signal: controller.signal })
      } finally {
        muted = false
        if (hidden) output.write('\n')
      }
    },
    close() {
      rl.close()
    },
  }
}

async function main() {
  const prompt = createPrompt(process.stdin, process.stdout)
  const pool = new pg.Pool({ ...dbConfig, max: 1 })
  let client
  try {
    client = await pool.connect()
    const target = (await client.query(
      'SELECT current_database() AS name, current_user AS db_user, host(inet_server_addr()) AS address, inet_server_port() AS port',
    )).rows[0]
    process.stdout.write(`目标数据库：${target.name}\n数据库用户：${target.db_user}\n数据库地址：${target.address ?? dbConfig.host}\n数据库端口：${target.port ?? dbConfig.port}\n`)
    const confirmation = await prompt.ask('确认连接正确请输入 yes：')
    if (confirmation.trim().toLowerCase() !== 'yes') throw new AdminInitError('已取消管理员初始化')
    const username = await prompt.ask('管理员用户名：')
    const displayName = await prompt.ask('管理员昵称：')
    validateIdentity(username, displayName)
    await ensureEligible(client, username)
    const password = await prompt.ask('管理员密码：', true)
    const passwordConfirmation = await prompt.ask('再次输入密码：', true)
    validateAdminInput(username, displayName, password, passwordConfirmation)
    const admin = await initializeAdmin(client, username, displayName, password, prompt.signal)
    process.stdout.write(`已创建管理员：${admin.username}\n`)
  } finally {
    prompt.close()
    if (client) client.release()
    await pool.end()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    const message = err instanceof AdminInitError ? err.message :
      err.name === 'AbortError' ? '已取消管理员初始化' :
        err.code === '23505' ? '用户名已存在，不会修改现有账号' :
          '初始化失败，请检查数据库连接与权限'
    process.stderr.write(message + '\n')
    process.exitCode = 1
  })
}
