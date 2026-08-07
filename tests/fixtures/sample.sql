-- Sample SQL fixture for shanpan parser tests
-- Covers: table, view, function, procedure, trigger across dialects

-- ── Tables ────────────────────────────────────────────────────────────────────

CREATE TABLE orders (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    customer_id BIGINT UNSIGNED NOT NULL,
    status      ENUM('pending','confirmed','shipped','cancelled') NOT NULL DEFAULT 'pending',
    total_cents INT NOT NULL DEFAULT 0,
    created_at  DATETIME NOT NULL,
    PRIMARY KEY (id),
    INDEX idx_customer (customer_id)
);

CREATE TABLE IF NOT EXISTS order_items (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    order_id   BIGINT UNSIGNED NOT NULL,
    product_id BIGINT UNSIGNED NOT NULL,
    quantity   INT NOT NULL DEFAULT 1,
    unit_price INT NOT NULL,
    PRIMARY KEY (id)
);

-- Schema-qualified table (PostgreSQL / SQL Server style)
CREATE TABLE inventory.stock_levels (
    product_id INT NOT NULL,
    warehouse  VARCHAR(50) NOT NULL,
    quantity   INT NOT NULL DEFAULT 0,
    PRIMARY KEY (product_id, warehouse)
);

-- ── Views ─────────────────────────────────────────────────────────────────────

CREATE VIEW pending_orders AS
    SELECT o.id, o.customer_id, o.total_cents
    FROM orders o
    WHERE o.status = 'pending';

CREATE OR REPLACE VIEW order_summary AS
    SELECT o.id,
           COUNT(i.id) AS item_count,
           SUM(i.unit_price * i.quantity) AS subtotal
    FROM orders o
    JOIN order_items i ON i.order_id = o.id
    GROUP BY o.id;

-- ── Functions ─────────────────────────────────────────────────────────────────

CREATE FUNCTION calculate_tax(amount_cents INT, rate_bps INT)
RETURNS INT DETERMINISTIC
BEGIN
    RETURN FLOOR(amount_cents * rate_bps / 10000);
END;

CREATE OR REPLACE FUNCTION format_money(cents BIGINT)
RETURNS TEXT LANGUAGE plpgsql AS $$
BEGIN
    RETURN TO_CHAR(cents / 100.0, 'FM999,999,990.00');
END;
$$;

-- ── Stored Procedures ─────────────────────────────────────────────────────────

CREATE PROCEDURE confirm_order(IN p_order_id BIGINT)
BEGIN
    UPDATE orders SET status = 'confirmed' WHERE id = p_order_id;
END;

CREATE OR REPLACE PROCEDURE cancel_order(p_order_id BIGINT, p_reason TEXT)
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE orders SET status = 'cancelled' WHERE id = p_order_id;
    INSERT INTO order_audit(order_id, action, reason, created_at)
    VALUES (p_order_id, 'cancel', p_reason, NOW());
END;
$$;

-- ── Triggers ──────────────────────────────────────────────────────────────────

CREATE TRIGGER trg_order_updated
AFTER UPDATE ON orders
FOR EACH ROW
BEGIN
    INSERT INTO order_audit(order_id, action, created_at)
    VALUES (NEW.id, 'update', NOW());
END;

CREATE OR REPLACE TRIGGER trg_stock_check
BEFORE INSERT ON order_items
FOR EACH ROW
EXECUTE FUNCTION check_stock_availability();
