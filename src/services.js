// 业务服务层：练习分支生命周期、操作应用、状态转移评分、回滚、版本迁移。
// 不依赖具体存储；repo 可以是 pgRepo 或 memoryRepo。
'use strict';

const crypto = require('crypto');
const catalog = require('./catalog');
const ledger = require('./engine/ledger');
const { annulPlan, gradeExercise } = require('./engine/grade');

function ruleHash(node) {
  const crypto2 = crypto;
  return crypto2.createHash('sha256').update(catalog.stableStringify(node.rule)).digest('hex').slice(0, 12);
}

function httpError(status, code, message, extra) {
  return Object.assign(new Error(message), { status, code }, extra || {});
}

async function loadContext(repo, userId, courseId, version, nodeKey) {
  const enr = await repo.getEnrollment(userId, courseId);
  if (!enr) throw httpError(404, 'NOT_ENROLLED', '尚未选择课程版本');
  const cv = catalog.getCourseVersion(courseId, enr.version);
  if (!cv) throw httpError(500, 'COURSE_GONE', '已报读版本在目录中不存在');
  const node = catalog.getNode(cv, nodeKey);
  if (!node) throw httpError(404, 'NODE_NOT_FOUND', '节点不存在');
  return { enr, cv, node };
}

async function activeBranchOf(repo, courseId, nodeKey, branches) {
  const list = (branches || await repo.listBranches(branches ? branches[0].user_id : null, courseId, nodeKey))
    .filter((b) => b.node_key === nodeKey && b.status === 'active');
  return list[list.length - 1] || null;
}

async function ensureActiveBranch(repo, user, courseId, node, version) {
  const branches = await repo.listBranches(user.id, courseId, node.key);
  let active = branches.filter((b) => b.status === 'active').pop();
  if (active) return { active, branches };
  // 首次进入：从虚构种子事件建立主分支
  active = await repo.createBranch({
    user_id: user.id, course_id: courseId, version, node_key: node.key,
    name: '主练习', origin: 'native',
  });
  const seed = node.seed || [];
  const rows = [];
  for (let i = 0; i < seed.length; i++) {
    rows.push(await repo.appendEvent({
      branch_id: active.id, seq: i, kind: 'valid', type: seed[i].type,
      payload: seed[i].payload, annuls: [],
    }));
  }
  return { active: await repo.getBranch(active.id), branches: [...branches, active] };
}

async function summarizeNode(repo, user, cv, node, readings, branchIndex) {
  const ch = catalog.contentHash(node);
  if (node.kind === 'reading') {
    const r = readings.find((x) => x.node_key === node.key);
    const status = r && r.content_hash === ch ? 'READ_DONE' : 'NOT_STARTED';
    return { nodeKey: node.key, kind: node.kind, title: node.title, status, contentHash: ch,
      stale: Boolean(r && r.content_hash !== ch) };
  }
  const branches = branchIndex.get(node.key) || [];
  const active = branches.filter((b) => b.status === 'active').pop() || null;
  if (!active) return { nodeKey: node.key, kind: node.kind, title: node.title, status: 'NOT_STARTED', contentHash: ch, branches: [] };

  const [events, grades] = await Promise.all([repo.listEvents(active.id), repo.listGrades(active.id)]);
  const latest = grades[grades.length - 1] || null;
  const best = grades.reduce((m, g) => (g.score > (m ? m.score : -1) ? g : m), null);
  const shots = await repo.countValidScreenshots(active.id);
  const passedEver = grades.some((g) => g.passed);
  let status = 'NEEDS_REWORK';
  if (latest && latest.passed) status = 'PRACTICE_PASSED';
  else if (passedEver) status = 'NEEDS_REWORK'; // 曾经通过但最新状态不满足（撤回导致依据失效）
  return {
    nodeKey: node.key, kind: node.kind, title: node.title, status, contentHash: ch,
    activeBranchId: active.id, branchName: active.name, origin: active.origin,
    score: latest ? latest.score : null, passed: Boolean(latest && latest.passed),
    bestScore: best ? best.score : null,
    passedEver, screenshotCount: shots,
    ruleHash: ruleHash(node), branches: branches.map(branchSummary),
  };
}

function branchSummary(b) {
  return { id: b.id, name: b.name, status: b.status, origin: b.origin,
    parentBranchId: b.parent_branch_id, sourceBranchId: b.source_branch_id, forkSeq: b.fork_seq, createdAt: b.created_at };
}

