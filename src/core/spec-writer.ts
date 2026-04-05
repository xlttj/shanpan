import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

export const ALLOWED_SPEC_TYPES = [
  'intent',
  'business_rule',
  'software_requirement',
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
