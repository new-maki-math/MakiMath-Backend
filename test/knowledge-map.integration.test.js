import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { buildApp } from '../src/app.js'
import { pool } from '../src/db/pool.js'
import { decryptPayload } from '../src/lib/crypto.js'

const enabled = process.env.MAKIMATH_INTEGRATION === '1'

test('地图筛选穿过归档分类并返回内部前置关系', { skip: !enabled }, async () => {
  if (!process.env.PGDATABASE || !/^[a-z0-9_]+_test$/i.test(process.env.PGDATABASE)) throw new Error('集成验证必须显式指定名称以测试后缀结尾的独立数据库')
  const app = await buildApp({ logger: false })
  const suffix = randomBytes(6).toString('hex')
  try {
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, process.env.PGDATABASE)
    const admin = (await pool.query("INSERT INTO users(username,password_hash,role) VALUES ($1,'test','super_admin') RETURNING id", ['map-' + suffix])).rows[0]
    const root = (await pool.query("INSERT INTO knowledge_categories(slug,name) VALUES ($1,'根') RETURNING id", ['map-root-' + suffix])).rows[0]
    const archived = (await pool.query("INSERT INTO knowledge_categories(slug,name,parent_id,status) VALUES ($1,'归档',$2,'archived') RETURNING id", ['map-archived-' + suffix,root.id])).rows[0]
    const child = (await pool.query("INSERT INTO knowledge_categories(slug,name,parent_id) VALUES ($1,'子分类',$2) RETURNING id", ['map-child-' + suffix,archived.id])).rows[0]
    const outside = (await pool.query("INSERT INTO knowledge_categories(slug,name) VALUES ($1,'其他') RETURNING id", ['map-outside-' + suffix])).rows[0]
    const points = (await pool.query(
      "INSERT INTO knowledge_points(slug,title,source,created_by,updated_by) VALUES ($1,'前置','正文',$5,$5),($2,'后续','正文',$5,$5),($3,'独立','正文',$5,$5),($4,'外部','正文',$5,$5) RETURNING id",
      ['map-a-' + suffix,'map-b-' + suffix,'map-c-' + suffix,'map-d-' + suffix,admin.id],
    )).rows
    const extra = (await pool.query(
      "INSERT INTO knowledge_points(slug,title,source,status,created_by,updated_by) VALUES ($1,'归档分类下','正文','active',$4,$4),($2,'归档知识点','正文','archived',$4,$4),($3,'无分类','正文','active',$4,$4) RETURNING id",
      ['map-e-' + suffix,'map-f-' + suffix,'map-g-' + suffix,admin.id],
    )).rows
    await pool.query('INSERT INTO knowledge_point_categories(knowledge_point_id,category_id) VALUES ($1,$3),($2,$4)', [extra[0].id,extra[1].id,archived.id,root.id])
    await pool.query(
      'INSERT INTO knowledge_point_categories(knowledge_point_id,category_id) VALUES ($1,$5),($1,$6),($2,$6),($3,$6),($4,$7)',
      [points[0].id,points[1].id,points[2].id,points[3].id,root.id,child.id,outside.id],
    )
    await pool.query('INSERT INTO knowledge_prerequisites(knowledge_point_id,prerequisite_id,created_by) VALUES ($1,$2,$4),($1,$3,$4)', [points[1].id,points[0].id,points[3].id,admin.id])
    await app.ready()
    const response = await app.inject({ method: 'GET', url: `/api/knowledge-map?category_id=${root.id}` })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.headers['cache-control'], 'no-store')
    const result = decryptPayload(response.json())
    assert.deepEqual(result.nodes.map(node => node.id), [...points.slice(0,3).map(point => point.id), extra[0].id])
    assert.deepEqual(result.nodes.find(node => node.id === extra[0].id).category_ids, [])
    assert.equal(result.nodes.some(node => node.id === extra[1].id), false)
    assert.deepEqual(result.nodes[0].category_ids, [root.id,child.id].sort((a,b) => a-b))
    assert.equal(result.categories.some(category => category.id === archived.id), false)
    assert.equal(result.categories.find(category => category.id === child.id).parent_id, archived.id)
    assert.deepEqual(result.edges, [{ source: points[0].id, target: points[1].id }])
    assert.equal(result.stats.node_count, 4)
    assert.equal(result.stats.edge_count, 1)
    const unfiltered = decryptPayload((await app.inject({ method: 'GET', url: '/api/knowledge-map' })).json())
    assert.equal(unfiltered.nodes.some(node => node.id === extra[2].id), true)
    assert.equal(unfiltered.nodes.some(node => node.id === extra[1].id), false)
    assert.equal((await app.inject({ method: 'GET', url: `/api/knowledge-map?category_id=${archived.id}` })).statusCode, 404)
    assert.equal((await app.inject({ method: 'GET', url: '/api/knowledge-map?category_id=0' })).statusCode, 400)
  } finally {
    await app.close()
    await pool.end()
  }
})
