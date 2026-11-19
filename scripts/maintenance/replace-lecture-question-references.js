// 将指定讲义工作草稿中按真题来源写死的题目替换为题库引用。
// node --env-file=.env scripts/maintenance/replace-lecture-question-references.js [--apply]
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'

const args = process.argv.slice(2)
if (args.some(arg => arg !== '--apply') || args.length > 1) throw new Error('只支持 --apply；不带参数时仅预览')
const apply = args.includes('--apply')
const bookSlug = 'makikysx-ref'

// 内容块中数学模式允许出现不成对的区间括号，不能按普通文本配对。
function blockEnd(text, start) {
  let depth = 0
  let math = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (c === '\\') { i++; continue }
    if (c === '$') { math = !math; continue }
    if (math) continue
    if (text.startsWith('//', i)) { const n = text.indexOf('\n', i); i = n < 0 ? text.length : n; continue }
    if (text.startsWith('/*', i)) { const n = text.indexOf('*/', i + 2); if (n < 0) throw new Error('未闭合的注释'); i = n + 1; continue }
    if (c === '[') depth++
    if (c === ']' && --depth === 0) return i + 1
  }
  throw new Error('题目内容块未闭合')
}

// 参数只读取本草稿的静态格式；遇到意外格式中止，避免错误替换。
function transform(source, lookup) {
  const pattern = /#mm-question\s*\(/g
  const changes = []
  let match
  while ((match = pattern.exec(source))) {
    const head = source.slice(match.index).match(/^#mm-question\s*\(source:\s*"(\d{4})\s*数([一二三])\s*第\s*(\d+)\s*题",\s*title:\s*\[([\s\S]*?)\],\s*id:\s*"([^"]+)",\s*difficulty:\s*([1-5])\)\s*\[/)
    if (!head) {
      // 已经是引用的不参与转换，其余格式必须人工检查。
      if (/^#mm-question\s*\(\s*slug\s*:/.test(source.slice(match.index))) continue
      throw new Error(`无法识别题目格式，偏移 ${match.index}: ${source.slice(match.index, match.index + 120)}`)
    }
    const [, year, volume, number, title, id, difficulty] = head
    const key = `${year}-${{ 一: 1, 二: 2, 三: 3 }[volume]}-${Number(number)}`
    if (id !== key) throw new Error(`来源和题目 ID 不一致: ${key} / ${id}`)
    const hits = lookup.get(key) || []
    if (hits.length !== 1) throw new Error(`题库来源 ${key} 匹配到 ${hits.length} 条记录`)
    const open = match.index + head[0].length - 1
    const end = blockEnd(source, open)
    const replacement = `#strong[${title}]\n\n#mm-question(slug: "${hits[0]}", number: "第${Number(number)}题", difficulty: ${difficulty})`
    changes.push({ start: match.index, end, key, slug: hits[0], replacement })
    pattern.lastIndex = end
  }
  let result = source
  for (const change of [...changes].reverse()) result = result.slice(0, change.start) + change.replacement + result.slice(change.end)
  return { result, changes }
}

const client = new pg.Client()
await client.connect()
try {
  await client.query('BEGIN')
  const revisions = await client.query(`SELECT r.id, r.edit_version, r.title FROM books b JOIN book_revisions r ON r.book_id=b.id
    WHERE b.slug=$1 AND r.status='draft' AND r.source_draft_id IS NULL FOR UPDATE OF r`, [bookSlug])
  if (revisions.rowCount !== 1) throw new Error(`找到 ${revisions.rowCount} 个工作草稿，预期恰好一个`)
  const revision = revisions.rows[0]
  const entries = await client.query(`SELECT year.name AS year, volume.name AS volume, e.source_number, q.slug
    FROM question_entries e JOIN questions q ON q.id=e.question_id
    JOIN question_categories volume ON volume.id=e.category_id
    JOIN question_categories year ON year.id=volume.parent_id
    JOIN question_categories root ON root.id=year.parent_id
    WHERE root.name='考研数学题库'`)
  const lookup = new Map()
  for (const entry of entries.rows) {
    const year = /^(\d{4})年$/.exec(entry.year)
    const number = /^第\s*(\d+)\s*题$/.exec(entry.source_number)
    const volume = { 数一: 1, 数二: 2, 数三: 3 }[entry.volume]
    if (!year || !number || !volume) continue
    const key = `${year[1]}-${volume}-${Number(number[1])}`
    lookup.set(key, [...(lookup.get(key) || []), entry.slug])
  }
  const sections = (await client.query(`SELECT s.id, c.title AS chapter, s.title, s.source FROM book_sections s
    JOIN book_chapters c ON c.id=s.chapter_id WHERE s.book_revision_id=$1 ORDER BY c.pos,s.pos FOR UPDATE OF s`, [revision.id])).rows
  const updates = []
  for (const section of sections) {
    try {
      const transformed = transform(section.source, lookup)
      if (transformed.changes.length) updates.push({ ...section, ...transformed })
    } catch (err) { throw new Error(`${section.chapter} / ${section.title}: ${err.message}`) }
  }
  const count = updates.reduce((total, row) => total + row.changes.length, 0)
  console.log(`${apply ? '执行' : '预览'}：${revision.title}，草稿 ${revision.id}，编辑版本 ${revision.edit_version}；${updates.length} 个小节，${count} 处题目`)
  for (const row of updates) console.log(`${row.chapter} / ${row.title}: ${row.changes.map(c => `${c.key}→${c.slug}`).join(', ')}`)
  if (apply && count) {
    const dir = path.resolve('cache/question-reference-backups')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = path.join(dir, `revision-${revision.id}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    fs.writeFileSync(file, JSON.stringify({ bookSlug, revision, sections: updates.map(({ id, chapter, title, source, changes }) => ({ id, chapter, title, source, changes })) }, null, 2), { flag: 'wx', mode: 0o600 })
    for (const row of updates) await client.query('UPDATE book_sections SET source=$1 WHERE id=$2 AND book_revision_id=$3', [row.result, row.id, revision.id])
    const updated = await client.query('UPDATE book_revisions SET edit_version=edit_version+1 WHERE id=$1 RETURNING edit_version', [revision.id])
    await client.query('COMMIT')
    console.log(`已提交，编辑版本 ${updated.rows[0].edit_version}；原文备份：${file}`)
  } else {
    await client.query('ROLLBACK')
  }
} catch (err) {
  await client.query('ROLLBACK').catch(() => {})
  throw err
} finally {
  await client.end()
}
