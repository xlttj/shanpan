import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PhpParser } from '../src/analyzer/languages/php.js';

const parser = new PhpParser();

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'sample.php');

describe('PhpParser', () => {
  it('has correct name and extensions', () => {
    expect(parser.name).toBe('php');
    expect(parser.extensions).toContain('.php');
  });

  it('extracts class symbols', () => {
    const source = `<?php\nclass Foo {}\n`;
    const symbols = parser.extractSymbols('src/Foo.php', source);
    expect(symbols.some((s) => s.fqn === 'Foo' && s.kind === 'class')).toBe(true);
  });

  it('extracts class methods', () => {
    const source = `<?php\nclass Bar {\n  public function doSomething() {}\n}\n`;
    const symbols = parser.extractSymbols('src/Bar.php', source);
    expect(symbols.some((s) => s.fqn === 'Bar' && s.kind === 'class')).toBe(true);
    expect(symbols.some((s) => s.fqn === 'Bar.doSomething' && s.kind === 'method')).toBe(true);
  });

  it('extracts top-level functions', () => {
    const source = `<?php\nfunction calculateTax(float $amount): float { return $amount * 0.19; }\n`;
    const symbols = parser.extractSymbols('src/helpers.php', source);
    expect(symbols.some((s) => s.fqn === 'calculateTax' && s.kind === 'function')).toBe(true);
  });

  it('extracts interfaces', () => {
    const source = `<?php\ninterface PaymentGateway {\n  public function charge(int $amount): bool;\n}\n`;
    const symbols = parser.extractSymbols('src/PaymentGateway.php', source);
    expect(symbols.some((s) => s.fqn === 'PaymentGateway' && s.kind === 'interface')).toBe(true);
  });

  it('sets correct file path and language on symbols', () => {
    const source = `<?php\nclass Baz {}\n`;
    const symbols = parser.extractSymbols('app/Baz.php', source);
    const cls = symbols.find((s) => s.fqn === 'Baz');
    expect(cls).toBeDefined();
    expect(cls?.filePath).toBe('app/Baz.php');
    expect(cls?.language).toBe('php');
    expect(cls?.id).toBe('app/Baz.php::Baz');
  });

  it('includes line numbers', () => {
    const source = `<?php\n\nclass Qux {\n  public function run() {}\n}\n`;
    const symbols = parser.extractSymbols('x.php', source);
    const cls = symbols.find((s) => s.fqn === 'Qux');
    expect(cls?.lineStart).toBe(3);
  });

  it('parses the sample fixture without errors', () => {
    const source = fs.readFileSync(FIXTURE, 'utf-8');
    const symbols = parser.extractSymbols('tests/fixtures/sample.php', source);
    const fqns = symbols.map((s) => s.fqn);
    expect(fqns).toContain('OrderService');
    expect(fqns).toContain('OrderService.createOrder');
    expect(fqns).toContain('OrderService.validateOrder');
    expect(fqns).toContain('PaymentGateway');
    expect(fqns).toContain('calculateTax');
  });
});
