// config.js — the only file you edit to point the frontend at a backend.
//
//  apiBase: ""  → same origin. Use this for:
//                 • XAMPP          http://localhost/whom/
//                 • Render Docker  https://your-app.onrender.com/
//                 • php -S localhost:8000 server.php
//  apiBase: "https://your-app.onrender.com" → frontend hosted elsewhere
//                 (GitHub Pages, Netlify…). Then also set CORS_ORIGINS on the backend.
window.WHOM_CONFIG = {
  apiBase: "http://localhost/whom/",
  currency: "₦", // fallback only; each store's own currency is used when known
};
