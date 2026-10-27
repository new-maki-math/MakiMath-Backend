-- 本脚本用于初始化空数据库
-- 知识点与讲义分别使用独立身份和版本
-- 讲义内容块固定引用已经审核的知识点版本
-- 提交审核的内容版本不可继续编辑
-- 个人讲义与批注及掌握状态由浏览器本地保存
-- 本脚本不包含旧数据库的迁移与兼容处理

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 用户表保存管理员与讲师账号
CREATE TABLE users (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- 用户标识
  username      text        NOT NULL UNIQUE CHECK (btrim(username) <> ''), -- 登录名称
  password_hash text        NOT NULL CHECK (btrim(password_hash) <> ''), -- 密码哈希
  display_name  text        NOT NULL DEFAULT '', -- 展示名称
  role          text        NOT NULL DEFAULT 'editor' CHECK (role IN ('super_admin', 'editor')), -- 用户角色
  status        text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')), -- 用户状态
  invitation_id bigint, -- 注册邀请码标识
  last_login_at timestamptz, -- 最近登录时间
  created_at    timestamptz NOT NULL DEFAULT now(), -- 创建时间
  updated_at    timestamptz NOT NULL DEFAULT now() -- 更新时间
);

CREATE INDEX users_role_status_idx ON users (role, status);

-- 邀请码控制账号注册和角色
CREATE TABLE invitations (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- 邀请码标识
  code       text        NOT NULL UNIQUE CHECK (btrim(code) <> ''), -- 邀请码内容
  role       text        NOT NULL DEFAULT 'editor' CHECK (role IN ('super_admin', 'editor')), -- 注册授予的角色
  created_by bigint      REFERENCES users(id) ON DELETE SET NULL, -- 创建人标识
  max_uses   integer     NOT NULL DEFAULT 1 CHECK (max_uses > 0), -- 使用次数上限
  used_count integer     NOT NULL DEFAULT 0 CHECK (used_count >= 0 AND used_count <= max_uses), -- 已使用次数
  status     text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'exhausted')), -- 邀请码状态
  note       text        NOT NULL DEFAULT '', -- 备注
  expires_at timestamptz, -- 过期时间
  created_at timestamptz NOT NULL DEFAULT now(), -- 创建时间
  updated_at timestamptz NOT NULL DEFAULT now() -- 更新时间
);

ALTER TABLE users ADD CONSTRAINT users_invitation_fk
  FOREIGN KEY (invitation_id) REFERENCES invitations(id) ON DELETE SET NULL;
CREATE INDEX users_invitation_idx ON users (invitation_id);
CREATE INDEX invitations_status_idx ON invitations (status);

-- 会话表保存刷新令牌哈希
CREATE TABLE user_sessions (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- 会话标识
  user_id    bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- 用户标识
  token_hash text        NOT NULL UNIQUE, -- 刷新令牌哈希
  user_agent text        NOT NULL DEFAULT '', -- 客户端信息
  ip_address inet, -- 客户端地址
  expires_at timestamptz NOT NULL, -- 过期时间
  created_at timestamptz NOT NULL DEFAULT now() -- 创建时间
);

CREATE INDEX user_sessions_user_idx ON user_sessions (user_id);
CREATE INDEX user_sessions_expires_idx ON user_sessions (expires_at);

-- 操作审计不替代内容版本和审核记录
CREATE TABLE audit_logs (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- 审计记录标识
  user_id     bigint      REFERENCES users(id) ON DELETE SET NULL, -- 操作人标识
  username    text        NOT NULL DEFAULT '', -- 操作人名称快照
  user_role   text        NOT NULL DEFAULT '', -- 操作人角色快照
  method      text        NOT NULL, -- 请求方法
  path        text        NOT NULL, -- 请求路径
  status_code integer     NOT NULL CHECK (status_code BETWEEN 100 AND 599), -- 响应状态码
  duration_ms integer     NOT NULL DEFAULT 0 CHECK (duration_ms >= 0), -- 请求耗时毫秒
  ip_address  inet, -- 客户端地址
  user_agent  text        NOT NULL DEFAULT '', -- 客户端信息
  payload     jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'), -- 脱敏后的操作参数
  created_at  timestamptz NOT NULL DEFAULT now() -- 创建时间
);

CREATE INDEX audit_logs_user_idx ON audit_logs (user_id);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_method_path_idx ON audit_logs (method, path);

