// api-gateway: the public API entry point. Forwards /api/* requests to the
// right internal service. (The web page itself lives in the paylab-web repo.)
const express = require('express');

const SERVICE = 'api-gateway';
const PORT = Number(process.env.PORT || 8080);
const WALLET_URL = process.env.WALLET_URL || 'http://wallet-svc:8082';
const PAYMENT_URL = process.env.PAYMENT_URL || 'http://payment-svc:8081';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

function log(level, msg, extra = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, service: SERVICE, msg, ...extra }));
}

// Forward the request to `targetBase`, dropping the "/api" prefix.
// e.g. POST /api/wallets -> POST http://wallet-svc:8082/wallets
// `allowedPrefix` stops tricks like /api/wallets/../transfers from reaching
// internal-only endpoints (the URL parser would turn that into /transfers).
function proxyTo(targetBase, allowedPrefix) {
  return async (req, res) => {
    const target = new URL(req.originalUrl.replace(/^\/api/, ''), targetBase);
    if (target.pathname !== allowedPrefix && !target.pathname.startsWith(allowedPrefix + '/')) {
      return res.status(404).json({ error: 'not found' });
    }
    const url = target.toString();
    try {
      const upstream = await fetch(url, {
        method: req.method,
        headers: { 'Content-Type': 'application/json' },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {}),
      });
      const text = await upstream.text();
      log('info', 'proxied', { method: req.method, path: req.originalUrl, upstream: url, status: upstream.status });
      res.status(upstream.status).type('application/json').send(text);
    } catch (err) {
      log('error', 'upstream unreachable', { upstream: url, error: err.message });
      res.status(502).json({ error: 'upstream unreachable', upstream: url });
    }
  };
}

const app = express();
app.use(express.json());

// CORS: lets a page on another origin (e.g. paylab-web on :3000 locally) call this API.
// On AWS the web page and the API share one origin (the ALB), so CORS isn't needed there.
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204); // preflight
  next();
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: SERVICE }));

// Only wallets and payments are public. wallet-svc's /transfers is internal-only:
// money moves only through payment-svc.
app.use('/api/wallets', proxyTo(WALLET_URL, '/wallets'));
app.use('/api/payments', proxyTo(PAYMENT_URL, '/payments'));

app.use((req, res) => res.status(404).json({ error: 'not found' }));

app.listen(PORT, () => log('info', `listening on port ${PORT}`, { WALLET_URL, PAYMENT_URL, CORS_ORIGIN }));
