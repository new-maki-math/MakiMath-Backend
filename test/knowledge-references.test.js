import test from 'node:test'
import assert from 'node:assert/strict'
import { extractKnowledgeReferences as extract } from '../src/lib/knowledge-references.js'

test('引用提取跳过注释字符串与原样内容', () => {
  const source = '// #mm-knowledge(1)\n#text("#mm-knowledge(2)") `#mm-knowledge(3)` #mm-knowledge(4)'
  const result = extract(source)
  assert.deepEqual(result.references.map(ref => ref.knowledge_point_id), [4])
  assert.equal(extract(result.source).references[0].occurrence_id, result.references[0].occurrence_id)
})

test('引用实例在移动后保留并拒绝重复标识', () => {
  const result = extract('#mm-knowledge(1) #mm-knowledge(1)')
  const parts = result.source.split(' ')
  const moved = extract(parts.reverse().join(' '))
  assert.deepEqual(moved.references.map(ref => ref.occurrence_id), result.references.map(ref => ref.occurrence_id).reverse())
  assert.throws(() => extract(parts[0] + ' ' + parts[0]), { status: 400 })
})

test('引用拒绝动态参数与知识点嵌套', () => {
  for (const source of ['#mm-knowledge(1 + 2)', '#mm-knowledge(x)', '#mm-knowledge(0)', '#let x = mm-knowledge(1)', '#mm-knowledge(1).text', '/*mm-ref:11111111-1111-4111-8111-111111111111*/#mm-knowledge(1).text']) {
    assert.throws(() => extract(source), { status: 400 })
  }
  assert.throws(() => extract('#mm-knowledge(1)', { forbid: true }), { status: 400 })
})
