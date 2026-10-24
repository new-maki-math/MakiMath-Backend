// Typst 纯语法 AST 解析器 (SCHEMA_VERSION = 1)
export const SCHEMA_VERSION = 1

const PAIR = { '[': ']', '(': ')', '{': '}' }

// 跳过双引号字符串
function skipString(s, i) {
  let j = i + 1
  while (j < s.length) {
    if (s[j] === '\\') { j += 2; continue }
    if (s[j] === '"') return j + 1
    j++
  }
  return j
}

// 跳过反引号代码
function skipRaw(s, i) {
  let count = 0
  while (i + count < s.length && s[i + count] === '`') count++
  let j = i + count
  while (j < s.length) {
    if (s[j] === '`') {
      let close = 0
      while (j + close < s.length && s[j + close] === '`') close++
      if (close === count) return j + close
      j += close
      continue
    }
    j++
  }
  return j
}

// 寻找数学公式闭合符 $，跳过内嵌字符串、代码与宏调用
function mathClose(s, i) {
  let j = i + 1
  while (j < s.length) {
    const c = s[j]
    if (c === '\\') { j += 2; continue }
    if (c === '"') { j = skipString(s, j); continue }
    if (c === '`') { j = skipRaw(s, j); continue }
    if (c === '#') {
      const call = parseCall(s, j)
      if (call) { j = call.next; continue }
    }
    if (c === '$') return j
    j++
  }
  return -1
}

const skipMath = (s, i) => {
  const close = mathClose(s, i)
  return close === -1 ? s.length : close + 1
}

// 读取完整数学公式内容
function readMath(s, i) {
  const close = mathClose(s, i)
  return close === -1
    ? { inner: s.slice(i + 1), next: s.length }
    : { inner: s.slice(i + 1, close), next: close + 1 }
}

// 生成数学公式 AST 节点
function makeMath(inner) {
  if (inner.trim() === '') return null
  return {
    type: 'math',
    display: /^\s/.test(inner) && /\s$/.test(inner),
    typst: inner.trim(),
  }
}

// 跳过单行 // 或嵌套块级 /* */ 注释
function skipComment(s, i) {
  if (s[i] === '/' && s[i + 1] === '/') {
    const j = s.indexOf('\n', i)
    return j === -1 ? s.length : j
  }
  if (s[i] === '/' && s[i + 1] === '*') {
    let depth = 1
    let j = i + 2
    while (j < s.length && depth > 0) {
      if (s[j] === '/' && s[j + 1] === '*') { depth++; j += 2; continue }
      if (s[j] === '*' && s[j + 1] === '/') { depth--; j += 2; continue }
      j++
    }
    return j
  }
  return i + 1
}

// 扫描匹配的闭合定界符，自动跳过字符串、代码与公式
function balancedEnd(s, i) {
  const stack = [PAIR[s[i]]]
  let j = i + 1
  while (j < s.length && stack.length > 0) {
    const c = s[j]
    if (c === '\\') { j += 2; continue }
    if (c === '"') { j = skipString(s, j); continue }
    if (c === '`') { j = skipRaw(s, j); continue }
    if (c === '$') { j = skipMath(s, j); continue }
    if (PAIR[c]) { stack.push(PAIR[c]); j++; continue }
    if (c === stack[stack.length - 1]) { stack.pop(); j++; continue }
    j++
  }
  return stack.length === 0 ? j : -1
}

const skipBalanced = (s, i) => {
  const end = balancedEnd(s, i)
  return end === -1 ? s.length : end
}

// 外层按指定分隔符切分字符串
function splitTopLevel(s, sep = ',') {
  const out = []
  let depth = 0
  let start = 0
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '\\') { i += 2; continue }
    if (c === '"') { i = skipString(s, i); continue }
    if (c === '`') { i = skipRaw(s, i); continue }
    if (c === '$') { i = skipMath(s, i); continue }
    if (PAIR[c]) { depth++; i++; continue }
    if (c === ']' || c === ')' || c === '}') { depth--; i++; continue }
    if (depth === 0 && c === sep) {
      out.push(s.slice(start, i))
      start = i + 1
      i++
      continue
    }
    i++
  }
  out.push(s.slice(start))
  return out
}

