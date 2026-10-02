// 初始化演示数据：教师/学生、课程 v1（报销/预算/月结）、规则升级 v2
const crypto = require('crypto');
const { query, withTx, applySchema } = require('./db');

function token() { return crypto.randomBytes(24).toString('hex'); }

async function ensureUser(username, displayName, role) {
  const ex = await query('SELECT id, token FROM users WHERE username=$1', [username]);
  if (ex.rowCount) return { id: ex.rows[0].id, token: ex.rows[0].token };
  const t = token();
  const r = await query(
    'INSERT INTO users (username, display_name, role, token) VALUES ($1,$2,$3,$4) RETURNING id, token',
    [username, displayName, role, t]);
  return { id: r.rows[0].id, token: r.rows[0].token };
}

const DOC_CONTENT = {
  reimbursement: `# 报销模拟流程\n\n本页演示一笔虚构报销单的生命周期：**草稿 → 已提交 → 已批准 → 已支付**。
\n\n- **提交**前必须已有审批通过的预算，且占用后不超预算余额（前置条件）。\n- 审批人可**退回**，单据回到草稿可修改后再提交。\n- 支付后仍可**撤回（冲销）**：撤回会把单据打回草稿，其下游步骤（如月结）可能因此失去依据而被标记"需重做"。\n\n> 本中心为教学模拟环境，不接入任何真实资金系统，所有金额均为虚构数据，不构成任何财务合规结论。`,
  budget: `# 预算模拟流程\n\n预算单：**草稿 → 已提交 → 已批准 →（月结时自动冻结）**。\n\n- 预算审批通过后，报销单才允许提交，所有非草稿报销合计不得超过预算金额。\n- 月结关闭时系统自动**冻结**预算；若月结被撤回重开，预算自动**解冻**——这是训练操作相互影响的示例。`,
  month_end: `# 月结模拟流程\n\n月结：**open（开放）→ closed（已结账）→ reopen（重开）**。\n\n- 月结前置条件：预算已批准，且所有非草稿报销均已支付。\n- 月结练习要求上传一张**截图凭证**；截图上传失败时节点会显示"需重做"，可重新上传后再次评分。\n- 已结账后若撤回一张报销单，月结自动重开、预算解冻，月结节点因依据丢失变为"需重做"。`,
};

const V1_NODES = [
  { code: 'read_reimbursement', title: '阅读：报销流程', doc_type: 'reimbursement',
    required: [], evidence: 0, prereq: null, slug: 'reimbursement' },
  { code: 'read_budget', title: '阅读：预算流程', doc_type: 'budget',
    required: [], evidence: 0, prereq: 'read_reimbursement', slug: 'budget' },
  { code: 'read_month_end', title: '阅读：月结流程', doc_type: 'month_end',
    required: [], evidence: 0, prereq: 'read_budget', slug: 'month_end' },
  { code: 'prac_budget', title: '练习：编制并审批预算', doc_type: 'budget',
    required: [{ doc_type: 'budget', action: 'submit' },
               { doc_type: 'budget', action: 'approve' }],
    evidence: 0, prereq: 'read_month_end' },
  { code: 'prac_reimbursement', title: '练习：提交并完成一笔报销', doc_type: 'reimbursement',
    required: [{ doc_type: 'reimbursement', action: 'submit' },
               { doc_type: 'reimbursement', action: 'approve' },
               { doc_type: 'reimbursement', action: 'pay' }],
    evidence: 0, prereq: 'prac_budget' },
  { code: 'prac_month_end', title: '练习：月末结账（需截图）', doc_type: 'month_end',
    required: [{ doc_type: 'month_end', action: 'close' }],
    evidence: 1, prereq: 'prac_reimbursement' },
];

