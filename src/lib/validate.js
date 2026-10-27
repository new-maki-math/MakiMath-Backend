import { badRequest } from './errors.js'

export function body(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('请求体必须为对象')
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw badRequest('存在不支持的字段')
  }
  for (const key of required) {
    if (value[key] === undefined) throw badRequest(`缺少字段 ${key}`)
  }
  return value
}

export function id(value) {
  if (!/^[1-9][0-9]*$/.test(String(value))) throw badRequest('标识必须为正整数')
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw badRequest('标识超出范围')
  return number
}

export function integer(value, min = 0, max = 2147483647) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw badRequest('整数参数不合法')
  return value
}

export function string(value, max = 200, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) {
    throw badRequest('文本参数不合法')
  }
  return value
}

export function slug(value) {
  string(value, 100)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw badRequest('标识名称格式不合法')
  return value
}

export function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('参数必须为对象')
  return value
}

export function animation(value) {
  object(value)
  const pending = [value]
  while (pending.length) {
    const current = pending.pop()
    for (const [key, child] of Object.entries(current)) {
      if (key.replace(/[_-]/g, '').toLowerCase() === 'scenescode') {
        throw badRequest('动画配置不允许包含可执行场景代码')
      }
      if (child && typeof child === 'object') pending.push(child)
    }
  }
  return value
}

export function list(value, max = 500) {
  if (!Array.isArray(value) || value.length > max) throw badRequest('数组参数不合法')
  return value
}

export function choice(value, allowed) {
  if (!allowed.includes(value)) throw badRequest('参数取值不合法')
  return value
}
