// 评分引擎：依据“状态转移证据”而非点击顺序。
// 撤回/反结账会废止其前置转移事件，后续步骤失去依据 -> 需重做。
'use strict';

const { budgetKey } = require('./ledger');

function refOf(type, payload) {
  switch (type) {
    case 'BUDGET_PROPOSE':
    case 'BUDGET_APPROVE':
    case 'BUDGET_REJECT':
      return budgetKey(payload.dept, payload.month);
    case 'MONTH_CLOSE':
    case 'MONTH_REOPEN':
      return payload.month;
    default:
      return payload.claimId;
  }
}

// 计划某次事件应废止哪些历史事件：
// 撤回单据 -> 废止该单此前全部生命周期转移；反结账 -> 废止原结账事件
function annulPlan(events, event) {
  if (event.type === 'CLAIM_WITHDRAW') {
    const lifecycle = ['CLAIM_CREATE', 'CLAIM_SUBMIT', 'CLAIM_APPROVE', 'CLAIM_PAY'];
    return events
      .filter((e) => lifecycle.includes(e.type) && e.payload && e.payload.claimId === event.payload.claimId)
      .map((e) => e.id);
  }
  if (event.type === 'MONTH_REOPEN') {
    return events.filter((e) => e.type === 'MONTH_CLOSE' && e.payload.month === event.payload.month).map((e) => e.id);
  }
  return [];
}

function annulledSet(events) {
  const set = new Set();
  for (const e of events) {
    if (e.type === 'EVENT_ANNUL') set.add(e.payload.eventId);
    if (Array.isArray(e.annuls)) e.annuls.forEach((id) => set.add(id));
  }
  return set;
}

// 从“当前仍有效”的事件中提取状态转移（与完成顺序无关）
function achievedTransitions(events) {
  const annulled = annulledSet(events);
  const out = [];
  for (const e of events) {
    if (e.type === 'EVENT_ANNUL' || annulled.has(e.id)) continue;
    if (e.kind === 'invalid') continue; // 未通过校验的点击只留审计，不产生转移
    out.push({ eventId: e.id, seq: e.seq, type: e.type, ref: refOf(e.type, e.payload || {}) });
  }
  return out;
}

// 找到废止某目标转移的撤回/反结账事件
function findInvalidator(events, reqType, reqRef) {
  const byId = new Map(events.map((e) => [e.id, e]));
  for (const e of events) {
    if (!Array.isArray(e.annuls) || e.annuls.length === 0) continue;
    const hit = e.annuls.some((id) => {
      const x = byId.get(id);
      return x && x.type === reqType && refOf(x.type, x.payload || {}) === reqRef;
    });
    if (hit) return e;
  }
  return null;
}

// 规则驱动评分：required 每项在当前有效事件中存在即得分；顺序无关
function gradeExercise(node, events, hasValidScreenshot) {
  const achieved = achievedTransitions(events);
  const items = node.rule.required.map((req, index) => {
    const hit = achieved.find((t) => t.type === req.type && (!req.ref || t.ref === req.ref));
    const item = {
      index,
      label: req.label,
      achieved: Boolean(hit),
      evidenceEventId: hit ? hit.eventId : null,
      reason: hit ? null : '尚未完成',
      lostAtSeq: null,
    };
    if (!hit) {
      const inv = findInvalidator(events, req.type, req.ref);
      if (inv) {
        item.reason = '依据被撤回/反结账废止，后续步骤失去依据';
        item.lostAtSeq = inv.seq;
      }
    }
    return item;
  });
  const hitCount = items.filter((i) => i.achieved).length;
  const score = Math.round((hitCount / node.rule.required.length) * 100);
  const screenshotOk = node.rule.requiresScreenshot ? Boolean(hasValidScreenshot) : true;
  const passed = score >= node.rule.passScore && screenshotOk;
  return {
    score,
    passScore: node.rule.passScore,
    passed,
    screenshotRequired: node.rule.requiresScreenshot,
    screenshotOk,
    items,
  };
}

module.exports = { refOf, annulPlan, annulledSet, achievedTransitions, gradeExercise, findInvalidator };
