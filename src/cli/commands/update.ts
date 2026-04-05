import chalk from 'chalk';
import path from 'node:path';
import { openDatabase, closeDatabase, dbExists, queryAll } from '../../core/db.js';
import { loadConfig } from '../../core/config.js';
import { updateSpec } from '../../core/spec-writer.js';

export async function runUpdate(options: {
  id: string;
  addSymbols?: string[];
  removeSymbols?: string[];
  status?: string;
}): Promise<void> {
  const projectDir = process.cwd();
  const config = loadConfig(projectDir);
  const specsDir = path.resolve(projectDir, config.specsDir);

  // Resolve symbol types from DB when available
  const resolvedAddSymbols: Array<{ symbol: string; type: string }> = [];
  if (options.addSymbols && options.addSymbols.length > 0) {
    if (dbExists(projectDir)) {
      const { db, conn } = await openDatabase(projectDir, true);
      try {
        for (const symbolId of options.addSymbols) {
          const esc = symbolId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
          const { rows } = await queryAll(
            conn,
            `MATCH (c:CodeSymbol {id: '${esc}'}) RETURN c.symbol_type AS t`,
          );
          const symbolType = rows[0]?.['t'] ? String(rows[0]['t']) : 'unknown';
          if (rows.length === 0) {
            console.warn(chalk.yellow(`  ⚠ Symbol not found in graph (DB may be stale): ${symbolId}`));
          }
          resolvedAddSymbols.push({ symbol: symbolId, type: symbolType });
        }
      } finally {
        await closeDatabase(db, conn);
      }
    } else {
      for (const symbolId of options.addSymbols) {
        resolvedAddSymbols.push({ symbol: symbolId, type: 'unknown' });
      }
    }
  }

  try {
    const { filePath } = updateSpec({
      id: options.id,
      specsDir,
      addSymbols: resolvedAddSymbols.length > 0 ? resolvedAddSymbols : undefined,
      removeSymbols: options.removeSymbols,
      status: options.status,
    });

    console.log(chalk.green(`✓ Updated ${path.relative(projectDir, filePath)}`));
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}
