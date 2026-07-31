import { describe, it, expect } from 'vitest';
import {
  scanMarkers,
  buildMarkerRegex,
  parseReverts,
  buildGitLogArgs,
  scanAdr,
  dedupKey,
  MAX_CLAIM,
} from '../src/core/bootstrap.js';

// ─── scanMarkers ─────────────────────────────────────────────────────────────

describe('scanMarkers', () => {
  it('captures a marker at the start of a line comment', () => {
    const out = scanMarkers('a.ts', '// HACK: retry twice because the API flaps\ncode();');
    expect(out).toEqual([
      { file: 'a.ts', line: 1, marker: 'HACK', claim: 'retry twice because the API flaps' },
    ]);
  });

  it('reports the correct 1-based line number', () => {
    const out = scanMarkers('a.ts', 'line1\nline2\n# FIXME broken on leap years');
    expect(out[0]?.line).toBe(3);
  });

  it('handles hash, block, and jsdoc comment styles', () => {
    const src = [
      '# WORKAROUND: pin the version',
      '/* XXX: this leaks a handle */',
      ' * DANGER: not thread-safe',
    ].join('\n');
    const markers = scanMarkers('a.ts', src).map((m) => m.marker);
    expect(markers).toEqual(['WORKAROUND', 'XXX', 'DANGER']);
  });

  it('is case-insensitive on the marker but normalises to upper', () => {
    expect(scanMarkers('a.ts', '// Fixme: lowercase tag')[0]?.marker).toBe('FIXME');
  });

  it('ignores TODO and NOTE — future work and asides are not knowledge', () => {
    const src = '// TODO: refactor later\n// NOTE: see the docs';
    expect(scanMarkers('a.ts', src)).toEqual([]);
  });

  it('does not match a marker word appearing mid-prose', () => {
    expect(scanMarkers('a.ts', '// this is a hack but it works')).toEqual([]);
  });

  it('skips a bare marker with no text', () => {
    expect(scanMarkers('a.ts', '// HACK')).toEqual([]);
  });

  it('strips a trailing block-comment terminator', () => {
    expect(scanMarkers('a.ts', '/* WARNING: mutates the arg */')[0]?.claim).toBe('mutates the arg');
  });

  it('clips an over-long claim', () => {
    const long = 'x'.repeat(MAX_CLAIM + 50);
    const claim = scanMarkers('a.ts', `// HACK: ${long}`)[0]?.claim ?? '';
    expect(claim.length).toBeLessThanOrEqual(MAX_CLAIM);
    expect(claim.endsWith('…')).toBe(true);
  });

  it('matches a project-specific marker when supplied', () => {
    const src = '// KLUDGE: single-threaded on purpose\n// HACK: also this';
    const out = scanMarkers('a.ts', src, ['KLUDGE']);
    // Only the custom marker is in the set here — HACK is not passed.
    expect(out.map((m) => m.marker)).toEqual(['KLUDGE']);
  });

  it('returns nothing when the marker set is empty', () => {
    expect(scanMarkers('a.ts', '// HACK: x', [])).toEqual([]);
  });
});

describe('buildMarkerRegex', () => {
  it('treats a marker with regex metacharacters as a literal', () => {
    const re = buildMarkerRegex(['C++']);
    expect(re.test('// C++: careful with ABI')).toBe(true);
    // The escaped '+' must not turn into a quantifier that matches "C".
    expect(re.test('// Cc: not a marker')).toBe(false);
  });
});

// ─── parseReverts ────────────────────────────────────────────────────────────

function gitRecord(hash: string, subject: string, body = ''): string {
  return `${hash}\x1f${subject}\x1f${body}\x1e`;
}

describe('parseReverts', () => {
  it('extracts the reverted subject as the claim', () => {
    const log = gitRecord('abc1234567', 'Revert "Add Redis write-through cache"', 'This reverts commit deadbeef.');
    const out = parseReverts(log);
    expect(out).toEqual([{ sha: 'abc123456', claim: 'Add Redis write-through cache' }]);
  });

  it('ignores non-revert commits', () => {
    const log = gitRecord('aaa', 'Add feature') + gitRecord('bbb', 'Fix bug');
    expect(parseReverts(log)).toEqual([]);
  });

  it('handles multiple reverts across records', () => {
    const log =
      gitRecord('1111111', 'Revert "First"') +
      gitRecord('2222222', 'Normal commit') +
      gitRecord('3333333', 'Revert "Third"');
    expect(parseReverts(log).map((r) => r.claim)).toEqual(['First', 'Third']);
  });

  it('shortens the sha to at most 9 characters', () => {
    const log = gitRecord('0123456789abcdef', 'Revert "x"');
    expect(parseReverts(log)[0]?.sha).toBe('012345678');
  });

  it('tolerates an empty log', () => {
    expect(parseReverts('')).toEqual([]);
  });
});

describe('buildGitLogArgs', () => {
  it('bounds the scan with -n and uses the field/record separators', () => {
    const args = buildGitLogArgs(500);
    expect(args).toContain('-n500');
    expect(args.some((a) => a.includes('%x1f') && a.includes('%x1e'))).toBe(true);
  });
});

// ─── scanAdr ─────────────────────────────────────────────────────────────────

describe('scanAdr', () => {
  it('takes the H1 as the claim', () => {
    expect(scanAdr('# Use Postgres for the ledger\n\nsome text')?.claim).toBe('Use Postgres for the ledger');
  });

  it('strips an ADR number prefix', () => {
    expect(scanAdr('# ADR-12: Adopt event sourcing')?.claim).toBe('Adopt event sourcing');
    expect(scanAdr('# 0007. Split the monolith')?.claim).toBe('Split the monolith');
  });

  it('pulls the Decision section as the reason', () => {
    const src = [
      '# Cache at the edge',
      '## Context',
      'latency was high',
      '## Decision',
      'We put a CDN in front because origin round-trips dominated p99.',
      '## Consequences',
      'more infra',
    ].join('\n');
    const adr = scanAdr(src);
    expect(adr?.claim).toBe('Cache at the edge');
    expect(adr?.because).toBe('We put a CDN in front because origin round-trips dominated p99.');
  });

  it('returns a null reason when there is no Decision section', () => {
    expect(scanAdr('# Just a title\n\nbody')?.because).toBeNull();
  });

  it('returns null when there is no title', () => {
    expect(scanAdr('no heading here')).toBeNull();
  });
});

// ─── dedupKey ────────────────────────────────────────────────────────────────

describe('dedupKey', () => {
  it('collapses whitespace and case so re-runs match', () => {
    expect(dedupKey('gotcha', '  Retry   TWICE ')).toBe(dedupKey('gotcha', 'retry twice'));
  });

  it('separates by kind', () => {
    expect(dedupKey('gotcha', 'x')).not.toBe(dedupKey('decision', 'x'));
  });
});