-- 知识分类支持多级父子关系
CREATE TABLE knowledge_categories (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- 分类标识
  parent_id  bigint      REFERENCES knowledge_categories(id) ON DELETE RESTRICT, -- 父分类标识
  slug       text        NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'), -- 分类别名
  name       text        NOT NULL CHECK (btrim(name) <> ''), -- 分类名称
  descr      text        NOT NULL DEFAULT '', -- 分类说明
  pos        integer     NOT NULL DEFAULT 0 CHECK (pos >= 0), -- 同级分类顺序
  status     text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')), -- 分类状态
  created_at timestamptz NOT NULL DEFAULT now(), -- 创建时间
  updated_at timestamptz NOT NULL DEFAULT now(), -- 更新时间
  CONSTRAINT knowledge_categories_no_self CHECK (parent_id IS DISTINCT FROM id)
);

CREATE INDEX knowledge_categories_parent_idx ON knowledge_categories (parent_id, pos, id);

-- 讲义分类与知识分类独立维护
CREATE TABLE lecture_categories (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- 分类标识
  parent_id  bigint      REFERENCES lecture_categories(id) ON DELETE RESTRICT, -- 父分类标识
  slug       text        NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'), -- 分类别名
  name       text        NOT NULL CHECK (btrim(name) <> ''), -- 分类名称
  descr      text        NOT NULL DEFAULT '', -- 分类说明
  pos        integer     NOT NULL DEFAULT 0 CHECK (pos >= 0), -- 同级分类顺序
  status     text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')), -- 分类状态
  created_at timestamptz NOT NULL DEFAULT now(), -- 创建时间
  updated_at timestamptz NOT NULL DEFAULT now(), -- 更新时间
  CONSTRAINT lecture_categories_no_self CHECK (parent_id IS DISTINCT FROM id)
);

CREATE INDEX lecture_categories_parent_idx ON lecture_categories (parent_id, pos, id);

-- 知识点标识独立于标题和正文
CREATE TABLE knowledge_points (
  id                 bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- 知识点永久标识
  slug               text        NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'), -- 知识点别名
  status             text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'archived')), -- 知识点生命周期状态
  public_revision_id bigint, -- 当前公开版本标识
  created_by         bigint      REFERENCES users(id) ON DELETE RESTRICT, -- 知识点创建人
  created_at         timestamptz NOT NULL DEFAULT now(), -- 创建时间
  updated_at         timestamptz NOT NULL DEFAULT now() -- 更新时间
);

CREATE INDEX knowledge_points_status_idx ON knowledge_points (status);
CREATE INDEX knowledge_points_created_by_idx ON knowledge_points (created_by);

-- 一个知识点可以属于多个知识分类
CREATE TABLE knowledge_point_categories (
  knowledge_point_id bigint      NOT NULL REFERENCES knowledge_points(id) ON DELETE RESTRICT, -- 知识点永久标识
  category_id        bigint      NOT NULL REFERENCES knowledge_categories(id) ON DELETE RESTRICT, -- 知识分类标识
  created_at         timestamptz NOT NULL DEFAULT now(), -- 关联创建时间
  PRIMARY KEY (knowledge_point_id, category_id)
);

CREATE INDEX knowledge_point_categories_category_idx ON knowledge_point_categories (category_id, knowledge_point_id);

