import { Database, Connection, QueryResult } from '@ladybugdb/core';
import path from 'node:path';
import fs from 'node:fs';
import { SCHEMA_STATEMENTS, DROP_ORDER } from './schema.js';

export const DB_DIR = '.specgraph';

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
