import { tx } from '../db/pool.js'
import { notFound } from '../lib/errors.js'

// 在一致快照中读取知识地图
export async function knowledgeMap(categoryId = null) {
  return tx(async db => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    if (categoryId !== null) {
      const category = (await db.query("SELECT id FROM knowledge_categories WHERE id=$1 AND status='active'", [categoryId])).rows[0]
      if (!category) throw notFound('知识分类')
    }
    const categories = (await db.query(
      "SELECT id,parent_id,slug,name,pos FROM knowledge_categories WHERE status='active' ORDER BY pos,id",
    )).rows
    const rows = (await db.query(
      `WITH RECURSIVE subtree AS (
         SELECT id FROM knowledge_categories WHERE id=$1
         UNION ALL
         SELECT c.id FROM knowledge_categories c JOIN subtree s ON c.parent_id=s.id
       )
       SELECT p.id,p.slug,p.title,
              COALESCE(array_agg(c.id ORDER BY c.id) FILTER (WHERE c.id IS NOT NULL), '{}'::bigint[]) AS category_ids
         FROM knowledge_points p
         LEFT JOIN knowledge_point_categories pc ON pc.knowledge_point_id=p.id
         LEFT JOIN knowledge_categories c ON c.id=pc.category_id AND c.status='active'
        WHERE p.status='active' AND ($1::bigint IS NULL OR EXISTS (
          SELECT 1 FROM knowledge_point_categories scope
          JOIN subtree s ON s.id=scope.category_id WHERE scope.knowledge_point_id=p.id
        ))
        GROUP BY p.id ORDER BY p.id`, [categoryId],
    )).rows
    const nodes = rows.map(row => ({ ...row, category_ids: row.category_ids.map(value => {
      const categoryId = Number(value)
      if (!Number.isSafeInteger(categoryId)) throw new Error('数据库整数超出安全范围')
      return categoryId
    }) }))
    const nodeIds = nodes.map(node => node.id)
    const edges = nodeIds.length ? (await db.query(
      `SELECT prerequisite_id AS source,knowledge_point_id AS target FROM knowledge_prerequisites
        WHERE prerequisite_id=ANY($1::bigint[]) AND knowledge_point_id=ANY($1::bigint[])
        ORDER BY prerequisite_id,knowledge_point_id`, [nodeIds],
    )).rows : []
    return {
      categories,
      nodes,
      edges,
      stats: { category_count: categories.length, node_count: nodes.length, edge_count: edges.length },
      filter: { category_id: categoryId, include_descendants: true },
    }
  })
}
