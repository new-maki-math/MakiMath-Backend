# 后端接口契约

本文描述知识点与讲义模型的首版接口。旧课程和小节接口已移除，前端需要按本文适配。

## 通用约定

- 基础路径为 `/api`。
- 除公钥接口外，请求继续使用现有通信加解密协议。客户端使用 `GET /api/auth/pubkey` 获取服务端公钥；请求体加密为 `{ "d": "..." }`，成功响应也按同一协议解密。错误响应为普通 JSON。
- 登录后使用 `Authorization: Bearer <access_token>`。所有身份和权限由服务端确认，请求不能指定所有者、维护人或审核人。
- 返回错误格式为 `{ "error": "说明" }`。常见状态码为 400 参数错误、401 未登录或会话失效、403 无权限、404 不存在或不可公开、409 版本或业务冲突。
- 账号被停用或会话注销后，已有访问令牌立即失效。刷新令牌每次刷新时轮换。
- 资源标识为正整数。草稿的 `edit_version` 是乐观并发版本号，保存或提交时必须传入最近一次读取返回的值。成功操作后使用新返回值；遇到 409 应重新读取并解决冲突。
- 单个请求体上限为 4 MiB。列表接口暂未分页，建议前端不要假设其适合大量数据。

## 认证与管理

| 方法 | 路径 | 请求体或说明 |
| --- | --- | --- |
| POST | `/auth/register` | `username`、`password`、`invite_code`，可选 `display_name` |
| POST | `/auth/login` | `username`、`password`，返回 `user`、`access_token`、`refresh_token` |
| POST | `/auth/refresh` | `refresh_token`，返回新的令牌对 |
| POST | `/auth/logout` | 登录后提交当前 `refresh_token`，返回 204 |
| GET | `/auth/me` | 返回当前用户 |
| PATCH | `/auth/profile` | 提交 `display_name` 更新个人展示名称 |
| PATCH | `/auth/password` | 提交 `old_password`、`new_password`，成功后撤销所有会话并返回 204 |
| POST | `/invitations` | 管理员提交 `role`、`max_uses`，可选 `note`、`expires_at` |
| GET | `/invitations` | 管理员读取邀请码，最多返回 200 条 |
| DELETE | `/invitations/:id` | 管理员撤销邀请码 |
| GET | `/users` | 管理员读取用户列表 |
| PATCH | `/users/:id/status` | 管理员提交 `status`，取值为 `active` 或 `disabled` |
| GET | `/audit-logs?limit=20` | 管理员读取审计记录，最多 100 条 |

邀请码的 `role` 可以是 `editor` 或 `super_admin`。本地可使用 `pn run admin:init` 初始化管理员。

## 知识点

知识点由 `super_admin` 直接维护，保存后立即对外生效。普通编者不能创建或修改知识点，未登录用户可读取有效知识点。知识点只包含永久 ID、别名、标题、Typst 正文、分类、前置关系、状态和维护记录，不再有知识点版本、简介、动画或内容 metadata。

| 方法 | 路径 | 请求体或说明 |
| --- | --- | --- |
| GET | `/knowledge-points` | 公开有效知识点列表，返回 `id`、`slug`、`title` |
| GET | `/knowledge-points/:id` | 公开有效知识点详情，返回 `id`、`slug`、`title`、`source` 和 `categories` |
| GET | `/knowledge-points/by-slug/:slug` | 通过别名读取公开有效知识点详情 |
| GET | `/knowledge-points/manage` | 管理员读取所有状态的知识点列表，包括全部关联分类的 `category_ids` |
| GET | `/knowledge-points/manage/:id` | 管理员读取任意状态的知识点详情及维护记录 |
| POST | `/knowledge-points` | 管理员提交 `slug`、`title`、`source`，返回新知识点 |
| POST | `/knowledge-points/import` | 管理员向有效一级分类原子导入分类、知识点及前置关系 |
| PUT | `/knowledge-points/:id` | 管理员提交 `title`、`source`，立即更新 |
| DELETE | `/knowledge-points/:id` | 管理员永久删除知识点并清理其分类及前置关联 |
| DELETE | `/categories/knowledge/:id` | 管理员永久删除分类树及仅属于该范围的知识点 |
| GET | `/knowledge-points/:id/prerequisites` | 获取有效的前置知识点 |
| PUT | `/knowledge-points/:id/prerequisites` | 管理员提交 `{ "prerequisites": [1, 2] }` |
| PUT | `/knowledge-points/:id/categories` | 管理员提交 `{ "categories": [1, 2] }` |
| PATCH | `/knowledge-points/:id/status` | 管理员提交 `status`，取值为 `active` 或 `archived` |

