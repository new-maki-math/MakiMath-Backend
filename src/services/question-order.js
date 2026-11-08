import { tx } from '../db/pool.js'
import { conflict, notFound } from '../lib/errors.js'
import { requireAdmin } from './access.js'

const stamp = `to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at`
const fields = {
  question_categories: `id,parent_id,slug,name,pos,created_at,${stamp}`,
  question_entries: `id,category_id,question_id,source_number,pos,created_at,${stamp}`,
}

async function orderedRows(db, table, parentColumn, parentId) {
  return (await db.query(`SELECT id,pos,${stamp} FROM ${table} WHERE ${parentColumn} IS NOT DISTINCT FROM $1 ORDER BY pos,id FOR UPDATE`, [parentId])).rows
}

async function setOrder(db, table, rows) {
  const ids = rows.map(row => row.id)
  if (ids.length > 2147483647) throw conflict('同级项目数量超出排序范围')
  if (ids.length) await db.query(`UPDATE ${table} t SET pos=(v.ordinality-1)::integer
    FROM unnest($1::bigint[]) WITH ORDINALITY AS v(id,ordinality)
    WHERE t.id=v.id AND t.pos IS DISTINCT FROM (v.ordinality-1)::integer`, [ids])
}

export async function nextPosition(db, table, parentColumn, parentId) {
  const rows = await orderedRows(db,table,parentColumn,parentId)
  if (!rows.length) return 0
  if (rows.at(-1).pos < 2147483647) return rows.at(-1).pos + 1
  if (rows.length >= 2147483647) throw conflict('同级项目数量超出排序范围')
  await setOrder(db,table,rows)
  return rows.length
}

async function move(user, table, parentColumn, itemId, data) {
  requireAdmin(user)
  return tx(async db => {
    const lock = await db.query("UPDATE content_graph_locks SET generation=generation+1 WHERE scope='question_categories' RETURNING generation")
    if (!lock.rowCount) throw conflict('题库关系锁不存在')
    const row = (await db.query(`SELECT ${fields[table]} FROM ${table} WHERE id=$1 FOR UPDATE`, [itemId])).rows[0]
    if (!row) throw notFound(table === 'question_categories' ? '题目来源目录' : '题目来源')
    if (row.updated_at !== data.updated_at) throw conflict('当前项目已修改请重新加载')
    const rows = await orderedRows(db,table,parentColumn,row[parentColumn])
    const index = rows.findIndex(item => item.id === row.id)
    const target = index + (data.direction === 'up' ? -1 : 1)
    const neighbor = rows[target]
    if (!neighbor || neighbor.id !== data.neighbor_id || neighbor.updated_at !== data.neighbor_updated_at) throw conflict('相邻项目已变化请重新加载')
    ;[rows[index],rows[target]] = [rows[target],rows[index]]
    await setOrder(db,table,rows)
    return (await db.query(`SELECT ${fields[table]} FROM ${table} WHERE id=$1`, [itemId])).rows[0]
  })
}

export async function moveCategory(user, categoryId, data) {
  return { category: await move(user,'question_categories','parent_id',categoryId,data) }
}

export async function moveEntry(user, entryId, data) {
  return { entry: await move(user,'question_entries','category_id',entryId,data) }
}
