import fs from 'node:fs';
import chalk from 'chalk';
import { loadConfig } from '../../core/config.js';
import { knowledgePath } from '../../core/records.js';
import { ensureRef } from '../../core/knowledge-ref.js';

/**
 * Set up the knowledge ref and say what happened.
 *
 * Its own module because both `init` and `upgrade` need it and `upgrade`
 * already imports from `init` — putting it in either would close a cycle.
 *
 * The division of labour: `upgrade` is what repairs a project that is already
 * set up, since `init` declines to touch one, and that is right for its job. A
 * fresh clone has no graph, so `init` runs in full and lands here on the way
 * through.
 */
export function reportEnsureRef(projectDir: string): void {
  const ref = loadConfig(projectDir).knowledge.ref;
  if (ref === null) return;

  const file = knowledgePath(projectDir);
  const seed = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';

  switch (ensureRef(projectDir, ref, seed)) {
    case 'created':
      console.log(chalk.green(`✓ Created knowledge ref ${ref}`));
      break;
    case 'present':
      console.log(chalk.gray(`  Knowledge ref ${ref} already present`));
      break;
    case 'not-a-repo':
      console.log(
        chalk.yellow(`  ⚠ ${ref} is configured but this is not a git repository — using the file only.`),
      );
      break;
    case 'failed':
      console.log(chalk.yellow(`  ⚠ Could not create ${ref} — knowledge stays in the working tree.`));
      break;
    default:
      break;
  }
}
