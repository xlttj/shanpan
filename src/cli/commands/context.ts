import path from 'node:path';
import { openDatabase, closeDatabase, dbExists, queryAll, escId } from '../../core/db.js';
import { loadConfig } from '../../core/config.js';

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

  const config = loadConfig(projectDir);
  const relPaths = absPaths
    .map((p) => path.relative(projectDir, p))
    .filter((rel) => !rel.startsWith(config.specsDir) && !rel.startsWith('..'));

  if (relPaths.length === 0) {
    process.stdout.write(allowResponse());
    return;
  }

  const { db, conn } = await openDatabase(projectDir, true);
  try {
    const allSpecs: Array<{ specId: string; type: string; status: string }> = [];

    for (const relPath of relPaths) {
      const { rows: symbolRows } = await queryAll(
        conn,
        `MATCH (c:CodeSymbol {file_path: '${escId(relPath)}'})-[:IMPLEMENTS]->(s:Spec)
         RETURN DISTINCT s.id AS specId, s.type AS type, s.status AS status`,
      );
      const { rows: fileRows } = await queryAll(
        conn,
        `MATCH (f:File {id: '${escId(relPath)}'})-[:IMPLEMENTS]->(s:Spec)
         RETURN s.id AS specId, s.type AS type, s.status AS status`,
      );
      for (const r of [...symbolRows, ...fileRows]) {
        allSpecs.push({
          specId: String(r['specId']),
          type: String(r['type']),
          status: String(r['status']),
        });
      }
    }

    const unique = [...new Map(allSpecs.map((s) => [s.specId, s])).values()];

    if (unique.length === 0) {
      process.stdout.write(allowResponse());
      return;
    }

    const fileList = relPaths.length === 1 ? relPaths[0] : `${relPaths.length} files`;
    const specLines = unique
      .map((s) => `  • ${s.specId} [${s.type}]`)
      .join('\n');

    const additionalContext = [
      `[specgraph] Specs covering ${fileList} — review before editing:`,
      specLines,
      '',
      'Read the full spec if needed: get_spec("<specId>")',
      'If your edit would violate an acceptance criterion or break a business rule, surface the conflict before proceeding.',
    ].join('\n');

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
