import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const script = `
  import { buildApp } from './src/app.js'
  import { pool } from './src/db/pool.js'
  if (process.env.TEST_PRETTY === '1') process.argv.push('--pretty')
  const app = await buildApp()
  app.log.info('数据库已连接')
  app.log.error(new Error('中文异常'), '请求处理失败')
  pool.emit('error', new Error('连接中文异常'))
  await app.close()
`

function runLogger(nodeEnv, pretty) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      NODE_ENV: nodeEnv,
      TEST_PRETTY: pretty ? '1' : '0',
      JWT_SECRET: 'temporary-testing-secret-at-least-32-bytes',
      PAYLOAD_SECRET_KEY: '12345678901234567890123456789012',
    },
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

test('开发日志显示中文与完整异常堆栈', () => {
  const output = runLogger('development', true)
  assert.match(output, /\[\d{2}:\d{2}:\d{2}\.\d{3}\] INFO: 数据库已连接/)
  assert.match(output, /ERROR: 请求处理失败/)
  assert.match(output, /Error: 中文异常\s+at /)
  assert.match(output, /数据库空闲连接出错/)
  assert.match(output, /Error: 连接中文异常\s+at /)
})

test('生产日志始终为结构化数据并保留异常堆栈', () => {
  const entries = runLogger('production', true).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(entries[0].msg, '数据库已连接')
  assert.equal(entries[1].msg, '请求处理失败')
  assert.match(entries[1].err.stack, /Error: 中文异常\s+at /)
  assert.equal(entries[2].msg, '数据库空闲连接出错')
  assert.match(entries[2].err.stack, /Error: 连接中文异常\s+at /)
})

test('普通启动保持结构化数据', () => {
  const entries = runLogger('development', false).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(entries[0].msg, '数据库已连接')
})
