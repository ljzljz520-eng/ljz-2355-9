// 验收1：阅读 / 练习 / 三态进度 + 状态转移评分（与点击顺序无关）
// 验收2：前置条件与相互影响（预算不足/未支付不得月结）
// 验收8：学生接口不得取得教师答案
const test = require('node:test');
const assert = require('node:assert');
const { setupHarness, completeV1, readAll, statusMap } = require('./helpers');

test('完整训练链路：阅读→预算→报销→月结，状态三态正确', async t => {
  const h = await setupHarness(); t.after(h.cleanup); const { req, users } = h;
  const token = users.student.token;
  const catalog = await req('GET', '/api/catalog', { token });
  const v1 = catalog.data.find(c => c.version === 1);
  const { enrollment_id: eid } = (await req('POST', '/api/enrollments',
    { token, body: { cv_id: v1.cv_id } })).data;

  await readAll(req, token, eid, v1.cv_id);
  await completeV1(req, token, eid);

  const st = (await req('GET', `/api/enrollments/${eid}/state`, { token })).data;
  const m = statusMap({ data: st });
  assert.equal(m.read_reimbursement.status, 'reading_done');
  assert.equal(m.prac_budget.status, 'passed');
  assert.equal(m.prac_reimbursement.status, 'passed');
  assert.equal(m.prac_month_end.status, 'passed');

  // 月结关闭级联冻结预算
  const budget = st.ledger.find(d => d.doc_uid === 'budget-1');
  assert.equal(budget.state, 'frozen');
  assert.ok(st.transitions.some(t => t.action === 'freeze' && !t.undone_at));
});

test('评分依据状态转移而非点击顺序：多余/乱序点击不影响通过',  async t => {
  const h = await setupHarness(); t.after(h.cleanup); const { req, users } = h;
  const token = users.student.token;
  const catalog = await req('GET', '/api/catalog', { token });
  const v1 = catalog.data.find(c => c.version === 1);
  const { enrollment_id: eid } = (await req('POST', '/api/enrollments',
    { token, body: { cv_id: v1.cv_id } })).data;
  await readAll(req, token, eid, v1.cv_id);

  // 故意把报销走"提交→退回→提交→批准→支付"，存在额外 reject 转移
  const op = (doc_uid, action) => req('POST', `/api/enrollments/${eid}/actions`,
    { token, body: { doc_uid, action, client_op_id: 'op-' + Math.random().toString(36).slice(2), device_id: 'devA' } });
  await op('budget-1', 'submit');
  await op('budget-1', 'approve');
  await op('reimb-1', 'submit');
  await op('reimb-1', 'reject');
  await op('reimb-1', 'submit');
  await op('reimb-1', 'approve');
  await op('op_nope' ,'x'); // 无效噪声（doc 不存在）
  await op('reimb-1', 'pay');
  await op('month-end-1', 'close');
  await req('POST', `/api/enrollments/${eid}/evidence`,
    { token, body: { node_code: 'prac_month_end' } });

  const st = (await req('GET', `/api/enrollments/${eid}/state`, { token })).data;
  const m = statusMap({ data: st });
  // v1 只要求 submit/approve/pay，reject 是额外转移 => 仍通过
  assert.equal(m.prac_reimbursement.status, 'passed');
  assert.equal(m.prac_month_end.status, 'passed');
});

test('前置条件：预算未批准时不能提交报销；有未支付报销不能月结', async t => {
  const h = await setupHarness(); t.after(h.cleanup); const { req, users } = h;
  const token = users.student.token;
  const catalog = await req('GET', '/api/catalog', { token });
  const v1 = catalog.data.find(c => c.version === 1);
  const { enrollment_id: eid } = (await req('POST', '/api/enrollments',
    { token, body: { cv_id: v1.cv_id } })).data;

  // 直接提交报销 -> 拒绝（没有批准的预算）
  let r = await req('POST', `/api/enrollments/${eid}/actions`,
    { token, body: { doc_uid: 'reimb-1', action: 'submit', client_op_id: 'a1' } });
  assert.equal(r.status, 422);
  assert.equal(r.data.error, 'PRECOND_BUDGET_NOT_APPROVED');

  await req('POST', `/api/enrollments/${eid}/actions`,
    { token, body: { doc_uid: 'budget-1', action: 'submit', client_op_id: 'a2' } });
  await req('POST', `/api/enrollments/${eid}/actions`,
    { token, body: { doc_uid: 'budget-1', action: 'approve', client_op_id: 'a3' } });
  r = await req('POST', `/api/enrollments/${eid}/actions`,
    { token, body: { doc_uid: 'reimb-1', action: 'submit', client_op_id: 'a4' } });
  assert.equal(r.status, 200);
  // 报销已提交未支付 -> 月结被拒
  r = await req('POST', `/api/enrollments/${eid}/actions`,
    { token, body: { doc_uid: 'month-end-1', action: 'close', client_op_id: 'a5' } });
  assert.equal(r.status, 422);
  assert.equal(r.data.error, 'PRECOND_OPEN_REIMBURSEMENTS');
});

test('学生无法获得教师答案：material 无 required_transitions；教师接口学生 403', async t => {
  const h = await setupHarness(); t.after(h.cleanup); const { req, users } = h;
  const { student, teacher } = users;
  const catalog = await req('GET', '/api/catalog', { token: student.token });
  const v1 = catalog.data.find(c => c.version === 1);
  // 学生材料中绝不能出现答案字段
  const mat = await req('GET', `/api/courses/${v1.cv_id}/material`, { token: student.token });
  for (const n of mat.data.nodes) {
    assert.ok(!('required_transitions' in n), '学生节点数据泄漏了 required_transitions');
  }
  // 学生直接调教师接口 -> 403（不是简单的前端隐藏）
  const denied = await req('GET', `/api/teacher/course-versions/${v1.cv_id}/rules`,
    { token: student.token });
  assert.equal(denied.status, 403);
  // 教师可看到完整 expected path
  const rules = await req('GET', `/api/teacher/course-versions/${v1.cv_id}/rules`,
    { token: teacher.token });
  assert.equal(rules.status, 200);
  const reimb = rules.data.find(r => r.node_code === 'prac_reimbursement');
  assert.ok(reimb.required_transitions.length >= 3);
});
