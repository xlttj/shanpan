import fs from 'node:fs';
import path from 'node:path';
import type { Connection } from '@ladybugdb/core';
import { queryAll, DB_DIR } from './db.js';
import { readRecords, liveIds } from './records.js';
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
  }

  return { unresolved, invalidRecords: errors, missingRefs };
}

const DRIFT_CACHE_FILE = 'last-drift-report.json';

interface DriftCache {
  reported: string[];
}

export function driftKey(entry: RecordDriftEntry): string {
  return `${entry.recordId} ${entry.subject}`;
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

/** Persist the current drift set so the next hook call can diff against it. */
export function saveDriftCache(projectDir: string, drift: RecordDriftEntry[]): void {
  const cachePath = path.join(projectDir, DB_DIR, DRIFT_CACHE_FILE);
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ reported: drift.map(driftKey) }), 'utf-8');
  } catch {
    // best-effort cache; failure must not break the hook
  }
}
