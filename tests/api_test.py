#!/usr/bin/env python3
"""End-to-end API tests for server.php. Usage: api_test.py BASE_URL RATE_LIMITED_BASE_URL"""
import json, sys, urllib.request, urllib.error

BASE, BASE_RL = sys.argv[1].rstrip("/"), sys.argv[2].rstrip("/")
passed = failed = 0

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None
opener = urllib.request.build_opener(NoRedirect)

def call(method, path, body=None, token=None, base=BASE, headers=None):
    h = {"Content-Type": "application/json", **(headers or {})}
    if token: h["Authorization"] = "Bearer " + token
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method, headers=h)
    try:
        r = opener.open(req)
    except urllib.error.HTTPError as e:
        r = e
    raw = r.read().decode()
    try: js = json.loads(raw) if raw else None
    except ValueError: js = raw
    return r.status, js, r.headers

def check(name, cond, extra=""):
    global passed, failed
    if cond: passed += 1; print(f"  ok   {name}")
    else: failed += 1; print(f"  FAIL {name} {extra}")

def section(t): print(f"\n== {t}")

section("health + routing")
s, j, _ = call("GET", "/api/health"); check("health 200", s == 200 and j["db"] is True, (s, j))
s, j, _ = call("GET", "/api/nope"); check("unknown route 404 json", s == 404 and "error" in j)
s, j, h = call("DELETE", "/api/store", token="x"); check("405 with Allow header", s == 405 and "GET" in h.get("Allow", ""), (s, h.get("Allow")))
s, _, h = call("GET", "/store/my-shop"); check("pretty link 302", s == 302 and h["Location"].endswith("/?store=my-shop"), (s, h.get("Location")))

section("CORS")
s, _, h = call("OPTIONS", "/api/store", headers={"Origin": "https://shop.example.com"})
check("preflight allowed origin", s == 204 and h.get("Access-Control-Allow-Origin") == "https://shop.example.com", (s, dict(h)))
s, _, h = call("OPTIONS", "/api/store", headers={"Origin": "https://evil.com"})
check("preflight evil origin gets no ACAO", s == 204 and h.get("Access-Control-Allow-Origin") is None)

section("auth guards")
for m, p in [("GET", "/api/auth/me"), ("GET", "/api/store"), ("PUT", "/api/store"), ("GET", "/api/products"), ("POST", "/api/products"),
             ("PATCH", "/api/products/1"), ("GET", "/api/orders"), ("PATCH", "/api/orders/1/status"), ("GET", "/api/stats")]:
    s, _, _ = call(m, p, {}); check(f"{m} {p} -> 401 without token", s == 401, s)
s, _, _ = call("GET", "/api/auth/me", token="abc.def.ghi"); check("garbage token 401", s == 401)
# forged token: alg=none
import base64
b = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()
forged = b({"alg": "none", "typ": "JWT"}) + "." + b({"sub": "1", "exp": 9999999999}) + "."
s, _, _ = call("GET", "/api/auth/me", token=forged); check("alg=none forged token rejected", s == 401)

section("register / login")
s, j, _ = call("POST", "/api/auth/register", {"full_name": "A", "email": "a@x.com", "password": "password1"}); check("short name 422", s == 422, (s, j))
s, j, _ = call("POST", "/api/auth/register", {"full_name": "Ada Vendor", "email": "nope", "password": "password1"}); check("bad email 422", s == 422)
s, j, _ = call("POST", "/api/auth/register", {"full_name": "Ada Vendor", "email": "ada@x.com", "password": "short"}); check("short password 422", s == 422)
s, j, _ = call("POST", "/api/auth/register", {"full_name": "Ada Vendor", "email": "Ada@X.com", "password": "password1"})
check("register 201 + token + no hash", s == 201 and j["access_token"] and "password_hash" not in json.dumps(j) and j["user"]["email"] == "ada@x.com", (s, j))
A = j["access_token"]
s, j, _ = call("POST", "/api/auth/register", {"full_name": "Ada Again", "email": "ADA@x.com", "password": "password1"}); check("duplicate email 409 (case-insens.)", s == 409, (s, j))
s, j, _ = call("POST", "/api/auth/login", {"email": "ada@x.com", "password": "wrongpass"}); check("wrong password 401", s == 401 and j["error"] == "Invalid email or password")
s, j, _ = call("POST", "/api/auth/login", {"email": "ghost@x.com", "password": "wrongpass"}); check("unknown email same 401 message", s == 401 and j["error"] == "Invalid email or password")
s, j, _ = call("POST", "/api/auth/login", {"email": "ada@x.com", "password": "password1"}); check("login ok", s == 200 and j["access_token"])
A = j["access_token"]
s, j, _ = call("GET", "/api/auth/me", token=A); check("me", s == 200 and j["email"] == "ada@x.com" and "password_hash" not in j)
s, j, _ = call("POST", "/api/auth/register", {"full_name": "Bola Vendor", "email": "bola@x.com", "password": "password2"}); B = j["access_token"]