function prerequisitesMet(cv, nodeKey, statusMap) {
  const edges = cv.edges.filter((e) => e.to === nodeKey);
  return edges.every((e) => ['READ_DONE', 'PRACTICE_PASSED'].includes(statusMap.get(e.from)));
}

async function getProgress(repo, user, courseId) {
  const enr = await repo.getEnrollment(user.id, courseId);
  if (!enr) return null;
  const cv = catalog.getCourseVersion(courseId, enr.version);
  const readings = await repo.listReadings(user.id, courseId);
  const allBranches = await repo.listBranches(user.id, courseId, null);
  const branchIndex = new Map();
  for (const b of allBranches) {
    if (!branchIndex.has(b.node_key)) branchIndex.set(b.node_key, []);
    branchIndex.get(b.node_key).push(b);
  }
  const summaries = [];
  const statusMap = new Map();
  for (const node of cv.nodes) {
    const s = await summarizeNode(repo, user, cv, node, readings, branchIndex);
    summaries.push(s); statusMap.set(node.nodeKey, s.status);
  }
  // 解锁状态（依赖当前状态；未满足前置的节点锁定）
  summaries.forEach((s) => {
    s.locked = s.status === 'NOT_STARTED' ? !prerequisitesMet(cv, s.nodeKey, statusMap) : false;
  });
  return {
    courseId, version: enr.version,
    latestVersion: Object.keys(catalog.versions[courseId].versions).sort().pop(),
    nodes: summaries,
  };
}

// ---- 练习：获取分支完整视图（不含答案；学生视图） ----
async function getExerciseView(repo, user, courseId, nodeKey) {
  const { cv, node } = await loadContext(repo, user.id, courseId, null, nodeKey);
  if (node.kind !== 'exercise') throw httpError(400, 'NOT_EXERCISE', '该节点不是练习');
  const { active } = await ensureActiveBranch(repo, user, courseId, node, cv.version);
  const [events, grades, shots] = await Promise.all([
    repo.listEvents(active.id), repo.listGrades(active.id), repo.listScreenshots(active.id),
  ]);
  const state = ledger.fold(events);
  const latest = grades[grades.length - 1] || null;
  return {
    node: catalog.toStudentNode(node),
    branch: { id: active.id, name: active.name, origin: active.origin, forkSeq: active.fork_seq },
    seedCount: node.seed.length,
    ledger: stateView(state),
    events: events.map(eventView),
    grading: latest ? { score: latest.score, passed: latest.passed, atSeq: latest.at_seq,
      screenshotOk: latest.detail.screenshotOk, items: latest.detail.items } : null,
    bestScore: grades.reduce((m, g) => Math.max(m, g.score), 0) || null,
    screenshots: shots.map((s) => ({ id: s.id, filename: s.filename, status: s.status, createdAt: s.created_at })),
  };
}

function stateView(state) {
  return {
    budgets: state.budgets,
    claims: state.claims,
    months: state.months,
    budgetRemaining: state.budgets.map((b) => ({
      dept: b.dept, month: b.month, remaining: state.budgetRemaining(b.dept, b.month),
    })),
  };
}

function eventView(e) {
  return { seq: e.seq, kind: e.kind, type: e.type, payload: e.payload,
    errorCode: e.error_code, errorMessage: e.error_message, deviceId: e.device_id, createdAt: e.created_at };
}

