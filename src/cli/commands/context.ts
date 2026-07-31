import path from 'node:path';
import { openDatabase, closeDatabase, dbExists, queryAll, escId } from '../../core/db.js';

interface HookInput {
  hook_event_name?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    edits?: Array<{ file_path?: string }>;
  };
}

function allowResponse(): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
  });
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.resume();
  });
}

function extractFilePaths(input: HookInput): string[] {
  const paths: string[] = [];
  if (input.tool_input?.file_path) {
    paths.push(input.tool_input.file_path);
  }
  for (const edit of input.tool_input?.edits ?? []) {
    if (edit.file_path) paths.push(edit.file_path);
  }
  return [...new Set(paths)];
}

export interface ContextRecord {
  id: string;
  kind: string;
  claim: string;
  because: string | null;
  provenance: string;
}

/**
 * Order records so the ones that change what an agent is about to do come
 * first: traps and invariants, then things already tried, then background.
 */
const KIND_PRIORITY: Record<string, number> = {
  gotcha: 0,
  constraint: 1,
  rejected: 2,
  decision: 3,
  behavior: 4,
  intent: 5,
  conflict: 6,
};

/** Cap injected records so a well-documented file cannot flood the context. */
export const MAX_INJECTED = 12;

/** Traps and invariants first, background last; ties broken by id for stability. */
export function sortRecords(records: ContextRecord[]): ContextRecord[] {
  return [...records].sort(
    (a, b) =>
      (KIND_PRIORITY[a.kind] ?? 99) - (KIND_PRIORITY[b.kind] ?? 99) ||
      a.id.localeCompare(b.id),
  );
}

async function fetchRecords(
  conn: Awaited<ReturnType<typeof openDatabase>>['conn'],
  relPaths: string[],
): Promise<ContextRecord[]> {
  const byId = new Map<string, ContextRecord>();

  for (const relPath of relPaths) {
    const esc = escId(relPath);
    // DISTINCT matters: a record with several subjects in the same file would
    // otherwise come back once per matching edge.
    const queries = [
      `MATCH (r:Record)-[:ABOUT]->(c:CodeSymbol {file_path: '${esc}'})
       WHERE r.live
       RETURN DISTINCT r.id AS id, r.kind AS kind, r.claim AS claim,
                       r.because AS because, r.provenance AS provenance`,
      `MATCH (r:Record)-[:ABOUT]->(f:File {id: '${esc}'})
       WHERE r.live
       RETURN DISTINCT r.id AS id, r.kind AS kind, r.claim AS claim,
                       r.because AS because, r.provenance AS provenance`,
    ];
    for (const cypher of queries) {
      const { rows } = await queryAll(conn, cypher);
      for (const row of rows) {
        const id = String(row['id']);
        if (byId.has(id)) continue;
        byId.set(id, {
          id,
          kind: String(row['kind']),
          claim: String(row['claim']),
          because: row['because'] == null ? null : String(row['because']),
          provenance: String(row['provenance']),
        });
      }
    }
  }

  return sortRecords([...byId.values()]);
}

export function formatRecords(records: ContextRecord[]): string[] {
  const shown = records.slice(0, MAX_INJECTED);
  const lines = shown.map((r) => {
    const why = r.because ? ` — ${r.because}` : '';
    return `  • [${r.kind}] ${r.claim}${why}  (${r.id}, ${r.provenance})`;
  });
  if (records.length > shown.length) {
    const rest = records.length - shown.length;
    lines.push(`  … ${rest} more record(s) not shown — query them if relevant.`);
  }
  return lines;
}

export async function runContext(): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) {
    process.stdout.write(allowResponse());
    return;
  }

  let input: HookInput;
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    process.stdout.write(allowResponse());
    return;
  }

  const projectDir = input.cwd ?? process.cwd();
  const absPaths = extractFilePaths(input);

  if (absPaths.length === 0 || !dbExists(projectDir)) {
    process.stdout.write(allowResponse());
    return;
  }

  const relPaths = absPaths
    .map((p) => path.relative(projectDir, p))
    .filter((rel) => !rel.startsWith('..'));

  if (relPaths.length === 0) {
    process.stdout.write(allowResponse());
    return;
  }

  const { db, conn } = await openDatabase(projectDir, true);
  try {
    const records = await fetchRecords(conn, relPaths);

    if (records.length === 0) {
      process.stdout.write(allowResponse());
      return;
    }

    const fileList = relPaths.length === 1 ? relPaths[0] : `${relPaths.length} files`;
    const sections: string[] = [];

    // Records carry their claims inline, so the agent needs no follow-up read.
    sections.push(
      `[specgraph] Known about ${fileList} — read before editing:`,
      ...formatRecords(records),
    );

    sections.push(
      '',
      'If your edit would contradict any of the above, surface the conflict before proceeding.',
      'If you learn something durable while editing, record it: specgraph records add --kind <kind> --claim "..." --because "..." --subject <symbolId>',
    );

    const additionalContext = sections.join('\n');

    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext,
          permissionDecision: 'allow',
        },
      }),
    );
  } finally {
    await closeDatabase(db, conn);
  }
}
