import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TypeScriptParser } from '../src/analyzer/languages/typescript.js';

const parser = new TypeScriptParser();

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'sample.ts');

describe('TypeScriptParser', () => {
  it('has correct name and extensions', () => {
    expect(parser.name).toBe('typescript');
    expect(parser.extensions).toContain('.ts');
    expect(parser.extensions).toContain('.tsx');
  });

  it('extracts a class', () => {
    const symbols = parser.extractSymbols('src/foo.ts', 'export class Foo {}');
    expect(symbols.some((s) => s.fqn === 'Foo' && s.kind === 'class')).toBe(true);
  });

  it('extracts class methods', () => {
    const src = `export class Bar {\n  doWork(): void {}\n}`;
    const symbols = parser.extractSymbols('src/bar.ts', src);
    expect(symbols.some((s) => s.fqn === 'Bar' && s.kind === 'class')).toBe(true);
    expect(symbols.some((s) => s.fqn === 'Bar.doWork' && s.kind === 'method')).toBe(true);
  });

  it('extracts top-level functions', () => {
    const symbols = parser.extractSymbols('src/utils.ts', 'export function hashPassword(p: string): string { return p; }');
    expect(symbols.some((s) => s.fqn === 'hashPassword' && s.kind === 'function')).toBe(true);
  });

  it('extracts interfaces', () => {
    const symbols = parser.extractSymbols('src/types.ts', 'export interface IRepo { find(): void; }');
    expect(symbols.some((s) => s.fqn === 'IRepo' && s.kind === 'interface')).toBe(true);
  });

  it('extracts type aliases', () => {
    const symbols = parser.extractSymbols('src/types.ts', 'export type UserId = string;');
    expect(symbols.some((s) => s.fqn === 'UserId' && s.kind === 'type')).toBe(true);
  });

  it('extracts enums', () => {
    const symbols = parser.extractSymbols('src/types.ts', 'export enum Status { Active, Inactive }');
    expect(symbols.some((s) => s.fqn === 'Status' && s.kind === 'enum')).toBe(true);
  });

  it('extracts exported const arrays as constant', () => {
    const src = `export const SKILLS: Skill[] = [a, b];`;
    const symbols = parser.extractSymbols('src/skills/index.ts', src);
    const sym = symbols.find((s) => s.fqn === 'SKILLS');
    expect(sym).toBeDefined();
    expect(sym?.kind).toBe('constant');
    expect(sym?.id).toBe('src/skills/index.ts::SKILLS');
  });

  it('extracts non-exported const as constant', () => {
    const src = `const MAX_RETRIES = 3;`;
    const symbols = parser.extractSymbols('src/config.ts', src);
    expect(symbols.some((s) => s.fqn === 'MAX_RETRIES' && s.kind === 'constant')).toBe(true);
  });

  it('extracts let declarations as constant', () => {
    const src = `export let counter = 0;`;
    const symbols = parser.extractSymbols('src/state.ts', src);
    expect(symbols.some((s) => s.fqn === 'counter' && s.kind === 'constant')).toBe(true);
  });

  it('sets correct id, filePath, language', () => {
    const symbols = parser.extractSymbols('src/foo.ts', 'export class Baz {}');
    const cls = symbols.find((s) => s.fqn === 'Baz');
    expect(cls?.id).toBe('src/foo.ts::Baz');
    expect(cls?.filePath).toBe('src/foo.ts');
    expect(cls?.language).toBe('typescript');
  });

  it('includes line numbers', () => {
    const src = `\nexport class MyClass {\n  run() {}\n}`;
    const symbols = parser.extractSymbols('x.ts', src);
    const cls = symbols.find((s) => s.fqn === 'MyClass');
    expect(cls?.lineStart).toBe(2);
  });

  it('parses the sample fixture', () => {
    const source = fs.readFileSync(FIXTURE, 'utf-8');
    const symbols = parser.extractSymbols('tests/fixtures/sample.ts', source);
    const fqns = symbols.map((s) => s.fqn);
    expect(fqns).toContain('UserService');
    expect(fqns).toContain('UserService.getUser');
    expect(fqns).toContain('UserService.createUser');
    expect(fqns).toContain('hashPassword');
    expect(fqns).toContain('IUserRepository');
    expect(fqns).toContain('UserId');
    expect(fqns).toContain('UserRole');
    expect(fqns).toContain('DEFAULT_ROLES');
  });
});

describe('TypeScriptParser.extractCallRefs', () => {
  it('extracts instantiation via new ClassName()', () => {
    const src = `export class OrderService {
  process() {
    const p = new Product();
  }
}
export class Product {}
`;
    const symbols = parser.extractSymbols('src/order.ts', src);
    const refs = parser.extractCallRefs!('src/order.ts', src, symbols);
    const inst = refs.find((r) => r.kind === 'instantiation' && r.targetName === 'Product');
    expect(inst).toBeDefined();
    expect(inst?.callerSymbolId).toBe('src/order.ts::OrderService.process');
  });

  it('extracts static call via Identifier.method()', () => {
    const src = `export class Handler {
  handle() {
    const r = Inventory.check(x);
  }
}
`;
    const symbols = parser.extractSymbols('src/handler.ts', src);
    const refs = parser.extractCallRefs!('src/handler.ts', src, symbols);
    const sc = refs.find((r) => r.kind === 'static_call' && r.targetName === 'Inventory.check');
    expect(sc).toBeDefined();
    expect(sc?.callerSymbolId).toBe('src/handler.ts::Handler.handle');
  });

  it('captures this.method() as intra-class call', () => {
    const src = `export class A {
  run() { this.init(); }
  init() {}
}
`;
    const symbols = parser.extractSymbols('src/a.ts', src);
    const refs = parser.extractCallRefs!('src/a.ts', src, symbols);
    const call = refs.find((r) => r.targetName === 'A.init');
    expect(call).toBeDefined();
    expect(call?.callerSymbolId).toBe('src/a.ts::A.run');
    expect(call?.kind).toBe('static_call');
  });

  it('skips super.method() calls', () => {
    const src = `export class Child extends Base {
  run() { super.run(); }
}
`;
    const symbols = parser.extractSymbols('src/child.ts', src);
    const refs = parser.extractCallRefs!('src/child.ts', src, symbols);
    expect(refs).toHaveLength(0);
  });

  it('does not capture chained this.prop.method() (DI calls)', () => {
    const src = `export class Service {
  run() { this.dependency.doWork(); }
}
`;
    const symbols = parser.extractSymbols('src/service.ts', src);
    const refs = parser.extractCallRefs!('src/service.ts', src, symbols);
    // this.dependency is a member_expression, not a bare `this` — no ref expected
    expect(refs.every((r) => !r.targetName.includes('doWork'))).toBe(true);
  });

  it('returns empty array when no calls exist', () => {
    const src = `export class Empty {}`;
    const symbols = parser.extractSymbols('src/empty.ts', src);
    const refs = parser.extractCallRefs!('src/empty.ts', src, symbols);
    expect(refs).toHaveLength(0);
  });

  it('sets line numbers on call refs', () => {
    const src = `export class A {
  go() {
    const b = new B();
  }
}
export class B {}
`;
    const symbols = parser.extractSymbols('src/a.ts', src);
    const refs = parser.extractCallRefs!('src/a.ts', src, symbols);
    const inst = refs.find((r) => r.targetName === 'B');
    expect(inst?.line).toBeGreaterThan(0);
  });
});
