// 内存仓储：与 pgRepo 相同接口，用于测试与离线开发；进程退出数据不保留。
'use strict';

const crypto = require('crypto');

function uuid() { return crypto.randomUUID(); }

class MemoryRepo {
  constructor() {
    this.users = [];
    this.sessions = new Map();
    this.enrollments = new Map(); // user|course
    this.readings = [];
    this.branches = [];
    this.events = [];
    this.grades = [];
    this.screenshots = [];
    this.locks = new Set();
    this.forceScreenshotFail = false;
  }
  kind() { return 'memory'; }

  // ---- users / sessions ----
  findUserByUsername(username) {
    return Promise.resolve(this.users.find((u) => u.username === username) || null);
  }
  findUserById(id) {
    return Promise.resolve(this.users.find((u) => u.id === id) || null);
  }
  createUser({ username, role, display_name }) {
    const u = { id: this.users.length + 1, username, role, display_name: display_name || username };
    this.users.push(u);
    return Promise.resolve(u);
  }
  createSession(token, userId) {
    this.sessions.set(token, userId);
    return Promise.resolve();
  }
  findSession(token) {
    const userId = this.sessions.get(token);
    return Promise.resolve(userId ? this.users.find((u) => u.id === userId) || null : null);
  }
  listUsers() {
    return Promise.resolve(this.users.map((u) => ({ id: u.id, username: u.username, role: u.role, display_name: u.display_name })));
  }

  // ---- enrollment ----
  getEnrollment(userId, courseId) {
    return Promise.resolve(this.enrollments.get(`${userId}|${courseId}`) || null);
  }
  upsertEnrollment(userId, courseId, version) {
    const key = `${userId}|${courseId}`;
    const cur = this.enrollments.get(key);
    const row = { user_id: userId, course_id: courseId, version,
      created_at: cur ? cur.created_at : new Date(), updated_at: new Date() };
    this.enrollments.set(key, row);
    return Promise.resolve(row);
  }

  // ---- readings ----
  completeReading(userId, courseId, version, nodeKey, contentHash) {
    const existing = this.readings.find(
      (r) => r.user_id === userId && r.course_id === courseId && r.node_key === nodeKey,
    );
    if (existing) { existing.content_hash = contentHash; existing.version = version; existing.completed_at = new Date(); return Promise.resolve(existing); }
    const row = { id: this.readings.length + 1, user_id: userId, course_id: courseId, version, node_key: nodeKey, content_hash: contentHash, completed_at: new Date() };
    this.readings.push(row);
    return Promise.resolve(row);
  }
  listReadings(userId, courseId) {
    return Promise.resolve(this.readings.filter((r) => r.user_id === userId && r.course_id === courseId));
  }

  // ---- branches ----
  createBranch(b) {
    const row = {
      id: b.id || uuid(), user_id: b.user_id, course_id: b.course_id, version: b.version,
      node_key: b.node_key, name: b.name || '主练习', parent_branch_id: b.parent_branch_id || null,
      fork_seq: b.fork_seq == null ? null : b.fork_seq, origin: b.origin || 'native',
      source_branch_id: b.source_branch_id || null, status: b.status || 'active', created_at: new Date(),
    };
    this.branches.push(row);
    return Promise.resolve(row);
  }
  getBranch(id) {
    return Promise.resolve(this.branches.find((x) => x.id === id) || null);
  }
  listBranches(userId, courseId, nodeKey) {
    return Promise.resolve(this.branches
      .filter((x) => x.user_id === userId && x.course_id === courseId && (!nodeKey || x.node_key === nodeKey))
      .sort((a, b) => a.created_at - b.created_at));
  }
  setBranchStatus(id, status) {
    const b = this.branches.find((x) => x.id === id);
    if (b) b.status = status;
    return Promise.resolve();
  }

