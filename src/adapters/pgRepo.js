// PostgreSQL 仓储：与 memoryRepo 相同接口。
// 并发：pg_advisory_xact_lock(hashtext(branchId)) 将同分支操作串行化（两设备同时操作安全）
'use strict';

const crypto = require('crypto');

class PgRepo {
  constructor(pool) {
    this.pool = pool;
    this.forceScreenshotFail = false;
  }
  kind() { return 'postgres'; }

  async _one(sql, params = []) {
    const r = await this.pool.query(sql, params);
    return r.rows[0] || null;
  }
  async _all(sql, params = []) {
    const r = await this.pool.query(sql, params);
    return r.rows;
  }

  async findUserByUsername(username) {
    return this._one('SELECT id, username, role, display_name FROM users WHERE username=$1', [username]);
  }
  async findUserById(id) {
    return this._one('SELECT id, username, role, display_name FROM users WHERE id=$1', [id]);
  }
  async createUser({ username, role, display_name }) {
    return this._one(
      'INSERT INTO users(username, role, display_name) VALUES($1,$2,$3) RETURNING id, username, role, display_name',
      [username, role, display_name || username],
    );
  }
  async createSession(token, userId) {
    await this.pool.query('INSERT INTO sessions(token, user_id) VALUES($1,$2)', [token, userId]);
  }
  async findSession(token) {
    return this._one(
      `SELECT u.id, u.username, u.role, u.display_name
       FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1`,
      [token],
    );
  }
  async listUsers() {
    return this._all('SELECT id, username, role, display_name FROM users ORDER BY id');
  }

  async getEnrollment(userId, courseId) {
    return this._one('SELECT user_id, course_id, version FROM enrollments WHERE user_id=$1 AND course_id=$2', [userId, courseId]);
  }
  async upsertEnrollment(userId, courseId, version) {
    return this._one(
      `INSERT INTO enrollments(user_id, course_id, version) VALUES($1,$2,$3)
       ON CONFLICT (user_id, course_id) DO UPDATE SET version=EXCLUDED.version, updated_at=now()
       RETURNING user_id, course_id, version`,
      [userId, courseId, version],
    );
  }

  async completeReading(userId, courseId, version, nodeKey, contentHash) {
    return this._one(
      `INSERT INTO readings(user_id, course_id, version, node_key, content_hash)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, course_id, node_key) DO UPDATE
         SET content_hash=EXCLUDED.content_hash, version=EXCLUDED.version, completed_at=now()
       RETURNING id, node_key, content_hash, completed_at`,
      [userId, courseId, version, nodeKey, contentHash],
    );
  }
  async listReadings(userId, courseId) {
    return this._all('SELECT node_key, content_hash FROM readings WHERE user_id=$1 AND course_id=$2', [userId, courseId]);
  }

