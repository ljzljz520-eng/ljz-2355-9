// 课程目录：课程版本、文档节点、练习节点（含虚构账套种子事件与评分规则）
// 规则与答案仅在本模块定义；序列化时按角色剥离（学生接口永不返回 expected*/seed 等答案信息）
'use strict';

// v1 报销练习：预算已批，任务是建单->提交->审批->付款
const reimburseV1 = {
  key: 'ex-reimburse',
  kind: 'exercise',
  title: '练习：报销单全流程',
  scenario:
    '销售部 2026-09 月预算 5,000 元已审批通过。请为差旅费 1,200 元创建报销单（单号 C-101），' +
    '依次完成提交、审批与付款。尝试撤回单据，观察后续步骤的依据如何失效。',
  month: '2026-09',
  seed: [
    { type: 'BUDGET_PROPOSE', payload: { dept: 'SALES', month: '2026-09', amount: 5000 } },
    { type: 'BUDGET_APPROVE', payload: { dept: 'SALES', month: '2026-09' } },
  ],
  rule: {
    passScore: 80,
    requiresScreenshot: false,
    required: [
      { type: 'CLAIM_CREATE', ref: 'C-101', label: '创建报销单 C-101' },
      { type: 'CLAIM_SUBMIT', ref: 'C-101', label: '提交 C-101' },
      { type: 'CLAIM_APPROVE', ref: 'C-101', label: '审批通过 C-101' },
      { type: 'CLAIM_PAY', ref: 'C-101', label: '付款 C-101' },
    ],
  },
};

const budgetV1 = {
  key: 'ex-budget',
  kind: 'exercise',
  title: '练习：预算申报与审批',
  scenario: '行政部尚未编制 2026-09 预算，请申报 8,000 元并完成审批。',
  month: '2026-09',
  seed: [],
  rule: {
    passScore: 80,
    requiresScreenshot: false,
    required: [
      { type: 'BUDGET_PROPOSE', ref: 'ADMIN|2026-09', label: '申报 ADMIN 预算 8000' },
      { type: 'BUDGET_APPROVE', ref: 'ADMIN|2026-09', label: '审批 ADMIN 预算' },
    ],
  },
};

const monthV1 = {
  key: 'ex-month',
  kind: 'exercise',
  title: '练习：月末结账',
  scenario: '当前账套中报销单均已付款。请对 2026-09 月执行结账。',
  month: '2026-09',
  seed: [
    { type: 'BUDGET_PROPOSE', payload: { dept: 'SALES', month: '2026-09', amount: 5000 } },
    { type: 'BUDGET_APPROVE', payload: { dept: 'SALES', month: '2026-09' } },
    { type: 'CLAIM_CREATE', payload: { claimId: 'C-201', dept: 'SALES', month: '2026-09', amount: 900, desc: '办公用品' } },
    { type: 'CLAIM_SUBMIT', payload: { claimId: 'C-201' } },
    { type: 'CLAIM_APPROVE', payload: { claimId: 'C-201' } },
    { type: 'CLAIM_PAY', payload: { claimId: 'C-201' } },
  ],
  rule: {
    passScore: 80,
    requiresScreenshot: false,
    required: [{ type: 'MONTH_CLOSE', ref: '2026-09', label: '结转并关闭 2026-09 月' }],
  },
};

const docReimburse = {
  key: 'doc-reimburse',
  kind: 'reading',
  title: '指南：报销流程',
  body:
    '报销流程：申请人创建报销单（需有已审批预算且额度充足）→ 提交 → 主管审批 → 出纳付款。\n\n' +
    '撤回规则：草稿/已提交单据可直接撤回；已审批单据在会计期间打开时可撤回，审批与提交依据一并失效；' +
    '已付款单据在结账后不可撤回，必须先反结账。\n\n' +
    '本文档为模拟教学材料，不接入真实资金系统，也不构成任何财务合规结论。',
};
const docBudget = {
  key: 'doc-budget',
  kind: 'reading',
  title: '指南：预算管理',
  body:
    '预算按部门、按月编制：申报 → 审批通过后方可被报销单占用。被驳回后可修改金额重新申报。\n' +
    '预算占用 = 该部门当月所有未撤回/未驳回的报销单金额合计。',
};
const docMonthV1 = {
  key: 'doc-month',
  kind: 'reading',
  title: '指南：月结流程',
  body:
    '月结前检查：当月无草稿/待审批/待付款单据，所有报销单处于已付款/已驳回/已撤回。\n' +
    '结账后期间关闭，付款等操作被禁止；如发现错误，可反结账后更正，但原结账节点的依据将失效，需要重新结账。',
};
const docMonthV2 = {
  ...docMonthV1,
  body:
    docMonthV1.body +
    '\n\n【v2 更新】结账时必须留存结账报告截图作为归档依据，无截图的结账练习不予通过。',
};

