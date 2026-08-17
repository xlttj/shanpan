import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PythonParser } from '../src/analyzer/languages/python.js';

const parser = new PythonParser();

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'sample.py');

describe('PythonParser', () => {
  it('has correct name and extensions', () => {
    expect(parser.name).toBe('python');
    expect(parser.extensions).toContain('.py');
  });

  it('extracts a top-level function', () => {
    const symbols = parser.extractSymbols('src/util.py', 'def hash_password(p):\n    return p\n');
    expect(symbols.some((s) => s.fqn === 'hash_password' && s.kind === 'function')).toBe(true);
  });

  it('extracts a class and its methods', () => {
    const src = 'class Bar:\n    def do_work(self):\n        return 1\n';
    const symbols = parser.extractSymbols('src/bar.py', src);
    expect(symbols.some((s) => s.fqn === 'Bar' && s.kind === 'class')).toBe(true);
    expect(symbols.some((s) => s.fqn === 'Bar.do_work' && s.kind === 'method')).toBe(true);
  });

  it('extracts decorated methods (@property, @staticmethod)', () => {
    const symbols = parser.extractSymbols(FIXTURE, fs.readFileSync(FIXTURE, 'utf-8'));
    expect(symbols.some((s) => s.fqn === 'Order.is_empty' && s.kind === 'method')).toBe(true);
    expect(symbols.some((s) => s.fqn === 'Order.create' && s.kind === 'method')).toBe(true);
  });

  it('extracts a nested class and its method with a dotted fqn', () => {
    const symbols = parser.extractSymbols(FIXTURE, fs.readFileSync(FIXTURE, 'utf-8'));
    expect(symbols.some((s) => s.fqn === 'Order.Line' && s.kind === 'class')).toBe(true);
    expect(symbols.some((s) => s.fqn === 'Order.Line.price' && s.kind === 'method')).toBe(true);
  });

  it('extracts SCREAMING_SNAKE_CASE constants at module and class level', () => {
    const symbols = parser.extractSymbols(FIXTURE, fs.readFileSync(FIXTURE, 'utf-8'));
    expect(symbols.some((s) => s.fqn === 'MAX_RETRIES' && s.kind === 'constant')).toBe(true);
    expect(symbols.some((s) => s.fqn === 'Order.STATUS_OPEN' && s.kind === 'constant')).toBe(true);
  });

  it('does not extract lower-case module variables', () => {
    const symbols = parser.extractSymbols(FIXTURE, fs.readFileSync(FIXTURE, 'utf-8'));
    expect(symbols.some((s) => s.fqn === 'default_timeout')).toBe(false);
  });

  it('gives every symbol a filePath::fqn id and 1-based line numbers', () => {
    const symbols = parser.extractSymbols('src/bar.py', 'class Bar:\n    def m(self):\n        return 1\n');
    const bar = symbols.find((s) => s.fqn === 'Bar');
    expect(bar?.id).toBe('src/bar.py::Bar');
    expect(bar?.lineStart).toBe(1);
    expect(bar?.language).toBe('python');
  });
});

describe('PythonParser.extractCallRefs', () => {
  function refs(src: string) {
    const symbols = parser.extractSymbols('src/m.py', src);
    return parser.extractCallRefs('src/m.py', src, symbols);
  }

  it('marks a capitalised call as an instantiation', () => {
    const src = 'class Widget:\n    pass\n\ndef make():\n    return Widget()\n';
    const r = refs(src);
    expect(r.some((c) => c.targetName === 'Widget' && c.kind === 'instantiation')).toBe(true);
  });

  it('marks a lower-case call as a static call to the function name', () => {
    const src = 'def helper():\n    return 1\n\ndef run():\n    return helper()\n';
    const r = refs(src);
    const call = r.find((c) => c.targetName === 'helper');
    expect(call).toBeDefined();
    expect(call?.kind).toBe('static_call');
    expect(call?.callerSymbolId).toBe('src/m.py::run');
  });

  it('resolves self.method() to the enclosing class', () => {
    const src = 'class Svc:\n    def run(self):\n        return self.step()\n    def step(self):\n        return 1\n';
    const r = refs(src);
    expect(r.some((c) => c.targetName === 'Svc.step' && c.callerSymbolId === 'src/m.py::Svc.run')).toBe(true);
  });

  it('records obj.method() calls by their written form', () => {
    const src = 'def go():\n    return Order.create()\n';
    const r = refs(src);
    expect(r.some((c) => c.targetName === 'Order.create' && c.kind === 'static_call')).toBe(true);
  });
});
