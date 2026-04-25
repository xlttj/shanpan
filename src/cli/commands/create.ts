import chalk from 'chalk';
import path from 'node:path';
import { openDatabase, closeDatabase, dbExists, queryAll } from '../../core/db.js';
import { loadConfig } from '../../core/config.js';
import { createSpec, ALLOWED_SPEC_TYPES } from '../../core/spec-writer.js';

export async function runCreate(options: {
  title: string;
  type: string;
  dir?: string;
  symbols?: string[];
  refs?: string[];
}): Promise<void> {
  const projectDir = process.cwd();
  const config = loadConfig(projectDir);
  const specsDir = path.resolve(projectDir, config.specsDir);

  if (!ALLOWED_SPEC_TYPES.includes(options.type as (typeof ALLOWED_SPEC_TYPES)[number])) {
    console.error(
      chalk.red(
        `Invalid spec type "${options.type}". Must be one of: ${ALLOWED_SPEC_TYPES.join(', ')}`,
      ),
    );
    process.exit(1);
  }

  if (options.symbols && options.symbols.length > 0 && dbExists(projectDir)) {
    const { db, conn } = await openDatabase(projectDir, true);
    try {
      for (const symbolId of options.symbols) {
        const { rows } = await queryAll(
          conn,
          `MATCH (c:CodeSymbol {id: '${symbolId.replace(/'/g, "\\'")}'}) RETURN c.id AS id`,
        );
        if (rows.length === 0) {
          console.warn(
            chalk.yellow(`  ⚠ Symbol not found in graph (DB may be stale): ${symbolId}`),
          );
        }
      }
    } finally {
      await closeDatabase(db, conn);
    }
  }

  try {
    const { filePath } = createSpec({
      title: options.title,
      type: options.type,
      dir: options.dir,
      symbols: options.symbols,
      refs: options.refs,
      specsDir,
    });

    console.log(chalk.green(`✓ Created ${path.relative(projectDir, filePath)}`));
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}
