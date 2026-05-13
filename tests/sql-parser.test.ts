import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SqlParser } from '../src/analyzer/languages/sql.js';

const parser = new SqlParser();

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'sample.sql');

describe('SqlParser', () => {
  it('has correct name and extensions', () => {
    expect(parser.name).toBe('sql');
    expect(parser.extensions).toContain('.sql');
  });

  it('does not implement extractCallRefs', () => {
    expect(parser.extractCallRefs).toBeUndefined();
  });

  it('extracts CREATE TABLE as table symbol', () => {
    const src = `CREATE TABLE orders (\n  id INT NOT NULL\n);`;
    const symbols = parser.extractSymbols('db/orders.sql', src);
    const sym = symbols.find((s) => s.fqn === 'orders');
    expect(sym).toBeDefined();
    expect(sym?.kind).toBe('table');
    expect(sym?.id).toBe('db/orders.sql::orders');
    expect(sym?.filePath).toBe('db/orders.sql');
    expect(sym?.language).toBe('sql');
  });

  it('extracts CREATE TABLE IF NOT EXISTS', () => {
    const src = `CREATE TABLE IF NOT EXISTS order_items (\n  id INT\n);`;
    const symbols = parser.extractSymbols('db/items.sql', src);
    expect(symbols.some((s) => s.fqn === 'order_items' && s.kind === 'table')).toBe(true);
  });

  it('extracts CREATE TEMPORARY TABLE', () => {
    const src = `CREATE TEMPORARY TABLE tmp_results (id INT);`;
    const symbols = parser.extractSymbols('db/tmp.sql', src);
    expect(symbols.some((s) => s.fqn === 'tmp_results' && s.kind === 'table')).toBe(true);
  });

  it('strips schema prefix from table name', () => {
    const src = `CREATE TABLE inventory.stock_levels (\n  product_id INT\n);`;
    const symbols = parser.extractSymbols('db/stock.sql', src);
    expect(symbols.some((s) => s.fqn === 'stock_levels' && s.kind === 'table')).toBe(true);
  });

  it('strips backtick quoting from table name', () => {
    const src = 'CREATE TABLE `order_items` (\n  id INT\n);';
    const symbols = parser.extractSymbols('db/items.sql', src);
    expect(symbols.some((s) => s.fqn === 'order_items' && s.kind === 'table')).toBe(true);
  });

  it('extracts CREATE VIEW as view symbol', () => {
    const src = `CREATE VIEW pending_orders AS SELECT id FROM orders WHERE status='pending';`;
    const symbols = parser.extractSymbols('db/views.sql', src);
    expect(symbols.some((s) => s.fqn === 'pending_orders' && s.kind === 'view')).toBe(true);
  });

  it('extracts CREATE OR REPLACE VIEW', () => {
    const src = `CREATE OR REPLACE VIEW order_summary AS SELECT id FROM orders;`;
    const symbols = parser.extractSymbols('db/views.sql', src);
    expect(symbols.some((s) => s.fqn === 'order_summary' && s.kind === 'view')).toBe(true);
  });

  it('extracts CREATE MATERIALIZED VIEW', () => {
    const src = `CREATE MATERIALIZED VIEW mv_daily_sales AS SELECT date, SUM(total) FROM orders GROUP BY date;`;
    const symbols = parser.extractSymbols('db/views.sql', src);
    expect(symbols.some((s) => s.fqn === 'mv_daily_sales' && s.kind === 'view')).toBe(true);
  });

  it('extracts CREATE FUNCTION as function symbol', () => {
    const src = `CREATE FUNCTION calculate_tax(amount INT) RETURNS INT\nBEGIN RETURN amount * 0.19; END;`;
    const symbols = parser.extractSymbols('db/fn.sql', src);
    expect(symbols.some((s) => s.fqn === 'calculate_tax' && s.kind === 'function')).toBe(true);
  });

  it('extracts CREATE OR REPLACE FUNCTION', () => {
    const src = `CREATE OR REPLACE FUNCTION format_money(cents BIGINT) RETURNS TEXT LANGUAGE plpgsql AS $$ BEGIN END; $$;`;
    const symbols = parser.extractSymbols('db/fn.sql', src);
    expect(symbols.some((s) => s.fqn === 'format_money' && s.kind === 'function')).toBe(true);
  });

  it('extracts CREATE PROCEDURE as procedure symbol', () => {
    const src = `CREATE PROCEDURE confirm_order(IN p_id BIGINT)\nBEGIN UPDATE orders SET status='confirmed' WHERE id=p_id; END;`;
    const symbols = parser.extractSymbols('db/procs.sql', src);
    expect(symbols.some((s) => s.fqn === 'confirm_order' && s.kind === 'procedure')).toBe(true);
  });

  it('extracts CREATE OR REPLACE PROCEDURE', () => {
    const src = `CREATE OR REPLACE PROCEDURE cancel_order(p_id BIGINT) LANGUAGE plpgsql AS $$ BEGIN END; $$;`;
    const symbols = parser.extractSymbols('db/procs.sql', src);
    expect(symbols.some((s) => s.fqn === 'cancel_order' && s.kind === 'procedure')).toBe(true);
  });

  it('extracts CREATE TRIGGER as trigger symbol', () => {
    const src = `CREATE TRIGGER trg_order_updated\nAFTER UPDATE ON orders FOR EACH ROW BEGIN END;`;
    const symbols = parser.extractSymbols('db/triggers.sql', src);
    expect(symbols.some((s) => s.fqn === 'trg_order_updated' && s.kind === 'trigger')).toBe(true);
  });

  it('extracts CREATE OR REPLACE TRIGGER', () => {
    const src = `CREATE OR REPLACE TRIGGER trg_stock_check\nBEFORE INSERT ON order_items FOR EACH ROW EXECUTE FUNCTION check_stock();`;
    const symbols = parser.extractSymbols('db/triggers.sql', src);
    expect(symbols.some((s) => s.fqn === 'trg_stock_check' && s.kind === 'trigger')).toBe(true);
  });

  it('ignores comment lines', () => {
    const src = `-- CREATE TABLE ghost (id INT);\nCREATE TABLE real_table (id INT);`;
    const symbols = parser.extractSymbols('db/x.sql', src);
    expect(symbols.every((s) => s.fqn !== 'ghost')).toBe(true);
    expect(symbols.some((s) => s.fqn === 'real_table')).toBe(true);
  });

  it('ignores ALTER and DROP statements', () => {
    const src = `ALTER TABLE orders ADD COLUMN note TEXT;\nDROP TABLE tmp;\nCREATE TABLE keepers (id INT);`;
    const symbols = parser.extractSymbols('db/x.sql', src);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].fqn).toBe('keepers');
  });

  it('sets correct lineStart', () => {
    const src = `\nCREATE TABLE late_table (\n  id INT\n);`;
    const symbols = parser.extractSymbols('db/x.sql', src);
    const sym = symbols.find((s) => s.fqn === 'late_table');
    expect(sym?.lineStart).toBe(2);
  });

  it('sets lineEnd to cover multi-line body up to next symbol', () => {
    const src = [
      'CREATE TABLE a (', //  1
      '  id INT',         //  2
      ');',               //  3
      'CREATE TABLE b (', //  4
      '  id INT',         //  5
      ');',               //  6
    ].join('\n');
    const symbols = parser.extractSymbols('db/x.sql', src);
    const a = symbols.find((s) => s.fqn === 'a');
    const b = symbols.find((s) => s.fqn === 'b');
    expect(a?.lineEnd).toBe(3);
    expect(b?.lineEnd).toBe(6);
  });

  it('parses the sample fixture', () => {
    const source = fs.readFileSync(FIXTURE, 'utf-8');
    const symbols = parser.extractSymbols('tests/fixtures/sample.sql', source);
    const fqns = symbols.map((s) => s.fqn);

    expect(fqns).toContain('orders');
    expect(fqns).toContain('order_items');
    expect(fqns).toContain('stock_levels');
    expect(fqns).toContain('pending_orders');
    expect(fqns).toContain('order_summary');
    expect(fqns).toContain('calculate_tax');
    expect(fqns).toContain('format_money');
    expect(fqns).toContain('confirm_order');
    expect(fqns).toContain('cancel_order');
    expect(fqns).toContain('trg_order_updated');
    expect(fqns).toContain('trg_stock_check');

    const orders = symbols.find((s) => s.fqn === 'orders');
    expect(orders?.kind).toBe('table');
    expect(orders?.language).toBe('sql');
  });
});
