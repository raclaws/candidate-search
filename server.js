const express = require('express');
const https = require('https');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Security: Basic Auth credentials from env
const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASS = process.env.AUTH_PASS || 'changeme';

// NocoDB config (read from env or use defaults for local dev)
const NOCODB_URL = (process.env.NOCODB_URL || 'ats.deadalus.site').replace(/^https?:\/\//, '');
const NOCODB_TOKEN = process.env.NOCODB_TOKEN;
const TABLE_ID = process.env.NOCODB_TABLE_ID;

// Simple rate limiting
const requestCounts = new Map();
const RATE_LIMIT = 100; // requests
const RATE_WINDOW = 15 * 60 * 1000; // 15 minutes

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
        return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
      }
    }
  }
  next();
}

// Basic HTTP Auth middleware
function basicAuth(req, res, next) {
  const auth = req.headers.authorization;
  
  if (!auth) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Candidate Search"');
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  const credentials = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  const username = credentials[0];
  const password = credentials[1];
  
  if (username !== AUTH_USER || password !== AUTH_PASS) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Candidate Search"');
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  
  next();
}

// Security headers middleware
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // CSP allows connections to same origin only (API calls are server-side)
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self';");
  next();
}

// Apply security middleware
app.use(securityHeaders);
app.use(rateLimit);
app.use(basicAuth);

// Static files (protected by auth above)
app.use(express.static('public'));
app.use(express.json({ limit: '10kb' })); // Limit body size

// Input validation
function sanitizeInput(str) {
  if (typeof str !== 'string') return '';
  // Remove any potentially dangerous characters
  return str.replace(/[<>\"']/g, '').trim();
}

// API proxy endpoint
app.get('/api/candidates', (req, res) => {
  // Validate config
  if (!NOCODB_TOKEN || !TABLE_ID) {
    return res.status(500).json({ error: 'Server configuration error' });
  }
  
  const searchName = sanitizeInput(req.query.name || '');
  const limit = Math.min(parseInt(req.query.limit) || 20, 100); // Max 100
  
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
    timeout: 10000 // 10 second timeout
  };
  
  const request = https.request(options, (response) => {
    let data = '';
    response.on('data', chunk => data += chunk);
    response.on('end', () => {
      try {
        // Validate JSON before sending
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

// Health check (no auth needed for monitoring)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

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
  console.log(`Candidate Search server running at http://localhost:${PORT}`);
  console.log(`Auth required: ${AUTH_USER} / [hidden]`);
});