创建示例：

```json
{ "slug": "sequence-limit", "title": "数列极限的定义", "source": "知识点正文" }
```

内容编辑请求只需要 `title` 与 `source`。标题和正文不能为空，维护人从登录身份取得。内容更新采用最后一次成功写入的结果，当前没有并发冲突提示。归档后公开详情返回 404，管理员仍可通过管理接口查看并恢复。分类和前置关系由管理员维护，前置关系替换在事务中锁定所属知识点，数据库拒绝循环依赖。

`GET /api/knowledge-points/by-slug/sequence-limit` 允许匿名访问，返回与按 ID 详情相同的 `{ "id": 101, "slug": "sequence-limit", "title": "数列极限", "source": "正文", "categories": [{ "id": 1, "slug": "analysis", "name": "分析" }] }`，分类仅包含有效分类。`id` 是用于掌握状态的永久身份；slug 不合法返回 400，知识点不存在或已归档返回 404。该公开接口即使由管理员调用也不返回已归档知识点；管理详情仍按原有管理员权限通过 ID 读取。响应设置 `Cache-Control: no-store`。

知识点 slug 在数据库中全局唯一，当前业务接口不支持修改，但数据库本身未禁止直接修改。若直接改动 slug，旧讲义引用不会随之更新；删除知识点后旧 slug 也可能重新被使用，旧引用可能指向新知识点。维护时应避免改动或复用已引用的 slug。

管理列表的 `category_ids` 为该知识点所有直接关联的分类永久 ID，按 ID 升序排列，包括已归档分类；无关联时为 `[]`。知识点自身无论是 `active` 还是 `archived` 都会返回。`GET /categories/knowledge` 只返回有效分类，因此不在分类接口结果中的 ID 仍可能是已归档的现有关联，前端不能把它当成不存在并在整体替换分类时自动删除。`PUT /knowledge-points/:id/categories` 会整体替换关联，若不打算移除归档分类，应一并保留这些 ID。管理详情接口暂不返回 `category_ids`，管理列表是该字段的数据来源。

知识点公开列表、详情、管理查询及搜索设置 `Cache-Control: no-store`。知识地图见下方接口，不提供知识点 `revision_id` 或 `summary`。

### 永久删除

永久删除接口仅允许 `super_admin`，无需请求体；成功返回 204 且无响应体，不存在返回 404，未登录返回 401，非管理员返回 403。知识点删除在同一事务中移除该点的全部直接分类关联及入向、出向前置关系，然后删除知识点；不删除关系另一端的知识点。

分类删除会删除目标分类和所有层级的后代，包括已归档分类。与该范围直接关联的知识点，如果所有分类关联都在该范围内，会被永久删除；只要仍关联范围外的任一分类，就保留该知识点和范围外的关联，归档分类也计入判断。未关联该范围的知识点不受影响。删除专属知识点时同时清理其入向及出向前置关系；保留知识点之间及其与其他未删除知识点的前置关系不变。所有操作在同一事务内完成，失败回滚。

讲义只保存源码，后端不维护或扫描知识点引用关系，删除时无法判断哪些讲义引用该知识点。删除后讲义源码保持原样，前端读取缺失知识点时显示局部占位；浏览器本地的掌握记录和批注也不会自动清理。永久删除不可撤销，操作前由客户端明确提示这些影响。

### 知识点批量导入

`POST /api/knowledge-points/import` 使用现有请求加密，解密后的请求体为：

```json
{
  "category_id": 8,
  "data": {
    "schema_version": 1,
    "categories": [
      { "id": "calculus", "parent_id": null, "slug": "calculus", "name": "一元微积分", "pos": 0 },
      { "id": "limits", "parent_id": "calculus", "slug": "calculus-limits", "name": "极限", "pos": 0 }
    ],
    "points": [
      { "id": "L03-01", "slug": "sequence-limit", "title": "数列极限", "source": "完整 Typst 正文", "category_ids": ["limits"] },
      { "id": "L03-02", "slug": "sequence-limit-properties", "title": "极限性质", "source": "完整 Typst 正文", "category_ids": [] }
    ],
    "edges": [{ "source": "L03-01", "target": "L03-02" }]
  }
}
```

