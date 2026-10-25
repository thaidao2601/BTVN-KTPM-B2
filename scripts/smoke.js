import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdir, writeFile } from 'node:fs/promises';

const gateway = process.env.GATEWAY_URL || 'http://localhost:8080';
async function request(path, options = {}) {
  return fetch(`${gateway}${path}`, { ...options, signal: AbortSignal.timeout(5000) });
}

assert.equal((await request('/users')).status, 401);
const login = await request('/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'alice', password: '123456' }),
});
assert.equal(login.status, 200);
const { token } = await login.json();
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const dashboard = await request('/dashboard', { headers });
assert.equal(dashboard.status, 200);
const data = await dashboard.json();
assert.equal(data.user.id, 1);
assert.equal(data.totalOrders, 2);
assert.equal(data.totalAmount, 750000);

const presign = await request('/users/1/avatar-upload-url', {
  method: 'POST', headers, body: JSON.stringify({ contentType: 'image/png' }),
});
assert.equal(presign.status, 200);
const upload = await presign.json();
assert.equal(new URL(upload.uploadUrl).searchParams.get('X-Amz-Expires'), '300');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const put = await fetch(upload.uploadUrl, {
  method: 'PUT', headers: { 'content-type': 'image/png' }, body: png,
  signal: AbortSignal.timeout(5000),
});
assert.equal(put.status, 200, await put.text());
// Bucket private: không thể đọc ảnh bằng URL bỏ chữ ký.
const unsigned = new URL(upload.uploadUrl);
unsigned.search = '';
const anonymous = await fetch(unsigned, { signal: AbortSignal.timeout(5000) });
assert.equal(anonymous.status, 403);
await anonymous.body?.cancel();
await sleep(1100);
const codes = await Promise.all(Array.from({ length: 11 }, async () => {
  const response = await request('/orders', { headers });
  await response.arrayBuffer();
  return response.status;
}));
assert.equal(codes.filter(code => code === 200).length, 10);
assert.equal(codes.filter(code => code === 429).length, 1);
const report = {
  checkedAt: new Date().toISOString(),
  gateway,
  checks: {
    missingJwt: 401,
    dashboard: { userId: data.user.id, totalOrders: data.totalOrders, totalAmount: data.totalAmount },
    presignedUrlExpiresInSeconds: Number(new URL(upload.uploadUrl).searchParams.get('X-Amz-Expires')),
    uploadStatus: put.status,
    anonymousReadStatus: anonymous.status,
    rateLimit: { successful: codes.filter(code => code === 200).length,
      rejected: codes.filter(code => code === 429).length },
  },
  uploadedObject: `${upload.bucket}/${upload.objectName}`,
};
await mkdir('results', { recursive: true });
await writeFile('results/smoke.json', JSON.stringify(report, null, 2) + '\n');
console.log('PASS: JWT, dashboard, upload ảnh trực tiếp MinIO (TTL 300s), bucket private, rate limit 10/s.');
console.log(`Ảnh mẫu đã upload: ${upload.bucket}/${upload.objectName}`);
if (process.argv.includes('--wait-expiry')) {
  // Giữ nguyên URL ban đầu, đợi thực sự hết 5 phút rồi PUT lại.
  const deadline = Date.parse(upload.expiresAt) + 1500;
  while (Date.now() < deadline) {
    console.log(`Đợi URL hết hạn: còn ${Math.ceil((deadline - Date.now()) / 1000)} giây...`);
    await sleep(Math.min(30000, deadline - Date.now()));
  }
  const expired = await fetch(upload.uploadUrl, {
    method: 'PUT', headers: { 'content-type': 'image/png' }, body: png,
    signal: AbortSignal.timeout(5000),
  });
  const errorBody = await expired.text();
  assert.equal(expired.status, 403, errorBody);
  assert.match(errorBody, /Request has expired/i);
  report.checks.expiredUpload = { status: expired.status, message: 'Request has expired',
    checkedAt: new Date().toISOString() };
  await writeFile('results/smoke.json', JSON.stringify(report, null, 2) + '\n');
  console.log('PASS: PUT lại cùng URL sau 5 phút nhận 403, Request has expired.');
}
console.log('Kết quả: results/smoke.json');
