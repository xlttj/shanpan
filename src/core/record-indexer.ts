import type { Connection } from '@ladybugdb/core';
import type { KnowledgeRecord } from '../types/record.js';
import { queryAll } from './db.js';
import { liveIds, tsToSql } from './records.js';

function esc(value: string | null | undefined): string {
  if (value == null) return 'NULL';
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function escTs(ts: string): string {
  const sql = tsToSql(ts);
  return sql === null ? 'NULL' : `timestamp('${sql}')`;
}

/** Leading token of a provenance string: 'u' | 'a' | 'i' | 'g' | 't' | 'n' | 'd'. */
export function provenanceKind(pv: string): string {
  const colon = pv.indexOf(':');
  return colon === -1 ? pv : pv.slice(0, colon);
}

export interface RecordIndexStats {
  records: number;
  live: number;
  about: number;
  supersedes: number;
  /** Subjects that matched no CodeSymbol and no File — record-level drift. */
  unresolved: { recordId: string; subject: string }[];
}

async function run(conn: Connection, cypher: string): Promise<void> {
  const result = await conn.query(cypher);
  if (!Array.isArray(result)) result.close();
}

/**
 * Index knowledge records into an existing graph.
 *
 * Assumes the schema is present and code symbols have already been analysed —
 * ABOUT edges are only created against nodes that genuinely exist, so a
 * subject pointing at a symbol that has since been renamed or deleted shows
 * up in `unresolved` instead of silently materialising a stub node.
 */
export async function indexRecords(
  conn: Connection,
  records: readonly KnowledgeRecord[],
): Promise<RecordIndexStats> {
  const stats: RecordIndexStats = {
    records: 0,
    live: 0,
    about: 0,
    supersedes: 0,
    unresolved: [],
  };

  const { rows: symbolRows } = await queryAll(conn, 'MATCH (c:CodeSymbol) RETURN c.id AS id');
  const knownSymbols = new Set(symbolRows.map((r) => String(r['id'])));
  const { rows: fileRows } = await queryAll(conn, 'MATCH (f:File) RETURN f.id AS id');
  const knownFiles = new Set(fileRows.map((r) => String(r['id'])));

  const live = liveIds(records);
  const presentIds = new Set(records.map((r) => r.id));

  for (const r of records) {
    const isLive = live.has(r.id);
    await run(
      conn,
      `CREATE (:Record {
        id: ${esc(r.id)},
        kind: ${esc(r.kn)},
        claim: ${esc(r.cl)},
        because: ${esc(r.bc ?? null)},
        given: ${esc(r.gv ?? null)},
        when_: ${esc(r.wn ?? null)},
        then_: ${esc(r.tn ?? null)},
        provenance: ${esc(r.pv)},
        provenance_kind: ${esc(provenanceKind(r.pv))},
        ts: ${escTs(r.ts)},
        live: ${isLive}
      })`,
    );
    stats.records++;
    if (isLive) stats.live++;
  }

  for (const r of records) {
    for (const subject of r.sb ?? []) {
      const label = knownSymbols.has(subject)
        ? 'CodeSymbol'
        : knownFiles.has(subject)
          ? 'File'
          : null;
      if (label === null) {
        stats.unresolved.push({ recordId: r.id, subject });
        continue;
      }
      await run(
        conn,
        `MATCH (r:Record {id: ${esc(r.id)}}), (t:${label} {id: ${esc(subject)}})
         CREATE (r)-[:ABOUT]->(t)`,
      );
      stats.about++;
    }
  }

  for (const r of records) {
    if (!r.ss) continue;
    // A dangling `ss` is legal on disk — the superseded record may have been
    // compacted into the archive. Only edge it when both ends are loaded.
    if (!presentIds.has(r.ss)) continue;
    await run(
      conn,
      `MATCH (a:Record {id: ${esc(r.id)}}), (b:Record {id: ${esc(r.ss)}})
       CREATE (a)-[:SUPERSEDES]->(b)`,
    );
    stats.supersedes++;
  }

  return stats;
}