// ---- 应用一次操作（带分支锁；离线 opId 幂等；非法点击记审计但不产生转移） ----
async function applyOp(repo, user, courseId, nodeKey, op, meta = {}) {
  const { cv, node } = await loadContext(repo, user.id, courseId, null, nodeKey);
  if (node.kind !== 'exercise') throw httpError(400, 'NOT_EXERCISE', '该节点不是练习');
  const { active } = await ensureActiveBranch(repo, user, courseId, node, cv.version);
  const clientOpId = meta.clientOpId || null;
  const deviceId = meta.deviceId || null;

  return repo.withBranchLock(active.id, async (tx) => {
    // 幂等：离线补交/重试，相同 opId 直接回放已有结果
    if (clientOpId) {
      const dup = await tx.findEventByClientOpId(clientOpId);
      if (dup) {
        const events = await tx.listEvents();
        const grades = await tx.listGrades();
        return { idempotent: true, event: eventView(dup),
          grading: gradingView(grades[grades.length - 1]), ledger: stateView(ledger.fold(events)),
          conflict: false };
      }
    }
    const events = await tx.listEvents();
    const validEvents = events.filter((e) => e.kind !== 'invalid');
    let appended;
    try {
      ledger.validate(validEvents, op);
      const annuls = annulPlan(validEvents, { type: op.type, payload: op.payload });
      appended = await tx.appendEvent({
        branch_id: active.id, kind: 'valid', type: op.type, payload: op.payload || {},
        annuls, client_op_id: clientOpId, device_id: deviceId,
      });
    } catch (e) {
      if (e.status === 400 && e.code === 'UNKNOWN_OP') throw e;
      appended = await tx.appendEvent({
        branch_id: active.id, kind: 'invalid', type: op.type || 'UNKNOWN', payload: op.payload || {},
        annuls: [], error_code: e.code || 'INVALID', error_message: e.message,
        client_op_id: clientOpId, device_id: deviceId,
      });
      const allEvents = await tx.listEvents();
      const grades = await tx.listGrades();
      return { idempotent: false, event: eventView(appended),
        rejected: { code: e.code || 'INVALID', message: e.message },
        grading: gradingView(grades[grades.length - 1]),
        ledger: stateView(ledger.fold(allEvents)), conflict: false };
    }
    // 评分：依据当前全部有效状态转移
    const allEvents = await tx.listEvents();
    const shots = await tx.countValidScreenshots();
    const g = gradeExercise(node, allEvents, shots > 0);
    await tx.addGrade({ branch_id: active.id, at_seq: appended.seq, score: g.score,
      passed: g.passed, detail: g, rule_hash: ruleHash(node), origin: 'native' });
    const grades = await tx.listGrades();
    return { idempotent: false, event: eventView(appended),
      grading: gradingView(grades[grades.length - 1]),
      ledger: stateView(ledger.fold(allEvents)), conflict: false, annulled: appended.annuls || [] };
  });
}

function gradingView(g) {
  if (!g) return null;
  return { score: g.score, passed: g.passed, atSeq: g.at_seq,
    screenshotOk: g.detail.screenshotOk, items: g.detail.items };
}

// ---- 截图：操作已生效后截图失败不抹除练习状态；可重试补交 ----
async function uploadScreenshot(repo, user, courseId, nodeKey, { filename, mime, bytes }) {
  const { cv, node } = await loadContext(repo, user.id, courseId, null, nodeKey);
  if (node.kind !== 'exercise') throw httpError(400, 'NOT_EXERCISE', '该节点不是练习');
  const { active } = await ensureActiveBranch(repo, user, courseId, node, cv.version);
  try {
    const shot = await repo.addScreenshot({ branch_id: active.id, filename, mime, bytes });
    // 截图可能改变“是否通过”（v2 月结需要截图），重新基于当前事件评分并留痕
    const events = await repo.listEvents(active.id);
    const g = gradeExercise(node, events, true);
    await repo.addGrade({ branch_id: active.id, at_seq: events[events.length - 1] ? events[events.length - 1].seq : 0,
      score: g.score, passed: g.passed, detail: g, rule_hash: ruleHash(node), origin: 'native' });
    return { stored: true, shot: { id: shot.id, filename: shot.filename, status: shot.status },
      grading: gradingView((await repo.listGrades(active.id)).pop()) };
  } catch (e) {
    if (e.code === 'SHOT_STORE_FAILED') {
      // 练习状态保留；前端提示“截图失败，可重试”
      const grades = await repo.listGrades(active.id);
      throw httpError(503, 'SHOT_STORE_FAILED', '截图存储失败，练习进度不受影响，请重试上传', {
        retainedGrading: gradingView(grades[grades.length - 1]),
      });
    }
    throw e;
  }
}

