import jwt from 'jsonwebtoken';
import { pathToFileURL } from 'node:url';
import { createApp, finishApp, fetchService } from './shared.js';

const DEMO_ACCOUNTS = [
  { id: 1, username: 'alice', password: '123456' },
  { id: 2, username: 'bob', password: '123456' },
];

export function createGateway({
  userUrl = process.env.USER_SERVICE_URL || 'http://localhost:3001',
  orderUrl = process.env.ORDER_SERVICE_URL || 'http://localhost:3002',
  secret = process.env.JWT_SECRET || 'demo-secret-change-in-production-123456',
} = {}) {
  const app = createApp('gateway');

  // Sliding window: tối đa 10 request trong bất kỳ 1 giây nào, theo IP.
  // Không tin X-Forwarded-For do client gửi. /health được miễn giới hạn.
  const requests = new Map();
  app.use((req, res, next) => {
    const now = Date.now();
    for (const [ip, times] of requests) {
      if (times.at(-1) <= now - 1000) requests.delete(ip);
    }
    const recent = (requests.get(req.ip) || []).filter(time => time > now - 1000);
    if (recent.length >= 10) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((recent[0] + 1000 - now) / 1000))));
      return res.status(429).json({ error: 'Tối đa 10 request/giây cho mỗi IP' });
    }
    recent.push(now);
    requests.set(req.ip, recent);
    next();
  });

  // Endpoint đăng nhập mẫu; mật khẩu chỉ dùng cho bài thực hành.
  app.post('/auth/login', (req, res) => {
    const account = DEMO_ACCOUNTS.find(item =>
      item.username === req.body?.username && item.password === req.body?.password);
    if (!account) return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' });
    const token = jwt.sign({}, secret, {
      algorithm: 'HS256', subject: String(account.id), expiresIn: '1h',
      issuer: 'demo-gateway', audience: 'demo-api',
    });
    res.json({ token, tokenType: 'Bearer', expiresIn: 3600, userId: account.id });
  });

  // JWT được kiểm tra một lần tại gateway, trước routing và aggregation.
  app.use((req, res, next) => {
    try {
      const match = /^Bearer (\S+)$/.exec(req.get('authorization') || '');
      if (!match) throw new Error('Missing token');
      const payload = jwt.verify(match[1], secret, {
        algorithms: ['HS256'], issuer: 'demo-gateway', audience: 'demo-api',
      });
      if (!/^[12]$/.test(payload.sub)) throw new Error('Invalid subject');
      req.userId = payload.sub;
      next();
    } catch {
      res.status(401).json({ error: 'JWT không hợp lệ hoặc đã hết hạn' });
    }
  });

  app.get('/dashboard', async (req, res) => {
    const headers = { 'x-user-id': req.userId };
    const [userResponse, orderResponse] = await Promise.all([
      fetchService(`${userUrl}/users/${req.userId}`, { headers }),
      fetchService(`${orderUrl}/orders?userId=${req.userId}`, { headers }),
    ]);
    if (!userResponse.ok || !orderResponse.ok) {
      return res.status(502).json({ error: 'Không lấy được dữ liệu dashboard' });
    }
    const [user, orders] = await Promise.all([userResponse.json(), orderResponse.json()]);
    res.json({ user, orders, totalOrders: orders.length,
      totalAmount: orders.reduce((sum, order) => sum + order.total, 0) });
  });

  // Giữ nguyên đường dẫn khi chuyển tiếp, ghi đè danh tính do client gửi.
  app.use(async (req, res, next) => {
    const isUser = req.path === '/users' || req.path.startsWith('/users/');
    const isOrder = req.path === '/orders' || req.path.startsWith('/orders/');
    if (!isUser && !isOrder) return next();
    const target = new URL(req.originalUrl, isUser ? userUrl : orderUrl);
    if (isUser && req.path !== '/users' && req.path.split('/')[2] !== req.userId) {
      return res.status(403).json({ error: 'Chỉ được truy cập thông tin của mình' });
    }
    if (isOrder) target.searchParams.set('userId', req.userId);
    const upstream = await fetchService(target, {
      method: req.method,
      headers: { 'content-type': 'application/json', 'x-user-id': req.userId },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body ?? {}),
    });
    res.status(upstream.status);
    res.set('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.send(Buffer.from(await upstream.arrayBuffer()));
  });
  return finishApp(app);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createGateway().listen(8080, '0.0.0.0', () => console.log('Gateway: http://localhost:8080'));
}
