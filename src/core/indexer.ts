import type { Connection } from '@ladybugdb/core';
import type { ParsedSpec, IndexStats } from '../types/spec.js';
import { dropAndRecreateSchema, queryAll } from './db.js';

function esc(value: string | null | undefined): string {
  if (value == null) return 'NULL';
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function escDate(value: string | Date | null | undefined): string {
  if (value == null) return 'NULL';
  if (value instanceof Date) {
    const iso = value.toISOString().slice(0, 10);
    return `date('${iso}')`;
  }
  return `date('${value}')`;
}

export async function indexSpecs(
  conn: Connection,
  specs: ParsedSpec[],
): Promise<IndexStats> {
  await dropAndRecreateSchema(conn);

  const stats: IndexStats = {
    specs: 0,
    rules: 0,
    symbols: 0,
    dependsOn: 0,
    derivesFrom: 0,
    defines: 0,
    implements: 0,
  };

  // Insert Spec nodes
  for (const { frontmatter: f, content } of specs) {
    const cypher = `CREATE (:Spec {
      id: ${esc(f.id)},
      title: ${esc(f.title)},
      type: ${esc(f.type)},
      status: ${esc(f.status)},
      priority: ${esc(f.priority)},
      author: ${esc(f.author)},
      created: ${escDate(f.created)},
      description: ${esc(content)}
    })`;
    const result = await conn.query(cypher);
    if (!Array.isArray(result)) result.close();
    stats.specs++;
  }

  // Insert BusinessRule stub nodes from defines_rules
  const ruleIds = new Set<string>();
  for (const { frontmatter: f } of specs) {
    for (const ruleId of f.defines_rules ?? []) {
      if (!ruleIds.has(ruleId)) {
        ruleIds.add(ruleId);
        const cypher = `CREATE (:BusinessRule {
          id: ${esc(ruleId)},
          title: ${esc(ruleId)},
          type: 'business_rule',
          status: 'draft',
          description: NULL
        })`;
        const result = await conn.query(cypher);
        if (!Array.isArray(result)) result.close();
        stats.rules++;
      }
    }
  }

  // Insert CodeSymbol nodes from implements
  const symbolIds = new Set<string>();
  for (const { frontmatter: f } of specs) {
    for (const impl of f.implements ?? []) {
      const symbolId = impl.symbol;
      if (!symbolIds.has(symbolId)) {
        symbolIds.add(symbolId);
        const parts = symbolId.split('::');
        const filePath = parts[0] ?? symbolId;
        const fqn = parts[1] ?? symbolId;
        const cypher = `CREATE (:CodeSymbol {
          id: ${esc(symbolId)},
          fqn: ${esc(fqn)},
          symbol_type: ${esc(impl.type)},
          file_path: ${esc(filePath)},
          line_start: 0,
          line_end: 0
        })`;
        const result = await conn.query(cypher);
        if (!Array.isArray(result)) result.close();
        stats.symbols++;
      }
    }
  }

  // Insert DEPENDS_ON edges
  for (const { frontmatter: f } of specs) {
    for (const depId of f.depends_on ?? []) {
      const cypher = `MATCH (a:Spec {id: ${esc(f.id)}}), (b:Spec {id: ${esc(depId)}})
        CREATE (a)-[:DEPENDS_ON]->(b)`;
      const result = await conn.query(cypher);
      if (!Array.isArray(result)) result.close();
      stats.dependsOn++;
    }
  }

  // Insert DERIVES_FROM edges
  for (const { frontmatter: f } of specs) {
    for (const srcId of f.derives_from ?? []) {
      const cypher = `MATCH (a:Spec {id: ${esc(f.id)}}), (b:Spec {id: ${esc(srcId)}})
        CREATE (a)-[:DERIVES_FROM]->(b)`;
      const result = await conn.query(cypher);
      if (!Array.isArray(result)) result.close();
      stats.derivesFrom++;
    }
  }

  // Insert DEFINES edges (Spec -> BusinessRule)
  for (const { frontmatter: f } of specs) {
    for (const ruleId of f.defines_rules ?? []) {
      const cypher = `MATCH (s:Spec {id: ${esc(f.id)}}), (r:BusinessRule {id: ${esc(ruleId)}})
        CREATE (s)-[:DEFINES]->(r)`;
      const result = await conn.query(cypher);
      if (!Array.isArray(result)) result.close();
      stats.defines++;
    }
  }

  // Insert IMPLEMENTS edges (CodeSymbol -> Spec | BusinessRule)
  for (const { frontmatter: f } of specs) {
    for (const impl of f.implements ?? []) {
      const symbolId = impl.symbol;
      const cypher = `MATCH (c:CodeSymbol {id: ${esc(symbolId)}}), (s:Spec {id: ${esc(f.id)}})
        CREATE (c)-[:IMPLEMENTS {confidence: 1.0}]->(s)`;
      const result = await conn.query(cypher);
      if (!Array.isArray(result)) result.close();
      stats.implements++;
    }
  }

  return stats;
}

export async function getGraphStats(conn: Connection): Promise<{
  specs: number;
  rules: number;
  symbols: number;
  edges: Record<string, number>;
}> {
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
      const { rows } = await queryAll(
        conn,
        `MATCH ()-[r:${type}]->() RETURN count(r) AS cnt`,
      );
      return Number(rows[0]?.['cnt'] ?? 0);
    } catch {
      return 0;
    }
  };

  const [specs, rules, symbols] = await Promise.all([
    countNode('Spec'),
    countNode('BusinessRule'),
    countNode('CodeSymbol'),
  ]);

  const [dependsOn, derivesFrom, defines, constrains, implements_, calls] = await Promise.all([
    countRel('DEPENDS_ON'),
    countRel('DERIVES_FROM'),
    countRel('DEFINES'),
    countRel('CONSTRAINS'),
    countRel('IMPLEMENTS'),
    countRel('CALLS'),
  ]);

  return {
    specs,
    rules,
    symbols,
    edges: {
      DEPENDS_ON: dependsOn,
      DERIVES_FROM: derivesFrom,
      DEFINES: defines,
      CONSTRAINS: constrains,
      IMPLEMENTS: implements_,
      CALLS: calls,
    },
  };
}
