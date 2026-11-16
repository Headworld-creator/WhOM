<?php
/**
 * WhOM — single-file PHP backend.
 *
 * Requirements : PHP 8.1+ with pdo_mysql, mbstring, openssl. No Composer.
 * Dev          : XAMPP (Apache + MySQL/MariaDB) or `php -S localhost:8000 server.php`
 * Production   : Docker on Render  +  MySQL add-on on Clever Cloud
 *
 * Request flow : .htaccess rewrites /api/* and /store/* to this file.
 * Config       : environment variables win; a local .env file is the fallback.
 * Schema       : created automatically on first request (AUTO_MIGRATE=true),
 *                or manually with `php server.php migrate` / schema.sql.
 *
 * Ownership model (enforced in every query):
 *   user -> store (1:1) -> products -> orders -> order_items
 */
declare(strict_types=1);

// ───────────────────────── php -S convenience (dev only) ─────────────────────────
if (PHP_SAPI === 'cli-server') {
    $p = rawurldecode((string) parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH));
    if (!preg_match('#^/(api|store)(/|$)#', $p)) {
        if ($p === '/') return false;                       // serves index.html
        $blocked = '#(^|/)\.|\.(php|sql|md|ya?ml|sh)$|Dockerfile#i';
        if (is_file(__DIR__ . $p) && !preg_match($blocked, $p)) return false; // static file
        http_response_code(404);
        echo 'Not found';
        return;
    }
}

const APP_VERSION = '1.0.0';
const ORDER_STATUSES = ['New', 'Preparing', 'Delivered'];

// ═════════════════════════════════ Config / env ═════════════════════════════════

/** Parse a .env file once. Real environment variables always take precedence. */
function env_file(): array
{
    static $vars = null;
    if ($vars !== null) return $vars;
    $vars = [];
    $file = __DIR__ . '/.env';
    if (!is_readable($file)) return $vars;
    foreach (file($file, FILE_IGNORE_NEW_LINES) ?: [] as $line) {
        $line = trim($line);
        if ($line === '' || $line[0] === '#') continue;
        if (str_starts_with($line, 'export ')) $line = ltrim(substr($line, 7));
        if (!str_contains($line, '=')) continue;
        [$k, $v] = explode('=', $line, 2);
        $k = trim($k);
        $v = trim($v);
        if ($v !== '' && ($v[0] === '"' || $v[0] === "'") && substr($v, -1) === $v[0] && strlen($v) >= 2) {
            $v = substr($v, 1, -1);
        } else {
            $v = trim(preg_replace('/\s+#.*$/', '', $v));  // strip trailing " # comment"
        }
        $vars[$k] = $v;
    }
    return $vars;
}

function env(string $key, ?string $default = null): ?string
{
    $v = getenv($key);
    if ($v !== false && $v !== '') return $v;
    $f = env_file();
    if (isset($f[$key]) && $f[$key] !== '') return $f[$key];
    return $default;
}

function env_bool(string $key, bool $default = false): bool
{
    $v = env($key);
    if ($v === null) return $default;
    return in_array(strtolower($v), ['1', 'true', 'yes', 'on'], true);
}

function is_debug(): bool
{
    return env_bool('APP_DEBUG', false);
}

// ═════════════════════════════════ Errors / output ═════════════════════════════

final class HttpError extends Exception
{
    public function __construct(public int $status, string $message, public array $details = [], public array $headers = [])
    {
        parent::__construct($message);
    }
}

/** Throw a 422 tied to a field. */
function fail(string $field, string $message): never
{
    $label = ucfirst(str_replace('_', ' ', $field));
    throw new HttpError(422, "$label $message", [$field => $message]);
}

function send_headers_common(): void
{
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: strict-origin-when-cross-origin');
    header('Cache-Control: no-store');
}

function send_cors(): void
{
    $allowed = trim((string) env('CORS_ORIGINS', ''));
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($allowed === '' || $origin === '') return;   // same-origin deployments need no CORS
    $list = array_filter(array_map(fn($o) => rtrim(trim($o), '/'), explode(',', $allowed)));
    if (in_array('*', $list, true)) {
        header('Access-Control-Allow-Origin: *');
    } elseif (in_array(rtrim($origin, '/'), $list, true)) {
        header('Access-Control-Allow-Origin: ' . $origin);
        header('Vary: Origin');
    } else {
        return;
    }
    header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, OPTIONS');
    header('Access-Control-Allow-Headers: Authorization, Content-Type');
    header('Access-Control-Max-Age: 86400');
}

function emit(int $status, mixed $data, array $headers = []): never
{
    http_response_code($status);
    foreach ($headers as $k => $v) header("$k: $v");
    if ($status === 204) exit;
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

// ═════════════════════════════════ Database ═════════════════════════════════════

function db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) return $pdo;

    $dsn = env('DB_DSN');   // full DSN override (used by the automated tests)
    $user = null;
    $pass = null;
    if (!$dsn) {
        // DB_* first, Clever Cloud's MYSQL_ADDON_* as fallback (works with zero renaming).
        $host = env('DB_HOST') ?? env('MYSQL_ADDON_HOST') ?? '127.0.0.1';
        $port = env('DB_PORT') ?? env('MYSQL_ADDON_PORT') ?? '3306';
        $name = env('DB_NAME') ?? env('MYSQL_ADDON_DB') ?? 'whom';
        $user = env('DB_USER') ?? env('MYSQL_ADDON_USER') ?? 'root';
        $pass = env('DB_PASSWORD') ?? env('MYSQL_ADDON_PASSWORD') ?? '';
        $dsn = "mysql:host=$host;port=$port;dbname=$name;charset=utf8mb4";
    }
    $opts = [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
        PDO::ATTR_TIMEOUT => 10,
    ];
    if (str_starts_with($dsn, 'mysql:') && ($ca = env('DB_SSL_CA'))) {
        $opts[PDO::MYSQL_ATTR_SSL_CA] = $ca;
    }
    try {
        $pdo = new PDO($dsn, $user, $pass, $opts);
    } catch (PDOException $e) {
        error_log('[whom] DB connect failed: ' . $e->getMessage());
        throw new HttpError(503, is_debug() ? 'Database unavailable: ' . $e->getMessage() : 'Database unavailable');
    }
    if ($pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite') $pdo->exec('PRAGMA foreign_keys = ON');
    return $pdo;
}

function is_mysql(): bool
{
    return db()->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql';
}

/** Prepared statement with typed binding. */
function q(string $sql, array $params = []): PDOStatement
{
    $st = db()->prepare($sql);
    $i = 1;
    foreach ($params as $v) {
        $type = is_int($v) || is_bool($v) ? PDO::PARAM_INT : (is_null($v) ? PDO::PARAM_NULL : PDO::PARAM_STR);
        $st->bindValue($i++, is_bool($v) ? (int) $v : $v, $type);
    }
    $st->execute();
    return $st;
}

function now_utc(): string
{
    return gmdate('Y-m-d H:i:s');
}

function iso(?string $dt): ?string
{
    return $dt ? str_replace(' ', 'T', $dt) . 'Z' : null;
}

