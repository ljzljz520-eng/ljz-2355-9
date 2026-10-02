const app = require('./app');
const { initPool, applySchema, pool } = require('./db');
const { seed } = require('./seed');
const { startEmbedded } = require('./dev-pg');

const port = Number(process.env.PORT || 3000);

(async () => {
  let connString = process.env.DATABASE_URL;
  if (!connString) {
    connString = await startEmbedded(Number(process.env.PG_PORT || 55432));
    process.env.DATABASE_URL = connString;
    console.log('[dev] embedded PostgreSQL ready:', connString);
  }
  initPool({ connectionString: connString });
  await applySchema(pool);
  const seeded = await seed();
  console.log('[seed] teacher token:', seeded.teacher.token);
  console.log('[seed] student token:', seeded.student.token);
  app.listen(port, () => console.log(`培训中心运行中: http://127.0.0.1:${port}`));
})().catch(e => { console.error(e); process.exit(1); });