-- 公共正文与动画保存为知识点版本
CREATE TABLE knowledge_revisions (
  id                 bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- 知识点版本标识
  knowledge_point_id bigint      NOT NULL REFERENCES knowledge_points(id) ON DELETE RESTRICT, -- 所属知识点标识
  revision_no        integer     NOT NULL CHECK (revision_no > 0), -- 知识点内版本序号
  based_on_id        bigint, -- 所依据的同一知识点版本
  title              text        NOT NULL DEFAULT '', -- 本版标题
  summary            text        NOT NULL DEFAULT '', -- 本版摘要
  source             text        NOT NULL DEFAULT '', -- 本版公共正文源码
  animation          jsonb       CHECK (jsonb_typeof(animation) = 'object' AND NOT (animation ? 'scenes_code')), -- 本版动画配置
  metadata           jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'), -- 本版渲染配置
  change_note        text        NOT NULL DEFAULT '', -- 修改说明
  contributor_id     bigint      NOT NULL REFERENCES users(id) ON DELETE RESTRICT, -- 本版贡献者标识
  edit_version       integer     NOT NULL DEFAULT 1 CHECK (edit_version > 0), -- 草稿并发版本号
  status             text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'approved', 'rejected')), -- 版本审核状态
  submitted_at       timestamptz, -- 提交审核时间
  reviewed_at        timestamptz, -- 完成审核时间
  created_at         timestamptz NOT NULL DEFAULT now(), -- 创建时间
  updated_at         timestamptz NOT NULL DEFAULT now(), -- 更新时间
  UNIQUE (knowledge_point_id, revision_no),
  UNIQUE (knowledge_point_id, id),
  CONSTRAINT knowledge_revisions_base_fk FOREIGN KEY (knowledge_point_id, based_on_id)
    REFERENCES knowledge_revisions(knowledge_point_id, id) ON DELETE RESTRICT,
  CONSTRAINT knowledge_revisions_no_self_base CHECK (based_on_id IS DISTINCT FROM id),
  CONSTRAINT knowledge_revisions_times_check CHECK (
    (status = 'draft' AND submitted_at IS NULL AND reviewed_at IS NULL)
    OR (status = 'pending' AND submitted_at IS NOT NULL AND reviewed_at IS NULL)
    OR (status IN ('approved', 'rejected') AND submitted_at IS NOT NULL AND reviewed_at IS NOT NULL AND reviewed_at >= submitted_at)
  )
);

ALTER TABLE knowledge_points ADD CONSTRAINT knowledge_points_public_revision_fk
  FOREIGN KEY (id, public_revision_id)
  REFERENCES knowledge_revisions(knowledge_point_id, id) ON DELETE RESTRICT;
CREATE INDEX knowledge_revisions_contributor_idx ON knowledge_revisions (contributor_id, created_at DESC);
CREATE INDEX knowledge_revisions_review_idx ON knowledge_revisions (status, submitted_at);
CREATE INDEX knowledge_revisions_title_trgm_idx ON knowledge_revisions USING gin (title gin_trgm_ops);
CREATE INDEX knowledge_revisions_search_idx ON knowledge_revisions USING gin (
  (setweight(to_tsvector('simple', title), 'A') || setweight(to_tsvector('simple', source), 'B'))
);

-- 审核记录绑定一个确定的知识点版本
CREATE TABLE knowledge_reviews (
  id                    bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- 审核记录标识
  knowledge_revision_id bigint      NOT NULL UNIQUE REFERENCES knowledge_revisions(id) ON DELETE RESTRICT, -- 被审核的版本标识
  reviewer_id           bigint      NOT NULL REFERENCES users(id) ON DELETE RESTRICT, -- 审核人标识
  decision              text        NOT NULL CHECK (decision IN ('approved', 'rejected')), -- 审核结论
  comment               text        NOT NULL DEFAULT '', -- 审核意见
  created_at            timestamptz NOT NULL DEFAULT now() -- 审核时间
);

CREATE INDEX knowledge_reviews_reviewer_idx ON knowledge_reviews (reviewer_id, created_at DESC);

-- 知识点前置关系独立于讲义编排
CREATE TABLE knowledge_prerequisites (
  knowledge_point_id bigint      NOT NULL REFERENCES knowledge_points(id) ON DELETE RESTRICT, -- 当前知识点标识
  prerequisite_id    bigint      NOT NULL REFERENCES knowledge_points(id) ON DELETE RESTRICT, -- 前置知识点标识
  created_by         bigint      NOT NULL REFERENCES users(id) ON DELETE RESTRICT, -- 关系创建人
  created_at         timestamptz NOT NULL DEFAULT now(), -- 创建时间
  PRIMARY KEY (knowledge_point_id, prerequisite_id),
  CONSTRAINT knowledge_prerequisites_no_self CHECK (knowledge_point_id <> prerequisite_id)
);

CREATE INDEX knowledge_prerequisites_reverse_idx ON knowledge_prerequisites (prerequisite_id, knowledge_point_id);

-- 讲义身份包含独立的发布状态与推荐标记
CREATE TABLE lectures (
  id                 bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- 讲义永久标识
  slug               text        NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'), -- 讲义别名
  owner_id           bigint      NOT NULL REFERENCES users(id) ON DELETE RESTRICT, -- 讲义所有者
  publication_status text        NOT NULL DEFAULT 'unpublished' CHECK (publication_status IN ('unpublished', 'published', 'withdrawn', 'archived')), -- 上下架状态
  public_revision_id bigint, -- 当前公开版本标识
  is_recommended     boolean     NOT NULL DEFAULT false, -- 推荐展示标记
  created_at         timestamptz NOT NULL DEFAULT now(), -- 创建时间
  updated_at         timestamptz NOT NULL DEFAULT now(), -- 更新时间
  CONSTRAINT lectures_publication_check CHECK (publication_status <> 'published' OR public_revision_id IS NOT NULL),
  CONSTRAINT lectures_recommendation_check CHECK (NOT is_recommended OR publication_status = 'published')
);

