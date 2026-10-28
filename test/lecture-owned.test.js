import test from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../src/db/pool.js'
import { owned } from '../src/services/lectures.js'

test('本人书架一次查询按讲义聚合全部版本', async () => {
  const original = pool.query
  const calls = []
  pool.query = async (sql, params) => {
    calls.push({ sql, params })
    return { rows: [
      { lecture_id: 1, slug: 'lecture', publication_status: 'published', public_revision_id: 10, revision_id: 11, revision_no: 1, source_draft_id: null, status: 'draft', title: '草稿', subtitle: '', updated_at: '2026-10-28T12:00:00Z' },
      { lecture_id: 1, slug: 'lecture', publication_status: 'published', public_revision_id: 10, revision_id: 10, revision_no: 2, source_draft_id: 11, status: 'approved', title: '公开', subtitle: '', updated_at: '2026-10-27T12:00:00Z' },
      { lecture_id: 1, slug: 'lecture', publication_status: 'published', public_revision_id: 10, revision_id: 12, revision_no: 3, source_draft_id: 11, status: 'draft', title: '异常', subtitle: '', updated_at: '2026-10-26T12:00:00Z' },
      { lecture_id: 2, slug: 'empty', publication_status: 'archived', public_revision_id: null, revision_id: null },
    ] }
  }
  try {
    const result = await owned({ id: 7, role: 'super_admin' })
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].params, [7])
    assert.match(calls[0].sql, /WHERE l\.owner_id=\$1/)
    assert.deepEqual(result[0].versions.map(item => item.kind), ['working_draft','snapshot','snapshot'])
    assert.deepEqual(result[0].versions.map(item => item.is_public), [false,true,false])
    assert.equal(result[0].versions[2].status, 'draft')
    assert.deepEqual(result[1].versions, [])
    await assert.rejects(() => owned(null), { status: 401 })
  } finally {
    pool.query = original
  }
})

test('下架讲义的公开指针不会标记为当前公开', async () => {
  const original = pool.query
  pool.query = async () => ({ rows: [{
    lecture_id: 1, slug: 'lecture', publication_status: 'withdrawn', public_revision_id: 10,
    revision_id: 10, revision_no: 1, source_draft_id: 11, status: 'approved', title: '标题', subtitle: '', updated_at: '2026-10-28T12:00:00Z',
  }] })
  try {
    assert.equal((await owned({ id: 7, role: 'editor' }))[0].versions[0].is_public, false)
  } finally {
    pool.query = original
  }
})
