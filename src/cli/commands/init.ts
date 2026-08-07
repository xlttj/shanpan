import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { openDatabase, closeDatabase, ensureSchema, getDbPath, DB_DIR } from '../../core/db.js';
import { saveConfig, RC_FILE } from '../../core/config.js';
import { DEFAULT_CONFIG } from '../../types/config.js';
import { SKILLS } from '../../skills/index.js';
import { IDE_INTEGRATIONS, installIdeHooks, installOpenCodePlugin, type IdeIntegration } from '../../core/ide-hooks.js';
import { installGitHooks } from '../../core/git-hooks.js';

const SKILL_CLIENT_DIRS = ['.claude', '.cursor', '.opencode'] as const;

// Appended to every generated SKILL.md. Lets a later run recognise which skill
// directories shanpan itself owns, so it can prune ones it no longer ships
// without ever touching a skill the user wrote by hand.
const OWNERSHIP_MARKER = '<!-- shanpan-managed-skill -->';

/** Delete shanpan-owned skill directories that are no longer in SKILLS. */
function pruneStaleSkills(skillsBase: string, current: Set<string>): void {
  if (!fs.existsSync(skillsBase)) return;
  for (const entry of fs.readdirSync(skillsBase, { withFileTypes: true })) {
    if (!entry.isDirectory() || current.has(entry.name)) continue;
    const skillFile = path.join(skillsBase, entry.name, 'SKILL.md');
    let owned = false;
    try {
      owned = fs.readFileSync(skillFile, 'utf-8').includes(OWNERSHIP_MARKER);
    } catch {
      // No readable SKILL.md — not ours, leave it alone.
    }
    if (owned) fs.rmSync(path.join(skillsBase, entry.name), { recursive: true, force: true });
  }
}

export function writeSkills(projectDir: string): string[] {
  const written: string[] = [];
  const currentNames = new Set(SKILLS.map((s) => s.name));
  for (const clientDir of SKILL_CLIENT_DIRS) {
    const clientPath = path.join(projectDir, clientDir);
    const hasOpencodeJson =
      clientDir === '.opencode' && fs.existsSync(path.join(projectDir, 'opencode.json'));
    if (clientDir !== '.claude' && !fs.existsSync(clientPath) && !hasOpencodeJson) continue;
    const skillsBase = path.join(clientPath, 'skills');
    pruneStaleSkills(skillsBase, currentNames);
    for (const skill of SKILLS) {
      const skillDir = path.join(skillsBase, skill.name);
      fs.mkdirSync(skillDir, { recursive: true });
      const content = `${skill.content.trimEnd()}\n\n${OWNERSHIP_MARKER}\n`;
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf-8');
    }
    written.push(path.join(clientDir, 'skills'));
  }
  return written;
}

function detectIdes(projectDir: string): IdeIntegration[] {
  return IDE_INTEGRATIONS.filter((ide) => {
    if (fs.existsSync(path.join(projectDir, ide.settingsPath))) return true;
    const probe = ide.detectionPath ?? path.dirname(ide.settingsPath);
    return fs.existsSync(path.join(projectDir, probe));
  });
}

function buildMenuOptions(detected: IdeIntegration[]): string {
  return IDE_INTEGRATIONS.map((ide, i) => {
    const hint = detected.some((d) => d.id === ide.id) ? chalk.gray('[detected]') : '';
    return `  ${i + 1}) ${ide.label} ${hint}`.trimEnd();
  }).join('\n') + `\n  ${IDE_INTEGRATIONS.length + 1}) All\n  ${IDE_INTEGRATIONS.length + 2}) Skip`;
}

export async function promptIdeSelection(projectDir: string): Promise<IdeIntegration[]> {
  if (!process.stdin.isTTY) {
    const detected = detectIdes(projectDir);
    return detected.length > 0 ? detected : [IDE_INTEGRATIONS[0]!];
  }

  const detected = detectIdes(projectDir);
  const defaultChoice = detected.length >= 2 ? IDE_INTEGRATIONS.length + 1
    : detected.length === 1 ? IDE_INTEGRATIONS.indexOf(detected[0]!) + 1
    : 1;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    console.log('');
    console.log(chalk.gray('Which AI coding tool does this project use?'));
    console.log(buildMenuOptions(detected));
    rl.question(chalk.gray(`Choice [${defaultChoice}]: `), (answer) => {
      rl.close();
      const n = answer.trim() === '' ? defaultChoice : parseInt(answer.trim(), 10);
      if (n >= 1 && n <= IDE_INTEGRATIONS.length) {
        resolve([IDE_INTEGRATIONS[n - 1]!]);
      } else if (n === IDE_INTEGRATIONS.length + 1) {
        resolve([...IDE_INTEGRATIONS]);
      } else {
        resolve([]);
      }
    });
  });
}

export async function runInit(options: { gitHooks?: boolean } = {}): Promise<void> {
  const projectDir = process.cwd();
  const dbPath = getDbPath(projectDir);

  if (fs.existsSync(dbPath)) {
    console.log(chalk.yellow(`Graph database already exists at ${DB_DIR}/`));
    console.log(chalk.gray('Run `shanpan status` to inspect the current state.'));
    return;
  }


  console.log(chalk.cyan('Initializing Shanpan…'));

  const { db, conn } = await openDatabase(projectDir);
  await ensureSchema(conn);
  await closeDatabase(db, conn);

  const rcPath = path.join(projectDir, RC_FILE);
  const rcExists = fs.existsSync(rcPath);
  if (!rcExists) {
    const config = structuredClone(DEFAULT_CONFIG);
    saveConfig(projectDir, config);
  }

  const selectedIdes = await promptIdeSelection(projectDir);
  const skillDirs = writeSkills(projectDir);

  console.log('');
  console.log(chalk.green(`✓ Created ${DB_DIR}/ with empty graph database`));
  if (rcExists) {
    console.log(chalk.gray(`  Using existing ${RC_FILE}`));
  } else {
    console.log(chalk.green(`✓ Created ${RC_FILE} with default settings`));
  }
  for (const dir of skillDirs) {
    console.log(chalk.green(`✓ Wrote agent skills to ${dir}/`));
  }

  for (const ide of selectedIdes) {
    installIdeHooks(projectDir, ide);
    if (ide.id === 'opencode') installOpenCodePlugin(projectDir);
    console.log(chalk.green(`✓ Wrote agent hooks to ${ide.settingsPath}`));
    if (ide.id === 'opencode') {
      console.log(chalk.green('✓ Wrote OpenCode drift plugin to .opencode/plugin/shanpan-drift.ts'));
    }
  }
  if (selectedIdes.length === 0) {
    console.log(chalk.gray('  Skipped agent hooks. To add later, configure your IDE settings manually.'));
  }

  if (options.gitHooks !== false) {
    const hooks = installGitHooks(projectDir);
    if (hooks === null) {
      console.log(chalk.gray('  Not a git repository — skipped git hooks.'));
    } else {
      console.log(
        chalk.green(`✓ Installed git hooks (${hooks.join(', ')})`) +
          chalk.gray(' — rebuilds the graph on checkout/merge, checks integrity pre-commit'),
      );
    }
  }

  console.log('');
  console.log(chalk.gray('Next steps:'));
  console.log(chalk.gray('  1. Run `shanpan analyze` to index code symbols'));
  console.log(chalk.gray('  2. Run `shanpan bootstrap` to seed records from history (optional)'));
  console.log(chalk.gray('  3. Run `shanpan status` to inspect the graph'));
  console.log('');
  console.log(chalk.gray('To start the MCP server: shanpan mcp --project-dir <path>'));
}
