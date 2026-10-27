import { randomUUID } from 'node:crypto'
import { typstParser } from 'codemirror-lang-typst/lezer'
import { badRequest } from './errors.js'

const marker = /^\/\*mm-ref:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\*\/$/i

// 从源码语法树提取知识点引用
export function extractKnowledgeReferences(source, options = {}) {
  const tree = typstParser.parse(source)
  const calls = []
  const seen = new Set()
  tree.iterate({ enter(node) {
    if (node.type.isError) throw badRequest('Typst 源码语法不完整', { offset: node.from })
    if (node.name === 'BlockComment' && source.slice(node.from, node.to).startsWith('/*mm-ref:') && !marker.test(source.slice(node.from, node.to))) {
      throw badRequest('知识点引用实例标识格式不合法', { offset: node.from })
    }
    if (node.name === 'Ident' && source.slice(node.from, node.to) === 'mm-knowledge' && node.node.parent?.name !== 'FuncCall') {
      throw badRequest('知识点引用必须使用独立宏调用', { offset: node.from })
    }
    if (node.name !== 'FuncCall') return
    const call = node.node
    const ident = call.getChild('Ident')
    if (!ident || source.slice(ident.from, ident.to) !== 'mm-knowledge') return
    const args = call.getChild('Args')
    const value = args?.getChild('Int')
    const valueText = value && source.slice(value.from, value.to)
    const argText = args && source.slice(args.from, args.to)
    if (!valueText || !/^[1-9][0-9]*$/.test(valueText) || !/^\(\s*[1-9][0-9]*\s*\)$/.test(argText)) {
      throw badRequest('知识点引用只能使用正整数标识', { offset: node.from })
    }
    const pointId = Number(valueText)
    if (!Number.isSafeInteger(pointId)) throw badRequest('知识点标识超出范围', { offset: node.from })
    if (source[node.from - 1] !== '#') throw badRequest('知识点引用必须使用独立宏调用', { offset: node.from })
    if (options.forbid) throw badRequest('知识点正文不允许引用其他知识点', { offset: node.from - 1 })
    const hash = node.node.prevSibling
    const previous = hash?.name === 'Hash' ? hash.prevSibling : null
    const matched = previous?.name === 'BlockComment' && previous.to === node.from - 1
      ? source.slice(previous.from, previous.to).match(marker) : null
    const occurrenceId = matched ? matched[1].toLowerCase() : randomUUID()
    if (seen.has(occurrenceId)) throw badRequest('知识点引用实例标识重复', { offset: node.from })
    seen.add(occurrenceId)
    calls.push({ start: matched ? previous.from : node.from - 1, end: node.to, matched, occurrenceId, pointId })
  } })
  let output = ''
  let last = 0
  const references = []
  for (const call of calls) {
    output += source.slice(last, call.start)
    const start = output.length
    if (!call.matched) output += `/*mm-ref:${call.occurrenceId}*/`
    output += source.slice(call.start, call.end)
    references.push({ occurrence_id: call.occurrenceId, knowledge_point_id: call.pointId, source_offset: start, source_length: output.length - start })
    last = call.end
  }
  output += source.slice(last)
  return { source: output, references }
}
