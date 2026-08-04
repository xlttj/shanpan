import path from 'node:path';
import { openDatabase, closeDatabase, dbExists, queryAll, escId } from '../../core/db.js';
import {
  formatRecords,
  sortRecords,
  MAX_INJECTED,
  type ContextRecord,
} from '../../core/record-format.js';
import { ancestorDirs, dirDepth } from '../../core/dir-scope.js';

// Re-exported so the hook's formatting contract stays addressable from here.
export { formatRecords, sortRecords, MAX_INJECTED, type ContextRecord };

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

async function fetchRecords(
  conn: Awaited<ReturnType<typeof openDatabase>>['conn'],
  relPaths: string[],
): Promise<ContextRecord[]> {
  const byId = new Map<string, ContextRecord>();

  const RET = `r.id AS id, r.kind AS kind, r.claim AS claim,
              r.because AS because, r.provenance AS provenance, r.ref AS ref`;

  const take = (row: Record<string, unknown>, over: Partial<ContextRecord> = {}): void => {
    const id = String(row['id']);
    if (byId.has(id)) return; // most-specific match wins — symbol/file queries run first
    byId.set(id, {
      id,
      kind: String(row['kind']),
      claim: String(row['claim']),
      because: row['because'] == null ? null : String(row['because']),
      provenance: String(row['provenance']),
      ref: row['ref'] == null ? null : String(row['ref']),
      ...over,
    });
  };

  for (const relPath of relPaths) {
    const esc = escId(relPath);
    // DISTINCT matters: a record with several subjects in the same file would
    // otherwise come back once per matching edge.
    for (const cypher of [
      `MATCH (r:Record)-[:ABOUT]->(c:CodeSymbol {file_path: '${esc}'})
       WHERE r.live RETURN DISTINCT ${RET}`,
      `MATCH (r:Record)-[:ABOUT]->(f:File {id: '${esc}'})
       WHERE r.live RETURN DISTINCT ${RET}`,
    ]) {
      const { rows } = await queryAll(conn, cypher);
      for (const row of rows) take(row);
    }

    // Directory-anchored records: a record on any ancestor directory applies to
    // this file (recursive subtree). Deeper directories are more specific, so a
    // module-wide rule ranks below the file's own records but is still surfaced.
    const dirs = ancestorDirs(relPath);
    if (dirs.length > 0) {
      const list = dirs.map((d) => `'${escId(d)}'`).join(', ');
      const { rows } = await queryAll(
        conn,
        `MATCH (r:Record)-[:ABOUT]->(d:File)
         WHERE r.live AND d.kind = 'dir' AND d.id IN [${list}]
         RETURN DISTINCT ${RET}, d.id AS anchorDir`,
      );
      for (const row of rows) {
        const anchorDir = String(row['anchorDir']);
        take(row, { anchorDir, scope: 100 - dirDepth(anchorDir) });
      }
    }
  }

  return sortRecords([...byId.values()]);
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
      'Before you finish: if you chose between alternatives, hit a trap, or learned something durable, record it (`specgraph records add` or MCP `add_record` then `reindex`). Decisions left only in code or chat are lost between sessions.',
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