function is_unique_violation(PDOException $e): bool
{
    return $e->getCode() === '23000' || str_contains($e->getMessage(), 'UNIQUE constraint');
}

/** Create all tables, in dependency order. Idempotent. */
function migrate(): void
{
    $ddl = [
        "CREATE TABLE IF NOT EXISTS users (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            full_name VARCHAR(80) NOT NULL,
            email VARCHAR(190) NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            created_at DATETIME NOT NULL,
            UNIQUE KEY uq_users_email (email)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

        "CREATE TABLE IF NOT EXISTS stores (
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

        "CREATE TABLE IF NOT EXISTS products (
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

        "CREATE TABLE IF NOT EXISTS orders (
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

        "CREATE TABLE IF NOT EXISTS order_items (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            order_id INT UNSIGNED NOT NULL,
            product_id INT UNSIGNED NULL,
            name VARCHAR(120) NOT NULL,
            qty INT UNSIGNED NOT NULL,
            price INT UNSIGNED NOT NULL,
            KEY idx_items_order (order_id),
            CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
            CONSTRAINT fk_items_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

        "CREATE TABLE IF NOT EXISTS rate_limits (
            k VARCHAR(100) NOT NULL PRIMARY KEY,
            hits INT UNSIGNED NOT NULL,
            reset_at DATETIME NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    ];
    foreach ($ddl as $sql) db()->exec($sql);

    // Additive WhOM Plus migration. Existing tables and records are preserved.
    $addColumn = function (string $table, string $column, string $mysql, string $sqlite) {
        $exists = false;
        if (is_mysql()) {
            $exists = (bool) q('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [$table, $column])->fetchColumn();
        } else {
            foreach (q("PRAGMA table_info($table)")->fetchAll() as $col) if ($col['name'] === $column) $exists = true;
        }
        if (!$exists) db()->exec('ALTER TABLE ' . $table . ' ADD COLUMN ' . $column . ' ' . (is_mysql() ? $mysql : $sqlite));
    };
    $addColumn('stores', 'tagline', 'VARCHAR(100) NULL', 'TEXT NULL');
    $addColumn('stores', 'logo_url', 'VARCHAR(500) NULL', 'TEXT NULL');
    $addColumn('stores', 'cover_url', 'VARCHAR(500) NULL', 'TEXT NULL');
    $addColumn('stores', 'opening_hours', 'VARCHAR(500) NULL', 'TEXT NULL');
    $addColumn('stores', 'delivery_info', 'VARCHAR(300) NULL', 'TEXT NULL');
    $addColumn('stores', 'instagram', 'VARCHAR(120) NULL', 'TEXT NULL');
    $addColumn('stores', 'accent_color', 'VARCHAR(7) NULL', 'TEXT NULL');
    $addColumn('stores', 'accepting_orders', 'TINYINT(1) NOT NULL DEFAULT 1', 'INTEGER NOT NULL DEFAULT 1');
    $addColumn('orders', 'payment_status', "VARCHAR(20) NOT NULL DEFAULT 'unpaid'", "TEXT NOT NULL DEFAULT 'unpaid'");
    $addColumn('orders', 'tracking_token', 'VARCHAR(64) NULL', 'TEXT NULL');
    $addColumn('orders', 'customer_id', 'INT UNSIGNED NULL', 'INTEGER NULL');
    db()->exec("CREATE TABLE IF NOT EXISTS customers (
        id " . (is_mysql() ? 'INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT') . ",
        store_id INT NOT NULL, full_name VARCHAR(80) NOT NULL, phone VARCHAR(24) NOT NULL,
        normalized_phone VARCHAR(24) NOT NULL, default_address VARCHAR(300) NULL,
        created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL,
        UNIQUE(store_id, normalized_phone)
    )" . (is_mysql() ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : ''));
    db()->exec("CREATE TABLE IF NOT EXISTS payments (
        id " . (is_mysql() ? 'INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT') . ",
        order_id INT NOT NULL, reference VARCHAR(100) NOT NULL UNIQUE, amount BIGINT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending', provider VARCHAR(30) NOT NULL DEFAULT 'paystack',
        created_at DATETIME NOT NULL
    )" . (is_mysql() ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : ''));
}

// ═════════════════════════════════ Input helpers ═══════════════════════════════

function body(): array
{
    static $cached = null;
    if ($cached !== null) return $cached;
    $raw = file_get_contents('php://input', false, null, 0, 1_000_001);
    if ($raw === false || trim($raw) === '') return $cached = [];
    if (strlen($raw) > 1_000_000) throw new HttpError(413, 'Request body too large');
    $data = json_decode($raw, true);
    if (!is_array($data) || array_is_list($data) && $data !== []) {
        throw new HttpError(400, 'Request body must be a JSON object');
    }
    return $cached = $data;
}

function str_field(array $b, string $k, int $min, int $max, bool $multiline = false): string
{
    $v = $b[$k] ?? '';
    if ($v === null) $v = '';
    if (is_int($v) || is_float($v)) $v = (string) $v;
    if (!is_string($v)) fail($k, 'must be text');
    $v = trim(str_replace("\r\n", "\n", $v));
    if (!mb_check_encoding($v, 'UTF-8')) fail($k, 'has invalid characters');
    if (preg_match($multiline ? '/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/' : '/[\x00-\x1F\x7F]/', $v)) {
        fail($k, 'has invalid characters');
    }
    $len = mb_strlen($v);
    if ($len < $min) fail($k, $min <= 1 ? 'is required' : "must be at least $min characters");
    if ($len > $max) fail($k, "must be at most $max characters");
    return $v;
}

function nullable(string $s): ?string
{
    return $s === '' ? null : $s;
}

function int_field(array $b, string $k, int $min, int $max): int
{
    if (!array_key_exists($k, $b) || $b[$k] === '' || $b[$k] === null) fail($k, 'is required');
    $v = $b[$k];
    if (is_string($v) && preg_match('/^-?\d+$/', trim($v))) $v = (int) trim($v);
    if (is_float($v) && floor($v) === $v) $v = (int) $v;
    if (!is_int($v)) fail($k, 'must be a whole number');
    if ($v < $min || $v > $max) fail($k, "must be between $min and $max");
    return $v;
}

function email_field(array $b): string
{
    $e = strtolower(str_field($b, 'email', 1, 190));
    if (!filter_var($e, FILTER_VALIDATE_EMAIL)) fail('email', 'is not a valid email address');
    return $e;
}

/** "0801 234 5678" / "+234 801…" / "2348012345678" → "+2348012345678". */
function normalize_phone(string $raw): ?string
{
    $raw = trim($raw);
    $plus = str_starts_with($raw, '+');
    $d = preg_replace('/\D+/', '', $raw) ?? '';
    if ($d === '') return null;
    $cc = preg_replace('/\D+/', '', (string) env('DEFAULT_COUNTRY_CODE', '234')) ?: '234';
    if (!$plus) {
        if (str_starts_with($d, '00')) $d = substr($d, 2);
        elseif (str_starts_with($d, '0')) $d = $cc . substr($d, 1);
        elseif (strlen($d) <= 10) $d = $cc . $d;
    }
    return strlen($d) >= 8 && strlen($d) <= 15 ? '+' . $d : null;
}

function phone_field(array $b, string $k): string
{
    $raw = str_field($b, $k, 1, 30);
    $p = normalize_phone($raw);
    if ($p === null) fail($k, 'is not a valid phone number');
    return $p;
}

function url_field(array $b, string $k): ?string
{
    $v = str_field($b, $k, 0, 500);
    if ($v === '') return null;
    if (!preg_match('#^https?://[^\s]+$#i', $v) || !filter_var($v, FILTER_VALIDATE_URL)) {
        fail($k, 'must be a valid http(s) link');
    }
    return $v;
}

function slugify(string $s): string
{
    $s = mb_strtolower(trim($s), 'UTF-8');
    if (function_exists('iconv')) {
        $t = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s);
        if ($t !== false && $t !== '') $s = $t;
    }
    $s = trim((string) preg_replace('/[^a-z0-9]+/', '-', $s), '-');
    return $s === '' ? 'store' : substr($s, 0, 50);
}

