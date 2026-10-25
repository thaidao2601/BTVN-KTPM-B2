import express from 'express';

export function createApp(service) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.get('/health', (_req, res) => res.json({ service, status: 'ok' }));
  return app;
}

export function finishApp(app) {
  app.use((_req, res) => res.status(404).json({ error: 'Endpoint không tồn tại' }));
  app.use((error, _req, res, _next) => {
    const status = error.status >= 400 && error.status < 600 ? error.status : 500;
    if (status === 500) console.error(error.message);
    res.status(status).json({ error: status === 500 ? 'Lỗi máy chủ' : error.message });
  });
  return app;
}

export async function fetchService(url, options = {}) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(3000) });
  } catch {
    const error = new Error('Không kết nối được service');
    error.status = 502;
    throw error;
  }
}
