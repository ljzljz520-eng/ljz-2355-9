/* 验收测试：前置依赖、状态转移评分、撤回失据、刷新恢复、离线补交、
   两设备并发、规则变更/迁移、截图失败、练习回滚、答案隔离。 */
'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { makeRepo, startServer, login, postJson, getJson, completeAllReadings } = require('./helpers');

const CID = 'finance101';
let env;
let base, stop, repo;

beforeEach(async () => {
  env = await makeRepo();
  repo = env.repo;
  const s = await startServer(repo);
  base = s.base; stop = async () => { await s.stop(); await env.stop(); };
});
afterEach(async () => { await stop(); });

test('1. 报销全流程：按状态转移评分，顺序无关', async () => {
  const { token } = await login(base, 'alice');
  await postJson(`${base}/api/enrollments`, token, { courseId: CID, version: '1.0.0' });
  await completeAllReadings(base, token, CID);
  const op = (type, payload) => postJson(`${base}/api/practice/${CID}/ex-reimburse/ops`, token, { type, payload });

  // 前置条件：结账期间/预算等约束生效——直接付款（无单据）应被拒绝
  const bad = await op('CLAIM_PAY', { claimId: 'C-101' });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.rejected.code, 'CLAIM_MISSING');

  const a = await op('CLAIM_CREATE', { claimId: 'C-101', dept: 'SALES', month: '2026-09', amount: 1200, desc: '差旅费' });
  assert.equal(a.status, 200); assert.equal(a.body.grading.score, 25);
  assert.equal(a.body.grading.items[0].achieved, true);

  await op('CLAIM_SUBMIT', { claimId: 'C-101' });
  await op('CLAIM_APPROVE', { claimId: 'C-101' });
  const p = await op('CLAIM_PAY', { claimId: 'C-101' });
  assert.equal(p.body.grading.score, 100);
  assert.equal(p.body.grading.passed, true);

  // 预算占用与剩余额度
  assert.equal(p.body.ledger.budgetRemaining.find((b) => b.dept === 'SALES').remaining, 3800);

  // 页面状态：练习通过
  const prog = (await getJson(`${base}/api/progress/${CID}`, token)).body;
  assert.equal(prog.nodes.find((n) => n.nodeKey === 'ex-reimburse').status, 'PRACTICE_PASSED');
});

test('2. 撤回模拟单据使后续步骤失去依据，状态变为需重做', async () => {
  const { token } = await login(base, 'alice');
  await postJson(`${base}/api/enrollments`, token, { courseId: CID, version: '1.0.0' });
  await completeAllReadings(base, token, CID);
  const op = (type, payload) => postJson(`${base}/api/practice/${CID}/ex-reimburse/ops`, token, { type, payload });
  for (const [t, pl] of [
    ['CLAIM_CREATE', { claimId: 'C-101', dept: 'SALES', month: '2026-09', amount: 1200, desc: '差旅费' }],
    ['CLAIM_SUBMIT', { claimId: 'C-101' }],
    ['CLAIM_APPROVE', { claimId: 'C-101' }],
    ['CLAIM_PAY', { claimId: 'C-101' }],
  ]) await op(t, pl);

  const w = await op('CLAIM_WITHDRAW', { claimId: 'C-101' });
  assert.equal(w.status, 200);
  // 付款后、月份打开时允许撤回；全部生命周期证据废止 -> 0 分，需重做
  assert.equal(w.body.grading.score, 0);
  assert.equal(w.body.grading.passed, false);
  assert.ok(w.body.grading.items.every((i) => !i.achieved));
  assert.match(w.body.grading.items[0].reason, /依据被撤回/);

  const prog = (await getJson(`${base}/api/progress/${CID}`, token)).body;
  assert.equal(prog.nodes.find((n) => n.nodeKey === 'ex-reimburse').status, 'NEEDS_REWORK');
  assert.equal(prog.nodes.find((n) => n.nodeKey === 'ex-reimburse').passedEver, true); // 曾通过

  // 重新建单（新单号）走完整流程可再次通过
  for (const [t, pl] of [
    ['CLAIM_CREATE', { claimId: 'C-102', dept: 'SALES', month: '2026-09', amount: 300, desc: '打车' }],
    ['CLAIM_SUBMIT', { claimId: 'C-102' }],
    ['CLAIM_APPROVE', { claimId: 'C-102' }],
    ['CLAIM_PAY', { claimId: 'C-102' }],
  ]) {
    const r = await op(t, pl);
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  }
  // C-101 的期望转移已被撤回废止且不会再回来 -> 仍无法满足原规则（说明重做必须重建同号或重开分支）
  const again = (await getJson(`${base}/api/practice/${CID}/ex-reimburse`, token)).body;
  assert.equal(again.grading.passed, false);
});