section("order of creation: user -> store -> products")
s, j, _ = call("GET", "/api/store", token=A); check("GET store is null (200) before creation", s == 200 and j is None, (s, j))
s, j, _ = call("POST", "/api/products", {"name": "X", "price": 1, "stock": 1}, token=A); check("product w/o store 400", s == 400 and "store first" in j["error"], (s, j))
s, j, _ = call("GET", "/api/products", token=A); check("products [] w/o store", s == 200 and j == [])
s, j, _ = call("GET", "/api/orders", token=A); check("orders [] w/o store", s == 200 and j == [])
s, j, _ = call("GET", "/api/stats", token=A); check("stats zeros w/o store", s == 200 and j["product_count"] == 0 and j["today_total"] == 0)

section("store")
s, j, _ = call("PUT", "/api/store", {"name": "Ada's Gadgets & Co!", "whatsapp_number": "abc"}, token=A); check("bad whatsapp 422", s == 422, (s, j))
s, j, _ = call("PUT", "/api/store", {"name": "Ada's Gadgets & Co!", "whatsapp_number": "0803 123 4567", "category": "Tech", "location": "Lagos", "description": "Best <b>gadgets</b>"}, token=A)
check("create store 201, slug, phone normalised", s == 201 and j["slug"] == "ada-s-gadgets-co" and j["whatsapp_number"] == "+2348031234567" and j["currency"] == "₦", (s, j))
SLUG, SID = j["slug"], j["id"]
s, j, _ = call("PUT", "/api/store", {"name": "Ada Gadgets Renamed", "whatsapp_number": "+2348031234567"}, token=A)
check("update store keeps slug + id", s == 200 and j["slug"] == SLUG and j["id"] == SID and j["name"] == "Ada Gadgets Renamed", (s, j))
s, j, _ = call("PUT", "/api/store", {"name": "Ada Gadgets Renamed", "whatsapp_number": "+2348031234567"}, token=B)
check("second user same name -> different slug", s == 201 and j["slug"] != SLUG and j["slug"].startswith("ada-gadgets-renamed"), (s, j))
BSLUG = j["slug"]
s, j, _ = call("GET", "/api/store", token=B); check("B sees own store only", j["slug"] == BSLUG)

section("products + ownership")
s, j, _ = call("POST", "/api/products", {"name": "Phone", "price": -5, "stock": 1, "category": "x"}, token=A); check("negative price 422", s == 422)
s, j, _ = call("POST", "/api/products", {"name": "Phone", "price": 10, "stock": 1.5, "category": "x"}, token=A); check("fractional stock 422", s == 422)
s, j, _ = call("POST", "/api/products", {"name": "Phone", "price": 10, "stock": 1, "image_url": "javascript:alert(1)"}, token=A); check("javascript: image_url rejected", s == 422, (s, j))
s, j, _ = call("POST", "/api/products", {"name": "Phone", "price": 15000, "stock": 5, "category": "Tech", "description": "d", "image_url": "https://img.example.com/p.png"}, token=A)
check("create product 201 active", s == 201 and j["is_active"] is True and j["store_id"] == SID and j["price"] == 15000, (s, j)); P1 = j["id"]
s, j, _ = call("POST", "/api/products", {"name": "Case", "price": 2500, "stock": 3, "category": "Tech"}, token=A); P2 = j["id"]
s, j, _ = call("POST", "/api/products", {"name": "Hidden", "price": 100, "stock": 9, "category": "Tech"}, token=A); P3 = j["id"]
s, j, _ = call("POST", "/api/products", {"name": "Zero", "price": 100, "stock": 0, "category": "Tech"}, token=A); P4 = j["id"]
s, j, _ = call("POST", "/api/products", {"name": "Bola item", "price": 500, "stock": 4, "category": "Misc"}, token=B); PB = j["id"]
s, j, _ = call("PATCH", f"/api/products/{P3}", {"is_active": False}, token=A); check("PATCH pause", s == 200 and j["is_active"] is False)
s, j, _ = call("PATCH", f"/api/products/{P1}", {"name": "Phone X", "price": "16000"}, token=A); check("PATCH partial (string price ok)", s == 200 and j["name"] == "Phone X" and j["price"] == 16000 and j["stock"] == 5, (s, j))
s, j, _ = call("PATCH", f"/api/products/{P1}", {"price": 15000}, token=A)
s, j, _ = call("PATCH", f"/api/products/{P1}", {"store_id": 999}, token=A); check("PATCH ignores unknown fields (store_id not writable)", s == 422, (s, j))
s, j, _ = call("PATCH", f"/api/products/{P1}", {"name": "hacked"}, token=B); check("B cannot PATCH A's product (404, no leak)", s == 404, (s, j))
s, j, _ = call("GET", "/api/products", token=B); check("B list only B's products", [p["id"] for p in j] == [PB])
s, j, _ = call("GET", "/api/products", token=A); check("A list incl. inactive", {p["id"] for p in j} == {P1, P2, P3, P4})

