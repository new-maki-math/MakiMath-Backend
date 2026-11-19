// 将解答中明确标注的答案复制到解答开头，原文保持不变。
// node --env-file=.env scripts/maintenance/prefix-question-answers.js [--apply]
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'

const args = process.argv.slice(2)
if (args.some(arg => arg !== '--apply') || args.length > 1) throw new Error('只支持 --apply；不带参数时仅预览')
const apply = args.includes('--apply')

function findAnswer(source) {
  const lines = [...source.matchAll(/^[ \t]*#text\(weight:\s*"bold"\)\[答案：\][^\n]*/gm)]
  const blocks = [...source.matchAll(/#strong\[答案[．。.:：]\]/g)]
  if (lines.length && blocks.length) return null
  if (lines.length > 2 || blocks.length > 2 || lines.length + blocks.length === 0) return null
  if (lines.length) {
    const answer = lines.at(-1)[0].trim()
    return lines.length === 1 || source.trimStart().startsWith(answer) ? answer : null
  }
  const start = blocks.at(-1).index
  const rest = source.slice(start)
  // 独立答案段在下一段标题前结束；允许答案跨多个段落。
  const next = /\n\s*\n\s*#strong\[/.exec(rest)
  const answer = (next ? rest.slice(0, next.index) : rest).trim()
  return blocks.length === 1 || source.trimStart().startsWith(answer) ? answer : null
}

const db = new pg.Client()
await db.connect()
try {
  await db.query('BEGIN')
  const rows = (await db.query('SELECT id, slug, solution_source FROM questions ORDER BY id FOR UPDATE')).rows
  const changes = []
  const unresolved = []
  let already = 0
  for (const row of rows) {
    const answer = findAnswer(row.solution_source)
    if (!answer) { unresolved.push(row.slug); continue }
    if (row.solution_source.trimStart().startsWith(answer)) { already++; continue }
    changes.push({ ...row, answer, updated: `${answer}\n\n${row.solution_source}` })
  }
  console.log(`${apply ? '执行' : '预览'}：题目 ${rows.length} 道，待更新 ${changes.length} 道，开头已有答案 ${already} 道，未识别明确答案 ${unresolved.length} 道`)
  for (const row of changes) console.log(`${row.slug}: ${row.answer.replace(/\s+/g, ' ').slice(0, 200)}`)
  if (apply && changes.length) {
    const dir = path.resolve('cache/question-answer-backups')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = path.join(dir, `solutions-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    fs.writeFileSync(file, JSON.stringify({ createdAt: new Date().toISOString(), questions: changes.map(({ id, slug, solution_source, answer }) => ({ id, slug, solution_source, answer })), unresolved }, null, 2), { flag: 'wx', mode: 0o600 })
    for (const row of changes) await db.query('UPDATE questions SET solution_source=$1 WHERE id=$2', [row.updated, row.id])
    await db.query('COMMIT')
    console.log(`已提交，原文备份：${file}`)
  } else await db.query('ROLLBACK')
} catch (error) {
  await db.query('ROLLBACK').catch(() => {})
  throw error
} finally {
  await db.end()
}
