-- 本脚本只添加讲义工作草稿唯一约束
-- 重复草稿必须先由管理员人工处理
-- 脚本不会删除或合并已有数据
BEGIN;
LOCK TABLE public.lecture_revisions IN SHARE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.lecture_revisions
     WHERE status = 'draft' AND source_draft_id IS NULL
     GROUP BY lecture_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '存在一份讲义拥有多个工作草稿请先人工处理';
  END IF;
END;
$$;
CREATE UNIQUE INDEX IF NOT EXISTS lecture_revisions_one_working_draft_idx
  ON public.lecture_revisions (lecture_id) WHERE status = 'draft' AND source_draft_id IS NULL;
COMMIT;
