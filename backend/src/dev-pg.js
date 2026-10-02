// 开发环境：无 root 也能运行真实 PostgreSQL（embedded-postgres 下载官方二进制）
// 生产环境请直接用外部 PG（见 docker-compose.yml），不走本文件。
const EmbeddedPostgres = require('embedded-postgres').default || require('embedded-postgres');

let pg;
async function startEmbedded(port = 55432, dbName = 'training') {
  pg = new EmbeddedPostgres({
    databaseDir: process.env.PG_DATA_DIR || `${__dirname}/../../.pgdata`,
    user: 'node', password: 'node', port, persistent: true,
    initdbFlags: [], postgresFlags: [],
  });
  await pg.initialise();
  await pg.start();
  // 建库（幂等）
  const { Client } = require('pg');
  const admin = new Client({ host: '127.0.0.1', port, user: 'node', password: 'node', database: 'postgres' });
  await admin.connect();
  const ex = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [dbName]);
  if (ex.rowCount === 0) await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  return `postgres://node:node@127.0.0.1:${port}/${dbName}`;
}
async function stopEmbedded() { if (pg) await pg.stop(); }

module.exports = { startEmbedded, stopEmbedded };
