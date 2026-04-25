import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { GivenWhenThen } from '../types/spec.js';

export const ALLOWED_SPEC_TYPES = [
  'intent',
  'business_rule',
  'software_requirement',
  'project_spec',
] as const;

export type SpecType = (typeof ALLOWED_SPEC_TYPES)[number];

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export interface CreateSpecOptions {
  title: string;
  type: string;
  /** Subdirectory under specsDir, e.g. 'core', 'cli' */
  dir?: string;
  /** Symbol IDs to include in the implements list */
  symbols?: string[];
  /** Acceptance criteria as Given/When/Then entries */
  acceptanceCriteria?: GivenWhenThen[];
  /** Base directory where spec files live */
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
  const { title, type, dir, symbols, acceptanceCriteria, specsDir } = options;

  if (!ALLOWED_SPEC_TYPES.includes(type as SpecType)) {
    throw new Error(
      `Invalid spec type "${type}". Must be one of: ${ALLOWED_SPEC_TYPES.join(', ')}`,
    );
  }

  const filename = slugify(title) + '.md';
  const targetDir = dir ? path.join(specsDir, dir) : specsDir;
  const filePath = path.join(targetDir, filename);

  if (fs.existsSync(filePath)) {
    throw new Error(`Spec file already exists: ${filePath}`);
  }

  const today = new Date().toISOString().slice(0, 10);

  const frontmatter: Record<string, unknown> = {
    title,
    type,
    status: 'draft',
    created: today,
  };

  if (symbols && symbols.length > 0) {
    frontmatter['implements'] = symbols.map((s) => ({ symbol: s, type: 'unknown' }));
  }
  if (acceptanceCriteria && acceptanceCriteria.length > 0) {
    frontmatter['acceptance_criteria'] = acceptanceCriteria;
  }

  const body = `# ${title}\n\n`;
  const content = matter.stringify(body, frontmatter);

  fs.mkdirSync(targetDir, { recursive: true });
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
 * Update an existing spec file in place. Resolves the file path directly from
 * the path key (e.g. 'core/spec-parser' → specsDir/core/spec-parser.md).
 *
 * Throws if the file does not exist.
 */
export function updateSpec(options: UpdateSpecOptions): { filePath: string } {
  const { id, specsDir, addSymbols, removeSymbols, status } = options;

  const filePath = path.join(specsDir, id.endsWith('.md') ? id : id + '.md');

  if (!fs.existsSync(filePath)) {
    throw new Error(`Spec not found: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const file = matter(raw);

  if (status !== undefined) {
    file.data['status'] = status;
  }

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

  if (removeSymbols && removeSymbols.length > 0) {
    const toRemove = new Set(removeSymbols);
    const existing = (file.data['implements'] as Array<{ symbol: string }>) ?? [];
    file.data['implements'] = existing.filter((e) => !toRemove.has(e.symbol));
    if ((file.data['implements'] as unknown[]).length === 0) {
      delete file.data['implements'];
    }
  }

  const updated = matter.stringify(file.content, file.data);
  fs.writeFileSync(filePath, updated, 'utf-8');

  return { filePath };
}
