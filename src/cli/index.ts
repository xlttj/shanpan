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
  .action(() => runMcp());

program
  .command('analyze')
  .description('Scan source files, extract code symbols, and link to specs')
  .option('--include <dirs...>', 'Directories to scan (overrides config)')
  .option('--exclude <dirs...>', 'Directory names to skip (overrides config)')
  .option('--languages <langs...>', 'Languages to parse: typescript, php (overrides config)')
  .action((opts) =>
    runAnalyze({
      include: opts.include as string[] | undefined,
      exclude: opts.exclude as string[] | undefined,
      languages: opts.languages as string[] | undefined,
    }),
  );

program
  .command('create')
  .description('Create a new spec file')
  .requiredOption('--id <id>', 'Spec ID, e.g. SPEC-042 or RULE-007')
  .requiredOption('--title <title>', 'Human-readable title')
  .requiredOption('--type <type>', 'intent | business_rule | software_requirement')
  .option('--symbol <ids...>', 'Symbol IDs to link via implements')
  .option('--depends-on <ids...>', 'Spec IDs this spec depends on')
  .option('--derives-from <ids...>', 'Spec IDs this spec derives from')
  .action((opts) =>
    runCreate({
      id: opts.id as string,
      title: opts.title as string,
      type: opts.type as string,
      symbols: opts.symbol as string[] | undefined,
      dependsOn: opts.dependsOn as string[] | undefined,
      derivesFrom: opts.derivesFrom as string[] | undefined,
    }),
  );

program
  .command('update')
  .description('Update an existing spec (add/remove symbol links, change status)')
  .requiredOption('--id <id>', 'Spec ID to update')
  .option('--add-symbol <ids...>', 'Symbol IDs to add to implements')
  .option('--remove-symbol <ids...>', 'Symbol IDs to remove from implements')
  .option('--status <status>', 'New status value')
  .action((opts) =>
    runUpdate({
      id: opts.id as string,
      addSymbols: opts.addSymbol as string[] | undefined,
      removeSymbols: opts.removeSymbol as string[] | undefined,
      status: opts.status as string | undefined,
    }),
  );

program
  .command('check')
  .description('Check for spec drift (use --staged in pre-commit hooks)')
  .option('--staged', 'Check staged git changes for symbol deletions/renames')
  .action((opts) => runCheck({ staged: !!opts.staged }));

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
