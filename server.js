const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// NocoDB config
const NOCODB_URL = 'ats.deadalus.site';
const NOCODB_TOKEN = 'yJnX6prNSAKUGum0cXx9p6uXTpwi4lDlf7ODRDgB';
const TABLE_ID = 'mqf1wqf4abbaqtx';

app.use(express.static('public'));
app.use(express.json());

// API proxy endpoint
app.get('/api/candidates', (req, res) => {
  const searchName = req.query.name || '';
  const limit = req.query.limit || 20;
  
  let path = `/api/v2/tables/${TABLE_ID}/records?limit=${limit}`;
  if (searchName) {
    path += `&where=(Full-Name,like,${encodeURIComponent('%' + searchName + '%')})`;
  }
  
  const options = {
    hostname: NOCODB_URL,
    path: path,
    method: 'GET',
    headers: {
      'xc-token': NOCODB_TOKEN,
      'Accept': 'application/json'
    }
  };
  
  const request = https.request(options, (response) => {
    let data = '';
    response.on('data', chunk => data += chunk);
    response.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.status(response.statusCode).send(data);
    });
  });
  
  request.on('error', (error) => {
    res.status(500).json({ error: error.message });
  });
  
  request.end();
});

app.listen(PORT, () => {
  console.log(`Candidate Search server running at http://localhost:${PORT}`);
});