// v2 月结练习：规则变更——要求结账截图；与 v1 评分不兼容
const monthV2 = {
  ...monthV1,
  scenario: monthV1.scenario + '（v2 规则：结账后必须上传结账报告截图。）',
  rule: {
    passScore: 80,
    requiresScreenshot: true,
    required: [{ type: 'MONTH_CLOSE', ref: '2026-09', label: '结转并关闭 2026-09 月（含报告截图）' }],
  },
};

const versions = {
  'finance101': {
    id: 'finance101',
    name: '财务软件实操入门',
    versions: {
      '1.0.0': {
        courseId: 'finance101',
        version: '1.0.0',
        publishedAt: '2026-08-01',
        nodes: [docReimburse, reimburseV1, docBudget, budgetV1, docMonthV1, monthV1],
        edges: [
          { from: 'doc-reimburse', to: 'ex-reimburse' },
          { from: 'doc-budget', to: 'ex-budget' },
          { from: 'doc-month', to: 'ex-month' },
          { from: 'ex-reimburse', to: 'ex-month' },
        ],
      },
      '2.0.0': {
        courseId: 'finance101',
        version: '2.0.0',
        publishedAt: '2026-10-01',
        nodes: [docReimburse, reimburseV1, docBudget, budgetV1, docMonthV2, monthV2],
        edges: [
          { from: 'doc-reimburse', to: 'ex-reimburse' },
          { from: 'doc-budget', to: 'ex-budget' },
          { from: 'doc-month', to: 'ex-month' },
          { from: 'ex-reimburse', to: 'ex-month' },
        ],
      },
    },
  },
};

function stableStringify(obj) {
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  if (obj && typeof obj === 'object') {
    return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
  }
  return JSON.stringify(obj);
}

function contentHash(node) {
  const crypto = require('crypto');
  if (node.kind === 'reading') return crypto.createHash('sha256').update(stableStringify(node.body)).digest('hex').slice(0, 12);
  return crypto.createHash('sha256').update(stableStringify(node.rule)).digest('hex').slice(0, 12);
}

function listCourses() {
  return Object.values(versions).map((c) => ({
    id: c.id,
    name: c.name,
    versions: Object.values(c.versions).map((v) => ({
      version: v.version,
      publishedAt: v.publishedAt,
      nodeCount: v.nodes.length,
    })),
  }));
}

function getCourseVersion(courseId, version) {
  return versions[courseId] && versions[courseId].versions[version] || null;
}

function getNode(cv, key) {
  return cv.nodes.find((n) => n.key === key) || null;
}

// 学生视图：剥离答案/规则内部细节（required 仅返回 label，绝不返回 type/ref；隐藏 seed）
function toStudentNode(node) {
  const base = { key: node.key, kind: node.kind, title: node.title, contentHash: contentHash(node) };
  if (node.kind === 'reading') return { ...base, body: node.body };
  return {
    ...base,
    scenario: node.scenario,
    passScore: node.rule.passScore,
    requiresScreenshot: node.rule.requiresScreenshot,
    tasks: node.rule.required.map((r, i) => ({ index: i, label: r.label })),
  };
}

function toTeacherNode(node) {
  const crypto = require('crypto');
  const ruleHash = node.kind === 'exercise'
    ? crypto.createHash('sha256').update(stableStringify(node.rule)).digest('hex').slice(0, 12)
    : null;
  return { ...node, contentHash: contentHash(node), ruleHash };
}

module.exports = {
  versions,
  listCourses,
  getCourseVersion,
  getNode,
  contentHash,
  stableStringify,
  toStudentNode,
  toTeacherNode,
};
