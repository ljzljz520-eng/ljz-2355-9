// 课程升级迁移：
//  mode=migrate —— 用新版规则重放旧转移，匹配上的节点「继承」，保留原成绩；
//  mode=branch  —— 旧分支原样冻结（原成绩保留），另开新分支从头练习。
// 比较两种模式后返回继承依据。
async function buildComparison(client, studentId, fromCvId, toCvId) {
  const oldEnr = await client.query(`
    SELECT e.* FROM enrollments e
    WHERE e.student_id=$1 AND e.cv_id=$2 AND e.parent_enrollment IS NULL
    ORDER BY e.id DESC LIMIT 1`, [studentId, fromCvId]);
  if (oldEnr.rowCount === 0) throw Object.assign(new Error('旧版本报名不存在'), { code: 'NOT_FOUND' });
  const oldId = oldEnr.rows[0].id;

  const oldTrans = await client.query(`
    SELECT doc_uid, doc_type, action, to_state FROM transitions
    WHERE enrollment_id=$1 AND undone_at IS NULL AND undo_of_id IS NULL ORDER BY id`, [oldId]);
  const oldProgress = await client.query(
    'SELECT * FROM node_progress WHERE enrollment_id=$1 ORDER BY node_code', [oldId]);

  const newRules = await client.query(
    'SELECT * FROM grading_rules WHERE cv_id=$1 ORDER BY ordering', [toCvId]);
  const newVer = await client.query('SELECT version FROM course_versions WHERE id=$1', [toCvId]);

  const inherited = [];
  for (const rule of newRules.rows) {
    const required = rule.required_transitions || [];
    if (required.length === 0) continue; // 阅读节点不迁移，新版重读
    let cursor = 0; const basis = [];
    for (const req of required) {
      let found = -1;
      for (let i = cursor; i < oldTrans.rows.length; i++) {
        const t = oldTrans.rows[i];
        if (t.doc_type === req.doc_type && t.action === req.action) { found = i; break; }
      }
      if (found >= 0) {
        cursor = found + 1;
        basis.push({ doc_type: req.doc_type, action: req.action,
          old_transition_action: oldTrans.rows[found].action });
      }
    }
    const oldP = oldProgress.rows.find(p => p.node_code === rule.node_code);
    if (basis.length === required.length && oldP && oldP.status === 'passed') {
      inherited.push({
        node_code: rule.node_code,
        title: rule.title,
        old_score: oldP.score,
        old_rule_version: oldP.rule_version,
        basis,
        inheritable: true,
      });
    } else {
      inherited.push({
        node_code: rule.node_code,
        title: rule.title,
        old_score: oldP ? oldP.score : 0,
        old_status: oldP ? oldP.status : 'pending',
        inheritable: false,
        reason: basis.length < required.length
          ? `新版规则要求 ${required.length} 个状态转移，旧练习仅匹配 ${basis.length} 个（数据与旧评分不兼容）`
          : '旧版本该节点未通过',
        matched: basis.length, required: required.length,
      });
    }
  }

  const oldTotal = oldProgress.rows.length
    ? Math.round(oldProgress.rows.reduce((s, p) => s + Number(p.score), 0) / oldProgress.rows.length)
    : 0;
  const inheritCount = inherited.filter(n => n.inheritable).length;
  const newTotal = newRules.rows.filter(r => r.required_transitions.length > 0).length;

  return {
    from_cv_id: fromCvId, to_cv_id: toCvId,
    new_course_version: newVer.rows[0].version,
    old_enrollment_id: oldId,
    old_overall_score: oldTotal,
    comparison: {
      migrate: {
        label: '迁移已完成节点',
        inherited_count: inheritCount,
        practice_nodes_total: newTotal,
        old_score_kept: true,
        projected_score: newTotal
          ? Math.round(inherited.reduce((s, n) => s + (n.inheritable ? 100 : 0), 0) / newTotal) : 0,
        description: '继承节点以旧状态转移为依据并保留原成绩；不兼容节点需重做',
      },
      branch: {
        label: '重开练习分支',
        inherited_count: 0,
        practice_nodes_total: newTotal,
        old_score_kept: true,
        old_branch_frozen: true,
        projected_score: 0,
        description: '旧分支与原成绩完整保留为只读，新分支从空白账套重新练习',
      },
    },
    nodes: inherited,
  };
}

// 复制旧账套到已初始化的新报名：单据已由 createEnrollment 建好，这里把状态推进到旧值并复制转移
async function cloneLedger(client, oldEnrollmentId, newEnrollmentId) {
  const docs = await client.query('SELECT * FROM docs WHERE enrollment_id=$1', [oldEnrollmentId]);
  for (const d of docs.rows) {
    // 新报名可能有自定义单据；存在则更新状态，不存在才插入
    const ex = await client.query(
      'SELECT 1 FROM docs WHERE enrollment_id=$1 AND doc_uid=$2', [newEnrollmentId, d.doc_uid]);
    if (ex.rowCount) {
      await client.query(
        'UPDATE docs SET state=$1, amount_cents=$2, title=$3 WHERE enrollment_id=$4 AND doc_uid=$5',
        [d.state, d.amount_cents, d.title, newEnrollmentId, d.doc_uid]);
    } else {
      await client.query(`INSERT INTO docs
        (enrollment_id, doc_uid, doc_type, title, amount_cents, state, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [newEnrollmentId, d.doc_uid, d.doc_type, d.title, d.amount_cents, d.state, d.created_at]);
    }
  }
  const trs = await client.query(
    'SELECT * FROM transitions WHERE enrollment_id=$1 ORDER BY id', [oldEnrollmentId]);
  for (const t of trs.rows) {
    await client.query(`INSERT INTO transitions
      (enrollment_id, doc_uid, doc_type, from_state, to_state, action, client_op_id,
       server_ts, client_ts, device_id, undone_at, undo_of_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [newEnrollmentId, t.doc_uid, t.doc_type, t.from_state, t.to_state, t.action,
       t.client_op_id, t.server_ts, t.client_ts, t.device_id, t.undone_at, t.undo_of_id]);
  }
}

module.exports = { buildComparison, cloneLedger };
