const express = require('express');
const path = require('path');
const { query, withTx } = require('./db');
const { applyAction, rollbackTransition, DomainError, loadLedger } = require('./services/ledger');
const { recomputeEnrollment, studentRule } = require('./services/grading');
const { buildComparison, cloneLedger } = require('./services/migration');
const { createEnrollment } = require('./services/enrollment');

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, '..', '..', 'frontend')));

// ---------- 认证（简单 Bearer token；演示用途） ----------
async function auth(req, res, next) {
  const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'UNAUTHORIZED', message: '缺少登录令牌' });
  const r = await query('SELECT * FROM users WHERE token=$1', [m[1]]);
  if (r.rowCount === 0) return res.status(401).json({ error: 'UNAUTHORIZED', message: '令牌无效' });
  req.user = r.rows[0];
  next();
}
const requireTeacher = (req, res, next) =>
  req.user.role !== 'teacher'
    ? res.status(403).json({ error: 'FORBIDDEN', message: '仅教师可访问' })
    : next();

async function ownedEnrollment(client, req, res) {
  const r = await client.query(
    'SELECT * FROM enrollments WHERE id=$1 AND student_id=$2',
    [req.params.id || req.body.enrollment_id, req.user.id]);
  if (r.rowCount === 0) {
    res.status(404).json({ error: 'NOT_FOUND', message: '报名记录不存在或不属于当前学生' });
    return null;
  }
  return r.rows[0];
}

// ---------- 认证/公开 ----------
app.post('/api/auth/login', async (req, res) => {
  const { username } = req.body || {};
  const r = await query('SELECT id, username, display_name, role, token FROM users WHERE username=$1', [username]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'NO_USER', message: '用户不存在' });
  res.json(r.rows[0]);
});

app.get('/api/catalog', auth, async (req, res) => {
  const r = await query(`
    SELECT c.id, c.code, c.title, c.description, cv.id AS cv_id, cv.version, cv.published_at
    FROM courses c JOIN course_versions cv ON cv.course_id = c.id
    ORDER BY c.id, cv.version`);
  // 学生目录同样不含任何答案字段
  res.json(r.rows);
});

// ---------- 学生：课程材料（不含教师答案） ----------
app.get('/api/courses/:cvId/material', auth, async (req, res) => {
  const cvId = Number(req.params.cvId);
  const rules = await query('SELECT * FROM grading_rules WHERE cv_id=$1 ORDER BY ordering', [cvId]);
  const pages = await query('SELECT id, slug, title, ordering FROM doc_pages WHERE cv_id=$1 ORDER BY ordering', [cvId]);
  res.json({
    nodes: rules.rows.map(studentRule),         // 关键：学生拿不到 required_transitions
    pages: pages.rows,
  });
});

app.get('/api/courses/:cvId/pages/:slug', auth, async (req, res) => {
  const r = await query(
    'SELECT slug, title, content FROM doc_pages WHERE cv_id=$1 AND slug=$2',
    [Number(req.params.cvId), req.params.slug]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json(r.rows[0]);
});

// ---------- 学生：报名 ----------
app.post('/api/enrollments', auth, async (req, res) => {
  const cvId = Number(req.body.cv_id);
  try {
    const id = await withTx(c => createEnrollment(c, { studentId: req.user.id, cvId }));
    res.json({ enrollment_id: id });
  } catch (e) {
    res.status(400).json({ error: 'ENROLL_FAILED', message: e.message });
  }
});

// ---------- 学生：云端状态（刷新后恢复） ----------
app.get('/api/enrollments/:id/state', auth, async (req, res) => {
  try {
    const result = await withTx(async client => {
      const enr = await ownedEnrollment(client, req, res);
      if (!enr) return null;
      const ledger = await loadLedger(client, enr.id);
      const prog = await client.query(
        'SELECT node_code, rule_version, status, score, old_score, reason, scored_transitions, read_at, passed_at, updated_at FROM node_progress WHERE enrollment_id=$1 ORDER BY updated_at',
        [enr.id]);
      const trans = await client.query(`
        SELECT id, doc_uid, doc_type, from_state, to_state, action, client_op_id,
               server_ts, client_ts, device_id, undone_at, undo_of_id
        FROM transitions WHERE enrollment_id=$1 ORDER BY id`, [enr.id]);
      const evs = await client.query(
        'SELECT id, node_code, status, failure_note, created_at FROM evidences WHERE enrollment_id=$1 ORDER BY id',
        [enr.id]);
      return {
        enrollment_id: enr.id, cv_id: enr.cv_id, branch_name: enr.branch_name,
        ledger_version: enr.ledger_version,
        ledger, transitions: trans.rows, progress: prog.rows, evidences: evs.rows,
      };
    });
    if (result) res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'STATE_ERROR', message: e.message });
  }
});

