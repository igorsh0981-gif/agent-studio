const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || 'YOUR_API_KEY_HERE';
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

// ── Sessions storage (JSON file) ────────────────────────────────────────────
async function loadSessions() {
  try {
    const raw = await fsp.readFile(SESSIONS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveSessions(sessions) {
  await fsp.writeFile(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf8');
}

async function saveSession(session) {
  const sessions = await loadSessions();
  const idx = sessions.findIndex(s => s.id === session.id);
  if (idx !== -1) sessions[idx] = session;
  else sessions.unshift(session); // newest first
  // Keep max 50 sessions
  const trimmed = sessions.slice(0, 50);
  await saveSessions(trimmed);
  return session;
}

async function deleteSession(id) {
  const sessions = await loadSessions();
  await saveSessions(sessions.filter(s => s.id !== id));
}

// ── HTTP SERVER ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const origin = req.headers.origin || '';
  // Railway автоматически выдаёт RAILWAY_PUBLIC_DOMAIN
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null;
  const allowed = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    ...(railwayDomain ? [railwayDomain] : []),
  ];
  const defaultOrigin = railwayDomain || 'http://localhost:3000';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : defaultOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');

  // ── GET /api/sessions — список всех сессий ──
  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    loadSessions().then(sessions => {
      // Возвращаем без content артефактов для лёгкости списка
      const list = sessions.map(s => ({
        id: s.id,
        query: s.query,
        timestamp: s.timestamp,
        artifactCount: s.artifacts ? Object.keys(s.artifacts).length : 0,
        artifactNames: s.artifacts ? Object.values(s.artifacts).map(a => a.name) : [],
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(list));
    }).catch(err => {
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // ── GET /api/sessions/:id — полная сессия с артефактами ──
  if (url.pathname.startsWith('/api/sessions/') && req.method === 'GET') {
    const id = url.pathname.replace('/api/sessions/', '');
    loadSessions().then(sessions => {
      const session = sessions.find(s => s.id === id);
      if (!session) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(session));
    }).catch(err => {
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // ── POST /api/sessions — сохранить/обновить сессию ──
  if (url.pathname === '/api/sessions' && req.method === 'POST') {
    let body = '';
    let bodySize = 0;
    const BODY_LIMIT = 2 * 1024 * 1024; // 2MB max per session
    req.on('data', chunk => {
      bodySize += chunk.length;
      if (bodySize > BODY_LIMIT) { req.destroy(); res.writeHead(413); res.end(JSON.stringify({error:'Payload too large'})); return; }
      body += chunk;
    });
    req.on('end', () => {
      try {
        const session = JSON.parse(body);
        // Валидация структуры session
        if (!session || typeof session.id !== 'string' || !session.id.trim()) {
          res.writeHead(400); res.end(JSON.stringify({error:'Invalid session: id must be non-empty string'})); return;
        }
        if (!session.timestamp || !session.query) {
          res.writeHead(400); res.end(JSON.stringify({error:'Invalid session: missing timestamp or query'})); return;
        }
        if (session.artifacts && typeof session.artifacts !== 'object') {
          res.writeHead(400); res.end(JSON.stringify({error:'Invalid session: artifacts must be object'})); return;
        }
        saveSession(session).then(saved => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, id: saved.id }));
        });
      } catch (err) {
        res.writeHead(400); res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── DELETE /api/sessions/:id — удалить сессию ──
  if (url.pathname.startsWith('/api/sessions/') && req.method === 'DELETE') {
    const id = url.pathname.replace('/api/sessions/', '');
    deleteSession(id).then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }).catch(err => {
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // ── POST /api/messages — прокси к Anthropic ──
  if (url.pathname === '/api/messages' && req.method === 'POST') {
    let body = '';
    let msgBodySize = 0;
    const MSG_LIMIT = 4 * 1024 * 1024; // 4MB для длинных артефактов в контексте
    req.on('data', chunk => {
      msgBodySize += chunk.length;
      if (msgBodySize > MSG_LIMIT) { req.destroy(); res.writeHead(413); res.end(JSON.stringify({error:'Payload too large'})); return; }
      body += chunk;
    });
    req.on('end', () => {
      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        },
      };
      const corsOrigin = allowed.includes(origin) ? origin : defaultOrigin;
      const proxyReq = https.request(options, proxyRes => {
        res.writeHead(proxyRes.statusCode, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': corsOrigin,
        });
        proxyRes.pipe(res);
      });
      proxyReq.on('error', err => {
        console.error('API error:', err.message);
        res.writeHead(502);
        res.end(JSON.stringify({ error: { message: err.message } }));
      });
      proxyReq.write(body);
      proxyReq.end();
    });
    return;
  }

  // ── Static files ──
  let filePath = url.pathname === '/' ? '/agent_studio_v4.html' : url.pathname;
  filePath = path.join(__dirname, filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found: ' + url.pathname); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  Agent Studio v4 запущен!');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    console.log('  https://' + process.env.RAILWAY_PUBLIC_DOMAIN);
  } else {
    console.log('  http://localhost:' + PORT);
  }
  console.log('');
  if (API_KEY === 'YOUR_API_KEY_HERE') {
    console.log('  [!] API ключ не задан');
    console.log('  Windows: set ANTHROPIC_API_KEY=sk-ant-... && node server.js');
    console.log('  Mac/Linux: ANTHROPIC_API_KEY=sk-ant-... node server.js');
  } else {
    console.log('  [ok] API ключ загружен');
  }
  console.log('');
});
