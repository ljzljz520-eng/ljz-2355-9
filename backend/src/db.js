// pg Pool（懒初始化）。生产用 DATABASE_URL；测试可注入 embedded-postgres 的真实 PG。
const { Pool } = require('pg');

let pool = null;

function initPool({ connectionString, max = 10 } = {}) {
  pool = new Pool({
    connectionString: connectionString || process.env.DATABASE_URL ||
      'postgres://node:node@127.0.0.1:55432/training',
    max,
  });
  return pool;
}

async function query(text, params) {
  if (!pool) initPool();
  return pool.query(text, params);
}

async function withTx(fn) {
  if (!pool) initPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function applySchema(clientOrPool) {
  const fs = require('fs');
  const path = require('path');
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await (clientOrPool || pool).query(sql);
}

async function closePool() {
  if (pool) { await pool.end().catch(() => {}); pool = null; }
}

module.exports = { initPool, get pool() { return pool; }, query, withTx, applySchema, closePool };