// ---- 练习回滚：在指定 seq 处分叉新分支；旧分支归档，原成绩保留 ----
async function rollbackBranch(repo, user, courseId, nodeKey, { toSeq, name }) {
  const { cv, node } = await loadContext(repo, user.id, courseId, null, nodeKey);
  const { active } = await ensureActiveBranch(repo, user, courseId, node, cv.version);
  const events = await repo.listEvents(active.id);
  const seedCount = (node.seed || []).length;
  const maxSeq = events.length ? events[events.length - 1].seq : 0;
  const to = Number.isInteger(toSeq) ? toSeq : maxSeq - 1;
  if (to < seedCount - 1) throw httpError(400, 'BAD_SEQ', '不能回滚到种子事件之前');
  if (to >= maxSeq) throw httpError(400, 'BAD_SEQ', `回滚点必须早于当前末端 seq=${maxSeq}`);

  return repo.withBranchLock(active.id, async () => {
    const nb = await repo.createBranch({
      user_id: user.id, course_id: courseId, version: cv.version, node_key: node.key,
      name: name || `回滚分支@${to}`, parent_branch_id: active.id, fork_seq: to,
      origin: 'rollback', source_branch_id: active.id,
    });
    const copied = await repo.copyEventsIntoBranch(nb.id, events, to);
    await repo.setBranchStatus(active.id, 'archived');
    // 原成绩保留：以 inherited 快照把截至 fork 点的成绩带到新分支
    const oldGrades = await repo.listGrades(active.id);
    for (const g of oldGrades.filter((x) => x.at_seq <= to)) {
      await repo.addGrade({ branch_id: nb.id, at_seq: g.at_seq, score: g.score, passed: g.passed,
        detail: g.detail, rule_hash: g.rule_hash, origin: 'inherited' });
    }
    // 回滚后立即按新分支状态评分
    const freshEvents = await repo.listEvents(nb.id);
    const shots = 0;
    const res = gradeExercise(node, freshEvents, false);
    await repo.addGrade({ branch_id: nb.id, at_seq: copied[copied.length - 1].seq,
      score: res.score, passed: res.passed, detail: res, rule_hash: ruleHash(node), origin: 'native' });
    return { branchId: nb.id, forkedFrom: active.id, forkSeq: to,
      copiedEvents: copied.length,
      preservedBranch: { id: active.id, name: active.name, gradesKept: oldGrades.length },
      grading: res };
  });
}

// ---- 版本迁移：对比旧版已完成节点 vs 新版 ----
async function migrationPreview(repo, user, courseId, targetVersion) {
  const enr = await repo.getEnrollment(user.id, courseId);
  if (!enr) throw httpError(404, 'NOT_ENROLLED', '尚未选择课程版本');
  if (enr.version === targetVersion) throw httpError(400, 'SAME_VERSION', '当前已在该版本');
  const oldCv = catalog.getCourseVersion(courseId, enr.version);
  const newCv = catalog.getCourseVersion(courseId, targetVersion);
  if (!newCv) throw httpError(404, 'NO_SUCH_VERSION', '目标版本不存在');
  const progress = await getProgress(repo, user, courseId);
  const oldStatus = new Map(progress.nodes.map((n) => [n.nodeKey, n]));

  const nodes = newCv.nodes.map((nn) => {
    const on = oldStatus.get(nn.key);
    const oldNode = catalog.getNode(oldCv, nn.key);
    if (!on || on.status === 'NOT_STARTED') {
      return { nodeKey: nn.key, kind: nn.kind, title: nn.title, decision: 'fresh',
        reason: '旧版未开始', newContentHash: catalog.contentHash(nn) };
    }
    if (nn.kind === 'reading') {
      const same = oldNode && catalog.contentHash(oldNode) === catalog.contentHash(nn);
      return { nodeKey: nn.key, kind: nn.kind, title: nn.title,
        decision: same ? 'inherit' : 'redo_reading',
        reason: same ? '阅读内容一致，继承阅读完成' : '阅读内容已更新，需重新阅读',
        oldContentHash: oldNode ? catalog.contentHash(oldNode) : null,
        newContentHash: catalog.contentHash(nn) };
    }
    const sameRule = oldNode && ruleHash(oldNode) === ruleHash(nn);
    return { nodeKey: nn.key, kind: nn.kind, title: nn.title,
      decision: sameRule ? 'inherit' : 'incompatible',
      reason: sameRule ? '评分规则一致，可继承练习分支与原成绩' : '评分规则变更，旧评分不兼容，建议重开练习分支',
      oldScore: on.score, bestScore: on.bestScore, passed: on.passed,
      oldRuleHash: oldNode ? ruleHash(oldNode) : null, newRuleHash: ruleHash(nn),
      sourceBranchId: on.activeBranchId };
  });

  return { courseId, fromVersion: enr.version, toVersion: targetVersion,
    summary: {
      inherit: nodes.filter((n) => n.decision === 'inherit').length,
      redo_reading: nodes.filter((n) => n.decision === 'redo_reading').length,
      incompatible: nodes.filter((n) => n.decision === 'incompatible').length,
      fresh: nodes.filter((n) => n.decision === 'fresh').length,
    },
    nodes };
}

