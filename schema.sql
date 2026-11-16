-- WhOM schema (MySQL 5.7+ / MariaDB 10.3+). Generated from server.php migrate().
-- You normally do NOT need this: tables are created automatically (AUTO_MIGRATE=true).
-- Use it to import by hand in phpMyAdmin / Clever Cloud's Adminer.
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS users (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    full_name VARCHAR(80) NOT NULL,
    email VARCHAR(190) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at DATETIME NOT NULL,
    UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stores (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    owner_id INT UNSIGNED NOT NULL,
    name VARCHAR(80) NOT NULL,
    slug VARCHAR(60) NOT NULL,
    description TEXT NULL,
    category VARCHAR(60) NULL,
    location VARCHAR(120) NULL,
    whatsapp_number VARCHAR(24) NOT NULL,
    currency VARCHAR(8) NOT NULL DEFAULT '₦',
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY uq_stores_owner (owner_id),
    UNIQUE KEY uq_stores_slug (slug),
    CONSTRAINT fk_stores_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS products (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    store_id INT UNSIGNED NOT NULL,
    name VARCHAR(120) NOT NULL,
    price INT UNSIGNED NOT NULL,
    stock INT UNSIGNED NOT NULL DEFAULT 0,
    category VARCHAR(60) NULL,
    description TEXT NULL,
    image_url VARCHAR(500) NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL,
    KEY idx_products_store (store_id, is_active),
    CONSTRAINT fk_products_store FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS orders (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    store_id INT UNSIGNED NOT NULL,
    customer_name VARCHAR(80) NOT NULL,
    customer_phone VARCHAR(24) NOT NULL,
    delivery_address VARCHAR(300) NOT NULL,
    note VARCHAR(300) NULL,
    total BIGINT UNSIGNED NOT NULL,
    status VARCHAR(12) NOT NULL DEFAULT 'New',
    created_at DATETIME NOT NULL,
    KEY idx_orders_store_created (store_id, created_at),
    KEY idx_orders_store_status (store_id, status),
    CONSTRAINT fk_orders_store FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS order_items (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    order_id INT UNSIGNED NOT NULL,
    product_id INT UNSIGNED NULL,
    name VARCHAR(120) NOT NULL,
    qty INT UNSIGNED NOT NULL,
    price INT UNSIGNED NOT NULL,
    KEY idx_items_order (order_id),
    CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    CONSTRAINT fk_items_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rate_limits (
    k VARCHAR(100) NOT NULL PRIMARY KEY,
    hits INT UNSIGNED NOT NULL,
    reset_at DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