function unique_slug(string $name): string
{
    $base = slugify($name);
    $slug = $base;
    for ($i = 2; q('SELECT 1 FROM stores WHERE slug = ?', [$slug])->fetchColumn(); $i++) {
        $slug = $i > 30 ? $base . '-' . bin2hex(random_bytes(3)) : $base . '-' . $i;
        if ($i > 30) break;
    }
    return $slug;
}

// ═════════════════════════════════ Rate limiting ═══════════════════════════════

function client_ip(): string
{
    if (env_bool('TRUST_PROXY') && !empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
        return trim(explode(',', $_SERVER['HTTP_X_FORWARDED_FOR'])[0]);
    }
    return $_SERVER['REMOTE_ADDR'] ?? 'cli';
}

/** Fixed-window limiter per IP. Approximate by design (no locking). */
function rate_limit(string $bucket, int $max, int $windowSec): void
{
    if (!env_bool('RATE_LIMIT', true)) return;
    $key = substr($bucket . ':' . hash('sha256', client_ip()), 0, 100);
    $now = now_utc();
    $row = q('SELECT hits, reset_at FROM rate_limits WHERE k = ?', [$key])->fetch();
    if (!$row || $row['reset_at'] <= $now) {
        q('DELETE FROM rate_limits WHERE k = ?', [$key]);
        try {
            q('INSERT INTO rate_limits (k, hits, reset_at) VALUES (?, 1, ?)', [$key, gmdate('Y-m-d H:i:s', time() + $windowSec)]);
        } catch (PDOException $e) { /* concurrent insert: fine */ }
        if (random_int(1, 50) === 1) q('DELETE FROM rate_limits WHERE reset_at <= ?', [$now]);
        return;
    }
    if ((int) $row['hits'] >= $max) {
        $retry = max(1, strtotime($row['reset_at'] . ' UTC') - time());
        throw new HttpError(429, 'Too many attempts. Please try again later.', [], ['Retry-After' => (string) $retry]);
    }
    q('UPDATE rate_limits SET hits = hits + 1 WHERE k = ?', [$key]);
}

// ═════════════════════════════════ JWT (HS256) ═════════════════════════════════

function b64u(string $s): string
{
    return rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
}

function b64u_dec(string $s): string|false
{
    return base64_decode(strtr($s, '-_', '+/'), true);
}

function jwt_secret(): string
{
    $s = (string) env('JWT_SECRET', '');
    $local = env('APP_ENV', 'production') === 'local';
    if ($s === '' || (!$local && (strlen($s) < 32 || str_starts_with($s, 'change-me')))) {
        error_log('[whom] JWT_SECRET missing/weak. Generate one: php -r "echo bin2hex(random_bytes(32));"');
        throw new HttpError(500, 'Server misconfigured: JWT_SECRET must be set (32+ characters)');
    }
    return $s;
}

function jwt_ttl(): int
{
    return max(1, (int) env('JWT_TTL_DAYS', '7')) * 86400;
}

function jwt_encode(int $userId): string
{
    $h = b64u(json_encode(['alg' => 'HS256', 'typ' => 'JWT']));
    $p = b64u(json_encode(['sub' => (string) $userId, 'iat' => time(), 'exp' => time() + jwt_ttl()]));
    return "$h.$p." . b64u(hash_hmac('sha256', "$h.$p", jwt_secret(), true));
}

function jwt_decode(string $token): ?int
{
    $parts = explode('.', $token);
    if (count($parts) !== 3) return null;
    [$h, $p, $s] = $parts;
    $header = json_decode((string) b64u_dec($h), true);
    if (!is_array($header) || ($header['alg'] ?? '') !== 'HS256') return null;
    if (!hash_equals(b64u(hash_hmac('sha256', "$h.$p", jwt_secret(), true)), $s)) return null;
    $claims = json_decode((string) b64u_dec($p), true);
    if (!is_array($claims) || (int) ($claims['exp'] ?? 0) < time()) return null;
    $sub = $claims['sub'] ?? null;
    return is_string($sub) && ctype_digit($sub) ? (int) $sub : null;
}

function bearer_token(): ?string
{
    $h = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? null;
    if (!$h && function_exists('getallheaders')) {
        foreach (getallheaders() as $k => $v) if (strcasecmp($k, 'Authorization') === 0) $h = $v;
    }
    return $h && preg_match('/^Bearer\s+(\S+)$/i', trim($h), $m) ? $m[1] : null;
}

function current_user(): array
{
    $tok = bearer_token();
    $id = $tok ? jwt_decode($tok) : null;
    $u = $id ? q('SELECT id, full_name, email FROM users WHERE id = ?', [$id])->fetch() : false;
    if (!$u) throw new HttpError(401, 'Authentication required');
    return $u;
}

// ═════════════════════════════════ Serializers ═════════════════════════════════

function user_out(array $u): array
{
    return ['id' => (int) $u['id'], 'full_name' => $u['full_name'], 'email' => $u['email']];
}

function store_out(array $s, bool $public = false): array
{
    $o = [
        'id' => (int) $s['id'], 'name' => $s['name'], 'slug' => $s['slug'],
        'description' => $s['description'], 'category' => $s['category'], 'location' => $s['location'],
        'whatsapp_number' => $s['whatsapp_number'], 'currency' => $s['currency'], 'created_at' => iso($s['created_at']),
        'tagline' => $s['tagline'] ?? null, 'logo_url' => $s['logo_url'] ?? null, 'cover_url' => $s['cover_url'] ?? null,
        'opening_hours' => $s['opening_hours'] ?? null, 'delivery_info' => $s['delivery_info'] ?? null,
        'instagram' => $s['instagram'] ?? null, 'accent_color' => $s['accent_color'] ?? null,
        'accepting_orders' => (bool) ($s['accepting_orders'] ?? true),
    ];
    if (!$public) $o['owner_id'] = (int) $s['owner_id'];
    return $o;
}