`category_id` 是已存在且有效的一级知识分类数据库 ID。文件中的分类和知识点 `id` 是各自命名空间内的本批次字符串标识；分类 `parent_id`、知识点 `category_ids` 和边两端只能引用文件中的局部 ID，不能引用外部数据库 ID。文件顶层分类挂到目标分类下，子分类保持文件层级。知识点只关联其直接分类；`category_ids` 为空或省略时关联目标分类，不额外关联祖先。边的 `source` 是前置知识点，`target` 是依赖它的知识点。`schema_version` 是文件格式版本，当前只支持整数 `1`。

导入至少包含一个知识点，分类最多 150 个，知识点最多 1000 个，边最多 6000 条，每个知识点最多关联 100 个分类，整个批次最多 10000 条分类关联。`data` 重新序列化后的 UTF-8 大小不超过 2 MiB，加密后的整个 HTTP 请求仍受 4 MiB 限制。局部 ID 不超过 100 个字符，分类和知识点 `slug` 不超过 100 个字符且遵循现有别名规则，分类名称和知识点标题不超过 200 个字符，正文不超过 200000 个字符。额外字段、空标题或正文、重复 ID 和关系、未知引用以及分类或知识点前置成环均会被拒绝。

整个批次在一个事务中写入，成功返回 201 和如下格式；映射数组的顺序不应作为业务顺序使用：

```json
{
  "category_id": 8,
  "counts": { "categories": 2, "points": 2, "edges": 1 },
  "categories": [{ "id": "calculus", "category_id": 11 }, { "id": "limits", "category_id": 12 }],
  "points": [{ "id": "L03-01", "point_id": 21 }, { "id": "L03-02", "point_id": 22 }]
}
```

错误响应为普通 JSON，`details` 中的 `field` 指明数组，`index` 是从零开始的条目位置，部分错误还包含 `property`、局部 `id` 或 `slug`。格式及引用错误为 400，已有或批内重复 `slug` 及无效目标分类为 409。分类和知识点的 `slug` 各自在全库唯一，冲突不会复用、移动或覆盖已有内容；失败时整批回滚。接口不读取服务器本机路径，不接受审核、版本、统计或审阅字段。

### 知识地图

`GET /api/knowledge-map` 允许匿名访问，可选 `category_id` 为正整数。省略时返回所有有效知识点；传入时只返回属于该有效分类及其任意层级后代的知识点。遍历后代时会经过归档分类；目标分类不存在或已归档返回 404，参数格式不合法返回 400。前端可选择 `parent_id` 为 `null` 的一级分类，并在返回节点范围内按标题搜索。

响应示例：

```json
{
  "categories": [{ "id": 1, "parent_id": null, "slug": "analysis", "name": "分析", "pos": 0 }],
  "nodes": [{ "id": 10, "slug": "sequence-limit", "title": "数列极限", "category_ids": [1] }, { "id": 11, "slug": "limit-rule", "title": "极限性质", "category_ids": [1] }],
  "edges": [{ "source": 10, "target": 11 }],
  "stats": { "category_count": 1, "node_count": 2, "edge_count": 1 },
  "filter": { "category_id": 1, "include_descendants": true }
}
```

`categories` 始终是全部有效分类，`category_count` 是其数量，并非筛选范围内分类数；若有效分类的父分类已归档，`parent_id` 仍是真实父 ID，父项可能不在返回列表。`nodes` 只包含有效知识点，同一点即使属于多个分类也只出现一次，`category_ids` 是其全部有效的直接分类 ID。没有分类或前置关系的有效知识点在未筛选地图中仍会返回。

`edges.source` 为前置知识点永久 ID，`edges.target` 为依赖者 ID；只返回两端都在本次节点结果内的边，不能据此推断范围外没有前置依赖。`node_count` 和 `edge_count` 是本次结果数量。分类按 `pos,id`，节点按 `id`，边按 `source,target` 升序排列。整个响应在同一只读一致快照中获取，不含正文、版本、简介、动画和个人掌握状态。节点详情通过 `GET /api/knowledge-points/:id` 读取。响应设置 `Cache-Control: no-store`；当前没有分页。

## 讲义

