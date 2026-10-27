import { forbidden, notFound, unauthorized } from '../lib/errors.js'

export function requireUser(user) {
  if (!user) throw unauthorized()
  return user
}

export function requireAdmin(user) {
  requireUser(user)
  if (user.role !== 'super_admin') throw forbidden('需要管理员权限')
}

export async function lectureAccess(db, lectureId, user, permission = 'view', lock = false) {
  const { rows } = await db.query(
    `SELECT * FROM lectures WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [lectureId],
  )
  const lecture = rows[0]
  if (!lecture) throw notFound('讲义')
  const collaborator = user ? (await db.query(
    'SELECT permission FROM lecture_collaborators WHERE lecture_id=$1 AND user_id=$2',
    [lectureId, user.id],
  )).rows[0] : null
  const owner = user && (user.role === 'super_admin' || lecture.owner_id === user.id)
  const editable = owner || collaborator?.permission === 'edit'
  const readable = editable || collaborator?.permission === 'view'
  if (permission === 'owner' && !owner) throw forbidden('需要讲义所有者或管理员权限')
  if (permission === 'edit' && !editable) throw forbidden('没有讲义编辑权限')
  if (permission === 'view' && !readable) throw forbidden('没有讲义查看权限')
  return lecture
}
