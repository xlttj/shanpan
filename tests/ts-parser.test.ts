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
  });
});
