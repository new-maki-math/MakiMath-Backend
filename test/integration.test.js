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
        slug: 'section', title: '小节', source: `解释 #mm-knowledge(${pointId})`,
      }] }],
    }
    assert.equal((await call('PUT', `/lecture-revisions/${revisionId}`, draft, outsider)).status, 403)
    const missing = structuredClone(draft)
    missing.chapters[0].sections[0].source = '#mm-knowledge(999999999)'
    assert.equal((await call('PUT', `/lecture-revisions/${revisionId}`, missing, editor)).status, 409)
    const concurrent = await Promise.all([
      call('PUT', `/lecture-revisions/${revisionId}`, draft, editor),
      call('PUT', `/lecture-revisions/${revisionId}`, draft, editor),
    ])
    assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409])
    const saved = concurrent.find(r => r.status === 200)
    const duplicate = structuredClone(draft)
    duplicate.edit_version = saved.data.revision.edit_version
    duplicate.chapters[0].sections[0].source = saved.data.chapters[0].sections[0].source
    duplicate.chapters[0].sections.push({ slug: 'section-two', source: saved.data.chapters[0].sections[0].source })
    assert.equal((await call('PUT', `/lecture-revisions/${revisionId}`, duplicate, editor)).status, 409)
    const afterDuplicate = await call('GET', `/lecture-revisions/${revisionId}`, undefined, editor)
    assert.equal(afterDuplicate.data.revision.edit_version, saved.data.revision.edit_version)
    assert.equal(afterDuplicate.data.chapters[0].sections.length, 1)
    assert.equal((await call('GET', '/lectures/' + lectureId)).status, 404)
    const submissions = await Promise.all([
      call('POST', `/lecture-revisions/${revisionId}/submit`, { edit_version: saved.data.revision.edit_version }, editor),
      call('POST', `/lecture-revisions/${revisionId}/submit`, { edit_version: saved.data.revision.edit_version }, editor),
    ])
    assert.deepEqual(submissions.map(item => item.status).sort(), [200,409])
    const submitted = submissions.find(item => item.status === 200)
    const snapshotId = submitted.data.snapshot.id
    const changedDraft = structuredClone(draft)
    changedDraft.edit_version = saved.data.revision.edit_version
    changedDraft.chapters[0].sections[0].source = saved.data.chapters[0].sections[0].source + ' 草稿后续修改'
    const edited = await call('PUT', `/lecture-revisions/${revisionId}`, changedDraft, editor)
    assert.equal(edited.status, 200, JSON.stringify(edited.data))
    assert.equal((await call('PUT', `/lecture-revisions/${snapshotId}`, changedDraft, editor)).status, 409)
    assert.equal((await call('POST', `/reviews/lecture/${snapshotId}`, { decision: 'approved', comment: '' }, outsider)).status, 403)
    assert.equal((await call('PATCH', `/knowledge-points/${pointId}/status`, { status: 'disabled' }, admin)).status, 200)
    assert.equal((await call('POST', `/reviews/lecture/${snapshotId}`, { decision: 'approved', comment: '' }, admin)).status, 409)
    assert.equal((await call('PATCH', `/knowledge-points/${pointId}/status`, { status: 'active' }, admin)).status, 200)
    assert.equal((await call('POST', `/reviews/lecture/${snapshotId}`, { decision: 'approved', comment: '' }, admin)).status, 201)
    assert.equal((await call('POST', `/reviews/lecture/${snapshotId}`, { decision: 'approved', comment: '' }, admin)).status, 409)
    const published = await call('GET', '/lectures/' + lectureId)
    assert.equal(published.status, 200, JSON.stringify(published.data))
    assert.equal(published.data.revision.id, snapshotId)
    assert.ok(!published.data.chapters[0].sections[0].source.includes('草稿后续修改'))
    const ongoing = await call('GET', `/lecture-revisions/${revisionId}`, undefined, editor)
    assert.equal(ongoing.data.revision.based_on_id, snapshotId)
    assert.ok(ongoing.data.chapters[0].sections[0].source.includes('草稿后续修改'))
    const resubmit = await call('POST', `/lecture-revisions/${revisionId}/submit`, { edit_version: ongoing.data.revision.edit_version }, editor)
    assert.equal(resubmit.status, 200, JSON.stringify(resubmit.data))
    assert.equal((await call('POST', `/reviews/lecture/${resubmit.data.snapshot.id}`, { decision: 'rejected', comment: '待修改' }, admin)).status, 201)
    assert.equal((await call('GET', '/lectures/' + lectureId)).data.revision.id, snapshotId)
    const search = await call('GET', '/search?q=正文')
    assert.equal(search.status, 200, JSON.stringify(search.data))
    assert.equal(published.data.chapters[0].sections[0].references[0].knowledge_source, '正文')
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
    assert.equal(unchanged.data.chapters[0].sections[0].references[0].knowledge_source, '修订正文')
    const dynamicSearch = await call('GET', '/search?q=修订正文')
    assert.ok(dynamicSearch.data.hits.some(hit => hit.type === 'lecture' && hit.id === lectureId))
    const savedRef = published.data.chapters[0].sections[0].references[0].occurrence_id
    assert.equal(unchanged.data.chapters[0].sections[0].references[0].occurrence_id, savedRef)
    assert.equal((await call('PATCH', `/knowledge-points/${pointId}/status`, { status: 'disabled' }, admin)).status, 200)
    const unavailable = await call('GET', '/lectures/' + lectureId)
    assert.equal(unavailable.data.chapters[0].sections[0].references[0].availability, 'unavailable')
    assert.equal(unavailable.data.chapters[0].sections[0].references[0].knowledge_source, null)
    const copied = await call('POST', `/lectures/${lectureId}/revisions`, { based_on_id: snapshotId }, editor)
    assert.equal(copied.status, 201, JSON.stringify(copied.data))
    assert.equal(copied.data.chapters[0].sections[0].references[0].occurrence_id, savedRef)
    const copiedDraft = structuredClone(draft)
    copiedDraft.edit_version = copied.data.revision.edit_version
    copiedDraft.chapters[0].occurrence_id = copied.data.chapters[0].occurrence_id
    copiedDraft.chapters[0].sections[0].occurrence_id = copied.data.chapters[0].sections[0].occurrence_id
    copiedDraft.chapters[0].sections[0].source = copied.data.chapters[0].sections[0].source
    const warningSave = await call('PUT', `/lecture-revisions/${copied.data.revision.id}`, copiedDraft, editor)
    assert.equal(warningSave.status, 200, JSON.stringify(warningSave.data))
    assert.equal(warningSave.data.warnings.length, 1)
    assert.equal(warningSave.data.warnings[0].occurrence_id, savedRef)
    assert.equal((await call('POST', `/lecture-revisions/${copied.data.revision.id}/submit`, { edit_version: warningSave.data.revision.edit_version }, editor)).status, 409)
    await assert.rejects(() => pool.query('UPDATE lecture_sections SET source=$1 WHERE lecture_revision_id=$2', ['未审核内容', snapshotId]))
    await assert.rejects(() => pool.query('DELETE FROM knowledge_points WHERE id=$1', [pointId]))
  } finally {
    await app.close()
    await pool.end()
  }
})
