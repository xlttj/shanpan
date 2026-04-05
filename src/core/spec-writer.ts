import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { findSpecFiles, parseSpecFile } from './parser.js';

export const ALLOWED_SPEC_TYPES = [
  'intent',
  'business_rule',
  'software_requirement',
  'project_spec',
] as const;

export type SpecType = (typeof ALLOWED_SPEC_TYPES)[number];

export interface CreateSpecOptions {
  id: string;
  title: string;
  type: string;
  /** Symbol IDs to include in the implements list */
  symbols?: string[];
  dependsOn?: string[];
  derivesFrom?: string[];
  /** Directory in which to write the file */
  specsDir: string;
}

export interface CreateSpecResult {
  filePath: string;
}

/**
 * Write a new spec markdown file to disk. Throws if:
 * - `type` is not one of the allowed values
 * - The file already exists
 */
export function createSpec(options: CreateSpecOptions): CreateSpecResult {
  const { id, title, type, symbols, dependsOn, derivesFrom, specsDir } = options;

  if (!ALLOWED_SPEC_TYPES.includes(type as SpecType)) {
    throw new Error(
      `Invalid spec type "${type}". Must be one of: ${ALLOWED_SPEC_TYPES.join(', ')}`,
    );
  }

  const fileName = `${id.toLowerCase()}.md`;
  const filePath = path.join(specsDir, fileName);

  if (fs.existsSync(filePath)) {
    throw new Error(`Spec file already exists: ${filePath}`);
  }

  const today = new Date().toISOString().slice(0, 10);

  // Build frontmatter — only include optional arrays if provided
  const frontmatter: Record<string, unknown> = {
    id,
    title,
    type,
    status: 'draft',
    created: today,
  };

  if (dependsOn && dependsOn.length > 0) {
    frontmatter['depends_on'] = dependsOn;
  }
  if (derivesFrom && derivesFrom.length > 0) {
    frontmatter['derives_from'] = derivesFrom;
  }
  if (symbols && symbols.length > 0) {
    frontmatter['implements'] = symbols.map((s) => ({ symbol: s, type: 'unknown' }));
  }

  const body = `# ${title}\n\n`;
  const content = matter.stringify(body, frontmatter);

  fs.mkdirSync(specsDir, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');

  return { filePath };
}

export interface UpdateSpecOptions {
  id: string;
  specsDir: string;
  /** Symbol IDs to append to implements (no duplicates) */
  addSymbols?: Array<{ symbol: string; type: string }>;
  /** Symbol IDs to remove from implements */
  removeSymbols?: string[];
  /** Overwrite the status field */
  status?: string;
}

/**
 * Update an existing spec file in place. Finds the file by scanning specsDir
 * for a matching `id` field, then applies the requested mutations while
 * preserving the markdown body exactly.
 *
 * Throws if no spec with the given ID is found.
 */
export function updateSpec(options: UpdateSpecOptions): { filePath: string } {
  const { id, specsDir, addSymbols, removeSymbols, status } = options;

  // Scan to find the file whose frontmatter.id matches
  const files = findSpecFiles(specsDir);
  let targetPath: string | undefined;
  for (const filePath of files) {
    try {
      const parsed = parseSpecFile(filePath);
      if (parsed.frontmatter.id === id) {
        targetPath = filePath;
        break;
      }
    } catch {
      // skip malformed files
    }
  }

  if (!targetPath) {
    throw new Error(`Spec "${id}" not found in ${specsDir}`);
  }

  const raw = fs.readFileSync(targetPath, 'utf-8');
  const file = matter(raw);

  // Apply status change
  if (status !== undefined) {
    file.data['status'] = status;
  }

  // Apply symbol additions (dedup by symbol ID)
  if (addSymbols && addSymbols.length > 0) {
    const existing = (file.data['implements'] as Array<{ symbol: string; type: string }>) ?? [];
    const existingIds = new Set(existing.map((e) => e.symbol));
    for (const entry of addSymbols) {
      if (!existingIds.has(entry.symbol)) {
        existing.push(entry);
        existingIds.add(entry.symbol);
      }
    }
    file.data['implements'] = existing;
  }

  // Apply symbol removals
  if (removeSymbols && removeSymbols.length > 0) {
    const toRemove = new Set(removeSymbols);
    const existing = (file.data['implements'] as Array<{ symbol: string }>) ?? [];
    file.data['implements'] = existing.filter((e) => !toRemove.has(e.symbol));
    // Remove the key entirely if empty
    if ((file.data['implements'] as unknown[]).length === 0) {
      delete file.data['implements'];
    }
  }

  const updated = matter.stringify(file.content, file.data);
  fs.writeFileSync(targetPath, updated, 'utf-8');

  return { filePath: targetPath };
}
