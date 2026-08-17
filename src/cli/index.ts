import { Command } from 'commander';
import { runInit } from './commands/init.js';
import { runStatus } from './commands/status.js';
import { runQuery } from './commands/query.js';
import { runMcp } from './commands/mcp.js';
import { runAnalyze } from './commands/analyze.js';
import { runCheck, parseHookFormat } from './commands/check.js';
import { runUpgrade } from './commands/upgrade.js';
import { runContext } from './commands/context.js';
import { runRules } from './commands/rules.js';
import { runBootstrap } from './commands/bootstrap.js';
import { runRecordsIndex, runRecordsCheck, runRecordsAdd } from './commands/records.js';
import { migrateLegacyLayout } from '../core/db.js';
import { RECORD_KINDS } from '../types/record.js';

// Rename a pre-shanpan .specgraph/ layout before any command reads it. All
// commands operate on cwd, so one call here covers every subcommand.
migrateLegacyLayout(process.cwd());

const program = new Command();

program
  .name('shanpan')
  .description('Agent-native code knowledge graph')
  .version('0.1.0');

program
  .command('init')
  .description('Initialize .shanpan/ in the current project')
  .option('--no-git-hooks', 'Do not install git hooks (checkout/merge rebuild, pre-commit check)')
  .action((opts) => runInit({ gitHooks: opts.gitHooks as boolean }));

program
  .command('query <cypher>')
  .description('Execute a Cypher query against the graph')
  .action((cypher: string) => runQuery(cypher));

program
  .command('status')
  .description('Show graph statistics (nodes, edges)')
  .action(() => runStatus());

program
  .command('mcp')
  .description('Start MCP server (stdio)')
  .option('--project-dir <path>', 'Project root containing .shanpan/ (defaults to cwd)')
  .action((opts) => runMcp({ projectDir: opts.projectDir as string | undefined }));

program
  .command('analyze')
  .description('Scan source files and extract code symbols and call edges')
  .option('--include <dirs...>', 'Directories to scan (overrides config)')
  .option('--exclude <dirs...>', 'Directory names to skip (overrides config)')
  .option('--languages <langs...>', 'Languages to parse: typescript, php, python, sql (overrides config)')
  .option('--watch', 'Keep running and re-analyze on file changes (2s debounce)')
  .option('--full', 'Force a full rebuild, ignoring the incremental state cache')
  .action((opts) =>
    runAnalyze({
      include: opts.include as string[] | undefined,
      exclude: opts.exclude as string[] | undefined,
      languages: opts.languages as string[] | undefined,
      watch: !!opts.watch,
      full: !!opts.full,
    }),
  );

program
  .command('upgrade')
  .description('Re-write agent skill files to the current version')
  .option('--hooks', 'Also update IDE hook settings')
  .option('--no-git-hooks', 'Do not (re)install git hooks')
  .action((opts) => runUpgrade({ hooks: !!opts.hooks, gitHooks: opts.gitHooks as boolean }));

program
  .command('check')
  .description('Check that knowledge records still match the code')
  .option('--staged', 'Check staged git changes for deletions/renames')
  .option('--hook-output', 'Output JSON for use in IDE Stop hooks')
  .option('--format <ide>', 'Hook output dialect: claude | cursor | opencode', 'claude')
  .action((opts) =>
    runCheck({
      staged: !!opts.staged,
      hookOutput: !!opts.hookOutput,
      format: parseHookFormat(opts.format as string),
    }),
  );

program
  .command('context')
  .description('Output knowledge for a file (reads Claude Code PreToolUse hook JSON from stdin)')
  .action(() => runContext());

program
  .command('rules')
  .description('Generate .cursor/rules/*.mdc from knowledge records, scoped by glob')
  .action(() => runRules());

const collect = (val: string, acc: string[]): string[] => {
  acc.push(val);
  return acc;
};

program
  .command('bootstrap')
  .description('Seed knowledge records from an existing codebase (marker comments, git reverts, decision docs)')
  .option('--dry-run', 'Show what would be added without writing')
  .option('--commit-limit <n>', 'How many recent commits to scan for reverts (default 2000)', (v) => parseInt(v, 10))
  .option('--doc <path>', 'Decision-doc file or directory to scan (repeatable). Point at ADRs wherever they live.', collect, [])
  .option('--marker <name>', 'Extra comment marker tag to treat as a gotcha (repeatable)', collect, [])
  .option('--no-adr', 'Skip auto-detection of conventional ADR directories')
  .action((opts) =>
    runBootstrap({
      dryRun: !!opts.dryRun,
      commitLimit: typeof opts.commitLimit === 'number' && !Number.isNaN(opts.commitLimit) ? opts.commitLimit : undefined,
      docs: opts.doc as string[],
      markers: opts.marker as string[],
      adr: opts.adr as boolean, // commander sets this false when --no-adr is passed
    }),
  );

const records = program
  .command('records')
  .description('Work with the knowledge record file (.shanpan/knowledge.ndjson)');

records
  .command('index')
  .description('Parse knowledge.ndjson and rebuild Record nodes in the graph')
  .action(() => runRecordsIndex());

records
  .command('check')
  .description('Validate knowledge.ndjson without touching the graph')
  .action(() => runRecordsCheck());

records
  .command('add')
  .description('Append a knowledge record')
  .requiredOption('--kind <kind>', RECORD_KINDS.join(' | '))
  .requiredOption('--claim <text>', 'The claim itself; for behavior, the scenario name')
  .option('--because <text>', 'Why the claim holds')
  .option('--subject <ids...>', 'Symbol IDs or file paths this record is about')
  .option('--provenance <token>', 'u | a | i | g:<sha> | t:<path> | n:<path>:<line> | d:<path>', 'a')
  .option('--given <text>', 'behavior only: precondition')
  .option('--when <text>', 'behavior only: triggering event')
  .option('--then <text>', 'behavior only: expected outcome')
  .option('--ref <doc>', 'source only: the document to consult (URL or repo-relative path)')
  .option('--supersedes <id>', 'Record id this one replaces')
  .action((opts) =>
    runRecordsAdd({
      kind: opts.kind as string,
      claim: opts.claim as string,
      because: opts.because as string | undefined,
      subjects: opts.subject as string[] | undefined,
      provenance: opts.provenance as string | undefined,
      given: opts.given as string | undefined,
      when: opts.when as string | undefined,
      then: opts.then as string | undefined,
      ref: opts.ref as string | undefined,
      supersedes: opts.supersedes as string | undefined,
    }),
  );

// process.exit() prevents V8 from running GC finalizers in an unspecified
// order after the command completes. Without this, the simultaneous presence
// of multiple native addons (tree-sitter, LadybugDB) causes a segfault on
// macOS because their native destructors execute in the wrong sequence.
//
// Exit with whatever code a command set via process.exitCode — forcing 0 here
// swallows the non-zero exits that `check` (invalid/fabricated records) and a
// rejected `records add` rely on for CI and pre-commit to actually fail.
program
  .parseAsync(process.argv)
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
