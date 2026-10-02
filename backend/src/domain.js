// ==================================================================
// 领域模型：模拟财务流程（报销 / 预算 / 月结）
// 评分依据「状态转移」而非点击顺序；动作之间存在前置条件与相互影响。
// 仅为教学模拟，不接真实资金系统，不产生任何财务合规结论。
// ==================================================================

const REIMB_TRANSITIONS = {
  draft:    { submit:  'submitted' },
  submitted:{ approve: 'approved', reject: 'draft' },
  approved: { pay:     'paid', reject: 'draft' },
  // 已支付/已批准的单据可申请撤回（冲销）；冲销后回到草稿，需重新提交
  paid:     { reverse: 'draft' },
};
const BUDGET_TRANSITIONS = {
  draft:    { submit: 'submitted' },
  submitted:{ approve: 'approved', reject: 'draft' },
  // 月结通过时预算自动 frozen；月结重开自动解冻
  approved: { freeze: 'frozen' },
  frozen:   { unfreeze:'approved' },
};
const MONTH_END_TRANSITIONS = {
  open:     { close: 'closed' },
  closed:   { reopen: 'open' },
};

const TRANSITIONS = {
  reimbursement: REIMB_TRANSITIONS,
  budget:        BUDGET_TRANSITIONS,
  month_end:     MONTH_END_TRANSITIONS,
};

// 动作完成后单据所处的目标状态（用于评分规则的 expected_path）
function targetState(docType, action) {
  for (const st of Object.keys(TRANSITIONS[docType])) {
    const t = TRANSITIONS[docType][st][action];
    if (t) return t;
  }
  return null;
}

// 回滚一条有效转移时使用的反向动作
const REVERSE_ACTION = {
  submit:   'rollback_submit',
  approve:  'rollback_approve',
  pay:      'rollback_pay',
  reject:   'rollback_reject',
  freeze:   'rollback_freeze',
  unfreeze: 'rollback_unfreeze',
  close:    'rollback_close',
  reopen:   'rollback_reopen',
};

// 规则内置校验之外的业务前置条件（与 DB 中当前单据状态一起检查）
// 返回 null 表示通过，否则返回错误原因
function businessGuard({ docType, action, doc, ledger }) {
  // 前置条件 1：报销提交/审批前必须存在已批准预算，且占用后不超预算
  if (docType === 'reimbursement' && (action === 'submit' || action === 'approve')) {
    const budget = ledger.find(d => d.doc_type === 'budget');
    if (!budget || (budget.state !== 'approved' && budget.state !== 'frozen')) {
      return 'PRECOND_BUDGET_NOT_APPROVED: 必须先提交并审批通过预算';
    }
    if (action === 'submit') {
      const used = ledger
        .filter(d => d.doc_type === 'reimbursement' && ['submitted', 'approved', 'paid'].includes(d.state))
        .filter(d => d.doc_uid !== doc.doc_uid)
        .reduce((s, d) => s + Number(d.amount_cents), 0);
      const inclSelf = doc && ['submitted','approved','paid'].includes(doc.state)
        ? used : used + Number(doc.amount_cents);
      if (inclSelf > Number(budget.amount_cents)) {
        return 'BUDGET_EXCEEDED: 提交后占用金额超过预算余额，不能提交';
      }
    }
  }
  // 前置条件 2：月结要求预算 approved 且所有非草稿报销 paid
  if (docType === 'month_end' && action === 'close') {
    const budget = ledger.find(d => d.doc_type === 'budget');
    if (!budget || budget.state !== 'approved') {
      return 'PRECOND_BUDGET_NOT_APPROVED: 月结前预算必须已审批通过';
    }
    const blocking = ledger.filter(d =>
      d.doc_type === 'reimbursement' && ['submitted', 'approved'].includes(d.state));
    if (blocking.length > 0) {
      return 'PRECOND_OPEN_REIMBURSEMENTS: 仍有报销单未支付，不能月结';
    }
  }
  return null;
}

// 一个动作成功后的级联（不额外计入节点进度的自动转移；月结 => 冻结预算）
function cascades(action, docType, ledger) {
  const out = [];
  if (docType === 'month_end' && action === 'close') {
    const budget = ledger.find(d => d.doc_type === 'budget');
    if (budget && budget.state === 'approved') {
      out.push({ doc_uid: budget.doc_uid, doc_type: 'budget', action: 'freeze' });
    }
  }
  if (docType === 'month_end' && action === 'reopen') {
    const budget = ledger.find(d => d.doc_type === 'budget');
    if (budget && budget.state === 'frozen') {
      out.push({ doc_uid: budget.doc_uid, doc_type: 'budget', action: 'unfreeze' });
    }
  }
  return out;
}

// 回滚级联：回滚月结 close -> 自动 reopen 月结、解冻预算
function rollbackCascades(original) {
  const out = [];
  if (original.doc_type === 'month_end' && original.action === 'close') {
    out.push({ doc_uid: original.doc_uid, doc_type: 'month_end', action: 'reopen' });
  }
  return out;
}

module.exports = {
  TRANSITIONS, REVERSE_ACTION, targetState,
  businessGuard, cascades, rollbackCascades,
};