  async createBranch(b) {
    return this._one(
      `INSERT INTO branches(id, user_id, course_id, version, node_key, name, parent_branch_id, fork_seq, origin, source_branch_id, status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [b.id || crypto.randomUUID(), b.user_id, b.course_id, b.version, b.node_key, b.name || '主练习',
       b.parent_branch_id || null, b.fork_seq == null ? null : b.fork_seq, b.origin || 'native',
       b.source_branch_id || null, b.status || 'active'],
    );
  }
  async getBranch(id) {
    return this._one('SELECT * FROM branches WHERE id=$1', [id]);
  }
  async listBranches(userId, courseId, nodeKey) {
    return this._all(
      `SELECT * FROM branches WHERE user_id=$1 AND course_id=$2 ${nodeKey ? 'AND node_key=$3' : ''} ORDER BY created_at, id`,
      nodeKey ? [userId, courseId, nodeKey] : [userId, courseId],
    );
  }
  async setBranchStatus(id, status) {
    await this.pool.query('UPDATE branches SET status=$2 WHERE id=$1', [id, status]);
  }

  async copyEventsIntoBranch(branchId, sourceEvents, upToSeq) {
    const slice = sourceEvents.filter((e) => e.seq <= upToSeq);
    const idMap = new Map(slice.map((e) => [e.id, crypto.randomUUID()]));
    const rows = [];
    for (const [i, e] of slice.entries()) {
      const payload = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload;
      const annuls = (e.annuls || []).map((oldId) => idMap.get(oldId)).filter(Boolean);
      await this.pool.query(
        `INSERT INTO events(id, branch_id, seq, kind, type, payload, annuls, error_code, error_message)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [idMap.get(e.id), branchId, i, e.kind, e.type, JSON.stringify(payload), JSON.stringify(annuls),
         e.error_code || null, e.error_message || null],
      );
      rows.push({ id: idMap.get(e.id), seq: i, type: e.type, kind: e.kind, payload, annuls });
    }
    return rows;
  }

  // 在事务 + 行级咨询锁内执行；返回 fn(client) 结果
  async withBranchLock(branchId, fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [branchId]);
      const tx = {
        async query(...args) { return client.query(...args); },
        async nextSeq() {
          const r = await client.query('SELECT COALESCE(MAX(seq),-1)+1 AS n FROM events WHERE branch_id=$1', [branchId]);
          return Number(r.rows[0].n);
        },
        async findEventByClientOpId(clientOpId) {
          if (!clientOpId) return null;
          const r = await client.query('SELECT * FROM events WHERE branch_id=$1 AND client_op_id=$2', [branchId, clientOpId]);
          return r.rows[0] ? normalizeEvent(r.rows[0]) : null;
        },
        async appendEvent(ev) {
          let seq = ev.seq;
          if (seq == null) {
            const r = await client.query('SELECT COALESCE(MAX(seq),-1)+1 AS n FROM events WHERE branch_id=$1', [branchId]);
            seq = Number(r.rows[0].n);
          }
          const id = ev.id || crypto.randomUUID();
          await client.query(
            `INSERT INTO events(id, branch_id, seq, kind, type, payload, annuls, error_code, error_message, client_op_id, device_id)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [id, branchId, seq, ev.kind || 'valid', ev.type, JSON.stringify(ev.payload || {}),
             JSON.stringify(ev.annuls || []), ev.error_code || null, ev.error_message || null,
             ev.client_op_id || null, ev.device_id || null],
          );
          return normalizeEvent((await client.query('SELECT * FROM events WHERE id=$1', [id])).rows[0]);
        },
        async listEvents() {
          const r = await client.query('SELECT * FROM events WHERE branch_id=$1 ORDER BY seq', [branchId]);
          return r.rows.map(normalizeEvent);
        },
        async listGrades() {
          const r = await client.query('SELECT * FROM grades WHERE branch_id=$1 ORDER BY at_seq, id', [branchId]);
          return r.rows.map((g) => ({ ...g, detail: typeof g.detail === 'string' ? JSON.parse(g.detail) : g.detail }));
        },
        async addGrade(g) {
          const r = await client.query(
            `INSERT INTO grades(branch_id, at_seq, score, passed, detail, rule_hash, origin)
             VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [branchId, g.at_seq, g.score, g.passed, JSON.stringify(g.detail), g.rule_hash, g.origin || 'native'],
          );
          return r.rows[0];
        },
        async countValidScreenshots() {
          const r = await client.query(`SELECT count(*)::int AS n FROM screenshots WHERE branch_id=$1 AND status='stored'`, [branchId]);
          return Number(r.rows[0].n);
        },
      };
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }
  }

  async appendEvent(ev) {
    return this.withBranchLock(ev.branch_id, (tx) => tx.appendEvent(ev));
  }
  async findEventByClientOpId(branchId, clientOpId) {
    if (!clientOpId) return null;
    return this._one('SELECT * FROM events WHERE branch_id=$1 AND client_op_id=$2', [branchId, clientOpId]);
  }
  async listEvents(branchId) {
    const rows = await this._all('SELECT * FROM events WHERE branch_id=$1 ORDER BY seq', [branchId]);
    return rows.map(normalizeEvent);
  }

  async addGrade(g) {
    return this._one(
      `INSERT INTO grades(branch_id, at_seq, score, passed, detail, rule_hash, origin)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [g.branch_id, g.at_seq, g.score, g.passed, JSON.stringify(g.detail), g.rule_hash, g.origin || 'native'],
    );
  }
  async listGrades(branchId) {
    const rows = await this._all('SELECT * FROM grades WHERE branch_id=$1 ORDER BY at_seq, id', [branchId]);
    return rows.map((g) => ({ ...g, detail: typeof g.detail === 'string' ? JSON.parse(g.detail) : g.detail }));
  }

  async addScreenshot(s) {
    if (this.forceScreenshotFail) {
      const err = new Error('模拟截图存储失败（失败注入已开启）');
      err.status = 503; err.code = 'SHOT_STORE_FAILED'; throw err;
    }
    return this._one(
      `INSERT INTO screenshots(id, branch_id, event_id, filename, mime, bytes, status)
       VALUES($1,$2,$3,$4,$5,$6,'stored') RETURNING id, branch_id, filename, mime, status, created_at`,
      [s.id || crypto.randomUUID(), s.branch_id, s.event_id || null, s.filename, s.mime || 'image/png', s.bytes],
    );
  }
  async countValidScreenshots(branchId) {
    const r = await this._one(`SELECT count(*)::int AS n FROM screenshots WHERE branch_id=$1 AND status='stored'`, [branchId]);
    return r.n;
  }
  async listScreenshots(branchId) {
    return this._all('SELECT id, branch_id, event_id, filename, mime, status, created_at FROM screenshots WHERE branch_id=$1 ORDER BY created_at', [branchId]);
  }

  async close() { await this.pool.end(); }
}

function normalizeEvent(e) {
  return {
    ...e,
    payload: typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload,
    annuls: typeof e.annuls === 'string' ? JSON.parse(e.annuls) : (e.annuls || []),
  };
}

module.exports = { PgRepo, normalizeEvent };
