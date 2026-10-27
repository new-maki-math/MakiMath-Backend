import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { spawnSync } from 'node:child_process'
import bcrypt from 'bcryptjs'
import { createPrompt, ensureEligible, initializeAdmin, validateAdminInput } from '../scripts/admin-init.js'

function makeDatabase(state) {
  const calls = []
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params })
      if (sql.startsWith('SELECT EXISTS')) return { rows: [state] }
      if (sql.startsWith('INSERT INTO users')) return { rows: [{ id: 1, username: params[0], display_name: params[1] }] }
      return { rows: [] }
    },
  }
}

test('创建管理员时锁定用户表并只写入密码哈希', async () => {
  const password = randomBytes(24).toString('base64url')
  const db = makeDatabase({ username_exists: false, admin_exists: false })
  validateAdminInput('admin', '昵称', password, password)
  const result = await initializeAdmin(db, 'admin', '昵称', password)
  assert.equal(result.username, 'admin')
  assert.equal(db.calls[0].sql, 'BEGIN')
  assert.equal(db.calls[1].sql, 'LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE')
  assert.match(db.calls[2].sql, /^SELECT EXISTS/)
  const insert = db.calls[3]
  assert.match(insert.sql, /'super_admin','active'/)
  assert.equal(insert.params[0], 'admin')
  assert.equal(insert.params[1], '昵称')
  assert.equal(await bcrypt.compare(password, insert.params[2]), true)
  assert.match(insert.params[2], /^\$2[aby]\$12\$/)
  assert.equal(JSON.stringify(db.calls).includes(password), false)
  assert.equal(db.calls[4].sql, 'COMMIT')
})

test('用户名重复或已有有效管理员时回滚且不写入', async () => {
  const password = randomBytes(24).toString('base64url')
  for (const state of [
    { username_exists: true, admin_exists: false },
    { username_exists: false, admin_exists: true },
    { username_exists: true, admin_exists: true },
  ]) {
    const db = makeDatabase(state)
    await assert.rejects(
      () => initializeAdmin(db, 'admin', '', password),
      err => (!state.username_exists || err.message.includes('用户名已存在')) &&
        (!state.admin_exists || err.message.includes('已有有效管理员')),
    )
    assert.equal(db.calls.some(call => call.sql.startsWith('INSERT')), false)
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK')
  }
})

test('输入不合法时拒绝创建', () => {
  const password = randomBytes(24).toString('base64url')
  assert.throws(() => validateAdminInput('admin', '', password, password + 'x'), /两次输入的密码不一致/)
  assert.throws(() => validateAdminInput(' admin', '', password, password), /用户名/)
  assert.throws(() => validateAdminInput('admin', '', 'x', 'x'), /密码/)
  assert.throws(() => validateAdminInput('admin', '', '长'.repeat(25), '长'.repeat(25)), /密码/)
  assert.throws(() => createPrompt({}, {}), /交互式终端/)
})

test('独立工具不依赖会话密钥配置并拒绝非交互输入', () => {
  const result = spawnSync(process.execPath, ['scripts/admin-init.js'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: '', PAYLOAD_SECRET_KEY: '' },
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /请在交互式终端中运行/)
})

test('交互密码输入不回显并在结束后恢复终端模式', async () => {
  const input = new PassThrough()
  input.isTTY = true
  input.isRaw = false
  input.setRawMode = value => { input.isRaw = value; return input }
  const output = new PassThrough()
  output.isTTY = true
  output.columns = 100
  let captured = ''
  output.on('data', chunk => { captured += chunk.toString('utf8') })
  const prompt = createPrompt(input, output)
  const secret = randomBytes(24).toString('base64url')
  try {
    const response = prompt.ask('密码：', true)
    input.write(secret + '\r')
    assert.equal(await response, secret)
    assert.equal(captured.includes(secret), false)
    assert.match(captured, /密码：/)
  } finally {
    prompt.close()
    input.destroy()
    output.destroy()
  }
  assert.equal(input.isRaw, false)
})

test('密码输入时可以中断', async () => {
  const input = new PassThrough()
  input.isTTY = true
  input.isRaw = false
  input.setRawMode = value => { input.isRaw = value; return input }
  const output = new PassThrough()
  output.isTTY = true
  output.columns = 100
  output.resume()
  const prompt = createPrompt(input, output)
  try {
    const response = prompt.ask('密码：', true)
    input.write('\x03')
    await assert.rejects(response, { name: 'AbortError' })
  } finally {
    prompt.close()
    input.destroy()
    output.destroy()
  }
  assert.equal(input.isRaw, false)
})

test('事务等待期间取消不会写入管理员', async () => {
  const controller = new AbortController()
  const password = randomBytes(24).toString('base64url')
  const db = makeDatabase({ username_exists: false, admin_exists: false })
  const originalQuery = db.query
  db.query = async (...args) => {
    const result = await originalQuery(...args)
    if (args[0] === 'LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE') controller.abort()
    return result
  }
  await assert.rejects(() => initializeAdmin(db, 'admin', '', password, controller.signal), /已取消/)
  assert.equal(db.calls.some(call => call.sql.startsWith('INSERT')), false)
  assert.equal(db.calls.at(-1).sql, 'ROLLBACK')
})

test('提交前取消会回滚已插入的管理员', async () => {
  const controller = new AbortController()
  const password = randomBytes(24).toString('base64url')
  const db = makeDatabase({ username_exists: false, admin_exists: false })
  const originalQuery = db.query
  db.query = async (...args) => {
    const result = await originalQuery(...args)
    if (args[0].startsWith('INSERT INTO users')) controller.abort()
    return result
  }
  await assert.rejects(() => initializeAdmin(db, 'admin', '', password, controller.signal), /已取消/)
  assert.equal(db.calls.at(-1).sql, 'ROLLBACK')
  assert.equal(db.calls.some(call => call.sql === 'COMMIT'), false)
})
