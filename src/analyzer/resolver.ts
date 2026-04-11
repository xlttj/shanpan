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

export interface RenameSuggestion {
  specId: string;
  oldSymbolId: string;
  suggestedSymbolId: string;
  reason: 'same_file_similar_fqn' | 'different_file_same_fqn';
}

function longestCommonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * For each unresolved symbol, attempt to find where it went:
 * - Pass 1: same FQN in a different file → the file was moved
 * - Pass 2: same class, similar method name in the same file → method was renamed
 *
 * Returns at most one suggestion per unresolved entry (Pass 1 wins over Pass 2).
 */
export function suggestRenames(
  unresolved: UnresolvedImplementation[],
  allSymbols: CodeSymbol[],
): RenameSuggestion[] {
  const results: RenameSuggestion[] = [];

  for (const { specId, symbolId } of unresolved) {
    const sep = symbolId.indexOf('::');
    if (sep === -1) continue; // malformed — skip

    const oldFilePath = symbolId.slice(0, sep);
    const oldFqn = symbolId.slice(sep + 2);

    // Pass 1 — file moved, FQN unchanged
    const moved = allSymbols.find(
      (s) => s.fqn === oldFqn && s.filePath !== oldFilePath,
    );
    if (moved) {
      results.push({
        specId,
        oldSymbolId: symbolId,
        suggestedSymbolId: moved.id,
        reason: 'different_file_same_fqn',
      });
      continue;
    }

    // Pass 2 — method renamed within the same class/file
    // Only applies when the FQN has a dot (is a method, not a top-level fn)
    const dotIdx = oldFqn.lastIndexOf('.');
    if (dotIdx === -1) continue;

    const classPrefix = oldFqn.slice(0, dotIdx);
    const oldMethod = oldFqn.slice(dotIdx + 1);
    const sameClassSymbols = allSymbols.filter(
      (s) => s.filePath === oldFilePath && s.fqn.startsWith(classPrefix + '.'),
    );

    let bestCandidate: CodeSymbol | null = null;
    let bestScore = 0;
    for (const candidate of sameClassSymbols) {
      const candidateMethod = candidate.fqn.slice(classPrefix.length + 1);
      const score = longestCommonPrefixLength(oldMethod, candidateMethod);
      if (score > bestScore) {
        bestScore = score;
        bestCandidate = candidate;
      }
    }

    if (bestCandidate && bestScore > 0) {
      results.push({
        specId,
        oldSymbolId: symbolId,
        suggestedSymbolId: bestCandidate.id,
        reason: 'same_file_similar_fqn',
      });
    }
  }

  return results;
}