// 剔除文档注释并保留换行符
function stripComments(s) {
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '\\') { out += s.slice(i, i + 2); i += 2; continue }
    if (c === '"') { const j = skipString(s, i); out += s.slice(i, j); i = j; continue }
    if (c === '`') { const j = skipRaw(s, i); out += s.slice(i, j); i = j; continue }
    if (c === '$') { const j = skipMath(s, i); out += s.slice(i, j); i = j; continue }
    if (c === '/' && (s[i + 1] === '/' || s[i + 1] === '*')) {
      i = skipComment(s, i)
      continue
    }
    out += c
    i++
  }
  return out
}

const lineEndOf = (s, i) => {
  const j = s.indexOf('\n', i)
  return j === -1 ? s.length : j
}

// 解除字符串外层引号与转义
const unquote = (raw) => {
  const t = String(raw ?? '').trim()
  return (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"')
    ? t.slice(1, -1).replace(/\\(.)/g, '$1')
    : t
}

// 解除内容块外层方括号
const unwrapBracket = (raw) => {
  const t = String(raw ?? '').trim()
  return (t[0] === '[' && balancedEnd(t, 0) === t.length) ? t.slice(1, -1) : t
}

// 解析 #name(args)[body1][body2]... 调用语法
function parseCall(s, i) {
  const m = /^#([A-Za-z][A-Za-z0-9_.-]*)/.exec(s.slice(i, i + 64))
  if (!m) return null
  const name = m[1]
  let j = i + m[0].length

  // 解析可选括号参数表 (args)
  let argsRaw = null
  if (s[j] === '(') {
    const end = balancedEnd(s, j)
    if (end !== -1) {
      argsRaw = s.slice(j + 1, end - 1)
      j = end
    }
  }

  let k = j
  while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++

  // 解析紧邻的连续方括号内容块 [...]
  const bodies = []
  if (s[k] === '[' && balancedEnd(s, k) !== -1) {
    const end = balancedEnd(s, k)
    bodies.push(s.slice(k + 1, end - 1))
    j = end

    for (;;) {
      let p = j
      while (p < s.length && (s[p] === ' ' || s[p] === '\t')) p++
      if (s[p] !== '[') break
      const e2 = balancedEnd(s, p)
      if (e2 === -1) break
      bodies.push(s.slice(p + 1, e2 - 1))
      j = e2
    }
  }

  return { name, argsRaw, bodies, body: bodies[0] ?? null, next: j, start: i }
}

// 单个参数求值：内容块解析为 AST，字符串解引号，其余保留原样
function parseArgValue(raw, ctx) {
  const t = String(raw ?? '').trim()
  if (!t) return t
  if (t.startsWith('[') && balancedEnd(t, 0) === t.length) {
    return parseInline(t.slice(1, -1), ctx)
  }
  if (t.startsWith('"') && skipString(t, 0) === t.length) {
    return unquote(t)
  }
  return t
}

// 解析参数列表为位置参数与命名参数
function parseArgs(argsRaw, ctx = null) {
  const positional = []
  const named = {}
  if (argsRaw == null) return { positional, named }
  for (const part of splitTopLevel(argsRaw, ',')) {
    const t = part.trim()
    if (!t) continue
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*([\s\S]*)$/.exec(t)
    if (m) named[m[1]] = parseArgValue(m[2], ctx)
    else positional.push(parseArgValue(t, ctx))
  }
  return { positional, named }
}

const indentOf = (line) => /^[ \t]*/.exec(line)[0].length

// 判断是否为独立块级前缀
function isBlockPrefix(line) {
  const t = line.replace(/^[ \t]+/, '')
  return /^(=+)[ \t]/.test(t) || /^[-+][ \t]/.test(t) || /^```/.test(t)
}

// 递归解析块级文档流
function parseBlocks(s, ctx) {
  const out = []
  let i = 0
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++
    if (i >= s.length) break

    // 块级代码块 ```lang ... ```
    if (s.slice(i, i + 3) === '```') {
      let count = 0
      while (i + count < s.length && s[i + count] === '`') count++
      const firstLineEnd = lineEndOf(s, i)
      const lang = s.slice(i + count, firstLineEnd).trim()
      let j = firstLineEnd + 1
      let foundEnd = false
      let blockContentEnd = j
      while (j < s.length) {
        const nextLineEnd = lineEndOf(s, j)
        const line = s.slice(j, nextLineEnd).trim()
        if (line.startsWith('`'.repeat(count))) {
          blockContentEnd = j
          foundEnd = true
          i = nextLineEnd + 1
          break
        }
        j = nextLineEnd + 1
      }
      if (!foundEnd) {
        blockContentEnd = s.length
        i = s.length
      }
      out.push({
        type: 'raw',
        block: true,
        lang: lang || null,
        text: s.slice(firstLineEnd + 1, blockContentEnd).replace(/\n$/, ''),
      })
      continue
    }

    // 标题 (=, ==, ===)
    const hm = /^(=+)[ \t]/.exec(s.slice(i, i + 8))
    if (hm) {
      const end = lineEndOf(s, i)
      const line = s.slice(i + hm[1].length, end).trim()
      const children = parseInline(line, ctx)
      out.push({
        type: 'heading',
        level: hm[1].length,
        children,
        text: plainText(children),
      })
      i = end + 1
      continue
    }

    // 独立公式块（行首 $ 且首尾留白）
    if (s[i] === '$' && /\s/.test(s[i + 1] ?? '')) {
      const close = mathClose(s, i)
      if (close !== -1) {
        const node = makeMath(s.slice(i + 1, close))
        if (node) out.push(node)
        i = close + 1
        continue
      }
    }

    // 列表项（无序 -，有序 +）
    if (/^[-+][ \t]/.test(s.slice(i, i + 3))) {
      const r = parseList(s, i, ctx, indentOf(s.slice(i, lineEndOf(s, i))))
      if (r.node.items.length > 0) out.push(r.node)
      i = r.next
      continue
    }

    // 独立块级宏调用或表格
    if (s[i] === '#') {
      const call = parseCall(s, i)
      if (call) {
        if (call.name === 'import') {
          i = lineEndOf(s, i) + 1
          continue
        }

        let after = call.next
        while (after < s.length && (s[after] === ' ' || s[after] === '\t')) after++
        const isEndOfLine = after >= s.length || s[after] === '\n' || s[after] === '\r'

        if (isEndOfLine) {
          const nodes = dispatchBlock(call, ctx)
          for (const n of nodes) if (n) out.push(n)
          i = call.next
          continue
        }
      }
    }

    // 普通自然段落
    const para = parseParagraph(s, i, ctx)
    if (para.node) out.push(para.node)
    i = para.next
  }
  return out
}