CREATE INDEX lectures_owner_idx ON lectures (owner_id);
CREATE INDEX lectures_publication_idx ON lectures (publication_status, is_recommended, updated_at DESC);

-- 协作者权限独立于讲义所有权
CREATE TABLE lecture_collaborators (
  lecture_id bigint      NOT NULL REFERENCES lectures(id) ON DELETE CASCADE, -- 讲义标识
  user_id    bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- 协作者标识
  permission text        NOT NULL DEFAULT 'edit' CHECK (permission IN ('view', 'edit')), -- 查看或编辑权限
  invited_by bigint      REFERENCES users(id) ON DELETE SET NULL, -- 授权人标识
  created_at timestamptz NOT NULL DEFAULT now(), -- 授权时间
  PRIMARY KEY (lecture_id, user_id)
);

CREATE INDEX lecture_collaborators_user_idx ON lecture_collaborators (user_id, lecture_id);

-- 讲义版本保存完整快照的元数据
CREATE TABLE lecture_revisions (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- 讲义版本标识
  lecture_id    bigint      NOT NULL REFERENCES lectures(id) ON DELETE RESTRICT, -- 所属讲义标识
  revision_no   integer     NOT NULL CHECK (revision_no > 0), -- 讲义内版本序号
  based_on_id   bigint, -- 所依据的同一讲义版本
  category_id   bigint      REFERENCES lecture_categories(id) ON DELETE RESTRICT, -- 本版讲义分类
  title         text        NOT NULL DEFAULT '', -- 本版标题
  subtitle      text        NOT NULL DEFAULT '', -- 本版副标题
  descr         text        NOT NULL DEFAULT '', -- 本版简介
  typst_version text        NOT NULL DEFAULT '0.15.1', -- 本版排版版本
  metadata      jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'), -- 本版渲染配置
  change_note   text        NOT NULL DEFAULT '', -- 修改说明
  created_by    bigint      NOT NULL REFERENCES users(id) ON DELETE RESTRICT, -- 本版创建人
  edit_version  integer     NOT NULL DEFAULT 1 CHECK (edit_version > 0), -- 草稿并发版本号
  status        text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'approved', 'rejected')), -- 版本审核状态
  submitted_at  timestamptz, -- 提交审核时间
  reviewed_at   timestamptz, -- 完成审核时间
  created_at    timestamptz NOT NULL DEFAULT now(), -- 创建时间
  updated_at    timestamptz NOT NULL DEFAULT now(), -- 更新时间
  UNIQUE (lecture_id, revision_no),
  UNIQUE (lecture_id, id),
  CONSTRAINT lecture_revisions_base_fk FOREIGN KEY (lecture_id, based_on_id)
    REFERENCES lecture_revisions(lecture_id, id) ON DELETE RESTRICT,
  CONSTRAINT lecture_revisions_no_self_base CHECK (based_on_id IS DISTINCT FROM id),
  CONSTRAINT lecture_revisions_times_check CHECK (
    (status = 'draft' AND submitted_at IS NULL AND reviewed_at IS NULL)
    OR (status = 'pending' AND submitted_at IS NOT NULL AND reviewed_at IS NULL)
    OR (status IN ('approved', 'rejected') AND submitted_at IS NOT NULL AND reviewed_at IS NOT NULL AND reviewed_at >= submitted_at)
  )
);

ALTER TABLE lectures ADD CONSTRAINT lectures_public_revision_fk
  FOREIGN KEY (id, public_revision_id)
  REFERENCES lecture_revisions(lecture_id, id) ON DELETE RESTRICT;
CREATE INDEX lecture_revisions_category_idx ON lecture_revisions (category_id);
CREATE INDEX lecture_revisions_created_by_idx ON lecture_revisions (created_by);
CREATE INDEX lecture_revisions_review_idx ON lecture_revisions (status, submitted_at);
CREATE INDEX lecture_revisions_title_trgm_idx ON lecture_revisions USING gin (title gin_trgm_ops);

