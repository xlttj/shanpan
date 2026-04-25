import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, closeDatabase, ensureSchema, queryAll } from '../src/core/db.js';
import { indexSpecs } from '../src/core/indexer.js';
import { analyzeAndIndex } from '../src/analyzer/indexer.js';
import type { ParsedSpec } from '../src/types/spec.js';
import type { SpecGraphConfig } from '../src/types/config.js';
import type { Database, Connection } from '@ladybugdb/core';

// ─── analyzeAndIndex — File nodes, CONTAINS edges, file-level drift (SPEC-011) ─

describe('analyzeAndIndex', () => {
  let projectDir: string;
  let db: Database;
  let conn: Connection;

  function makeConfig(include: string[] = ['src']): SpecGraphConfig {
    return {
      specsDir: 'specs',
      analyze: { include, exclude: ['node_modules'], languages: ['typescript'] },
    };
  }

  beforeEach(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specgraph-analyze-'));
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.specgraph'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'src', 'auth.ts'),
      ['export class UserService {', '  signIn(user: string): void {}', '}'].join('\n'),
    );
    ({ db, conn } = await openDatabase(projectDir));
    await ensureSchema(conn);
    await indexSpecs(conn, []);
  });

  afterEach(async () => {
    await closeDatabase(db, conn);
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('creates File nodes for scanned source files', async () => {
    const stats = await analyzeAndIndex(conn, projectDir, [], makeConfig());
    expect(stats.fileNodesCreated).toBeGreaterThan(0);
    const { rows } = await queryAll(conn, `MATCH (f:File) RETURN f.id AS id`);
    const ids = rows.map((r) => String(r['id']));
    expect(ids).toContain('src/auth.ts');
  });

  it('creates File→CodeSymbol CONTAINS edges for top-level symbols', async () => {
    await analyzeAndIndex(conn, projectDir, [], makeConfig());
    const { rows } = await queryAll(
      conn,
      `MATCH (f:File)-[:CONTAINS]->(c:CodeSymbol) RETURN f.id AS fileId, c.fqn AS fqn`,
    );
    const fqns = rows.map((r) => String(r['fqn']));
    expect(fqns).toContain('UserService');
  });

  it('creates CodeSymbol→CodeSymbol CONTAINS edges for methods', async () => {
    await analyzeAndIndex(conn, projectDir, [], makeConfig());
    const { rows } = await queryAll(
      conn,
      `MATCH (p:CodeSymbol)-[:CONTAINS]->(m:CodeSymbol) RETURN p.fqn AS parent, m.fqn AS child`,
    );
    const children = rows.map((r) => String(r['child']));
    expect(children).toContain('UserService.signIn');
  });

  it('records containsEdgesCreated in stats', async () => {
    const stats = await analyzeAndIndex(conn, projectDir, [], makeConfig());
    expect(stats.containsEdgesCreated).toBeGreaterThanOrEqual(2);
  });

  it('creates File node and IMPLEMENTS edge for file-type spec entry', async () => {
    fs.writeFileSync(path.join(projectDir, 'package.json'), '{}');
    const r = await conn.query(
      `CREATE (:Spec { id: 'SPEC-PKG', title: 'Package Spec', type: 'software_requirement', status: 'active', description: NULL })`,
    );
    if (!Array.isArray(r)) r.close();
    const spec: ParsedSpec = {
      id: 'SPEC-PKG',
      frontmatter: {
        title: 'Package Spec',
        type: 'software_requirement',
        status: 'active',
        implements: [{ symbol: 'package.json', type: 'file' }],
      },
      content: '',
      filePath: path.join(projectDir, 'specs', 'spec-pkg.md'),
    };
    const stats = await analyzeAndIndex(conn, projectDir, [spec], makeConfig());
    expect(stats.implementationsLinked).toBeGreaterThan(0);
    const { rows } = await queryAll(
      conn,
      `MATCH (f:File {id: 'package.json'})-[:IMPLEMENTS]->(s:Spec) RETURN s.id AS specId`,
    );
    expect(rows.map((r) => String(r['specId']))).toContain('SPEC-PKG');
  });

  it('records drift when file-type spec entry points to missing file', async () => {
    const r = await conn.query(
      `CREATE (:Spec { id: 'SPEC-MISSING', title: 'Missing File Spec', type: 'software_requirement', status: 'active', description: NULL })`,
    );
    if (!Array.isArray(r)) r.close();
    const spec: ParsedSpec = {
      id: 'SPEC-MISSING',
      frontmatter: {
        title: 'Missing File Spec',
        type: 'software_requirement',
        status: 'active',
        implements: [{ symbol: 'nonexistent.json', type: 'file' }],
      },
      content: '',
      filePath: path.join(projectDir, 'specs', 'spec-missing.md'),
    };
    const stats = await analyzeAndIndex(conn, projectDir, [spec], makeConfig());
    expect(stats.driftWarnings.some((w) => w.includes('nonexistent.json'))).toBe(true);
    expect(stats.unresolvedSymbols).toBeGreaterThan(0);
  });
});
