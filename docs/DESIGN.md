# 设计说明：状态机、评分与版本迁移

## 单据状态机（`backend/src/domain.js`）

```
budget        draft ──submit──▶ submitted ──approve──▶ approved ──(月结级联)──▶ frozen
                              └─reject─▶ draft            ◀──unfreeze(月结重开)──┘
reimbursement draft ──submit──▶ submitted ──approve──▶ approved ──pay──▶ paid ──reverse──▶ draft
                              └─reject─▶ draft ◀─reject─┘
month_end     open ──close──▶ closed ──reopen──▶ open
```

业务前置（`businessGuard`）：
- 报销 submit/approve：存在 approved/frozen 预算；submit 时占用合计不得超预算。
- 月结 close：预算 approved 且无 submitted/approved 的报销。

级联（`cascades`）：month_end close → budget freeze；reopen → unfreeze。

## 评分算法（`services/grading.js::recomputeEnrollment`）

1. 取该报名所属课程版本的规则（`required_transitions`）。
2. 取该报名**有效转移**（`undone_at IS NULL AND undo_of_id IS NULL`），按时间排序。
3. 对每条期望 `{doc_type, action}` 用单调游标在有效转移中匹配 —— 只看状态转移，与点击次数/顺序中的噪声无关。
4. 前置节点未通过则 blocked；全部匹配且（无证据要求或证据 uploaded）→ passed；
   曾 passed 但匹配丢失 → needs_redo(BASIS_LOST)；证据 failed/missing → needs_redo(EVIDENCE_*)。
5. upsert `node_progress`，`rule_version` 记录评分时课程版本，`old_score` 跨版本保留原成绩。

阅读节点（required 为空）由 `/read` 单独置 `reading_done`，重算时跳过。

## 回滚（`services/ledger.js::rollbackTransition`）

- 目标转移 + 同单据其后有效转移全部 `undone_at=now()`；
- 若账套当前已月结，先把 close/freeze 一并撤销并写入 `reopen/unfreeze`（undo_of_id 指向原转移），旧月结截图置 failed；
- 其余转移写入 `rollback_*` 补偿行；单据状态按补偿流推进；`ledger_version+1`；
- 然后整报名重新评分。

## 版本迁移（`services/migration.js`）

- `buildComparison`：用旧有效转移去匹配新版本期望路径，给出每节点 inheritable/basis/reason，及两种模式的 projected_score。
- migrate：`createEnrollment` 后 `cloneLedger`（推进单据状态+复制转移）→ 克隆旧进度（score→old_score）→ 新版规则重算 → 阅读完成状态沿用。
- branch：新分支全新账套，旧 enrollment 不做任何写操作（只读保留）。
