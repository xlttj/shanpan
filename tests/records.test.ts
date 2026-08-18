import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  formatTs,
  tsToSql,
  nextId,
  validateRecord,
  serializeRecord,
  parseRecords,
  readRecords,
  appendRecords,
  liveIds,
  knowledgePath,
  provenancePointers,
  missingProvenanceRefs,
} from '../src/core/records.js';
import { indexRecords, provenanceKind } from '../src/core/record-indexer.js';
import { openDatabase, closeDatabase, queryAll, dropAndRecreateSchema, migrateLegacyLayout } from '../src/core/db.js';
import type { KnowledgeRecord } from '../src/types/record.js';
import type { Database, Connection } from '@ladybugdb/core';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shanpan-records-'));
  fs.mkdirSync(path.join(tmpDir, '.shanpan'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function rec(over: Partial<KnowledgeRecord> = {}): KnowledgeRecord {
  return {
    id: 'a1b2c3',
    kn: 'decision',
    cl: 'use composite key',
    pv: 'u',
    ts: '20260617143022',
    ...over,
  } as KnowledgeRecord;
}

// ─── timestamps ──────────────────────────────────────────────────────────────

describe('timestamps', () => {
  it('formats a Date as YYYYMMDDHHIISS in UTC', () => {
    expect(formatTs(new Date('2026-06-17T14:30:22Z'))).toBe('20260617143022');
  });

  it('pads single-digit components', () => {
    expect(formatTs(new Date('2026-01-02T03:04:05Z'))).toBe('20260102030405');
  });

  it('round-trips through tsToSql', () => {
    expect(tsToSql('20260617143022')).toBe('2026-06-17 14:30:22');
  });

  it('rejects a non-existent calendar date', () => {
    expect(tsToSql('20260231120000')).toBeNull();
  });

  it('rejects an out-of-range hour', () => {
    expect(tsToSql('20260617250000')).toBeNull();
  });

  it('rejects wrong length', () => {
    expect(tsToSql('202606171430')).toBeNull();
  });

  it('rejects non-digits', () => {
    expect(tsToSql('2026-06-17 14:30')).toBeNull();
  });
});

// ─── ids ─────────────────────────────────────────────────────────────────────

describe('nextId', () => {
  it('produces a 6-char lowercase hex id', () => {
    expect(nextId(new Set())).toMatch(/^[0-9a-f]{6}$/);
  });

  it('never returns an id already taken', () => {
    const taken = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = nextId(taken);
      expect(taken.has(id)).toBe(false);
      taken.add(id);
    }
  });
});

// ─── validation ──────────────────────────────────────────────────────────────

describe('validateRecord', () => {
  it('accepts a well-formed record', () => {
    expect(validateRecord(rec(), 1)).toEqual([]);
  });

  it('rejects an unknown kind', () => {
    const errs = validateRecord(rec({ kn: 'nonsense' as never }), 1);
    expect(errs.some((e) => e.message.includes("'kn'"))).toBe(true);
  });

  it('rejects an empty claim', () => {
    const errs = validateRecord(rec({ cl: '   ' }), 1);
    expect(errs.some((e) => e.message.includes('claim'))).toBe(true);
  });

  it('requires when and then on behavior records', () => {
    const errs = validateRecord(rec({ kn: 'behavior' }), 1);
    expect(errs.some((e) => e.message.includes("'wn'"))).toBe(true);
    expect(errs.some((e) => e.message.includes("'tn'"))).toBe(true);
  });

  it('accepts a complete behavior record', () => {
    const errs = validateRecord(
      rec({ kn: 'behavior', cl: 'delete removes rim', wn: 'a delete event arrives', tn: 'the rim is removed' }),
      1,
    );
    expect(errs).toEqual([]);
  });

  it('forbids given/when/then on non-behavior kinds', () => {
    const errs = validateRecord(rec({ kn: 'decision', wn: 'something happens' }), 1);
    expect(errs.some((e) => e.message.includes("only valid on kind 'behavior'"))).toBe(true);
  });

  it('requires rf on a source record', () => {
    const errs = validateRecord(rec({ kn: 'source', cl: 'VAT rounding' }), 1);
    expect(errs.some((e) => e.message.includes("'source' requires 'rf'"))).toBe(true);
  });

  it('accepts a complete source record', () => {
    const errs = validateRecord(
      rec({ kn: 'source', cl: 'VAT rounding', rf: 'docs/tax/vat.md', sb: ['src/tax/Vat.ts'] }),
      1,
    );
    expect(errs).toEqual([]);
  });

  it('forbids rf on a non-source kind', () => {
    const errs = validateRecord(rec({ kn: 'decision', rf: 'docs/x.md' }), 1);
    expect(errs.some((e) => e.message.includes("'rf' is only valid on kind 'source'"))).toBe(true);
  });

  it('accepts every bare provenance token', () => {
    for (const pv of ['u', 'a', 'i']) {
      expect(validateRecord(rec({ pv }), 1)).toEqual([]);
    }
  });

  it('accepts pointer provenance forms', () => {
    for (const pv of ['g:abc123f', 't:tests/rim.test.ts', 'n:src/a.php:42', 'd:specs/old.md']) {
      expect(validateRecord(rec({ pv }), 1)).toEqual([]);
    }
  });

  it('rejects an unknown provenance prefix', () => {
    const errs = validateRecord(rec({ pv: 'z:whatever' }), 1);
    expect(errs.some((e) => e.message.includes("'pv'"))).toBe(true);
  });

  it('rejects a prefix with no pointer', () => {
    const errs = validateRecord(rec({ pv: 'g:' }), 1);
    expect(errs.some((e) => e.message.includes("'pv'"))).toBe(true);
  });

  it('rejects a non-object', () => {
    expect(validateRecord('nope', 1)[0]?.message).toBe('not a JSON object');
    expect(validateRecord([1, 2], 1)[0]?.message).toBe('not a JSON object');
  });

  it('rejects subject entries that are not non-empty strings', () => {
    const errs = validateRecord(rec({ sb: ['ok', ''] as string[] }), 1);
    expect(errs.some((e) => e.message.includes("'sb'"))).toBe(true);
  });
});

// ─── serialisation ───────────────────────────────────────────────────────────

describe('serializeRecord', () => {
  it('emits keys in canonical order regardless of input order', () => {
    const line = serializeRecord({
      ts: '20260617143022', cl: 'x', id: 'aa11bb', pv: 'u', kn: 'intent',
    } as KnowledgeRecord);
    expect(line).toBe('{"id":"aa11bb","kn":"intent","cl":"x","pv":"u","ts":"20260617143022"}');
  });

  it('omits undefined optional fields entirely', () => {
    expect(serializeRecord(rec())).not.toContain('null');
    expect(serializeRecord(rec())).not.toContain('"bc"');
  });

  it('places rf between tn and pv in canonical order', () => {
    const line = serializeRecord({
      id: 'aa11bb', kn: 'source', cl: 'topic', rf: 'docs/x.md', pv: 'u', ts: '20260617143022',
    } as KnowledgeRecord);
    expect(line).toBe('{"id":"aa11bb","kn":"source","cl":"topic","rf":"docs/x.md","pv":"u","ts":"20260617143022"}');
  });

  it('produces exactly one line (merge=union depends on this)', () => {
    const line = serializeRecord(rec({ cl: 'multi\nline\nclaim', bc: 'because\nreasons' }));
    expect(line.includes('\n')).toBe(false);
  });

  it('round-trips through parseRecords', () => {
    const original = rec({ sb: ['src/a.ts::Foo'], bc: 'weil' });
    const { records, errors } = parseRecords(serializeRecord(original));
    expect(errors).toEqual([]);
    expect(records[0]).toEqual(original);
  });
});

// ─── parsing ─────────────────────────────────────────────────────────────────

describe('parseRecords', () => {
  it('skips blank lines', () => {
    const text = `\n${serializeRecord(rec())}\n\n`;
    const { records, errors } = parseRecords(text);
    expect(records).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('reports malformed JSON with a line number and keeps going', () => {
    const text = [serializeRecord(rec({ id: 'aaa111' })), 'not json', serializeRecord(rec({ id: 'bbb222' }))].join('\n');
    const { records, errors } = parseRecords(text);
    expect(records.map((r) => r.id)).toEqual(['aaa111', 'bbb222']);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.line).toBe(2);
  });

  it('rejects a duplicate id rather than silently keeping both', () => {
    const text = [serializeRecord(rec()), serializeRecord(rec({ cl: 'different' }))].join('\n');
    const { records, errors } = parseRecords(text);
    expect(records).toHaveLength(1);
    expect(errors.some((e) => e.message.includes('duplicate id'))).toBe(true);
  });

  it('reports an invalid record without dropping valid neighbours', () => {
    const bad = JSON.stringify({ id: 'ccc333', kn: 'bogus', cl: 'x', pv: 'u', ts: '20260617143022' });
    const text = [serializeRecord(rec({ id: 'aaa111' })), bad].join('\n');
    const { records, errors } = parseRecords(text);
    expect(records.map((r) => r.id)).toEqual(['aaa111']);
    expect(errors.some((e) => e.id === 'ccc333')).toBe(true);
  });
});

// ─── file io ─────────────────────────────────────────────────────────────────

describe('append / read', () => {
  it('returns empty for a missing knowledge file', () => {
    expect(readRecords(tmpDir)).toEqual({ records: [], errors: [] });
  });

  it('appends and reads back in order', () => {
    appendRecords(tmpDir, [rec({ id: 'aaa111' }), rec({ id: 'bbb222' })]);
    appendRecords(tmpDir, [rec({ id: 'ccc333' })]);
    const { records, errors } = readRecords(tmpDir);
    expect(errors).toEqual([]);
    expect(records.map((r) => r.id)).toEqual(['aaa111', 'bbb222', 'ccc333']);
  });

  it('writes one physical line per record', () => {
    appendRecords(tmpDir, [rec({ id: 'aaa111' }), rec({ id: 'bbb222' })]);
    const lines = fs.readFileSync(knowledgePath(tmpDir), 'utf-8').split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
  });

  it('appending an empty list is a no-op', () => {
    appendRecords(tmpDir, []);
    expect(fs.existsSync(knowledgePath(tmpDir))).toBe(false);
  });
});

// ─── supersede chains ────────────────────────────────────────────────────────

describe('liveIds', () => {
  it('treats every record as live when nothing supersedes', () => {
    expect(liveIds([rec({ id: 'aaa111' }), rec({ id: 'bbb222' })]).size).toBe(2);
  });

  it('drops a superseded record', () => {
    const live = liveIds([rec({ id: 'aaa111' }), rec({ id: 'bbb222', ss: 'aaa111' })]);
    expect(live.has('aaa111')).toBe(false);
    expect(live.has('bbb222')).toBe(true);
  });

  it('keeps only the tail of a chain', () => {
    const live = liveIds([
      rec({ id: 'aaa111' }),
      rec({ id: 'bbb222', ss: 'aaa111' }),
      rec({ id: 'ccc333', ss: 'bbb222' }),
    ]);
    expect([...live]).toEqual(['ccc333']);
  });
});

describe('provenanceKind', () => {
  it('returns the bare token unchanged', () => {
    expect(provenanceKind('u')).toBe('u');
  });
  it('strips the pointer from a prefixed form', () => {
    expect(provenanceKind('g:abc123f')).toBe('g');
    expect(provenanceKind('n:src/a.php:42')).toBe('n');
  });
});

describe('provenancePointers', () => {
  it('yields nothing for bare tokens that carry no file', () => {
    expect(provenancePointers('u')).toEqual([]);
    expect(provenancePointers('a')).toEqual([]);
    expect(provenancePointers('i')).toEqual([]);
  });
  it('yields the file for d: (doc) and t: (test)', () => {
    expect(provenancePointers('d:docs/adr/0001.md')).toEqual(['docs/adr/0001.md']);
    expect(provenancePointers('t:tests/foo.test.ts')).toEqual(['tests/foo.test.ts']);
  });
  it('strips the trailing :line from an n: code location', () => {
    expect(provenancePointers('n:src/a.php:42')).toEqual(['src/a.php']);
    expect(provenancePointers('n:src/a.php')).toEqual(['src/a.php']);
  });
  it('yields nothing for g: — a git sha is not a path', () => {
    expect(provenancePointers('g:abc123f')).toEqual([]);
  });
});

describe('missingProvenanceRefs', () => {
  it('flags a d:/t:/n: pointer whose file is not on disk', () => {
    const r = rec({ pv: 'd:openspec/design-that-was-invented.md' });
    expect(missingProvenanceRefs(r, tmpDir)).toEqual(['openspec/design-that-was-invented.md']);
  });
  it('passes when the cited file exists', () => {
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs/real.md'), '# real');
    expect(missingProvenanceRefs(rec({ pv: 'd:docs/real.md' }), tmpDir)).toEqual([]);
  });
  it('never flags a bare token or a git sha', () => {
    expect(missingProvenanceRefs(rec({ pv: 'i' }), tmpDir)).toEqual([]);
    expect(missingProvenanceRefs(rec({ pv: 'g:deadbeef' }), tmpDir)).toEqual([]);
  });
  it('checks the path portion of an n: pointer, ignoring the line number', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src/a.ts'), 'export const x = 1;');
    expect(missingProvenanceRefs(rec({ pv: 'n:src/a.ts:999' }), tmpDir)).toEqual([]);
    expect(missingProvenanceRefs(rec({ pv: 'n:src/gone.ts:1' }), tmpDir)).toEqual(['src/gone.ts']);
  });
});

// ─── MCP handlers ────────────────────────────────────────────────────────────

describe('record MCP handlers', () => {
  let dbDir: string;

  beforeEach(async () => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shanpan-recmcp-'));
    fs.mkdirSync(path.join(dbDir, '.shanpan'), { recursive: true });
    const { db, conn } = await openDatabase(dbDir);
    await dropAndRecreateSchema(conn);
    for (const [id, fqn] of [
      ['src/a.ts::Svc', 'Svc'],
      ['src/a.ts::Svc.run', 'Svc.run'],
    ]) {
      const r = await conn.query(
        `CREATE (:CodeSymbol { id: '${id}', fqn: '${fqn}', symbol_type: 'class', file_path: 'src/a.ts', line_start: 0, line_end: 0, language: 'typescript' })`,
      );
      if (!Array.isArray(r)) r.close();
    }
    const rf = await conn.query(
      `CREATE (:File { id: 'src/a.ts', path: 'src/a.ts', ext: '.ts', kind: 'source' })`,
    );
    if (!Array.isArray(rf)) rf.close();

    const recs: KnowledgeRecord[] = [
      rec({ id: 'aaa111', kn: 'gotcha', cl: 'method level trap', sb: ['src/a.ts::Svc.run'] }),
      rec({ id: 'bbb222', kn: 'constraint', cl: 'class level invariant', sb: ['src/a.ts::Svc'] }),
      rec({ id: 'ccc333', kn: 'intent', cl: 'file level purpose', sb: ['src/a.ts'] }),
      rec({ id: 'ddd444', kn: 'rejected', cl: 'tried caching results', bc: 'invalidation was unsolvable' }),
      rec({ id: 'eee555', kn: 'decision', cl: 'old ruling', sb: ['src/a.ts::Svc'] }),
      rec({ id: 'fff666', kn: 'decision', cl: 'new ruling', sb: ['src/a.ts::Svc'], ss: 'eee555' }),
      rec({ id: 'sss777', kn: 'source', cl: 'service protocol', rf: 'https://wiki/svc', sb: ['src/a.ts::Svc'] }),
    ];
    appendRecords(dbDir, recs);
    await indexRecords(conn, recs);
    await closeDatabase(db, conn);
  });

  afterEach(() => {
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  function parsed(res: { content: { type: string; text: string }[] }): any {
    return JSON.parse(res.content[0]!.text);
  }

  it('walks method → class → file when fetching records for a symbol', async () => {
    const { handleGetRecordsForSymbol } = await import('../src/cli/commands/mcp.js');
    const out = parsed(await handleGetRecordsForSymbol(dbDir, 'src/a.ts::Svc.run'));
    const ids = out.map((r: { id: string }) => r.id).sort();
    expect(ids).toContain('aaa111'); // the method itself
    expect(ids).toContain('bbb222'); // inherited from the class
    expect(ids).toContain('ccc333'); // inherited from the file
  });

  it('returns all records for symbols in a file when given a bare file path', async () => {
    const { handleGetRecordsForSymbol } = await import('../src/cli/commands/mcp.js');
    const out = parsed(await handleGetRecordsForSymbol(dbDir, 'src/a.ts'));
    const ids = out.map((r: { id: string }) => r.id).sort();
    expect(ids).toContain('aaa111');
    expect(ids).toContain('bbb222');
    expect(ids).toContain('ccc333');
  });

  it('excludes superseded records by default', async () => {
    const { handleGetRecordsForSymbol } = await import('../src/cli/commands/mcp.js');
    const out = parsed(await handleGetRecordsForSymbol(dbDir, 'src/a.ts::Svc'));
    const ids = out.map((r: { id: string }) => r.id);
    expect(ids).toContain('fff666');
    expect(ids).not.toContain('eee555');
  });

  it('includes superseded records on request', async () => {
    const { handleGetRecordsForSymbol } = await import('../src/cli/commands/mcp.js');
    const out = parsed(await handleGetRecordsForSymbol(dbDir, 'src/a.ts::Svc', true));
    expect(out.map((r: { id: string }) => r.id)).toContain('eee555');
  });

  it('carries a source record and its ref when fetching for a symbol', async () => {
    const { handleGetRecordsForSymbol } = await import('../src/cli/commands/mcp.js');
    const out = parsed(await handleGetRecordsForSymbol(dbDir, 'src/a.ts::Svc'));
    const src = out.find((r: { id: string }) => r.id === 'sss777');
    expect(src).toBeDefined();
    expect(src.ref).toBe('https://wiki/svc');
    expect(src.kind).toBe('source');
  });

  it('finds source records by the document they point at', async () => {
    const { handleGetRecordsByRef } = await import('../src/cli/commands/mcp.js');
    const out = parsed(await handleGetRecordsByRef(dbDir, 'https://wiki/svc'));
    expect(out.map((r: { id: string }) => r.id)).toEqual(['sss777']);
  });

  it('returns nothing for an unknown ref', async () => {
    const { handleGetRecordsByRef } = await import('../src/cli/commands/mcp.js');
    expect(parsed(await handleGetRecordsByRef(dbDir, 'https://nope'))).toEqual([]);
  });

  it('add_record accepts a source with ref and rejects one without', async () => {
    const { handleAddRecord } = await import('../src/cli/commands/mcp.js');
    const ok = await handleAddRecord(dbDir, {
      kind: 'source', claim: 'billing rules', ref: 'docs/billing.md',
    });
    expect(ok.content[0]!.text).toContain('Created record');
    const bad = await handleAddRecord(dbDir, { kind: 'source', claim: 'no ref here' });
    expect(bad.content[0]!.text).toContain('not valid');
  });

  it('returns each record once even when several subjects match', async () => {
    const { handleGetRecordsForSymbol } = await import('../src/cli/commands/mcp.js');
    const out = parsed(await handleGetRecordsForSymbol(dbDir, 'src/a.ts::Svc.run'));
    const ids = out.map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('orders records-for-symbol by kind priority — traps and invariants first', async () => {
    const { handleGetRecordsForSymbol } = await import('../src/cli/commands/mcp.js');
    const out = parsed(await handleGetRecordsForSymbol(dbDir, 'src/a.ts::Svc'));
    const priority: Record<string, number> = {
      gotcha: 0, constraint: 1, rejected: 2, decision: 3, source: 4, behavior: 5, intent: 6, conflict: 7,
    };
    const kinds = out.map((r: { kind: string }) => r.kind);
    const prios = kinds.map((k: string) => priority[k] ?? 99);
    expect(prios).toEqual([...prios].sort((a, b) => a - b));
    // the constraint on Svc must lead the decision on Svc
    expect(kinds.indexOf('constraint')).toBeLessThan(kinds.indexOf('decision'));
  });

  it('searches claim and because text', async () => {
    const { handleSearchRecords } = await import('../src/cli/commands/mcp.js');
    expect(parsed(await handleSearchRecords(dbDir, 'invalidation')).map((r: { id: string }) => r.id))
      .toEqual(['ddd444']);
    expect(parsed(await handleSearchRecords(dbDir, 'TRAP')).map((r: { id: string }) => r.id))
      .toEqual(['aaa111']);
  });

  it('returns nothing for an empty search', async () => {
    const { handleSearchRecords } = await import('../src/cli/commands/mcp.js');
    expect(parsed(await handleSearchRecords(dbDir, ''))).toEqual([]);
  });

  it('filters by kind', async () => {
    const { handleGetRecordsByKind } = await import('../src/cli/commands/mcp.js');
    const out = parsed(await handleGetRecordsByKind(dbDir, 'rejected'));
    expect(out.map((r: { id: string }) => r.id)).toEqual(['ddd444']);
  });

  it('rejects an unknown kind with a helpful message', async () => {
    const { handleGetRecordsByKind } = await import('../src/cli/commands/mcp.js');
    const res = await handleGetRecordsByKind(dbDir, 'nonsense');
    expect(res.content[0]!.text).toContain('Unknown kind');
  });

  it('appends a valid record via add_record', async () => {
    const { handleAddRecord } = await import('../src/cli/commands/mcp.js');
    const res = await handleAddRecord(dbDir, {
      kind: 'gotcha',
      claim: 'freshly learned',
      because: 'observed in this session',
      subjects: ['src/a.ts::Svc'],
    });
    expect(res.content[0]!.text).toContain('Created record');
    const { records } = readRecords(dbDir);
    expect(records.some((r) => r.cl === 'freshly learned')).toBe(true);
  });

  it('refuses a behavior record missing when/then', async () => {
    const { handleAddRecord } = await import('../src/cli/commands/mcp.js');
    const res = await handleAddRecord(dbDir, { kind: 'behavior', claim: 'incomplete scenario' });
    expect(res.content[0]!.text).toContain('not valid');
    const { records } = readRecords(dbDir);
    expect(records.some((r) => r.cl === 'incomplete scenario')).toBe(false);
  });

  it('refuses to supersede a record that does not exist', async () => {
    const { handleAddRecord } = await import('../src/cli/commands/mcp.js');
    const res = await handleAddRecord(dbDir, { kind: 'decision', claim: 'x', supersedes: 'nope99' });
    expect(res.content[0]!.text).toContain('no such record');
  });

  it('reports unresolved subjects as record drift', async () => {
    const { handleAddRecord, handleGetRecordDrift } = await import('../src/cli/commands/mcp.js');
    await handleAddRecord(dbDir, {
      kind: 'gotcha',
      claim: 'points at vanished code',
      subjects: ['src/gone.ts::Vanished'],
    });
    const out = parsed(await handleGetRecordDrift(dbDir));
    expect(out.unresolved.map((u: { subject: string }) => u.subject)).toEqual(['src/gone.ts::Vanished']);
  });

  it('reports no drift when every subject resolves', async () => {
    const { handleGetRecordDrift } = await import('../src/cli/commands/mcp.js');
    const out = parsed(await handleGetRecordDrift(dbDir));
    expect(out.unresolved).toEqual([]);
    expect(out.invalidRecords).toEqual([]);
  });

  it('flags a source record whose local document is missing — but never a URL', async () => {
    const { handleAddRecord, handleGetRecordDrift } = await import('../src/cli/commands/mcp.js');
    await handleAddRecord(dbDir, { kind: 'source', claim: 'gone doc', ref: 'docs/missing.md' });
    await handleAddRecord(dbDir, { kind: 'source', claim: 'external', ref: 'https://example.com/x' });
    const out = parsed(await handleGetRecordDrift(dbDir));
    const refs = out.missingRefs.map((m: { ref: string }) => m.ref);
    expect(refs).toContain('docs/missing.md');
    expect(refs).not.toContain('https://example.com/x'); // URLs are never checked
    // A missing document is soft — it must not surface as hard subject drift.
    expect(out.unresolved.map((u: { recordId: string }) => u.recordId)).not.toContain('sss777');
  });

  it('rejects add_record when provenance cites a file that does not exist', async () => {
    const { handleAddRecord } = await import('../src/cli/commands/mcp.js');
    const res = await handleAddRecord(dbDir, {
      kind: 'decision',
      claim: 'guessed from a design doc that was never read',
      provenance: 'd:openspec/2025-11-invented.md',
    });
    expect(res.content[0]!.text).toContain('does not exist');
    // The fabricated claim must not reach disk.
    const { records } = readRecords(dbDir);
    expect(records.some((r) => r.pv === 'd:openspec/2025-11-invented.md')).toBe(false);
  });

  it('accepts add_record when the cited provenance file is real', async () => {
    const { handleAddRecord } = await import('../src/cli/commands/mcp.js');
    fs.writeFileSync(path.join(dbDir, 'DECISIONS.md'), '# a real doc');
    const res = await handleAddRecord(dbDir, {
      kind: 'decision',
      claim: 'grounded in a doc that exists',
      provenance: 'd:DECISIONS.md',
    });
    expect(res.content[0]!.text).toContain('Created record');
  });

  it('reports a record written straight to the file with a fabricated source', async () => {
    const { handleGetRecordDrift } = await import('../src/cli/commands/mcp.js');
    // Bypass the write-time gate the way a bootstrap subagent did: append raw
    // NDJSON. Continuous verify must still catch the fabricated provenance.
    appendRecords(dbDir, [
      rec({
        id: 'fab001',
        kn: 'constraint',
        cl: 'invented invariant',
        pv: 'd:openspec/fabricated.md',
      }),
    ]);
    const out = parsed(await handleGetRecordDrift(dbDir));
    const pointers = out.fabricatedRefs.map((f: { pointer: string }) => f.pointer);
    expect(pointers).toContain('openspec/fabricated.md');
  });
});

// ─── directory-anchored records ──────────────────────────────────────────────

describe('directory anchoring', () => {
  let dbDir: string;

  beforeEach(async () => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shanpan-diranchor-'));
    fs.mkdirSync(path.join(dbDir, '.shanpan'), { recursive: true });
    // A real module subtree the fallback can resolve, plus a sibling with a
    // shared prefix to prove segment-boundary matching.
    fs.mkdirSync(path.join(dbDir, 'apps/bmf/src/Consumers'), { recursive: true });
    fs.mkdirSync(path.join(dbDir, 'apps/bmfx/src'), { recursive: true });
    const { db, conn } = await openDatabase(dbDir);
    await dropAndRecreateSchema(conn);
    // A concrete symbol living inside the module, so the file resolves too.
    const r = await conn.query(
      `CREATE (:CodeSymbol { id: 'apps/bmf/src/Consumers/Foo.php::Foo', fqn: 'Foo', symbol_type: 'class', file_path: 'apps/bmf/src/Consumers/Foo.php', line_start: 0, line_end: 0, language: 'php' })`,
    );
    if (!Array.isArray(r)) r.close();
    await closeDatabase(db, conn);
  });

  afterEach(() => {
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  function parsed(res: { content: { type: string; text: string }[] }): any {
    return JSON.parse(res.content[0]!.text);
  }

  it('resolves a directory subject to a File node with kind dir, no drift', async () => {
    const recs = [rec({ id: 'aaa111', kn: 'constraint', cl: 'all consumers idempotent', sb: ['apps/bmf/src'] })];
    appendRecords(dbDir, recs);
    const { db, conn } = await openDatabase(dbDir);
    try {
      const stats = await indexRecords(conn, recs, dbDir);
      expect(stats.unresolved).toEqual([]);
      const { rows } = await queryAll(conn, "MATCH (f:File {id: 'apps/bmf/src'}) RETURN f.kind AS kind");
      expect(rows[0]?.['kind']).toBe('dir');
    } finally {
      await closeDatabase(db, conn);
    }
  });

  it('surfaces a module rule for a file deep in the subtree', async () => {
    const recs = [rec({ id: 'aaa111', kn: 'constraint', cl: 'all consumers idempotent', sb: ['apps/bmf/src'] })];
    appendRecords(dbDir, recs);
    const { db, conn } = await openDatabase(dbDir);
    try {
      await indexRecords(conn, recs, dbDir);
    } finally {
      await closeDatabase(db, conn);
    }
    const { handleGetRecordsForSymbol } = await import('../src/cli/commands/mcp.js');
    const out = parsed(await handleGetRecordsForSymbol(dbDir, 'apps/bmf/src/Consumers/Foo.php'));
    expect(out.map((r: { id: string }) => r.id)).toContain('aaa111');
  });

  it('does not leak a module rule to a sibling with a shared path prefix', async () => {
    const recs = [rec({ id: 'aaa111', kn: 'constraint', cl: 'bmf rule', sb: ['apps/bmf/src'] })];
    appendRecords(dbDir, recs);
    const { db, conn } = await openDatabase(dbDir);
    try {
      await indexRecords(conn, recs, dbDir);
    } finally {
      await closeDatabase(db, conn);
    }
    const { handleGetRecordsForSymbol } = await import('../src/cli/commands/mcp.js');
    // apps/bmfx/... must NOT match apps/bmf as an ancestor.
    const out = parsed(await handleGetRecordsForSymbol(dbDir, 'apps/bmfx/src/Bar.php'));
    expect(out.map((r: { id: string }) => r.id)).not.toContain('aaa111');
  });

  it('emits a subtree glob for a directory-anchored Cursor rule', async () => {
    const recs = [rec({ id: 'aaa111', kn: 'constraint', cl: 'module rule', sb: ['apps/bmf/src'] })];
    appendRecords(dbDir, recs);
    const { db, conn } = await openDatabase(dbDir);
    let groups;
    try {
      await indexRecords(conn, recs, dbDir);
      const { fetchRecordsByFile } = await import('../src/core/cursor-rules.js');
      groups = await fetchRecordsByFile(conn);
    } finally {
      await closeDatabase(db, conn);
    }
    const { renderRule } = await import('../src/core/cursor-rules.js');
    const dirGroup = groups.find((g) => g.file === 'apps/bmf/src');
    expect(dirGroup?.isDir).toBe(true);
    const rule = renderRule(dirGroup!.file, dirGroup!.records, dirGroup!.isDir);
    expect(rule).toContain('globs: apps/bmf/src/**');
    expect(rule).toContain('# Known about module apps/bmf/src');
  });
});

// ─── stale-graph diagnostics (agent-feedback fixes) ──────────────────────────

describe('stale-graph diagnostics', () => {
  let dbDir: string;

  beforeEach(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shanpan-stale-'));
    fs.mkdirSync(path.join(dbDir, '.shanpan'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  function parsed(res: { content: { type: string; text: string }[] }): any {
    return JSON.parse(res.content[0]!.text);
  }

  it('record reads return a rebuild hint, not [], when the graph has records on disk but none indexed', async () => {
    // knowledge.ndjson has a record, but the graph is empty (never indexed).
    appendRecords(dbDir, [rec({ id: 'aaa111', kn: 'gotcha', cl: 'x', sb: ['src/a.ts'] })]);
    const { db, conn } = await openDatabase(dbDir);
    await dropAndRecreateSchema(conn);
    await closeDatabase(db, conn);

    const { handleGetRecordsByKind } = await import('../src/cli/commands/mcp.js');
    const res = await handleGetRecordsByKind(dbDir, 'gotcha');
    expect(res.content[0]!.text).toContain('none are indexed');
    expect(res.content[0]!.text).toContain('records index');
  });

  it('returns a real empty array when there genuinely are no records', async () => {
    const { db, conn } = await openDatabase(dbDir);
    await dropAndRecreateSchema(conn);
    await closeDatabase(db, conn);

    const { handleGetRecordsByKind } = await import('../src/cli/commands/mcp.js');
    const res = await handleGetRecordsByKind(dbDir, 'gotcha');
    expect(parsed(res)).toEqual([]);
  });

  it('get_record_drift flags a stale graph', async () => {
    appendRecords(dbDir, [rec({ id: 'aaa111', kn: 'gotcha', cl: 'x', sb: ['src/a.ts'] })]);
    const { db, conn } = await openDatabase(dbDir);
    await dropAndRecreateSchema(conn);
    await closeDatabase(db, conn);

    const { handleGetRecordDrift } = await import('../src/cli/commands/mcp.js');
    const out = parsed(await handleGetRecordDrift(dbDir));
    expect(out.graphStale).toContain('records index');
  });
});

describe('diagnoseError', () => {
  it('treats an unknown property as a query typo, not a stale graph', async () => {
    const { diagnoseError } = await import('../src/cli/commands/mcp.js');
    const res = diagnoseError(new Error('Binder exception: Cannot find property filePath for c'));
    expect(res.content[0]!.text).not.toContain('out of date');
    expect(res.content[0]!.text).toContain('file_path');
    expect(res.content[0]!.text).toContain('query error');
  });

  it('translates a genuine schema/table error into a rebuild command', async () => {
    const { diagnoseError } = await import('../src/cli/commands/mcp.js');
    const res = diagnoseError(new Error('Binder exception: Table Spec does not exist'));
    expect(res.content[0]!.text).toContain('out of date');
    expect(res.content[0]!.text).toContain('analyze --full');
  });

  it('passes a non-schema error through without a false migration hint', async () => {
    const { diagnoseError } = await import('../src/cli/commands/mcp.js');
    const res = diagnoseError(new Error('something unrelated exploded'));
    expect(res.content[0]!.text).toContain('shanpan error');
    expect(res.content[0]!.text).not.toContain('analyze --full');
  });
});

// ─── schema bookkeeping ──────────────────────────────────────────────────────

describe('schema table names', () => {
  it('stay aligned with the DDL statements', async () => {
    const { SCHEMA_STATEMENTS, SCHEMA_TABLE_NAMES } = await import('../src/core/schema.js');
    expect(SCHEMA_TABLE_NAMES).toHaveLength(SCHEMA_STATEMENTS.length);
    const derived = SCHEMA_STATEMENTS.map((s) => {
      const m = /CREATE (?:NODE|REL) TABLE (?:GROUP )?(\w+)/.exec(s);
      return m?.[1] ?? null;
    });
    expect(derived).toEqual(SCHEMA_TABLE_NAMES);
  });

  it('lists every table in DROP_ORDER', async () => {
    const { SCHEMA_TABLE_NAMES, DROP_ORDER } = await import('../src/core/schema.js');
    expect([...SCHEMA_TABLE_NAMES].sort()).toEqual([...DROP_ORDER].sort());
  });
});

// ─── graph indexing ──────────────────────────────────────────────────────────

describe('indexRecords', () => {
  let db: Database;
  let conn: Connection;
  let dbDir: string;

  beforeEach(async () => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shanpan-recidx-'));
    fs.mkdirSync(path.join(dbDir, '.shanpan'), { recursive: true });
    ({ db, conn } = await openDatabase(dbDir));
    await dropAndRecreateSchema(conn);
    const r = await conn.query(
      `CREATE (:CodeSymbol { id: 'src/a.ts::Foo', fqn: 'Foo', symbol_type: 'class', file_path: 'src/a.ts', line_start: 0, line_end: 0, language: 'typescript' })`,
    );
    if (!Array.isArray(r)) r.close();
    const rf = await conn.query(
      `CREATE (:File { id: 'composer.json', path: 'composer.json', ext: '.json', kind: 'config' })`,
    );
    if (!Array.isArray(rf)) rf.close();
  });

  afterEach(async () => {
    await closeDatabase(db, conn);
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it('creates Record nodes with a real TIMESTAMP', async () => {
    await indexRecords(conn, [rec({ id: 'aaa111' })]);
    const { rows } = await queryAll(conn, 'MATCH (r:Record) RETURN r.id AS id, r.ts AS ts, r.kind AS kind');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['kind']).toBe('decision');
    // Proves timestamp('...') parsed rather than landing as NULL or a string.
    expect(rows[0]?.['ts']).toBeInstanceOf(Date);
  });

  it('supports temporal comparison in Cypher', async () => {
    await indexRecords(conn, [
      rec({ id: 'aaa111', ts: '20260101120000' }),
      rec({ id: 'bbb222', ts: '20260901120000' }),
    ]);
    const { rows } = await queryAll(
      conn,
      `MATCH (r:Record) WHERE r.ts > timestamp('2026-06-01 00:00:00') RETURN r.id AS id`,
    );
    expect(rows.map((r) => r['id'])).toEqual(['bbb222']);
  });

  it('links ABOUT to an existing CodeSymbol', async () => {
    const stats = await indexRecords(conn, [rec({ id: 'aaa111', sb: ['src/a.ts::Foo'] })]);
    expect(stats.about).toBe(1);
    expect(stats.unresolved).toEqual([]);
    const { rows } = await queryAll(
      conn,
      'MATCH (r:Record)-[:ABOUT]->(c:CodeSymbol) RETURN c.id AS id',
    );
    expect(rows[0]?.['id']).toBe('src/a.ts::Foo');
  });

  it('links ABOUT to an existing File', async () => {
    const stats = await indexRecords(conn, [rec({ id: 'aaa111', sb: ['composer.json'] })]);
    expect(stats.about).toBe(1);
    const { rows } = await queryAll(conn, 'MATCH (r:Record)-[:ABOUT]->(f:File) RETURN f.id AS id');
    expect(rows[0]?.['id']).toBe('composer.json');
  });

  it('reports an unresolved subject instead of creating a stub node', async () => {
    const stats = await indexRecords(conn, [rec({ id: 'aaa111', sb: ['src/gone.ts::Vanished'] })]);
    expect(stats.about).toBe(0);
    expect(stats.unresolved).toEqual([{ recordId: 'aaa111', subject: 'src/gone.ts::Vanished' }]);
    const { rows } = await queryAll(conn, 'MATCH (c:CodeSymbol) RETURN c.id AS id');
    expect(rows.map((r) => r['id'])).toEqual(['src/a.ts::Foo']);
  });

  it('marks superseded records as not live and edges the chain', async () => {
    const stats = await indexRecords(conn, [
      rec({ id: 'aaa111' }),
      rec({ id: 'bbb222', ss: 'aaa111' }),
    ]);
    expect(stats.supersedes).toBe(1);
    expect(stats.live).toBe(1);
    const { rows } = await queryAll(
      conn,
      'MATCH (r:Record) WHERE r.live RETURN r.id AS id',
    );
    expect(rows.map((r) => r['id'])).toEqual(['bbb222']);
  });

  it('does not report unresolved subjects for superseded records', async () => {
    const stats = await indexRecords(conn, [
      rec({ id: 'aaa111', sb: ['src/gone.ts::Vanished'] }),
      rec({ id: 'bbb222', sb: ['src/a.ts::Foo'], ss: 'aaa111' }),
    ]);
    // aaa111 points at deleted code, but that is why it was superseded.
    expect(stats.unresolved).toEqual([]);
  });

  it('still reports unresolved subjects for live records', async () => {
    const stats = await indexRecords(conn, [
      rec({ id: 'aaa111', sb: ['src/gone.ts::Vanished'] }),
      rec({ id: 'bbb222', sb: ['src/a.ts::Foo'] }),
    ]);
    expect(stats.unresolved).toEqual([{ recordId: 'aaa111', subject: 'src/gone.ts::Vanished' }]);
  });

  it('skips a dangling supersedes without failing', async () => {
    const stats = await indexRecords(conn, [rec({ id: 'bbb222', ss: 'compacted-away' })]);
    expect(stats.supersedes).toBe(0);
    expect(stats.records).toBe(1);
  });

  it('stores provenance_kind for filtering', async () => {
    await indexRecords(conn, [
      rec({ id: 'aaa111', pv: 'u' }),
      rec({ id: 'bbb222', pv: 'g:abc123f' }),
      rec({ id: 'ccc333', pv: 'i' }),
    ]);
    const { rows } = await queryAll(
      conn,
      `MATCH (r:Record) WHERE r.provenance_kind = 'i' RETURN r.id AS id`,
    );
    expect(rows.map((r) => r['id'])).toEqual(['ccc333']);
  });

  it('escapes quotes in claims', async () => {
    await indexRecords(conn, [rec({ id: 'aaa111', cl: "it's a 'quoted' claim" })]);
    const { rows } = await queryAll(conn, 'MATCH (r:Record) RETURN r.claim AS claim');
    expect(rows[0]?.['claim']).toBe("it's a 'quoted' claim");
  });
});

// ─── legacy .specgraph → .shanpan migration ──────────────────────────────────

describe('migrateLegacyLayout', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shanpan-migrate-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('renames a committed .specgraph/ dir to .shanpan/, preserving knowledge byte-for-byte', () => {
    fs.mkdirSync(path.join(dir, '.specgraph'));
    const knowledge = '{"id":"aa11bb","kn":"intent","cl":"x","pv":"u","ts":"20260617143022"}\n';
    fs.writeFileSync(path.join(dir, '.specgraph', 'knowledge.ndjson'), knowledge);
    fs.writeFileSync(path.join(dir, '.specgraphrc.json'), '{"languages":["php"]}');

    migrateLegacyLayout(dir);

    expect(fs.existsSync(path.join(dir, '.specgraph'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, '.shanpan', 'knowledge.ndjson'), 'utf-8')).toBe(knowledge);
    expect(fs.existsSync(path.join(dir, '.specgraphrc.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.shanpanrc.json'))).toBe(true);
  });

  it('is a silent no-op when there is nothing to migrate', () => {
    expect(() => migrateLegacyLayout(dir)).not.toThrow();
    expect(fs.existsSync(path.join(dir, '.shanpan'))).toBe(false);
  });

  it('never clobbers a live .shanpan/ — leaves the legacy dir untouched', () => {
    fs.mkdirSync(path.join(dir, '.specgraph'));
    fs.writeFileSync(path.join(dir, '.specgraph', 'knowledge.ndjson'), 'old\n');
    fs.mkdirSync(path.join(dir, '.shanpan'));
    fs.writeFileSync(path.join(dir, '.shanpan', 'knowledge.ndjson'), 'current\n');

    migrateLegacyLayout(dir);

    // The live layout wins; the stale legacy dir is left for the user to remove.
    expect(fs.readFileSync(path.join(dir, '.shanpan', 'knowledge.ndjson'), 'utf-8')).toBe('current\n');
    expect(fs.existsSync(path.join(dir, '.specgraph'))).toBe(true);
  });
});
