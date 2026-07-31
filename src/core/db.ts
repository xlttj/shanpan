import { Database, Connection, QueryResult } from '@ladybugdb/core';
import path from 'node:path';
import fs from 'node:fs';
import { SCHEMA_STATEMENTS, SCHEMA_TABLE_NAMES, DROP_ORDER } from './schema.js';

export const DB_DIR = '.specgraph';
export const DB_FILE = 'graph.db';

/** Escape a string for safe interpolation into a Cypher single-quoted literal. */
export function escId(id: string): string {
  return id.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export async function openDatabase(
  projectDir: string,
  readOnly = false,
): Promise<{ db: Database; conn: Connection }> {
  const dir = path.join(projectDir, DB_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, DB_FILE);
  // bufferManagerSize and maxDBSize limit the mmap reservation. The native
  // default reserves 8 TB of virtual address space, which exhausts the limit
  // in constrained environments. Override with SPECGRAPH_MAX_DB_MB env var.
  const maxMb = parseInt(process.env['SPECGRAPH_MAX_DB_MB'] ?? '256', 10);
  const MAX_DB = (isNaN(maxMb) || maxMb < 16 ? 256 : maxMb) * 1024 * 1024;
  const db = new Database(dbPath, MAX_DB, undefined, readOnly, MAX_DB);
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

/**
 * Create any schema table that does not exist yet. Creating per-table rather
 * than all-or-nothing means a database built by an earlier version picks up
 * newly added tables without a rebuild.
 */
export async function ensureSchema(conn: Connection): Promise<void> {
  for (let i = 0; i < SCHEMA_STATEMENTS.length; i++) {
    const name = SCHEMA_TABLE_NAMES[i];
    const stmt = SCHEMA_STATEMENTS[i];
    if (name === undefined || stmt === undefined) continue;
    if (await tableExists(conn, name)) continue;
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
  return path.join(projectDir, DB_DIR, DB_FILE);
}

export function dbExists(projectDir: string): boolean {
  return fs.existsSync(path.join(projectDir, DB_DIR, DB_FILE));
}
