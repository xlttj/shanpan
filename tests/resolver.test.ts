import { describe, it, expect } from 'vitest';
import {
  resolveImplementations,
  findUnresolvedImplementations,
  suggestRenames,
} from '../src/analyzer/resolver.js';
import type { UnresolvedImplementation } from '../src/analyzer/resolver.js';
import type { CodeSymbol } from '../src/types/code.js';
import type { ParsedSpec } from '../src/types/spec.js';

function makeSymbol(id: string): CodeSymbol {
  return {
    id,
    fqn: id.split('::')[1] ?? id,
    kind: 'function',
    filePath: id.split('::')[0] ?? id,
    lineStart: 1,
    lineEnd: 1,
    language: 'typescript',
  };
}

function makeSpec(
  id: string,
  symbols: string[] = [],
): ParsedSpec {
  return {
    frontmatter: {
      id,
      title: id,
      type: 'software_requirement',
      status: 'draft',
      implements: symbols.map((s) => ({ symbol: s, type: 'function' })),
    },
    content: '',
    filePath: `/fake/${id}.md`,
  };
}

// ─── resolveImplementations ───────────────────────────────────────────────────

describe('resolveImplementations', () => {
  it('returns a link for each symbol that exists in the extracted set', () => {
    const symbols = [makeSymbol('src/foo.ts::bar')];
    const specs = [makeSpec('SPEC-001', ['src/foo.ts::bar'])];
    const links = resolveImplementations(symbols, specs);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ symbolId: 'src/foo.ts::bar', specId: 'SPEC-001' });
  });

  it('returns no links when no symbol matches', () => {
    const symbols = [makeSymbol('src/foo.ts::bar')];
    const specs = [makeSpec('SPEC-001', ['src/baz.ts::qux'])];
    expect(resolveImplementations(symbols, specs)).toHaveLength(0);
  });

  it('handles specs with no implements field', () => {
    const symbols = [makeSymbol('src/foo.ts::bar')];
    const specs = [makeSpec('SPEC-001')];
    expect(resolveImplementations(symbols, specs)).toHaveLength(0);
  });

  it('returns links for multiple specs referencing the same symbol', () => {
    const symbols = [makeSymbol('src/foo.ts::bar')];
    const specs = [
      makeSpec('SPEC-001', ['src/foo.ts::bar']),
      makeSpec('SPEC-002', ['src/foo.ts::bar']),
    ];
    const links = resolveImplementations(symbols, specs);
    expect(links).toHaveLength(2);
  });

  it('returns empty array for empty specs', () => {
    const symbols = [makeSymbol('src/foo.ts::bar')];
    expect(resolveImplementations(symbols, [])).toHaveLength(0);
  });

  it('returns empty array for empty symbols', () => {
    const specs = [makeSpec('SPEC-001', ['src/foo.ts::bar'])];
    expect(resolveImplementations([], specs)).toHaveLength(0);
  });
});

// ─── findUnresolvedImplementations ───────────────────────────────────────────

