// 验收7：课程升级 —— 比较「迁移已完成节点」与「重开练习分支」
//        继承依据 + 原成绩保留；规则变更只影响新版本
// 验收9：刷新后云端状态恢复；学生只能访问自己的报名
const test = require('node:test');
const assert = require('node:assert');
const { setupHarness, completeV1, readAll, statusMap } = require('./helpers');

async function finishedV1(req, token) {
  const catalog = await req('GET', '/api/catalog', { token });
  const v1 = catalog.data.find(c => c.version === 1);
  const v2 = catalog.data.find(c => c.version === 2);
  const { enrollment_id: eid } = (await req('POST', '/api/enrollments',
    { token, body: { cv_id: v1.cv_id } })).data;
  await readAll(req, token, eid, v1.cv_id);
  await completeV1(req, token, eid);
  return { catalog: catalog.data, v1, v2, eid };
}

test('升级计划：v1 完成者对 v2 的可继承判定正确（报销新增退回路径 => 不兼容）', async t => {
  const h = await setupHarness(); t.after(h.cleanup); const { req, users } = h;
  const token = users.student.token;
  const { v2, eid } = await finishedV1(req, token);

  const plan = await req('GET', `/api/enrollments/${eid}/upgrade-plan?to_cv_id=${v2.cv_id}`, { token });
  assert.equal(plan.status, 200);
  assert.ok(plan.data.comparison.migrate.old_score_kept);
  assert.ok(plan.data.comparison.branch.old_branch_frozen);
  const byCode = Object.fromEntries(plan.data.nodes.map(n => [n.node_code, n]));
  assert.equal(byCode.prac_budget.inheritable, true);
  assert.equal(byCode.prac_reimbursement.inheritable, false);
  assert.match(byCode.prac_reimbursement.reason, /不兼容/);
  // 迁移模式预计继承数 < branch 模式的新分支起点
  assert.ok(plan.data.comparison.migrate.inherited_count >= 1);
  assert.equal(plan.data.comparison.branch.projected_score, 0);
});

test('迁移模式：旧账套重放，预算节点继承+原成绩保留；报销节点按新规则需重做', async t => {
  const h = await setupHarness(); t.after(h.cleanup); const { req, users } = h;
  const token = users.student.token;
  const { v1, v2, eid } = await finishedV1(req, token);

  const up = await req('POST', `/api/enrollments/${eid}/upgrade`,
    { token, body: { to_cv_id: v2.cv_id, mode: 'migrate' } });
  assert.equal(up.status, 200);
  assert.ok(up.data.inherited_nodes.includes('prac_budget'));
  assert.ok(!up.data.inherited_nodes.includes('prac_reimbursement'));

  const st = (await req('GET', `/api/enrollments/${up.data.new_enrollment_id}/state`, { token })).data;
  const m = statusMap({data: st});
  assert.equal(m.prac_budget.status, 'passed');
  assert.equal(m.prac_budget.old_score, 100, '原成绩保留在 old_score');
  assert.equal(m.prac_reimbursement.status, 'pending', '新规则要求 reject，旧数据不兼容');
  assert.equal(m.prac_reimbursement.old_score, 100, '虽然需重做，原成绩仍保留');
  assert.equal(m.prac_reimbursement.rule_version, 2, '按新版规则评分');
  // 阅读节点随迁移保持完成
  assert.equal(m.read_budget.status, 'reading_done');
  // 账套状态也迁移：预算已冻结（v1 月结导致）
  assert.equal(st.ledger.find(d => d.doc_uid === 'budget-1').state, 'frozen');

  // 原报名的 v1 成绩完全不变
  const oldSt = (await req('GET', `/api/enrollments/${eid}/state`, { token })).data;
  const om = statusMap({data: oldSt});
  assert.equal(om.prac_reimbursement.status, 'passed');
  assert.equal(om.prac_reimbursement.rule_version, 1);
});