// ---------- 学生：单个动作 ----------
app.post('/api/enrollments/:id/actions', auth, async (req, res) => {
  try {
    const out = await withTx(async client => {
      const enr = await ownedEnrollment(client, req, res);
      if (!enr) return { __http: 404 };
      const r = await applyAction(client, enr.id, req.body, {
        expectedVersion: req.body.expected_version,
      });
      await recomputeEnrollment(client, enr.id);
      return r;
    });
    if (out.__http) return res.status(out.__http).end();
    res.json(out);
  } catch (e) {
    const status = e instanceof DomainError
      ? (e.code === 'VERSION_CONFLICT' ? 409 : 422) : 500;
    res.status(status).json({ error: e.code || 'ACTION_FAILED', message: e.message,
      ...(e.serverVersion ? { server_version: e.serverVersion } : {}) });
  }
});

// ---------- 学生：离线批量同步（补交）。逐动作处理：幂等/非法返回错误，不影响其他动作 ----------
app.post('/api/enrollments/:id/sync', auth, async (req, res) => {
  const actions = Array.isArray(req.body.actions) ? req.body.actions : [];
  const out = await withTx(async client => {
    const enr = await ownedEnrollment(client, req, res);
    if (!enr) return { __http: 404 };
    const results = [];
    let applied = 0, rejected = 0, duplicate = 0;
    for (const a of actions) {
      try {
        const r = await applyAction(client, enr.id, a, {}); // 批量同步不强校验版本，逐动作按当前状态校验
        if (r.idempotent) { duplicate++; results.push({ client_op_id: a.client_op_id, ok: true, idempotent: true }); }
        else { applied++; results.push({ client_op_id: a.client_op_id, ok: true, server_version: r.serverVersion }); }
      } catch (e) {
        rejected++;
        results.push({ client_op_id: a.client_op_id || null, ok: false, error: e.code, message: e.message });
      }
    }
    const progress = await recomputeEnrollment(client, enr.id);
    const ver = (await client.query('SELECT ledger_version FROM enrollments WHERE id=$1', [enr.id])).rows[0].ledger_version;
    return { applied, rejected, duplicate, results, server_version: ver, progress };
  });
  if (out && out.__http) return res.status(out.__http).end();
  res.json(out);
});

// ---------- 学生：回滚（撤回模拟单据的一步，事件溯源） ----------
app.post('/api/enrollments/:id/rollback', auth, async (req, res) => {
  try {
    const out = await withTx(async client => {
      const enr = await ownedEnrollment(client, req, res);
      if (!enr) return { __http: 404 };
      const r = await rollbackTransition(client, enr.id, Number(req.body.transition_id),
        { deviceId: req.body.device_id });
      const progress = await recomputeEnrollment(client, enr.id);
      return { ...r, progress };
    });
    if (out.__http) return res.status(out.__http).end();
    res.json(out);
  } catch (e) {
    res.status(e instanceof DomainError ? 422 : 500)
      .json({ error: e.code || 'ROLLBACK_FAILED', message: e.message });
  }
});

// ---------- 学生：阅读完成 ----------
app.post('/api/enrollments/:id/read', auth, async (req, res) => {
  try {
    const out = await withTx(async client => {
      const enr = await ownedEnrollment(client, req, res);
      if (!enr) return { __http: 404 };
      const rule = await client.query(
        'SELECT gr.*, cv.version FROM grading_rules gr JOIN course_versions cv ON cv.id=gr.cv_id WHERE gr.cv_id=$1 AND gr.node_code=$2',
        [enr.cv_id, req.body.node_code]);
      if (rule.rowCount === 0 || rule.rows[0].required_transitions.length !== 0) {
        throw new DomainError('NOT_A_READING_NODE', '该节点不是阅读节点');
      }
      await client.query(`
        INSERT INTO node_progress (enrollment_id, node_code, rule_version, status, score, reason, read_at, passed_at)
        VALUES ($1,$2,$3,'reading_done',100,'READ',now(),now())
        ON CONFLICT (enrollment_id, node_code) DO UPDATE SET
          status='reading_done', score=100, reason='READ', read_at=now(), passed_at=now(), updated_at=now()`,
        [enr.id, req.body.node_code, rule.rows[0].version]);
      return { ok: true };
    });
    if (out.__http) return res.status(out.__http).end();
    res.json(out);
  } catch (e) {
    res.status(e instanceof DomainError ? 422 : 500)
      .json({ error: e.code || 'READ_FAILED', message: e.message });
  }
});