test('3. 前置条件联动：预算超额、月结未完结拦截、反结账级联', async () => {
  const { token } = await login(base, 'bob');
  await postJson(`${base}/api/enrollments`, token, { courseId: CID, version: '1.0.0' });
  await completeAllReadings(base, token, CID);

  // 月结：种子里 C-201 已付款，可直接结账
  let r = await postJson(`${base}/api/practice/${CID}/ex-month/ops`, token, { type: 'MONTH_CLOSE', payload: { month: '2026-09' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.grading.passed, true);

  // 结账后再结账被拒绝
  r = await postJson(`${base}/api/practice/${CID}/ex-month/ops`, token, { type: 'MONTH_CLOSE', payload: { month: '2026-09' } });
  assert.equal(r.status, 422);
  assert.equal(r.body.rejected.code, 'MONTH_ALREADY_CLOSED');

  // 反结账：原结账证据废止 -> 需重做
  r = await postJson(`${base}/api/practice/${CID}/ex-month/ops`, token, { type: 'MONTH_REOPEN', payload: { month: '2026-09' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.grading.passed, false);
  assert.match(r.body.grading.items[0].reason, /反结账/);

  // 预算练习：超额校验（先报 8000 并批掉，再建一张超额单据）
  await postJson(`${base}/api/practice/${CID}/ex-budget/ops`, token, { type: 'BUDGET_PROPOSE', payload: { dept: 'ADMIN', month: '2026-09', amount: 8000 } });
  await postJson(`${base}/api/practice/${CID}/ex-budget/ops`, token, { type: 'BUDGET_APPROVE', payload: { dept: 'ADMIN', month: '2026-09' } });
  r = await postJson(`${base}/api/practice/${CID}/ex-budget/ops`, token, {
    type: 'CLAIM_CREATE', payload: { claimId: 'X1', dept: 'ADMIN', month: '2026-09', amount: 9001, desc: '超额' },
  });
  assert.equal(r.status, 422);
  assert.equal(r.body.rejected.code, 'BUDGET_EXCEEDED');
});

test('4. 刷新后云端状态恢复', async () => {
  const { token } = await login(base, 'alice');
  await postJson(`${base}/api/enrollments`, token, { courseId: CID, version: '1.0.0' });
  await completeAllReadings(base, token, CID);
  await postJson(`${base}/api/practice/${CID}/ex-budget/ops`, token, { type: 'BUDGET_PROPOSE', payload: { dept: 'ADMIN', month: '2026-09', amount: 8000 } });
  // 重新登录（新 token，同一用户），状态应从云端重建
  const again = await login(base, 'alice');
  const view = (await getJson(`${base}/api/practice/${CID}/ex-budget`, again.token)).body;
  assert.equal(view.ledger.budgets[0].status, 'PROPOSED');
  const prog = (await getJson(`${base}/api/progress/${CID}`, again.token)).body;
  assert.equal(prog.nodes.find((n) => n.nodeKey === 'doc-budget').status, 'READ_DONE');
});

test('5. 离线进度补交 + clientOpId 幂等（重复补交不重复入账）', async () => {
  const { token } = await login(base, 'alice');
  await postJson(`${base}/api/enrollments`, token, { courseId: CID, version: '1.0.0' });
  await completeAllReadings(base, token, CID);
  const ops = [
    { clientOpId: 'c1', type: 'BUDGET_PROPOSE', payload: { dept: 'ADMIN', month: '2026-09', amount: 8000 }, deviceId: 'dev-A' },
    { clientOpId: 'c2', type: 'BUDGET_APPROVE', payload: { dept: 'ADMIN', month: '2026-09' }, deviceId: 'dev-A' },
    // 离线期间不可能知道状态，学生可能重复点击审批 -> 同 opId 幂等；不同 opId 的重复审批被拒绝
    { clientOpId: 'c2dup', type: 'BUDGET_APPROVE', payload: { dept: 'ADMIN', month: '2026-09' }, deviceId: 'dev-A' },
  ];
  const r = await postJson(`${base}/api/practice/${CID}/ex-budget/sync`, token, { ops, deviceId: 'dev-A' });
  assert.equal(r.body.results[0].status, 'applied');
  assert.equal(r.body.results[1].status, 'applied');
  assert.equal(r.body.results[2].status, 'rejected');
  assert.equal(r.body.current.grading.passed, true);

  // 同一队列再次补交：c1/c2 幂等回放
  const r2 = await postJson(`${base}/api/practice/${CID}/ex-budget/sync`, token, { ops, deviceId: 'dev-A' });
  assert.equal(r2.body.results[0].idempotent, true);
  assert.equal(r2.body.results[1].idempotent, true);

  const view = (await getJson(`${base}/api/practice/${CID}/ex-budget`, token)).body;
  const valid = view.events.filter((e) => e.kind !== 'invalid');
  assert.equal(valid.length, 2); // 只有两次有效转移
});

test('6. 两设备同时操作：同分支串行化，seq 连续无丢失', async () => {
  const { token } = await login(base, 'alice');
  await postJson(`${base}/api/enrollments`, token, { courseId: CID, version: '1.0.0' });
  await completeAllReadings(base, token, CID);
  // 先建立 ADMIN 预算并批掉
  await postJson(`${base}/api/practice/${CID}/ex-budget/ops`, token, { type: 'BUDGET_PROPOSE', payload: { dept: 'ADMIN', month: '2026-09', amount: 80000 } });
  await postJson(`${base}/api/practice/${CID}/ex-budget/ops`, token, { type: 'BUDGET_APPROVE', payload: { dept: 'ADMIN', month: '2026-09' } });

  // 两设备并发各建 8 张单据
  const mk = (dev, prefix) => Promise.all(Array.from({ length: 8 }, (_, i) =>
    postJson(`${base}/api/practice/${CID}/ex-budget/ops`, token, {
      type: 'CLAIM_CREATE',
      payload: { claimId: `${prefix}-${i}`, dept: 'ADMIN', month: '2026-09', amount: 10, desc: dev },
      clientOpId: `${prefix}-${i}`, deviceId: dev,
    })));
  const [ra, rb] = await Promise.all([mk('dev-A', 'A'), mk('dev-B', 'B')]);
  const all = [...ra, ...rb];
  assert.equal(all.filter((x) => x.status === 200).length, 16);

  const view = (await getJson(`${base}/api/practice/${CID}/ex-budget`, token)).body;
  const seqs = view.events.filter((e) => e.type === 'CLAIM_CREATE').map((e) => e.seq);
  assert.equal(new Set(seqs).size, seqs.length); // seq 唯一
  assert.equal(view.ledger.claims.length, 16);
  const devs = new Set(view.events.map((e) => e.deviceId).filter(Boolean));
  assert.deepEqual([...devs].sort(), ['dev-A', 'dev-B']);
});

test('7. 规则变更：v2 月结要求截图；迁移对比，不兼容节点重开且原成绩保留', async () => {
  const { token } = await login(base, 'alice');
  await postJson(`${base}/api/enrollments`, token, { courseId: CID, version: '1.0.0' });
  await completeAllReadings(base, token, CID);
  // v1 完成月结（无截图即可通过）
  const c = await postJson(`${base}/api/practice/${CID}/ex-month/ops`, token, { type: 'MONTH_CLOSE', payload: { month: '2026-09' } });
  assert.equal(c.body.grading.passed, true);

  // 预览迁移：报销规则一致可继承；月结规则变更不兼容；月结文档更新需重读
  const pv = (await getJson(`${base}/api/migrations/${CID}/preview/2.0.0`, token)).body;
  assert.equal(pv.summary.inherit, 2); // doc-reimburse + doc-budget（ex-reimburse 未做，算 fresh）
  assert.equal(pv.summary.incompatible, 1);
  assert.equal(pv.nodes.find((n) => n.nodeKey === 'ex-month').oldScore, 100);

  await postJson(`${base}/api/migrations/${CID}/migrate/2.0.0`, token, { choices: { 'ex-month': 'new' } });

  // 迁移后：月结新分支为全新状态，需重新结账+截图；旧分支与 100 分成绩保留
  const view = (await getJson(`${base}/api/practice/${CID}/ex-month`, token)).body;
  assert.equal(view.node.requiresScreenshot, true);
  assert.equal(view.branch.origin, 'native');
  assert.equal(view.grading, null);

  // 归档旧分支仍可查（成绩保留）——直接查库验证
  const oldBranches = await repo.listBranches((await repo.findUserByUsername("alice")).id, CID, "ex-month");
  const archived = oldBranches.filter((b) => b.status === 'archived');
  assert.ok(archived.length >= 1);
  const grades = await repo.listGrades(archived[0].id);
  assert.ok(grades.some((g) => g.score === 100 && g.passed));

  // v2：只结账不传截图 -> 不通过
  const close = await postJson(`${base}/api/practice/${CID}/ex-month/ops`, token, { type: 'MONTH_CLOSE', payload: { month: '2026-09' } });
  assert.equal(close.body.grading.score, 100);
  assert.equal(close.body.grading.passed, false);
  assert.equal(close.body.grading.screenshotOk, false);
});

test('8. 截图失败：操作进度保留，可重试上传后通过', async () => {
  const { token } = await login(base, 'teacher1');
  const { token: st } = await login(base, 'alice');
  await postJson(`${base}/api/enrollments`, st, { courseId: CID, version: '2.0.0' });
  await completeAllReadings(base, st, CID);
  await postJson(`${base}/api/practice/${CID}/ex-month/ops`, st, { type: 'MONTH_CLOSE', payload: { month: '2026-09' } });

  // 教师开启失败注入
  const inj = await postJson(`${base}/api/teacher/debug/screenshot-failure`, token, { enabled: true });
  assert.equal(inj.body.forceScreenshotFail, true);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
  const fail = await postJson(`${base}/api/practice/${CID}/ex-month/screenshot`, st,
    { filename: 'close.png', dataUrl: `data:image/png;base64,${png.toString('base64')}` });
  assert.equal(fail.status, 503);
  assert.equal(fail.body.error.code, 'SHOT_STORE_FAILED');
  // 账套事件仍在
  let view = (await getJson(`${base}/api/practice/${CID}/ex-month`, st)).body;
  assert.equal(view.ledger.months[0].status, 'CLOSED');

  await postJson(`${base}/api/teacher/debug/screenshot-failure`, token, { enabled: false });
  const ok2 = await postJson(`${base}/api/practice/${CID}/ex-month/screenshot`, st,
    { filename: 'close.png', dataUrl: `data:image/png;base64,${png.toString('base64')}` });
  assert.equal(ok2.status, 201);
  assert.equal(ok2.body.stored, true);
  assert.equal(ok2.body.grading.passed, true);

  view = (await getJson(`${base}/api/practice/${CID}/ex-month`, st)).body;
  assert.equal(view.screenshots.length, 1);
});

test('9. 练习回滚：分叉新分支、旧分支归档、原成绩保留', async () => {
  const { token } = await login(base, 'alice');
  await postJson(`${base}/api/enrollments`, token, { courseId: CID, version: '1.0.0' });
  await completeAllReadings(base, token, CID);
  const op = (type, payload) => postJson(`${base}/api/practice/${CID}/ex-reimburse/ops`, token, { type, payload });
  for (const [t, pl] of [
    ['CLAIM_CREATE', { claimId: 'C-101', dept: 'SALES', month: '2026-09', amount: 1200, desc: '差旅费' }],
    ['CLAIM_SUBMIT', { claimId: 'C-101' }],
    ['CLAIM_APPROVE', { claimId: 'C-101' }],
  ]) await op(t, pl);

  const before = (await getJson(`${base}/api/practice/${CID}/ex-reimburse`, token)).body;
  const oldBranch = before.branch.id;
  const rb = await postJson(`${base}/api/practice/${CID}/ex-reimburse/rollback`, token, {});
  assert.equal(rb.status, 201);
  assert.equal(rb.body.forkedFrom, oldBranch);
  // 新分支：事件只保留到 fork 点（种子2 + 建单/提交 = seq0..3），审批被回滚
  assert.equal(rb.body.copiedEvents, 4);
  assert.equal(rb.body.grading.score, 50);

  const after = (await getJson(`${base}/api/practice/${CID}/ex-reimburse`, token)).body;
  assert.equal(after.branch.id, rb.body.branchId);
  assert.equal(after.branch.origin, 'rollback');
  assert.equal(after.ledger.claims[0].status, 'SUBMITTED');

  // 旧分支归档且成绩保留
  const oldGrades = await repo.listGrades(oldBranch);
  assert.ok(oldGrades.some((g) => g.score === 75));
  const oldB = await repo.getBranch(oldBranch);
  assert.equal(oldB.status, 'archived');
  // 新分支保留 inherited 成绩快照
  const newGrades = await repo.listGrades(rb.body.branchId);
  assert.ok(newGrades.some((g) => g.origin === 'inherited'));
});

test('10. 学生接口不得取得教师答案（服务端剥离，非浏览器隐藏）', async () => {
  const { token } = await login(base, 'alice');
  await postJson(`${base}/api/enrollments`, token, { courseId: CID, version: '1.0.0' });
  const course = (await getJson(`${base}/api/courses/${CID}`, token)).body;
  const ex = course.nodes.find((n) => n.key === 'ex-reimburse');
  assert.equal(ex.seed, undefined);
  assert.equal(ex.rule, undefined);
  assert.ok(Array.isArray(ex.tasks));
  assert.equal(ex.tasks[0].type, undefined);
  assert.equal(ex.tasks[0].ref, undefined);
  assert.ok(typeof ex.tasks[0].label === 'string');

  // 练习视图同样无答案
  const view = (await getJson(`${base}/api/practice/${CID}/ex-reimburse`, token)).body;
  assert.equal(view.node.seed, undefined);
  assert.equal(view.node.rule, undefined);

  // 教师接口 403 for student
  const denied = await getJson(`${base}/api/teacher/courses/${CID}`, token);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'FORBIDDEN');

  // 教师可以看到完整规则与种子
  const t = await login(base, 'teacher1');
  const tc = (await getJson(`${base}/api/teacher/courses/${CID}`, t.token)).body;
  const tex = tc.versions[0].nodes.find((n) => n.key === 'ex-reimburse');
  assert.ok(Array.isArray(tex.rule.required));
  assert.equal(tex.rule.required[0].type, 'CLAIM_CREATE');
  assert.ok(Array.isArray(tex.seed));
});

test('11. 前置节点未完成时练习锁定（由进度接口表达）', async () => {
  const { token } = await login(base, 'alice');
  await postJson(`${base}/api/enrollments`, token, { courseId: CID, version: '1.0.0' });
  // 不读文档
  const prog = (await getJson(`${base}/api/progress/${CID}`, token)).body;
  const re = prog.nodes.find((n) => n.nodeKey === 'ex-reimburse');
  assert.equal(re.locked, true);
  // 服务端练习仍可直接打开（锁是课程编排层概念），但无法“通过”因为学生没有答案可猜
});

test('12. 迁移继承：规则一致的练习分支与成绩随版本继承', async () => {
  const { token } = await login(base, 'alice');
  await postJson(`${base}/api/enrollments`, token, { courseId: CID, version: '1.0.0' });
  await completeAllReadings(base, token, CID);
  // 完成报销练习
  for (const [t, pl] of [
    ['CLAIM_CREATE', { claimId: 'C-101', dept: 'SALES', month: '2026-09', amount: 1200, desc: '差旅费' }],
    ['CLAIM_SUBMIT', { claimId: 'C-101' }],
    ['CLAIM_APPROVE', { claimId: 'C-101' }],
    ['CLAIM_PAY', { claimId: 'C-101' }],
  ]) await postJson(`${base}/api/practice/${CID}/ex-reimburse/ops`, token, { type: t, payload: pl });

  const pv = (await getJson(`${base}/api/migrations/${CID}/preview/2.0.0`, token)).body;
  assert.equal(pv.nodes.find((n) => n.nodeKey === 'ex-reimburse').decision, 'inherit');
  await postJson(`${base}/api/migrations/${CID}/migrate/2.0.0`, token, { choices: { 'ex-reimburse': 'inherit', 'ex-month': 'new' } });

  const prog = (await getJson(`${base}/api/progress/${CID}`, token)).body;
  assert.equal(prog.version, '2.0.0');
  const re = prog.nodes.find((n) => n.nodeKey === 'ex-reimburse');
  assert.equal(re.status, 'PRACTICE_PASSED');
  assert.equal(re.origin, 'migrated');
  // 原成绩保留
  assert.equal(re.score, 100);
});