describe('findUnresolvedImplementations', () => {
  it('returns unresolved entries for symbols not in the extracted set', () => {
    const symbols = [makeSymbol('src/foo.ts::bar')];
    const specs = [makeSpec('SPEC-001', ['src/missing.ts::gone'])];
    const unresolved = findUnresolvedImplementations(symbols, specs);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]).toMatchObject({
      specId: 'SPEC-001',
      symbolId: 'src/missing.ts::gone',
    });
  });

  it('returns empty array when all symbols resolve', () => {
    const symbols = [makeSymbol('src/foo.ts::bar')];
    const specs = [makeSpec('SPEC-001', ['src/foo.ts::bar'])];
    expect(findUnresolvedImplementations(symbols, specs)).toHaveLength(0);
  });

  it('returns only the unresolved subset when some resolve and some do not', () => {
    const symbols = [makeSymbol('src/foo.ts::bar')];
    const specs = [makeSpec('SPEC-001', ['src/foo.ts::bar', 'src/missing.ts::gone'])];
    const unresolved = findUnresolvedImplementations(symbols, specs);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.symbolId).toBe('src/missing.ts::gone');
  });

  it('handles specs with no implements field', () => {
    const symbols = [makeSymbol('src/foo.ts::bar')];
    const specs = [makeSpec('SPEC-001')];
    expect(findUnresolvedImplementations(symbols, specs)).toHaveLength(0);
  });

  it('handles empty specs array', () => {
    const symbols = [makeSymbol('src/foo.ts::bar')];
    expect(findUnresolvedImplementations(symbols, [])).toHaveLength(0);
  });

  it('handles empty symbols array — all spec implements are unresolved', () => {
    const specs = [makeSpec('SPEC-001', ['src/foo.ts::bar', 'src/baz.ts::qux'])];
    const unresolved = findUnresolvedImplementations([], specs);
    expect(unresolved).toHaveLength(2);
  });

  it('reports unresolved entries across multiple specs', () => {
    const specs = [
      makeSpec('SPEC-001', ['src/a.ts::A']),
      makeSpec('SPEC-002', ['src/b.ts::B']),
    ];
    const unresolved = findUnresolvedImplementations([], specs);
    expect(unresolved.map((u) => u.specId).sort()).toEqual(['SPEC-001', 'SPEC-002']);
  });
});

// ─── suggestRenames ──────────────────────────────────────────────────────────

function makeUnresolved(specId: string, symbolId: string): UnresolvedImplementation {
  return { specId, symbolId };
}

describe('suggestRenames', () => {
  it('suggests same_file_similar_fqn when method is renamed within same class', () => {
    const unresolved = [makeUnresolved('SPEC-003', 'src/tax.php::Tax.calculateTax')];
    const symbols = [makeSymbol('src/tax.php::Tax.computeTax')];
    const suggestions = suggestRenames(unresolved, symbols);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      specId: 'SPEC-003',
      oldSymbolId: 'src/tax.php::Tax.calculateTax',
      suggestedSymbolId: 'src/tax.php::Tax.computeTax',
      reason: 'same_file_similar_fqn',
    });
  });

  it('suggests different_file_same_fqn when file is moved', () => {
    const unresolved = [makeUnresolved('SPEC-005', 'src/old/Tax.php::Tax.calculateTax')];
    const symbols = [makeSymbol('src/new/Tax.php::Tax.calculateTax')];
    const suggestions = suggestRenames(unresolved, symbols);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      specId: 'SPEC-005',
      oldSymbolId: 'src/old/Tax.php::Tax.calculateTax',
      suggestedSymbolId: 'src/new/Tax.php::Tax.calculateTax',
      reason: 'different_file_same_fqn',
    });
  });

  it('returns empty array when there is no match', () => {
    const unresolved = [makeUnresolved('SPEC-007', 'src/foo.php::Foo.bar')];
    const symbols = [makeSymbol('src/other.php::Unrelated.method')];
    expect(suggestRenames(unresolved, symbols)).toHaveLength(0);
  });

  it('different_file_same_fqn takes priority over same_file_similar_fqn', () => {
    const unresolved = [makeUnresolved('SPEC-008', 'src/old.php::Tax.calculateTax')];
    const symbols = [
      makeSymbol('src/new.php::Tax.calculateTax'), // file moved (Pass 1)
      makeSymbol('src/old.php::Tax.computeTax'),   // same-file rename (Pass 2)
    ];
    const suggestions = suggestRenames(unresolved, symbols);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.reason).toBe('different_file_same_fqn');
    expect(suggestions[0]?.suggestedSymbolId).toBe('src/new.php::Tax.calculateTax');
  });

  it('does not suggest for top-level functions (no dot in FQN)', () => {
    // Top-level fn — Pass 2 is skipped; no file move either
    const unresolved = [makeUnresolved('SPEC-009', 'src/helpers.php::calculateTax')];
    const symbols = [makeSymbol('src/helpers.php::computeTax')];
    expect(suggestRenames(unresolved, symbols)).toHaveLength(0);
  });
});
