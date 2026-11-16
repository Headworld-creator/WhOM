# WhOM — WhatsApp Commerce

Vanilla HTML/CSS/JS frontend + a **single-file PHP backend** (`server.php`) on MySQL.
Vendors create a store, share one link, customers check out without an account, and the order is handed to the vendor on WhatsApp.

```
USER (auth) → STORE (owned by user) → PRODUCTS (owned by store) → ORDERS (owned by store)
```

Every vendor query is scoped to the logged-in user's store. A second account can never see the first account's store, products or orders (covered by tests).

## Files

| File | Purpose |
|---|---|
| `server.php` | The whole backend: router, JWT auth, validation, rate limiting, auto-migration |
| `.htaccess` | Sends `/api/*` and `/store/*` to `server.php`, keeps the `Authorization` header, blocks `.env`/`.sql` |
| `.env.example` | All settings, documented. Copy to `.env` for local dev |
| `schema.sql` | Optional manual import (tables are normally created automatically) |
| `Dockerfile`, `docker/entrypoint.sh` | Render image (PHP 8.3 + Apache, binds Render's `$PORT`) |
| `render.yaml` | Render Blueprint |
| `index.html`, `styles.css`, `app.js`, `api.js`, `config.js` | Frontend |
| `tests/` | API tests (`run.sh`) and a Playwright UI test (`ui_test.js`) |

## 1 · Local development with XAMPP

1. Copy this folder to `C:\xampp\htdocs\whom` (Mac/Linux: `/opt/lampp/htdocs/whom`).
2. XAMPP Control Panel → start **Apache** and **MySQL**.
3. phpMyAdmin (`http://localhost/phpmyadmin`) → **New** → database `whom`, collation `utf8mb4_unicode_ci`.
4. Copy `.env.example` → `.env`. XAMPP defaults already match (`root`, empty password). Set `JWT_SECRET` to anything long.
5. Open **http://localhost/whom/**. Tables are created on the first request.

Sanity check: `http://localhost/whom/api/health` → `{"status":"ok","db":true,...}`.

No Apache? `php -S localhost:8000 server.php` from this folder also works (needs `pdo_mysql`).

## 2 · Push to GitHub

```bash
git init && git add . && git commit -m "WhOM"
git branch -M main
git remote add origin https://github.com/<you>/whom.git
git push -u origin main
```
`.gitignore` already excludes `.env`. **Never commit real secrets.**

## 3 · MySQL on Clever Cloud

1. Clever Cloud → **Create → an add-on → MySQL** (DEV plan is free).
2. Open the add-on → **Information**. You'll see `MYSQL_ADDON_HOST`, `_PORT`, `_DB`, `_USER`, `_PASSWORD`.
3. Keep that tab open for step 4. Nothing to import, tables are created automatically.

The backend reads `MYSQL_ADDON_*` directly, so no renaming is needed. (The DEV plan allows only a handful of simultaneous connections. PHP opens one per request and closes it, which is fine for small traffic.)

## 4 · Deploy on Render (Docker)

1. Render → **New → Blueprint** → select your GitHub repo (uses `render.yaml`).
   *Or* **New → Web Service → Docker** and add the env vars below by hand.
2. Paste the five `MYSQL_ADDON_*` values from Clever Cloud when prompted.
   `JWT_SECRET` is generated for you.
3. Deploy. Health check is `/api/health`. Open `https://<your-service>.onrender.com/`.

| Env var                                 | Value                                                           |
|-----------------------------------------|-----------------------------------------------------------------|
| `APP_ENV`                               | `production`                                                    |
| `APP_DEBUG`                             | `false`                                                         |
| `JWT_SECRET`                            | 32+ random chars (`php -r "echo bin2hex(random_bytes(32));"`)   |
| `MYSQL_ADDON_HOST/PORT/DB/USER/PASSWORD`| from Clever Cloud                                               |
| `TRUST_PROXY`                           | `true` (rate limiting sees real client IPs)                     |
| `APP_TIMEZONE`                          | `Africa/Lagos` (what "today" means on the dashboard)            |
| `CORS_ORIGINS`                          | only if the frontend lives on another domain                    |

The Docker image serves the frontend **and** the API from one origin, so `config.js` needs no change and CORS is not involved.
Render's free tier sleeps after inactivity; the first request after a nap takes ~30 s.

### Frontend on a different host (optional)
GitHub Pages/Netlify for the frontend, Render for the API: set `apiBase: "https://<service>.onrender.com"` in `config.js`, and set `CORS_ORIGINS=https://<you>.github.io` on Render.

## Customer flow

Vendor Dashboard shows a link like `https://…/?store=ada-gadgets` (`/store/ada-gadgets` redirects to it).
Customers open it, add to cart, check out, and an **order-placed** screen offers *Send order on WhatsApp* → opens `wa.me/<vendor>` with the order pre-filled. Vendors get the order in **Orders** (refreshes every 30 s) and can send a WhatsApp receipt.

## API

Errors are `{"error": "message", "details": {...}}`. Auth is `Authorization: Bearer <jwt>`.

| Endpoint | Auth | Notes |
|---|---|---|
| `GET /api/health` | – | DB check |
| `POST /api/auth/register` `{full_name,email,password}` | – | 201 `{access_token,user}`; 409 duplicate email |
| `POST /api/auth/login` `{email,password}` | – | 401 on bad credentials; 10 tries / 15 min / IP |
| `GET /api/auth/me` | ✔ | |
| `GET /api/store` | ✔ | **`null`** (200) if no store yet |
| `PUT /api/store` `{name,whatsapp_number,category,location,description}` | ✔ | creates (201) or updates; slug stays stable |
| `GET/POST /api/products`, `PATCH /api/products/{id}` | ✔ | POST → 400 `Create your store first`; foreign ids → 404 |
| `GET /api/orders`, `PATCH /api/orders/{id}/status` | ✔ | `New / Preparing / Delivered` |
| `GET /api/stats` | ✔ | `today_total, today_orders, week_total, pending_orders, product_count` |
| `GET /api/public/store/{slug}` · `…/products` | – | active products only |
| `POST /api/orders` `{store_slug, customer_*, delivery_address, note, items:[{product_id,qty}]}` | – | server computes price/total, checks and atomically decrements stock; 409 if sold out |

Phone numbers are normalised to `+<country><number>` (`0803…` → `+234803…`, via `DEFAULT_COUNTRY_CODE`).

## Security notes

- Passwords: `password_hash` (bcrypt), never returned. Login response time doesn't reveal whether an email exists.
- JWT HS256 signed with `JWT_SECRET`; server refuses to start auth with a missing/weak/placeholder secret in production. Algorithm is pinned (no `alg:none`).
- All SQL is prepared statements. All server/customer text is HTML-escaped in the frontend (customers can't inject script into the vendor's Orders page).
- Prices, totals and stock are never taken from the browser.
- Rate limits: login, register, checkout (per IP, stored in MySQL).
- `.env`, `*.sql`, `Dockerfile` etc. are denied by `.htaccess`.

## Tests

```bash
sh tests/run.sh          # 87 API checks (uses a throwaway SQLite DB, no MySQL needed)
node tests/ui_test.js    # browser flow; needs Playwright and a server on :8111 (see file header)
```

## Troubleshooting

- **401 on every request under XAMPP** → Apache dropped the `Authorization` header. The shipped `.htaccess` fixes this; make sure `AllowOverride All` is active and `mod_rewrite` enabled.
- **`/api/...` shows the 404 page / HTML** → `.htaccess` not applied (see above).
- **"Database unavailable"** → check credentials; set `APP_DEBUG=true` temporarily for the exact reason.
- **"Server misconfigured: JWT_SECRET"** → set a 32+ character `JWT_SECRET`.
- **Orders from a customer show up as a different phone format** → expected, numbers are normalised.