// v2 规则变更：报销练习增加「退回后再提交」的严谨路径，月结仍要求截图
const V2_NODES = [
  { code: 'read_reimbursement', title: '阅读：报销流程（第2版）', doc_type: 'reimbursement',
    required: [], evidence: 0, prereq: null, slug: 'reimbursement' },
  { code: 'read_budget', title: '阅读：预算流程（第2版）', doc_type: 'budget',
    required: [], evidence: 0, prereq: 'read_reimbursement', slug: 'budget' },
  { code: 'read_month_end', title: '阅读：月结流程（第2版）', doc_type: 'month_end',
    required: [], evidence: 0, prereq: 'read_budget', slug: 'month_end' },
  { code: 'prac_budget', title: '练习：编制并审批预算', doc_type: 'budget',
    required: [{ doc_type: 'budget', action: 'submit' },
               { doc_type: 'budget', action: 'approve' }],
    evidence: 0, prereq: 'read_month_end' },
  { code: 'prac_reimbursement', title: '练习：完整报销（含一次退回修改）', doc_type: 'reimbursement',
    required: [{ doc_type: 'reimbursement', action: 'submit' },
               { doc_type: 'reimbursement', action: 'reject' },
               { doc_type: 'reimbursement', action: 'submit' },
               { doc_type: 'reimbursement', action: 'approve' },
               { doc_type: 'reimbursement', action: 'pay' }],
    evidence: 0, prereq: 'prac_budget' },
  { code: 'prac_month_end', title: '练习：月末结账（需截图）', doc_type: 'month_end',
    required: [{ doc_type: 'month_end', action: 'close' }],
    evidence: 1, prereq: 'prac_reimbursement' },
];

async function seedVersion(cvId, nodes) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    await query(
      `INSERT INTO grading_rules (cv_id, node_code, title, doc_type, required_transitions,
        requires_evidence, prereq_node, ordering)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (cv_id, node_code) DO NOTHING`,
      [cvId, n.code, n.title, n.doc_type, JSON.stringify(n.required),
       n.evidence, n.prereq, i]);
    if (n.slug) {
      await query(
        `INSERT INTO doc_pages (cv_id, slug, title, content, ordering)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (cv_id, slug) DO NOTHING`,
        [cvId, n.slug, DOC_CONTENT[n.slug].split('\n')[0].replace('# ', ''),
         DOC_CONTENT[n.slug], i]);
    }
  }
}

async function seed() {
  await applySchema();

  const teacher = await ensureUser('teacher1', '王老师', 'teacher');
  const student = await ensureUser('student1', '李同学', 'student');
  const student2 = await ensureUser('student2', '赵同学', 'student');

  let course = await query('SELECT id FROM courses WHERE code=$1', ['fin_core']);
  let courseId;
  if (course.rowCount === 0) {
    const c = await query(
      'INSERT INTO courses (code, title, description, created_by) VALUES ($1,$2,$3,$4) RETURNING id',
      ['fin_core', '财务软件操作：报销·预算·月结',
       '基于虚构账套的模拟训练，含前置条件、相互影响与状态转移评分', teacher.id]);
    courseId = c.rows[0].id;
  } else courseId = course.rows[0].id;

  let v1 = await query('SELECT id FROM course_versions WHERE course_id=$1 AND version=1', [courseId]);
  let v1Id;
  if (v1.rowCount === 0) {
    const r = await query(
      'INSERT INTO course_versions (course_id, version, parent_id) VALUES ($1,1,NULL) RETURNING id',
      [courseId]);
    v1Id = r.rows[0].id;
  } else v1Id = v1.rows[0].id;
  await seedVersion(v1Id, V1_NODES);

  // v2：规则升级（旧练习数据可能不兼容）
  let v2 = await query('SELECT id FROM course_versions WHERE course_id=$1 AND version=2', [courseId]);
  let v2Id;
  if (v2.rowCount === 0) {
    const r = await query(
      'INSERT INTO course_versions (course_id, version, parent_id) VALUES ($1,2,$2) RETURNING id',
      [courseId, v1Id]);
    v2Id = r.rows[0].id;
  } else v2Id = v2.rows[0].id;
  await seedVersion(v2Id, V2_NODES);

  return { teacher, student, student2, courseId, v1Id, v2Id };
}

module.exports = { seed, seedVersion, ensureUser };

if (require.main === module) {
  seed().then(r => {
    console.log('seeded:', JSON.stringify(r, null, 2));
    process.exit(0);
  }).catch(e => { console.error(e); process.exit(1); });
}