-- 讲义章节属于确定的讲义版本
CREATE TABLE lecture_chapters (
  id                  bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- 版本内章节标识
  lecture_revision_id bigint      NOT NULL REFERENCES lecture_revisions(id) ON DELETE RESTRICT, -- 所属讲义版本
  occurrence_id       uuid        NOT NULL DEFAULT gen_random_uuid(), -- 跨草稿复制时保留的章节实例标识
  slug                text        NOT NULL CHECK (btrim(slug) <> ''), -- 版本内章节别名
  tag                 text        NOT NULL DEFAULT '', -- 章节编号文案
  title               text        NOT NULL DEFAULT '', -- 章节标题
  summary             text        NOT NULL DEFAULT '', -- 章节说明
  pos                 integer     NOT NULL CHECK (pos >= 0), -- 章节顺序
  created_at          timestamptz NOT NULL DEFAULT now(), -- 创建时间
  updated_at          timestamptz NOT NULL DEFAULT now(), -- 更新时间
  UNIQUE (lecture_revision_id, id),
  UNIQUE (lecture_revision_id, occurrence_id),
  UNIQUE (lecture_revision_id, slug),
  UNIQUE (lecture_revision_id, pos) DEFERRABLE INITIALLY DEFERRED
);

-- 讲义小节只负责版本内目录结构
CREATE TABLE lecture_sections (
  id                  bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- 版本内小节标识
  lecture_revision_id bigint      NOT NULL REFERENCES lecture_revisions(id) ON DELETE RESTRICT, -- 所属讲义版本
  chapter_id          bigint      NOT NULL, -- 同一版本内的章节标识
  occurrence_id       uuid        NOT NULL DEFAULT gen_random_uuid(), -- 跨草稿复制时保留的小节实例标识
  slug                text        NOT NULL CHECK (btrim(slug) <> ''), -- 章节内小节别名
  tag                 text        NOT NULL DEFAULT '', -- 小节编号文案
  title               text        NOT NULL DEFAULT '', -- 小节标题
  summary             text        NOT NULL DEFAULT '', -- 小节说明
  pos                 integer     NOT NULL CHECK (pos >= 0), -- 小节顺序
  created_at          timestamptz NOT NULL DEFAULT now(), -- 创建时间
  updated_at          timestamptz NOT NULL DEFAULT now(), -- 更新时间
  UNIQUE (lecture_revision_id, id),
  UNIQUE (lecture_revision_id, occurrence_id),
  UNIQUE (chapter_id, slug),
  UNIQUE (chapter_id, pos) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT lecture_sections_chapter_fk FOREIGN KEY (lecture_revision_id, chapter_id)
    REFERENCES lecture_chapters(lecture_revision_id, id) ON DELETE RESTRICT
);

-- 内容块按顺序存放作者正文或固定知识点版本引用
CREATE TABLE lecture_blocks (
  id                    bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- 版本内内容块标识
  lecture_revision_id   bigint      NOT NULL REFERENCES lecture_revisions(id) ON DELETE RESTRICT, -- 所属讲义版本
  section_id            bigint      NOT NULL, -- 同一版本内的小节标识
  occurrence_id         uuid        NOT NULL DEFAULT gen_random_uuid(), -- 每次出现的独立实例标识
  block_type            text        NOT NULL CHECK (block_type IN ('author', 'knowledge_reference')), -- 内容块类型
  source                text, -- 作者内容块正文源码
  knowledge_point_id    bigint, -- 引用的知识点永久标识
  knowledge_revision_id bigint, -- 引用的确定知识点版本
  animation             jsonb       CHECK (jsonb_typeof(animation) = 'object' AND NOT (animation ? 'scenes_code')), -- 作者内容块动画配置
  pos                   integer     NOT NULL CHECK (pos >= 0), -- 小节内内容块顺序
  created_at            timestamptz NOT NULL DEFAULT now(), -- 创建时间
  updated_at            timestamptz NOT NULL DEFAULT now(), -- 更新时间
  UNIQUE (lecture_revision_id, occurrence_id),
  UNIQUE (section_id, pos) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT lecture_blocks_section_fk FOREIGN KEY (lecture_revision_id, section_id)
    REFERENCES lecture_sections(lecture_revision_id, id) ON DELETE RESTRICT,
  CONSTRAINT lecture_blocks_knowledge_fk FOREIGN KEY (knowledge_point_id, knowledge_revision_id)
    REFERENCES knowledge_revisions(knowledge_point_id, id) ON DELETE RESTRICT,
  CONSTRAINT lecture_blocks_payload_check CHECK (
    (block_type = 'author' AND source IS NOT NULL AND knowledge_point_id IS NULL AND knowledge_revision_id IS NULL)
    OR (block_type = 'knowledge_reference' AND source IS NULL AND animation IS NULL
      AND knowledge_point_id IS NOT NULL AND knowledge_revision_id IS NOT NULL)
  )
);

