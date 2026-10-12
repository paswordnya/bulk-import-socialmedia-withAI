import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Missing DATABASE_URL');
const pool = new Pool({ connectionString: url });
const dir = path.resolve('migrations');

await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
for (const f of (await readdir(dir)).filter((x) => x.endsWith('.sql')).sort()) {
  const done = await pool.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f]);
  if (done.rowCount) continue;
  await pool.query('BEGIN');
  try {
    await pool.query(await readFile(path.join(dir, f), 'utf8'));
    await pool.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
    await pool.query('COMMIT');
    console.log('applied', f);
  } catch (e) {
    await pool.query('ROLLBACK');
    throw e;
  }
}
await pool.end();