section("public storefront")
s, j, _ = call("GET", f"/api/public/store/{SLUG}"); check("public store, no owner_id", s == 200 and "owner_id" not in j and j["name"] == "Ada Gadgets Renamed", (s, j))
s, j, _ = call("GET", f"/api/public/store/{SLUG.upper()}"); check("slug case-insensitive", s == 200)
s, j, _ = call("GET", f"/api/public/store/{SLUG}/products"); check("public products hide inactive", {p["id"] for p in j} == {P1, P2, P4}, j)
s, j, _ = call("GET", "/api/public/store/does-not-exist"); check("unknown store 404", s == 404)

section("checkout (public) — server owns prices, totals, stock")
good = {"store_slug": SLUG, "customer_name": "Chidi", "customer_phone": "08011112222", "delivery_address": "12 Allen Ave, Ikeja", "note": "<img src=x onerror=alert(1)>",
        "items": [{"product_id": P1, "qty": 1, "price": 1}, {"product_id": P2, "qty": 2}, {"product_id": P2, "qty": 1}], "total": 1}
s, j, _ = call("POST", "/api/orders", good)
check("order 201, total computed server-side (15000 + 3*2500 = 22500)", s == 201 and j["total"] == 22500 and j["status"] == "New", (s, j))
check("duplicate lines merged, item prices snapshot", sorted((i["name"], i["qty"], i["price"]) for i in j["items"]) == [("Case", 3, 2500), ("Phone X", 1, 15000)], j["items"])
check("response carries store whatsapp for handoff", j["store"]["whatsapp_number"] == "+2348031234567" and j["customer_phone"] == "+2348011112222")
check("XSS payload stored verbatim (frontend must escape)", j["note"] == "<img src=x onerror=alert(1)>")
O1 = j["id"]
s, j, _ = call("GET", f"/api/public/store/{SLUG}/products"); st = {p["id"]: p["stock"] for p in j}; check("stock decremented", st[P1] == 4 and st[P2] == 0, st)
s, j, _ = call("POST", "/api/orders", {**good, "items": [{"product_id": P2, "qty": 1}]}); check("sold-out -> 409", s == 409 and "out of stock" in j["error"], (s, j))
s, j, _ = call("POST", "/api/orders", {**good, "items": [{"product_id": P1, "qty": 99}]}); check("over-stock -> 409 'Only 4 left'", s == 409 and "Only 4 left" in j["error"], (s, j))
s, j, _ = call("GET", f"/api/public/store/{SLUG}/products"); check("failed orders did not touch stock", {p["id"]: p["stock"] for p in j}[P1] == 4)
s, j, _ = call("POST", "/api/orders", {**good, "items": [{"product_id": P3, "qty": 1}]}); check("inactive product 422", s == 422, (s, j))
s, j, _ = call("POST", "/api/orders", {**good, "items": [{"product_id": PB, "qty": 1}]}); check("other store's product 422 (cross-store blocked)", s == 422, (s, j))
s, j, _ = call("POST", "/api/orders", {**good, "items": [{"product_id": P1, "qty": 1}, {"product_id": P4, "qty": 1}]}); check("mixed cart w/ out-of-stock fails whole order", s == 409, (s, j))
s, j, _ = call("GET", f"/api/public/store/{SLUG}/products"); check("...and rolled back P1 stock (atomic)", {p["id"]: p["stock"] for p in j}[P1] == 4)
s, j, _ = call("POST", "/api/orders", {**good, "items": []}); check("empty cart 422", s == 422)
s, j, _ = call("POST", "/api/orders", {**good, "items": [{"product_id": P1, "qty": 0}]}); check("qty 0 422", s == 422)
s, j, _ = call("POST", "/api/orders", {**good, "customer_phone": "12"}); check("bad phone 422", s == 422)
s, j, _ = call("POST", "/api/orders", {**good, "customer_name": ""}); check("missing name 422", s == 422)
s, j, _ = call("POST", "/api/orders", {**good, "store_slug": "nope"}); check("unknown store 404", s == 404)
s, j, _ = call("POST", "/api/orders", {k: v for k, v in good.items() if k != "store_slug"}); check("no store ref 422", s == 422)
s, j, _ = call("POST", "/api/orders", {**good, "store_slug": None, "store_id": SID, "items": [{"product_id": P1, "qty": 1}]}); check("store_id works too", s == 201, (s, j))
s, j, _ = call("POST", "/api/orders", {**good, "items": [{"product_id": P1, "qty": 1}]}, token=B); check("public checkout ignores a (foreign) token", s == 201, (s, j))

