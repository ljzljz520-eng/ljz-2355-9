'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fold } = require('../src/engine/ledger');
const { gradeExercise } = require('../src/engine/grade');
const { getCourseVersion, getNode } = require('../src/catalog');

function ev(seq, type, payload, annuls = []) {
  return { id: `e${seq}`, seq, kind: 'valid', type, payload, annuls };
}

test('状态转移顺序无关：打乱折叠顺序仍由最终事件流决定（转移集合相同）', () => {
  const cv = getCourseVersion('finance101', '1.0.0');
  const node = getNode(cv, 'ex-reimburse');
  const events = [
    ...node.seed.map((s, i) => ev(i, s.type, s.payload)),
    ev(2, 'CLAIM_CREATE', { claimId: 'C-101', dept: 'SALES', month: '2026-09', amount: 1200 }),
    ev(3, 'CLAIM_SUBMIT', { claimId: 'C-101' }),
    ev(4, 'CLAIM_APPROVE', { claimId: 'C-101' }),
    ev(5, 'CLAIM_PAY', { claimId: 'C-101' }),
  ];
  const g = gradeExercise(node, events, false);
  assert.equal(g.score, 100);
  assert.deepEqual(g.items.map((i) => i.achieved), [true, true, true, true]);
});

test('撤回级联：annuls 中事件全部从有效转移中剔除', () => {
  const cv = getCourseVersion('finance101', '1.0.0');
  const node = getNode(cv, 'ex-reimburse');
  const events = [
    ...node.seed.map((s, i) => ev(i, s.type, s.payload)),
    ev(2, 'CLAIM_CREATE', { claimId: 'C-101', dept: 'SALES', month: '2026-09', amount: 1200 }),
    ev(3, 'CLAIM_SUBMIT', { claimId: 'C-101' }),
    ev(4, 'CLAIM_APPROVE', { claimId: 'C-101' }),
    ev(5, 'CLAIM_PAY', { claimId: 'C-101' }),
    { ...ev(6, 'CLAIM_WITHDRAW', { claimId: 'C-101' }), annuls: ['e2', 'e3', 'e4', 'e5'] },
  ];
  const g = gradeExercise(node, events, false);
  assert.equal(g.score, 0);
  assert.ok(g.items.every((i) => i.lostAtSeq === 6));
  const state = fold(events);
  assert.equal(state.claims[0].status, 'WITHDRAWN');
  assert.equal(state.budgetRemaining('SALES', '2026-09'), 5000); // 撤回释放占用
});

test('月结前置：存在 APPROVED 单据时 MONTH_CLOSE 折叠抛 PENDING_CLAIMS', () => {
  const events = [
    ev(0, 'BUDGET_PROPOSE', { dept: 'SALES', month: '2026-09', amount: 5000 }),
    ev(1, 'BUDGET_APPROVE', { dept: 'SALES', month: '2026-09' }),
    ev(2, 'CLAIM_CREATE', { claimId: 'C-9', dept: 'SALES', month: '2026-09', amount: 10 }),
    ev(3, 'CLAIM_SUBMIT', { claimId: 'C-9' }),
    ev(4, 'CLAIM_APPROVE', { claimId: 'C-9' }),
  ];
  assert.throws(() => fold([...events, ev(5, 'MONTH_CLOSE', { month: '2026-09' })]), /PENDING_CLAIMS|仍有/);
  // 付款后可以结账
  const ok = fold([...events, ev(5, 'CLAIM_PAY', { claimId: 'C-9' }), ev(6, 'MONTH_CLOSE', { month: '2026-09' })]);
  assert.equal(ok.monthStatus('2026-09'), 'CLOSED');
});

test('无审批预算时建单被拒', () => {
  assert.throws(
    () => fold([ev(0, 'CLAIM_CREATE', { claimId: 'C-1', dept: 'X', month: '2026-09', amount: 1 })]),
    /NO_APPROVED_BUDGET|没有已审批预算/,
  );
});

test('非法点击事件（kind=invalid）不改变状态', () => {
  const s = fold([
    { id: 'x', seq: 0, kind: 'invalid', type: 'MONTH_CLOSE', payload: { month: '2026-09' } },
  ]);
  assert.equal(s.monthStatus('2026-09'), 'OPEN');
});
