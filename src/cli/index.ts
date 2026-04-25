import { Command } from 'commander';
import { runInit } from './commands/init.js';
import { runStatus } from './commands/status.js';
import { runIndex } from './commands/index-specs.js';
import { runQuery } from './commands/query.js';
import { runMcp } from './commands/mcp.js';
import { runAnalyze } from './commands/analyze.js';
import { runCreate } from './commands/create.js';
import { runUpdate } from './commands/update.js';
import { runCheck } from './commands/check.js';

const program = new Command();

program
  .name('specgraph')
  .description('Spec & business-rule knowledge graph for AI agents')
  .version('0.1.0');

program
  .command('init')
  .description('Initialize .specgraph/ in the current project')
  .option('--specs-dir <path>', 'Path to spec files directory', 'specs')
  .action((opts) => runInit({ specsDir: opts.specsDir }));

program
  .command('index')
  .description('Parse spec files and build the graph')
  .option('--specs-dir <path>', 'Path to spec files directory', 'specs')
  .action((opts) => runIndex({ specsDir: opts.specsDir }));

program
  .command('query <cypher>')
  .description('Execute a Cypher query against the graph')
  .action((cypher: string) => runQuery(cypher));

program
  .command('status')
  .description('Show graph statistics (nodes, edges, last indexed)')
  .action(() => runStatus());

program
  .command('mcp')
  .description('Start MCP server (stdio)')
  .option('--project-dir <path>', 'Project root containing .specgraph/ (defaults to cwd)')
  .action((opts) => runMcp({ projectDir: opts.projectDir as string | undefined }));

program
  .command('analyze')
  .description('Scan source files, extract code symbols, and link to specs')
  .option('--include <dirs...>', 'Directories to scan (overrides config)')
  .option('--exclude <dirs...>', 'Directory names to skip (overrides config)')
  .option('--languages <langs...>', 'Languages to parse: typescript, php (overrides config)')
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
  .command('create')
  .description('Create a new spec file')
  .requiredOption('--title <title>', 'Human-readable title')
  .requiredOption('--type <type>', 'intent | business_rule | software_requirement | project_spec')
  .option('--dir <dir>', 'Subdirectory under specsDir, e.g. core, cli')
  .option('--symbol <ids...>', 'Symbol IDs to link via implements')
  .option('--ref <urls...>', 'External URLs to attach as refs (http/https)')
  .action((opts) =>
    runCreate({
      title: opts.title as string,
      type: opts.type as string,
      dir: opts.dir as string | undefined,
      symbols: opts.symbol as string[] | undefined,
      refs: opts.ref as string[] | undefined,
    }),
  );

program
  .command('update')
  .description('Update an existing spec (add/remove symbol links, change status)')
  .requiredOption('--id <path>', 'Spec path key to update, e.g. core/spec-parser')
  .option('--add-symbol <ids...>', 'Symbol IDs to add to implements')
  .option('--remove-symbol <ids...>', 'Symbol IDs to remove from implements')
  .option('--add-ref <urls...>', 'URLs to add to refs')
  .option('--remove-ref <urls...>', 'URLs to remove from refs')
  .option('--status <status>', 'New status value')
  .action((opts) =>
    runUpdate({
      id: opts.id as string,
      addSymbols: opts.addSymbol as string[] | undefined,
      removeSymbols: opts.removeSymbol as string[] | undefined,
      addRefs: opts.addRef as string[] | undefined,
      removeRefs: opts.removeRef as string[] | undefined,
      status: opts.status as string | undefined,
    }),
  );

program
  .command('check')
  .description('Check for spec drift (use --staged in pre-commit hooks)')
  .option('--staged', 'Check staged git changes for symbol deletions/renames')
  .option('--hook-output', 'Output JSON for use in IDE Stop hooks')
  .action((opts) => runCheck({ staged: !!opts.staged, hookOutput: !!opts.hookOutput }));

// process.exit() prevents V8 from running GC finalizers in an unspecified
// order after the command completes. Without this, the simultaneous presence
// of multiple native addons (tree-sitter, LadybugDB) causes a segfault on
// macOS because their native destructors execute in the wrong sequence.
program
  .parseAsync(process.argv)
  .then(() => process.exit(0))
  .catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
