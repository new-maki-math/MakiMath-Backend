import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSections, resolveReferences } from '../src/services/lectures.js'

test('整份讲义不能重复使用引用实例标识', () => {
  const marker = '/*mm-ref:11111111-1111-4111-8111-111111111111*/#mm-knowledge(1)'
  assert.throws(() => parseSections([{ slug: 'a', source: marker }, { slug: 'b', source: marker }]), { status: 409 })
})

test('重复知识点批量读取并对缺失目标显示占位', async () => {
  const sections = parseSections([{ id: 5, slug: 'a', source: '#mm-knowledge(1) #mm-knowledge(1) #mm-knowledge(2)' }], true)
  let calls = 0
  const db = { async query(sql, values) {
    calls++
    assert.deepEqual(values[0], [1, 2])
    return { rows: [{ id: 1, revision_id: 7, knowledge_source: '正文' }] }
  } }
  const resolved = await resolveReferences(db, sections)
  assert.equal(calls, 1)
  assert.deepEqual(resolved[0].references.map(ref => ref.availability), ['available', 'available', 'unavailable'])
  assert.notEqual(resolved[0].references[0].occurrence_id, resolved[0].references[1].occurrence_id)
  assert.equal(resolved[0].references[2].knowledge_source, null)
})
