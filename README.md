# 财务软件培训中心

面向财务软件教学的模拟训练系统：文档页讲解**报销 / 预算 / 月结**流程，练习服务维护每个学生独立的**虚构账套**，PostgreSQL 保存课程版本、评分规则与学习进度。

> ⚠️ **边界声明**：本系统不接入任何真实资金/支付系统，所有金额与单据均为虚构教学数据；系统不对任何业务操作出具财务、税务或合规结论。

## 核心设计

### 1. 训练操作有前置条件、且相互影响
- **预算**：`draft → submitted → approved →（月结自动）frozen`
- **报销**：`draft → submitted → approved → paid`，可 `reject` 退回；支付后可 `reverse/回滚`
- **月结**：`open → closed → reopen`
- 前置条件（服务端强校验，非前端隐藏）：
  - 报销提交前必须有**已批准预算**，且非草稿报销合计不得超预算（`PRECOND_BUDGET_NOT_APPROVED` / `BUDGET_EXCEEDED`）；
  - 月结要求预算已批准、**所有非草稿报销均已支付**（`PRECOND_OPEN_REIMBURSEMENTS`）。
- 相互影响：月结关闭**自动冻结预算**；已结账后撤回报销 → 月结自动重开、预算自动解冻。

### 2. 评分依据「状态转移」而非点击顺序
教师把每个练习节点的答案定义为一串期望的**状态转移**（`required_transitions: [{doc_type, action}, …]`）。
评分时从该报名**当前仍有效**的转移序列中按序匹配：多余点击、退回重做、额外噪声都不影响判定（见测试「乱序点击不影响通过」）。
节点状态四态：`pending`（未开始/进行中）、`reading_done`（阅读完成）、`passed`（练习通过）、`needs_redo`（依据丢失/截图失败，需重做）。

### 3. 撤回单据 → 后续步骤失去依据（事件溯源）
`transitions` 只追加（append-only）。回滚不是 DELETE，而是：
1. 标记目标及其同单据后续转移 `undone_at`；
2. 追加带 `undo_of_id` 的补偿转移（如 `rollback_pay`，月结用语义反向动作 `reopen`）；
3. 自动联动（已月结则重开月结+解冻预算，旧截图失效）；
4. 重新评分：原本 passed 的节点若匹配依据消失 → **needs_redo / BASIS_LOST_AFTER_ROLLBACK**。

### 4. 课程升级：两种迁移方式的比较与原成绩保留
规则修改只能在**新版本**上进行（`POST /api/teacher/courses/:id/new-version`，复制旧版本后改），旧版本评分永远不变。
学生在旧版本完成练习后，可先看 `upgrade-plan` 对比，再二选一：
- **migrate（迁移已完成节点）**：克隆旧账套到新版本，按新版规则重放转移；匹配上的节点继承并保留 `old_score` 原成绩快照，不兼容节点需重做；
- **branch（重开练习分支）**：旧分支只读冻结、原成绩保留，新分支从空白账套重练（分支名 `v2-branch`）。
节点级返回「继承依据」（匹配到的具体转移）或不兼容原因。

### 5. 安全隔离：学生拿不到教师答案
- 学生侧 `GET /api/courses/:cv/material` 经 `studentRule()` 白名单序列化，**永远不返回 `required_transitions`**；
- 教师答案只在 `/api/teacher/*`（角色中间件 403，学生 token 直接拒绝）——浏览器隐藏不算隔离；
- 学生只能访问自己的报名（他人 ID 一律 404）。

### 6. 并发 / 离线 / 证据
- **幂等**：每个动作带 `client_op_id`，服务端 `(enrollment_id, client_op_id)` 唯一；断线重放、双设备重复提交不重复入账。
- **两设备并发**：动作可带 `expected_version`（`ledger_version` 乐观锁），过期提交返回 **409 VERSION_CONFLICT** 与最新版本号；
- **离线补交**：`POST /sync` 逐动作处理，分别统计 applied / duplicate / rejected，单个非法动作不阻断整批；
- **截图失败**：月结节点要求证据；证据 `failed`（或回滚失效）→ needs_redo，重传成功后恢复 passed。
- **刷新恢复**：云端为唯一事实来源，`GET /state` 返回账套、全部转移、进度、证据与版本号。

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | 原生 HTML/CSS/JS SPA（无构建），`frontend/` |
| 后端 | Node.js + Express，`backend/src/` |
| 数据库 | **真实 PostgreSQL**（生产 `docker-compose`；本地无 root 时用 `embedded-postgres` 跑官方 PG 二进制，无需 Docker/sudo） |
| 测试 | `node:test` + 真实 PG，每个用例独立库实例 |

## 运行

```bash
cd backend
npm install
npm start          # 自动启动 embedded PG(55432)、建表、种子数据，监听 :3000
# 生产：DATABASE_URL=postgres://user:pass@host/db npm start，或 docker compose up --build
```

启动日志会打印 teacher1 / student1 的登录 token；也可 `POST /api/auth/login {"username":"teacher1|student1|student2"}` 获取。
浏览器打开 http://localhost:3000 ，可用顶栏按钮切换教师/学生身份体验。

种子课程：`fin_core` 财务软件操作 v1，及规则升级 **v2**（报销练习新增「提交→退回→再提交」的严谨路径，用于演示旧练习与新评分不兼容）。

## 测试（验收点对应）

```bash
cd backend && npm test     # 15 个用例，全部基于真实 PostgreSQL
```

| 文件 | 覆盖验收点 |
|---|---|
| `test/01-basic-flow` | 阅读/练习/三态；状态转移评分与点击顺序无关；前置条件；**学生答案隔离** |
| `test/02-rollback` | 撤回报销 → 月结重开/预算解冻/needs_redo；事件只追加；禁止重复回滚 |
| `test/03-offline-concurrency` | 离线补交（幂等/逐动作容错）；两设备 409 冲突与刷新重试；重放不重复 |
| `test/04-evidence` | 截图失败 needs_redo、重传恢复；缺证据不通过 |
| `test/05-migration-rules` | 升级计划比较；migrate 继承+原成绩保留；branch 冻结；规则变更只影响新版；刷新恢复；越权 404 |

## 主要 API

```
POST /api/auth/login
GET  /api/catalog
GET  /api/courses/:cvId/material                 # 学生（无答案）
GET  /api/courses/:cvId/pages/:slug
POST /api/enrollments
GET  /api/enrollments/:id/state                  # 刷新恢复
POST /api/enrollments/:id/actions                # 单动作（可带 expected_version）
POST /api/enrollments/:id/sync                   # 离线批量补交
POST /api/enrollments/:id/rollback               # 事件溯源回滚
POST /api/enrollments/:id/read                   # 阅读完成
POST /api/enrollments/:id/evidence[?fail=1]      # 截图证据/模拟失败
GET  /api/enrollments/:id/upgrade-plan?to_cv_id= # 两种迁移方式比较
POST /api/enrollments/:id/upgrade                # mode=migrate|branch
GET  /api/teacher/course-versions/:cvId/rules    # 教师（含答案；学生 403）
POST /api/teacher/courses/:courseId/new-version  # 规则变更发新版
GET  /api/teacher/enrollments/:id/progress
```

## 数据模型（见 `backend/src/schema.sql`）

`users / courses / course_versions / grading_rules / doc_pages / enrollments /
docs / transitions(事件) / node_progress(含 rule_version 与 old_score) / evidences / migrations`
