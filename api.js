// api.js - NO hardcoded data. Everything comes from the backend.
// Auth: token lives in localStorage ONLY (never hardcoded). Every vendor request sends it.
const API_BASE = "http://localhost:8000";
const CURRENCY = "₦";
const TOKEN_KEY = "shoplite_token";
function getToken() { return localStorage.getItem(TOKEN_KEY); }
function setToken(t) { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }
function isLoggedIn() { return !!getToken(); }
async function api(path, options = {}) {
  if (!API_BASE) throw new Error("API_BASE is not set in api.js");
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  // Public auth + public storefront do NOT need a token. Everything else does.
  const isPublic = path.startsWith("/api/auth/") || path.startsWith("/api/public/");
  if (!isPublic && getToken()) headers["Authorization"] = "Bearer " + getToken();
  const res = await fetch(API_BASE + path, { ...options, headers });
  if (res.status === 401) { setToken(null); throw new Error("UNAUTHORIZED"); }
  if (!res.ok) throw new Error(await res.text());
  return res.status === 204 ? null : res.json();
}
// Backend contract (see README.md) — ORDER MATTERS: User first, then Store, then Products, then Orders
// POST /api/auth/register -> {full_name,email,password} -> {access_token, user:{id,full_name,email}}
// POST /api/auth/login    -> {email,password} -> {access_token, user:{id,full_name,email}}
// GET  /api/auth/me       -> current user from token -> {id,full_name,email} (401 if no/invalid token)
// GET  /api/store         -> store owned by current user (or null if they have not created one yet)
// PUT  /api/store         -> create/update store owned by current user
// GET  /api/products, POST /api/products, PATCH /api/products/{id}  (scoped to current user's store)
// GET  /api/orders, POST /api/orders (public checkout), PATCH /api/orders/{id}/status (vendor only)
// GET  /api/stats         (vendor only, scoped to current user's store)
// GET  /api/public/store/{slug}, GET /api/public/store/{slug}/products (public, no login)