CREATE INDEX lecture_blocks_revision_idx ON lecture_blocks (lecture_revision_id);
CREATE INDEX lecture_blocks_knowledge_idx ON lecture_blocks (knowledge_point_id, knowledge_revision_id);

-- 讲义审核记录绑定完整讲义版本
CREATE TABLE lecture_reviews (
  id                  bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- 审核记录标识
  lecture_revision_id bigint      NOT NULL UNIQUE REFERENCES lecture_revisions(id) ON DELETE RESTRICT, -- 被审核的完整讲义版本
  reviewer_id         bigint      NOT NULL REFERENCES users(id) ON DELETE RESTRICT, -- 审核人标识
  decision            text        NOT NULL CHECK (decision IN ('approved', 'rejected')), -- 审核结论
  comment             text        NOT NULL DEFAULT '', -- 审核意见
  created_at          timestamptz NOT NULL DEFAULT now() -- 审核时间
);

CREATE INDEX lecture_reviews_reviewer_idx ON lecture_reviews (reviewer_id, created_at DESC);

-- 关系图写入锁用于并发安全的环路检查
CREATE TABLE content_graph_locks (
  scope      text   PRIMARY KEY, -- 关系图名称
  generation bigint NOT NULL DEFAULT 0 -- 写入序号
);

INSERT INTO content_graph_locks (scope)
VALUES ('knowledge_categories'), ('lecture_categories'), ('knowledge_prerequisites');

-- 写入图关系前更新锁记录
CREATE FUNCTION lock_content_graph() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE content_graph_locks SET generation = generation + 1 WHERE scope = TG_TABLE_NAME;
  IF NOT FOUND THEN
    RAISE EXCEPTION '缺少关系图写入锁';
  END IF;
  RETURN NULL;
END;
$$;

-- 分类移动时检查完整祖先链
CREATE FUNCTION guard_category_parent() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  has_cycle boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION '分类标识不可修改';
  END IF;
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  EXECUTE format(
    'WITH RECURSIVE ancestors AS (
       SELECT id, parent_id FROM %I WHERE id = $1
       UNION
       SELECT c.id, c.parent_id FROM %I c JOIN ancestors a ON c.id = a.parent_id
     ) SELECT EXISTS (SELECT 1 FROM ancestors WHERE id = $2)', TG_TABLE_NAME, TG_TABLE_NAME
  ) INTO has_cycle USING NEW.parent_id, NEW.id;
  IF has_cycle THEN
    RAISE EXCEPTION '分类父子关系不能成环';
  END IF;
  RETURN NEW;
END;
$$;

-- 知识点前置关系写入时检查完整依赖链
CREATE FUNCTION guard_knowledge_prerequisite() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  has_cycle boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    WITH RECURSIVE dependencies AS (
      SELECT NEW.prerequisite_id AS id
      UNION
      SELECT p.prerequisite_id FROM knowledge_prerequisites p
      JOIN dependencies d ON p.knowledge_point_id = d.id
      WHERE (p.knowledge_point_id, p.prerequisite_id) IS DISTINCT FROM (OLD.knowledge_point_id, OLD.prerequisite_id)
    )
    SELECT EXISTS (SELECT 1 FROM dependencies WHERE id = NEW.knowledge_point_id) INTO has_cycle;
  ELSE
    WITH RECURSIVE dependencies AS (
      SELECT NEW.prerequisite_id AS id
      UNION
      SELECT p.prerequisite_id FROM knowledge_prerequisites p
      JOIN dependencies d ON p.knowledge_point_id = d.id
    )
    SELECT EXISTS (SELECT 1 FROM dependencies WHERE id = NEW.knowledge_point_id) INTO has_cycle;
  END IF;
  IF has_cycle THEN
    RAISE EXCEPTION '知识点前置关系不能成环';
  END IF;
  RETURN NEW;
