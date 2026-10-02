// 虚构账套：事件溯源。所有练习操作 -> 校验 -> 事件；状态由事件折叠得到。
// 不接真实资金系统；全部金额为教学用虚构数据。
'use strict';

function assert(cond, code, message, http = 409) {
  if (!cond) {
    const err = new Error(message);
    err.code = code;
    err.status = http;
    throw err;
  }
}

function budgetKey(dept, month) {
  return `${dept}|${month}`;
}

// 从事件流折叠出账套状态；撤回会产生 annul 标记，折叠时剔除被废止事件
function fold(events) {
  const budgets = new Map(); // key -> {dept, month, amount, status}
  const claims = new Map(); // claimId -> claim
  const months = new Map(); // month -> 'OPEN' | 'CLOSED'
  const annulled = new Set(); // 被废止的事件 id

  const getB = (dept, month) => budgets.get(budgetKey(dept, month));
  const occupied = (dept, month) => {
    let sum = 0;
    for (const c of claims.values()) {
      if (c.dept === dept && c.month === month && !['WITHDRAWN', 'REJECTED'].includes(c.status)) sum += c.amount;
    }
    return sum;
  };

  for (const e of events) {
    if (e.kind === 'invalid') continue; // 非法点击只做审计，不进入状态折叠
    if (e.type === 'EVENT_ANNUL') {
      annulled.add(e.payload.eventId);
      continue;
    }
    if (annulled.has(e.id)) continue;
    const p = e.payload || {};
    switch (e.type) {
      case 'BUDGET_PROPOSE': {
        const k = budgetKey(p.dept, p.month);
        const b = budgets.get(k);
        assert(!b || b.status === 'REJECTED', 'BUDGET_DUP', `预算已存在且非驳回状态：${k}`);
        budgets.set(k, { dept: p.dept, month: p.month, amount: p.amount, status: 'PROPOSED' });
        break;
      }
      case 'BUDGET_APPROVE': {
        const b = getB(p.dept, p.month);
        assert(b && b.status === 'PROPOSED', 'BUDGET_NOT_PROPOSED', '预算不存在或不在待审批状态');
        b.status = 'APPROVED';
        break;
      }
      case 'BUDGET_REJECT': {
        const b = getB(p.dept, p.month);
        assert(b && b.status === 'PROPOSED', 'BUDGET_NOT_PROPOSED', '预算不存在或不在待审批状态');
        b.status = 'REJECTED';
        break;
      }
      case 'CLAIM_CREATE': {
        assert(!claims.has(p.claimId), 'CLAIM_DUP', `报销单号已存在：${p.claimId}`);
        assert(months.get(p.month) !== 'CLOSED', 'MONTH_CLOSED', '会计期间已结账，禁止新建单据');
        const b = getB(p.dept, p.month);
        assert(b && b.status === 'APPROVED', 'NO_APPROVED_BUDGET', '没有已审批预算，报销单无依据');
        assert(p.amount > 0 && Number.isFinite(p.amount), 'BAD_AMOUNT', '金额必须为正数');
        assert(occupied(p.dept, p.month) + p.amount <= b.amount, 'BUDGET_EXCEEDED', '预算余额不足');
        claims.set(p.claimId, {
          claimId: p.claimId, dept: p.dept, month: p.month,
          amount: p.amount, desc: p.desc || '', status: 'DRAFT',
        });
        break;
      }
      case 'CLAIM_SUBMIT': {
        const c = claims.get(p.claimId);
        assert(c, 'CLAIM_MISSING', '报销单不存在');
        assert(c.status === 'DRAFT', 'CLAIM_NOT_DRAFT', '仅草稿状态可提交');
        assert(months.get(c.month) !== 'CLOSED', 'MONTH_CLOSED', '会计期间已结账');
        c.status = 'SUBMITTED';
        break;
      }
      case 'CLAIM_APPROVE': {
        const c = claims.get(p.claimId);
        assert(c, 'CLAIM_MISSING', '报销单不存在');
        assert(c.status === 'SUBMITTED', 'CLAIM_NOT_SUBMITTED', '仅已提交单据可审批');
        assert(months.get(c.month) !== 'CLOSED', 'MONTH_CLOSED', '会计期间已结账');
        c.status = 'APPROVED';
        break;
      }
      case 'CLAIM_REJECT': {
        const c = claims.get(p.claimId);
        assert(c, 'CLAIM_MISSING', '报销单不存在');
        assert(c.status === 'SUBMITTED', 'CLAIM_NOT_SUBMITTED', '仅已提交单据可驳回');
        assert(months.get(c.month) !== 'CLOSED', 'MONTH_CLOSED', '会计期间已结账');
        c.status = 'REJECTED';
        break;
      }
      case 'CLAIM_PAY': {
        const c = claims.get(p.claimId);
        assert(c, 'CLAIM_MISSING', '报销单不存在');
        assert(c.status === 'APPROVED', 'CLAIM_NOT_APPROVED', '仅审批通过单据可付款');
        assert(months.get(c.month) !== 'CLOSED', 'MONTH_CLOSED', '会计期间已结账，禁止付款');
        c.status = 'PAID';
        break;
      }
      case 'CLAIM_WITHDRAW': {
        const c = claims.get(p.claimId);
        assert(c, 'CLAIM_MISSING', '报销单不存在');
        if (c.status === 'PAID') {
          assert(months.get(c.month) !== 'CLOSED', 'MONTH_CLOSED', '已结账期间的已付款单据不可撤回，请先反结账');
        } else {
          assert(['DRAFT', 'SUBMITTED', 'APPROVED'].includes(c.status), 'CLAIM_NOT_WITHDRAWABLE', '当前状态不可撤回');
          assert(months.get(c.month) !== 'CLOSED', 'MONTH_CLOSED', '会计期间已结账，禁止撤回');
        }
        c.status = 'WITHDRAWN';
        break;
      }
      case 'MONTH_CLOSE': {
        assert(months.get(p.month) !== 'CLOSED', 'MONTH_ALREADY_CLOSED', '该月已结账');
        const blocking = [...claims.values()].filter(
          (c) => c.month === p.month && ['DRAFT', 'SUBMITTED', 'APPROVED'].includes(c.status),
        );
        assert(blocking.length === 0, 'PENDING_CLAIMS', `仍有 ${blocking.length} 张单据未完结，无法结账`);
        months.set(p.month, 'CLOSED');
        break;
      }
      case 'MONTH_REOPEN': {
        assert(months.get(p.month) === 'CLOSED', 'MONTH_NOT_CLOSED', '该月未结账，无需反结账');
        months.set(p.month, 'OPEN');
        break;
      }
      default:
        assert(false, 'UNKNOWN_OP', `未知操作类型：${e.type}`, 400);
    }
  }

  return {
    budgets: [...budgets.values()],
    claims: [...claims.values()],
    months: [...months.entries()].map(([month, status]) => ({ month, status })),
    annulledEventIds: [...annulled],
    budgetRemaining(dept, month) {
      const b = getB(dept, month);
      return b ? b.amount - occupied(dept, month) : null;
    },
    claim(id) {
      return claims.get(id) || null;
    },
    monthStatus(month) {
      return months.get(month) || 'OPEN';
    },
  };
}

// 校验单个操作在当前状态下是否合法（不返回新状态；成功后 append 事件再 fold）
function validate(events, op) {
  const probe = [...events, { id: `probe-${Date.now()}-${Math.random()}`, type: op.type, payload: op.payload }];
  fold(probe); // 不合法直接抛错
  return true;
}

module.exports = { fold, validate, budgetKey, assert };
