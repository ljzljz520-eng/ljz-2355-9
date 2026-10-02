// 每个测试用例启动独立的真实 PostgreSQL（embedded-postgres）+ 独立模块注册表的 express
const path = require('path');
const fs = require('fs');
const Module = require('module');

const BACKEND = path.join(__dirname, '..', 'backend');
const _ep = require('embedded-postgres');
const EmbeddedPostgres = _ep.default || _ep;

async function setupHarness() {
  const port = 55600 + Math.floor(Math.random() * 300);
  const dataDir = fs.mkdtempSync('/tmp/ft-pg-');
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'node', password: 'node',
    port, persistent: false, onLog: () => {},
  });

  // initdb/postgres 默认继承父进程 stdio，这里统一导向 /dev/null 避免污染 TAP
  const cp = require('child_process');
  const origSpawn = cp.spawn;
  cp.spawn = function (cmd, args, opts = {}) {
    return origSpawn.call(this, cmd, args,
      { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  };
  await pg.initialise();
  await pg.start();
  cp.spawn = origSpawn;

  const { Client } = require('pg');
  const admin = new Client({ host: '127.0.0.1', port, user: 'node', password: 'node', database: 'postgres' });
  await admin.connect();
  await admin.query('CREATE DATABASE training');
  await admin.end();

  // 独立模块注册表：保证多个用例不复用旧 pool/app（模拟全新进程）
  const freshRequire = Module.createRequire(path.join(BACKEND, 'package.json'));
  const db = freshRequire(path.join(BACKEND, 'src', 'db.js'));
  const connString = `postgres://node:node@127.0.0.1:${port}/training`;
  db.initPool({ connectionString: connString });
  await db.applySchema(db.pool);
  const { seed } = freshRequire(path.join(BACKEND, 'src', 'seed.js'));
  const users = await seed();

  const app = freshRequire(path.join(BACKEND, 'src', 'app.js'));
  const server = await new Promise(resolve => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function req(method, url, { token, body } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data; try { data = await res.json(); } catch { data = {}; }
    return { status: res.status, data };
  }

  const cleanup = async () => {
    await server.close();
    await db.closePool();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };

  return { req, users, db, base, cleanup };
}

// 学生完成 v1 全部练习的辅助
async function completeV1(req, token, enrollmentId, { withEvidence = true } = {}) {
  const events = [];
  const act = async (doc_uid, action, extra = {}) => {
    const r = await req('POST', `/api/enrollments/${enrollmentId}/actions`, { token, body: {
      doc_uid, action, client_op_id: 'op-' + Math.random().toString(36).slice(2),
      client_ts: new Date().toISOString(), device_id: 'devA', ...extra,
    } });
    if (r.status === 200) events.push(r.data.transition);
    return r;
  };
  await act('budget-1', 'submit');
  await act('budget-1', 'approve');
  await act('reimb-1', 'submit');
  await act('reimb-1', 'approve');
  await act('reimb-1', 'pay');
  await act('month-end-1', 'close');
  if (withEvidence) {
    await req('POST', `/api/enrollments/${enrollmentId}/evidence`,
      { token, body: { node_code: 'prac_month_end', content_type: 'image/png', byte_size: 1234 } });
  }
  return events;
}

async function readAll(req, token, enrollmentId, cvId) {
  const mat = (await req('GET', `/api/courses/${cvId}/material`, { token })).data;
  for (const n of mat.nodes.filter(n => n.is_reading)) {
    await req('POST', `/api/enrollments/${enrollmentId}/read`, { token, body: { node_code: n.node_code } });
  }
}

function statusMap(stateRes) {
  return Object.fromEntries(stateRes.data.progress.map(p => [p.node_code, p]));
}

module.exports = { setupHarness, completeV1, readAll, statusMap };