END;
$$;

-- 仅允许草稿编辑并通过审核记录推进已提交版本
CREATE FUNCTION guard_content_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  review_exists boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
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
     OR NEW.based_on_id IS DISTINCT FROM OLD.based_on_id
     OR NEW.revision_no IS DISTINCT FROM OLD.revision_no
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION '版本身份与来源不可修改';
  END IF;
  IF TG_TABLE_NAME = 'knowledge_revisions' THEN
    IF NEW.knowledge_point_id IS DISTINCT FROM OLD.knowledge_point_id
       OR NEW.contributor_id IS DISTINCT FROM OLD.contributor_id THEN
      RAISE EXCEPTION '知识点版本归属与贡献者不可修改';
    END IF;
  ELSE
    IF NEW.lecture_id IS DISTINCT FROM OLD.lecture_id OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
      RAISE EXCEPTION '讲义版本归属与创建人不可修改';
    END IF;
  END IF;
  IF OLD.status = 'draft' THEN
    IF NEW.status = 'pending' THEN
      IF btrim(NEW.title) = '' THEN
        RAISE EXCEPTION '提交审核前必须填写标题';
      END IF;
      IF TG_TABLE_NAME = 'knowledge_revisions' THEN
        IF btrim(NEW.source) = '' THEN
          RAISE EXCEPTION '提交审核前必须填写知识点正文';
        END IF;
      ELSE
        IF NOT EXISTS (SELECT 1 FROM lecture_blocks WHERE lecture_revision_id = NEW.id) THEN
          RAISE EXCEPTION '提交审核前必须编排讲义内容';
        END IF;
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
    IF TG_TABLE_NAME = 'knowledge_revisions' THEN
      SELECT EXISTS (
        SELECT 1 FROM knowledge_reviews WHERE knowledge_revision_id = OLD.id AND decision = NEW.status
      ) INTO review_exists;
    ELSE
      SELECT EXISTS (
        SELECT 1 FROM lecture_reviews WHERE lecture_revision_id = OLD.id AND decision = NEW.status
      ) INTO review_exists;
    END IF;
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

-- 编辑目录或内容块时锁定所属讲义版本
CREATE FUNCTION guard_lecture_content() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  revision_id bigint;
  revision_status text;
  reference_status text;
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
  SELECT status INTO revision_status FROM lecture_revisions WHERE id = revision_id FOR UPDATE;
  IF revision_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION '只能修改草稿版本的目录与内容';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME = 'lecture_blocks' THEN
    IF NEW.block_type = 'knowledge_reference' THEN
      SELECT status INTO reference_status FROM knowledge_revisions
       WHERE id = NEW.knowledge_revision_id AND knowledge_point_id = NEW.knowledge_point_id FOR SHARE;
      IF reference_status IS DISTINCT FROM 'approved' THEN
        RAISE EXCEPTION '讲义只能引用已审核通过的知识点版本';
      END IF;
    END IF;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

-- 公开入口只能指向本体的已审核版本
CREATE FUNCTION guard_public_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  revision_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION '永久身份标识不可修改';
  END IF;
  IF NEW.public_revision_id IS NOT NULL THEN
    IF TG_TABLE_NAME = 'knowledge_points' THEN
      SELECT status INTO revision_status FROM knowledge_revisions
       WHERE id = NEW.public_revision_id AND knowledge_point_id = NEW.id FOR SHARE;
    ELSE
      SELECT status INTO revision_status FROM lecture_revisions
       WHERE id = NEW.public_revision_id AND lecture_id = NEW.id FOR SHARE;
    END IF;
    IF revision_status IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION '公开入口必须指向本体的已审核通过版本';
    END IF;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

-- 仅允许有效管理员审核待审核版本
CREATE FUNCTION guard_content_review() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  revision_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION '审核记录不可修改或删除';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.reviewer_id AND role = 'super_admin' AND status = 'active') THEN
    RAISE EXCEPTION '审核人必须为有效超级管理员';
  END IF;
  IF TG_TABLE_NAME = 'knowledge_reviews' THEN
    SELECT status INTO revision_status FROM knowledge_revisions WHERE id = NEW.knowledge_revision_id FOR UPDATE;
  ELSE
    SELECT status INTO revision_status FROM lecture_revisions WHERE id = NEW.lecture_revision_id FOR UPDATE;
  END IF;
  IF revision_status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION '只能审核待审核版本';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

