import chalk from 'chalk';
import path from 'node:path';
import { openDatabase, closeDatabase, dbExists, queryAll } from '../../core/db.js';
import { loadConfig } from '../../core/config.js';
import { createSpec, ALLOWED_SPEC_TYPES } from '../../core/spec-writer.js';

export async function runCreate(options: {
  id: string;
  title: string;
  type: string;
  symbols?: string[];
  dependsOn?: string[];
  derivesFrom?: string[];
}): Promise<void> {
  const projectDir = process.cwd();
  const config = loadConfig(projectDir);
  const specsDir = path.resolve(projectDir, config.specsDir);

  // Validate type early so the error is clear before any DB access
  if (!ALLOWED_SPEC_TYPES.includes(options.type as (typeof ALLOWED_SPEC_TYPES)[number])) {
    console.error(
      chalk.red(
        `Invalid spec type "${options.type}". Must be one of: ${ALLOWED_SPEC_TYPES.join(', ')}`,
      ),
    );
    process.exit(1);
  }

  // If symbol IDs were provided and the DB exists, warn about any that aren't found
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
      id: options.id,
      title: options.title,
      type: options.type,
      symbols: options.symbols,
      dependsOn: options.dependsOn,
      derivesFrom: options.derivesFrom,
      specsDir,
    });

    console.log(chalk.green(`✓ Created ${path.relative(projectDir, filePath)}`));
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}
