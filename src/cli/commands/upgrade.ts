import chalk from 'chalk';
import { dbExists } from '../../core/db.js';
import { installIdeHooks } from '../../core/ide-hooks.js';
import { writeSkills, promptIdeSelection } from './init.js';

export async function runUpgrade(options: { hooks?: boolean }): Promise<void> {
  const projectDir = process.cwd();

  if (!dbExists(projectDir)) {
    console.error(chalk.red('No SpecGraph database found. Run `specgraph init` first.'));
    process.exit(1);
  }

  const skillDirs = writeSkills(projectDir);

  console.log('');
  for (const dir of skillDirs) {
    console.log(chalk.green(`✓ Updated agent skills in ${dir}/`));
  }

  if (options.hooks) {
    const selectedIdes = await promptIdeSelection(projectDir);
    for (const ide of selectedIdes) {
      installIdeHooks(projectDir, ide);
      console.log(chalk.green(`✓ Updated agent hooks in ${ide.settingsPath}`));
    }
    if (selectedIdes.length === 0) {
      console.log(chalk.gray('  Skipped agent hooks.'));
    }
  } else {
    console.log(chalk.gray('  Run with --hooks to also update IDE hook settings.'));
  }

  console.log('');
}
