import { Database, Connection, QueryResult } from '@ladybugdb/core';
import path from 'node:path';
import fs from 'node:fs';

export const DB_DIR = '.specgraph';

const SCHEMA_STATEMENTS = [
  `CREATE NODE TABLE Spec (
    id STRING PRIMARY KEY,
    title STRING,
    type STRING,
    status STRING,
    priority STRING,
    author STRING,
    created DATE,
    description STRING
  )`,
  `CREATE NODE TABLE BusinessRule (
    id STRING PRIMARY KEY,
    title STRING,
    type STRING,
    status STRING,
    description STRING
  )`,
  `CREATE NODE TABLE CodeSymbol (
    id STRING PRIMARY KEY,
    fqn STRING,
    symbol_type STRING,
    file_path STRING,
    line_start INT64,
    line_end INT64
  )`,
  `CREATE REL TABLE DEPENDS_ON (FROM Spec TO Spec)`,
  `CREATE REL TABLE DERIVES_FROM (FROM Spec TO Spec)`,
  `CREATE REL TABLE DEFINES (FROM Spec TO BusinessRule)`,
  `CREATE REL TABLE GROUP CONSTRAINS (
    FROM BusinessRule TO Spec,
    FROM BusinessRule TO BusinessRule
  )`,
  `CREATE REL TABLE GROUP IMPLEMENTS (
    FROM CodeSymbol TO Spec,
    FROM CodeSymbol TO BusinessRule,
    confidence FLOAT DEFAULT 1.0,
    verified_at TIMESTAMP,
    verified_by STRING
  )`,
];

const DROP_ORDER = [
  'IMPLEMENTS',
  'CONSTRAINS',
  'DEFINES',
  'DERIVES_FROM',
  'DEPENDS_ON',
  'CodeSymbol',
  'BusinessRule',
  'Spec',
];

export async function openDatabase(
  projectDir: string,
  readOnly = false,
): Promise<{ db: Database; conn: Connection }> {
  const dbPath = path.join(projectDir, DB_DIR);
  const db = new Database(dbPath, undefined, undefined, readOnly);
  await db.init();
  const conn = new Connection(db);
  await conn.init();
  return { db, conn };
}

export async function closeDatabase(db: Database, conn: Connection): Promise<void> {
  await conn.close();
  await db.close();
}

async function runQuery(conn: Connection, stmt: string): Promise<QueryResult> {
  const result = await conn.query(stmt);
  if (Array.isArray(result)) return result[0] as QueryResult;
  return result as QueryResult;
}

async function tableExists(conn: Connection, name: string): Promise<boolean> {
  const result = await runQuery(conn, `CALL show_tables() RETURN *`);
  const rows = await result.getAll();
  result.close();
  return rows.some((row) => row['name'] === name);
}

export async function ensureSchema(conn: Connection): Promise<void> {
  const specExists = await tableExists(conn, 'Spec');
  if (specExists) return;

  for (const stmt of SCHEMA_STATEMENTS) {
    const result = await runQuery(conn, stmt);
    result.close();
  }
}

export async function dropAndRecreateSchema(conn: Connection): Promise<void> {
  for (const name of DROP_ORDER) {
    const exists = await tableExists(conn, name);
    if (exists) {
      const result = await runQuery(conn, `DROP TABLE ${name}`);
      result.close();
    }
  }
  for (const stmt of SCHEMA_STATEMENTS) {
    const result = await runQuery(conn, stmt);
    result.close();
  }
}

export async function queryAll(
  conn: Connection,
  cypher: string,
): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  const result = await runQuery(conn, cypher);
  const columns = await result.getColumnNames();
  const rows = await result.getAll();
  result.close();
  return { columns, rows };
}

export function getDbPath(projectDir: string): string {
  return path.join(projectDir, DB_DIR);
}

export function dbExists(projectDir: string): boolean {
  return fs.existsSync(path.join(projectDir, DB_DIR));
}
