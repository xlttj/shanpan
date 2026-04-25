import matter from 'gray-matter';
import fs from 'node:fs';
import path from 'node:path';
import type { ParsedSpec, SpecFrontmatter } from '../types/spec.js';

export function parseSpecFile(filePath: string, specsDir?: string): ParsedSpec {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const { data, content } = matter(raw);
  const frontmatter = data as SpecFrontmatter;

  if (!frontmatter.title) throw new Error(`Missing required field 'title' in ${filePath}`);
  if (!frontmatter.type) throw new Error(`Missing required field 'type' in ${filePath}`);
  if (!frontmatter.status) throw new Error(`Missing required field 'status' in ${filePath}`);

  for (const impl of frontmatter.implements ?? []) {
    if (!impl.symbol || typeof impl.symbol !== 'string') {
      throw new Error(`Invalid implements entry in ${filePath}: missing 'symbol' string field`);
    }
  }

  const id = specsDir ? path.relative(specsDir, filePath).replace(/\.md$/, '') : '';
  return { id, frontmatter, content: content.trim(), filePath };
}

export function findSpecFiles(specsDir: string): string[] {
  if (!fs.existsSync(specsDir)) return [];

  const files: string[] = [];
  for (const entry of fs.readdirSync(specsDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(path.join(specsDir, entry.name));
    } else if (entry.isDirectory()) {
      files.push(...findSpecFiles(path.join(specsDir, entry.name)));
    }
  }
  return files.sort();
}

export function parseAllSpecs(specsDir: string): { specs: ParsedSpec[]; errors: string[] } {
  const files = findSpecFiles(specsDir);
  const specs: ParsedSpec[] = [];
  const errors: string[] = [];

  for (const file of files) {
    try {
      specs.push(parseSpecFile(file, specsDir));
    } catch (err) {
      errors.push(`${path.basename(file)}: ${(err as Error).message}`);
    }
  }

  return { specs, errors };
}
