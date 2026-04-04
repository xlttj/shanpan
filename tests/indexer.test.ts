import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, closeDatabase, ensureSchema, queryAll } from '../src/core/db.js';
import { indexSpecs, getGraphStats } from '../src/core/indexer.js';
import type { ParsedSpec } from '../src/types/spec.js';
import type { Database, Connection } from '@ladybugdb/core';

let tmpDir: string;
let db: Database;
let conn: Connection;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specgraph-db-test-'));
  ({ db, conn } = await openDatabase(tmpDir));
  await ensureSchema(conn);
});

afterEach(async () => {
  await closeDatabase(db, conn);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeSpec(overrides: Partial<ParsedSpec['frontmatter']> = {}): ParsedSpec {
  return {
    frontmatter: {
      id: 'SPEC-001',
      title: 'Test Spec',
      type: 'software_requirement',
      status: 'draft',
      ...overrides,
    },
    content: 'Test content',
    filePath: '/fake/SPEC-001.md',
  };
}

describe('indexSpecs', () => {
  it('inserts a single spec node', async () => {
    const specs = [makeSpec()];
    const stats = await indexSpecs(conn, specs);

    expect(stats.specs).toBe(1);
    expect(stats.rules).toBe(0);
    expect(stats.symbols).toBe(0);

    const { rows } = await queryAll(conn, `MATCH (s:Spec) RETURN s.id AS id, s.title AS title`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['id']).toBe('SPEC-001');
    expect(rows[0]?.['title']).toBe('Test Spec');
  });

  it('inserts business rule stubs from defines_rules', async () => {
    const specs = [makeSpec({ defines_rules: ['BR-001', 'BR-002'] })];
    const stats = await indexSpecs(conn, specs);

    expect(stats.rules).toBe(2);
    expect(stats.defines).toBe(2);

    const { rows } = await queryAll(conn, `MATCH (r:BusinessRule) RETURN r.id AS id`);
    expect(rows).toHaveLength(2);
  });

  it('inserts code symbol nodes from implements', async () => {
    const specs = [
      makeSpec({
        implements: [
          { symbol: 'src/foo.ts::bar', type: 'function' },
          { symbol: 'src/foo.ts::Baz', type: 'class' },
        ],
      }),
    ];
    const stats = await indexSpecs(conn, specs);

    expect(stats.symbols).toBe(2);
    expect(stats.implements).toBe(2);
  });

  it('inserts DEPENDS_ON edges between specs', async () => {
    const specs = [
      makeSpec({ id: 'SPEC-001' }),
      makeSpec({ id: 'SPEC-002', title: 'Dep', depends_on: ['SPEC-001'] }),
    ];
    const stats = await indexSpecs(conn, specs);

    expect(stats.dependsOn).toBe(1);
    const { rows } = await queryAll(
      conn,
      `MATCH (a:Spec)-[:DEPENDS_ON]->(b:Spec) RETURN a.id AS from, b.id AS to`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['from']).toBe('SPEC-002');
    expect(rows[0]?.['to']).toBe('SPEC-001');
  });

  it('clears previous data on re-index', async () => {
    const specs1 = [makeSpec({ id: 'SPEC-001' })];
    await indexSpecs(conn, specs1);

    const specs2 = [makeSpec({ id: 'SPEC-002', title: 'Other' })];
    await indexSpecs(conn, specs2);

    const { rows } = await queryAll(conn, `MATCH (s:Spec) RETURN s.id AS id`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['id']).toBe('SPEC-002');
  });
});

describe('getGraphStats', () => {
  it('returns zero counts for empty graph', async () => {
    const stats = await getGraphStats(conn);
    expect(stats.specs).toBe(0);
    expect(stats.rules).toBe(0);
    expect(stats.symbols).toBe(0);
  });

  it('returns correct counts after indexing', async () => {
    const specs = [
      makeSpec({ id: 'SPEC-001', defines_rules: ['BR-001'] }),
      makeSpec({
        id: 'SPEC-002',
        title: 'Two',
        depends_on: ['SPEC-001'],
        implements: [{ symbol: 'src/a.ts::fn', type: 'function' }],
      }),
    ];
    await indexSpecs(conn, specs);

    const stats = await getGraphStats(conn);
    expect(stats.specs).toBe(2);
    expect(stats.rules).toBe(1);
    expect(stats.symbols).toBe(1);
    expect(stats.edges['DEPENDS_ON']).toBe(1);
    expect(stats.edges['DEFINES']).toBe(1);
    expect(stats.edges['IMPLEMENTS']).toBe(1);
  });
});
