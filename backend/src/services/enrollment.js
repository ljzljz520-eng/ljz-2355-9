// 报名：为学生创建一个练习账套（预算/报销/月结三张虚构单据，全部初始态）
async function createEnrollment(client, { studentId, cvId, branchName = 'main', parentEnrollment = null }) {
  const ex = await client.query(
    'SELECT id FROM enrollments WHERE student_id=$1 AND cv_id=$2 AND branch_name=$3',
    [studentId, cvId, branchName]);
  if (ex.rowCount > 0) return ex.rows[0].id;

  const r = await client.query(`
    INSERT INTO enrollments (student_id, cv_id, branch_name, parent_enrollment)
    VALUES ($1,$2,$3,$4) RETURNING id`, [studentId, cvId, branchName, parentEnrollment]);
  const enrollmentId = r.rows[0].id;

  const docs = [
    { doc_uid: 'budget-1', doc_type: 'budget', title: '10月部门预算（虚构）', amount: 5000000 },
    { doc_uid: 'reimb-1', doc_type: 'reimbursement', title: '差旅费报销单（虚构）', amount: 320000 },
    { doc_uid: 'month-end-1', doc_type: 'month_end', title: '2026-10 月结（虚构）', amount: 0 },
  ];
  for (const d of docs) {
    const initState = d.doc_type === 'month_end' ? 'open' : 'draft';
    await client.query(`
      INSERT INTO docs (enrollment_id, doc_uid, doc_type, title, amount_cents, state)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (enrollment_id, doc_uid) DO NOTHING`,
      [enrollmentId, d.doc_uid, d.doc_type, d.title, d.amount, initState]);
  }

  // 初始化阅读/练习节点进度
  const rules = await client.query('SELECT * FROM grading_rules WHERE cv_id=$1', [cvId]);
  for (const rule of rules.rows) {
    await client.query(`
      INSERT INTO node_progress (enrollment_id, node_code, rule_version, status, score, reason)
      SELECT $1, node_code, $2::int, 'pending', 0, '' FROM grading_rules
      WHERE cv_id=$3 AND node_code=$4
      ON CONFLICT (enrollment_id, node_code) DO NOTHING`,
      [enrollmentId, (await client.query('SELECT version FROM course_versions WHERE id=$1', [cvId])).rows[0].version,
       cvId, rule.node_code]);
  }
  return enrollmentId;
}

module.exports = { createEnrollment };
