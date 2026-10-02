// 评分：依据「状态转移」匹配规则期望路径，与点击顺序无关。
// 规则升级后旧进度按当时的 rule_version 保留；本函数只对报名所属版本评分。
async function recomputeEnrollment(client, enrollmentId) {
  const enr = await client.query('SELECT * FROM enrollments WHERE id=$1', [enrollmentId]);
  if (enr.rowCount === 0) return [];
  const cvId = enr.rows[0].cv_id;
  const cvRes = await client.query('SELECT version FROM course_versions WHERE id=$1', [cvId]);
  const versionNo = cvRes.rows[0].version;

  const rules = await client.query(
    'SELECT * FROM grading_rules WHERE cv_id=$1 ORDER BY ordering', [cvId]);
  const acts = await client.query(`
    SELECT * FROM transitions
    WHERE enrollment_id=$1 AND undone_at IS NULL AND undo_of_id IS NULL
    ORDER BY id`, [enrollmentId]);
  const active = acts.rows;
  const evid = await client.query(
    `SELECT DISTINCT ON (node_code) * FROM evidences
     WHERE enrollment_id=$1 ORDER BY node_code, id DESC`, [enrollmentId]);
  const evidenceStatus = {};
  for (const e of evid.rows) evidenceStatus[e.node_code] = e.status;

  const results = [];
  const passMap = {};

  for (const rule of rules.rows) {
    const required = rule.required_transitions || [];
    // 阅读类节点由 read 接口处理，这里跳过
    if (required.length === 0) continue;

    // 前置节点必须已通过
    let blocked = false;
    if (rule.prereq_node && passMap[rule.prereq_node] !== true) blocked = true;

    // 匹配依据：按 (doc_type, action) 顺序消费有效转移（状态转移而非点击顺序）
    let cursor = 0;
    const matchedIds = [];
    const matchedPath = [];
    for (const req of required) {
      let found = null;
      for (let i = cursor; i < active.length; i++) {
        const t = active[i];
        if (t.doc_type === req.doc_type && t.action === req.action) { found = i; break; }
      }
      if (found !== null) {
        cursor = found + 1;
        matchedIds.push(active[found].id);
        matchedPath.push({ doc_type: req.doc_type, action: req.action, transition_id: active[found].id });
      }
    }
    const matchedCount = matchedPath.length;
    const allMatched = matchedCount === required.length;
    const score = Math.round((matchedCount / required.length) * 100);

    // 证据（截图）要求：最新一条证据的状态
    let evidenceState = 'none';
    if (rule.requires_evidence) {
      evidenceState = evidenceStatus[rule.node_code] === 'uploaded' ? 'uploaded'
        : evidenceStatus[rule.node_code] === 'failed' ? 'failed' : 'missing';
    }

    const prev = await client.query(
      'SELECT * FROM node_progress WHERE enrollment_id=$1 AND node_code=$2',
      [enrollmentId, rule.node_code]);
    const prevRow = prev.rows[0];
    const wasPassed = prevRow && prevRow.status === 'passed';

    let status;
    let reason = '';
    const evidenceOk = !rule.requires_evidence || evidenceState === 'uploaded';
    if (allMatched && evidenceOk) {
      status = 'passed';
      reason = wasPassed ? 'REMAINS_PASSED' : 'PASSED';
    } else if (wasPassed) {
      // 撤回单据导致通过依据消失 / 截图失败或被回滚失效 -> 需重做
      status = 'needs_redo';
      reason = !allMatched ? 'BASIS_LOST_AFTER_ROLLBACK'
        : (evidenceState === 'failed' ? 'EVIDENCE_FAILED' : 'EVIDENCE_MISSING');
    } else if (rule.requires_evidence && allMatched && evidenceState === 'failed') {
      status = 'needs_redo';
      reason = 'EVIDENCE_FAILED';
    } else if (matchedCount > 0) {
      status = 'pending';
      reason = 'IN_PROGRESS';
    } else {
      status = 'pending';
      reason = blocked ? 'PREREQ_NOT_PASSED' : '';
    }

    passMap[rule.node_code] = status === 'passed';

    await client.query(`
      INSERT INTO node_progress (enrollment_id, node_code, rule_version, status, score,
        scored_transitions, reason, passed_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $4='passed' THEN now()
        ELSE (SELECT passed_at FROM node_progress WHERE enrollment_id=$1 AND node_code=$2) END, now())
      ON CONFLICT (enrollment_id, node_code) DO UPDATE SET
        rule_version=EXCLUDED.rule_version, status=EXCLUDED.status, score=EXCLUDED.score,
        old_score=node_progress.old_score,
        scored_transitions=EXCLUDED.scored_transitions, reason=EXCLUDED.reason,
        passed_at=EXCLUDED.passed_at, updated_at=now()`,
      [enrollmentId, rule.node_code, versionNo, status, score,
       JSON.stringify(matchedPath), reason]);

    results.push({ node_code: rule.node_code, status, score, reason, matched: matchedCount,
      required: required.length });
  }
  return results;
}

// 学生视角的规则序列化：绝不包含 expected path（required_transitions）——
// 教师答案只走教师接口；浏览器隐藏不算隔离。
function studentRule(r) {
  return {
    node_code: r.node_code,
    title: r.title,
    doc_type: r.doc_type,
    requires_evidence: !!r.requires_evidence,
    prereq_node: r.prereq_node,
    ordering: r.ordering,
    is_reading: (r.required_transitions || []).length === 0,
  };
}

module.exports = { recomputeEnrollment, studentRule };
