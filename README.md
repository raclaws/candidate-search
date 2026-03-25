# Candidate Search Project

A simple web UI for searching candidates in NocoDB by name.

## Quick Start

```bash
cd projects/candidate-search
npm install
npm start
```

Then open http://localhost:3000

## Database Connection

**Provider:** NocoDB (Self-hosted)

Configure via `.env` file (not committed):
```
NOCODB_URL=your_nocodb_url
NOCODB_TOKEN=your_token
NOCODB_TABLE_ID=your_table_id
```

## Features

- 🔍 Search candidates by name (fuzzy match)
- 📊 Shows: contact info, experience, salary, skills
- 🔗 Quick links to LinkedIn, CV, Portfolio, Doss
- 💻 Clean, responsive UI

## API

The server proxies requests to NocoDB:
- `GET /api/candidates?name=John` — search by name
- `GET /api/candidates?limit=50` — list all (up to limit)
