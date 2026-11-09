// The catalogue loader must return every byte even when Content-Length describes a
// compressed body (the browser decompresses transparently) or is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { fetchWithProgress } from '../src/load.js';

test('fetchWithProgress keeps all data for gzip-encoded and unsized responses', async () => {
  const data = new Uint8Array(3_000_000);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7919) % 251;
  const gz = gzipSync(data);
  const server = createServer((req, res) => {
    if (req.url === '/gzip') { res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': gz.length }); res.end(gz); }
    else { res.writeHead(200, { 'Transfer-Encoding': 'chunked' }); res.end(Buffer.from(data)); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ['/gzip', '/chunked']) {
      let last = 0;
      const buf = await fetchWithProgress(base + path, (p) => { assert.ok(p >= last && p <= 1); last = p; });
      assert.equal(buf.byteLength, data.length, `${path}: ${buf.byteLength} bytes`);
      assert.deepEqual(new Uint8Array(buf).subarray(0, 1000), data.subarray(0, 1000));
      assert.equal(new Uint8Array(buf)[data.length - 1], data[data.length - 1]);
    }
  } finally {
    server.close();
  }
});
