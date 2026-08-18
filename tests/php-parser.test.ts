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

  it('extracts static methods (EasyAdmin getEntityFqcn pattern)', () => {
    const source = `<?php
namespace App\\Controller\\Admin;
class TypeTransformationCrudController extends AbstractCrudController
{
    public static function getEntityFqcn(): string
    {
        return TypeTransformation::class;
    }
}
`;
    const symbols = parser.extractSymbols('src/Controller.php', source);
    expect(symbols.some((s) => s.fqn === 'TypeTransformationCrudController' && s.kind === 'class')).toBe(true);
    expect(symbols.some((s) => s.fqn === 'TypeTransformationCrudController.getEntityFqcn' && s.kind === 'method')).toBe(true);
  });

  it('extracts classes inside braced namespaces', () => {
    const source = `<?php
namespace App\\Models {
    class Order {
        public function total(): float { return 0.0; }
    }
}
`;
    const symbols = parser.extractSymbols('src/Order.php', source);
    expect(symbols.some((s) => s.fqn === 'Order' && s.kind === 'class')).toBe(true);
    expect(symbols.some((s) => s.fqn === 'Order.total' && s.kind === 'method')).toBe(true);
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

describe('PhpParser.extractCallRefs', () => {
  it('extracts instantiation via new ClassName()', () => {
    const source = `<?php
class Service {
  public function run() {
    $m = new Product();
  }
}
class Product {}
`;
    const symbols = parser.extractSymbols('src/Service.php', source);
    const refs = parser.extractCallRefs!('src/Service.php', source, symbols);
    const inst = refs.find((r) => r.kind === 'instantiation' && r.targetName === 'Product');
    expect(inst).toBeDefined();
    expect(inst?.callerSymbolId).toBe('src/Service.php::Service.run');
  });

  it('extracts static call via ClassName::method()', () => {
    const source = `<?php
class Handler {
  public function handle() {
    $r = Inventory::check();
  }
}
`;
    const symbols = parser.extractSymbols('src/Handler.php', source);
    const refs = parser.extractCallRefs!('src/Handler.php', source, symbols);
    const sc = refs.find((r) => r.kind === 'static_call' && r.targetName === 'Inventory.check');
    expect(sc).toBeDefined();
    expect(sc?.callerSymbolId).toBe('src/Handler.php::Handler.handle');
  });

  it('emits self:: as same-class and parent:: as parent-scoped; skips static::', () => {
    const source = `<?php
class Base {
  public function init() {
    self::boot();
    parent::init();
    static::setup();
  }
}
`;
    const symbols = parser.extractSymbols('src/Base.php', source);
    const refs = parser.extractCallRefs!('src/Base.php', source, symbols);
    expect(refs.map((r) => r.targetName).sort()).toEqual(['Base.boot', 'parent::init']);
  });

  it('handles qualified class names in new expression', () => {
    const source = `<?php
class Svc {
  public function run() {
    $x = new \\App\\Models\\User();
  }
}
`;
    const symbols = parser.extractSymbols('src/Svc.php', source);
    const refs = parser.extractCallRefs!('src/Svc.php', source, symbols);
    const inst = refs.find((r) => r.kind === 'instantiation' && r.targetName === 'User');
    expect(inst).toBeDefined();
  });

  it('captures $this->method() as intra-class call', () => {
    const source = `<?php
class Controller {
  public function handle() {
    $this->process();
  }
  public function process() {}
}
`;
    const symbols = parser.extractSymbols('src/Controller.php', source);
    const refs = parser.extractCallRefs!('src/Controller.php', source, symbols);
    const call = refs.find((r) => r.targetName === 'Controller.process');
    expect(call).toBeDefined();
    expect(call?.callerSymbolId).toBe('src/Controller.php::Controller.handle');
    expect(call?.kind).toBe('static_call');
  });

  it('captures multiple $this->method() calls from different callers', () => {
    const source = `<?php
class PreviewImageController {
  public function __invoke() { $this->handleRequest('a'); }
  public function pathBased() { $this->handleRequest('b'); }
  public function handleRequest(string $x) {}
}
`;
    const symbols = parser.extractSymbols('src/PreviewImageController.php', source);
    const refs = parser.extractCallRefs!('src/PreviewImageController.php', source, symbols);
    const invoke = refs.find(
      (r) => r.callerSymbolId.includes('__invoke') && r.targetName === 'PreviewImageController.handleRequest',
    );
    const pathBased = refs.find(
      (r) => r.callerSymbolId.includes('pathBased') && r.targetName === 'PreviewImageController.handleRequest',
    );
    expect(invoke).toBeDefined();
    expect(pathBased).toBeDefined();
  });

  it('does not capture chained $this->prop->method() (DI calls)', () => {
    const source = `<?php
class Service {
  public function run() {
    $this->dependency->doWork();
  }
}
`;
    const symbols = parser.extractSymbols('src/Service.php', source);
    const refs = parser.extractCallRefs!('src/Service.php', source, symbols);
    // $this->dependency is a member_access_expression, not $this directly — no ref expected
    expect(refs.every((r) => !r.targetName.includes('doWork'))).toBe(true);
  });

  it('returns empty array when no calls exist', () => {
    const source = `<?php\nclass Empty {}\n`;
    const symbols = parser.extractSymbols('src/Empty.php', source);
    const refs = parser.extractCallRefs!('src/Empty.php', source, symbols);
    expect(refs).toHaveLength(0);
  });

  it('sets line numbers on call refs', () => {
    const source = `<?php
class A {
  public function go() {
    $b = new B();
  }
}
class B {}
`;
    const symbols = parser.extractSymbols('src/A.php', source);
    const refs = parser.extractCallRefs!('src/A.php', source, symbols);
    const inst = refs.find((r) => r.targetName === 'B');
    expect(inst?.line).toBeGreaterThan(0);
  });
});

describe('PhpParser — calls on typed properties (dependency injection)', () => {
  const source = `<?php
class DeferredImageCache {
    public function flush(): void {}
}
class FlysystemImageCache {
    public function clearMemory(): void {}
}
class FlushListener {
    private DeferredImageCache $l1;
    public function __construct(private FlysystemImageCache $l2) {}
    public function onTerminate(): void {
        $this->l1->flush();
        $this->l2->clearMemory();
        $this->localHelper();
    }
    public function localHelper(): void {}
}
`;

  function refs() {
    const symbols = parser.extractSymbols('src/L.php', source);
    return parser.extractCallRefs!('src/L.php', source, symbols);
  }

  it('resolves a call on a declared typed property to Type.method', () => {
    const r = refs().find((c) => c.targetName === 'DeferredImageCache.flush');
    expect(r).toBeDefined();
    expect(r?.callerSymbolId).toBe('src/L.php::FlushListener.onTerminate');
  });

  it('resolves a call on a constructor-promoted property', () => {
    expect(refs().some((c) => c.targetName === 'FlysystemImageCache.clearMemory')).toBe(true);
  });

  it('still resolves same-class $this->method() calls', () => {
    expect(refs().some((c) => c.targetName === 'FlushListener.localHelper')).toBe(true);
  });

  it('does not resolve a property whose type is a union', () => {
    const src = `<?php
class C {
    private Foo|Bar $x;
    public function run(): void { $this->x->go(); }
}`;
    const symbols = parser.extractSymbols('src/C.php', src);
    const r = parser.extractCallRefs!('src/C.php', src, symbols);
    expect(r.some((c) => c.targetName.endsWith('.go'))).toBe(false);
  });
});

describe('PhpParser — parent:: / self:: scoped calls', () => {
  it('emits parent::method as a parent-scoped target and self:: as same-class', () => {
    const src = `<?php
class Base { public function m() {} }
class Child extends Base {
    public function m() { parent::m(); self::other(); static::skip(); }
    public function other() {}
}`;
    const symbols = parser.extractSymbols('src/c.php', src);
    const r = parser.extractCallRefs!('src/c.php', src, symbols);
    expect(r.some((c) => c.targetName === 'parent::m')).toBe(true);
    expect(r.some((c) => c.targetName === 'Child.other')).toBe(true);
    // static:: is late-static-bound — left unresolved.
    expect(r.some((c) => c.targetName.includes('skip'))).toBe(false);
  });
});
