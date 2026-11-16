// Browser E2E (Playwright). Start a backend on a throwaway SQLite DB first:
//   php -r '$p=new PDO("sqlite:/tmp/whom-ui.db");$p->exec(file_get_contents("tests/sqlite_schema.sql"));'
//   DB_DSN=sqlite:/tmp/whom-ui.db AUTO_MIGRATE=false APP_ENV=local JWT_SECRET=ui-test-secret-ui-test-secret-1234 \
//     RATE_LIMIT=false php -S 127.0.0.1:8111 server.php &
//   node tests/ui_test.js          (needs: npm i playwright). Delete the DB between runs.
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:8111';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ok   ' : '  FAIL ') + n + (c ? '' : ' ' + x)); };
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = []; let dialogs = 0;
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|ERR_|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', d => { dialogs++; d.dismiss(); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());

  console.log('\n== first screen + auth tabs (previously broken)');
  await page.goto(BASE + '/');
  ok('first screen is Account', await page.isVisible('#view-auth.active'));
  await page.click('#tabLogin');
  ok('Log in tab works', (await page.textContent('#authSubmit')) === 'Log in' && !(await page.isVisible('#authFullName')));
  await page.click('#tabSignup');
  ok('Sign up tab works', (await page.textContent('#authSubmit')) === 'Create account' && await page.isVisible('#authFullName'));
  ok('API pill live', /Live/.test(await page.textContent('#apiStatusText')));
  await page.click('.nav-btn[data-view=dashboard]');
  ok('dashboard gated when logged out', await page.isVisible('#view-auth.active'));

  console.log('\n== signup -> store -> product');
  await page.fill('#authFullName', 'Ada Vendor'); await page.fill('input[name=email]', 'ada@x.com'); await page.fill('#authPassword', 'password1');
  await page.click('#authSubmit');
  await page.waitForSelector('#view-dashboard.active');
  ok('redirected to dashboard', true);
  ok('"Create your store" shown', await page.isVisible('#noStoreCard'));
  await page.click('#addProductBtn');
  ok('Add Product blocked w/o store', !(await page.isVisible('#productModal')));
  await page.fill('#storeForm [name=name]', 'Ada <i>Gadgets</i>'); await page.fill('#storeForm [name=whatsapp_number]', '0803 123 4567');
  await page.fill('#storeForm [name=category]', 'Tech'); await page.fill('#storeForm [name=location]', 'Lagos');
  await page.click('#storeSubmit');
  await page.waitForFunction(() => document.querySelector('#storeLink').textContent.includes('?store='));
  const link = (await page.textContent('#storeLink')).trim();
  const SLUG=link.split('?store=')[1]; ok('store link generated from slug (html chars stripped)', SLUG==='ada-i-gadgets-i', link);
  ok('store form shows normalised phone after save', (await page.inputValue('#storeForm [name=whatsapp_number]')) === '+2348031234567');
  await page.click('#addProductBtn');
  await page.fill('#productForm [name=name]', '<img src=x onerror=alert(1)>Phone');
  await page.fill('#productForm [name=price]', '15000'); await page.fill('#productForm [name=stock]', '3'); await page.fill('#productForm [name=category]', 'Tech');
  await page.fill('#productForm [name=description]', 'Nice <b>phone</b>');
  await page.click('#productSubmit');
  await page.waitForSelector('#vendorTable tr');
  ok('product in table, name shown as TEXT', (await page.textContent('#vendorTable')).includes('<img src=x onerror=alert(1)>Phone'));
  await page.click('#addProductBtn'); await page.fill('#productForm [name=name]', 'Case'); await page.fill('#productForm [name=price]', '2500'); await page.fill('#productForm [name=stock]', '10'); await page.fill('#productForm [name=category]', 'Tech');
  await page.fill('#productForm [name=image_url]', 'https://127.0.0.1:1/broken.png');
  await page.click('#productSubmit'); await page.waitForFunction(() => document.querySelectorAll('#vendorTable tr').length === 2);
  ok('stats products = 2', (await page.textContent('#statProducts')) === '2');
  await page.click('#vendorTable [data-edit]:first-child'); 
  ok('edit modal opens prefilled', (await page.inputValue('#productForm [name=name]')) === 'Case');
  await page.keyboard.press('Escape');

  console.log('\n== own storefront preview');
  await page.click('.nav-btn[data-view=storefront]');
  ok('preview shows 2 cards', (await page.locator('#productGrid .product').count()) === 2);
  ok('broken image replaced by placeholder', await page.locator('#productGrid .product-ph').count() >= 1);
  ok('no <img> injected from product name', (await page.locator('#productGrid img[src="x"]').count()) === 0);
  ok('no empty src=""', (await page.locator('#productGrid img[src=""]').count()) === 0);
  await page.screenshot({ path: 'desktop-storefront.png', fullPage: true });

  console.log('\n== customer (no login, separate browser context) uses the public link');
  const cctx = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2 });
  const cust = await cctx.newPage(); let popup = null;
  cust.on('dialog', d => { dialogs++; d.dismiss(); }); cust.on('pageerror', e => errors.push('cust:' + e.message));
  await cust.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  let waUrl = null; await cctx.route(/wa\.me/, r => { waUrl = r.request().url(); r.fulfill({ status: 200, body: 'ok' }); });
  await cust.goto(link);
  await cust.waitForSelector('#view-storefront.active'); await cust.waitForFunction(()=>document.querySelector('#storeName').textContent!=='—'); ok('lands on storefront', true);
  ok('store name shown (escaped)', (await cust.textContent('#storeName')) === 'Ada <i>Gadgets</i>');
  ok('not logged in: no logout button', !(await cust.isVisible('#logoutBtn')));
  await cust.click('#productGrid .product:nth-child(2) [data-add]');  // phone (newest first => Case is first)
  await cust.click('#cartItems [data-d="1"]'); await cust.click('#cartItems [data-d="1"]');
  ok('qty capped at stock (3)', (await cust.textContent('#cartCount')) === '3', await cust.textContent('#cartCount'));
  await cust.click('#cartItems [data-d="-1"]');
  ok('cart total shown', /45,?000|30,?000/.test(await cust.textContent('#cartTotal')), await cust.textContent('#cartTotal'));
  await cust.screenshot({ path: 'mobile-cart.png' });
  await cust.fill('#checkoutForm [name=customer_name]', 'Chidi <script>alert(2)</script>');
  await cust.fill('#checkoutForm [name=customer_phone]', '08011112222'); await cust.fill('#checkoutForm [name=delivery_address]', '12 Allen Ave, Ikeja');
  await cust.fill('#checkoutForm [name=note]', '"><img src=x onerror=alert(3)>');
  await cust.click('#checkoutSubmit');
  await cust.waitForSelector('#orderDoneModal:not(.hidden)');
  ok('order-done modal', /Order #1/.test(await cust.textContent('#doneText')), await cust.textContent('#doneText'));
  await cust.screenshot({ path: 'mobile-done.png' });
  const [pp] = await Promise.all([cust.waitForEvent('popup'), cust.click('#doneWhatsapp')]);
  await pp.waitForLoadState().catch(() => {}); const wa = waUrl || '';
  ok('WhatsApp opens vendor number + order text', wa.startsWith('https://wa.me/2348031234567?text=') && decodeURIComponent(wa).includes('New order #1'), wa);
  await pp.close().catch(() => {});
  await cust.click('#doneClose');
  ok('stock refreshed after order (phone 3 -> 1 left)', /1 left/.test(await cust.textContent('#productGrid')), (await cust.textContent('#productGrid')).slice(0, 200));
  await cust.goto(BASE + '/?store=nope-nope'); await cust.waitForSelector('#storeNotFound:not(.hidden)');
  ok('unknown store shows "Store not found"', true);
  await cust.goto(BASE + '/store/' + SLUG); await cust.waitForFunction(()=>document.querySelector('#storeName').textContent.includes('Gadgets'));
  ok('pretty /store/slug link redirects to storefront', cust.url().includes('?store=' + SLUG) && await cust.isVisible('#view-storefront.active'), cust.url());
  await cctx.close();

  console.log('\n== vendor sees the order (XSS escaped), updates status');
  await page.click('.nav-btn[data-view=orders]');
  await page.click('.nav-btn[data-view=dashboard]');   // forces nothing; orders refreshed by action below
  await page.evaluate(() => refreshVendor()); 
  await page.click('.nav-btn[data-view=orders]');
  await page.waitForSelector('#ordersList .order');
  const otext = await page.textContent('#ordersList');
  ok('customer XSS shown as text', otext.includes('<script>alert(2)</script>') && otext.includes('onerror=alert(3)'));
  ok('no injected script/img elements in orders list', (await page.locator('#ordersList script, #ordersList img').count()) === 0);
  await page.selectOption('#ordersList select', 'Preparing'); await page.waitForTimeout(500);
  ok('status Preparing saved', (await page.locator('#ordersList .badge-status').textContent()) === 'Preparing');
  await page.click('#orderFilters [data-status=Delivered]'); ok('filter Delivered -> none', (await page.locator('#ordersList .order').count()) === 0);
  await page.click('#orderFilters [data-status=all]');
  await page.click('.nav-btn[data-view=dashboard]');
  ok('stats reflect order', /45,000|30,000/.test(await page.textContent('#statToday')) && (await page.textContent('#statPending')) === '1', await page.textContent('#statToday'));
  await page.screenshot({ path: 'desktop-dashboard.png', fullPage: true });

  console.log('\n== logout wipes UI; second user is isolated');
  await page.click('#logoutBtn');
  ok('back on Account', await page.isVisible('#view-auth.active'));
  ok('store form cleared', (await page.inputValue('#storeForm [name=name]')) === '');
  await page.click('.nav-btn[data-view=storefront]');
  ok('storefront no longer shows previous store', (await page.textContent('#storeName')) === '—' && await page.isVisible('#loginPrompt'));
  await page.click('.nav-btn[data-view=auth]'); await page.fill('#authFullName', 'Bola'); await page.fill('input[name=email]', 'bola@x.com'); await page.fill('#authPassword', 'password2'); await page.click('#authSubmit');
  await page.waitForSelector('#view-dashboard.active');
  ok('user B: no store, no products, no orders', await page.isVisible('#noStoreCard') && (await page.locator('#vendorTable tr').count()) === 0 && (await page.inputValue('#storeForm [name=name]')) === '');
  await page.click('.nav-btn[data-view=orders]'); ok('user B orders empty', await page.isVisible('#emptyOrders'));
  await page.click('#logoutBtn');
  await page.click('#tabLogin'); await page.fill('input[name=email]', 'ada@x.com'); await page.fill('#authPassword', 'WRONGPASS'); await page.click('#authSubmit');
  await page.waitForFunction(() => document.querySelector('#authError').textContent.length > 0);
  ok('wrong password shows server message', /Invalid email or password/.test(await page.textContent('#authError')), await page.textContent('#authError'));
  await page.fill('#authPassword', 'password1'); await page.click('#authSubmit'); await page.waitForSelector('#view-dashboard.active');
  ok('Ada logs back in: her store + products return', (await page.locator('#vendorTable tr').count()) === 2);
  await page.reload(); await page.waitForFunction(()=>document.querySelectorAll('#vendorTable tr').length===2);
  ok('session persists across reload (token)', await page.isVisible('#view-dashboard.active') && (await page.locator('#vendorTable tr').count()) === 2);

  console.log('\n== misc');
  ok('no alert() dialogs fired (XSS payloads inert)', dialogs === 0, dialogs);
  ok('no JS errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