| 方法 | 路径 | 请求体或说明 |
| --- | --- | --- |
| GET | `/lectures` | 公开讲义列表，包含推荐标记 |
| GET | `/lectures/by-slug/:slug` | 按在线讲义 slug 读取默认内容，可选 `revision_id` 明确指定版本 |
| GET | `/lectures/mine` | 登录用户有权访问的讲义列表，包括协作者与管理员可见讲义 |
| GET | `/lectures/owned` | 登录用户作为所有者的讲义及版本摘要 |
| POST | `/lectures` | 提交 `slug`、`title`，返回 `lecture` 和首个草稿 `revision` |
| GET | `/lectures/:id/revisions` | 读取有权访问的讲义版本列表 |
| POST | `/lectures/:id/revisions` | 提交 `based_on_id` 复制快照；已有工作草稿时返回 409 |
| GET | `/lecture-revisions/:id` | 读取有权访问的完整版本 |
| PUT | `/lecture-revisions/:id` | 以完整目录树替换草稿 |
| POST | `/lecture-revisions/:id/submit` | 提交草稿 `edit_version`，生成独立待审快照并返回 `snapshot` 和 `draft_edit_version` |
| GET | `/lectures/:id/collaborators` | 有权查看讲义的用户读取协作者 |
| PUT | `/lectures/:id/collaborators/:userId` | 所有者或管理员提交 `permission`，取值为 `view` 或 `edit` |
| DELETE | `/lectures/:id/collaborators/:userId` | 所有者或管理员移除协作者 |
| PATCH | `/lectures/:id/publication` | 所有者或管理员设置 `publication_status`，推荐标记 `is_recommended` 仅管理员可设置 |
| POST | `/lectures/:id/restore` | 所有者或管理员恢复已归档讲义，无需请求体 |
| DELETE | `/lectures/:id` | 仅管理员永久删除已归档讲义，无需请求体，成功返回 204 |

归档后整本讲义只读，包括工作草稿和审核快照。保存目录与源码、复制草稿、提交审核、调整协作者、修改发布或推荐状态，以及对已有待审快照作出审核结论，均返回 409，提示 `已归档讲义只能恢复归档`。已有待审快照和审核记录保留，恢复后可以继续审核。读取仍按原有权限执行，归档讲义不会出现在公开列表中。

前端应移除归档讲义的编辑、提交、上架、下载和其他操作入口，只提供固定的恢复入口及只读查看。恢复通过 `POST /api/lectures/:id/restore`，返回更新后的讲义对象；未登录返回 401，无所有者或管理员权限返回 403，讲义不存在返回 404，未归档返回 409。恢复会保留 `public_revision_id`：已有公开版本指针时状态为 `withdrawn`，否则为 `unpublished`；`is_recommended` 为 `false`，不会自动公开。恢复后原有审核快照仍不可编辑。并发归档或恢复可能导致操作返回 409，前端应刷新讲义状态。

管理员可对已归档讲义调用 `DELETE /api/lectures/:id`，前端须先完成三步确认并明确告知删除不可恢复。永久删除包括讲义、所有草稿、审核快照、章节、小节、审核记录和协作者关系；用户、分类及共享知识点不受影响。成功返回 204 且无响应体；未登录返回 401，非管理员返回 403，讲义不存在返回 404，讲义未归档返回 409。删除与恢复及其他写操作通过讲义行锁串行化，前端遇到 409 或 404 时应刷新列表。普通操作审计日志按既有机制保留。

已有数据库需由用户另行审核并手工执行 `Database/manual/allow-archived-lecture-deletion.sql`，初始化数据库使用更新后的 `Database/schema.sql`。脚本只调整约束和触发函数，不清理数据。删除权限由服务端认证与授权检查执行，数据库中的事务局部标记用于限定冻结保护的删除例外，不能代替数据库账号权限管理。

当前没有专用讲义导出接口。授权阅读接口仍返回小节源码，前端应禁止对归档讲义提供下载功能，但无法阻止已获授权的读者复制阅读内容。

`GET /api/lectures/owned` 用于“我创作的讲义”，只返回当前会话用户作为所有者的讲义，管理员也只能通过该接口取得本人作品。未登录或会话失效返回 401，没有本人讲义返回 `200 []`。查询使用一次数据库查询，响应为数组：

