// app.js — Vanilla JS, zero hardcoded data.
// Flow: 1) Register/Login (User) → 2) Create Store (owned by User) → 3) Add Products → 4) Receive Orders
// The storefront is PUBLIC: customers open  ?store=<slug>  (no account) and check out.
"use strict";

// ───────────── helpers ─────────────
const $ = (s) => document.querySelector(s);
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
// EVERYTHING that came from the server or a customer goes through esc() before touching innerHTML.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const fmt = (v) => (v === null || v === undefined || v === "" ? "—" : esc(v));
const moneyRaw = (n, cur) => (cur || CURRENCY) + Number(n || 0).toLocaleString();   // for textContent
const money = (n, cur) => esc(moneyRaw(n, cur));                                      // for innerHTML
const digits = (s) => String(s || "").replace(/\D/g, "");
const waLink = (num, msg) => `https://wa.me/${digits(num)}?text=${encodeURIComponent(msg)}`;

let toastTimer;
function toast(m) {
  const t = $("#toast"); t.textContent = m; t.classList.remove("hidden");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add("hidden"), 3200);
}
async function busy(btn, label, fn) {
  const orig = btn.textContent; btn.disabled = true; btn.textContent = label;
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = orig; }
}
function store_(k, v) { try { v === undefined ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
function load_(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }

// ───────────── state ─────────────
let currentUser = null, store = null, products = [], orders = [], stats = null;   // the logged-in vendor's own data
let shop = { store: null, products: [], notFound: false };                          // what the storefront shows
let cart = [], orderFilter = "all", editingProduct = null, authMode = "signup", lastOrder = null, needsRetry = false;
const urlSlug = (() => {
  const q = new URLSearchParams(location.search).get("store");
  const m = q || (location.pathname.match(/\/store\/([^/]+)/) || [])[1];
  return m && /^[a-z0-9-]{1,60}$/i.test(m) ? m.toLowerCase() : null;
})();
const isOwnShop = () => !!(store && shop.store && store.id === shop.store.id);
const activeView = () => (document.querySelector(".view.active")?.id || "").replace("view-", "");

// ───────────── navigation ─────────────
function showView(name) {
  if ((name === "dashboard" || name === "orders") && !isLoggedIn()) { name = "auth"; toast("Log in first — your dashboard belongs to your account"); }
  document.querySelectorAll(".nav-btn").forEach((x) => x.classList.toggle("active", x.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $("#view-" + name).classList.add("active");
  window.scrollTo({ top: 0 });
}
document.querySelectorAll(".nav-btn").forEach((b) => (b.onclick = () => showView(b.dataset.view)));
document.addEventListener("click", (e) => { const g = e.target.closest("[data-go]"); if (g) showView(g.dataset.go); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  closeCart(); $("#productModal").classList.add("hidden"); $("#orderDoneModal").classList.add("hidden");
});

// ───────────── API status ─────────────
function setApiStatus(ok) {
  $("#apiStatus").classList.toggle("live", ok);
  $("#apiStatusText").textContent = ok ? "API: Live" : "API: Offline";
  $("#configBanner").classList.toggle("hidden", ok);
}
async function checkHealth() {
  try { await api("/api/health"); setApiStatus(true); if (needsRetry) { needsRetry = false; init(); } return true; }
  catch (e) { setApiStatus(false); return false; }
}

// ───────────── AUTH ─────────────
function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === "signup";
  $("#tabSignup").classList.toggle("active", signup);
  $("#tabLogin").classList.toggle("active", !signup);
  $("#authTitle").textContent = signup ? "Create your vendor account" : "Log in to your account";
  $("#authSubmit").textContent = signup ? "Create account" : "Log in";
  $("#authNameLabel").style.display = signup ? "block" : "none";
  $("#authFullName").required = signup;
  $("#authPassword").minLength = signup ? 8 : 0;
  $("#authPassword").autocomplete = signup ? "new-password" : "current-password";
  $("#authError").textContent = "";
}
$("#tabSignup").onclick = () => setAuthMode("signup");
$("#tabLogin").onclick = () => setAuthMode("login");

$("#authForm").onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const signup = authMode === "signup";
  const payload = signup
    ? { full_name: fd.get("full_name").trim(), email: fd.get("email").trim(), password: fd.get("password") }
    : { email: fd.get("email").trim(), password: fd.get("password") };
  $("#authError").textContent = "";
  await busy($("#authSubmit"), signup ? "Creating…" : "Logging in…", async () => {
    try {
      const res = await api(signup ? "/api/auth/register" : "/api/auth/login", { method: "POST", body: payload });
      setToken(res.access_token); currentUser = res.user || null;
      e.target.reset();
      await loadVendor();
      if (!urlSlug) syncOwnShop();
      renderAll();
      toast(signup ? "Account created — now create your store" : "Welcome back");
      showView("dashboard");
    } catch (err) { $("#authError").textContent = err.message; }
  });
};

function resetVendorState() {
  currentUser = null; store = null; products = []; orders = []; stats = null; editingProduct = null;
  $("#storeForm").reset(); $("#productForm").reset();
  $("#productModal").classList.add("hidden");
  if (!urlSlug) { shop = { store: null, products: [], notFound: false }; cart = []; }
}
function logout() { setToken(null); resetVendorState(); renderAll(); showView("auth"); toast("Logged out"); }
$("#logoutBtn").onclick = logout; $("#logoutBtn2").onclick = logout;
window.addEventListener("whom:unauthorized", () => { resetVendorState(); renderAll(); showView("auth"); toast("Session expired — please log in again"); });

function renderAuth() {
  const logged = isLoggedIn();
  $("#logoutBtn").style.display = logged ? "inline-flex" : "none";
  $("#userChip").style.display = logged && currentUser ? "inline-flex" : "none";
  if (currentUser) $("#userChip").textContent = currentUser.full_name || currentUser.email;
  $("#authLoggedIn").style.display = logged ? "block" : "none";
  $("#authCard").style.display = logged ? "none" : "block";
  if (logged && currentUser) {
    $("#authUserLine").textContent = (currentUser.full_name || "") + " • " + (currentUser.email || "");
    $("#authStoreLine").textContent = store ? "Your store: " + store.name : "You have no store yet — create one in your Dashboard.";
  }
  $("#dashboardGate").classList.toggle("hidden", logged);
  $("#dashboardContent").style.display = logged ? "block" : "none";
  $("#ordersGate").classList.toggle("hidden", logged);
  $("#ordersContent").style.display = logged ? "block" : "none";
}

// ───────────── DATA LOADING ─────────────
async function loadVendor() {
  const [s, p, o, st] = await Promise.all([api("/api/store"), api("/api/products"), api("/api/orders"), api("/api/stats")]);
  store = s; products = p || []; orders = o || []; stats = st;
}
async function refreshVendor() {
  try { await loadVendor(); if (!urlSlug) syncOwnShop(); renderAll(); } catch (e) { if (e.status !== 401) toast(e.message); }
}
/** Logged-in vendor without a ?store= link: the storefront previews THEIR OWN store (active products only). */
function syncOwnShop() {
  shop = store ? { store, products: products.filter((p) => p.is_active), notFound: false } : { store: null, products: [], notFound: false };
  restoreCart();
}
async function loadShop(slug) {
  try {
    const base = "/api/public/store/" + encodeURIComponent(slug);
    const [s, p] = await Promise.all([api(base), api(base + "/products")]);
    shop = { store: s, products: p || [], notFound: false };
  } catch (e) {
    if (e.status === 404) shop = { store: null, products: [], notFound: true };
    else { toast(e.message); throw e; }
  }
  restoreCart();
}
async function refreshShop() { try { if (urlSlug) await loadShop(urlSlug); else syncOwnShop(); renderShop(); updateCart(); } catch (e) { /* toast already shown */ } }

// ───────────── STOREFRONT ─────────────
function renderShop() {
  const s = shop.store, list = shop.products, logged = isLoggedIn();
  $("#storeNotFound").classList.toggle("hidden", !shop.notFound);
  $("#loginPrompt").classList.toggle("hidden", !(!s && !shop.notFound && !logged));
  if (!s) {
    $("#storeCategory").textContent = "Your Store"; $("#storeName").textContent = shop.notFound ? "Store not found" : "—";
    $("#storeDesc").textContent = shop.notFound ? "" : logged ? "Create your store in the Dashboard — it will belong to your account." : "Log in to create and manage your store.";
    $("#storeMeta").textContent = "—"; $("#catalogSub").textContent = "—"; $("#totalProducts").textContent = "0";
    $("#productGrid").innerHTML = ""; $("#emptySearch").classList.add("hidden");
    const showEmpty = logged && !shop.notFound;
    $("#emptyProducts").classList.toggle("hidden", !showEmpty);
    $("#emptyProductsText").textContent = "No store yet — create your store first, then add products.";
    $("#emptyDashBtn").style.display = "inline-flex";
    renderCategories([]);
    return;
  }
  $("#storeName").textContent = s.name;
  $("#storeDesc").textContent = s.description || "";
  $("#storeCategory").textContent = s.category || "Store";
  $("#storeMeta").textContent = [s.location, s.whatsapp_number].filter(Boolean).join(" • ") || "—";
  $("#catalogSub").textContent = "Products from " + s.name;
  $("#totalProducts").textContent = String(list.length);
  renderCategories([...new Set(list.map((p) => p.category).filter(Boolean))]);
  renderProducts();
}
function renderCategories(cats) {
  const sel = $("#categoryFilter"), keep = sel.value;
  sel.innerHTML = '<option value="all">All Categories</option>' + cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  sel.value = cats.includes(keep) ? keep : "all";
}
function filteredProducts() {
  const q = $("#searchInput").value.trim().toLowerCase(), cat = $("#categoryFilter").value;
  return shop.products.filter((p) => (cat === "all" || p.category === cat) &&
    (p.name.toLowerCase().includes(q) || (p.description || "").toLowerCase().includes(q)));
}
function renderProducts() {
  const list = filteredProducts(), grid = $("#productGrid"), s = shop.store;
  grid.innerHTML = list.map((p) => {
    const out = p.stock <= 0;
    const img = p.image_url
      ? `<img src="${esc(p.image_url)}" alt="${esc(p.name)}" loading="lazy" referrerpolicy="no-referrer">`
      : `<div class="product-ph" aria-hidden="true">${esc((p.name || "?").trim().charAt(0).toUpperCase())}</div>`;
    return `<article class="card product">${img}<div class="product-body"><span class="muted small">${fmt(p.category)}</span><h3>${fmt(p.name)}</h3><p class="muted small">${esc(p.description || "")}</p><div class="product-actions"><span class="price">${money(p.price, s.currency)}</span><span class="stock ${p.stock < 6 ? "low" : ""}">${out ? "Out of stock" : esc(p.stock) + " left"}</span></div><button class="btn btn-primary btn-block" type="button" data-add="${Number(p.id)}" ${out ? "disabled" : ""}>${out ? "Sold out" : "Add to Cart"}</button></div></article>`;
  }).join("");
  const none = shop.products.length === 0;
  $("#emptyProducts").classList.toggle("hidden", !none);
  $("#emptyProductsText").textContent = isOwnShop() ? "No products yet — add some in your Dashboard." : "This store has no products yet. Check back soon.";
  $("#emptyDashBtn").style.display = isOwnShop() ? "inline-flex" : "none";
  $("#emptySearch").classList.toggle("hidden", !(!none && list.length === 0));
}
$("#productGrid").addEventListener("click", (e) => { const b = e.target.closest("[data-add]"); if (b) addToCart(Number(b.dataset.add)); });
// Broken image URLs → neat placeholder (instead of an inline onerror attribute)
$("#productGrid").addEventListener("error", (e) => {
  if (e.target.tagName !== "IMG") return;
  const ph = document.createElement("div"); ph.className = "product-ph"; ph.textContent = (e.target.alt || "?").charAt(0).toUpperCase();
  e.target.replaceWith(ph);
}, true);
$("#searchInput").oninput = renderProducts; $("#categoryFilter").onchange = renderProducts;

// ───────────── CART ─────────────
const cartKey = () => (shop.store ? "whom_cart_" + shop.store.slug : null);
function saveCart() { const k = cartKey(); if (k) store_(k, cart.length ? cart : undefined); }
function restoreCart() {
  const k = cartKey(); const saved = k ? load_(k) : null;
  cart = Array.isArray(saved) ? saved.filter((i) => i && shop.products.some((p) => p.id === i.product_id)).map((i) => ({ product_id: i.product_id, qty: Math.max(1, i.qty | 0) })) : [];
}
function addToCart(id) {
  const p = shop.products.find((x) => x.id === id); if (!p) return;
  const ex = cart.find((i) => i.product_id === id);
  if ((ex ? ex.qty : 0) + 1 > p.stock) { toast("Only " + p.stock + " available"); return; }
  if (ex) ex.qty++; else cart.push({ product_id: id, qty: 1 });
  updateCart(); toast("Added to cart"); openCart();
}
function updateCart() {
  cart = cart.filter((i) => shop.products.some((p) => p.id === i.product_id));   // drop items that disappeared
  $("#cartCount").textContent = cart.reduce((s, i) => s + i.qty, 0);
  const wrap = $("#cartItems"); let total = 0;
  wrap.innerHTML = cart.length ? cart.map((item) => {
    const p = shop.products.find((x) => x.id === item.product_id); total += p.price * item.qty;
    return `<div class="cart-line"><div><strong>${fmt(p.name)}</strong><br><span class="muted small">${money(p.price, shop.store.currency)} × ${item.qty}</span></div><div class="qty"><button type="button" class="qty-btn" data-qty="${p.id}" data-d="-1" aria-label="Remove one">−</button><span>${item.qty}</span><button type="button" class="qty-btn" data-qty="${p.id}" data-d="1" aria-label="Add one">+</button></div></div>`;
  }).join("") : "<p class='muted'>Your cart is empty.</p>";
  $("#cartTotal").textContent = cart.length ? moneyRaw(total, shop.store?.currency) : "—";
  $("#checkoutSubmit").disabled = !cart.length;
  saveCart();
}
$("#cartItems").addEventListener("click", (e) => {
  const b = e.target.closest("[data-qty]"); if (!b) return;
  const id = Number(b.dataset.qty), d = Number(b.dataset.d), it = cart.find((i) => i.product_id === id), p = shop.products.find((x) => x.id === id);
  if (!it || !p) return;
  if (d > 0 && it.qty + 1 > p.stock) { toast("Only " + p.stock + " available"); return; }
  it.qty += d; if (it.qty <= 0) cart = cart.filter((i) => i.product_id !== id);
  updateCart();
});
function openCart() { $("#cartDrawer").classList.remove("hidden"); $("#overlay").classList.remove("hidden"); }
function closeCart() { $("#cartDrawer").classList.add("hidden"); $("#overlay").classList.add("hidden"); }
$("#cartBtn").onclick = openCart; $("#closeCart").onclick = closeCart; $("#overlay").onclick = closeCart;

// ───────────── CHECKOUT (public) ─────────────
$("#checkoutForm").onsubmit = async (e) => {
  e.preventDefault();
  if (!cart.length) return toast("Cart is empty");
  if (!shop.store) return toast("No store selected");
  const fd = new FormData(e.target);
  const payload = {
    store_slug: shop.store.slug,                               // the backend decides prices, totals and stock
    customer_name: fd.get("customer_name").trim(), customer_phone: fd.get("customer_phone").trim(),
    delivery_address: fd.get("delivery_address").trim(), note: (fd.get("note") || "").trim(),
    items: cart.map((i) => ({ product_id: i.product_id, qty: i.qty })),
  };
  $("#checkoutError").textContent = "";
  await busy($("#checkoutSubmit"), "Placing order…", async () => {
    try {
      const order = await api("/api/orders", { method: "POST", body: payload });
      cart = []; saveCart(); e.target.reset(); closeCart();
      showOrderDone(order);
      await refreshShop();                                      // stock changed
      if (isLoggedIn() && currentUser) refreshVendor();
    } catch (err) {
      $("#checkoutError").textContent = err.message;
      if (err.status === 409 || err.status === 422) refreshShop();   // out of stock / unavailable → resync
    }
  });
};
function orderMessage(o, cur) {
  const lines = (o.items || []).map((i) => `• ${i.name} × ${i.qty}`).join("\n");
  return `Hi! New order #${o.id}\n${lines}\nTotal: ${cur}${Number(o.total).toLocaleString()}\n\nName: ${o.customer_name}\nPhone: ${o.customer_phone}\nAddress: ${o.delivery_address}${o.note ? "\nNote: " + o.note : ""}`;
}
function showOrderDone(o) {
  lastOrder = o;
  $("#doneText").textContent = `Order #${o.id} · ${(o.items || []).reduce((s, i) => s + i.qty, 0)} item(s) · ${o.store?.currency || CURRENCY}${Number(o.total).toLocaleString()}`;
  $("#orderDoneModal").classList.remove("hidden");
}
$("#doneWhatsapp").onclick = () => {
  if (!lastOrder) return;
  window.open(waLink(lastOrder.store?.whatsapp_number, orderMessage(lastOrder, lastOrder.store?.currency || CURRENCY)), "_blank", "noopener");
};
$("#doneClose").onclick = () => $("#orderDoneModal").classList.add("hidden");

// ───────────── DASHBOARD ─────────────
function storeUrl() {
  return store?.slug ? location.origin + location.pathname.replace(/[^/]*$/, "") + "?store=" + store.slug : "";
}
function renderDashboard() {
  $("#noStoreCard").style.display = store ? "none" : "block";
  $("#dashboardSub").textContent = currentUser ? "Signed in as " + (currentUser.full_name || currentUser.email) + (store ? " • Store: " + store.name : " • No store yet") : "—";
  const f = $("#storeForm");
  if (store && !f.contains(document.activeElement)) {          // don't clobber what the vendor is typing
    f.elements.name.value = store.name || ""; f.elements.whatsapp_number.value = store.whatsapp_number || "";
    f.elements.category.value = store.category || ""; f.elements.location.value = store.location || ""; f.elements.description.value = store.description || "";
  }
  const link = storeUrl();
  $("#storeLink").textContent = link || "Create your store to get a link";
  $("#openLinkBtn").style.display = link ? "inline-flex" : "none"; if (link) $("#openLinkBtn").href = link;
  $("#copyLinkBtn").disabled = !link;
  $("#emptyVendorProducts").classList.toggle("hidden", products.length !== 0);
  $("#vendorTable").innerHTML = products.map((p) => `<tr><td><strong>${fmt(p.name)}</strong><br><span class="muted small">${fmt(p.category)}</span></td><td>${money(p.price, store?.currency)}</td><td>${Number(p.stock)}</td><td><span class="chip ${p.is_active ? "on" : "off"}">${p.is_active ? "Active" : "Paused"}</span></td><td class="actions"><button class="btn btn-outline" type="button" data-edit="${Number(p.id)}">Edit</button> <button class="btn btn-outline" type="button" data-toggle="${Number(p.id)}">${p.is_active ? "Pause" : "Activate"}</button></td></tr>`).join("");
}
function renderStats() {
  const cur = store?.currency;
  if (!stats || !store) { ["#statToday", "#statWeek", "#statPending"].forEach((s) => ($(s).textContent = "—")); $("#statTodaySub").textContent = "—"; $("#statProducts").textContent = String(products.length); return; }
  $("#statToday").textContent = moneyRaw(stats.today_total, cur); $("#statTodaySub").textContent = (stats.today_orders ?? 0) + ((stats.today_orders ?? 0) === 1 ? " order today" : " orders today");
  $("#statWeek").textContent = moneyRaw(stats.week_total, cur); $("#statPending").textContent = String(stats.pending_orders ?? 0);
  $("#statProducts").textContent = String(stats.product_count ?? products.length);
}
$("#copyLinkBtn").onclick = async () => {
  const link = storeUrl(); if (!link) return;
  try { await navigator.clipboard.writeText(link); }
  catch (e) { const t = document.createElement("textarea"); t.value = link; document.body.appendChild(t); t.select(); try { document.execCommand("copy"); } catch (_) { /* ignore */ } t.remove(); }
  toast("Link copied");
};
$("#vendorTable").addEventListener("click", async (e) => {
  const ed = e.target.closest("[data-edit]"), tg = e.target.closest("[data-toggle]");
  if (ed) return editProduct(Number(ed.dataset.edit));
  if (tg) {
    const p = products.find((x) => x.id === Number(tg.dataset.toggle)); if (!p) return;
    tg.disabled = true;
    try { await api("/api/products/" + p.id, { method: "PATCH", body: { is_active: !p.is_active } }); await refreshVendor(); toast(p.is_active ? "Product paused" : "Product activated"); }
    catch (err) { toast(err.message); tg.disabled = false; }
  }
});

// Product modal
function openProductModal(p) {
  editingProduct = p || null; const f = $("#productForm"); f.reset(); $("#productError").textContent = "";
  if (p) { f.elements.name.value = p.name; f.elements.price.value = p.price; f.elements.stock.value = p.stock; f.elements.category.value = p.category || ""; f.elements.description.value = p.description || ""; f.elements.image_url.value = p.image_url || ""; }
  $("#modalTitle").textContent = p ? "Edit Product" : "Add Product";
  $("#productModal").classList.remove("hidden"); f.elements.name.focus();
}
function editProduct(id) { const p = products.find((x) => x.id === id); if (p) openProductModal(p); }
$("#addProductBtn").onclick = () => { if (!store) { toast("Create your store first"); $("#storeForm").elements.name.focus(); return; } openProductModal(null); };
$("#closeModal").onclick = () => $("#productModal").classList.add("hidden");
$("#productModal").addEventListener("mousedown", (e) => { if (e.target.id === "productModal") $("#productModal").classList.add("hidden"); });
$("#productForm").onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const data = { name: fd.get("name").trim(), price: Number(fd.get("price")), stock: Number(fd.get("stock")), category: fd.get("category").trim(), description: fd.get("description").trim(), image_url: fd.get("image_url").trim() };
  await busy($("#productSubmit"), "Saving…", async () => {
    try {
      if (editingProduct) await api("/api/products/" + editingProduct.id, { method: "PATCH", body: data });
      else await api("/api/products", { method: "POST", body: data });
      $("#productModal").classList.add("hidden"); toast("Product saved"); await refreshVendor();
    } catch (err) { $("#productError").textContent = err.message; }
  });
};

// Store form
$("#storeForm").onsubmit = async (e) => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target)); Object.keys(d).forEach((k) => (d[k] = String(d[k]).trim()));
  await busy($("#storeSubmit"), "Saving…", async () => {
    try {
      const wasNew = !store;
      store = await api("/api/store", { method: "PUT", body: d });
      toast(wasNew ? "Store created — it belongs to your account" : "Store saved");
      e.target.elements.name.blur(); await refreshVendor();
    } catch (err) { toast(err.message); }
  });
};

