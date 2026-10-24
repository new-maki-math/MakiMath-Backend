import { badRequest } from './errors.js'

// 允许排序的表白名单，表名与父列名不接受外部输入
const KINDS = {
  categories: { table: 'categories', parent: null },
  courses: { table: 'courses', parent: 'category_id' },
  chapters: { table: 'chapters', parent: 'course_id' },
  sections: { table: 'sections', parent: 'chapter_id' },
}

export function kindOf(name) {
  const k = KINDS[name]
  if (!k) throw badRequest(`未知的排序对象：${name}`)
  return k
}

// 按数组顺序把 pos 重写成 0,1,2...，必须在 tx() 内调用
export async function reorder(client, name, parentId, ids) {
  const k = kindOf(name)
  if (!Array.isArray(ids) || ids.length === 0) throw badRequest('ids 必须是非空数组')

  for (const [index, id] of ids.entries()) {
    const sql = k.parent
      ? `UPDATE ${k.table} SET pos = $1, updated_at = now() WHERE id = $2 AND ${k.parent} = $3`
      : `UPDATE ${k.table} SET pos = $1, updated_at = now() WHERE id = $2`
    const params = k.parent ? [index, id, parentId] : [index, id]
    const res = await client.query(sql, params)
    if (res.rowCount === 0) {
      throw badRequest(`id=${id} 不在指定的父级下，无法排序`)
    }
  }
}