  // ---- events ----
  copyEventsIntoBranch(branchId, sourceEvents, upToSeq) {
    const slice = sourceEvents.filter((e) => e.seq <= upToSeq);
    const idMap = new Map(slice.map((e) => [e.id, uuid()]));
    const rows = slice.map((e, i) => ({
      id: idMap.get(e.id), branch_id: branchId, seq: i,
      kind: e.kind, type: e.type, payload: JSON.parse(JSON.stringify(e.payload)),
      annuls: (e.annuls || []).map((oldId) => idMap.get(oldId)).filter(Boolean),
      error_code: e.error_code || null, error_message: e.error_message || null,
      client_op_id: null, device_id: null, created_at: new Date(),
    }));
    this.events.push(...rows);
    return Promise.resolve(rows);
  }
  _nextSeq(branchId) {
    const seqs = this.events.filter((e) => e.branch_id === branchId).map((e) => e.seq);
    return seqs.length ? Math.max(...seqs) + 1 : 0;
  }
  appendEvent(ev) {
    const row = {
      id: ev.id || uuid(), branch_id: ev.branch_id, seq: ev.seq == null ? this._nextSeq(ev.branch_id) : ev.seq,
      kind: ev.kind || 'valid', type: ev.type, payload: ev.payload || {},
      annuls: ev.annuls || [], error_code: ev.error_code || null, error_message: ev.error_message || null,
      client_op_id: ev.client_op_id || null, device_id: ev.device_id || null, created_at: new Date(),
    };
    this.events.push(row);
    return Promise.resolve(row);
  }
  findEventByClientOpId(branchId, clientOpId) {
    if (!clientOpId) return Promise.resolve(null);
    return Promise.resolve(this.events.find((e) => e.branch_id === branchId && e.client_op_id === clientOpId) || null);
  }
  listEvents(branchId) {
    return Promise.resolve(this.events.filter((e) => e.branch_id === branchId).sort((a, b) => a.seq - b.seq));
  }

  // ---- grades ----
  addGrade(g) {
    const row = { id: this.grades.length + 1, branch_id: g.branch_id, at_seq: g.at_seq,
      score: g.score, passed: g.passed, detail: g.detail, rule_hash: g.rule_hash,
      origin: g.origin || 'native', created_at: new Date() };
    this.grades.push(row);
    return Promise.resolve(row);
  }
  listGrades(branchId) {
    return Promise.resolve(this.grades.filter((g) => g.branch_id === branchId).sort((a, b) => a.at_seq - a.at_seq || a.id - b.id));
  }

  // ---- screenshots ----
  addScreenshot(s) {
    if (this.forceScreenshotFail) return Promise.reject(Object.assign(new Error('模拟截图存储失败'), { status: 503, code: 'SHOT_STORE_FAILED' }));
    const row = { id: s.id || uuid(), branch_id: s.branch_id, event_id: s.event_id || null,
      filename: s.filename, mime: s.mime || 'image/png', bytes: s.bytes, status: 'stored', created_at: new Date() };
    this.screenshots.push(row);
    return Promise.resolve(row);
  }
  countValidScreenshots(branchId, afterEventId) {
    return Promise.resolve(this.screenshots.filter((s) => s.branch_id === branchId && s.status === 'stored').length);
  }
  listScreenshots(branchId) {
    return Promise.resolve(this.screenshots.filter((s) => s.branch_id === branchId).sort((a, b) => a.created_at - b.created_at));
  }

  // ---- 串行化：同一 branch 的并发操作按到达顺序排队（模拟 PG 行锁） ----
  async withBranchLock(branchId, fn) {
    const key = `branch:${branchId}`;
    while (this.locks.has(key)) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((res) => { const t = setInterval(() => { if (!this.locks.has(key)) { clearInterval(t); res(); } }, 5); t.unref && t.unref(); });
    }
    this.locks.add(key);
    const tx = {
      query: async () => { throw new Error('memory tx has no query'); },
      nextSeq: async () => this._nextSeq(branchId),
      findEventByClientOpId: (id) => this.findEventByClientOpId(branchId, id),
      appendEvent: (ev) => this.appendEvent({ ...ev, branch_id: branchId }),
      listEvents: () => this.listEvents(branchId),
      listGrades: () => this.listGrades(branchId),
      addGrade: (g) => this.addGrade({ ...g, branch_id: branchId }),
      countValidScreenshots: () => this.countValidScreenshots(branchId),
    };
    try {
      return await fn(tx);
    } finally {
      this.locks.delete(key);
    }
  }
  close() { return Promise.resolve(); }
}

function setTimeoutWait(t, rej) {
  setTimeout(() => { clearInterval(t); rej(new Error('lock timeout')); }, 10000).unref();
}

module.exports = { MemoryRepo };
