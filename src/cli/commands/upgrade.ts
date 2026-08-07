import chalk from 'chalk';
import { dbExists } from '../../core/db.js';
import { installIdeHooks, installOpenCodePlugin } from '../../core/ide-hooks.js';
import { installGitHooks } from '../../core/git-hooks.js';
import { writeSkills, promptIdeSelection } from './init.js';

export async function runUpgrade(options: { hooks?: boolean; gitHooks?: boolean }): Promise<void> {
  const projectDir = process.cwd();

  if (!dbExists(projectDir)) {
    console.error(chalk.red('No Shanpan database found. Run `shanpan init` first.'));
    process.exit(1);
  }

  const skillDirs = writeSkills(projectDir);

  console.log('');
  for (const dir of skillDirs) {
    console.log(chalk.green(`✓ Updated agent skills in ${dir}/`));
  }

  if (options.gitHooks !== false) {
    const gitHooks = installGitHooks(projectDir);
    if (gitHooks !== null) {
      console.log(chalk.green(`✓ Updated git hooks (${gitHooks.join(', ')})`));
    }
  }

  if (options.hooks) {
    const selectedIdes = await promptIdeSelection(projectDir);
    for (const ide of selectedIdes) {
      installIdeHooks(projectDir, ide);
      if (ide.id === 'opencode') installOpenCodePlugin(projectDir);
      console.log(chalk.green(`✓ Updated agent hooks in ${ide.settingsPath}`));
      if (ide.id === 'opencode') {
        console.log(chalk.green('✓ Updated OpenCode drift plugin in .opencode/plugin/shanpan-drift.ts'));
      }
    }
    if (selectedIdes.length === 0) {
      console.log(chalk.gray('  Skipped agent hooks.'));
    }
  } else {
    console.log(chalk.gray('  Run with --hooks to also update IDE hook settings.'));
  }

  console.log('');
}
