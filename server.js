const express = require('express');
const https = require('https');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Security: Auth credentials from env
const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASS = process.env.AUTH_PASS || 'changeme';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// NocoDB config (read from env)
const NOCODB_URL = (process.env.NOCODB_URL || 'ats.deadalus.site').replace(/^https?:\/\//, '');
const NOCODB_TOKEN = process.env.NOCODB_TOKEN;
const TABLE_ID = process.env.NOCODB_TABLE_ID;

// Simple session store (in-memory, clears on restart)
const sessions = new Map();

// Simple rate limiting
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

// Session middleware
function sessionMiddleware(req, res, next) {
  const sessionId = req.headers.cookie?.match(/sessionId=([^;]+)/)?.[1];
  if (sessionId && sessions.has(sessionId)) {
    req.session = sessions.get(sessionId);
  } else {
    req.session = null;
  }
  next();
}

// Auth check middleware
function requireAuth(req, res, next) {
  if (req.session?.authenticated) {
    return next();
  }
  // Check for Basic Auth fallback (for API clients)
  const auth = req.headers.authorization;
  if (auth?.startsWith('Basic ')) {
    const credentials = Buffer.from(auth.slice(6), 'base64').toString().split(':');
    if (credentials[0] === AUTH_USER && credentials[1] === AUTH_PASS) {
      return next();
    }
  }
  res.status(401).json({ error: 'Authentication required' });
}

// Security headers
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self';");
  next();
}

// Apply middleware
app.use(securityHeaders);
app.use(rateLimit);
app.use(sessionMiddleware);
app.use(express.json({ limit: '10kb' }));

// Login endpoint
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === AUTH_USER && password === AUTH_PASS) {
    const sessionId = crypto.randomBytes(32).toString('hex');
    sessions.set(sessionId, { authenticated: true, created: Date.now() });
    res.setHeader('Set-Cookie', `sessionId=${sessionId}; HttpOnly; SameSite=Strict; Max-Age=86400`);
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// Logout endpoint
app.post('/logout', (req, res) => {
  const sessionId = req.headers.cookie?.match(/sessionId=([^;]+)/)?.[1];
  if (sessionId) sessions.delete(sessionId);
  res.setHeader('Set-Cookie', 'sessionId=; HttpOnly; SameSite=Strict; Max-Age=0');
  res.json({ success: true });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Auth status endpoint - no auth required
app.get('/auth/status', (req, res) => {
  res.json({ authenticated: req.session?.authenticated || false });
});

// API routes - protected
app.use('/api', requireAuth);

// Input validation
function sanitizeInput(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>"']/g, '').trim();
}

// API proxy endpoint
app.get('/api/candidates', (req, res) => {
  if (!NOCODB_TOKEN || !TABLE_ID) {
    return res.status(500).json({ error: 'Server configuration error' });
  }
  
  const searchName = sanitizeInput(req.query.name || '');
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  
  let apiPath = `/api/v2/tables/${TABLE_ID}/records?limit=${limit}`;
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

// Static files - publicly accessible (login page is in here)
app.use(express.static('public'));

// Protect API routes only
app.use('/api', requireAuth);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
