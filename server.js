const express = require('express');
const https = require('https');
const crypto = require('crypto');
const path = require('path');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// Security: Auth credentials from env
const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASS = process.env.AUTH_PASS || 'changeme';
const PROFILE_PASS = process.env.PROFILE_PASS || AUTH_PASS;

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
app.use(cookieParser());
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

  // Build where clauses from all filters
  const conditions = [];

  if (searchName) {
    conditions.push(`(Full-Name,like,%${searchName}%)`);
  }

  const lang = sanitizeInput(req.query.lang || '');
  if (lang) {
    conditions.push(`(Programming Language (professionally used),like,%${lang}%)`);
  }

  const cloud = sanitizeInput(req.query.cloud || '');
  if (cloud) {
    conditions.push(`(Cloud Expertise,like,%${cloud}%)`);
  }

  const expMin = parseInt(req.query.expMin, 10);
  if (!isNaN(expMin)) {
    conditions.push(`(Total Years of Experience,gte,${expMin})`);
  }

  const expMax = parseInt(req.query.expMax, 10);
  if (!isNaN(expMax)) {
    conditions.push(`(Total Years of Experience,lte,${expMax})`);
  }

  const salaryMin = parseInt(req.query.salaryMin, 10);
  if (!isNaN(salaryMin)) {
    conditions.push(`((Full-time) Expected Salary (Nett in IDR),gte,${salaryMin})`);
  }

  const salaryMax = parseInt(req.query.salaryMax, 10);
  if (!isNaN(salaryMax)) {
    conditions.push(`((Full-time) Expected Salary (Nett in IDR),lte,${salaryMax})`);
  }

  const currentSalaryMin = parseInt(req.query.currentSalaryMin, 10);
  if (!isNaN(currentSalaryMin)) {
    conditions.push(`((Full-time) Current Salary (Nett in IDR),gte,${currentSalaryMin})`);
  }

  const currentSalaryMax = parseInt(req.query.currentSalaryMax, 10);
  if (!isNaN(currentSalaryMax)) {
    conditions.push(`((Full-time) Current Salary (Nett in IDR),lte,${currentSalaryMax})`);
  }

  const arrangement = sanitizeInput(req.query.arrangement || '');
  if (arrangement) {
    conditions.push(`(Working arrangement preferences,like,%${arrangement}%)`);
  }

  const notice = sanitizeInput(req.query.notice || '');
  if (notice) {
    conditions.push(`((Full-time) Notice Period,like,%${notice}%)`);
  }

  const position = sanitizeInput(req.query.position || '');
  if (position) {
    conditions.push(`(Current Formal Positions,like,%${position}%)`);
  }

  const tools = sanitizeInput(req.query.tools || '');
  if (tools) {
    conditions.push(`(Other professional related tools used,like,%${tools}%)`);
  }

  let apiPath = `/api/v2/tables/${TABLE_ID}/records?limit=${limit}&offset=${offset}`;
  if (conditions.length > 0) {
    apiPath += `&where=${encodeURIComponent(conditions.join('~and'))}`;
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

// Shareable candidate profile page
app.get('/candidate/:id', (req, res) => {
  if (!NOCODB_TOKEN || !TABLE_ID) {
    return res.status(500).send('Server configuration error');
  }

  const candidateId = parseInt(req.params.id, 10);
  if (isNaN(candidateId)) {
    return res.status(400).send('Invalid candidate ID');
  }

  // Check auth: query param or cookie
  const pass = req.query.pass || req.cookies.profile_pass;
  if (pass !== PROFILE_PASS) {
    return res.send(renderPasswordPage(candidateId));
  }

  // Set cookie for 24h so user doesn't need to re-enter
  res.cookie('profile_pass', PROFILE_PASS, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });

  // Fetch candidate from NocoDB
  const apiPath = `/api/v2/tables/${TABLE_ID}/records/${candidateId}`;
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
      if (response.statusCode === 404) {
        return res.status(404).send(renderErrorPage('Candidate not found'));
      }
      try {
        const candidate = JSON.parse(data);
        res.send(renderProfilePage(candidate, candidateId));
      } catch (e) {
        res.status(500).send(renderErrorPage('Failed to load candidate data'));
      }
    });
  });

  request.on('error', () => {
    res.status(500).send(renderErrorPage('Failed to fetch candidate'));
  });
  request.on('timeout', () => {
    request.destroy();
    res.status(504).send(renderErrorPage('Request timeout'));
  });
  request.end();
});