test('分支模式：旧分支冻结保留原成绩，新分支空白账套全部从头', async t => {
  const h = await setupHarness(); t.after(h.cleanup); const { req, users } = h;
  const token = users.student.token;
  const { v2, eid } = await finishedV1(req, token);

  const up = await req('POST', `/api/enrollments/${eid}/upgrade`,
    { token, body: { to_cv_id: v2.cv_id, mode: 'branch' } });
  assert.equal(up.status, 200);
  assert.deepEqual(up.data.inherited_nodes, []);
  assert.equal(up.data.old_enrollment_frozen, true);

  const st = (await req('GET', `/api/enrollments/${up.data.new_enrollment_id}/state`, { token })).data;
  assert.equal(st.branch_name, 'v2-branch');
  for (const d of st.ledger) {
    assert.ok(['draft', 'open'].includes(d.state), '新分支账套必须是初始状态');
  }
  const m = statusMap({data: st});
  assert.equal(m.prac_budget.status, 'pending');
  assert.equal(m.prac_month_end.status, 'pending');

  // 旧分支成绩仍在
  const oldSt = (await req('GET', `/api/enrollments/${eid}/state`, { token })).data;
  assert.equal(statusMap({data: oldSt}).prac_month_end.status, 'passed');
});

test('教师发布规则新版：旧评分不受影响；新规则只在新版本生效', async t => {
  const h = await setupHarness(); t.after(h.cleanup); const { req, users } = h;
  const token = users.student.token;
  const teacher = users.teacher.token;
  const { v1, eid } = await finishedV1(req, token);

  // 教师基于 v2 再发布 v3，把预算练习改为只要求 approve
  const catalog = await req('GET', '/api/catalog', { token: teacher });
  const v2 = catalog.data.find(c => c.version === 2);
  const nv = await req('POST', `/api/teacher/courses/${v2.id}/new-version`,
    { token: teacher, body: { updates: [{
      node_code: 'prac_budget',
      required_transitions: [{ doc_type: 'budget', action: 'approve' }],
    }] } });
  assert.equal(nv.status, 200);
  assert.equal(nv.data.version, 3);

  // v3 规则已变更（教师视角）
  const rules3 = (await req('GET', `/api/teacher/course-versions/${nv.data.id}/rules`,
    { token: teacher })).data;
  const b3 = rules3.find(r => r.node_code === 'prac_budget');
  assert.deepEqual(b3.required_transitions, [{ doc_type: 'budget', action: 'approve' }]);

  // 学生 v1 旧成绩依旧按 v1 规则 passed
  const oldSt = (await req('GET', `/api/enrollments/${eid}/state`, { token })).data;
  const om = statusMap({data: oldSt});
  assert.equal(om.prac_budget.status, 'passed');
  assert.equal(om.prac_budget.rule_version, 1);

  // 学生在 v3 材料中依然看不到答案
  const mat = (await req('GET', `/api/courses/${nv.data.id}/material`, { token })).data;
  assert.ok(mat.nodes.every(n => !('required_transitions' in n)));

  // 学生不能创建新版本
  const denied = await req('POST', `/api/teacher/courses/${v2.id}/new-version`,
    { token, body: {} });
  assert.equal(denied.status, 403);
});

test('刷新即恢复 + 越权访问被拒', async t => {
  const h = await setupHarness(); t.after(h.cleanup); const { req, users } = h;
  const t1 = users.student.token;
  const t2 = users.student2.token;
  const { eid } = await finishedV1(req, t1);

  // 重新 GET（模拟刷新/重开浏览器）：云端为唯一事实来源
  const st = (await req('GET', `/api/enrollments/${eid}/state`, { token: t1 })).data;
  assert.ok(st.transitions.length >= 7);
  assert.equal(st.ledger.find(d => d.doc_uid === 'month-end-1').state, 'closed');
  assert.equal(statusMap({data: st}).prac_reimbursement.status, 'passed');

  // 另一名学生无法读取/操作该报名
  const denied = await req('GET', `/api/enrollments/${eid}/state`, { token: t2 });
  assert.equal(denied.status, 404);
  const actDenied = await req('POST', `/api/enrollments/${eid}/actions`,
    { token: t2, body: { doc_uid: 'budget-1', action: 'submit', client_op_id: 'x' } });
  assert.equal(actDenied.status, 404);
});
