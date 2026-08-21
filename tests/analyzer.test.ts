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

  it('resolves parent::method() to the ancestor even when the class overrides it', async () => {
    fs.writeFileSync(
      path.join(projectDir, 'src', 'over.php'),
      [
        '<?php',
        'class Base { public function set($v): void {} }',
        'class Child extends Base {',
        '    public function set($v): void { parent::set($v); }',
        '}',
      ].join('\n'),
    );
    const config: ShanpanConfig = {
      analyze: { include: ['src'], exclude: ['node_modules'], languages: ['php'] },
    };
    await analyzeAndIndex(conn, projectDir, config);

    const { rows } = await queryAll(
      conn,
      `MATCH (a:CodeSymbol)-[:CALLS]->(b:CodeSymbol) WHERE a.fqn = 'Child.set' RETURN b.fqn AS callee`,
    );
    const callees = rows.map((r) => String(r['callee']));
    expect(callees).toContain('Base.set');
    expect(callees).not.toContain('Child.set'); // must not self-loop to the override
  });

  it('resolves TypeScript typed-property, inherited, and super calls', async () => {
    fs.writeFileSync(
      path.join(projectDir, 'src', 'svc.ts'),
      [
        'class Client { send(): void {} }',
        'class Base { reset(): void {} }',
        'class Service extends Base {',
        '  private client: Client;',
        '  run(): void {',
        '    this.client.send();', // typed field → Client.send
        '    this.reset();', //       inherited → Base.reset
        '    super.reset();', //      parent-scoped → Base.reset
        '  }',
        '}',
      ].join('\n'),
    );
    const config: ShanpanConfig = {
      analyze: { include: ['src'], exclude: ['node_modules'], languages: ['typescript'] },
    };
    await analyzeAndIndex(conn, projectDir, config);

    const { rows } = await queryAll(
      conn,
      `MATCH (a:CodeSymbol {fqn: 'Service.run'})-[:CALLS]->(b:CodeSymbol) RETURN b.fqn AS callee`,
    );
    const callees = rows.map((r) => String(r['callee']));
    expect(callees).toContain('Client.send'); // typed property
    expect(callees).toContain('Base.reset'); // this.reset() + super.reset(), inherited

    const ext = await queryAll(
      conn,
      `MATCH (:CodeSymbol {fqn: 'Service'})-[:EXTENDS]->(p:CodeSymbol) RETURN p.fqn AS parent`,
    );
    expect(ext.rows.map((r) => String(r['parent']))).toContain('Base');
  });

  it('counts unresolved outgoing calls (typed but vendor/unlinkable) per method', async () => {
    fs.writeFileSync(
      path.join(projectDir, 'src', 'svc.php'),
      [
        '<?php',
        'class Service {',
        '    public function __construct(private VendorClient $client) {}',
        '    public function run(): void {',
        '        $this->client->send();', // VendorClient not in graph → unresolved
        '        $this->helper();', //        Service.helper → resolves
        '    }',
        '    public function helper(): void {}',
        '}',
      ].join('\n'),
    );
    const config: ShanpanConfig = {
      analyze: { include: ['src'], exclude: ['node_modules'], languages: ['php'] },
    };
    await analyzeAndIndex(conn, projectDir, config);

    const { rows } = await queryAll(
      conn,
      `MATCH (c:CodeSymbol) WHERE c.fqn = 'Service.run' RETURN c.unresolved_calls AS n`,
    );
    expect(Number(rows[0]?.['n'])).toBe(1);

    // A method with no unresolved calls stays at 0.
    const helper = await queryAll(
      conn,
      `MATCH (c:CodeSymbol) WHERE c.fqn = 'Service.helper' RETURN c.unresolved_calls AS n`,
    );
    expect(Number(helper.rows[0]?.['n'])).toBe(0);
  });
});

// ─── results formatting ──────────────────────────────────────────────────────
// The columns were hand-counted spaces and had drifted apart. Misalignment is
// invisible in the source — it only shows in the output — so it needs a test
// rather than a careful reader.

const ANSI = /\u001b\[[0-9;]*m/g;

describe('statLine', () => {
  it('puts every value at the same column regardless of label length', async () => {
    const { statLine } = await import('../src/cli/commands/analyze.js');
    const rows: [string, string | number][] = [
      ['Files scanned', 42],
      ['Symbols found', 333],
      ['Call edges', 11],
      ['Records', '84 live'],
    ];
    // The value sits at the end, so its start column is what is left once its
    // own width is taken off. Strip colour first: escape codes add length, not
    // width. Measuring with /\S+$/ instead would find the last *word* — and
    // read "84 live" as starting at "live".
    const columns = rows.map(([label, value]) => {
      const plain = statLine(label, value).replace(ANSI, '');
      return plain.length - String(value).length;
    });
    expect(new Set(columns).size).toBe(1);
  });

  it('keeps the two-space indent and appends the value unchanged', async () => {
    const { statLine } = await import('../src/cli/commands/analyze.js');
    const plain = statLine('Records', '84 live').replace(ANSI, '');
    expect(plain.startsWith('  Records')).toBe(true);
    expect(plain.endsWith('84 live')).toBe(true);
  });
});