// 解析自然段落，由连续空行或独立块语法界定边界
function parseParagraph(s, i, ctx) {
  const lines = []
  let j = i
  while (j < s.length) {
    const end = lineEndOf(s, j)
    const line = s.slice(j, end)
    if (line.trim() === '') break

    if (lines.length > 0) {
      if (isBlockPrefix(line) || /^\$(?:\s|$)/.test(line.trim())) break
      const trimLine = line.trim()
      if (trimLine.startsWith('#')) {
        const call = parseCall(s, j + (line.length - line.replace(/^[ \t]+/, '').length))
        if (call && (call.name === 'table' || (Array.isArray(call.bodies) && call.bodies.length > 0))) {
          let after = call.next
          while (after < s.length && (s[after] === ' ' || s[after] === '\t')) after++
          if (after >= s.length || s[after] === '\n' || s[after] === '\r') {
            break
          }
        }
      }
    }

    lines.push(line.trim())
    j = end + 1
  }

  if (lines.length === 0) return { node: null, next: j + 1 }
  const children = parseInline(lines.join(' '), ctx)
  if (children.length === 0) return { node: null, next: j }
  return { node: { type: 'para', children }, next: j }
}

// 解析列表及多层缩进嵌套
function parseList(s, i, ctx, indent) {
  const items = []
  let ordered = null
  let j = i

  while (j < s.length) {
    const end = lineEndOf(s, j)
    const m = /^([ \t]*)([-+])([ \t]+)([\s\S]*)$/.exec(s.slice(j, end))
    if (!m || m[1].length !== indent) break
    const isOrdered = m[2] === '+'
    if (ordered === null) ordered = isOrdered
    else if (isOrdered !== ordered) break

    const parts = [m[4]]
    const nested = []
    j = end + 1

    while (j < s.length) {
      const e2 = lineEndOf(s, j)
      const l2 = s.slice(j, e2)
      if (l2.trim() === '' || indentOf(l2) <= indent) break
      const m2 = /^[ \t]*([-+])([ \t]+)/.exec(l2)
      if (m2) {
        const r = parseList(s, j, ctx, indentOf(l2))
        if (r.node.items.length > 0) nested.push(r.node)
        j = r.next
        continue
      }
      parts.push(l2.trim())
      j = e2 + 1
    }

    const children = parseInline(parts.join(' '), ctx)
    for (const n of nested) children.push(n)
    items.push({ type: 'item', children })
  }

  return { node: { type: 'list', ordered: !!ordered, items }, next: j }
}