function renderPasswordPage(id) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Candidate Profile - Access Required</title>
  <style>${profileStyles()}</style>
</head>
<body>
  <div class="password-container">
    <h1>Candidate Profile</h1>
    <p>Enter password to view this profile.</p>
    <form method="GET" action="/candidate/${id}">
      <input type="password" name="pass" placeholder="Password" autofocus>
      <button type="submit">View Profile</button>
    </form>
  </div>
</body>
</html>`;
}

function renderErrorPage(message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error</title>
  <style>${profileStyles()}</style>
</head>
<body>
  <div class="password-container">
    <h1>Error</h1>
    <p>${escapeHtmlServer(message)}</p>
    <a href="/">Back to search</a>
  </div>
</body>
</html>`;
}

function renderProfilePage(c, id) {
  const name = escapeHtmlServer(c['Full-Name'] || 'Unknown');
  const position = escapeHtmlServer(c['Current Formal Positions'] || '');
  const email = c.Email || '';
  const phone = c['Phone Number'] || '';
  const experience = escapeHtmlServer(c['Total Years of Experience'] || '');
  const currentSalary = c['(Full-time) Current Salary (Nett in IDR)'];
  const expectedSalary = c['(Full-time) Expected Salary (Nett in IDR)'];
  const arrangement = escapeHtmlServer(c['Working arrangement preferences'] || '');
  const notice = escapeHtmlServer(c['(Full-time) Notice Period'] || '');
  const cloud = escapeHtmlServer(c['Cloud Expertise'] || '');
  const langs = (c['Programming Language (professionally used)'] || '').split(/,|;/).map(s => s.trim()).filter(s => s);
  const tools = (c['Other professional related tools used'] || '').split(/,|;/).map(s => s.trim()).filter(s => s);
  const linkedin = c['LinkedIn Link'] || '';
  const cv = c['Upload CV'] || '';
  const portfolio = c['Portfolio Link (if any)'] || '';

  const waLink = formatWhatsAppServer(phone);
  const description = [position, langs.slice(0, 3).join(', '), cloud].filter(s => s).join(' | ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name} - Candidate Profile</title>
  <meta property="og:title" content="${name}">
  <meta property="og:description" content="${escapeHtmlServer(description)}">
  <meta property="og:type" content="profile">
  <meta name="description" content="${escapeHtmlServer(description)}">
  <style>${profileStyles()}</style>
</head>
<body>
  <div class="profile">
    <div class="profile-header">
      <h1>${name}</h1>
      ${position ? `<div class="profile-position">${position}</div>` : ''}
      <div class="profile-badges">
        ${arrangement ? `<span class="badge badge-arrangement">${arrangement}</span>` : ''}
        ${notice ? `<span class="badge badge-notice">${notice}</span>` : ''}
        ${cloud ? `<span class="badge badge-cloud">${cloud}</span>` : ''}
      </div>
    </div>

    <div class="profile-section">
      <h2>Contact</h2>
      <div class="profile-contact">
        ${email ? `<a href="mailto:${escapeHtmlServer(email)}">📧 ${escapeHtmlServer(email)}</a>` : ''}
        ${phone ? (waLink ? `<a href="${escapeHtmlServer(waLink)}" target="_blank">📱 ${escapeHtmlServer(phone)}</a>` : `<span>📱 ${escapeHtmlServer(phone)}</span>`) : ''}
      </div>
    </div>

    <div class="profile-section">
      <h2>Experience & Compensation</h2>
      <div class="profile-details">
        ${experience ? `<div>💼 <strong>${experience}</strong> years of experience</div>` : ''}
        ${currentSalary ? `<div>💰 Current: <strong>${formatSalaryServer(currentSalary)}</strong></div>` : ''}
        ${expectedSalary ? `<div>💰 Expected: <strong class="salary-expected">${formatSalaryServer(expectedSalary)}</strong></div>` : ''}
      </div>
    </div>

    ${langs.length ? `<div class="profile-section">
      <h2>Programming Languages</h2>
      <div class="profile-tags">${langs.map(s => `<span class="skill-tag">${escapeHtmlServer(s)}</span>`).join('')}</div>
    </div>` : ''}

    ${tools.length ? `<div class="profile-section">
      <h2>Tools & Frameworks</h2>
      <div class="profile-tags">${tools.map(s => `<span class="skill-tag-tool">${escapeHtmlServer(s)}</span>`).join('')}</div>
    </div>` : ''}

    <div class="profile-section">
      <h2>Links</h2>
      <div class="profile-links">
        ${linkedin ? `<a href="${escapeHtmlServer(linkedin)}" target="_blank">LinkedIn</a>` : ''}
        ${cv ? `<a href="${escapeHtmlServer(cv)}" target="_blank">CV</a>` : ''}
        ${portfolio ? `<a href="${escapeHtmlServer(portfolio)}" target="_blank">Portfolio</a>` : ''}
      </div>
    </div>
  </div>
</body>
</html>`;
}

function profileStyles() {
  return `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8f9fb; padding: 2rem; color: #1a1a2e; line-height: 1.6; }
    .password-container { max-width: 340px; margin: 4rem auto; background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04); text-align: center; }
    .password-container h1 { font-size: 1.2rem; margin-bottom: 0.5rem; }
    .password-container p { color: #666; font-size: 0.85rem; margin-bottom: 1.25rem; }
    .password-container form { display: flex; flex-direction: column; gap: 0.75rem; }
    .password-container input { padding: 0.6rem 0.75rem; border: 1px solid #e0e0e0; border-radius: 8px; font-size: 0.9rem; text-align: center; }
    .password-container input:focus { outline: none; border-color: #4f6ef7; box-shadow: 0 0 0 3px rgba(79,110,247,0.1); }
    .password-container button { padding: 0.6rem; background: #4f6ef7; color: white; border: none; border-radius: 8px; font-size: 0.85rem; cursor: pointer; }
    .password-container button:hover { background: #3d5bd9; }
    .password-container a { color: #4f6ef7; text-decoration: none; font-size: 0.85rem; }
    .profile { max-width: 640px; margin: 0 auto; background: white; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04); overflow: hidden; }
    .profile-header { padding: 2rem 2rem 1.5rem; border-bottom: 1px solid #f0f0f0; }
    .profile-header h1 { font-size: 1.4rem; margin-bottom: 0.2rem; }
    .profile-position { color: #555; font-size: 0.9rem; margin-bottom: 0.75rem; }
    .profile-badges { display: flex; flex-wrap: wrap; gap: 0.4rem; }
    .badge { display: inline-block; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.7rem; font-weight: 600; }
    .badge-arrangement { background: #e8f5e9; color: #2e7d32; }
    .badge-notice { background: #fff3e0; color: #e65100; }
    .badge-cloud { background: #e3f2fd; color: #1565c0; }
    .profile-section { padding: 1.25rem 2rem; border-bottom: 1px solid #f0f0f0; }
    .profile-section:last-child { border-bottom: none; }
    .profile-section h2 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #999; margin-bottom: 0.6rem; }
    .profile-contact { display: flex; flex-wrap: wrap; gap: 1rem; }
    .profile-contact a, .profile-contact span { color: #4f6ef7; text-decoration: none; font-size: 0.85rem; }
    .profile-contact a:hover { text-decoration: underline; }
    .profile-details { display: flex; flex-direction: column; gap: 0.4rem; font-size: 0.85rem; }
    .profile-details .salary-expected { color: #2e7d32; }
    .profile-tags { display: flex; flex-wrap: wrap; gap: 0.35rem; }
    .skill-tag { background: #eef1ff; color: #4f6ef7; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 500; }
    .skill-tag-tool { background: #fef3f0; color: #d84315; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 500; }
    .profile-links { display: flex; flex-wrap: wrap; gap: 1rem; }
    .profile-links a { color: #4f6ef7; text-decoration: none; font-size: 0.85rem; font-weight: 500; }
    .profile-links a:hover { text-decoration: underline; }
    @media (max-width: 600px) { body { padding: 1rem; } .profile-header, .profile-section { padding: 1.25rem; } }
  `;
}

function escapeHtmlServer(text) {
  if (!text) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatSalaryServer(salary) {
  if (!salary) return '';
  const num = parseInt(salary);
  if (isNaN(num)) return escapeHtmlServer(salary);
  return 'IDR ' + num.toLocaleString();
}

function formatWhatsAppServer(phone) {
  if (!phone) return null;
  let cleaned = phone.trim();
  const hasPlus = cleaned.startsWith('+');
  cleaned = cleaned.replace(/\D/g, '');
  if (cleaned.startsWith('62')) return `https://wa.me/${cleaned}`;
  if (cleaned.startsWith('0')) return `https://wa.me/62${cleaned.slice(1)}`;
  if (cleaned.startsWith('8') && cleaned.length >= 9) return `https://wa.me/62${cleaned}`;
  if (hasPlus) return `https://wa.me/${cleaned}`;
  return null;
}

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