// ───────────── ORDERS ─────────────
function renderOrders() {
  const list = orders.filter((o) => orderFilter === "all" || o.status === orderFilter), cur = store?.currency;
  $("#emptyOrders").classList.toggle("hidden", orders.length !== 0);
  $("#ordersList").innerHTML = list.map((o) => {
    const items = (o.items || []).map((i) => esc(i.name) + " × " + Number(i.qty)).join(", ");
    const when = o.created_at ? new Date(o.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
    const opts = ["New", "Preparing", "Delivered"].map((s) => `<option ${o.status === s ? "selected" : ""}>${s}</option>`).join("");
    return `<div class="card order"><div><strong>#${Number(o.id)} — ${fmt(o.customer_name)}</strong> <span class="badge-status ${esc(o.status)}">${esc(o.status)}</span><p class="muted small">${items || "—"}</p><p class="small">${fmt(o.customer_phone)} | ${fmt(o.delivery_address)}${o.note ? " | Note: " + esc(o.note) : ""}</p><p class="muted small">${esc(when)}</p></div><div class="order-side"><strong>${money(o.total, cur)}</strong><div class="order-actions"><select data-status="${Number(o.id)}" aria-label="Order status">${opts}</select><button class="btn btn-dark" type="button" data-receipt="${Number(o.id)}">WhatsApp Receipt</button></div></div></div>`;
  }).join("");
}
$("#ordersList").addEventListener("change", async (e) => {
  const sel = e.target.closest("[data-status]"); if (!sel) return;
  sel.disabled = true;
  try { await api(`/api/orders/${Number(sel.dataset.status)}/status`, { method: "PATCH", body: { status: sel.value } }); toast("Order updated"); await refreshVendor(); }
  catch (err) { toast(err.message); renderOrders(); }
});
$("#ordersList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-receipt]"); if (!b) return;
  const o = orders.find((x) => x.id === Number(b.dataset.receipt)); if (!o) return;
  const cur = store?.currency || CURRENCY;
  const msg = `Hi ${o.customer_name}! Your order #${o.id} is ${o.status}. Total: ${cur}${Number(o.total).toLocaleString()}. Items: ${(o.items || []).map((i) => i.name + " x" + i.qty).join(", ")}. Thank you!`;
  window.open(waLink(o.customer_phone, msg), "_blank", "noopener");
});
// Scoped to the order filters ONLY (the old code bound every .pill-btn, which broke the Sign up / Log in tabs)
$("#orderFilters").addEventListener("click", (e) => {
  const b = e.target.closest(".pill-btn"); if (!b) return;
  document.querySelectorAll("#orderFilters .pill-btn").forEach((x) => x.classList.toggle("active", x === b));
  orderFilter = b.dataset.status; renderOrders();
});