```json
[
  {
    "id": 1,
    "slug": "analysis",
    "publication_status": "published",
    "public_revision_id": 10,
    "versions": [
      { "revision_id": 11, "revision_no": 1, "kind": "working_draft", "status": "draft", "title": "讲义草稿", "subtitle": "", "updated_at": "2026-10-28T12:00:00.000Z", "is_public": false },
      { "revision_id": 10, "revision_no": 2, "kind": "snapshot", "status": "approved", "title": "已发布讲义", "subtitle": "", "updated_at": "2026-10-27T12:00:00.000Z", "is_public": true }
    ]
  }
]
```

版本状态为 `draft`、`pending`、`approved` 或 `rejected`。`kind` 为 `working_draft` 或 `snapshot`；仅当状态是 `draft` 且没有来源草稿时为工作草稿。历史异常数据若返回 `kind: snapshot` 且 `status: draft`，前端应标记异常，不应当成工作草稿。`is_public` 仅当讲义当前为 `published`、版本为 `approved` 且 ID 等于 `public_revision_id` 时为真；下架或归档可保留 `public_revision_id`，但所有版本的 `is_public` 均为假。

讲义按最近版本的 `updated_at` 倒序，再按讲义 ID 倒序；无版本时使用讲义的 `updated_at`。同一讲义的工作草稿排在快照之前，快照按 `revision_no`、版本 ID 倒序。无版本时 `versions` 为 `[]`，不会生成草稿；下架和归档的本人讲义仍会返回。响应不含正文，设置 `Cache-Control: no-store`，第一版不分页。权限或身份变化后应重新获取列表，读取指定版本时仍进行独立授权检查。

在线讲义 slug 在平台范围内唯一，前端地址使用 `/lecture/online/:slug`，通过 `GET /api/lectures/by-slug/:slug` 直接读取，不需要先下载列表。原 `GET /api/lectures/:id` 已移除，不提供兼容入口；讲义内部 ID 仍用于协作者、版本列表及其他管理接口。

不指定 `revision_id` 时，已发布讲义始终返回当前公开的已审核快照，包括所有者和协作者访问时；其他用户不能通过默认读取得到草稿。未发布、下架或归档的讲义仅所有者、查看或编辑协作者、管理员可访问，默认读取该讲义唯一工作草稿。不存在或无权限返回 404；若历史数据没有工作草稿或存在多个工作草稿，返回 409 并在 `details` 提供 `lecture_id` 和 `drafts`，不会猜选版本。非法 slug 或版本 ID 返回 400。

可使用 `GET /api/lectures/by-slug/:slug?revision_id=123` 精确读取该讲义的指定版本，响应 `revision.id` 就是所选版本，不会自动切换草稿或最新快照。匿名或无查看权限用户只能读取当前已发布的审核通过快照；所有者、查看和编辑协作者及管理员可读取该讲义的草稿、待审、通过或驳回版本。版本不存在、属于其他讲义或无权限时统一返回 404。登录用户也可继续使用 `GET /api/lecture-revisions/:id` 读取有权查看的明确版本，该接口的权限错误为 403。

每个讲义最多一个工作草稿，提交审核产生独立的不可修改快照。新初始化结构包含草稿唯一约束；已有数据库需要另行审核并手工执行 `Database/manual/enforce-single-lecture-draft.sql`。脚本发现同一讲义有多个草稿时会报错回滚，不会自动删除或合并数据。若尝试从快照复制新草稿而已有工作草稿，返回 409，并在 `details.draft_id` 中给出草稿 ID。读取响应为 `{lecture, revision, chapters}`，`lecture.id` 可供管理接口使用。接口返回 `Cache-Control: no-store`，不暴露所有者身份用于授权判断。

完整草稿保存示例：

```json
{
  "edit_version": 1,
  "title": "数学讲义",
  "subtitle": "",
  "descr": "",
  "category_id": null,
  "typst_version": "0.15.1",
  "metadata": {},
  "change_note": "",
  "chapters": [
    {
      "slug": "chapter-1",
      "title": "第一章",
      "sections": [
        {
          "slug": "section-1",
          "title": "第一节",
          "source": "讲师引入 #mm-knowledge(slug: \"sequence-limit\")"
        }
      ]
    }
  ]
}
```

保存体中的每个小节只包含完整的 `source`，后端按普通文本原样保存，不解析、改写或校验其中的知识点引用。章节和小节自身的 `occurrence_id` 仍应在后续保存时保留。