// ---------- 学生：截图证据（支持"截图失败"场景：?fail=1 或 status=failed） ----------
app.post('/api/enrollments/:id/evidence', auth, async (req, res) => {
  try {
    const out = await withTx(async client => {
      const enr = await ownedEnrollment(client, req, res);
      if (!enr) return { __http: 404 };
      const fail = req.query.fail === '1' || (req.body && req.body.status === 'failed');
      const nodeCode = req.body.node_code;
      const note = fail ? (req.body.failure_note || '截图上传失败：网络错误/文件损坏') : '';
      const er = await client.query(`
        INSERT INTO evidences (enrollment_id, node_code, content_type, byte_size, status, failure_note)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [enr.id, nodeCode, req.body.content_type || 'image/png',
         fail ? 0 : (req.body.byte_size || 1024), fail ? 'failed' : 'uploaded', note]);
      if (!fail) {
        await client.query('UPDATE node_progress SET evidence_id=$1, updated_at=now() WHERE enrollment_id=$2 AND node_code=$3',
          [er.rows[0].id, enr.id, nodeCode]);
      }
      const progress = await recomputeEnrollment(client, enr.id);
      return { evidence: { id: er.rows[0].id, status: er.rows[0].status, failure_note: note }, progress };
    });
    if (out.__http) return res.status(out.__http).end();
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: 'EVIDENCE_FAILED', message: e.message });
  }
});

// ---------- 学生：课程升级 —— 比较两种迁移模式 ----------
app.get('/api/enrollments/:id/upgrade-plan', auth, async (req, res) => {
  try {
    const plan = await withTx(async client => {
      const enr = await ownedEnrollment(client, req, res);
      if (!enr) return { __http: 404 };
      const toCvId = Number(req.query.to_cv_id);
      return buildComparison(client, req.user.id, enr.cv_id, toCvId);
    });
    if (plan.__http) return res.status(plan.__http).end();
    res.json(plan);
  } catch (e) {
    res.status(e.code === 'NOT_FOUND' ? 404 : 500).json({ error: e.code, message: e.message });
  }
});

// mode=migrate: 继承已完成节点（保留原成绩）；mode=branch: 重开练习分支（旧分支冻结）
app.post('/api/enrollments/:id/upgrade', auth, async (req, res) => {
  try {
    const out = await withTx(async client => {
      const enr = await ownedEnrollment(client, req, res);
      if (!enr) return { __http: 404 };
      const toCvId = Number(req.body.to_cv_id);
      const mode = req.body.mode === 'branch' ? 'branch' : 'migrate';
      const plan = await buildComparison(client, req.user.id, enr.cv_id, toCvId);

      const newVer = (await client.query('SELECT version FROM course_versions WHERE id=$1', [toCvId])).rows[0].version;

      // 分支名：main -> v2 / v2-branch，避免冲突
      const branchName = mode === 'branch'
        ? `v${newVer}-branch` : `v${newVer}`;
      const newId = await createEnrollment(client, {
        studentId: req.user.id, cvId: toCvId, branchName, parentEnrollment: enr.id });

      const inheritedNodes = [];
      let oldScoreKept = 0;
      if (mode === 'migrate') {
        await cloneLedger(client, plan.old_enrollment_id, newId);
        // 1) 先克隆旧进度：原成绩与旧规则版本保留到新报名（含 old_score 快照）
        await client.query(`
          INSERT INTO node_progress
            (enrollment_id, node_code, rule_version, status, score, old_score,
             scored_transitions, reason, read_at, passed_at, updated_at)
          SELECT $1, node_code, rule_version, status, score, score,
                 scored_transitions, reason || '_PRESERVED', read_at, passed_at, now()
          FROM node_progress WHERE enrollment_id=$2
          ON CONFLICT (enrollment_id, node_code) DO UPDATE SET
            old_score=EXCLUDED.score,
            rule_version=node_progress.rule_version, updated_at=now()`,
          [newId, plan.old_enrollment_id]);
        // 2) 按新版规则重放转移重算：匹配即继承为 passed；不兼容节点降为 pending
        await recomputeEnrollment(client, newId);
        // 3) 阅读节点沿用旧版本的阅读完成状态（重算只处理练习节点）
        await client.query(`
          UPDATE node_progress np SET status='reading_done', score=100,
                 reason='READ_CARRIED', read_at=COALESCE(np.read_at, now()),
                 passed_at=COALESCE(np.passed_at, now()), updated_at=now()
          FROM grading_rules gr
          WHERE np.enrollment_id=$1 AND np.node_code=gr.node_code AND gr.cv_id=$2
            AND jsonb_array_length(gr.required_transitions)=0
            AND (SELECT status FROM node_progress o
                 WHERE o.enrollment_id=$3 AND o.node_code=np.node_code)='reading_done'`,
          [newId, toCvId, plan.old_enrollment_id]);
        const kept = await client.query(
          `SELECT node_code, old_score, status FROM node_progress
           WHERE enrollment_id=$1 AND status='passed' AND old_score IS NOT NULL`, [newId]);
        for (const k of kept.rows) { inheritedNodes.push(k.node_code); oldScoreKept += k.old_score; }
      }

      await client.query(`
        INSERT INTO migrations (student_id, from_cv_id, to_cv_id, mode, target_enrollment_id,
          inherited_nodes, old_score_kept, comparison)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [req.user.id, enr.cv_id, toCvId, mode, newId,
         JSON.stringify(inheritedNodes), inheritedNodes.length ? Math.round(oldScoreKept / inheritedNodes.length) : 0,
         JSON.stringify(plan.comparison)]);

      return { mode, new_enrollment_id: newId, branch_name: branchName,
               inherited_nodes: inheritedNodes, old_enrollment_id: enr.id,
               old_enrollment_frozen: mode === 'branch', plan: plan.comparison };
    });
    if (out.__http) return res.status(out.__http).end();
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: 'UPGRADE_FAILED', message: e.message });
  }
});

