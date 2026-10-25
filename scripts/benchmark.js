import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const gateway = process.env.GATEWAY_URL || 'http://localhost:8080';
const samples = Number(process.env.SAMPLES || 30);
if (!Number.isInteger(samples) || samples < 1 || samples > 10000) {
  throw new Error('SAMPLES phải là số nguyên từ 1 đến 10000');
}

async function timedRequest(url, token) {
  const start = performance.now();
  const response = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status} ${body}`);
  return { ms: performance.now() - start, body: JSON.parse(body) };
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    meanMs: Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(3)),
    p50Ms: Number(sorted[Math.ceil(sorted.length * 0.5) - 1].toFixed(3)),
    p95Ms: Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(3)),
  };
}

const login = await fetch(`${gateway}/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'alice', password: '123456' }),
  signal: AbortSignal.timeout(5000),
});
if (!login.ok) throw new Error(`Đăng nhập thất bại: HTTP ${login.status}`);
const { token } = await login.json();
await sleep(1100);
const results = { measuredAt: new Date().toISOString(), samples, unit: 'ms',
  environment: { node: process.version, platform: process.platform,
    gateway, userService: process.env.USER_SERVICE_URL || 'http://localhost:3001',
    orderService: process.env.ORDER_SERVICE_URL || 'http://localhost:3002' },
  services: {} };

for (const [name, directUrl, gatewayPath] of [
  ['user', `${process.env.USER_SERVICE_URL || 'http://localhost:3001'}/users/1`, '/users/1'],
  ['order', `${process.env.ORDER_SERVICE_URL || 'http://localhost:3002'}/orders?userId=1`, '/orders'],
]) {
  const direct = [], throughGateway = [];
  // 5 lượt làm nóng; đảo thứ tự gọi để giảm ảnh hưởng thứ tự đo.
  for (let i = -5; i < samples; i++) {
    let directResult, gatewayResult;
    if (i % 2 === 0) {
      gatewayResult = await timedRequest(`${gateway}${gatewayPath}`, token);
      directResult = await timedRequest(directUrl);
    } else {
      directResult = await timedRequest(directUrl);
      gatewayResult = await timedRequest(`${gateway}${gatewayPath}`, token);
    }
    if (JSON.stringify(directResult.body) !== JSON.stringify(gatewayResult.body)) {
      throw new Error('Hai đường gọi trả dữ liệu khác nhau, không thể so sánh');
    }
    if (i >= 0) { direct.push(directResult.ms); throughGateway.push(gatewayResult.ms); }
    // Tối đa khoảng 7.7 request/giây tới gateway, không tắt rate limit khi đo.
    await sleep(130);
  }
  const directStats = stats(direct), gatewayStats = stats(throughGateway);
  results.services[name] = { direct: directStats, gateway: gatewayStats,
    overheadMeanMs: Number((gatewayStats.meanMs - directStats.meanMs).toFixed(3)),
    raw: { direct, gateway: throughGateway } };
}
await mkdir('results', { recursive: true });
await writeFile('results/benchmark.json', JSON.stringify(results, null, 2) + '\n');
console.table(Object.fromEntries(Object.entries(results.services).map(([name, result]) => [name, {
  'Gọi thẳng (ms)': result.direct.meanMs,
  'Qua gateway (ms)': result.gateway.meanMs,
  'Chênh lệch (ms)': result.overheadMeanMs,
  'Gateway p95 (ms)': result.gateway.p95Ms,
}])));
console.log(`Đã đo ${samples} mẫu/service. Chi tiết: results/benchmark.json`);