// 分发块级调用：通用语法输出标准标记、call 或 table 节点
function dispatchBlock(call, ctx) {
  const { name, argsRaw, body } = call

  if (name === 'table') return [makeTable(argsRaw, ctx)]
  if (name === 'strong') return [{ type: 'strong', children: parseInline(body ?? '', ctx) }]
  if (name === 'emph') return [{ type: 'emph', children: parseInline(body ?? '', ctx) }]
  if (name === 'underline') return [{ type: 'underline', children: parseInline(body ?? '', ctx) }]
  if (name === 'link') {
    const { positional } = parseArgs(argsRaw, ctx)
    return [{ type: 'link', href: unquote(positional[0]), children: parseInline(body ?? '', ctx) }]
  }
  if (name === 'text') {
    const { named } = parseArgs(argsRaw, ctx)
    const children = parseInline(body ?? '', ctx)
    if (named.weight && /bold/i.test(String(named.weight))) {
      return [{ type: 'strong', styles: named, children }]
    }
    return [{ type: 'span', styles: named, children }]
  }

  const { positional, named } = parseArgs(argsRaw, ctx)
  const bodies = Array.isArray(call.bodies) && call.bodies.length > 0
    ? call.bodies.map(b => parseBlocks(b, ctx))
    : (body != null ? [parseBlocks(body, ctx)] : [])

  return [{
    type: 'call',
    name,
    args: { positional, named },
    bodies
  }]
}

