import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  RECORD_KINDS,
  PROVENANCE_BARE,
  PROVENANCE_PREFIXES,
  type KnowledgeRecord,
  type RecordKind,
  type RecordValidationError,
} from '../types/record.js';
import { DB_DIR } from './db.js';

export const KNOWLEDGE_FILE = 'knowledge.ndjson';
export const ARCHIVE_FILE = 'knowledge.archive.ndjson';

/** Canonical key order — keeps diffs stable across writers. */
const KEY_ORDER: (keyof KnowledgeRecord)[] = [
  'id', 'kn', 'sb', 'cl', 'bc', 'gv', 'wn', 'tn', 'rf', 'pv', 'ts', 'ss',
];

export function knowledgePath(projectDir: string): string {
  return path.join(projectDir, DB_DIR, KNOWLEDGE_FILE);
}

export function archivePath(projectDir: string): string {
  return path.join(projectDir, DB_DIR, ARCHIVE_FILE);
}

// ─── timestamps ──────────────────────────────────────────────────────────────

const TS_RE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/;

/** Format a Date as the wire timestamp YYYYMMDDHHIISS, always UTC. */
export function formatTs(date: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    p(date.getUTCFullYear(), 4) +
    p(date.getUTCMonth() + 1) +
    p(date.getUTCDate()) +
    p(date.getUTCHours()) +
    p(date.getUTCMinutes()) +
    p(date.getUTCSeconds())
  );
}

/**
 * Split a wire timestamp into SQL-ish form `YYYY-MM-DD HH:II:SS`.
 * Returns null when the string is malformed or not a real calendar instant.
 */
export function tsToSql(ts: string): string | null {
  const m = TS_RE.exec(ts);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m as unknown as [string, string, string, string, string, string, string];
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
  const parsed = new Date(iso);
  // Round-trip guards against 20260231… and friends.
  if (Number.isNaN(parsed.getTime()) || formatTs(parsed) !== ts) return null;
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

// ─── ids ─────────────────────────────────────────────────────────────────────

/** Generate a short id not present in `taken`. */
export function nextId(taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const id = crypto.randomBytes(3).toString('hex');
    if (!taken.has(id)) return id;
  }
  // Astronomically unlikely; widen rather than loop forever.
  return crypto.randomBytes(8).toString('hex');
}

// ─── validation ──────────────────────────────────────────────────────────────

function validProvenance(pv: string): boolean {
  if ((PROVENANCE_BARE as readonly string[]).includes(pv)) return true;
  const colon = pv.indexOf(':');
  if (colon <= 0) return false;
  const prefix = pv.slice(0, colon);
  const pointer = pv.slice(colon + 1);
  return (PROVENANCE_PREFIXES as readonly string[]).includes(prefix) && pointer.length > 0;
}

/**
 * Validate one record. Returns an empty array when the record is well-formed.
 * `line` is only used to locate the problem for the caller.
 */
