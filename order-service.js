import { pathToFileURL } from 'node:url';
import { createApp, finishApp } from './shared.js';

const orders = [
  { id: 101, userId: 1, product: 'Bàn phím', total: 500000 },
  { id: 102, userId: 1, product: 'Chuột', total: 250000 },
  { id: 103, userId: 2, product: 'Màn hình', total: 3000000 },
];

export function createOrderService() {
  const app = createApp('order-service');
  app.get('/orders', (req, res) => {
    const userId = req.get('x-user-id') || req.query.userId;
    res.json(userId ? orders.filter(order => String(order.userId) === userId) : orders);
  });
  return finishApp(app);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createOrderService().listen(3002, '0.0.0.0', () => console.log('Order: http://localhost:3002'));
}
