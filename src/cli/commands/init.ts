import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, closeDatabase, ensureSchema, getDbPath, DB_DIR } from '../../core/db.js';
import { saveConfig } from '../../core/config.js';
import { DEFAULT_CONFIG } from '../../types/config.js';
import { SKILLS } from '../../skills/index.js';

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

  const skillDirs = writeSkills(projectDir);

  console.log(chalk.green(`✓ Created ${DB_DIR}/ with empty graph database`));
  console.log(chalk.green(`✓ Created ${DB_DIR}/config.json with default settings`));
  console.log(chalk.green(`✓ Specs directory ready at ${path.relative(projectDir, specsDir)}/`));
  for (const dir of skillDirs) {
    console.log(chalk.green(`✓ Wrote agent skills to ${dir}/`));
  }
  console.log('');
  console.log(chalk.gray('Next steps:'));
  console.log(chalk.gray('  1. Add spec files (*.md) to the specs/ directory'));
  console.log(chalk.gray('  2. Run `specgraph index` to build the graph'));
  console.log(chalk.gray('  3. Run `specgraph analyze` to scan source code'));
  console.log(chalk.gray('  4. Run `specgraph status` to inspect the graph'));
  console.log('');
  console.log(chalk.gray('To enable the pre-commit hook:'));
  console.log(chalk.gray('  echo "specgraph check --staged" >> .git/hooks/pre-commit'));
  console.log(chalk.gray('  chmod +x .git/hooks/pre-commit'));
  console.log('');
  console.log(chalk.gray('To start the MCP server: specgraph mcp'));
}
