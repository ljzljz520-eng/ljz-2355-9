# 财务软件培训中心（模拟）

报销 / 预算 / 月结三大模拟流程的教学系统：**文档页**展示操作指南；**练习服务**在虚构账套上
以事件溯源（event sourcing）维护状态；**PostgreSQL** 保存课程版本、评分规则与学习进度。

> ⚠️ 仅用于软件操作训练：账套、部门、金额均为虚构；**不接入真实资金系统，也不提供财务合规结论**。

## 它如何对应需求

| 需求 | 实现 |
|---|---|
| 文档页：报销/预算/月结模拟流程 | `src/catalog.js` 三个 reading 节点；`GET /api/courses/:id` 返回正文 |
| 练习服务维护虚构账套状态 | `src/engine/ledger.js` 事件折叠（预算、报销单、会计期间状态机） |
| PG 保存课程版、评分规则、学习进度 | `scripts/schema.sql` + `src/adapters/pgRepo.js`（事件/成绩/阅读/分支/截图） |
| 操作有前置条件、相互影响 | `ledger.fold/validate`：预算审批与余额、单据生命周期、结账拦截、撤回/反结账级联 |
| 撤回单据使后续步骤失去依据 | `grade.annulPlan`：撤回废止该单全部生命周期事件；反结账废止原结账；评分项标 `lostAtSeq` |
| 评分依据状态转移而非点击顺序 | `grade.gradeExercise`：在“当前仍有效”的事件集合中匹配 required 转移，与点击先后无关；非法点击只记 `invalid` 审计，不产生转移、不计分 |
| 不接真实资金/不出合规结论 | 页头与文档显著声明；全部金额虚构，无任何外部资金接口 |
| 课程升级，练习数据/旧评分可能不兼容 | 版本指纹：阅读比对正文 hash，练习比对规则 hash；`GET /api/migrations/.../preview` |
| 比较“迁移已完成节点”与“重开练习分支” | 预览给出 inherit / incompatible / redo_reading / fresh；执行时逐节点选择；旧分支归档、成绩以 `inherited`/原样保留，永不覆盖 |
| 继承依据及原成绩保留 | 继承复制事件流（重映射 id/annuls）并复制成绩快照；`grades.origin = inherited` |
| 学生接口不得取得教师答案（浏览器隐藏不算隔离） | 服务端角色序列化 `catalog.toStudentNode`：剥离 `seed`、`rule.required.type/ref`，只留任务文案；教师接口 403，答案不进学生响应体/前端包 |
| 离线进度补交 | 前端 localStorage 队列 + `POST .../sync` 批量顺序补交；服务端 `client_op_id` 幂等；单项拒绝不阻塞队列 |
| 两设备同时操作 | 同分支 `pg_advisory_xact_lock`（内存适配器为进程内互斥）串行化；事件带 `device_id`，seq 连续唯一 |
| 规则变更 | v1→v2 月结规则改为“必须截图”；规则 hash 不同 → 判不兼容；历史成绩按当时规则快照保留 |
| 截图失败 | 失败注入（教师开关）返回 503，**练习/账套进度保留**，可重试；必需截图未交时 `passed=false` 但状态转移分照算 |
| 练习回滚 | `POST .../rollback`：在 seq 处分叉新分支，旧分支归档，原成绩保留，新分支继承 fork 点成绩 |
| 阅读完成 / 练习通过 / 需重做 三态 | 进度状态：`READ_DONE` / `PRACTICE_PASSED` / `NEEDS_REWORK`（曾通过但最新证据失效）/ `NOT_STARTED`，侧边栏徽章区分 |
| 云端状态刷新后恢复 | 所有状态由 PG 事件流重放得到；重登/刷新 `GET /api/progress` 即恢复 |

## 运行

需要 Node 18+。PostgreSQL 可选（不设置 `DATABASE_URL` 时用内存仓储，仅用于快速体验）。

```bash
npm install

# 方式 A：内存仓储（数据不持久）
npm start

# 方式 B：PostgreSQL
#   已有 PG：
export DATABASE_URL='postgres://user:pass@localhost:5432/finance_training'
npm start
#   本机无 root 时（Debian 系），脚本会下载官方 deb 并解压到 /tmp，在 5433 启动：
scripts/pg-local.sh start
npm run start:pg
```

打开 http://localhost:3000 ，演示账号：`alice` / `bob`（学生）、`teacher1`（教师），任意新用户名也可登录。

## 测试

```bash
npm test                      # 内存适配器：5 个引擎单测 + 12 个 HTTP 验收测试
scripts/pg-local.sh start
npm run test:pg               # 同一套 17 项对真实 PostgreSQL 执行
```

验收测试覆盖：① 报销全流程与状态转移分 ② 撤回失据→需重做 ③ 预算超额/月结拦截/反结账
④ 刷新与重登恢复 ⑤ 离线补交与幂等 ⑥ 两设备并发 seq 一致 ⑦ v1→v2 规则变更与不兼容迁移
⑧ 截图失败 503 与重试 ⑨ 回滚分叉与原成绩保留 ⑩ 学生拿不到答案/教师 403 ⑪ 前置锁定 ⑫ 兼容节点继承。

## HTTP 接口（摘）

```
POST /api/auth/login
POST /api/enrollments
GET  /api/courses/:courseId                 # 学生视图（无答案）；教师账号返回教师视图仍不含 seed 以外的泄露
GET  /api/progress/:courseId                # 三态进度 + 分支信息
POST /api/progress/:courseId/read/:nodeKey  # 阅读完成（按内容 hash 记录）
GET  /api/practice/:courseId/:nodeKey       # 账套状态、事件流、最近评分、截图
POST /api/practice/:courseId/:nodeKey/ops   # 单次操作（非法→422 + 审计事件）
POST /api/practice/:courseId/:nodeKey/sync  # 离线批量补交（clientOpId 幂等）
POST /api/practice/:courseId/:nodeKey/screenshot
POST /api/practice/:courseId/:nodeKey/rollback
GET  /api/migrations/:courseId/preview/:v
POST /api/migrations/:courseId/migrate/:v
GET  /api/teacher/courses/:courseId         # 含 expected 转移/seed（仅教师）
POST /api/teacher/debug/screenshot-failure  # 截图失败注入开关（仅教师）
```

## 目录

```
src/catalog.js            课程版本/文档/练习种子事件与评分规则（含角色序列化）
src/engine/ledger.js      虚构账套事件折叠 + 前置条件状态机
src/engine/grade.js       状态转移证据评分、撤回/反结账废止计划
src/services.js           进度、练习操作、截图、回滚、版本迁移（不依赖存储实现）
src/adapters/memoryRepo.js  内存仓储（同契约，测试用）
src/adapters/pgRepo.js       PostgreSQL 仓储（咨询锁 + 事务）
src/app.js / src/server.js  HTTP 层与启动
public/                   原生 JS SPA（离线队列、操作面板、迁移向导、教师工作台）
scripts/schema.sql        表结构；scripts/pg-local.sh 无 root 本地 PG
test/                     引擎单测 + 12 项端到端验收（两适配器共用）
```

## 关键设计说明

- **事件溯源**：每个练习分支是只追加事件流；种子事件（虚构初始账套）seq 从 0 起。回滚/迁移通过
  物化复制事件产生新分支，不修改任何历史行；成绩表只追加。
- **无效操作也留痕**：不满足前置条件的点击写 `kind=invalid` 事件（带错误码），用于审计与教学反馈，
  但既不折叠进账套，也不作为评分转移。
- **截图与状态解耦**：上传失败不回滚账套；“必需截图”只影响最终 `passed`，前端明确提示重试。
