import type { CodeSymbol } from '../types/code.js';
import type { ParsedSpec } from '../types/spec.js';

export interface ImplementationLink {
  symbolId: string;
  specId: string;
  confidence: number;
}

/**
 * Match extracted code symbols against the `implements` entries declared in
 * spec frontmatter. Returns a link for each symbol ID that is referenced by
 * at least one spec.
 */
export function resolveImplementations(
  symbols: CodeSymbol[],
  specs: ParsedSpec[],
): ImplementationLink[] {
  const symbolIds = new Set(symbols.map((s) => s.id));
  const links: ImplementationLink[] = [];

  for (const spec of specs) {
    for (const impl of spec.frontmatter.implements ?? []) {
      if (symbolIds.has(impl.symbol)) {
        links.push({
          symbolId: impl.symbol,
          specId: spec.frontmatter.id,
          confidence: 1.0,
        });
      }
    }
  }

  return links;
}
