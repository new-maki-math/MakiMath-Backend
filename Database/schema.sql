-- MakiMath 讲义 schema
-- 架构特性：
--   1. 角色体系：普通读者（无需登录） + 超级管理员 (super_admin) + 编者 (editor)
--   2. 数据透传：纯 JSON 透传讲义数据，后端无状态、无外部编译依赖
--   3. 层级关系：分类 -> 课程 -> 章节 -> 小节
--   4. 拓扑与检索：数组 GIN 索引支持前置依赖 DAG，pg_trgm 支持中文模糊检索

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================
-- 1. 用户与认证表
-- ============================================================

-- 用户表（超管与编者，普通读者无需登录）
CREATE TABLE users (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      text        NOT NULL UNIQUE,
  password_hash text        NOT NULL,
  display_name  text        NOT NULL DEFAULT '',
  role          text        NOT NULL DEFAULT 'editor'
                            CHECK (role IN ('super_admin', 'editor')),
  status        text        NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'disabled')),
  invitation_id bigint,                                 -- 通过哪个邀请码注册的
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_role_status ON users (role, status);

-- 注册邀请码表（管理员生成，用于控制编者准入）
CREATE TABLE invitations (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        text        NOT NULL UNIQUE,               -- 易读邀请码（如 MK-A8B9C2）
  role        text        NOT NULL DEFAULT 'editor'
                          CHECK (role IN ('super_admin', 'editor')),
  created_by  bigint      REFERENCES users(id) ON DELETE SET NULL, -- 哪个管理员生成的
  max_uses    integer     NOT NULL DEFAULT 1,            -- 允许使用次数，默认 1
  used_count  integer     NOT NULL DEFAULT 0,            -- 已使用次数
  status      text        NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'revoked', 'exhausted')),
  note        text        NOT NULL DEFAULT '',           -- 备注（如：分配给高数编者张三）
  expires_at  timestamptz,                               -- 过期时间，空为永久有效
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_code   ON invitations (code);
CREATE INDEX invitations_status ON invitations (status);

-- 补充外键约束
ALTER TABLE users ADD CONSTRAINT fk_users_invitation
  FOREIGN KEY (invitation_id) REFERENCES invitations(id) ON DELETE SET NULL;

-- 用户会话 / Refresh Token 表
CREATE TABLE user_sessions (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text        NOT NULL UNIQUE,
  user_agent  text        NOT NULL DEFAULT '',
  ip_address  inet,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_sessions_user_id ON user_sessions (user_id);
CREATE INDEX user_sessions_expires ON user_sessions (expires_at);

-- 操作审计日志表（记录所有需要认证接口的操作行为）
CREATE TABLE audit_logs (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      bigint      REFERENCES users(id) ON DELETE SET NULL,
  username     text        NOT NULL DEFAULT '',
  user_role    text        NOT NULL DEFAULT '',
  method       text        NOT NULL,
  path         text        NOT NULL,
  status_code  integer     NOT NULL,
  duration_ms  integer     NOT NULL DEFAULT 0,
  ip_address   inet,
  user_agent   text        NOT NULL DEFAULT '',
  payload      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_user_id    ON audit_logs (user_id);
CREATE INDEX audit_logs_created_at ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_method_path ON audit_logs (method, path);


-- ============================================================
-- 2. 讲义树状层级业务表
-- ============================================================

-- 分类
CREATE TABLE categories (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug        text        NOT NULL UNIQUE,
  name        text        NOT NULL,
  pos         integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX categories_pos ON categories (pos);

-- 课程
CREATE TABLE courses (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug          text        NOT NULL UNIQUE,
  category_id   bigint      NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  title         text        NOT NULL,
  subtitle      text        NOT NULL DEFAULT '',
  descr         text        NOT NULL DEFAULT '',
  status        text        NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'live', 'hidden', 'archived')),
  pos           integer     NOT NULL DEFAULT 0,
  typst_version text        NOT NULL DEFAULT '0.15.1',
  -- 扩展元数据（前端渲染配置、主题等），纯 JSON
  metadata      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- 前置课程 id 数组，顺序即建议学习顺序
  prereqs       bigint[]    NOT NULL DEFAULT '{}',
  created_by    bigint      REFERENCES users(id) ON DELETE SET NULL,
  updated_by    bigint      REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category_id, pos) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT courses_no_self_prereq CHECK (NOT (id = ANY (prereqs)))
);
CREATE INDEX courses_category    ON courses (category_id, pos);
CREATE INDEX courses_status      ON courses (status);
CREATE INDEX courses_prereqs_gin ON courses USING gin (prereqs);

-- 课程协作者（编者与课程授权关联）
CREATE TABLE course_editors (
  course_id   bigint      NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id     bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (course_id, user_id)
);
CREATE INDEX course_editors_user ON course_editors (user_id);

-- 章节（大章）
CREATE TABLE chapters (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_id    bigint      NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  slug         text        NOT NULL,
  tag          text        NOT NULL DEFAULT '',
  title        text        NOT NULL,
  summary      text        NOT NULL DEFAULT '',
  pos          integer     NOT NULL DEFAULT 0,
  updated_by   bigint      REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, slug),
  UNIQUE (course_id, pos) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX chapters_course ON chapters (course_id, pos);

-- 小节（讲义核心内容，支持纯文本或 JSON 透传）
CREATE TABLE sections (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chapter_id  bigint      NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  slug        text        NOT NULL,
  tag         text        NOT NULL DEFAULT '',
  title       text        NOT NULL,
  summary     text        NOT NULL DEFAULT '',
  pos         integer     NOT NULL DEFAULT 0,
  -- 小节内容（文本或 JSON 透传）
  source      text        NOT NULL DEFAULT '',
  -- 内容哈希 sha256，用于前端协商缓存与版本冲突检测
  source_hash text        NOT NULL DEFAULT '',
  -- 前置小节 id 数组
  prereqs     bigint[]    NOT NULL DEFAULT '{}',
  updated_by  bigint      REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chapter_id, slug),
  UNIQUE (chapter_id, pos) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT sections_no_self_prereq CHECK (NOT (id = ANY (prereqs)))
);
CREATE INDEX sections_chapter     ON sections (chapter_id, pos);
CREATE INDEX sections_source_hash ON sections (source_hash);
CREATE INDEX sections_prereqs_gin ON sections USING gin (prereqs);
-- 中文子串检索
CREATE INDEX sections_title_trgm  ON sections USING gin (title gin_trgm_ops);
-- 标题与正文全文检索复合向量索引
CREATE INDEX sections_fts_idx     ON sections USING gin (
  (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(left(source, 2000), '')), 'B')
  )
);


-- ============================================================
-- 3. 初始默认超级管理员
-- 用户名: makimath_root
-- 密码: b!TnB7c3CGgcPxDFcaN8_&3Q
-- 部署后一定及时修改密码！
-- ============================================================
INSERT INTO users (username, password_hash, display_name, role, status)
VALUES (
  'makimath_root',
  '$2b$12$FzGlApGDO6kEDg8n7StcG.30EtRWrTnatavpkxEn20h7k7D6XM8cS',
  '超级管理员',
  'super_admin',
  'active'
) ON CONFLICT (username) DO NOTHING;