function product_out(array $p): array
{
    return [
        'id' => (int) $p['id'], 'store_id' => (int) $p['store_id'], 'name' => $p['name'],
        'price' => (int) $p['price'], 'stock' => (int) $p['stock'], 'category' => $p['category'],
        'description' => $p['description'], 'image_url' => $p['image_url'],
        'is_active' => (bool) $p['is_active'], 'created_at' => iso($p['created_at']),
    ];
}

/** Attach items to a list of order rows (one extra query, not N). */
function orders_out(array $rows): array
{
    if (!$rows) return [];
    $ids = array_map(fn($r) => (int) $r['id'], $rows);
    $in = implode(',', array_fill(0, count($ids), '?'));
    $items = [];
    foreach (q("SELECT id, order_id, product_id, name, qty, price FROM order_items WHERE order_id IN ($in) ORDER BY id", $ids)->fetchAll() as $i) {
        $items[(int) $i['order_id']][] = [
            'id' => (int) $i['id'], 'product_id' => $i['product_id'] === null ? null : (int) $i['product_id'],
            'name' => $i['name'], 'qty' => (int) $i['qty'], 'price' => (int) $i['price'],
        ];
    }
    return array_map(fn($r) => [
        'id' => (int) $r['id'], 'store_id' => (int) $r['store_id'], 'customer_name' => $r['customer_name'],
        'customer_phone' => $r['customer_phone'], 'delivery_address' => $r['delivery_address'], 'note' => $r['note'],
        'total' => (int) $r['total'], 'status' => $r['status'], 'payment_status' => $r['payment_status'] ?? 'unpaid',
        'tracking_token' => $r['tracking_token'] ?? null, 'created_at' => iso($r['created_at']),
        'items' => $items[(int) $r['id']] ?? [],
    ], $rows);
}

function owner_store(array $user): ?array
{
    $s = q('SELECT * FROM stores WHERE owner_id = ?', [(int) $user['id']])->fetch();
    return $s ?: null;
}

function require_store(array $user): array
{
    return owner_store($user) ?? throw new HttpError(400, 'Create your store first');
}

// ═════════════════════════════════ Handlers: system / auth ═════════════════════

function h_health(): array
{
    q('SELECT 1 FROM users LIMIT 1');   // also triggers auto-migrate on a fresh database
    return [200, ['status' => 'ok', 'db' => true, 'version' => APP_VERSION]];
}

function auth_response(array $user, int $status): array
{
    return [$status, [
        'access_token' => jwt_encode((int) $user['id']),
        'token_type' => 'bearer',
        'expires_in' => jwt_ttl(),
        'user' => user_out($user),
    ]];
}

function h_register(): array
{
    rate_limit('register', 10, 3600);
    $b = body();
    $name = str_field($b, 'full_name', 2, 80);
    $email = email_field($b);
    $pw = (string) ($b['password'] ?? '');
    if (strlen($pw) < 8) fail('password', 'must be at least 8 characters');
    if (strlen($pw) > 72) fail('password', 'must be at most 72 characters');

    if (q('SELECT 1 FROM users WHERE email = ?', [$email])->fetchColumn()) {
        throw new HttpError(409, 'An account with this email already exists', ['email' => 'already registered']);
    }
    try {
        q('INSERT INTO users (full_name, email, password_hash, created_at) VALUES (?, ?, ?, ?)',
            [$name, $email, password_hash($pw, PASSWORD_DEFAULT), now_utc()]);
    } catch (PDOException $e) {
        if (is_unique_violation($e)) throw new HttpError(409, 'An account with this email already exists', ['email' => 'already registered']);
        throw $e;
    }
    return auth_response(['id' => (int) db()->lastInsertId(), 'full_name' => $name, 'email' => $email], 201);
}

function h_login(): array
{
    rate_limit('login', 10, 900);
    $b = body();
    $email = strtolower(trim((string) ($b['email'] ?? '')));
    $pw = (string) ($b['password'] ?? '');
    $u = $email === '' ? false : q('SELECT * FROM users WHERE email = ?', [$email])->fetch();
    // Always run a hash check so response time does not reveal whether the email exists.
    $hash = $u['password_hash'] ?? '$2y$10$NCSi2jf02vf5uduHwK5aCu5eKUbiA20tXsIJfj4NPqOIrr4HQmpsK';
    $ok = password_verify($pw, $hash);
    if (!$u || !$ok) throw new HttpError(401, 'Invalid email or password');
    if (password_needs_rehash($u['password_hash'], PASSWORD_DEFAULT)) {
        q('UPDATE users SET password_hash = ? WHERE id = ?', [password_hash($pw, PASSWORD_DEFAULT), (int) $u['id']]);
    }
    return auth_response($u, 200);
}

function h_me(array $p, array $user): array
{
    return [200, user_out($user)];
}

// ═════════════════════════════════ Handlers: store ═════════════════════════════

function h_store_get(array $p, array $user): array
{
    $s = owner_store($user);
    return [200, $s ? store_out($s) : null];     // null (not 404): frontend shows "Create your store"
}

