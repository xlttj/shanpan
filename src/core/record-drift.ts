import fs from 'node:fs';
import path from 'node:path';
import type { Connection } from '@ladybugdb/core';
import { queryAll, DB_DIR } from './db.js';
import { readRecords, liveIds, missingProvenanceRefs } from './records.js';
import type { RecordValidationError } from '../types/record.js';

export interface RecordDriftEntry {
  recordId: string;
  subject: string;
  claim: string;
}

export interface MissingRefEntry {
  recordId: string;
  ref: string;
  claim: string;
}

export interface FabricatedRefEntry {
  recordId: string;
  pointer: string;
  claim: string;
}

export interface RecordDriftReport {
  unresolved: RecordDriftEntry[];
  invalidRecords: RecordValidationError[];
  /**
   * Source records whose local `rf` document no longer exists. Kept separate
   * from `unresolved` on purpose: a moved doc is a soft signal for humans, and
   * a URL cannot be checked offline, so this must NEVER feed the Stop hook or a
   * dead link would trap the agent.
   */
  missingRefs: MissingRefEntry[];
  /**
   * Live records whose `pv` provenance cites a d:/t:/n: file that is not on
   * disk — a fabricated or moved source. Unlike `missingRefs` this is a hard
   * correctness signal: filesystem existence is unambiguous, the write-time
   * gate already blocks new ones, and CI/`check` fails on it. It also feeds the
   * Stop hook (once per state) to catch records written straight to the file,
   * bypassing the gate.
   */
  fabricatedRefs: FabricatedRefEntry[];
}

/** A ref is a local path we can existence-check; a URL is not. */
function isLocalRef(ref: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:\/\//i.test(ref);
}

/**
 * Subjects of live records that resolve to no CodeSymbol and no File.
 *
 * Read from disk rather than from Record nodes so the answer stays correct
 * against a stale graph — a record added since the last index still counts.
 */
export async function computeRecordDrift(
  conn: Connection,
  projectDir: string,
): Promise<RecordDriftReport> {
  const { records, errors } = readRecords(projectDir);

  const { rows: symbolRows } = await queryAll(conn, 'MATCH (c:CodeSymbol) RETURN c.id AS id');
  const known = new Set(symbolRows.map((r) => String(r['id'])));
  const { rows: fileRows } = await queryAll(conn, 'MATCH (f:File) RETURN f.id AS id');
  for (const r of fileRows) known.add(String(r['id']));

  const live = liveIds(records);
  const unresolved: RecordDriftEntry[] = [];
  const missingRefs: MissingRefEntry[] = [];
  const fabricatedRefs: FabricatedRefEntry[] = [];
  for (const rec of records) {
    if (!live.has(rec.id)) continue;
    for (const subject of rec.sb ?? []) {
      if (!known.has(subject)) {
        unresolved.push({ recordId: rec.id, subject, claim: rec.cl });
      }
    }
    if (rec.rf && isLocalRef(rec.rf) && !fs.existsSync(path.resolve(projectDir, rec.rf))) {
      missingRefs.push({ recordId: rec.id, ref: rec.rf, claim: rec.cl });
    }
    for (const pointer of missingProvenanceRefs(rec, projectDir)) {
      fabricatedRefs.push({ recordId: rec.id, pointer, claim: rec.cl });
    }
  }

  return { unresolved, invalidRecords: errors, missingRefs, fabricatedRefs };
}

const DRIFT_CACHE_FILE = 'last-drift-report.json';

interface DriftCache {
  reported: string[];
}

export function driftKey(entry: RecordDriftEntry): string {
  return `${entry.recordId} ${entry.subject}`;
}

export function fabricatedKey(entry: FabricatedRefEntry): string {
  return `${entry.recordId} pv:${entry.pointer}`;
}

/**
 * Drift entries reported by the previous hook run. Without this the Stop hook
 * re-emits the same block on every turn while the drift persists, trapping the
 * agent in a loop it cannot exit.
 */
export function loadDriftCache(projectDir: string): Set<string> {
  const cachePath = path.join(projectDir, DB_DIR, DRIFT_CACHE_FILE);
  if (!fs.existsSync(cachePath)) return new Set();
  try {
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as DriftCache;
    return new Set(data.reported ?? []);
  } catch {
    return new Set();
  }
}

/**
 * Persist the keys reported this run so the next hook call can diff against
 * them. Callers pass the already-computed keys (drift + fabricated refs) so a
 * single cache covers every signal the Stop hook emits once per state.
 */
export function saveDriftCache(projectDir: string, keys: string[]): void {
  const cachePath = path.join(projectDir, DB_DIR, DRIFT_CACHE_FILE);
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ reported: keys }), 'utf-8');
  } catch {
    // best-effort cache; failure must not break the hook
  }
}
