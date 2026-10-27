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
    assert.equal((await call('POST', '/knowledge-points', { slug: 'denied-' + suffix, title: '定义', source: '正文' }, editor)).status, 403)
    const knowledge = await call('POST', '/knowledge-points', { slug: 'point-' + suffix, title: '定义', source: '正文' }, admin)
    assert.equal(knowledge.status, 201, JSON.stringify(knowledge.data))
    const pointId = knowledge.data.id
    assert.equal((await call('GET', '/knowledge-points/' + pointId)).data.source, '正文')
    assert.equal((await call('PUT', '/knowledge-points/' + pointId, { title: '定义', source: '越权修改' }, editor)).status, 403)
    assert.equal((await call('GET', '/knowledge-points/manage', undefined, editor)).status, 403)
    assert.equal((await call('GET', '/knowledge-points/manage', undefined, admin)).status, 200)
    const categoryA = await call('POST', '/categories/knowledge', { slug: 'active-' + suffix, name: '有效分类' }, admin)
    const categoryB = await call('POST', '/categories/knowledge', { slug: 'archive-' + suffix, name: '归档分类' }, admin)
    assert.equal(categoryA.status, 201)
    assert.equal(categoryB.status, 201)
    assert.equal((await call('PUT', `/knowledge-points/${pointId}/categories`, { categories: [categoryA.data.id, categoryB.data.id] }, admin)).status, 200)
    assert.equal((await call('PUT', `/categories/knowledge/${categoryB.data.id}`, {
      parent_id: null, name: '归档分类', descr: '', pos: 0, status: 'archived',
    }, admin)).status, 200)
    const managed = await call('GET', '/knowledge-points/manage', undefined, admin)
    assert.deepEqual(managed.data.find(point => point.id === pointId).category_ids, [categoryA.data.id, categoryB.data.id].sort((a,b) => a-b))
    const visibleCategories = await call('GET', '/categories/knowledge')
    assert.equal(visibleCategories.data.some(category => category.id === categoryB.data.id), false)

    assert.equal((await call('GET', '/knowledge-revisions/mine', undefined, admin)).status, 404)
    assert.equal((await call('POST', '/reviews/knowledge/1', { decision: 'approved', comment: '' }, admin)).status, 400)
    assert.equal((await call('PATCH', `/knowledge-points/${pointId}/status`, { status: 'disabled' }, editor)).status, 403)
    const point2 = await call('POST', '/knowledge-points', { slug: 'pre-' + suffix, title: '前置', source: '前置正文' }, admin)
    assert.equal(point2.status, 201)
    assert.equal((await call('PUT', `/knowledge-points/${pointId}/prerequisites`, { prerequisites: [point2.data.id] }, admin)).status, 200)
    assert.equal((await call('PUT', `/knowledge-points/${point2.data.id}/prerequisites`, { prerequisites: [pointId] }, admin)).status, 409)
    assert.equal((await call('DELETE', `/knowledge-points/${point2.data.id}`, undefined, editor)).status, 403)
    const blockedPoint = await call('DELETE', `/knowledge-points/${point2.data.id}`, undefined, admin)
    assert.equal(blockedPoint.status, 409)
    assert.deepEqual(blockedPoint.data.details.dependent_ids, [pointId])
    const blockedCategory = await call('DELETE', `/categories/knowledge/${categoryB.data.id}`, undefined, admin)
    assert.equal(blockedCategory.status, 409)
    assert.deepEqual(blockedCategory.data.details.knowledge_point_ids, [pointId])
    const child = await call('POST', '/categories/knowledge', { parent_id: categoryA.data.id, slug: 'child-' + suffix, name: '子分类' }, admin)
    assert.equal(child.status, 201)
    const parentBlocked = await call('DELETE', `/categories/knowledge/${categoryA.data.id}`, undefined, admin)
    assert.equal(parentBlocked.status, 409)
    assert.deepEqual(parentBlocked.data.details.child_category_ids, [child.data.id])
    assert.equal((await call('DELETE', `/categories/knowledge/${child.data.id}`, undefined, admin)).status, 204)
    const removable = await call('POST', '/knowledge-points', { slug: 'removable-' + suffix, title: '可删除', source: '正文' }, admin)
    assert.equal(removable.status, 201)
    assert.equal((await call('DELETE', `/knowledge-points/${removable.data.id}`)).status, 401)
    assert.equal((await call('DELETE', `/knowledge-points/${removable.data.id}`, undefined, admin)).status, 204)
    assert.equal((await call('GET', `/knowledge-points/${removable.data.id}`)).status, 404)
    assert.equal((await call('DELETE', `/knowledge-points/${removable.data.id}`, undefined, admin)).status, 404)


    const created = await call('POST', '/lectures', { slug: 'lecture-' + suffix, title: '讲义' }, editor)
    assert.equal(created.status, 201, JSON.stringify(created.data))
    const lectureId = created.data.lecture.id
    const revisionId = created.data.revision.id
    const draft = {
      edit_version: 1, title: '讲义', subtitle: '', descr: '', category_id: null,
      typst_version: '0.15.1', metadata: {}, change_note: '',
      chapters: [{ slug: 'chapter', title: '章节', sections: [{
        slug: 'section', title: '小节', source: `解释 #mm-knowledge(${pointId}) #mm-knowledge(999999999) #mm-knowledge(x) #mm-knowledge(${pointId}) /*mm-ref:legacy*/ #mm-knowledge(`,
      }] }],
    }
    assert.equal((await call('PUT', `/lecture-revisions/${revisionId}`, draft, outsider)).status, 403)
    const concurrent = await Promise.all([
      call('PUT', `/lecture-revisions/${revisionId}`, draft, editor),
      call('PUT', `/lecture-revisions/${revisionId}`, draft, editor),
    ])
    assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409])
    const saved = concurrent.find(r => r.status === 200)
    assert.equal(saved.data.chapters[0].sections[0].source, draft.chapters[0].sections[0].source)
    assert.equal('warnings' in saved.data, false)
    assert.equal('references' in saved.data.chapters[0].sections[0], false)
    assert.equal((await call('PATCH', `/knowledge-points/${pointId}/status`, { status: 'disabled' }, admin)).status, 200)
    const disabledPoints = await call('GET', '/knowledge-points/manage', undefined, admin)
    assert.deepEqual(disabledPoints.data.find(point => point.id === pointId).category_ids, [categoryA.data.id, categoryB.data.id].sort((a,b) => a-b))
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
    assert.equal(published.data.chapters[0].sections[0].source, draft.chapters[0].sections[0].source)
    assert.equal((await call('GET', '/knowledge-points/' + pointId)).status, 404)
    assert.equal((await call('PATCH', `/knowledge-points/${pointId}/status`, { status: 'active' }, admin)).status, 200)
    const updated = await call('PUT', '/knowledge-points/' + pointId, { title: '定义', source: '修订正文' }, admin)
    assert.equal(updated.status, 200)
    assert.equal(updated.data.updated_by, knowledge.data.created_by)
    const unchanged = await call('GET', '/lectures/' + lectureId)
    assert.equal(unchanged.data.chapters[0].sections[0].source, draft.chapters[0].sections[0].source)
    assert.equal((await call('GET', '/knowledge-points/' + pointId)).data.source, '修订正文')
    const dynamicSearch = await call('GET', '/search?q=修订正文')
    assert.ok(dynamicSearch.data.hits.some(hit => hit.type === 'knowledge' && hit.id === pointId))
    assert.ok(!dynamicSearch.data.hits.some(hit => hit.type === 'lecture' && hit.id === lectureId))
    assert.equal((await call('PATCH', `/knowledge-points/${pointId}/status`, { status: 'disabled' }, admin)).status, 200)
    assert.equal((await call('GET', '/knowledge-points/' + pointId)).status, 404)
    assert.equal((await call('GET', '/lectures/' + lectureId)).data.chapters[0].sections[0].source, draft.chapters[0].sections[0].source)
    const copied = await call('POST', `/lectures/${lectureId}/revisions`, { based_on_id: snapshotId }, editor)
    assert.equal(copied.status, 201, JSON.stringify(copied.data))
    assert.equal(copied.data.chapters[0].sections[0].source, draft.chapters[0].sections[0].source)
    assert.equal((await call('POST', `/lecture-revisions/${copied.data.revision.id}/submit`, { edit_version: copied.data.revision.edit_version }, editor)).status, 200)
    await assert.rejects(() => pool.query('UPDATE lecture_sections SET source=$1 WHERE lecture_revision_id=$2', ['未审核内容', snapshotId]))
    await assert.rejects(() => pool.query('DELETE FROM knowledge_points WHERE id=$1', [pointId]))
  } finally {
    await app.close()
    await pool.end()
  }
})