// ---------- 教师：规则（含答案 expected path），学生 403 ----------
app.get('/api/teacher/course-versions/:cvId/rules', auth, requireTeacher, async (req, res) => {
  const r = await query(
    `SELECT gr.*, cv.version AS course_version FROM grading_rules gr
     JOIN course_versions cv ON cv.id=gr.cv_id
     WHERE gr.cv_id=$1 ORDER BY gr.ordering`, [Number(req.params.cvId)]);
  res.json(r.rows);
});

// 教师：修改规则只能在新版本上进行（规则变更 -> 新版本，旧评分按 rule_version 保留）
app.post('/api/teacher/courses/:courseId/new-version', auth, requireTeacher, async (req, res) => {
  try {
    const out = await withTx(async client => {
      const courseId = Number(req.params.courseId);
      const last = await client.query(
        'SELECT * FROM course_versions WHERE course_id=$1 ORDER BY version DESC LIMIT 1', [courseId]);
      if (last.rowCount === 0) throw Object.assign(new Error('课程不存在'), { code: 'NOT_FOUND' });
      const nv = last.rows[0].version + 1;
      const created = await client.query(
        'INSERT INTO course_versions (course_id, version, parent_id) VALUES ($1,$2,$3) RETURNING *',
        [courseId, nv, last.rows[0].id]);
      // 复制旧规则
      await client.query(
        'INSERT INTO grading_rules (cv_id, node_code, title, doc_type, required_transitions, requires_evidence, prereq_node, ordering) SELECT $1, node_code, title, doc_type, required_transitions, requires_evidence, prereq_node, ordering FROM grading_rules WHERE cv_id=$2',
        [created.rows[0].id, last.rows[0].id]);
      await client.query(
        'INSERT INTO doc_pages (cv_id, slug, title, content, ordering) SELECT $1, slug, title, content, ordering FROM doc_pages WHERE cv_id=$2',
        [created.rows[0].id, last.rows[0].id]);
      // 应用规则变更（可选）：updates: [{node_code, required_transitions, title, requires_evidence}]
      for (const u of (req.body.updates || [])) {
        await client.query(
          `UPDATE grading_rules SET
             required_transitions=COALESCE($3, required_transitions),
             title=COALESCE($4, title),
             requires_evidence=COALESCE($5, requires_evidence)
           WHERE cv_id=$1 AND node_code=$2`,
          [created.rows[0].id, u.node_code,
           u.required_transitions ? JSON.stringify(u.required_transitions) : null,
           u.title || null, u.requires_evidence === undefined ? null : Number(u.requires_evidence)]);
      }
      return created.rows[0];
    });
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: 'NEW_VERSION_FAILED', message: e.message });
  }
});

// 教师：查任意学生进度（教师接口可以看评分细节）
app.get('/api/teacher/enrollments/:id/progress', auth, requireTeacher, async (req, res) => {
  const r = await query(`
    SELECT np.*, u.username FROM node_progress np
    JOIN enrollments e ON e.id=np.enrollment_id JOIN users u ON u.id=e.student_id
    WHERE np.enrollment_id=$1 ORDER BY np.node_code`, [Number(req.params.id)]);
  res.json(r.rows);
});

app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// SPA fallback
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', '..', 'frontend', 'index.html'));
});

module.exports = app;
