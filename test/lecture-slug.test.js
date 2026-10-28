import test from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../src/db/pool.js'
import { lectureBySlug } from '../src/services/lectures.js'

function clientFor(lecture, revisions, collaborators = []) {
  const calls = []
  return {
    calls,
    async query(sql, params = []) {
      calls.push(sql)
      if (sql.startsWith('SELECT id,slug,owner_id')) return { rows: lecture && params[0] === lecture.slug ? [lecture] : [] }
      if (sql.startsWith('SELECT 1 FROM lecture_collaborators')) return { rows: collaborators.includes(params[1]) ? [{ '?column?': 1 }] : [] }
      if (sql.startsWith('SELECT id,title,status,updated_at')) return { rows: revisions.filter(item => item.status === 'draft' && item.source_draft_id === null) }
      if (sql.startsWith('SELECT id,status FROM lecture_revisions')) return { rows: revisions.filter(item => item.id === params[0] && item.lecture_id === params[1]) }
      if (sql.startsWith('SELECT * FROM lecture_revisions')) return { rows: revisions.filter(item => item.id === params[0]) }
      return { rows: [] }
    },
    release() {},
  }
}

test('公开 slug 默认读取已发布版本而不会切换草稿', async () => {
  const original = pool.connect
  const client = clientFor(
    { id: 1, slug: 'lecture', owner_id: 2, publication_status: 'published', public_revision_id: 10, is_recommended: false },
    [{ id: 10, lecture_id: 1, status: 'approved' }, { id: 11, lecture_id: 1, status: 'draft', source_draft_id: null }],
  )
  pool.connect = async () => client
  try {
    assert.equal((await lectureBySlug(null, 'lecture')).revision.id, 10)
    assert.equal((await lectureBySlug({ id: 2, role: 'editor' }, 'lecture')).revision.id, 10)
    assert.equal((await lectureBySlug({ id: 2, role: 'editor' }, 'lecture', 11)).revision.id, 11)
    await assert.rejects(() => lectureBySlug(null, 'lecture', 11), { status: 404 })
    assert.ok(client.calls.includes('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'))
  } finally {
    pool.connect = original
  }
})

test('私有 slug 只允许所有者协作者和管理员读取', async () => {
  const original = pool.connect
  const client = clientFor(
    { id: 1, slug: 'private', owner_id: 2, publication_status: 'unpublished', public_revision_id: null, is_recommended: false },
    [{ id: 11, lecture_id: 1, status: 'draft', source_draft_id: null }, { id: 12, lecture_id: 1, status: 'pending' }],
    [3],
  )
  pool.connect = async () => client
  try {
    await assert.rejects(() => lectureBySlug(null, 'private'), { status: 404 })
    await assert.rejects(() => lectureBySlug({ id: 4, role: 'editor' }, 'private', 12), { status: 404 })
    assert.equal((await lectureBySlug({ id: 3, role: 'editor' }, 'private')).revision.id, 11)
    assert.equal((await lectureBySlug({ id: 2, role: 'editor' }, 'private', 12)).revision.id, 12)
    await assert.rejects(() => lectureBySlug({ id: 2, role: 'editor' }, 'private', 999), { status: 404 })
  } finally {
    pool.connect = original
  }
})

test('未同步的多草稿数据不会被静默选择', async () => {
  const original = pool.connect
  pool.connect = async () => clientFor(
    { id: 1, slug: 'private', owner_id: 2, publication_status: 'unpublished', public_revision_id: null, is_recommended: false },
    [{ id: 11, lecture_id: 1, status: 'draft', source_draft_id: null }, { id: 12, lecture_id: 1, status: 'draft', source_draft_id: null }],
  )
  try {
    await assert.rejects(() => lectureBySlug({ id: 2, role: 'editor' }, 'private'), { status: 409 })
  } finally {
    pool.connect = original
  }
})
