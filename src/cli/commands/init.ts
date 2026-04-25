import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { openDatabase, closeDatabase, ensureSchema, getDbPath, DB_DIR } from '../../core/db.js';
import { saveConfig } from '../../core/config.js';
import { DEFAULT_CONFIG } from '../../types/config.js';
import { SKILLS } from '../../skills/index.js';
import { IDE_INTEGRATIONS, installIdeHooks, type IdeIntegration } from '../../core/ide-hooks.js';

const SKILL_CLIENT_DIRS = ['.claude', '.cursor'] as const;

function writeSkills(projectDir: string): string[] {
  const written: string[] = [];
  for (const clientDir of SKILL_CLIENT_DIRS) {
    const clientPath = path.join(projectDir, clientDir);
    // Always write to .claude/; only write to others if the client dir already exists
    if (clientDir !== '.claude' && !fs.existsSync(clientPath)) continue;
    const skillsBase = path.join(clientPath, 'skills');
    for (const skill of SKILLS) {
      const skillDir = path.join(skillsBase, skill.name);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skill.content, 'utf-8');
    }
    written.push(path.join(clientDir, 'skills'));
  }
  return written;
}

function detectIdes(projectDir: string): IdeIntegration[] {
  return IDE_INTEGRATIONS.filter((ide) => {
    const dir = path.join(projectDir, path.dirname(ide.settingsPath));
    return fs.existsSync(dir);
  });
}

function buildMenuOptions(detected: IdeIntegration[]): string {
  return IDE_INTEGRATIONS.map((ide, i) => {
    const hint = detected.some((d) => d.id === ide.id) ? chalk.gray('[detected]') : '';
    return `  ${i + 1}) ${ide.label} ${hint}`.trimEnd();
  }).join('\n') + `\n  ${IDE_INTEGRATIONS.length + 1}) Both\n  ${IDE_INTEGRATIONS.length + 2}) Skip`;
}

async function promptIdeSelection(projectDir: string): Promise<IdeIntegration[]> {
  if (!process.stdin.isTTY) {
    // Non-interactive: default to Claude Code
    return [IDE_INTEGRATIONS[0]!];
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

export async function runInit(options: { specsDir?: string }): Promise<void> {
  const projectDir = process.cwd();
  const dbPath = getDbPath(projectDir);

  if (fs.existsSync(dbPath)) {
    console.log(chalk.yellow(`Graph database already exists at ${DB_DIR}/`));
    console.log(chalk.gray('Run `specgraph status` to inspect the current state.'));
    return;
  }

  const specsDir = path.resolve(projectDir, options.specsDir ?? 'specs');
  if (!fs.existsSync(specsDir)) {
    fs.mkdirSync(specsDir, { recursive: true });
    console.log(chalk.gray(`Created specs directory: ${path.relative(projectDir, specsDir)}/`));
  }

  console.log(chalk.cyan('Initializing SpecGraph…'));

  const { db, conn } = await openDatabase(projectDir);
  await ensureSchema(conn);
  await closeDatabase(db, conn);

  const config = structuredClone(DEFAULT_CONFIG);
  config.specsDir = path.relative(projectDir, specsDir);
  saveConfig(projectDir, config);

  const selectedIdes = await promptIdeSelection(projectDir);
  const skillDirs = writeSkills(projectDir);

  console.log('');
  console.log(chalk.green(`✓ Created ${DB_DIR}/ with empty graph database`));
  console.log(chalk.green(`✓ Created ${DB_DIR}/config.json with default settings`));
  console.log(chalk.green(`✓ Specs directory ready at ${path.relative(projectDir, specsDir)}/`));
  for (const dir of skillDirs) {
    console.log(chalk.green(`✓ Wrote agent skills to ${dir}/`));
  }

  for (const ide of selectedIdes) {
    installIdeHooks(projectDir, ide);
    console.log(chalk.green(`✓ Wrote agent hooks to ${ide.settingsPath}`));
  }
  if (selectedIdes.length === 0) {
    console.log(chalk.gray('  Skipped agent hooks. To add later, configure your IDE settings manually.'));
  }

  console.log('');
  console.log(chalk.gray('Next steps:'));
  console.log(chalk.gray('  1. Add spec files (*.md) to the specs/ directory'));
  console.log(chalk.gray('  2. Run `specgraph index` to build the graph'));
  console.log(chalk.gray('  3. Run `specgraph analyze` to scan source code'));
  console.log(chalk.gray('  4. Run `specgraph status` to inspect the graph'));
  console.log('');
  console.log(chalk.gray('For git pre-commit drift checks:'));
  console.log(chalk.gray('  echo "specgraph check --staged" >> .git/hooks/pre-commit'));
  console.log(chalk.gray('  chmod +x .git/hooks/pre-commit'));
  console.log('');
  console.log(chalk.gray('To start the MCP server: specgraph mcp --project-dir <path>'));
}
