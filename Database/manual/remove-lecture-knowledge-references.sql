-- 本脚本仅删除旧版讲义引用关系表
-- 请先确认已部署从小节源码解析引用的新后端
-- 本脚本不会删除讲义源码或知识点
BEGIN;
DROP TABLE IF EXISTS public.lecture_knowledge_references;
COMMIT;
