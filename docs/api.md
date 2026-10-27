# 后端接口契约

本文描述知识点与讲义模型的首版接口。旧课程和小节接口已移除，前端需要按本文适配。

## 通用约定

- 基础路径为 `/api`。
- 除公钥接口外，请求继续使用现有通信加解密协议。客户端使用 `GET /api/auth/pubkey` 获取服务端公钥；请求体加密为 `{ "d": "..." }`，成功响应也按同一协议解密。错误响应为普通 JSON。
- 登录后使用 `Authorization: Bearer <access_token>`。所有身份和权限由服务端确认，请求不能指定所有者、贡献者或审核人。
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

邀请码的 `role` 可以是 `editor` 或 `super_admin`。首个管理员需要由部署流程创建，初始化脚本不提供默认密码。

## 知识点

| 方法 | 路径 | 请求体或说明 |
| --- | --- | --- |
| GET | `/knowledge-points` | 公开知识点列表 |
| GET | `/knowledge-points/:id` | 公开知识点当前版本 |
| GET | `/knowledge-points/:id/revisions/:revisionId` | 读取该知识点已审核版本 |
| POST | `/knowledge-points` | 登录用户提交 `slug`、`title`、`source`，返回 `point` 和首个草稿 `revision` |
| GET | `/knowledge-revisions/mine` | 当前贡献者的版本列表 |
| GET | `/knowledge-revisions/:id` | 贡献者或管理员读取非公开版本，已审核版本可由登录用户读取 |
| POST | `/knowledge-points/:id/revisions` | 提交 `based_on_id`，复制版本创建当前用户的草稿 |
| PUT | `/knowledge-revisions/:id` | 完整保存草稿 |
| POST | `/knowledge-revisions/:id/submit` | 提交 `edit_version` 进入审核 |
| GET | `/knowledge-points/:id/prerequisites` | 获取可公开的前置知识点 |
| PUT | `/knowledge-points/:id/prerequisites` | 管理员提交 `{ "prerequisites": [1, 2] }` |
| PUT | `/knowledge-points/:id/categories` | 管理员提交 `{ "categories": [1, 2] }` |
| PATCH | `/knowledge-points/:id/status` | 管理员提交 `status`，取值为 `active`、`disabled` 或 `archived` |

知识点草稿保存请求体字段全部必填：

```json
{
  "edit_version": 1,
  "title": "数列极限的定义",
  "summary": "",
  "source": "知识点正文",
  "animation": null,
  "metadata": {},
  "change_note": "补充定义"
}
```

`animation` 可以为对象或 `null`，任何层级都不允许包含 `scenes_code` 或同名变体。现有前端会执行该字段，暂时禁用以保护读者。`metadata` 为对象。已提交版本不可直接修改或再次提交。创建新版本时只能复制已提交版本，以保证来源版本内容稳定。

## 讲义

| 方法 | 路径 | 请求体或说明 |
| --- | --- | --- |
| GET | `/lectures` | 公开讲义列表，包含推荐标记 |
| GET | `/lectures/:id` | 读取当前公开讲义完整版本 |
| GET | `/lectures/mine` | 登录用户有权访问的讲义列表 |
| POST | `/lectures` | 提交 `slug`、`title`，返回 `lecture` 和首个草稿 `revision` |
| GET | `/lectures/:id/revisions` | 读取有权访问的讲义版本列表 |
| POST | `/lectures/:id/revisions` | 提交 `based_on_id`，复制完整版本和内容块生成草稿 |
| GET | `/lecture-revisions/:id` | 读取有权访问的完整版本 |
| PUT | `/lecture-revisions/:id` | 以完整目录树替换草稿 |
| POST | `/lecture-revisions/:id/submit` | 提交 `edit_version` 进入审核 |
| GET | `/lectures/:id/collaborators` | 有权查看讲义的用户读取协作者 |
| PUT | `/lectures/:id/collaborators/:userId` | 所有者或管理员提交 `permission`，取值为 `view` 或 `edit` |
| DELETE | `/lectures/:id/collaborators/:userId` | 所有者或管理员移除协作者 |
| PATCH | `/lectures/:id/publication` | 所有者或管理员设置 `publication_status`，推荐标记 `is_recommended` 仅管理员可设置 |

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
          "blocks": [
            { "block_type": "author", "source": "讲师引入" },
            { "block_type": "knowledge_reference", "knowledge_point_id": 1, "knowledge_revision_id": 1 }
          ]
        }
      ]
    }
  ]
}
```

保存时按数组顺序生成章节、小节和内容块顺序。每一级可提供 `occurrence_id`，省略时服务端生成。读取后再次保存应保留原有实例标识，以便批注定位；复制已提交版本会保留实例标识。表内行标识可能因完整保存而变化，前端不能用它作为跨保存稳定标识。

作者内容块必须有 `source`，可选对象类型的 `animation`。知识点引用块必须提供匹配的知识点标识和已审核版本标识，不允许携带正文或动画副本。完整版本返回引用版本的 `knowledge_title`、`knowledge_source` 等字段供阅读，这些字段不是保存请求字段。

查看协作者只读，编辑协作者可以修改和提交；所有者或管理员可管理协作者及上下架。讲义必须先有审核通过的公开版本才能上架。下架或归档会取消推荐标记。

## 审核与发布

| 方法 | 路径 | 请求体或说明 |
| --- | --- | --- |
| GET | `/reviews/:kind/pending` | 管理员查看待审版本 |
| POST | `/reviews/:kind/:id` | 管理员提交 `decision` 和 `comment` |

`kind` 为 `knowledge` 或 `lecture`；`decision` 为 `approved` 或 `rejected`。审核记录与状态转换在同一事务完成。通过知识点审核会更新该知识点的公开版本；通过讲义审核会发布该完整讲义版本。推荐标记独立管理，不因审核通过自动开启。

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
- 知识点停用后，它的公开详情不可直接读取，但已发布讲义仍读取固定引用的版本；是否需要调整展示策略。
- 审核通过自动发布，推荐默认关闭；是否采用自动推荐。

## 验证方式

运行 `npm test` 会执行不连接实际数据库的权限和参数测试，并跳过集成测试。集成测试需要另行准备名称以 `_test` 结尾且已应用本项目初始化脚本的独立数据库，再设置对应的数据库连接环境变量和 `MAKIMATH_INTEGRATION=1`，执行 `node --test test/integration.test.js`。测试会创建带随机标识的账号与内容，不会清库或自动应用脚本。

前置知识点并发替换可单独执行 `node --test test/prerequisites.integration.test.js`，使用相同的独立测试数据库和环境变量。
