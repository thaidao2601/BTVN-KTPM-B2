import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import * as Minio from 'minio';
import { setTimeout as sleep } from 'node:timers/promises';
import { createGateway } from '../gateway.js';
import { createUserService } from '../user-service.js';
import { createOrderService } from '../order-service.js';

const secret = 'test-secret';
const signer = new Minio.Client({ endPoint: 'localhost', port: 9000, useSSL: false,
  accessKey: 'minioadmin', secretKey: 'minioadmin123', region: 'us-east-1' });

async function serve(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function setup(t, overrides = {}) {
  const userUrl = await serve(t, createUserService(signer));
  const orderUrl = await serve(t, createOrderService());
  const gateway = await serve(t, createGateway({ userUrl, orderUrl, secret, ...overrides }));
  const token = jwt.sign({}, secret, { subject: '1', issuer: 'demo-gateway',
    audience: 'demo-api', expiresIn: '1h' });
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  return { gateway, userUrl, orderUrl, headers };
}

test('Đăng nhập đúng/sai và JWT bị thiếu, sai chữ ký, hết hạn', async t => {
  const { gateway } = await setup(t);
  const post = body => fetch(`${gateway}/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ username: 'alice', password: 'wrong' })).status, 401);
  const login = await post({ username: 'alice', password: '123456' });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  assert.equal(jwt.verify(token, secret).sub, '1');
  assert.equal((await fetch(`${gateway}/users`)).status, 401);
  for (const invalid of [
    jwt.sign({}, 'wrong-secret', { subject: '1' }),
    jwt.sign({}, secret, { subject: '1', issuer: 'demo-gateway', audience: 'demo-api', expiresIn: -1 }),
    'not.a.jwt',
  ]) {
    assert.equal((await fetch(`${gateway}/users`, { headers: { authorization: `Bearer ${invalid}` } })).status, 401);
  }
});

test('Routing /users và /orders, không giả mạo được userId', async t => {
  const { gateway, headers, userUrl, orderUrl } = await setup(t);
  const user = await fetch(`${gateway}/users/1`, { headers });
  assert.deepEqual(await user.json(), await (await fetch(`${userUrl}/users/1`)).json());
  const orders = await (await fetch(`${gateway}/orders?userId=2`, {
    headers: { ...headers, 'x-user-id': '2' },
  })).json();
  assert.equal(orders.length, 2);
  assert.ok(orders.every(order => order.userId === 1));
  assert.deepEqual(orders, await (await fetch(`${orderUrl}/orders?userId=1`)).json());
  assert.equal((await fetch(`${gateway}/users/2`, { headers })).status, 403);
});

test('Dashboard gộp đúng user và đơn hàng từ JWT, bỏ qua query userId', async t => {
  const { gateway, headers } = await setup(t);
  const response = await fetch(`${gateway}/dashboard?userId=2`, { headers });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.user.id, 1);
  assert.equal(data.totalOrders, 2);
  assert.equal(data.totalAmount, 750000);
  assert.ok(data.orders.every(order => order.userId === 1));
  const bobToken = jwt.sign({}, secret, { subject: '2', issuer: 'demo-gateway',
    audience: 'demo-api', expiresIn: '1h' });
  const bob = await (await fetch(`${gateway}/dashboard`, {
    headers: { authorization: `Bearer ${bobToken}` },
  })).json();
  assert.equal(bob.user.id, 2);
  assert.equal(bob.totalOrders, 1);
  assert.equal(bob.totalAmount, 3000000);
});

test('Valet Key dùng SDK thật, TTL 300s, hostname public và object riêng cho user', async t => {
  const { gateway, headers } = await setup(t);
  const response = await fetch(`${gateway}/users/1/avatar-upload-url`, {
    method: 'POST', headers, body: JSON.stringify({ contentType: 'image/png' }),
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  const url = new URL(data.uploadUrl);
  assert.equal(data.expiresIn, 300);
  assert.equal(data.method, 'PUT');
  assert.equal(url.host, 'localhost:9000');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
  assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.match(url.searchParams.get('X-Amz-Signature'), /^[a-f0-9]{64}$/);
  assert.match(url.pathname, /^\/avatars\/1\/.+\.png$/);
  assert.equal((await fetch(`${gateway}/users/1/avatar-upload-url`, {
    method: 'POST', headers, body: JSON.stringify({ contentType: 'text/plain' }),
  })).status, 400);
});

test('Rate limit: 10 request thành công, request thứ 11 bị 429, phục hồi sau 1s', async t => {
  const { gateway, headers } = await setup(t);
  const responses = await Promise.all(Array.from({ length: 11 }, () => fetch(`${gateway}/users/1`, { headers })));
  assert.equal(responses.filter(response => response.status === 200).length, 10);
  assert.equal(responses.filter(response => response.status === 429).length, 1);
  assert.equal(responses.find(response => response.status === 429).headers.get('retry-after'), '1');
  await sleep(1050);
  assert.equal((await fetch(`${gateway}/users/1`, { headers })).status, 200);
});

test('Upstream ngừng chạy trả 502 cho routing và dashboard', async t => {
  const { gateway, headers } = await setup(t, { userUrl: 'http://127.0.0.1:1' });
  assert.equal((await fetch(`${gateway}/users/1`, { headers })).status, 502);
  assert.equal((await fetch(`${gateway}/dashboard`, { headers })).status, 502);
});
