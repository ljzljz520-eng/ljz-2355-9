// 启动入口：DATABASE_URL 存在时使用 PostgreSQL，否则回退内存仓储（数据仅进程内）。
'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { createApp } = require('./app');
const { MemoryRepo } = require('./adapters/memoryRepo');
const { PgRepo } = require('./adapters/pgRepo');

async function main() {
  const port = Number(process.env.PORT || 3000);
  let repo;
  const databaseUrl = process.env.DATABASE_URL || '';
  if (databaseUrl) {
    const pool = new Pool({ connectionString: databaseUrl, max: 10 });
    const schema = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'schema.sql'), 'utf8');
    await pool.query(schema);
    repo = new PgRepo(pool);
    console.log('[storage] PostgreSQL adapter ready');
  } else {
    repo = new MemoryRepo();
    console.warn('[storage] DATABASE_URL 未设置，使用内存仓储（重启数据丢失）');
  }

  // 内置演示用户
  for (const [username, role, dn] of [
    ['alice', 'student', '学生 Alice'],
    ['bob', 'student', '学生 Bob'],
    ['teacher1', 'teacher', '王老师'],
  ]) {
    if (!(await repo.findUserByUsername(username))) {
      await repo.createUser({ username, role, display_name: dn });
    }
  }

  const app = createApp(repo);
  const server = app.listen(port, () => console.log(`[http] finance training center on http://localhost:${port}`));

  const shutdown = async () => { server.close(async () => { await repo.close(); process.exit(0); }); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
