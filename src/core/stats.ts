import type { Connection } from '@ladybugdb/core';
import { queryAll } from './db.js';

export interface GraphStats {
  symbols: number;
  files: number;
  records: number;
  liveRecords: number;
  edges: Record<string, number>;
}

export async function getGraphStats(conn: Connection): Promise<GraphStats> {
  const countNode = async (label: string): Promise<number> => {
    try {
      const { rows } = await queryAll(conn, `MATCH (n:${label}) RETURN count(n) AS cnt`);
      return Number(rows[0]?.['cnt'] ?? 0);
    } catch {
      return 0;
    }
  };

  const countRel = async (type: string): Promise<number> => {
    try {
      const { rows } = await queryAll(conn, `MATCH ()-[r:${type}]->() RETURN count(r) AS cnt`);
      return Number(rows[0]?.['cnt'] ?? 0);
    } catch {
      return 0;
    }
  };

  const liveRecords = async (): Promise<number> => {
    try {
      const { rows } = await queryAll(
        conn,
        'MATCH (r:Record) WHERE r.live RETURN count(r) AS cnt',
      );
      return Number(rows[0]?.['cnt'] ?? 0);
    } catch {
      return 0;
    }
  };

  const [symbols, files, records, live] = await Promise.all([
    countNode('CodeSymbol'),
    countNode('File'),
    countNode('Record'),
    liveRecords(),
  ]);

  const [contains, calls, about, supersedes] = await Promise.all([
    countRel('CONTAINS'),
    countRel('CALLS'),
    countRel('ABOUT'),
    countRel('SUPERSEDES'),
  ]);

  return {
    symbols,
    files,
    records,
    liveRecords: live,
    edges: {
      CONTAINS: contains,
      CALLS: calls,
      ABOUT: about,
      SUPERSEDES: supersedes,
    },
  };
}
