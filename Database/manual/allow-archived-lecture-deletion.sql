-- 适用于当前讲义版本模型的 PostgreSQL 数据库
-- 手工执行前请备份并确认连接的数据库
-- 本脚本仅调整约束和触发函数不会删除数据
BEGIN;

ALTER TABLE lecture_revisions
  DROP CONSTRAINT lecture_revisions_base_fk,
  DROP CONSTRAINT lecture_revisions_source_draft_fk;

ALTER TABLE lecture_revisions
  ADD CONSTRAINT lecture_revisions_base_fk FOREIGN KEY (lecture_id, based_on_id)
    REFERENCES lecture_revisions(lecture_id, id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT lecture_revisions_source_draft_fk FOREIGN KEY (lecture_id, source_draft_id)
    REFERENCES lecture_revisions(lecture_id, id) DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION is_archived_lecture_deletion(target_id bigint) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM lectures WHERE id = target_id AND publication_status = 'archived'
      AND id::text = current_setting('maki.lecture_delete_id', true)
  );
$$;

CREATE OR REPLACE FUNCTION guard_content_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  review_exists boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' AND NOT is_archived_lecture_deletion(OLD.lecture_id) THEN
      RAISE EXCEPTION '已提交版本不可删除';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.submitted_at IS NOT NULL OR NEW.reviewed_at IS NOT NULL THEN
      RAISE EXCEPTION '新版本必须从草稿开始';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.revision_no IS DISTINCT FROM OLD.revision_no
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION '版本身份与来源不可修改';
  END IF;
  IF NEW.based_on_id IS DISTINCT FROM OLD.based_on_id THEN
    IF TG_TABLE_NAME <> 'lecture_revisions' OR OLD.status <> 'draft' OR NEW.status <> 'draft' THEN
      RAISE EXCEPTION '版本来源不可修改';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM lecture_revisions r JOIN lectures l ON l.public_revision_id = r.id
      WHERE r.id = NEW.based_on_id AND r.source_draft_id = OLD.id
        AND r.status = 'approved' AND l.id = OLD.lecture_id
    ) THEN
      RAISE EXCEPTION '草稿只能跟进由自身发布的版本';
    END IF;
  END IF;
  IF NEW.lecture_id IS DISTINCT FROM OLD.lecture_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.source_draft_id IS DISTINCT FROM OLD.source_draft_id THEN
    RAISE EXCEPTION '讲义版本归属与创建人不可修改';
  END IF;
  IF OLD.status = 'draft' THEN
    IF NEW.status = 'pending' THEN
      IF btrim(NEW.title) = '' THEN
        RAISE EXCEPTION '提交审核前必须填写标题';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM lecture_sections WHERE lecture_revision_id = NEW.id AND btrim(source) <> '') THEN
        RAISE EXCEPTION '提交审核前必须编排讲义内容';
      END IF;
      NEW.submitted_at := clock_timestamp();
      NEW.reviewed_at := NULL;
    ELSIF NEW.status <> 'draft' THEN
      RAISE EXCEPTION '草稿只能提交为待审核版本';
    ELSIF NEW.submitted_at IS NOT NULL OR NEW.reviewed_at IS NOT NULL THEN
      RAISE EXCEPTION '草稿不能设置审核时间';
    END IF;
  ELSIF OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected') THEN
    IF (to_jsonb(NEW) - ARRAY['status', 'reviewed_at', 'updated_at'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'reviewed_at', 'updated_at']) THEN
      RAISE EXCEPTION '审核不能修改提交版本的内容';
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM lecture_reviews WHERE lecture_revision_id = OLD.id AND decision = NEW.status
    ) INTO review_exists;
    IF NOT review_exists THEN
      RAISE EXCEPTION '必须通过审核记录更新版本状态';
    END IF;
    NEW.reviewed_at := clock_timestamp();
  ELSE
    RAISE EXCEPTION '已提交版本不可修改请创建新的草稿';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_lecture_content() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  revision_id bigint;
  revision_status text;
  owner_lecture_id bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    revision_id := OLD.lecture_revision_id;
  ELSE
    revision_id := NEW.lecture_revision_id;
    IF TG_OP = 'UPDATE' THEN
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.lecture_revision_id IS DISTINCT FROM OLD.lecture_revision_id
         OR NEW.occurrence_id IS DISTINCT FROM OLD.occurrence_id
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION '内容实例身份与版本归属不可修改';
      END IF;
    END IF;
  END IF;
  SELECT status, lecture_id INTO revision_status, owner_lecture_id FROM lecture_revisions WHERE id = revision_id FOR UPDATE;
  IF TG_OP = 'DELETE' AND is_archived_lecture_deletion(owner_lecture_id) THEN
    RETURN OLD;
  END IF;
  IF revision_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION '只能修改草稿版本的目录与内容';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_content_review() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  revision_status text;
  owner_lecture_id bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT lecture_id INTO owner_lecture_id FROM lecture_revisions WHERE id = OLD.lecture_revision_id;
    IF is_archived_lecture_deletion(owner_lecture_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION '审核记录不可修改或删除';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.reviewer_id AND role = 'super_admin' AND status = 'active') THEN
    RAISE EXCEPTION '审核人必须为有效超级管理员';
  END IF;
  SELECT status INTO revision_status FROM lecture_revisions WHERE id = NEW.lecture_revision_id FOR UPDATE;
  IF revision_status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION '只能审核待审核版本';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

COMMIT;
