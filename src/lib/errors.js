// 业务错误包含响应状态
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    if (details !== undefined) this.details = details
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, details)
export const unauthorized = (msg = '请先登录') => new HttpError(401, msg)
export const forbidden = (msg = '无权访问该资源') => new HttpError(403, msg)
export const notFound = (what = '资源') => new HttpError(404, `${what}不存在`)
export const conflict = (msg, details) => new HttpError(409, msg, details)

// 数据库错误映射到响应状态
const PG_STATUS = {
  '23001': 409,
  '23502': 400,
  '23503': 409,
  '23505': 409,
  '23514': 400,
  '22P02': 400,
  '40001': 409,
  '40P01': 409,
  'P0001': 409,
}

const PG_HINT = {
  '23001': '该记录仍被下级数据引用，不能删除',
  '23502': '必填字段缺失',
  '23503': '关联记录不存在或仍被引用',
  '23505': '数据与现有记录冲突',
  '23514': '违反检查约束',
  '22P02': '参数格式不对，id 需要是数字',
  '40001': '操作发生并发冲突请重试',
  '40P01': '操作发生并发冲突请重试',
  'P0001': '操作违反业务约束',
}

// 统一返回业务错误
export function errorHandler(err, req, reply) {
  if (err instanceof HttpError) {
    const body = { error: err.message }
    if (err.details !== undefined) body.details = err.details
    return reply.code(err.status).send(body)
  }

  if (err.validation) {
    return reply.code(400).send({ error: '请求参数不合法', details: err.validation })
  }

  // 请求格式错误保留原有状态
  const fastifyStatus = Number(err.statusCode)
  if (Number.isInteger(fastifyStatus) && fastifyStatus >= 400 && fastifyStatus < 500) {
    return reply.code(fastifyStatus).send({ error: err.message })
  }

  const status = PG_STATUS[err.code]
  if (status) {
    return reply.code(status).send({
      error: err.code === 'P0001' ? err.message : (PG_HINT[err.code] ?? '数据库约束冲突'),
    })
  }

  req.log.error(err)
  return reply.code(500).send({ error: '服务器内部错误' })
}
