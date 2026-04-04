import { Command } from 'commander';
import { runInit } from './commands/init.js';
import { runStatus } from './commands/status.js';
import { runIndex } from './commands/index-specs.js';
import { runQuery } from './commands/query.js';
import { runMcp } from './commands/mcp.js';

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

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