section("vendor orders + ownership")
s, j, _ = call("GET", "/api/orders", token=A); check("A sees 3 orders newest first w/ items", s == 200 and len(j) == 3 and j[0]["id"] > j[-1]["id"] and j[-1]["items"], (s, len(j)))
s, j, _ = call("GET", "/api/orders", token=B); check("B sees NO orders of A", j == [])
s, j, _ = call("PATCH", f"/api/orders/{O1}/status", {"status": "Preparing"}, token=B); check("B cannot update A's order (404)", s == 404)
s, j, _ = call("PATCH", f"/api/orders/{O1}/status", {"status": "Shipped"}, token=A); check("invalid status 422", s == 422)
s, j, _ = call("PATCH", f"/api/orders/{O1}/status", {"status": "Preparing"}, token=A); check("A updates status", s == 200 and j["status"] == "Preparing" and len(j["items"]) == 2, (s, j))
s, j, _ = call("GET", "/api/orders?status=Preparing", token=A); check("status filter", len(j) == 1)

section("stats")
s, j, _ = call("GET", "/api/stats", token=A)
check("A stats", s == 200 and j["today_orders"] == 3 and j["today_total"] == 22500 + 15000 + 15000 and j["week_total"] == j["today_total"] and j["pending_orders"] == 3 and j["product_count"] == 4 and j["active_product_count"] == 3, (s, j))
s, j, _ = call("PATCH", f"/api/orders/{O1}/status", {"status": "Delivered"}, token=A)
s, j, _ = call("GET", "/api/stats", token=A); check("delivered no longer pending", j["pending_orders"] == 2)
s, j, _ = call("GET", "/api/stats", token=B); check("B stats isolated (0 orders: checkout w/ B's token still bought from A's store)", j["today_orders"] == 0 and j["today_total"] == 0 and j["product_count"] == 1, j)

section("input hardening")
s, j, _ = call("POST", "/api/auth/login", base=BASE); check("empty body login 401 not 500", s == 401, (s, j))
req = urllib.request.Request(BASE + "/api/auth/login", data=b"{not json", method="POST", headers={"Content-Type": "application/json"})
try: r = opener.open(req); s = r.status
except urllib.error.HTTPError as e: s = e.code
check("malformed JSON -> 400", s == 400, s)
s, j, _ = call("POST", "/api/auth/login", [1, 2, 3]); check("JSON array body -> 400", s == 400, (s, j))
s, j, _ = call("POST", "/api/auth/register", {"full_name": "Bad\x00Name", "email": "n@x.com", "password": "password1"}); check("control chars rejected", s == 422)
s, j, _ = call("POST", "/api/auth/login", {"email": "' OR 1=1 --", "password": "x"}); check("SQLi-ish email just 401", s == 401)
s, j, _ = call("GET", "/.env"); check(".env not exposed by php -S router", s == 404 or s == 200 and "JWT_SECRET" not in str(j))

section("rate limiting (separate server with RATE_LIMIT=true)")
codes = [call("POST", "/api/auth/login", {"email": "ada@x.com", "password": "bad"}, base=BASE_RL)[0] for _ in range(12)]
check("login throttled after 10 tries", codes[:10] == [401] * 10 and codes[10] == 429, codes)
s, j, h = call("POST", "/api/auth/login", {"email": "ada@x.com", "password": "bad"}, base=BASE_RL); check("429 has Retry-After", s == 429 and int(h["Retry-After"]) > 0)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
