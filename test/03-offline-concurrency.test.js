// 验收3：离线进度补交（幂等、逐动作容错）
// 验收4：两设备同时操作（乐观版本冲突 + 幂等重放不重复入账）
const test = require('node:test');
const assert = require('node:assert');
const { setupHarness, readAll, statusMap } = require('./helpers');

test('离线批量补交：成功/重复幂等/非法动作并存，账套最终一致', async t => {
  const h = await setupHarness(); t.after(h.cleanup); const { req, users } = h;
  const token = users.student.token;
  const catalog = await req('GET', '/api/catalog', { token });
  const v1 = catalog.data.find(c => c.version === 1);
  const { enrollment_id: eid } = (await req('POST', '/api/enrollments',
    { token, body: { cv_id: v1.cv_id } })).data;
  await readAll(req, token, eid, v1.cv_id);

  const actions = [
    { doc_uid: 'budget-1', action: 'submit', client_op_id: 'off-1', device_id: 'devA' },
    { doc_uid: 'budget-1', action: 'approve', client_op_id: 'off-2', device_id: 'devA' },
    { doc_uid: 'budget-1', action: 'submit', client_op_id: 'off-illegal', device_id: 'devA' }, // 已 approved，非法
    { doc_uid: 'reimb-1', action: 'submit', client_op_id: 'off-3', device_id: 'devA' },
    { doc_uid: 'reimb-1', action: 'approve', client_op_id: 'off-4', device_id: 'devA' },
    { doc_uid: 'reimb-1', action: 'pay', client_op_id: 'off-5', device_id: 'devA' },
    { doc_uid: 'month-end-1', action: 'close', client_op_id: 'off-6', device_id: 'devA' },
    { doc_uid: 'missing-doc', action: 'submit', client_op_id: 'off-missing', device_id: 'devA' }, // 单据不存在
  ];
  const r = await req('POST', `/api/enrollments/${eid}/sync`, { token, body: { actions } });
  assert.equal(r.status, 200);
  assert.equal(r.data.applied, 6); // budget submit/approve + reimb 3 + close
  assert.equal(r.data.rejected, 2); // approved 后再 submit + 不存在的单据
  assert.equal(r.data.duplicate, 0);

  // 再次补交同一批 -> 已处理的 6 条全部幂等，非法的 2 条仍被拒
  const again = await req('POST', `/api/enrollments/${eid}/sync`, { token, body: { actions } });
  assert.equal(again.data.applied, 0);
  assert.equal(again.data.duplicate, 6);
  assert.equal(again.data.rejected, 2);

  // 上传截图后月结通过
  await req('POST', `/api/enrollments/${eid}/evidence`,
    { token, body: { node_code: 'prac_month_end' } });
  const st = (await req('GET', `/api/enrollments/${eid}/state`, { token })).data;
  assert.equal(statusMap({data: st}).prac_month_end.status, 'passed');
  assert.equal(st.ledger.find(d => d.doc_uid === 'budget-1').state, 'frozen');
});

test('两设备并发：设备B 基于过期版本提交 -> 409，刷新后可继续；幂等动作不重复', async t => {
  const h = await setupHarness(); t.after(h.cleanup); const { req, users } = h;
  const token = users.student.token;
  const catalog = await req('GET', '/api/catalog', { token });
  const v1 = catalog.data.find(c => c.version === 1);
  const { enrollment_id: eid } = (await req('POST', '/api/enrollments',
    { token, body: { cv_id: v1.cv_id } })).data;
  await readAll(req, token, eid, v1.cv_id);

  // 设备A 提交预算
  const a1 = await req('POST', `/api/enrollments/${eid}/actions`, { token, body: {
    doc_uid: 'budget-1', action: 'submit', client_op_id: 'devA-1', device_id: 'devA' } });
  assert.equal(a1.status, 200);

  // 设备B 握有更旧版本号 v1，试图提交 approve
  const conflict = await req('POST', `/api/enrollments/${eid}/actions`, { token, body: {
    doc_uid: 'budget-1', action: 'approve', client_op_id: 'devB-1',
    device_id: 'devB', expected_version: a1.data.serverVersion - 1 } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error, 'VERSION_CONFLICT');
  assert.ok(conflict.data.server_version >= a1.data.serverVersion);
  // 冲突动作没有产生转移
  let st = (await req('GET', `/api/enrollments/${eid}/state`, { token })).data;
  assert.equal(st.ledger.find(d => d.doc_uid === 'budget-1').state, 'submitted');

  // 设备B 刷新后用最新版本重试成功
  const fresh = await req('GET', `/api/enrollments/${eid}/state`, { token });
  const retry = await req('POST', `/api/enrollments/${eid}/actions`, { token, body: {
    doc_uid: 'budget-1', action: 'approve', client_op_id: 'devB-1',
    device_id: 'devB', expected_version: fresh.data.ledger_version } });
  assert.equal(retry.status, 200);

  // 设备A 网络重发了旧的 devA-1 -> 幂等，不重复
  const dup = await req('POST', `/api/enrollments/${eid}/actions`, { token, body: {
    doc_uid: 'budget-1', action: 'submit', client_op_id: 'devA-1', device_id: 'devA' } });
  assert.equal(dup.status, 200);
  assert.equal(dup.data.idempotent, true);

  st = (await req('GET', `/api/enrollments/${eid}/state`, { token })).data;
  const submits = st.transitions.filter(t => t.action === 'submit' && !t.undone_at);
  assert.equal(submits.length, 1, '幂等重放不得重复入账');
});
