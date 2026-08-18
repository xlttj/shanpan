import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, closeDatabase, ensureSchema, queryAll } from '../src/core/db.js';
import { analyzeAndIndex } from '../src/analyzer/indexer.js';
import type { ShanpanConfig } from '../src/types/config.js';
import type { Database, Connection } from '@ladybugdb/core';

// ─── analyzeAndIndex — File nodes, CONTAINS edges, file-level drift (SPEC-011) ─

describe('analyzeAndIndex', () => {
  let projectDir: string;
  let db: Database;
  let conn: Connection;

  function makeConfig(include: string[] = ['src']): ShanpanConfig {
    return {
      analyze: { include, exclude: ['node_modules'], languages: ['typescript'] },
    };
  }

  beforeEach(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shanpan-analyze-'));
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.shanpan'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'src', 'auth.ts'),
      ['export class UserService {', '  signIn(user: string): void {}', '}'].join('\n'),
    );
    ({ db, conn } = await openDatabase(projectDir));
    await ensureSchema(conn);
  });

  afterEach(async () => {
    await closeDatabase(db, conn);
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('creates File nodes for scanned source files', async () => {
    const stats = await analyzeAndIndex(conn, projectDir, makeConfig());
    expect(stats.fileNodesCreated).toBeGreaterThan(0);
    const { rows } = await queryAll(conn, `MATCH (f:File) RETURN f.id AS id`);
    const ids = rows.map((r) => String(r['id']));
    expect(ids).toContain('src/auth.ts');
  });

  it('creates File→CodeSymbol CONTAINS edges for top-level symbols', async () => {
    await analyzeAndIndex(conn, projectDir, makeConfig());
    const { rows } = await queryAll(
      conn,
      `MATCH (f:File)-[:CONTAINS]->(c:CodeSymbol) RETURN f.id AS fileId, c.fqn AS fqn`,
    );
    const fqns = rows.map((r) => String(r['fqn']));
    expect(fqns).toContain('UserService');
  });

  it('creates CodeSymbol→CodeSymbol CONTAINS edges for methods', async () => {
    await analyzeAndIndex(conn, projectDir, makeConfig());
    const { rows } = await queryAll(
      conn,
      `MATCH (p:CodeSymbol)-[:CONTAINS]->(m:CodeSymbol) RETURN p.fqn AS parent, m.fqn AS child`,
    );
    const children = rows.map((r) => String(r['child']));
    expect(children).toContain('UserService.signIn');
  });

  it('records containsEdgesCreated in stats', async () => {
    const stats = await analyzeAndIndex(conn, projectDir, makeConfig());
    expect(stats.containsEdgesCreated).toBeGreaterThanOrEqual(2);
  });

  // Regression: @overload (and TS overloads / declaration merging) produce
  // several symbols sharing one id. The id is a PRIMARY KEY, so without dedup
  // the insert aborts with a duplicate-key violation — as it did on the real
  // `rich` codebase (rich/containers.py::Lines.__getitem__).
  it('collapses duplicate symbol ids from @overload instead of crashing', async () => {
    fs.writeFileSync(
      path.join(projectDir, 'src', 'over.py'),
      [
        'from typing import overload',
        'class Box:',
        '    @overload',
        '    def get(self, i: int) -> int: ...',
        '    @overload',
        '    def get(self, i: str) -> str: ...',
        '    def get(self, i):',
        '        return i',
      ].join('\n'),
    );
    const config: ShanpanConfig = {
      analyze: { include: ['src'], exclude: ['node_modules'], languages: ['typescript', 'python'] },
    };
    const stats = await analyzeAndIndex(conn, projectDir, config);
    expect(stats.parseErrors).toBe(0);
    const { rows } = await queryAll(
      conn,
      `MATCH (c:CodeSymbol) WHERE c.fqn = 'Box.get' RETURN count(*) AS n`,
    );
    expect(Number(rows[0]?.['n'])).toBe(1);
  });

  // Inheritance: a $this->method() defined in a parent must resolve to the
  // parent (precise), not be dropped or suffix-guessed to some other class.
  it('resolves an inherited $this->method() call to the defining parent, with an EXTENDS edge', async () => {
    fs.writeFileSync(
      path.join(projectDir, 'src', 'cache.php'),
      [
        '<?php',
        'class Base { public function clear(): void {} }',
        'class Child extends Base {',
        '    public function reset(): void { $this->clear(); }',
        '}',
      ].join('\n'),
    );
    const config: ShanpanConfig = {
      analyze: { include: ['src'], exclude: ['node_modules'], languages: ['php'] },
    };
    await analyzeAndIndex(conn, projectDir, config);

    const calls = await queryAll(
      conn,
      `MATCH (a:CodeSymbol)-[:CALLS]->(b:CodeSymbol) WHERE b.fqn = 'Base.clear' RETURN a.fqn AS caller`,
    );
    expect(calls.rows.map((r) => String(r['caller']))).toContain('Child.reset');

    const ext = await queryAll(
      conn,
      `MATCH (c:CodeSymbol)-[:EXTENDS]->(p:CodeSymbol) RETURN c.fqn AS child, p.fqn AS parent`,
    );
    expect(ext.rows.some((r) => String(r['child']) === 'Child' && String(r['parent']) === 'Base')).toBe(true);
  });
});
