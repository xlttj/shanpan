import path from 'node:path';
import chalk from 'chalk';
import { openDatabase, closeDatabase, ensureSchema } from '../../core/db.js';
import { indexRecords } from '../../core/record-indexer.js';
import {
  readRecords,
  appendRecords,
  formatTs,
  nextId,
  validateRecord,
  missingProvenanceRefs,
  knowledgePath,
} from '../../core/records.js';
import type { KnowledgeRecord, RecordKind } from '../../types/record.js';
import { RECORD_KINDS } from '../../types/record.js';

function reportParseErrors(errors: { line: number; id: string | null; message: string }[]): void {
  for (const e of errors) {
    const where = e.id ? `line ${e.line} (${e.id})` : `line ${e.line}`;
    console.error(chalk.red(`  ✗ ${where}: ${e.message}`));
  }
}

/** Validate the knowledge file without touching the graph. */
export async function runRecordsCheck(): Promise<void> {
  const projectDir = process.cwd();
  const { records, errors } = readRecords(projectDir);

  if (errors.length > 0) {
    console.error(chalk.red(`${errors.length} invalid record(s) in ${path.relative(projectDir, knowledgePath(projectDir))}:`));
    reportParseErrors(errors);
    process.exitCode = 1;
    return;
  }
  console.log(chalk.green(`✓ ${records.length} record(s) valid`));
}

/** Parse the knowledge file and (re)build Record nodes in the graph. */
export async function runRecordsIndex(): Promise<void> {
  const projectDir = process.cwd();
  const { records, errors } = readRecords(projectDir);

  if (errors.length > 0) {
    console.error(chalk.red(`Refusing to index — ${errors.length} invalid record(s):`));
    reportParseErrors(errors);
    process.exitCode = 1;
    return;
  }

  const { db, conn } = await openDatabase(projectDir);
  try {
    await ensureSchema(conn);
    // Records are rebuilt wholesale; the file on disk is the source of truth.
    const cleared = await conn.query('MATCH (r:Record) DETACH DELETE r');
    if (!Array.isArray(cleared)) cleared.close();

    const stats = await indexRecords(conn, records, projectDir);
    console.log(
      chalk.green(
        `✓ Indexed ${stats.records} record(s): ${stats.live} live, ` +
          `${stats.about} subject link(s), ${stats.supersedes} supersede edge(s)`,
      ),
    );
    if (stats.unresolved.length > 0) {
      console.log(
        chalk.yellow(`\n${stats.unresolved.length} unresolved subject(s) — run 'shanpan analyze' first, or the symbol moved:`),
      );
      for (const u of stats.unresolved) {
        console.log(chalk.yellow(`  ⚠ ${u.recordId} → ${u.subject}`));
      }
    }
  } finally {
    await closeDatabase(db, conn);
  }
}

export interface RecordsAddOptions {
  kind: string;
  claim: string;
  because?: string;
  subjects?: string[];
  provenance?: string;
  given?: string;
  when?: string;
  then?: string;
  ref?: string;
  supersedes?: string;
}

/**
 * Append one record, assigning a fresh id and timestamp. Agents can append to
 * the file directly, but going through here gets id-collision avoidance and
 * validation before anything touches disk.
 */
export async function runRecordsAdd(opts: RecordsAddOptions): Promise<void> {
  const projectDir = process.cwd();
  const { records, errors } = readRecords(projectDir);
  if (errors.length > 0) {
    console.error(chalk.red('Refusing to append — existing knowledge file has errors:'));
    reportParseErrors(errors);
    process.exitCode = 1;
    return;
  }

  if (!(RECORD_KINDS as readonly string[]).includes(opts.kind)) {
    console.error(chalk.red(`Invalid kind '${opts.kind}'. Expected one of: ${RECORD_KINDS.join(', ')}`));
    process.exitCode = 1;
    return;
  }

  const taken = new Set(records.map((r) => r.id));
  const rec: KnowledgeRecord = {
    id: nextId(taken),
    kn: opts.kind as RecordKind,
    cl: opts.claim,
    pv: opts.provenance ?? 'a',
    ts: formatTs(new Date()),
  };
  if (opts.subjects && opts.subjects.length > 0) rec.sb = opts.subjects;
  if (opts.because) rec.bc = opts.because;
  if (opts.given) rec.gv = opts.given;
  if (opts.when) rec.wn = opts.when;
  if (opts.then) rec.tn = opts.then;
  if (opts.ref) rec.rf = opts.ref;
  if (opts.supersedes) rec.ss = opts.supersedes;

  const problems = validateRecord(rec, 0);
  if (problems.length > 0) {
    console.error(chalk.red('Record is not valid:'));
    for (const p of problems) console.error(chalk.red(`  ✗ ${p.message}`));
    process.exitCode = 1;
    return;
  }

  if (opts.supersedes && !taken.has(opts.supersedes)) {
    console.error(chalk.red(`Cannot supersede '${opts.supersedes}' — no such record.`));
    process.exitCode = 1;
    return;
  }

  const missing = missingProvenanceRefs(rec, projectDir);
  if (missing.length > 0) {
    console.error(chalk.red(`Provenance cites a file that does not exist: ${missing.join(', ')}`));
    console.error(
      chalk.gray(
        "  A d:/t:/n: pointer must name a real file you read. If the claim is your own inference, use provenance 'i'.",
      ),
    );
    process.exitCode = 1;
    return;
  }

  appendRecords(projectDir, [rec]);
  console.log(chalk.green(`✓ ${rec.id}  ${rec.kn}  ${rec.cl}`));
}
