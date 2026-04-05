import type { CodeSymbol } from '../types/code.js';
import type { ParsedSpec } from '../types/spec.js';

export interface ImplementationLink {
  symbolId: string;
  specId: string;
  confidence: number;
}

export interface UnresolvedImplementation {
  specId: string;
  symbolId: string;
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

/**
 * Returns all `implements` entries declared in specs that do NOT match any
 * extracted code symbol. These indicate drift: the symbol was renamed, moved,
 * or deleted since the spec was last updated.
 */
export function findUnresolvedImplementations(
  symbols: CodeSymbol[],
  specs: ParsedSpec[],
): UnresolvedImplementation[] {
  const symbolIds = new Set(symbols.map((s) => s.id));
  const unresolved: UnresolvedImplementation[] = [];

  for (const spec of specs) {
    for (const impl of spec.frontmatter.implements ?? []) {
      if (!symbolIds.has(impl.symbol)) {
        unresolved.push({ specId: spec.frontmatter.id, symbolId: impl.symbol });
      }
    }
  }

  return unresolved;
}