// 执行迁移：inherit -> 复制分支（原成绩保留为 inherited 快照）/阅读记录；incompatible -> 可选重开
async function migrate(repo, user, courseId, targetVersion, choices = {}) {
  const preview = await migrationPreview(repo, user, courseId, targetVersion);
  const oldCv = catalog.getCourseVersion(courseId, preview.fromVersion);
  const newCv = catalog.getCourseVersion(courseId, targetVersion);
  const results = [];

  for (const item of preview.nodes) {
    const nn = catalog.getNode(newCv, item.nodeKey);
    const choice = choices[item.nodeKey] || (item.decision === 'inherit' ? 'inherit' : 'new');
    if (item.decision === 'fresh') { results.push({ nodeKey: item.nodeKey, action: 'none' }); continue; }

    if (nn.kind === 'reading') {
      if (item.decision === 'inherit' && choice === 'inherit') {
        await repo.completeReading(user.id, courseId, targetVersion, nn.key, catalog.contentHash(nn));
        results.push({ nodeKey: item.nodeKey, action: 'inherited_reading' });
      } else {
        results.push({ nodeKey: item.nodeKey, action: 'reread_required' });
      }
      continue;
    }

    // exercise
    if (item.decision === 'inherit' && choice === 'inherit' && item.sourceBranchId) {
      const src = await repo.getBranch(item.sourceBranchId);
      const events = await repo.listEvents(item.sourceBranchId);
      const grades = await repo.listGrades(item.sourceBranchId);
      const nb = await repo.createBranch({
        user_id: user.id, course_id: courseId, version: targetVersion, node_key: nn.key,
        name: `${src.name}（自 ${preview.fromVersion} 继承）`, origin: 'migrated',
        source_branch_id: src.id, fork_seq: events.length ? events[events.length - 1].seq : 0,
      });
      const copied = await repo.copyEventsIntoBranch(nb.id, events, events.length ? events[events.length - 1].seq : 0);
      for (const g of grades) {
        await repo.addGrade({ branch_id: nb.id, at_seq: g.at_seq, score: g.score, passed: g.passed,
          detail: g.detail, rule_hash: g.rule_hash, origin: 'inherited' });
      }
      // 归档同节点旧版 active 分支（记录保留）
      const oldBranches = await repo.listBranches(user.id, courseId, nn.key);
      for (const b of oldBranches.filter((x) => x.status === 'active' && x.version !== targetVersion)) {
        await repo.setBranchStatus(b.id, 'archived');
      }
      results.push({ nodeKey: item.nodeKey, action: 'inherited_branch', branchId: nb.id,
        copiedEvents: copied.length, gradesKept: grades.length });
    } else if (choice === 'new' || item.decision === 'incompatible') {
      // 规则不兼容或选择重开：归档旧版分支（事件与原成绩原样保留），新版首次打开时另建主分支
      const oldBranches = await repo.listBranches(user.id, courseId, nn.key);
      let keptGrades = 0;
      for (const b of oldBranches.filter((x) => x.status === 'active')) {
        // eslint-disable-next-line no-await-in-loop
        keptGrades += (await repo.listGrades(b.id)).length;
        // eslint-disable-next-line no-await-in-loop
        await repo.setBranchStatus(b.id, 'archived');
      }
      results.push({ nodeKey: item.nodeKey, action: 'new_branch_on_open', gradesKept: keptGrades,
        note: '旧练习分支已归档，原成绩保留；首次打开新版练习时建立新分支' });
    } else {
      results.push({ nodeKey: item.nodeKey, action: 'pending_choice' });
    }
  }

  await repo.upsertEnrollment(user.id, courseId, targetVersion);
  return { migratedTo: targetVersion, results };
}

module.exports = {
  ruleHash, getProgress, getExerciseView, applyOp, uploadScreenshot,
  rollbackBranch, migrationPreview, migrate, summarizeNode,
  httpError, loadContext, ensureActiveBranch,
};