// 解析表格并自动计算行列布局
function makeTable(argsRaw, ctx) {
  const named = {}
  const cells = []

  for (const part of splitTopLevel(argsRaw ?? '', ',')) {
    const t = part.trim()
    if (!t || /^table\.(hline|vline|header)\s*\(/.test(t)) continue

    if (/^table\.cell\s*\(/.test(t)) {
      const call = parseCall('#' + t, 0)
      if (call) {
        const { named: cn } = parseArgs(call.argsRaw)
        cells.push({
          colspan: Number(cn.colspan) > 0 ? Number(cn.colspan) : 1,
          rowspan: Number(cn.rowspan) > 0 ? Number(cn.rowspan) : 1,
          align: cn.align ?? null,
          children: parseBlocks(call.body ?? '', ctx),
        })
        continue
      }
    }

    if (t.startsWith('[')) {
      cells.push({ colspan: 1, rowspan: 1, align: null, children: parseBlocks(unwrapBracket(t), ctx) })
      continue
    }

    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*([\s\S]*)$/.exec(t)
    if (m) named[m[1]] = m[2].trim()
  }

  let colCount = 0
  if (named.columns) {
    let spec = named.columns.trim()
    if (spec.startsWith('(') && skipBalanced(spec, 0) === spec.length) spec = spec.slice(1, -1)
    colCount = splitTopLevel(spec, ',').filter(x => x.trim() !== '').length
  }
  const columns = colCount || cells.length || 1

  const rows = []
  let cur = []
  let used = 0
  for (const cell of cells) {
    cur.push(cell)
    used += cell.colspan
    if (used >= columns) { rows.push(cur); cur = []; used = 0 }
  }
  if (cur.length > 0) rows.push(cur)

  return { type: 'table', columns, rows }
}

// 解析行内文本、代码、公式、标签与宏调用
function parseInline(s, ctx) {
  const out = []
  let buf = ''
  let i = 0

  const flush = () => {
    if (buf !== '') { out.push({ type: 'text', value: buf }); buf = '' }
  }

  while (i < s.length) {
    const c = s[i]

    // 反斜杠换行与字符转义
    if (c === '\\') {
      const nx = s[i + 1]
      if (nx === undefined || /\s/.test(nx)) {
        flush()
        out.push({ type: 'linebreak' })
        i += nx === undefined ? 1 : 2
        continue
      }
      buf += nx
      i += 2
      continue
    }

    // 行内代码 `code`
    if (c === '`') {
      let count = 0
      while (i + count < s.length && s[i + count] === '`') count++
      let j = i + count
      let end = -1
      while (j < s.length) {
        if (s[j] === '`') {
          let close = 0
          while (j + close < s.length && s[j + close] === '`') close++
          if (close === count) { end = j; break }
          j += close
          continue
        }
        j++
      }
      if (end !== -1) {
        flush()
        out.push({ type: 'raw', block: false, text: s.slice(i + count, end) })
        i = end + count
        continue
      }
    }

    // 原生标签 <label> 与引用 @ref
    if (c === '<') {
      const lm = /^<([A-Za-z0-9_:-]+)>/.exec(s.slice(i, i + 64))
      if (lm) {
        flush()
        out.push({ type: 'label', name: lm[1] })
        i += lm[0].length
        continue
      }
    }
    if (c === '@') {
      const rm = /^@([A-Za-z0-9_:-]+)/.exec(s.slice(i, i + 64))
      if (rm) {
        flush()
        out.push({ type: 'ref', target: rm[1] })
        i += rm[0].length
        continue
      }
    }

    // 原生粗体 *bold*
    if (c === '*' && i + 1 < s.length && !/\s/.test(s[i + 1])) {
      let j = i + 1
      let end = -1
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue }
        if (s[j] === '*' && !/\s/.test(s[j - 1])) { end = j; break }
        j++
      }
      if (end !== -1) {
        flush()
        out.push({ type: 'strong', children: parseInline(s.slice(i + 1, end), ctx) })
        i = end + 1
        continue
      }
    }

    // 原生斜体 _emph_
    if (c === '_' && i + 1 < s.length && !/\s/.test(s[i + 1])) {
      let j = i + 1
      let end = -1
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue }
        if (s[j] === '_' && !/\s/.test(s[j - 1])) { end = j; break }
        j++
      }
      if (end !== -1) {
        flush()
        out.push({ type: 'emph', children: parseInline(s.slice(i + 1, end), ctx) })
        i = end + 1
        continue
      }
    }

    // 行内数学公式 $...$
    if (c === '$') {
      const { inner, next } = readMath(s, i)
      flush()
      const node = makeMath(inner)
      if (node) out.push(node)
      i = next
      continue
    }

    // 行内宏调用 #call
    if (c === '#') {
      const call = parseCall(s, i)
      if (call) {
        flush()
        for (const n of dispatchInline(call, ctx)) if (n) out.push(n)
        i = call.next
        continue
      }
    }

    buf += c
    i++
  }

  flush()
  return normalizeInline(out)
}

// 分发行内原生样式与通用宏调用
function dispatchInline(call, ctx) {
  const { name, argsRaw, body } = call

  if (name === 'strong') return [{ type: 'strong', children: parseInline(body ?? '', ctx) }]
  if (name === 'emph') return [{ type: 'emph', children: parseInline(body ?? '', ctx) }]
  if (name === 'underline') return [{ type: 'underline', children: parseInline(body ?? '', ctx) }]

  if (name === 'link') {
    const { positional } = parseArgs(argsRaw, ctx)
    return [{ type: 'link', href: unquote(positional[0]), children: parseInline(body ?? '', ctx) }]
  }

  // 标准 text 宏：完整保留属性字典
  if (name === 'text') {
    const { named } = parseArgs(argsRaw, ctx)
    const children = parseInline(body ?? '', ctx)
    if (named.weight && /bold/i.test(String(named.weight))) {
      return [{ type: 'strong', styles: named, children }]
    }
    return [{ type: 'span', styles: named, children }]
  }

  const { positional, named } = parseArgs(argsRaw, ctx)
  const bodies = Array.isArray(call.bodies) && call.bodies.length > 0
    ? call.bodies.map(b => parseInline(b, ctx))
    : (body != null ? [parseInline(body, ctx)] : [])

  return [{
    type: 'call',
    name,
    args: { positional, named },
    bodies
  }]
}

