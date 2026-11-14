# ShopLite — WhatsApp Store (Frontend)

Vanilla HTML + CSS + JS. No framework, no build step.
ZERO hardcoded data. If the backend returns nothing, the UI shows empty states.

## Correct order — this is the whole point now

```
1. USER (auth)  ->  2. STORE (belongs to that user)  ->  3. PRODUCTS (belong to that store)  ->  4. ORDERS (belong to that store)
```

No user = no store. No store = no products. The frontend enforces this:
- First screen is **Account** (Sign up / Log in), not the Dashboard.
- Dashboard + Orders are gated: if you are not logged in, clicking them sends you to Account.
- After login, if you have no store yet, Dashboard shows "Create your store" and blocks Add Product until the store exists.

## Run
```bash
python -m http.server 5500
```
Set `API_BASE` in `api.js` to your FastAPI URL, e.g. `http://127.0.0.1:8000`.

## Files
- index.html — Auth + Storefront + Dashboard + Orders + Cart. All values from API.
- styles.css — Responsive only.
- api.js — API_BASE + token handling. Token in localStorage, sent as `Authorization: Bearer <token>`.
- app.js — Auth first, then store/products/orders. Gating + empty states.

## Backend contract

### Tables — CREATE IN THIS ORDER
1. **users** FIRST: id (PK), full_name, email (unique, indexed), password_hash (bcrypt/argon2 — NEVER store plain password), created_at
2. **stores**: id (PK), owner_id (FK -> users.id, UNIQUE — one store per user for MVP), name, slug (unique, from name), description, category, location, whatsapp_number, currency (default ₦), created_at
3. **products**: id (PK), store_id (FK -> stores.id), name, price (int), stock (int), category, description, image_url, is_active, created_at
4. **orders**: id (PK), store_id (FK -> stores.id), customer_name, customer_phone, delivery_address, note, total (int, backend-calculated), status (New/Preparing/Delivered), created_at
5. **order_items**: id (PK), order_id (FK), product_id (FK), name (snapshot), qty, price (snapshot)

### Auth endpoints — BUILD THESE FIRST
POST /api/auth/register — Body {full_name, email, password} — Backend: check email not taken (409 if taken), hash password, create user, create JWT (sub=user.id). Return {access_token, user:{id,full_name,email}} — NEVER return password_hash.
POST /api/auth/login — Body {email, password} — Backend: find user, verify hash (401 if wrong), create JWT. Return same shape as register.
GET /api/auth/me — Header `Authorization: Bearer <token>` — Backend: decode JWT, return {id,full_name,email}. 401 if missing/invalid/expired.
JWT: use python-jose / PyJWT, `sub` = user id, expiry e.g. 7 days. Secret from env var, never in code.
Dependency: `get_current_user(token) -> user` — use it on EVERY vendor endpoint below.

### Vendor endpoints — ALL require auth + ownership check
GET /api/store — Return store where owner_id == current_user.id, or null (not 404 — frontend uses null to show "Create your store").
PUT /api/store — Body {name,description,category,location,whatsapp_number} — If no store, create one with owner_id=current_user.id + slug from name. If exists, update only if owner matches. Return store.
GET /api/products — Only products where store.owner_id == current_user.id.
POST /api/products — Body {name,price,stock,category,description,image_url} — Backend finds caller's store, sets store_id from it. If caller has no store yet -> 400 "Create your store first".
PATCH /api/products/{id} — Only if product.store.owner_id == current_user.id, else 404 (do not leak existence).
GET /api/orders — Only orders where store.owner_id == current_user.id, newest first, with items.
PATCH /api/orders/{id}/status — Body {status} — Only if order.store.owner_id == current_user.id.
GET /api/stats — Computed for current user's store only: {today_total,today_orders,week_total,pending_orders,product_count}

### Public endpoints — NO login
GET /api/public/store/{slug} — Public store info (is_active products only via next endpoint).
GET /api/public/store/{slug}/products — Public products.
POST /api/orders — Public checkout. Body {store_slug OR store_id, customer_name,customer_phone,delivery_address,note,items:[{product_id,qty}]} — Backend: find store by slug, look up real prices, check stock, decrement stock, calculate total. NEVER trust frontend price/total.

### CORS
FastAPI CORSMiddleware allow_origins=["*"] in dev, frontend domain in prod.

### Test the order
1. Backend empty + frontend fresh -> first screen is Account.
2. Register -> token saved -> redirected to Dashboard -> "Create your store" shows.
3. Create store -> Add Product now works -> product appears in Catalog.
4. Log out -> Dashboard/Orders blocked -> Log in again -> your store/products/orders come back, not someone else's.
5. Register a SECOND user -> they see empty store/products/orders, not the first user's data. If they see the first user's data, your ownership scoping is broken.