-- 审核记录写入后同步版本审核状态
CREATE FUNCTION apply_content_review() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'knowledge_reviews' THEN
    UPDATE knowledge_revisions SET status = NEW.decision WHERE id = NEW.knowledge_revision_id;
  ELSE
    UPDATE lecture_revisions SET status = NEW.decision WHERE id = NEW.lecture_revision_id;
  END IF;
  RETURN NEW;
END;
$$;

-- 普通记录更新时维护更新时间
CREATE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER invitations_touch BEFORE UPDATE ON invitations
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER knowledge_categories_touch BEFORE UPDATE ON knowledge_categories
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER lecture_categories_touch BEFORE UPDATE ON lecture_categories
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER knowledge_categories_lock BEFORE INSERT OR UPDATE OR DELETE ON knowledge_categories
  FOR EACH STATEMENT EXECUTE FUNCTION lock_content_graph();
CREATE TRIGGER lecture_categories_lock BEFORE INSERT OR UPDATE OR DELETE ON lecture_categories
  FOR EACH STATEMENT EXECUTE FUNCTION lock_content_graph();
CREATE TRIGGER knowledge_prerequisites_lock BEFORE INSERT OR UPDATE OR DELETE ON knowledge_prerequisites
  FOR EACH STATEMENT EXECUTE FUNCTION lock_content_graph();
CREATE TRIGGER knowledge_categories_guard BEFORE INSERT OR UPDATE ON knowledge_categories
  FOR EACH ROW EXECUTE FUNCTION guard_category_parent();
CREATE TRIGGER lecture_categories_guard BEFORE INSERT OR UPDATE ON lecture_categories
  FOR EACH ROW EXECUTE FUNCTION guard_category_parent();
CREATE TRIGGER knowledge_prerequisites_guard BEFORE INSERT OR UPDATE ON knowledge_prerequisites
  FOR EACH ROW EXECUTE FUNCTION guard_knowledge_prerequisite();

CREATE TRIGGER knowledge_revisions_guard BEFORE INSERT OR UPDATE OR DELETE ON knowledge_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_content_revision();
CREATE TRIGGER lecture_revisions_guard BEFORE INSERT OR UPDATE OR DELETE ON lecture_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_content_revision();
CREATE TRIGGER lecture_chapters_guard BEFORE INSERT OR UPDATE OR DELETE ON lecture_chapters
  FOR EACH ROW EXECUTE FUNCTION guard_lecture_content();
CREATE TRIGGER lecture_sections_guard BEFORE INSERT OR UPDATE OR DELETE ON lecture_sections
  FOR EACH ROW EXECUTE FUNCTION guard_lecture_content();
CREATE TRIGGER lecture_blocks_guard BEFORE INSERT OR UPDATE OR DELETE ON lecture_blocks
  FOR EACH ROW EXECUTE FUNCTION guard_lecture_content();

CREATE TRIGGER knowledge_points_public_guard BEFORE INSERT OR UPDATE ON knowledge_points
  FOR EACH ROW EXECUTE FUNCTION guard_public_revision();
CREATE TRIGGER lectures_public_guard BEFORE INSERT OR UPDATE ON lectures
  FOR EACH ROW EXECUTE FUNCTION guard_public_revision();
CREATE TRIGGER knowledge_reviews_guard BEFORE INSERT OR UPDATE OR DELETE ON knowledge_reviews
  FOR EACH ROW EXECUTE FUNCTION guard_content_review();
CREATE TRIGGER lecture_reviews_guard BEFORE INSERT OR UPDATE OR DELETE ON lecture_reviews
  FOR EACH ROW EXECUTE FUNCTION guard_content_review();
CREATE TRIGGER knowledge_reviews_apply AFTER INSERT ON knowledge_reviews
  FOR EACH ROW EXECUTE FUNCTION apply_content_review();
CREATE TRIGGER lecture_reviews_apply AFTER INSERT ON lecture_reviews
  FOR EACH ROW EXECUTE FUNCTION apply_content_review();

-- 审核通过后由服务端在事务中更新公开入口
-- 推荐标记由服务端按发布策略单独设置
-- 知识点新版审核不会自动替换讲义的固定引用
-- 已提交版本和审核记录需要保留以支持追溯
-- 内容关联的账号应优先停用以保留归属和贡献记录
-- 管理员账号由部署流程创建并设置独立密码

COMMIT;
