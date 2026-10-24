// 带 HTTP 状态码的错误
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

// PostgreSQL 错误码到 HTTP 状态码的映射
const PG_STATUS = {
  '23001': 409, // 删除被 RESTRICT 挡住
  '23502': 400, // 非空约束
  '23503': 409, // 外键引用了不存在的记录
  '23505': 409, // 唯一约束
  '23514': 400, // 检查约束
  '22P02': 400, // 参数格式错误
}

const PG_HINT = {
  '23001': '该记录仍被下级数据引用，不能删除',
  '23502': '必填字段缺失',
  '23503': '引用的记录不存在',
  '23505': 'slug 或 pos 已被占用，请换一个试试',
  '23514': '违反检查约束',
  '22P02': '参数格式不对，id 需要是数字',
}

// 统一错误处理，输出 JSON
export function errorHandler(err, req, reply) {
  if (err instanceof HttpError) {
    const body = { error: err.message }
    if (err.details !== undefined) body.details = err.details
    return reply.code(err.status).send(body)
  }

  if (err.validation) {
    return reply.code(400).send({ error: '请求参数不合法', details: err.validation })
  }

  // Fastify 自身的请求错误（空 JSON 体、JSON 语法错误、body 过大等）自带 statusCode，
  // 按 4xx 原样返回，否则会被下面的兜底吞成 500，把真正的原因藏掉
  const fastifyStatus = Number(err.statusCode)
  if (Number.isInteger(fastifyStatus) && fastifyStatus >= 400 && fastifyStatus < 500) {
    return reply.code(fastifyStatus).send({ error: err.message })
  }

  const status = PG_STATUS[err.code]
  if (status) {
    return reply.code(status).send({
      error: PG_HINT[err.code] ?? '数据库约束冲突',
      detail: err.detail ?? err.message,
    })
  }

  console.error('[errorHandler]', err)
  req.log.error(err)
  return reply.code(500).send({ error: '服务器内部错误' })
}
