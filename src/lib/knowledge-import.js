import { badRequest, conflict } from './errors.js'

const limits = { bytes: 2 * 1024 * 1024, categories: 150, points: 1000, edges: 6000, associations: 10000 }

// 校验导入条目的字段并保留错误位置
function record(value, fields, location, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('导入条目必须为对象', location)
  for (const key of Object.keys(value)) if (!fields.includes(key)) throw badRequest('导入条目包含不支持的字段', { ...location, property: key })
  for (const key of fields) if (!(key in value) && !optional.includes(key)) throw badRequest('导入条目缺少字段', { ...location, property: key })
}

function textField(value, max, location) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw badRequest('导入文本不合法', location)
}

function slugField(value, location) {
  textField(value, 100, location)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw badRequest('导入标识名称格式不合法', location)
}

function arrayField(value, max, field) {
  if (!Array.isArray(value) || value.length > max) throw badRequest('导入数组不合法或超出限制', { field })
}

// 按依赖关系检查环路并返回稳定的拓扑顺序
function topologicalOrder(ids, edges, field) {
  const indegree = new Map(ids.map(id => [id, 0]))
  const next = new Map(ids.map(id => [id, []]))
  for (const edge of edges) {
    next.get(edge.source).push(edge.target)
    indegree.set(edge.target, indegree.get(edge.target) + 1)
  }
  const queue = ids.filter(id => indegree.get(id) === 0)
  for (let i = 0; i < queue.length; i++) {
    for (const target of next.get(queue[i])) {
      indegree.set(target, indegree.get(target) - 1)
      if (indegree.get(target) === 0) queue.push(target)
    }
  }
  if (queue.length !== ids.length) {
    const index = edges.findIndex(edge => indegree.get(edge.source) > 0 && indegree.get(edge.target) > 0)
    throw badRequest('导入关系不能成环', { field, index: edges[index]?.index ?? index, ids: ids.filter(id => indegree.get(id) > 0) })
  }
  return queue
}

export function validateKnowledgeImport(data) {
  record(data, ['schema_version','categories','points','edges'], { field: 'data' })
  if (Buffer.byteLength(JSON.stringify(data), 'utf8') > limits.bytes) throw badRequest('导入数据超过大小限制', { field: 'data', max_bytes: limits.bytes })
  if (data.schema_version !== 1) throw badRequest('不支持的导入格式版本', { field: 'schema_version' })
  for (const key of ['categories','points','edges']) arrayField(data[key], limits[key], key)
  if (!data.points.length) throw badRequest('导入至少需要一个知识点', { field: 'points' })
  const categoryById = new Map()
  const categorySlugs = new Set()
  for (const [index, category] of data.categories.entries()) {
    const where = { field: 'categories', index }
    record(category, ['id','parent_id','slug','name','pos'], where)
    textField(category.id, 100, { ...where, property: 'id' })
    if (category.parent_id !== null) textField(category.parent_id, 100, { ...where, property: 'parent_id' })
    slugField(category.slug, { ...where, property: 'slug' })
    textField(category.name, 200, { ...where, property: 'name' })
    if (!Number.isSafeInteger(category.pos) || category.pos < 0 || category.pos > 2147483647) throw badRequest('分类顺序不合法', { ...where, property: 'pos' })
    if (categoryById.has(category.id)) throw badRequest('分类局部标识重复', { ...where, id: category.id })
    if (categorySlugs.has(category.slug)) throw conflict('导入分类别名重复', { ...where, slug: category.slug })
    categoryById.set(category.id, { ...category, index })
    categorySlugs.add(category.slug)
  }
  const categoryEdges = []
  for (const category of categoryById.values()) {
    if (category.parent_id === null) continue
    if (!categoryById.has(category.parent_id)) throw badRequest('分类父标识不存在于导入文件', { field: 'categories', index: category.index, property: 'parent_id', id: category.parent_id })
    categoryEdges.push({ source: category.parent_id, target: category.id, index: category.index })
  }
  const categoryOrder = topologicalOrder([...categoryById.keys()], categoryEdges, 'categories')
  const pointById = new Map()
  const pointSlugs = new Set()
  let associations = 0
  for (const [index, point] of data.points.entries()) {
    const where = { field: 'points', index }
    record(point, ['id','slug','title','source','category_ids'], where, ['category_ids'])
    const categoryIds = point.category_ids === undefined ? [] : point.category_ids
    textField(point.id, 100, { ...where, property: 'id' })
    slugField(point.slug, { ...where, property: 'slug' })
    textField(point.title, 200, { ...where, property: 'title' })
    textField(point.source, 200000, { ...where, property: 'source' })
    if (!Array.isArray(categoryIds) || categoryIds.length > 100) throw badRequest('知识点分类数组不合法', { ...where, property: 'category_ids' })
    if (new Set(categoryIds).size !== categoryIds.length) throw badRequest('知识点分类不能重复', { ...where, property: 'category_ids' })
    for (const categoryId of categoryIds) {
      if (typeof categoryId !== 'string' || !categoryById.has(categoryId)) throw badRequest('知识点分类不存在于导入文件', { ...where, property: 'category_ids', id: categoryId })
    }
    associations += Math.max(1, categoryIds.length)
    if (associations > limits.associations) throw badRequest('导入分类关联数量超出限制', { ...where, max: limits.associations })
    if (pointById.has(point.id)) throw badRequest('知识点局部标识重复', { ...where, id: point.id })
    if (pointSlugs.has(point.slug)) throw conflict('导入知识点别名重复', { ...where, slug: point.slug })
    pointById.set(point.id, { ...point, category_ids: categoryIds, index })
    pointSlugs.add(point.slug)
  }
  const edgeKeys = new Set()
  for (const [index, edge] of data.edges.entries()) {
    const where = { field: 'edges', index }
    record(edge, ['source','target'], where)
    for (const property of ['source','target']) {
      if (typeof edge[property] !== 'string' || !pointById.has(edge[property])) throw badRequest('前置关系标识不存在于导入文件', { ...where, property, id: edge[property] })
    }
    const key = JSON.stringify([edge.source, edge.target])
    if (edgeKeys.has(key)) throw badRequest('前置关系不能重复', where)
    edgeKeys.add(key)
  }
  topologicalOrder([...pointById.keys()], data.edges, 'edges')
  return { categoryById, categoryOrder, pointById, edges: data.edges }
}
