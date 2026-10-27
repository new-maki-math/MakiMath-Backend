import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { buildApp } from '../src/app.js'
import { pool } from '../src/db/pool.js'
import { encryptPayload, decryptPayload } from '../src/lib/crypto.js'

const enabled = process.env.MAKIMATH_INTEGRATION === '1'

test('知识点审核与讲义发布完整流程', { skip: !enabled }, async () => {
  if (!process.env.PGDATABASE || !/^[a-z0-9_]+_test$/i.test(process.env.PGDATABASE)) {
    throw new Error('集成验证必须显式指定名称以测试后缀结尾的独立数据库')
  }
  const app = await buildApp({ logger: false })
  const suffix = randomBytes(6).toString('hex')
  const password = 'example-pass-2026'
  const passHash = await bcrypt.hash(password, 12)
  const accounts = ['admin', 'editor', 'outsider'].map(name => name + '-' + suffix)
  try {
    const check = await pool.query("SELECT current_database() AS name, to_regclass('public.lecture_revisions') IS NOT NULL AS ready")
    assert.equal(check.rows[0].name, process.env.PGDATABASE)
    assert.equal(check.rows[0].ready, true)
    await pool.query(
      `INSERT INTO users(username,password_hash,role) VALUES ($1,$4,'super_admin'),($2,$4,'editor'),($3,$4,'editor')`,
      [...accounts, passHash],
    )
    await app.ready()

    async function call(method, url, payload, token) {
      const response = await app.inject({
        method, url: '/api' + url,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        ...(payload === undefined ? {} : { payload: encryptPayload(payload) }),
      })
      const parsed = response.body ? response.json() : null
      return { status: response.statusCode, data: response.statusCode < 300 && parsed?.d ? decryptPayload(parsed) : parsed }
    }

    const tokens = []
    for (const username of accounts) {
      const login = await call('POST', '/auth/login', { username, password })
      assert.equal(login.status, 200, JSON.stringify(login.data))
      tokens.push(login.data.access_token)
    }
    const [admin, editor, outsider] = tokens
    const knowledge = await call('POST', '/knowledge-points', { slug: 'point-' + suffix, title: '定义', source: '正文' }, editor)
    assert.equal(knowledge.status, 201, JSON.stringify(knowledge.data))
    const pointId = knowledge.data.point.id
    const knowledgeId = knowledge.data.revision.id
    assert.equal((await call('GET', '/knowledge-points/' + pointId)).status, 404)
    assert.equal((await call('POST', `/knowledge-revisions/${knowledgeId}/submit`, { edit_version: 1 }, editor)).status, 200)
    assert.equal((await call('POST', `/reviews/knowledge/${knowledgeId}`, { decision: 'approved', comment: '' }, outsider)).status, 403)
    assert.equal((await call('POST', `/reviews/knowledge/${knowledgeId}`, { decision: 'approved', comment: '' }, admin)).status, 201)
    const later = await call('POST', `/knowledge-points/${pointId}/revisions`, { based_on_id: knowledgeId }, editor)
    assert.equal(later.status, 201)

    const created = await call('POST', '/lectures', { slug: 'lecture-' + suffix, title: '讲义' }, editor)
    assert.equal(created.status, 201, JSON.stringify(created.data))
    const lectureId = created.data.lecture.id
    const revisionId = created.data.revision.id
    const draft = {
      edit_version: 1, title: '讲义', subtitle: '', descr: '', category_id: null,
      typst_version: '0.15.1', metadata: {}, change_note: '',
      chapters: [{ slug: 'chapter', title: '章节', sections: [{
        slug: 'section', title: '小节', blocks: [
          { block_type: 'author', source: '解释' },
          { block_type: 'knowledge_reference', knowledge_point_id: pointId, knowledge_revision_id: knowledgeId },
        ],
      }] }],
    }
    assert.equal((await call('PUT', `/lecture-revisions/${revisionId}`, draft, outsider)).status, 403)
    const unapproved = structuredClone(draft)
    unapproved.chapters[0].sections[0].blocks[1].knowledge_revision_id = later.data.id
    assert.equal((await call('PUT', `/lecture-revisions/${revisionId}`, unapproved, editor)).status, 409)
    const concurrent = await Promise.all([
      call('PUT', `/lecture-revisions/${revisionId}`, draft, editor),
      call('PUT', `/lecture-revisions/${revisionId}`, draft, editor),
    ])
    assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409])
    const saved = concurrent.find(r => r.status === 200)
    assert.equal((await call('GET', '/lectures/' + lectureId)).status, 404)
    assert.equal((await call('POST', `/lecture-revisions/${revisionId}/submit`, { edit_version: saved.data.revision.edit_version }, editor)).status, 200)
    assert.equal((await call('POST', `/lecture-revisions/${revisionId}/submit`, { edit_version: saved.data.revision.edit_version }, editor)).status, 409)
    assert.equal((await call('PUT', `/lecture-revisions/${revisionId}`, draft, editor)).status, 409)
    assert.equal((await call('POST', `/reviews/lecture/${revisionId}`, { decision: 'approved', comment: '' }, outsider)).status, 403)
    assert.equal((await call('POST', `/reviews/lecture/${revisionId}`, { decision: 'approved', comment: '' }, admin)).status, 201)
    assert.equal((await call('POST', `/reviews/lecture/${revisionId}`, { decision: 'approved', comment: '' }, admin)).status, 409)
    const published = await call('GET', '/lectures/' + lectureId)
    assert.equal(published.status, 200, JSON.stringify(published.data))
    assert.equal(published.data.revision.id, revisionId)
    assert.equal(published.data.chapters[0].sections[0].blocks[1].knowledge_source, '正文')
    await assert.rejects(() => pool.query('DELETE FROM knowledge_revisions WHERE id=$1', [knowledgeId]))
    const update = {
      edit_version: later.data.edit_version, title: '定义', summary: '', source: '修订正文',
      animation: null, metadata: {}, change_note: '更新',
    }
    const updated = await call('PUT', `/knowledge-revisions/${later.data.id}`, update, editor)
    assert.equal(updated.status, 200)
    assert.equal((await call('POST', `/knowledge-revisions/${later.data.id}/submit`, { edit_version: updated.data.edit_version }, editor)).status, 200)
    assert.equal((await call('POST', `/reviews/knowledge/${later.data.id}`, { decision: 'approved', comment: '' }, admin)).status, 201)
    const unchanged = await call('GET', '/lectures/' + lectureId)
    assert.equal(unchanged.data.chapters[0].sections[0].blocks[1].knowledge_source, '正文')
  } finally {
    await app.close()
    await pool.end()
  }
})
