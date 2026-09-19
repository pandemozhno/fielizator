'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const http = require('node:http');
const express = require('express');
const upload = require('..');

const TMP = path.join(__dirname, 'tmp');

test.before(async () => { await fsp.mkdir(TMP, { recursive: true }); });
test.after(async () => { await fsp.rm(TMP, { recursive: true, force: true }); });

function listen(app) {
  return new Promise((res) => {
    const s = app.listen(0, () => res(s));
  });
}

async function postJson(port, pathname, body, headers = {}) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      port, path: pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers,
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('JSON data URL', async () => {
  const app = express();
  app.post('/u', upload.to(TMP).single('file'), (req, res) => {
    res.json({ file: req.file });
  });
  const srv = await listen(app);
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const dataUrl = 'data:image/png;base64,' + png.toString('base64');
    const res = await postJson(srv.address().port, '/u', { file: dataUrl });
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.file.mimetype, 'image/png');
    assert.ok(fs.existsSync(json.file.path));
  } finally {
    srv.close();
  }
});

test('JSON byte array', async () => {
  const app = express();
  app.post('/u', upload.to(TMP).single('file'), (req, res) => {
    res.json({ file: req.file });
  });
  const srv = await listen(app);
  try {
    const res = await postJson(srv.address().port, '/u', { file: [1, 2, 3, 4, 5] });
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.file.size, 5);
  } finally {
    srv.close();
  }
});