import chalk from 'chalk';
import { syncKnowledge } from '../../core/knowledge-sync.js';

/**
 * Exchange knowledge with the remote.
 *
 * Quiet mode exists because the git hooks call this on every checkout and
 * merge: a sync that found nothing must say nothing, or the noise trains
 * people to stop reading git's output.
 */
export function runSync(options: { quiet?: boolean } = {}): void {
  const result = syncKnowledge(process.cwd());
  const quiet = options.quiet === true;

  switch (result.status) {
    case 'not-configured':
      if (!quiet) {
        console.log(chalk.gray('No knowledge ref configured — nothing to sync.'));
        console.log(chalk.gray('Set knowledge.ref in .shanpanrc.json, then run `shanpan upgrade`.'));
      }
      return;

    case 'not-a-repo':
      if (!quiet) console.log(chalk.yellow('Not a git repository — knowledge stays in the file.'));
      return;

    // Neither of the next two is gated on quiet: the local side is safe, but
    // this machine's knowledge is reaching nobody, and silence reads as success.
    case 'push-rejected':
      console.log(
        chalk.yellow(
          `Could not push ${result.ref} after ${result.attempts} attempts — the remote kept moving. ` +
            'Everything is committed locally; run `shanpan sync` again.',
        ),
      );
      return;

    case 'push-failed':
      // Quote git rather than naming a cause we did not observe. "No
      // permission" and "no network" look identical from here, and guessing
      // between them sends people to fix the wrong thing.
      console.log(chalk.yellow(`Could not push ${result.ref} — git said:`));
      console.log(chalk.gray(`  ${result.error.split('\n').join('\n  ')}`));
      console.log(chalk.gray('Everything is committed locally; nothing is lost.'));
      return;

    default:
      break;
  }

  if (result.conflicts.length > 0) {
    // Loud regardless of quiet: two different records share an id, and one of
    // them will be missing from the graph until a human picks.
    console.log(
      chalk.yellow(
        `⚠ ${result.conflicts.length} id(s) carry different content locally than on the ref: ` +
          `${result.conflicts.join(', ')}. Run \`shanpan records check\`.`,
      ),
    );
  }

  const quietAndIdle = quiet && result.gained === 0 && !result.pushed;
  if (quietAndIdle) return;

  const parts: string[] = [];
  if (result.gained > 0) parts.push(`${result.gained} record(s) received`);
  if (result.pushed) parts.push('pushed');
  console.log(parts.length > 0 ? chalk.green(`✓ ${parts.join(', ')}`) : chalk.gray('Already up to date.'));
}
