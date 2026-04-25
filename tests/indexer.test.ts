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

function makeSpec(id: string = 'spec-001', overrides: Partial<ParsedSpec['frontmatter']> = {}): ParsedSpec {
  return {
    id,
    frontmatter: {
      title: 'Test Spec',
      type: 'software_requirement',
      status: 'draft',
      ...overrides,
    },
    content: 'Test content',
    filePath: `/fake/${id}.md`,
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
    expect(rows[0]?.['id']).toBe('spec-001');
    expect(rows[0]?.['title']).toBe('Test Spec');
  });

  it('inserts business rule stubs from defines_rules', async () => {
    const specs = [makeSpec('spec-001', { defines_rules: ['BR-001', 'BR-002'] })];
    const stats = await indexSpecs(conn, specs);

    expect(stats.rules).toBe(2);
    expect(stats.defines).toBe(2);

    const { rows } = await queryAll(conn, `MATCH (r:BusinessRule) RETURN r.id AS id`);
    expect(rows).toHaveLength(2);
  });

  it('inserts code symbol nodes from implements', async () => {
    const specs = [
      makeSpec('spec-001', {
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

  it('inserts DEFINES edges between specs and business rules', async () => {
    const specs = [makeSpec('spec-001', { defines_rules: ['BR-001'] })];
    const stats = await indexSpecs(conn, specs);

    expect(stats.defines).toBe(1);
    const { rows } = await queryAll(
      conn,
      `MATCH (a:Spec)-[:DEFINES]->(b:BusinessRule) RETURN a.id AS from, b.id AS to`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['from']).toBe('spec-001');
    expect(rows[0]?.['to']).toBe('BR-001');
  });

  it('clears previous data on re-index', async () => {
    const specs1 = [makeSpec('spec-001')];
    await indexSpecs(conn, specs1);

    const specs2 = [makeSpec('spec-002', { title: 'Other' })];
    await indexSpecs(conn, specs2);

    const { rows } = await queryAll(conn, `MATCH (s:Spec) RETURN s.id AS id`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['id']).toBe('spec-002');
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
      makeSpec('spec-001', { defines_rules: ['BR-001'] }),
      makeSpec('spec-002', {
        title: 'Two',
        implements: [{ symbol: 'src/a.ts::fn', type: 'function' }],
      }),
    ];
    await indexSpecs(conn, specs);

    const stats = await getGraphStats(conn);
    expect(stats.specs).toBe(2);
    expect(stats.rules).toBe(1);
    expect(stats.symbols).toBe(1);
    expect(stats.edges['DEFINES']).toBe(1);
    expect(stats.edges['IMPLEMENTS']).toBe(1);
  });
});
