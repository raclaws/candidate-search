const express = require('express');
const https = require('https');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Security: Auth credentials from env
const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASS = process.env.AUTH_PASS || 'changeme';

// NocoDB config (read from env)
let rawUrl = process.env.NOCODB_URL || 'ats.deadalus.site';
if (rawUrl.startsWith('http://')) {
  console.warn('Warning: NOCODB_URL uses HTTP, forcing HTTPS');
  rawUrl = 'https://' + rawUrl.slice(7);
}
const NOCODB_URL = rawUrl.replace(/^https?:\/\//, '');
const NOCODB_TOKEN = process.env.NOCODB_TOKEN;
const TABLE_ID = process.env.NOCODB_TABLE_ID;

// Security headers
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Allow inline styles and scripts (needed for the SPA)
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'");
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
}

// Simple rate limiting (per IP)
const requestCounts = new Map();
const RATE_LIMIT = 100;
const RATE_WINDOW = 15 * 60 * 1000;

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  
  if (!requestCounts.has(ip)) {
    requestCounts.set(ip, { count: 1, resetTime: now + RATE_WINDOW });
  } else {
    const data = requestCounts.get(ip);
    if (now > data.resetTime) {
      data.count = 1;
      data.resetTime = now + RATE_WINDOW;
    } else {
      data.count++;
      if (data.count > RATE_LIMIT) {
        return res.status(429).json({ error: 'Rate limit exceeded' });
      }
    }
  }
  next();
}

// Clean up stale rate‑limit entries every 5 minutes (only in long‑running processes)
if (!process.env.VERCEL) {
  setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of requestCounts.entries()) {
      if (now > data.resetTime) {
        requestCounts.delete(ip);
      }
    }
  }, 5 * 60 * 1000);
}

// Apply middleware
app.use(securityHeaders);
app.use(rateLimit);
app.use(express.json({ limit: '10kb' }));

// Handle CORS preflight
app.options('*', (req, res) => {
  res.sendStatus(200);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Input validation
function sanitizeInput(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>'"]/g, '').trim();
}

// Auth middleware - HTTP Basic Auth
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  
  if (!auth || !auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Candidate Search"');
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  const credentials = Buffer.from(auth.slice(6), 'base64').toString().split(':');
  if (credentials[0] !== AUTH_USER || credentials[1] !== AUTH_PASS) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Candidate Search"');
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  
  next();
}

// API proxy endpoint - protected
app.get('/api/candidates', requireAuth, (req, res) => {
  if (!NOCODB_TOKEN || !TABLE_ID) {
    return res.status(500).json({ error: 'Server configuration error' });
  }
  
  const searchName = sanitizeInput(req.query.name || '');
  const limitParam = parseInt(req.query.limit, 10);
  const limit = Math.min(isNaN(limitParam) ? 20 : limitParam, 100);
  const offsetParam = parseInt(req.query.offset, 10);
  const offset = isNaN(offsetParam) ? 0 : Math.max(0, offsetParam);
  
  let apiPath = `/api/v2/tables/${TABLE_ID}/records?limit=${limit}&offset=${offset}`;
  if (searchName) {
    apiPath += `&where=(Full-Name,like,${encodeURIComponent('%' + searchName + '%')})`;
  }
  
  const options = {
    hostname: NOCODB_URL,
    path: apiPath,
    method: 'GET',
    headers: {
      'xc-token': NOCODB_TOKEN,
      'Accept': 'application/json',
      'User-Agent': 'CandidateSearch/1.0'
    },
    timeout: 10000
  };
  
  const request = https.request(options, (response) => {
    let data = '';
    response.on('data', chunk => data += chunk);
    response.on('end', () => {
      try {
        JSON.parse(data);
        res.setHeader('Content-Type', 'application/json');
        res.status(response.statusCode).send(data);
      } catch (e) {
        res.status(500).json({ error: 'Invalid response from upstream' });
      }
    });
  });
  
  request.on('error', (error) => {
    console.error('NocoDB request error:', error.message);
    res.status(500).json({ error: 'Failed to fetch data' });
  });
  
  request.on('timeout', () => {
    request.destroy();
    res.status(504).json({ error: 'Request timeout' });
  });
  
  request.end();
});

// Serve index.html for root path
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Explicit static file routes (workaround for Vercel)
app.get('/style.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'style.css'));
});
app.get('/app.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'app.js'));
});

// Serve static files (fallback for other files)
app.use(express.static(__dirname));

// 404 handler
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: 'Not found' });
  } else {
    res.sendFile(path.join(__dirname, 'index.html'));
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server only if not on Vercel
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

// Export for Vercel
module.exports = app;
