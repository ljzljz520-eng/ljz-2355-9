// 验收5：练习回滚 —— 撤回一张模拟单据使后续步骤失去依据 => needs_redo
//        月结回滚自动重开 + 预算解冻；事件只追加不删除
const test = require('node:test');
const assert = require('node:assert');
const { setupHarness, completeV1, readAll, statusMap } = require('./helpers');

test('月结后撤回报销：月结自动重开、预算解冻、月结节点 needs_redo', async t => {
  const h = await setupHarness(); t.after(h.cleanup); const { req, users } = h;
  const token = users.student.token;
  const catalog = await req('GET', '/api/catalog', { token });
  const v1 = catalog.data.find(c => c.version === 1);
  const { enrollment_id: eid } = (await req('POST', '/api/enrollments',
    { token, body: { cv_id: v1.cv_id } })).data;
  await readAll(req, token, eid, v1.cv_id);
  const events = await completeV1(req, token, eid);

  let st = (await req('GET', `/api/enrollments/${eid}/state`, { token })).data;
  assert.equal(statusMap({data: st}).prac_month_end.status, 'passed');

  // 找到 pay 转移并回滚（撤回已支付报销）
  const pay = st.transitions.find(t => t.action === 'pay' && !t.undone_at);
  const rb = await req('POST', `/api/enrollments/${eid}/rollback`,
    { token, body: { transition_id: pay.id, device_id: 'devA' } });
  assert.equal(rb.status, 200);
  assert.ok(rb.data.auto.length >= 1, '应自动联动月结重开');

  st = (await req('GET', `/api/enrollments/${eid}/state`, { token })).data;
  const reimb = st.ledger.find(d => d.doc_uid === 'reimb-1');
  const me = st.ledger.find(d => d.doc_uid === 'month-end-1');
  const budget = st.ledger.find(d => d.doc_uid === 'budget-1');
  assert.equal(reimb.state, 'approved'); // pay 被撤销 -> 回退到 approved
  assert.equal(me.state, 'open');
  assert.equal(budget.state, 'approved'); // 冻结随月结一起撤销
  // 月结节点依据丢失 -> 需重做；报销节点也因 pay 撤销需要重做
  const m = statusMap({data: st});
  assert.equal(m.prac_month_end.status, 'needs_redo');
  assert.equal(m.prac_month_end.reason, 'BASIS_LOST_AFTER_ROLLBACK');
  assert.equal(m.prac_reimbursement.status, 'needs_redo');

  // 事件溯源：历史未删除，只是标记 undone，并新增补偿转移
  assert.ok(st.transitions.some(t => t.id === pay.id && t.undone_at));
  assert.ok(st.transitions.some(t => t.action === 'rollback_pay'));
  assert.ok(st.transitions.some(t => t.action === 'reopen'));

  // 重新完成 pay + close + 截图 => 再次通过
  await req('POST', `/api/enrollments/${eid}/actions`,
    { token, body: { doc_uid: 'reimb-1', action: 'pay', client_op_id: 'redo-pay' } });
  await req('POST', `/api/enrollments/${eid}/actions`,
    { token, body: { doc_uid: 'month-end-1', action: 'close', client_op_id: 'redo-close' } });
  st = (await req('GET', `/api/enrollments/${eid}/state`, { token })).data;
  assert.equal(statusMap({data: st}).prac_month_end.status, 'needs_redo',
    '截图证据已随回滚失效，需重新上传截图');

  await req('POST', `/api/enrollments/${eid}/evidence`,
    { token, body: { node_code: 'prac_month_end' } });
  st = (await req('GET', `/api/enrollments/${eid}/state`, { token })).data;
  assert.equal(statusMap({data: st}).prac_month_end.status, 'passed');
});

test('回滚不允许作用于已撤销的转移', async t => {
  const h = await setupHarness(); t.after(h.cleanup); const { req, users } = h;
  const token = users.student.token;
  const catalog = await req('GET', '/api/catalog', { token });
  const v1 = catalog.data.find(c => c.version === 1);
  const { enrollment_id: eid } = (await req('POST', '/api/enrollments',
    { token, body: { cv_id: v1.cv_id } })).data;
  await readAll(req, token, eid, v1.cv_id);
  await completeV1(req, token, eid);
  let st = (await req('GET', `/api/enrollments/${eid}/state`, { token })).data;
  const close = st.transitions.find(t => t.action === 'close');
  await req('POST', `/api/enrollments/${eid}/rollback`,
    { token, body: { transition_id: close.id } });
  const again = await req('POST', `/api/enrollments/${eid}/rollback`,
    { token, body: { transition_id: close.id } });
  assert.equal(again.status, 422);
  assert.equal(again.data.error, 'TRANSITION_NOT_ACTIVE');
});
