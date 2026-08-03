import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The README's tool list drifted badly once (it advertised the whole deleted
 * spec surface). This keeps it mechanically honest: the documented tools and
 * the tools the server actually dispatches must be the same set.
 */
describe('README MCP tool list', () => {
  const root = path.resolve(__dirname, '..');
  const mcpSrc = fs.readFileSync(path.join(root, 'src/cli/commands/mcp.ts'), 'utf-8');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf-8');

  // The tools the server truly implements — one dispatch branch each.
  const implemented = new Set(
    [...mcpSrc.matchAll(/name === '([a-z_]+)'/g)].map((m) => m[1]!),
  );

  // The "Available MCP tools" section, where the tool names live.
  const section = readme.slice(readme.indexOf('## Available MCP tools'));

  it('documents every tool the server dispatches', () => {
    const missing = [...implemented].filter((t) => !section.includes(`\`${t}\``)).sort();
    expect(missing, `README is missing: ${missing.join(', ')}`).toEqual([]);
  });

  it('advertises no tool the server does not implement', () => {
    // Underscore-shaped backtick tokens are tool claims; single prose words
    // like `rejected` or `source` are not. This is what catches a stale name
    // such as list_specs surviving after the tool was deleted.
    const claimed = [...section.matchAll(/`([a-z]+_[a-z_]+)`/g)].map((m) => m[1]!);
    const fictional = [...new Set(claimed)].filter((t) => !implemented.has(t)).sort();
    expect(fictional, `README advertises non-existent: ${fictional.join(', ')}`).toEqual([]);
  });
});
