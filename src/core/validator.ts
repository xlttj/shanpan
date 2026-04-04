import type { ParsedSpec } from '../types/spec.js';

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

export function validateSpecs(specs: ParsedSpec[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const specIds = new Set(specs.map((s) => s.frontmatter.id));

  for (const spec of specs) {
    const { id, depends_on, derives_from } = spec.frontmatter;

    for (const dep of depends_on ?? []) {
      if (!specIds.has(dep)) {
        warnings.push(`${id}: depends_on references unknown spec '${dep}'`);
      }
    }

    for (const der of derives_from ?? []) {
      if (!specIds.has(der)) {
        warnings.push(`${id}: derives_from references unknown spec '${der}'`);
      }
    }
  }

  const cycleErrors = detectCycles(specs, 'derives_from');
  errors.push(...cycleErrors);

  return { errors, warnings };
}

function detectCycles(specs: ParsedSpec[], field: 'derives_from' | 'depends_on'): string[] {
  const graph = new Map<string, string[]>();
  for (const spec of specs) {
    graph.set(spec.frontmatter.id, spec.frontmatter[field] ?? []);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();
  const errors: string[] = [];

  function dfs(id: string, path: string[]): void {
    if (inStack.has(id)) {
      const cycle = [...path.slice(path.indexOf(id)), id];
      errors.push(`Cycle detected in ${field}: ${cycle.join(' -> ')}`);
      return;
    }
    if (visited.has(id)) return;

    visited.add(id);
    inStack.add(id);

    for (const next of graph.get(id) ?? []) {
      dfs(next, [...path, id]);
    }

    inStack.delete(id);
  }

  for (const id of graph.keys()) {
    if (!visited.has(id)) dfs(id, []);
  }

  return errors;
}
