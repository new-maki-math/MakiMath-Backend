-- 本脚本仅同步知识点状态及状态约束
-- 请先备份并确认目标数据库
-- 被转换的知识点更新时间会由现有触发器更新
-- 再次执行不会改变已归档知识点
BEGIN;
LOCK TABLE public.knowledge_points IN ACCESS EXCLUSIVE MODE;
UPDATE public.knowledge_points SET status = 'archived' WHERE status = 'disabled';
ALTER TABLE public.knowledge_points DROP CONSTRAINT IF EXISTS knowledge_points_status_check;
ALTER TABLE public.knowledge_points ADD CONSTRAINT knowledge_points_status_check CHECK (status IN ('active', 'archived'));
COMMIT;