// 合并文本并规整空白
function normalizeInline(nodes) {
  const merged = []
  for (const n of nodes) {
    const prev = merged[merged.length - 1]
    if (n.type === 'text' && prev && prev.type === 'text') {
      prev.value += n.value
      continue
    }
    merged.push(n.type === 'text' ? { type: 'text', value: n.value } : n)
  }

  const out = []
  for (const n of merged) {
    if (n.type === 'text') {
      n.value = n.value.replace(/[ \t\r\n]+/g, ' ')
      if (out[out.length - 1]?.type === 'linebreak') n.value = n.value.replace(/^ +/, '')
      if (n.value === '') continue
    }
    out.push(n)
  }
  if (out.length > 0 && out[0].type === 'text') out[0].value = out[0].value.replace(/^ +/, '')
  const last = out[out.length - 1]
  if (last && last.type === 'text') last.value = last.value.replace(/ +$/, '')
  const kept = out.filter(n => !(n.type === 'text' && n.value === ''))
  while (kept.length > 0 && kept[0].type === 'linebreak') kept.shift()
  while (kept.length > 0 && kept[kept.length - 1].type === 'linebreak') kept.pop()
  return kept
}

// 提取 AST 纯文本
export function plainText(nodes) {
  let out = ''
  for (const n of nodes ?? []) {
    switch (n.type) {
      case 'text': out += n.value; break
      case 'math': out += n.typst; break
      case 'raw': out += n.text; break
      case 'linebreak': out += ' '; break
      case 'tag': out += n.text; break
      case 'table':
        for (const row of n.rows) for (const cell of row) out += plainText(cell.children) + ' '
        break
      default:
        if (n.children) out += plainText(n.children)
        else if (n.bodies) for (const b of n.bodies) out += plainText(b) + ' '
    }
  }
  return out.replace(/\s+/g, ' ').trim()
}

// 提取标签与引用标识
export function collectTags(nodes) {
  const out = []
  for (const n of nodes ?? []) {
    if (n.type === 'tag') {
      out.push({ color: n.color, text: n.text })
    } else if (n.type === 'label') {
      out.push({ color: null, text: n.name })
    } else if (n.tags && Array.isArray(n.tags)) {
      out.push(...n.tags)
    } else if (n.children) {
      out.push(...collectTags(n.children))
    } else if (n.bodies) {
      for (const b of n.bodies) out.push(...collectTags(b))
    }
  }
  return out
}

// 遍历 AST 节点树
export function walk(nodes, visit) {
  for (const n of nodes ?? []) {
    visit(n)
    if (n.children) walk(n.children, visit)
    if (n.titleChildren) walk(n.titleChildren, visit)
    if (n.bodies) for (const b of n.bodies) walk(b, visit)
    if (n.items) for (const it of n.items) walk(it.children, visit)
    if (n.rows) for (const row of n.rows) for (const cell of row) walk(cell.children, visit)
    if (n.args) {
      if (Array.isArray(n.args.positional)) {
        for (const p of n.args.positional) {
          if (Array.isArray(p)) walk(p, visit)
        }
      }
      if (n.args.named && typeof n.args.named === 'object') {
        for (const v of Object.values(n.args.named)) {
          if (Array.isArray(v)) walk(v, visit)
        }
      }
    }
  }
}

// 主入口：将 Typst 文本解析为主文档语法 AST
export function parseTypst(source, opts = {}) {
  const ctx = { warnings: [], file: opts.file ?? null }
  const src = stripComments(String(source ?? '')).replace(/\r\n?/g, '\n')
  let children = []
  try {
    children = parseBlocks(src, ctx)
  } catch (err) {
    ctx.warnings.push(`解析中断：${err.message}`)
    if (opts.throwOnError) throw err
  }
  return {
    type: 'doc',
    version: SCHEMA_VERSION,
    file: opts.file ?? null,
    children,
    warnings: ctx.warnings,
  }
}

export default parseTypst
