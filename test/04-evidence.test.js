// 验收6：截图失败 —— needs_redo；重新上传后恢复通过
const test = require('node:test');
const assert = require('node:assert');
const { setupHarness, completeV1, readAll, statusMap } = require('./helpers');

test('月结通过后截图标记失败 => needs_redo；重传后 passed', async t => {
  const h = await setupHarness(); t.after(h.cleanup); const { req, users } = h;
  const token = users.student.token;
  const catalog = await req('GET', '/api/catalog', { token });
  const v1 = catalog.data.find(c => c.version === 1);
  const { enrollment_id: eid } = (await req('POST', '/api/enrollments',
    { token, body: { cv_id: v1.cv_id } })).data;
  await readAll(req, token, eid, v1.cv_id);
  await completeV1(req, token, eid); // 内含成功截图

  let st = (await req('GET', `/api/enrollments/${eid}/state`, { token })).data;
  assert.equal(statusMap({data: st}).prac_month_end.status, 'passed');

  // 模拟截图失败
  const f = await req('POST', `/api/enrollments/${eid}/evidence?fail=1`,
    { token, body: { node_code: 'prac_month_end', status: 'failed',
      failure_note: '截图服务超时' } });
  assert.equal(f.status, 200);
  const node = f.data.progress.find(p => p.node_code === 'prac_month_end');
  assert.equal(node.status, 'needs_redo');
  assert.equal(node.reason, 'EVIDENCE_FAILED');

  // 重新上传成功 -> 恢复 passed
  const ok = await req('POST', `/api/enrollments/${eid}/evidence`,
    { token, body: { node_code: 'prac_month_end', byte_size: 998 } });
  const again = ok.data.progress.find(p => p.node_code === 'prac_month_end');
  assert.equal(again.status, 'passed');
});

test('已月结但从未上传截图 => 保持 needs_redo/不通过直到上传', async t => {
  const h = await setupHarness(); t.after(h.cleanup); const { req, users } = h;
  const token = users.student.token;
  const catalog = await req('GET', '/api/catalog', { token });
  const v1 = catalog.data.find(c => c.version === 1);
  const { enrollment_id: eid } = (await req('POST', '/api/enrollments',
    { token, body: { cv_id: v1.cv_id } })).data;
  await readAll(req, token, eid, v1.cv_id);
  await completeV1(req, token, eid, { withEvidence: false });
  const st = (await req('GET', `/api/enrollments/${eid}/state`, { token })).data;
  const me = statusMap({data: st}).prac_month_end;
  assert.notEqual(me.status, 'passed');
  assert.equal(me.score, 100, '状态转移全匹配，仅差证据');
});
