'use strict';
const { createApp } = require('../src/app');
const { MemoryRepo } = require('../src/adapters/memoryRepo');
const { PgRepo } = require('../src/adapters/pgRepo');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

async function makeRepo() {
  if (process.env.DATABASE_URL) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
    const schema = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'schema.sql'), 'utf8');
    await pool.query('DROP TABLE IF EXISTS screenshots, grades, events, branches, readings, enrollments, sessions, users CASCADE');
    await pool.query(schema);
    return { repo: new PgRepo(pool), kind: 'postgres', stop: () => pool.end() };
  }
  const repo = new MemoryRepo();
  return { repo, kind: 'memory', stop: async () => {} };
}

async function startServer(repo) {
  const app = createApp(repo);
  await new Promise((res) => (server = app.listen(0, res)));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return { base, stop: () => new Promise((res) => server.close(res)) };
}
let server;

async function login(base, username) {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username }),
  });
  return r.json();
}

function auth(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

async function postJson(url, token, body) {
  const res = await fetch(url, { method: 'POST', headers: auth(token), body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function getJson(url, token) {
  const res = await fetch(url, { headers: token ? auth(token) : {} });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// 完成所有阅读节点
async function completeAllReadings(base, token, courseId) {
  for (const key of ['doc-reimburse', 'doc-budget', 'doc-month']) {
    await postJson(`${base}/api/progress/${courseId}/read/${key}`, token, {});
  }
}

module.exports = { makeRepo, startServer, login, auth, postJson, getJson, completeAllReadings };
