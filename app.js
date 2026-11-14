// app.js - Vanilla JS. Zero hardcoded data. Auth FIRST, then Store, then Products/Orders.
// Flow: 1) Register/Login (creates User) -> 2) Create Store (belongs to User) -> 3) Add Products -> 4) Receive Orders
let currentUser = null, store = null, products = [], orders = [], stats = null, cart = [], orderFilter = "all", editingProduct = null, authMode = "signup";
const $ = (s) => document.querySelector(s);
const money = (n) => (store?.currency || CURRENCY) + Number(n || 0).toLocaleString();
const fmt = (v) => (v === null || v === undefined || v === "" ? "—" : v);
function toast(m) { const t = $("#toast"); t.textContent = m; t.classList.remove("hidden"); setTimeout(() => t.classList.add("hidden"), 2600); }
function goDashboard() { showView("dashboard"); }
function showView(name) {
  // Gate vendor pages behind login
  if ((name === "dashboard" || name === "orders") && !isLoggedIn()) {
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    document.getElementById("view-auth").classList.add("active");
    document.querySelectorAll(".nav-btn").forEach((x) => x.classList.toggle("active", x.dataset.view === "auth"));
    toast("Log in first — your dashboard belongs to your account"); return;
  }
  document.querySelectorAll(".nav-btn").forEach((x) => x.classList.toggle("active", x.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.getElementById("view-" + name).classList.add("active");
}
document.querySelectorAll(".nav-btn").forEach((b) => (b.onclick = () => showView(b.dataset.view)));
// --- AUTH ---
function setAuthMode(mode) {
  authMode = mode;
  $("#tabSignup").classList.toggle("active", mode === "signup");
  $("#tabLogin").classList.toggle("active", mode === "login");
  $("#authTitle").textContent = mode === "signup" ? "Create your vendor account" : "Log in to your account";
  $("#authSubmit").textContent = mode === "signup" ? "Create account" : "Log in";
  $("#authFullName").closest("label").style.display = mode === "signup" ? "block" : "none";
  $("#authFullName").required = mode === "signup";
  $("#authError").textContent = "";
}
$("#tabSignup").onclick = () => setAuthMode("signup");
$("#tabLogin").onclick = () => setAuthMode("login");
$("#authForm").onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = authMode === "signup"
    ? { full_name: fd.get("full_name"), email: fd.get("email"), password: fd.get("password") }
    : { email: fd.get("email"), password: fd.get("password") };
  try {
    const res = await api(authMode === "signup" ? "/api/auth/register" : "/api/auth/login", { method: "POST", body: JSON.stringify(payload) });
    setToken(res.access_token); currentUser = res.user || null;
    toast(authMode === "signup" ? "Account created — now create your store" : "Welcome back");
    await loadAll(); showView("dashboard");
  } catch (err) { $("#authError").textContent = "Could not " + (authMode === "signup" ? "create account" : "log in") + " — check email / password"; }
};
async function logout() {
  setToken(null); currentUser = null; store = null; products = []; orders = [];
  updateAuthUI(); showView("auth"); toast("Logged out");
}
$("#logoutBtn").onclick = logout; $("#logoutBtn2").onclick = logout;
function updateAuthUI() {
  const logged = isLoggedIn();
  $("#logoutBtn").style.display = logged ? "inline-block" : "none";
  $("#userChip").style.display = logged && currentUser ? "inline-block" : "none";
  if (currentUser) $("#userChip").textContent = currentUser.full_name || currentUser.email;
  $("#authLoggedIn").style.display = logged ? "block" : "none";
  $("#authForm").style.display = logged ? "none" : "block";
  if (logged && currentUser) {
    $("#authUserLine").textContent = (currentUser.full_name || "") + " • " + (currentUser.email || "");
    $("#authStoreLine").textContent = store ? "Your store: " + store.name : "You have no store yet — create one in your Dashboard.";
  }
  $("#dashboardGate").classList.toggle("hidden", logged);
  $("#dashboardContent").style.display = logged ? "block" : "none";
  $("#ordersGate").classList.toggle("hidden", logged);
  $("#ordersContent").style.display = logged ? "block" : "none";
  $("#loginPrompt").classList.toggle("hidden", logged);
}
// --- LOAD ---
async function loadAll() {
  updateAuthUI();
  if (!API_BASE) { $("#configBanner").classList.remove("hidden"); $("#apiStatus").textContent = "API: Not connected"; renderEmpty(); return; }
  $("#configBanner").classList.add("hidden");
  $("#apiStatus").textContent = "API: Live"; $("#apiStatus").classList.add("live");
  // If logged in, restore user from token first
  if (isLoggedIn() && !currentUser) {
    try { currentUser = await api("/api/auth/me"); } catch (e) { setToken(null); currentUser = null; updateAuthUI(); showView("auth"); toast("Session expired — please log in again"); return; }
    updateAuthUI();
  }
  if (!isLoggedIn()) { renderEmpty(); return; }
  try {
    const [s, p, o, st] = await Promise.all([
      api("/api/store").catch(() => null),
      api("/api/products"),
      api("/api/orders"),
      api("/api/stats").catch(() => null),
    ]);
    store = s; products = p || []; orders = o || []; stats = st;
    updateAuthUI(); renderStore(); renderProducts(); renderDashboard(); renderOrders(); renderStats();
  } catch (e) {
    if (String(e.message).includes("UNAUTHORIZED")) { setToken(null); currentUser = null; updateAuthUI(); showView("auth"); toast("Please log in"); return; }
    toast("Backend not reachable — check API_BASE / CORS"); renderEmpty();
  }
}
function renderEmpty() {
  $("#storeName").textContent = "—"; $("#storeDesc").textContent = isLoggedIn() ? "Create your store in the Dashboard." : "Log in to create and manage your store.";
  $("#emptyProducts").classList.remove("hidden"); $("#emptyOrders").classList.remove("hidden");
}
function renderStore() {
  $("#noStoreCard").style.display = store ? "none" : "block";
  if (!store) { $("#storeName").textContent = "No store yet"; $("#storeDesc").textContent = "Create your store below in the Dashboard — it will belong to your account."; $("#storeLink").textContent = "—"; return; }
  $("#storeName").textContent = fmt(store.name);
  $("#storeDesc").textContent = fmt(store.description);
  $("#storeCategory").textContent = fmt(store.category);
  $("#storeMeta").textContent = [store.location, store.whatsapp_number].filter(Boolean).join(" • ") || "—";
  $("#catalogSub").textContent = store.name ? "Products from " + store.name : "—";
  $("#dashboardSub").textContent = currentUser ? "Signed in as " + (currentUser.full_name || currentUser.email) + " • Store: " + store.name : "—";
  $("#storeLink").textContent = store.slug ? window.location.origin + "/store/" + store.slug : "—";
  const f = $("#storeForm");
  if (f) { f.name.value = store.name || ""; f.whatsapp_number.value = store.whatsapp_number || ""; f.category.value = store.category || ""; f.location.value = store.location || ""; f.description.value = store.description || ""; }
  const cats = [...new Set(products.map((p) => p.category).filter(Boolean))];
  const sel = $("#categoryFilter"); sel.innerHTML = '<option value="all">All Categories</option>' + cats.map((c) => `<option>${c}</option>`).join("");
}
function renderStats() {
  if (!stats) { $("#statToday").textContent = "—"; $("#statWeek").textContent = "—"; $("#statPending").textContent = "—"; $("#statProducts").textContent = String(products.length); return; }
  $("#statToday").textContent = money(stats.today_total); $("#statTodaySub").textContent = (stats.today_orders ?? 0) + " orders today";
  $("#statWeek").textContent = money(stats.week_total); $("#statPending").textContent = String(stats.pending_orders ?? 0); $("#statProducts").textContent = String(stats.product_count ?? products.length);
  $("#totalProducts").textContent = String(stats.product_count ?? products.length);
}
function filteredProducts() {
  const q = $("#searchInput").value.toLowerCase(); const cat = $("#categoryFilter").value;
  return products.filter((p) => (cat === "all" || p.category === cat) && (p.name.toLowerCase().includes(q) || (p.description || "").toLowerCase().includes(q)));
}
function renderProducts() {
  const list = filteredProducts(); const grid = $("#productGrid"); grid.innerHTML = "";
  $("#emptyProducts").classList.toggle("hidden", !(products.length === 0));
  $("#emptyProductsText").textContent = store ? "This store has no products." : "No store yet — create your store first, then add products.";
  $("#emptySearch").classList.toggle("hidden", !(products.length > 0 && list.length === 0));
  list.forEach((p) => {
    const el = document.createElement("article"); el.className = "card product";
    el.innerHTML = `<img src="${p.image_url || ""}" onerror="this.style.display='none'"><div class="product-body"><span class="muted small">${fmt(p.category)}</span><h3>${fmt(p.name)}</h3><p class="muted small">${fmt(p.description)}</p><div class="product-actions"><span class="price">${money(p.price)}</span><span class="stock ${p.stock < 6 ? "low" : ""}">${p.stock === 0 ? "Out of stock" : p.stock + " left"}</span></div><button class="btn btn-primary btn-block" style="margin-top:10px" ${p.stock === 0 ? "disabled" : ""}>Add to Cart</button></div>`;
    el.querySelector("button").onclick = () => addToCart(p.id); grid.appendChild(el);
  });
}
function addToCart(id) { const ex = cart.find((i) => i.product_id === id); if (ex) ex.qty++; else cart.push({ product_id: id, qty: 1 }); updateCart(); toast("Added to cart"); openCart(); }
function updateCart() {
  $("#cartCount").textContent = cart.reduce((s, i) => s + i.qty, 0);
  const wrap = $("#cartItems"); wrap.innerHTML = cart.length ? "" : "<p class='muted'>Your cart is empty.</p>";
  let total = 0;
  cart.forEach((item) => { const p = products.find((x) => x.id === item.product_id); if (!p) return; total += p.price * item.qty;
    const d = document.createElement("div"); d.style.cssText = "display:flex;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid #eee";
    d.innerHTML = `<div><strong>${fmt(p.name)}</strong><br><span class="muted small">${money(p.price)} x ${item.qty}</span></div><div><button onclick="changeQty(${p.id},1)">+</button> <button onclick="changeQty(${p.id},-1)">-</button></div>`;
    wrap.appendChild(d); });
  $("#cartTotal").textContent = cart.length ? money(total) : "—";
}
function changeQty(id, d) { const it = cart.find((i) => i.product_id === id); if (!it) return; it.qty += d; if (it.qty <= 0) cart = cart.filter((i) => i.product_id !== id); updateCart(); }
function openCart() { $("#cartDrawer").classList.remove("hidden"); $("#overlay").classList.remove("hidden"); }
function closeCart() { $("#cartDrawer").classList.add("hidden"); $("#overlay").classList.add("hidden"); }
$("#cartBtn").onclick = openCart; $("#closeCart").onclick = closeCart; $("#overlay").onclick = closeCart;
$("#searchInput").oninput = renderProducts; $("#categoryFilter").onchange = renderProducts;
$("#copyLinkBtn").onclick = () => { navigator.clipboard.writeText($("#storeLink").textContent); toast("Link copied"); };
function renderDashboard() {
  const tbody = $("#vendorTable"); tbody.innerHTML = "";
  $("#emptyVendorProducts").classList.toggle("hidden", products.length !== 0);
  products.forEach((p) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><strong>${fmt(p.name)}</strong><br><span class="muted small">${fmt(p.category)}</span></td><td>${money(p.price)}</td><td>${p.stock}</td><td>${p.is_active ? "Active" : "Paused"}</td><td><button class="btn btn-outline" onclick="editProduct(${p.id})">Edit</button> <button class="btn btn-outline" onclick="toggleProduct(${p.id})">${p.is_active ? "Pause" : "Activate"}</button></td>`;
    tbody.appendChild(tr);
  });
}
function editProduct(id) { editingProduct = products.find((p) => p.id === id); const f = $("#productForm"); f.name.value = editingProduct.name; f.price.value = editingProduct.price; f.stock.value = editingProduct.stock; f.category.value = editingProduct.category; f.description.value = editingProduct.description || ""; f.image_url.value = editingProduct.image_url || ""; $("#modalTitle").textContent = "Edit Product"; $("#productModal").classList.remove("hidden"); }
async function toggleProduct(id) { const p = products.find((x) => x.id === id); await api("/api/products/" + id, { method: "PATCH", body: JSON.stringify({ is_active: !p.is_active }) }); loadAll(); }
$("#addProductBtn").onclick = () => { if (!store) { toast("Create your store first"); return; } editingProduct = null; $("#productForm").reset(); $("#modalTitle").textContent = "Add Product"; $("#productModal").classList.remove("hidden"); };
$("#closeModal").onclick = () => $("#productModal").classList.add("hidden");
$("#productForm").onsubmit = async (e) => { e.preventDefault(); const fd = new FormData(e.target); const data = Object.fromEntries(fd); data.price = +data.price; data.stock = +data.stock;
  if (editingProduct) await api("/api/products/" + editingProduct.id, { method: "PATCH", body: JSON.stringify(data) }); else await api("/api/products", { method: "POST", body: JSON.stringify(data) });
  $("#productModal").classList.add("hidden"); toast("Product saved"); loadAll(); };
$("#storeForm").onsubmit = async (e) => { e.preventDefault(); const data = Object.fromEntries(new FormData(e.target)); const updated = await api("/api/store", { method: "PUT", body: JSON.stringify(data) }); store = updated; updateAuthUI(); renderStore(); toast("Store saved — it now belongs to your account"); loadAll(); };
function renderOrders() {
  const list = orders.filter((o) => orderFilter === "all" || o.status === orderFilter);
  const wrap = $("#ordersList"); wrap.innerHTML = list.length ? "" : "";
  $("#emptyOrders").classList.toggle("hidden", !(orders.length === 0));
  list.forEach((o) => {
    const items = (o.items || []).map((i) => i.name + " x " + i.qty).join(", ");
    const el = document.createElement("div"); el.className = "card order";
    el.innerHTML = `<div><strong>#${o.id} - ${fmt(o.customer_name)}</strong> <span class="badge-status ${o.status}">${o.status}</span><p class="muted small">${items || "—"}</p><p class="small">${fmt(o.customer_phone)} | ${fmt(o.delivery_address)}${o.note ? " | Note: " + o.note : ""}</p></div><div style="text-align:right"><strong>${money(o.total)}</strong><br><div style="display:flex;gap:6px;margin-top:8px"><select onchange="updateStatus(${o.id},this.value)"><option ${o.status === "New" ? "selected" : ""}>New</option><option ${o.status === "Preparing" ? "selected" : ""}>Preparing</option><option ${o.status === "Delivered" ? "selected" : ""}>Delivered</option></select><button class="btn btn-dark" onclick="sendReceipt(${o.id})">WhatsApp Receipt</button></div></div>`;
    wrap.appendChild(el);
  });
}
async function updateStatus(id, status) { await api(`/api/orders/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }); toast("Order updated"); loadAll(); }
function sendReceipt(id) { const o = orders.find((x) => x.id === id); const msg = `Hi ${o.customer_name}! Your order #${o.id} is ${o.status}. Total: ${money(o.total)}. Items: ${(o.items || []).map((i) => i.name + " x" + i.qty).join(", ")}. Thank you!`; window.open(`https://wa.me/${o.customer_phone.replace(/[^0-9]/g, "")}?text=${encodeURIComponent(msg)}`, "_blank"); }
document.querySelectorAll(".pill-btn").forEach((b) => (b.onclick = () => { document.querySelectorAll(".pill-btn").forEach((x) => x.classList.remove("active")); b.classList.add("active"); orderFilter = b.dataset.status; renderOrders(); }));
$("#checkoutForm").onsubmit = async (e) => { e.preventDefault(); if (!cart.length) return toast("Cart is empty");
  const fd = new FormData(e.target); const payload = { customer_name: fd.get("customer_name"), customer_phone: fd.get("customer_phone"), delivery_address: fd.get("delivery_address"), note: fd.get("note"), items: cart.map((i) => ({ product_id: i.product_id, qty: i.qty })) };
  try { const order = await api("/api/orders", { method: "POST", body: JSON.stringify(payload) }); cart = []; updateCart(); closeCart(); e.target.reset(); toast("Order placed! #" + order.id); loadAll(); } catch (err) { toast("Could not place order - check backend"); }
};
loadAll();