export function validateRecord(value: unknown, line: number): RecordValidationError[] {
  const errs: RecordValidationError[] = [];
  const rec = value as Partial<KnowledgeRecord>;
  const id = typeof rec?.id === 'string' ? rec.id : null;
  const err = (message: string): void => void errs.push({ line, id, message });

  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
    return [{ line, id: null, message: 'not a JSON object' }];
  }
  if (typeof rec.id !== 'string' || !/^[0-9a-z]+$/.test(rec.id)) {
    err("'id' must be a lowercase alphanumeric string");
  }
  if (typeof rec.kn !== 'string' || !(RECORD_KINDS as readonly string[]).includes(rec.kn)) {
    err(`'kn' must be one of: ${RECORD_KINDS.join(', ')}`);
  }
  if (typeof rec.cl !== 'string' || rec.cl.trim().length === 0) {
    err("'cl' (claim) is required and must be non-empty");
  }
  if (typeof rec.pv !== 'string' || !validProvenance(rec.pv)) {
    err("'pv' must be u|a|i or one of g:|t:|n:|d: followed by a pointer");
  }
  if (typeof rec.ts !== 'string' || tsToSql(rec.ts) === null) {
    err("'ts' must be a real UTC instant in YYYYMMDDHHIISS form");
  }
  if (rec.sb !== undefined) {
    if (!Array.isArray(rec.sb) || rec.sb.some((s) => typeof s !== 'string' || s.length === 0)) {
      err("'sb' must be an array of non-empty strings");
    }
  }
  if (rec.ss !== undefined && (typeof rec.ss !== 'string' || rec.ss.length === 0)) {
    err("'ss' must be a non-empty record id");
  }

  // given/when/then belongs to `behavior` and nowhere else. This is the rule
  // that makes kind selection mechanical rather than a judgement call.
  const bdd: (keyof KnowledgeRecord)[] = ['gv', 'wn', 'tn'];
  if (rec.kn === 'behavior') {
    if (typeof rec.wn !== 'string' || rec.wn.trim().length === 0) {
      err("'behavior' requires 'wn' (when)");
    }
    if (typeof rec.tn !== 'string' || rec.tn.trim().length === 0) {
      err("'behavior' requires 'tn' (then)");
    }
  } else {
    for (const k of bdd) {
      if (rec[k] !== undefined) {
        err(`'${k}' is only valid on kind 'behavior' — this record is '${String(rec.kn)}'`);
      }
    }
  }

  // `rf` (the source to consult) belongs to `source` and nowhere else, mirroring
  // the given/when/then rule — it keeps "go read this" a distinct kind from the
  // claims an agent must obey.
  if (rec.kn === 'source') {
    if (typeof rec.rf !== 'string' || rec.rf.trim().length === 0) {
      err("'source' requires 'rf' (the document — a URL or repo-relative path)");
    }
  } else if (rec.rf !== undefined) {
    err(`'rf' is only valid on kind 'source' — this record is '${String(rec.kn)}'`);
  }

  return errs;
}

// ─── (de)serialisation ───────────────────────────────────────────────────────

/** Serialise a record to its single canonical NDJSON line (no trailing newline). */
export function serializeRecord(rec: KnowledgeRecord): string {
  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER) {
    const v = rec[key];
    if (v !== undefined) ordered[key] = v;
  }
  return JSON.stringify(ordered);
}

export interface ParseResult {
  records: KnowledgeRecord[];
  errors: RecordValidationError[];
}

/** Parse NDJSON text. Blank lines are skipped; bad lines are reported, not thrown. */
export function parseRecords(text: string): ParseResult {
  const records: KnowledgeRecord[] = [];
  const errors: RecordValidationError[] = [];
  const seen = new Set<string>();

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] ?? '').trim();
    if (raw.length === 0) continue;
    const lineNo = i + 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      errors.push({ line: lineNo, id: null, message: 'malformed JSON' });
      continue;
    }

    const problems = validateRecord(parsed, lineNo);
    if (problems.length > 0) {
      errors.push(...problems);
      continue;
    }

    const rec = parsed as KnowledgeRecord;
    if (seen.has(rec.id)) {
      // merge=union can in principle land the same line twice; identical
      // duplicates are harmless, genuine id reuse is not.
      errors.push({ line: lineNo, id: rec.id, message: `duplicate id '${rec.id}'` });
      continue;
    }
    seen.add(rec.id);
    records.push(rec);
  }

  return { records, errors };
}

export function readRecords(projectDir: string): ParseResult {
  const file = knowledgePath(projectDir);
  if (!fs.existsSync(file)) return { records: [], errors: [] };
  return parseRecords(fs.readFileSync(file, 'utf-8'));
}

/**
 * Append records to the knowledge file, creating it if absent.
 * Always writes whole lines so a concurrent append cannot interleave.
 */
export function appendRecords(projectDir: string, recs: KnowledgeRecord[]): void {
  if (recs.length === 0) return;
  const file = knowledgePath(projectDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = recs.map((r) => serializeRecord(r) + '\n').join('');
  fs.appendFileSync(file, payload, 'utf-8');
}

// ─── supersede chains ────────────────────────────────────────────────────────

/**
 * Ids of records that are still current — i.e. not named by any other
 * record's `ss`. Superseded records stay on disk for the reasoning trail
 * but are excluded from graph queries.
 */
export function liveIds(recs: readonly KnowledgeRecord[]): Set<string> {
  const superseded = new Set<string>();
  for (const r of recs) if (r.ss) superseded.add(r.ss);
  return new Set(recs.filter((r) => !superseded.has(r.id)).map((r) => r.id));
}
