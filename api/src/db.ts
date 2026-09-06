import pg from 'pg';

const { Pool, types } = pg;

// int8 (count(*), sum(int)) arrives as a string by default — parse to number; our counts fit easily.
types.setTypeParser(20, (v) => parseInt(v, 10));
// numeric → float (only used for averages)
types.setTypeParser(1700, (v) => parseFloat(v));

export type Db = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(databaseUrl: string): Db {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'canvass-api',
  });
}

/** Typed single-statement helper. */
export async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(
  db: Queryable,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await db.query<T>(text, params);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  db: Queryable,
  text: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const rows = await q<T>(db, text, params);
  return rows[0];
}

/** Run fn inside a transaction on a dedicated client. */
export async function withTx<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