前端展示时识别源码中的 `#mm-knowledge(slug: "sequence-limit")`，通过 `GET /api/knowledge-points/by-slug/sequence-limit` 读取当前有效知识点，并以响应中的永久 `id` 关联掌握状态。知识点不存在或归档时，详情接口返回 404，前端在该引用位置显示缺失占位并继续展示其他内容。其他请求失败应显示可重试的读取错误，不得默认为知识点不存在。知识点详情和公开讲义详情均返回 `Cache-Control: no-store`；再次读取可获取当前内容。

后端不会为引用生成实例标识，不返回引用 `references` 或引用 `warnings`，也不限制重复引用、复制和剪切。保存及审核流程不检查引用目标是否存在或公开；引用格式问题不妨碍源码保存。前端只需在渲染讲义时处理能识别的引用，首阶段不递归展开知识点正文中的引用。已存源码中的旧注释也不会被后端自动删除。

提交基于已保存草稿创建独立审核快照，冻结目录和原样源码，原草稿继续编辑。每份讲义同一时间最多有一个待审核快照，并发提交只有一次成功。审核使用返回的 `snapshot.id`；审核通过后发布快照，同时更新原草稿的来源版本和并发号，前端须重新读取草稿并保留本地未保存输入，发生冲突时提示作者处理。驳回不会改变公开版本。知识点正文不属于快照，前端再次请求时读取当前有效内容。

查看协作者只读，编辑协作者可以修改和提交；所有者或管理员可管理协作者及上下架。讲义必须先有审核通过的公开版本才能上架。下架或归档会取消推荐标记。

## 审核与发布

| 方法 | 路径 | 请求体或说明 |
| --- | --- | --- |
| GET | `/reviews/:kind/pending` | 管理员查看待审版本 |
| POST | `/reviews/:kind/:id` | 管理员提交 `decision` 和 `comment` |

`kind` 仅支持 `lecture`；`decision` 为 `approved` 或 `rejected`。审核记录与状态转换在同一事务完成。通过讲义审核会发布该完整讲义版本。推荐标记独立管理，不因审核通过自动开启。

审核通过时会检查草稿所基于的最近一个已审核版本是否仍是当前公开版本。若公开版本已变化，接口返回 409，作者应基于当前公开版本重新整理并提交。驳回不会改变当前公开版本。当前实现允许管理员审核自己的提交，是否禁止自审需要产品确认。

## 分类与搜索

| 方法 | 路径 | 请求体或说明 |
| --- | --- | --- |
| GET | `/categories/:kind` | 获取有效分类，种类为 `knowledge` 或 `lecture` |
| POST | `/categories/:kind` | 管理员提交 `slug`、`name`，可选 `parent_id`、`descr`、`pos` |
| PUT | `/categories/:kind/:id` | 管理员提交 `parent_id`、`name`、`descr`、`pos`、`status` |
| GET | `/search?q=关键词&limit=20` | 搜索公开知识点及公开讲义，返回 `hits` |

分类状态为 `active` 或 `archived`。分类和知识点前置关系的成环由数据库约束拒绝。

## 待确认规则

- 讲义所有者可下架和重新上架已审核版本，管理员可管理推荐；是否需要额外审核下架或重新上架。
- 管理员可以审核自己提交的版本；是否需要禁止自审。
- 审核通过自动发布，推荐默认关闭；是否采用自动推荐。

## 验证方式

运行 `npm test` 会执行不连接实际数据库的权限和参数测试，并跳过集成测试。集成测试需要另行准备名称以 `_test` 结尾且已应用本项目初始化脚本的独立数据库，再设置对应的数据库连接环境变量和 `MAKIMATH_INTEGRATION=1`，执行 `node --test test/integration.test.js`。测试会创建带随机标识的账号与内容，不会清库或自动应用脚本。

前置知识点并发替换可单独执行 `node --test test/prerequisites.integration.test.js`，使用相同的独立测试数据库和环境变量。

讲义搜索匹配讲义标题、简介和小节原始源码，不展开引用知识点的正文。知识点标题和正文作为知识点搜索结果返回。

目前讲义没有动画配置字段或动画接口。原知识点版本中的动画能力不属于新知识点模型，讲义动画关联方式尚待另行设计。