// ───────────── render + boot ─────────────
function renderAll() { renderAuth(); renderShop(); updateCart(); renderDashboard(); renderStats(); renderOrders(); }

async function init() {
  setAuthMode("signup");
  const up = await checkHealth();
  if (isLoggedIn() && up) {
    try { currentUser = await api("/api/auth/me"); await loadVendor(); }
    catch (e) { if (e.status !== 401) { toast(e.message); needsRetry = true; } }   // 401 handled by the unauthorized event
  } else if (isLoggedIn()) needsRetry = true;
  if (urlSlug) { try { await loadShop(urlSlug); } catch (e) { needsRetry = true; } } else syncOwnShop();
  renderAll();
  showView(urlSlug ? "storefront" : isLoggedIn() && currentUser ? "dashboard" : "auth");
}

// Keep the vendor's orders fresh: every 30s while the tab is visible on Dashboard/Orders.
setInterval(async () => {
  if (document.visibilityState !== "visible") return;
  if (!(await checkHealth())) return;
  if (!isLoggedIn() || !currentUser || !["dashboard", "orders"].includes(activeView())) return;
  if (document.activeElement && document.activeElement.closest("#ordersList, #storeForm, #productForm")) return;
  const before = Math.max(0, ...orders.map((o) => o.id));
  try {
    [orders, stats] = await Promise.all([api("/api/orders"), api("/api/stats")]);
    renderOrders(); renderStats();
    if (orders.some((o) => o.id > before) && before > 0) toast("New order received");
  } catch (e) { /* silent: next tick retries */ }
}, 30000);

init();