function h_store_put(array $p, array $user): array
{
    $b = body();
    $name = str_field($b, 'name', 2, 80);
    $wa = phone_field($b, 'whatsapp_number');
    $desc = nullable(str_field($b, 'description', 0, 1000, true));
    $cat = nullable(str_field($b, 'category', 0, 60));
    $loc = nullable(str_field($b, 'location', 0, 120));
    $cur = isset($b['currency']) && trim((string) $b['currency']) !== '' ? str_field($b, 'currency', 1, 8) : null;
    $now = now_utc();
    $extra = [];
    foreach (['tagline'=>100,'opening_hours'=>500,'delivery_info'=>300,'instagram'=>120,'accent_color'=>7] as $key=>$max) if (array_key_exists($key, $b)) $extra[$key] = nullable(str_field($b, $key, 0, $max));
    if (array_key_exists('accepting_orders', $b)) $extra['accepting_orders'] = filter_var($b['accepting_orders'], FILTER_VALIDATE_BOOLEAN) ? 1 : 0;

    $update = function (array $existing) use ($name, $wa, $desc, $cat, $loc, $cur, $now, $extra): array {
        $sets = ['name=?','description=?','category=?','location=?','whatsapp_number=?','currency=?','updated_at=?']; $vals = [$name,$desc,$cat,$loc,$wa,$cur ?? $existing['currency'],$now];
        foreach ($extra as $k=>$v) { $sets[] = $k . '=?'; $vals[] = $v; }
        $vals[] = (int)$existing['id']; $vals[] = (int)$existing['owner_id'];
        q('UPDATE stores SET ' . implode(',', $sets) . ' WHERE id=? AND owner_id=?', $vals);
        return [200, store_out(q('SELECT * FROM stores WHERE id = ?', [(int) $existing['id']])->fetch())];
    };

    $uid = (int) $user['id'];
    if ($existing = owner_store($user)) return $update($existing);   // slug stays stable

    for ($attempt = 0; $attempt < 3; $attempt++) {
        try {
            q('INSERT INTO stores (owner_id, name, slug, description, category, location, whatsapp_number, currency, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [$uid, $name, unique_slug($name), $desc, $cat, $loc, $wa, $cur ?? (env('DEFAULT_CURRENCY', '₦') ?? '₦'), $now, $now]);
            if ($extra) { $sid=(int)db()->lastInsertId(); $sets=[]; $vals=[]; foreach($extra as $k=>$v){$sets[]=$k.'=?';$vals[]=$v;} $vals[]=$sid; q('UPDATE stores SET '.implode(',', $sets).' WHERE id=?',$vals); }
            return [201, store_out(q('SELECT * FROM stores WHERE id = ?', [(int) db()->lastInsertId()])->fetch())];
        } catch (PDOException $e) {
            if (!is_unique_violation($e)) throw $e;
            if ($existing = owner_store($user)) return $update($existing);   // double-submit race
            // else: slug collision, loop picks a new one
        }
    }
    throw new HttpError(409, 'Could not generate a unique store link, try a different name');
}

// ═════════════════════════════════ Handlers: products ══════════════════════════

/** Validate product fields. $partial = PATCH (only present keys). */
function product_fields(array $b, bool $partial): array
{
    $out = [];
    $has = fn(string $k) => !$partial || array_key_exists($k, $b);
    if ($has('name')) $out['name'] = str_field($b, 'name', 1, 120);
    if ($has('price')) $out['price'] = int_field($b, 'price', 0, 100_000_000);
    if ($has('stock')) $out['stock'] = int_field($b, 'stock', 0, 1_000_000);
    if ($has('category')) $out['category'] = nullable(str_field($b, 'category', 0, 60));
    if ($has('description')) $out['description'] = nullable(str_field($b, 'description', 0, 2000, true));
    if ($has('image_url')) $out['image_url'] = url_field($b, 'image_url');
    if (array_key_exists('is_active', $b)) {
        $v = $b['is_active'];
        if (!is_bool($v) && !in_array($v, [0, 1, '0', '1'], true)) fail('is_active', 'must be true or false');
        $out['is_active'] = (int) filter_var($v, FILTER_VALIDATE_BOOLEAN);
    }
    return $out;
}

function h_products_list(array $p, array $user): array
{
    $s = owner_store($user);
    if (!$s) return [200, []];
    $search = trim((string)($_GET['q'] ?? ''));
    $rows = $search === '' ? q('SELECT * FROM products WHERE store_id = ? ORDER BY id DESC', [(int) $s['id']])->fetchAll() : q('SELECT * FROM products WHERE store_id = ? AND (name LIKE ? OR category LIKE ?) ORDER BY id DESC', [(int)$s['id'], '%'.$search.'%', '%'.$search.'%'])->fetchAll();
    return [200, array_map('product_out', $rows)];
}

function h_product_create(array $p, array $user): array
{
    $s = require_store($user);
    $f = product_fields(body(), false) + ['is_active' => 1];
    q('INSERT INTO products (store_id, name, price, stock, category, description, image_url, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [(int) $s['id'], $f['name'], $f['price'], $f['stock'], $f['category'], $f['description'], $f['image_url'], $f['is_active'], now_utc()]);
    return [201, product_out(q('SELECT * FROM products WHERE id = ?', [(int) db()->lastInsertId()])->fetch())];
}

function h_product_update(array $p, array $user): array
{
    $s = require_store($user);
    // Ownership is part of the lookup; foreign ids look identical to missing ones (404, no leak).
    $row = q('SELECT * FROM products WHERE id = ? AND store_id = ?', [(int) $p['id'], (int) $s['id']])->fetch();
    if (!$row) throw new HttpError(404, 'Product not found');
    $f = product_fields(body(), true);
    if (!$f) throw new HttpError(422, 'No valid fields to update');
    $set = implode(', ', array_map(fn($c) => "$c = ?", array_keys($f)));
    q("UPDATE products SET $set WHERE id = ? AND store_id = ?", [...array_values($f), (int) $row['id'], (int) $s['id']]);
    return [200, product_out(q('SELECT * FROM products WHERE id = ?', [(int) $row['id']])->fetch())];
}

// ═════════════════════════════════ Handlers: orders (vendor) ═══════════════════

function h_orders_list(array $p, array $user): array
{
    $s = owner_store($user);
    if (!$s) return [200, []];
    $limit = min(500, max(1, (int) ($_GET['limit'] ?? 200)));
    $sql = 'SELECT * FROM orders WHERE store_id = ?';
    $args = [(int) $s['id']];
    if (isset($_GET['status']) && in_array($_GET['status'], ORDER_STATUSES, true)) {
        $sql .= ' AND status = ?';
        $args[] = $_GET['status'];
    }
    return [200, orders_out(q("$sql ORDER BY id DESC LIMIT $limit", $args)->fetchAll())];
}

function h_order_status(array $p, array $user): array
{
    $s = require_store($user);
    $status = (string) (body()['status'] ?? '');
    if (!in_array($status, ORDER_STATUSES, true)) fail('status', 'must be one of: ' . implode(', ', ORDER_STATUSES));
    $row = q('SELECT * FROM orders WHERE id = ? AND store_id = ?', [(int) $p['id'], (int) $s['id']])->fetch();
    if (!$row) throw new HttpError(404, 'Order not found');
    q('UPDATE orders SET status = ? WHERE id = ? AND store_id = ?', [$status, (int) $row['id'], (int) $s['id']]);
    $row['status'] = $status;
    return [200, orders_out([$row])[0]];
}

function h_stats(array $p, array $user): array
{
    $empty = ['today_total' => 0, 'today_orders' => 0, 'week_total' => 0, 'pending_orders' => 0, 'product_count' => 0, 'active_product_count' => 0];
    $s = owner_store($user);
    if (!$s) return [200, $empty];
    $tz = new DateTimeZone(env('APP_TIMEZONE', 'Africa/Lagos') ?? 'Africa/Lagos');
    $utc = new DateTimeZone('UTC');
    $today = (new DateTimeImmutable('today', $tz))->setTimezone($utc)->format('Y-m-d H:i:s');
    $week = (new DateTimeImmutable('today', $tz))->modify('-6 days')->setTimezone($utc)->format('Y-m-d H:i:s');
    $sid = (int) $s['id'];

    $o = q("SELECT
              COALESCE(SUM(CASE WHEN created_at >= ? THEN total ELSE 0 END), 0) AS today_total,
              COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0)     AS today_orders,
              COALESCE(SUM(CASE WHEN created_at >= ? THEN total ELSE 0 END), 0) AS week_total,
              COALESCE(SUM(CASE WHEN status <> 'Delivered' THEN 1 ELSE 0 END), 0) AS pending_orders
            FROM orders WHERE store_id = ?", [$today, $today, $week, $sid])->fetch();
    $pr = q('SELECT COUNT(*) AS c, COALESCE(SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END), 0) AS a FROM products WHERE store_id = ?', [$sid])->fetch();

    return [200, [
        'today_total' => (int) $o['today_total'], 'today_orders' => (int) $o['today_orders'],
        'week_total' => (int) $o['week_total'], 'pending_orders' => (int) $o['pending_orders'],
        'product_count' => (int) $pr['c'], 'active_product_count' => (int) $pr['a'],
    ]];
}

// ═════════════════════════════════ Handlers: public ════════════════════════════

function public_store(string $slug): array
{
    $s = q('SELECT * FROM stores WHERE slug = ?', [strtolower($slug)])->fetch();
    if (!$s) throw new HttpError(404, 'Store not found');
    return $s;
}

function h_public_store(array $p): array
{
    return [200, store_out(public_store($p['slug']), true)];
}

function h_public_products(array $p): array
{
    $s = public_store($p['slug']);
    $rows = q('SELECT * FROM products WHERE store_id = ? AND is_active = 1 ORDER BY id DESC', [(int) $s['id']])->fetchAll();
    return [200, array_map('product_out', $rows)];
}

/** Public checkout. Prices, totals and stock are NEVER taken from the client. */
function h_order_create(): array
{
    rate_limit('order', 20, 600);
    $b = body();

    if (!empty($b['store_slug'])) {
        $store = public_store((string) $b['store_slug']);
    } elseif (!empty($b['store_id']) && is_numeric($b['store_id'])) {
        $store = q('SELECT * FROM stores WHERE id = ?', [(int) $b['store_id']])->fetch() ?: throw new HttpError(404, 'Store not found');
    } else {
        fail('store_slug', 'is required');
    }

    $name = str_field($b, 'customer_name', 2, 80);
    $phone = phone_field($b, 'customer_phone');
    $addr = str_field($b, 'delivery_address', 5, 300, true);
    $note = nullable(str_field($b, 'note', 0, 300, true));

    $items = $b['items'] ?? null;
    if (!is_array($items) || !array_is_list($items) || !$items) fail('items', 'must contain at least one product');
    if (count($items) > 50) fail('items', 'cannot contain more than 50 lines');
    $want = [];   // product_id => qty (duplicates merged)
    foreach ($items as $it) {
        if (!is_array($it)) fail('items', 'is malformed');
        $pid = int_field($it, 'product_id', 1, PHP_INT_MAX);
        $qty = int_field($it, 'qty', 1, 999);
        $want[$pid] = ($want[$pid] ?? 0) + $qty;
    }

    $pdo = db();
    $pdo->beginTransaction();
    try {
        $ids = array_keys($want);
        $in = implode(',', array_fill(0, count($ids), '?'));
        $lock = is_mysql() ? ' FOR UPDATE' : '';
        $found = [];
        foreach (q("SELECT id, name, price, stock, is_active FROM products WHERE store_id = ? AND id IN ($in)$lock", [(int) $store['id'], ...$ids])->fetchAll() as $r) {
            $found[(int) $r['id']] = $r;
        }

        $total = 0;
        $lines = [];
        foreach ($want as $pid => $qty) {
            $r = $found[$pid] ?? null;
            if (!$r || !(int) $r['is_active']) throw new HttpError(422, 'A product in your cart is no longer available', ['items' => 'unavailable']);
            if ((int) $r['stock'] <= 0) throw new HttpError(409, "\"{$r['name']}\" is out of stock", ['items' => 'out_of_stock']);
            if ((int) $r['stock'] < $qty) throw new HttpError(409, "Only {$r['stock']} left of \"{$r['name']}\"", ['items' => 'insufficient_stock']);
            // Guarded decrement: succeeds only if stock is still sufficient at write time.
            $upd = q('UPDATE products SET stock = stock - ? WHERE id = ? AND store_id = ? AND stock >= ?', [$qty, $pid, (int) $store['id'], $qty]);
            if ($upd->rowCount() !== 1) throw new HttpError(409, "Only a few left of \"{$r['name']}\". Please refresh and try again", ['items' => 'insufficient_stock']);
            $total += (int) $r['price'] * $qty;
            $lines[] = [$pid, $r['name'], $qty, (int) $r['price']];
        }

        $normalized = norm_customer_phone($phone);
        $customer = q('SELECT id FROM customers WHERE store_id=? AND normalized_phone=?', [(int)$store['id'], $normalized])->fetch();
        if ($customer) { $customerId=(int)$customer['id']; q('UPDATE customers SET full_name=?,phone=?,default_address=?,updated_at=? WHERE id=?',[$name,$phone,$addr,now_utc(),$customerId]); }
        else { q('INSERT INTO customers(store_id,full_name,phone,normalized_phone,default_address,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',[(int)$store['id'],$name,$phone,$normalized,$addr,now_utc(),now_utc()]); $customerId=(int)$pdo->lastInsertId(); }
        $trackingToken = bin2hex(random_bytes(24));
        q('INSERT INTO orders (store_id, customer_id, customer_name, customer_phone, delivery_address, note, total, status, payment_status, tracking_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [(int) $store['id'], $customerId, $name, $phone, $addr, $note, $total, 'New', 'unpaid', $trackingToken, now_utc()]);
        $orderId = (int) $pdo->lastInsertId();
        foreach ($lines as [$pid, $pname, $qty, $price]) {
            q('INSERT INTO order_items (order_id, product_id, name, qty, price) VALUES (?, ?, ?, ?, ?)', [$orderId, $pid, $pname, $qty, $price]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }

    $order = orders_out([q('SELECT * FROM orders WHERE id = ?', [$orderId])->fetch()])[0];
    $order['tracking_token'] = $trackingToken;
    $order['tracking_url'] = 'track/' . $trackingToken;
    $order['payment_status'] = 'unpaid';
    $order['store'] = ['name' => $store['name'], 'slug' => $store['slug'], 'whatsapp_number' => $store['whatsapp_number'], 'currency' => $store['currency']];
    return [201, $order];
}


// ═══════════════════════ WhOM Plus: customers, tracking, reports ═══════════════
function norm_customer_phone(string $phone): string { return preg_replace('/\D+/', '', $phone) ?: $phone; }
function h_customers(array $p, array $user): array {
    $s=require_store($user); $sql='SELECT c.*, COUNT(o.id) order_count, COALESCE(SUM(CASE WHEN o.payment_status="paid" THEN o.total ELSE 0 END),0) lifetime_paid FROM customers c LEFT JOIN orders o ON o.customer_id=c.id WHERE c.store_id=?'; $args=[(int)$s['id']];
    $qtext=trim((string)($_GET['q']??'')); if($qtext!==''){$sql.=' AND (c.full_name LIKE ? OR c.phone LIKE ?)';$args[]='%'.$qtext.'%';$args[]='%'.$qtext.'%';}
    $rows=q($sql.' GROUP BY c.id ORDER BY c.id DESC LIMIT 300',$args)->fetchAll(); foreach($rows as &$r){$r['id']=(int)$r['id'];$r['order_count']=(int)$r['order_count'];$r['lifetime_paid']=(int)$r['lifetime_paid'];} return [200,$rows];
}
function h_customer_get(array $p,array $user): array { $s=require_store($user); $r=q('SELECT * FROM customers WHERE id=? AND store_id=?',[(int)$p['id'],(int)$s['id']])->fetch(); if(!$r)throw new HttpError(404,'Customer not found'); $r['orders']=orders_out(q('SELECT * FROM orders WHERE customer_id=? ORDER BY id DESC LIMIT 100',[(int)$r['id']])->fetchAll()); return [200,$r]; }
function h_order_detail(array $p,array $user): array { $s=require_store($user); $r=q('SELECT * FROM orders WHERE id=? AND store_id=?',[(int)$p['id'],(int)$s['id']])->fetch(); if(!$r)throw new HttpError(404,'Order not found'); return [200,orders_out([$r])[0]]; }
function h_order_filters(array $p,array $user): array { $s=require_store($user); $sql='SELECT * FROM orders WHERE store_id=?';$a=[(int)$s['id']]; foreach(['status','payment_status'] as $k)if(isset($_GET[$k])&&$_GET[$k]!==''){$sql.=" AND $k=?";$a[]=$_GET[$k];} if(!empty($_GET['q'])){$sql.=' AND (customer_name LIKE ? OR customer_phone LIKE ? OR CAST(id AS CHAR) LIKE ?)';$v='%'.$_GET['q'].'%';array_push($a,$v,$v,$v);} return [200,orders_out(q($sql.' ORDER BY id DESC LIMIT 500',$a)->fetchAll())]; }
function h_track(array $p): array { $r=q('SELECT id,store_id,customer_name,total,status,payment_status,created_at FROM orders WHERE tracking_token=?',[$p['token']])->fetch(); if(!$r)throw new HttpError(404,'Tracking link not found'); $r['items']=orders_out([q('SELECT * FROM orders WHERE id=?',[(int)$r['id']])->fetch()])[0]['items']; $r['store']=q('SELECT name,slug,currency FROM stores WHERE id=?',[(int)$r['store_id']])->fetch(); return [200,$r]; }
function h_marketplace(array $p): array { $qtext=trim((string)($_GET['q']??''));$sql='SELECT p.*,s.name store_name,s.slug store_slug,s.currency FROM products p JOIN stores s ON s.id=p.store_id WHERE p.is_active=1 AND s.accepting_orders=1';$a=[];if($qtext!==''){$sql.=' AND (p.name LIKE ? OR p.category LIKE ? OR s.name LIKE ?)';$v='%'.$qtext.'%';array_push($a,$v,$v,$v);} $rows=q($sql.' ORDER BY p.id DESC LIMIT 100',$a)->fetchAll();foreach($rows as &$r){$r=product_out($r)+['store_name'=>$r['store_name'],'store_slug'=>$r['store_slug'],'currency'=>$r['currency']];}return [200,$rows]; }
function h_reports(array $p,array $user): array { $s=require_store($user);$days=min(90,max(1,(int)($_GET['days']??7)));$from=(new DateTimeImmutable('today',new DateTimeZone(env('APP_TIMEZONE','Africa/Lagos')??'Africa/Lagos')))->modify('-'.($days-1).' days')->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s');$rows=q('SELECT DATE(created_at) day,COUNT(*) orders,COALESCE(SUM(total),0) revenue,COALESCE(SUM(CASE WHEN payment_status="paid" THEN total ELSE 0 END),0) paid FROM orders WHERE store_id=? AND created_at>=? GROUP BY DATE(created_at) ORDER BY day',[(int)$s['id'],$from])->fetchAll();$sum=q('SELECT COALESCE(SUM(total),0) revenue,COALESCE(SUM(CASE WHEN payment_status="paid" THEN total ELSE 0 END),0) paid,COUNT(*) orders FROM orders WHERE store_id=? AND created_at>=?',[(int)$s['id'],$from])->fetch();foreach($sum as &$v)$v=(int)$v;return [200,['days'=>$days,'summary'=>$sum,'daily'=>$rows]]; }
function h_store_image(array $p,array $user): array { $s=require_store($user);$kind=$p['kind'];if(!in_array($kind,['logo','cover'],true))throw new HttpError(422,'Image kind must be logo or cover');$url=save_uploaded_image((string)file_get_contents('php://input'));$col=$kind==='logo'?'logo_url':'cover_url';q("UPDATE stores SET $col=? WHERE id=?",[$url,(int)$s['id']]);return [200,['url'=>$url]]; }

function save_uploaded_image(string $raw): string { if(strlen($raw)>2097152)throw new HttpError(413,'Image exceeds 2 MB');$mime=(new finfo(FILEINFO_MIME_TYPE))->buffer($raw);$ext=['image/jpeg'=>'jpg','image/png'=>'png','image/webp'=>'webp'][$mime]??null;if(!$ext)throw new HttpError(415,'Only JPEG, PNG and WebP are supported');$dir=__DIR__.'/uploads';if(!is_dir($dir)&&!mkdir($dir,0755,true))throw new HttpError(500,'Upload directory unavailable');$name=bin2hex(random_bytes(16)).'.'.$ext;if(file_put_contents($dir.'/'.$name,$raw)===false)throw new HttpError(500,'Could not save image');return 'uploads/'.$name; }
function h_product_image(array $p,array $user): array { $s=require_store($user);$pid=(int)$p['id'];$product=q('SELECT * FROM products WHERE id=? AND store_id=?',[$pid,(int)$s['id']])->fetch();if(!$product)throw new HttpError(404,'Product not found');$url=save_uploaded_image((string)file_get_contents('php://input'));q('UPDATE products SET image_url=? WHERE id=? AND store_id=?',[$url,$pid,(int)$s['id']]);return [200,['image_url'=>$url]]; }
function h_pay_init(array $p): array { $b=body();$oid=int_field($b,'order_id',1,PHP_INT_MAX);$email=filter_var((string)($b['email']??''),FILTER_VALIDATE_EMAIL);if(!$email)fail('email','valid email required');$o=q('SELECT o.*,s.currency FROM orders o JOIN stores s ON s.id=o.store_id WHERE o.id=?',[$oid])->fetch();if(!$o)throw new HttpError(404,'Order not found');$secret=env('PAYSTACK_SECRET_KEY');if(!$secret)throw new HttpError(503,'Online payments are not configured');$ref='WHOM-'.bin2hex(random_bytes(10));$ch=curl_init('https://api.paystack.co/transaction/initialize');curl_setopt_array($ch,[CURLOPT_POST=>true,CURLOPT_RETURNTRANSFER=>true,CURLOPT_HTTPHEADER=>['Authorization: Bearer '.$secret,'Content-Type: application/json'],CURLOPT_POSTFIELDS=>json_encode(['email'=>$email,'amount'=>(int)$o['total']*100,'reference'=>$ref,'metadata'=>['order_id'=>$oid]])]);$res=curl_exec($ch);$code=curl_getinfo($ch,CURLINFO_HTTP_CODE);curl_close($ch);$data=json_decode((string)$res,true);if($code<200||$code>=300||empty($data['status']))throw new HttpError(502,'Payment provider could not initialize payment');q('INSERT INTO payments(order_id,reference,amount,status,provider,created_at) VALUES(?,?,?,?,?,?)',[$oid,$ref,(int)$o['total'],'pending','paystack',now_utc()]);return [200,$data['data']]; }
function h_pay_verify(array $p): array { $secret=env('PAYSTACK_SECRET_KEY');if(!$secret)throw new HttpError(503,'Online payments are not configured');$ref=$p['reference'];$ch=curl_init('https://api.paystack.co/transaction/verify/'.rawurlencode($ref));curl_setopt_array($ch,[CURLOPT_RETURNTRANSFER=>true,CURLOPT_HTTPHEADER=>['Authorization: Bearer '.$secret]]);$res=curl_exec($ch);$code=curl_getinfo($ch,CURLINFO_HTTP_CODE);curl_close($ch);$d=json_decode((string)$res,true);if($code!==200||empty($d['status']))throw new HttpError(502,'Could not verify payment');$paid=($d['data']['status']??'')==='success';$pay=q('SELECT * FROM payments WHERE reference=?',[$ref])->fetch();if(!$pay)throw new HttpError(404,'Payment reference not found');if($paid && (int)($d['data']['amount']??0)===(int)$pay['amount']*100){q('UPDATE payments SET status="paid" WHERE id=?',[(int)$pay['id']]);q('UPDATE orders SET payment_status="paid" WHERE id=?',[(int)$pay['order_id']]);}else{q('UPDATE payments SET status=? WHERE id=?',[$paid?'amount_mismatch':'failed',(int)$pay['id']]);$paid=false;}return [200,['verified'=>$paid,'reference'=>$ref]]; }

// ═════════════════════════════════ Router ══════════════════════════════════════

const ROUTES = [
    // [method, pattern, handler, requires_auth]
    ['GET',   '#^/api/health$#',                          'h_health',          false],
    ['POST',  '#^/api/auth/register$#',                   'h_register',        false],
    ['POST',  '#^/api/auth/login$#',                      'h_login',           false],
    ['GET',   '#^/api/auth/me$#',                         'h_me',              true],
    ['GET',   '#^/api/store$#',                           'h_store_get',       true],
    ['PUT',   '#^/api/store$#',                           'h_store_put',       true],
    ['GET',   '#^/api/products$#',                        'h_products_list',   true],
    ['POST',  '#^/api/products$#',                        'h_product_create',  true],
    ['PATCH', '#^/api/products/(?<id>\d+)$#',             'h_product_update',  true],
    ['PUT',   '#^/api/products/(?<id>\d+)/image$#',       'h_product_image',   true],
    ['GET',   '#^/api/orders$#',                          'h_orders_list',     true],
    ['POST',  '#^/api/orders$#',                          'h_order_create',    false],   // public checkout
    ['PATCH', '#^/api/orders/(?<id>\d+)/status$#',        'h_order_status',    true],
    ['GET',   '#^/api/stats$#',                           'h_stats',           true],
    ['GET',   '#^/api/public/store/(?<slug>[a-z0-9-]{1,60})$#i',          'h_public_store',    false],
    ['GET',   '#^/api/public/store/(?<slug>[a-z0-9-]{1,60})/products$#i', 'h_public_products', false],
    ['GET',   '#^/api/customers$#', 'h_customers', true],
    ['GET',   '#^/api/customers/(?<id>\d+)$#', 'h_customer_get', true],
    ['GET',   '#^/api/orders/(?<id>\d+)$#', 'h_order_detail', true],
    ['GET',   '#^/api/orders/search$#', 'h_order_filters', true],
    ['GET',   '#^/api/reports$#', 'h_reports', true],
    ['GET',   '#^/api/marketplace$#', 'h_marketplace', false],
    ['GET',   '#^/api/track/(?<token>[a-f0-9]{32,64})$#i', 'h_track', false],
    ['PUT',   '#^/api/store/image/(?<kind>logo|cover)$#', 'h_store_image', true],
    ['POST',  '#^/api/payments/initialize$#', 'h_pay_init', false],
    ['GET',   '#^/api/payments/verify/(?<reference>[A-Za-z0-9_-]+)$#', 'h_pay_verify', false],
];

function request_path(): string
{
    $path = rawurldecode((string) parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH));
    return preg_replace('#/{2,}#', '/', $path) ?? $path;
}

/** Works from any sub-folder (XAMPP: /whom/api/...). Returns the "/api/..." tail. */
function api_tail(string $path): ?string
{
    $i = strpos($path, '/api/');
    if ($i !== false) return substr($path, $i);
    return str_ends_with($path, '/api') ? '/api' : null;
}

function dispatch(): array
{
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    $tail = api_tail(request_path());
    if ($tail === null) throw new HttpError(404, 'Not found');
    $tail = rtrim($tail, '/') ?: '/api';

    $allowed = [];
    foreach (ROUTES as [$m, $re, $fn, $auth]) {
        if (!preg_match($re, $tail, $mm)) continue;
        if ($m !== $method) { $allowed[] = $m; continue; }
        $params = array_filter($mm, 'is_string', ARRAY_FILTER_USE_KEY);
        return $fn($params, $auth ? current_user() : null);
    }
    if ($allowed) throw new HttpError(405, 'Method not allowed', [], ['Allow' => implode(', ', array_unique($allowed))]);
    throw new HttpError(404, 'Not found');
}

function main(): void
{
    ini_set('display_errors', '0');
    send_headers_common();
    send_cors();
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method === 'OPTIONS') emit(204, null);

    // Pretty store links: /store/my-shop  ->  /?store=my-shop   (works from any sub-folder)
    $path = request_path();
    if (preg_match('#^(.*?)/store/([a-z0-9-]{1,60})/?$#i', $path, $m) && api_tail($path) === null) {
        header('Location: ' . $m[1] . '/?store=' . strtolower($m[2]), true, 302);
        exit;
    }

    try {
        try {
            [$status, $data] = dispatch();
        } catch (PDOException $e) {
            // Fresh database: tables missing -> create them once, retry the request.
            if ($e->getCode() === '42S02' && env_bool('AUTO_MIGRATE', true)) {
                migrate();
                [$status, $data] = dispatch();
            } else {
                throw $e;
            }
        }
        emit($status, $data);
    } catch (HttpError $e) {
        $out = ['error' => $e->getMessage()];
        if ($e->details) $out['details'] = $e->details;
        emit($e->status, $out, $e->headers);
    } catch (Throwable $e) {
        error_log('[whom] ' . get_class($e) . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
        emit(500, ['error' => is_debug() ? $e->getMessage() : 'Internal server error']);
    }
}

// ═════════════════════════════════ Entry point ═════════════════════════════════

if (PHP_SAPI === 'cli') {
    $cmd = $argv[1] ?? '';
    if ($cmd === 'migrate') {
        try {
            migrate();
            fwrite(STDOUT, "Migration OK\n");
            exit(0);
        } catch (Throwable $e) {
            fwrite(STDERR, 'Migration failed: ' . $e->getMessage() . "\n");
            exit(1);
        }
    }
    fwrite(STDOUT, "Usage: php server.php migrate\n");
    exit($cmd === '' ? 0 : 1);
}

main();
