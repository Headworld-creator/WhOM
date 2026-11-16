// api.js — NO hardcoded data. Everything comes from the backend.
// Token lives in localStorage only. Vendor calls send it; public calls never do.
const CFG = window.WHOM_CONFIG || {};
const CURRENCY = CFG.currency || "₦";
const TOKEN_KEY = "whom_token";

// Same-origin by default: the folder the page is served from (works at "/" and at "/whom/").
const API_BASE = (CFG.apiBase || location.pathname.replace(/[^/]*$/, "")).replace(/\/+$/, "");

function safeStorage(fn) { try { return fn(); } catch (e) { return null; } }
function getToken() { return safeStorage(() => localStorage.getItem(TOKEN_KEY)); }
function setToken(t) { safeStorage(() => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY))); }
function isLoggedIn() { return !!getToken(); }

class ApiError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details || {}; }
}

/**
 * api(path, { method, body, auth })
 *   auth: true  → send the token and treat 401 as "session expired"
 *         false → never send the token (login, register, public storefront, checkout)
 *   default: auth for everything except /api/auth/* , /api/public/* and POST /api/orders
 */
async function api(path, { method = "GET", body, auth } = {}) {
  const isPublic = path.startsWith("/api/auth/login") || path.startsWith("/api/auth/register") ||
    path.startsWith("/api/public/") || path === "/api/health" || (path === "/api/orders" && method === "POST");
  const useAuth = auth !== undefined ? auth : !isPublic;
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (useAuth && getToken()) headers.Authorization = "Bearer " + getToken();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res;
  try {
    res = await fetch(API_BASE + path, { method, headers, signal: ctrl.signal, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new ApiError(0, e.name === "AbortError" ? "The server took too long to respond." : "Cannot reach the server. Check your connection.");
  } finally { clearTimeout(timer); }

  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }

  if (!res.ok) {
    if (res.status === 401 && useAuth) { setToken(null); window.dispatchEvent(new CustomEvent("whom:unauthorized")); }
    const msg = (data && data.error) || (res.status >= 500 ? "Server error. Please try again." : "Request failed (" + res.status + ")");
    throw new ApiError(res.status, msg, data && data.details);
  }
  return data;
}

// Backend contract (see README.md) — ORDER MATTERS: User → Store → Products → Orders
// POST /api/auth/register {full_name,email,password}  → {access_token,user}
// POST /api/auth/login    {email,password}            → {access_token,user}
// GET  /api/auth/me                                   → user
// GET  /api/store  (null if none) · PUT /api/store
// GET/POST /api/products · PATCH /api/products/{id}
// GET  /api/orders · PATCH /api/orders/{id}/status · GET /api/stats
// GET  /api/public/store/{slug} · GET /api/public/store/{slug}/products
// POST /api/orders  (public checkout, needs store_slug)
