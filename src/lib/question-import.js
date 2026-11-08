import { badRequest, conflict } from './errors.js'
import { IMPORT_DATA_MAX } from './import-limits.js'

function record(value, fields, required, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('导入条目必须为对象', where)
  for (const key of Object.keys(value)) if (!fields.includes(key)) throw badRequest('导入条目包含不支持的字段', { ...where, property: key })
  for (const key of required) if (value[key] === undefined) throw badRequest('导入条目缺少字段', { ...where, property: key })
}

function text(value, max, where, empty = false) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (!empty && !value.trim())) throw badRequest('导入文本不合法', where)
}

function slug(value, where) {
  text(value,100,where)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw badRequest('导入标识名称格式不合法', where)
}

function position(value, where) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) throw badRequest('导入顺序不合法', where)
}

export function validateQuestionImport(data) {
  record(data,['schema_version','categories','questions'],['schema_version','categories','questions'],{ field: 'data' })
  if (Buffer.byteLength(JSON.stringify(data),'utf8') > IMPORT_DATA_MAX) throw badRequest('导入数据超过大小限制', { field: 'data', max_bytes: IMPORT_DATA_MAX })
  if (data.schema_version !== 1) throw badRequest('不支持的导入格式版本', { field: 'schema_version' })
  if (!Array.isArray(data.categories)) throw badRequest('来源目录格式不合法', { field: 'categories' })
  if (!Array.isArray(data.questions) || !data.questions.length) throw badRequest('题目数量不合法', { field: 'questions' })
  const categories = new Map()
  const categorySlugs = new Set()
  for (const [index, item] of data.categories.entries()) {
    const where = { field: 'categories', index }
    record(item,['id','parent_id','slug','name','pos'],['id','parent_id','slug','name'],where)
    text(item.id,100,{ ...where, property: 'id' })
    if (item.parent_id !== null) text(item.parent_id,100,{ ...where, property: 'parent_id' })
    slug(item.slug,{ ...where, property: 'slug' })
    text(item.name,200,{ ...where, property: 'name' })
    position(item.pos === undefined ? 0 : item.pos,{ ...where, property: 'pos' })
    if (categories.has(item.id)) throw badRequest('目录局部标识重复', { ...where, id: item.id })
    if (categorySlugs.has(item.slug)) throw conflict('导入目录标识重复', { ...where, slug: item.slug })
    categories.set(item.id,{ ...item, name: item.name.trim(), pos: item.pos === undefined ? 0 : item.pos, index })
    categorySlugs.add(item.slug)
  }
  const categoryOrder = []
  const children = new Map([...categories.keys()].map(key => [key,[]]))
  const queue = []
  for (const item of categories.values()) {
    if (item.parent_id === null) queue.push(item.id)
    else {
      if (!categories.has(item.parent_id)) throw badRequest('目录父标识不存在于导入文件', { field: 'categories', index: item.index, id: item.parent_id })
      children.get(item.parent_id).push(item.id)
    }
  }
  for (let index = 0; index < queue.length; index++) {
    const key = queue[index]
    categoryOrder.push(key)
    for (const child of children.get(key)) queue.push(child)
  }
  if (categoryOrder.length !== categories.size) throw badRequest('目录父子关系不能成环', { field: 'categories' })
  const questions = []
  const questionSlugs = new Set()
  let entryCount = 0
  for (const [index, item] of data.questions.entries()) {
    const where = { field: 'questions', index }
    const fields = ['slug','difficulty','stem_source','focus_source','solution_source','conclusion_source','pitfalls_source','knowledge_slugs','sources']
    record(item,fields,['slug','difficulty','stem_source','sources'],where)
    slug(item.slug,{ ...where, property: 'slug' })
    if (questionSlugs.has(item.slug)) throw conflict('导入题目标识重复', { ...where, slug: item.slug })
    questionSlugs.add(item.slug)
    if (!Number.isSafeInteger(item.difficulty) || item.difficulty < 1 || item.difficulty > 5) throw badRequest('题目难度不合法', where)
    text(item.stem_source,IMPORT_DATA_MAX,{ ...where, property: 'stem_source' })
    for (const key of ['focus_source','solution_source','conclusion_source','pitfalls_source']) text(item[key] === undefined ? '' : item[key],IMPORT_DATA_MAX,{ ...where, property: key },true)
    const knowledge = item.knowledge_slugs === undefined ? [] : item.knowledge_slugs
    if (!Array.isArray(knowledge)) throw badRequest('知识点关联格式不合法', where)
    for (const value of knowledge) slug(value,{ ...where, property: 'knowledge_slugs' })
    if (new Set(knowledge).size !== knowledge.length) throw badRequest('知识点标识不能重复', where)
    if (!Array.isArray(item.sources) || !item.sources.length) throw badRequest('题目至少需要一个来源', where)
    const seen = new Set()
    const sources = item.sources.map((source, sourceIndex) => {
      const location = { ...where, property: 'sources', source_index: sourceIndex }
      record(source,['category_id','source_number','pos'],['category_id'],location)
      if (source.category_id !== null && !categories.has(source.category_id)) throw badRequest('来源目录标识不存在于导入文件', location)
      if (seen.has(source.category_id)) throw badRequest('同一目录不能重复关联题目', location)
      seen.add(source.category_id)
      text(source.source_number === undefined ? '' : source.source_number,200,{ ...location, property: 'source_number' },true)
      position(source.pos === undefined ? 0 : source.pos,{ ...location, property: 'pos' })
      entryCount++
      return { category_id: source.category_id, source_number: source.source_number === undefined ? '' : source.source_number, pos: source.pos === undefined ? 0 : source.pos }
    })
    questions.push({ slug: item.slug, difficulty: item.difficulty, stem_source: item.stem_source, focus_source: item.focus_source === undefined ? '' : item.focus_source, solution_source: item.solution_source === undefined ? '' : item.solution_source, conclusion_source: item.conclusion_source === undefined ? '' : item.conclusion_source, pitfalls_source: item.pitfalls_source === undefined ? '' : item.pitfalls_source, knowledge_slugs: knowledge, sources, index })
  }
  return { categories, categoryOrder, questions, entryCount }
}
