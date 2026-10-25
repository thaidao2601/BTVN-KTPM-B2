import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import * as Minio from 'minio';
import { createApp, finishApp } from './shared.js';

const users = [
  { id: 1, username: 'alice', name: 'Nguyễn An', email: 'alice@example.com' },
  { id: 2, username: 'bob', name: 'Trần Bình', email: 'bob@example.com' },
];
const BUCKET = 'avatars';
const EXPIRES_IN = 300; // Valet Key hết hạn sau đúng 5 phút.

export function createUserService(signer) {
  const app = createApp('user-service');
  app.get('/users', (req, res) => {
    const id = req.get('x-user-id');
    res.json(id ? users.filter(user => String(user.id) === id) : users);
  });
  app.get('/users/:id', (req, res) => {
    const user = users.find(item => String(item.id) === req.params.id);
    if (!user) return res.status(404).json({ error: 'Không tìm thấy user' });
    res.json(user);
  });
  app.post('/users/:id/avatar-upload-url', async (req, res) => {
    if (!users.some(user => String(user.id) === req.params.id)) {
      return res.status(404).json({ error: 'Không tìm thấy user' });
    }
    const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
    const contentType = req.body?.contentType;
    if (!Object.hasOwn(extensions, contentType || '')) {
      return res.status(400).json({ error: 'contentType phải là image/png, image/jpeg hoặc image/webp' });
    }
    const objectName = `${req.params.id}/${randomUUID()}.${extensions[contentType]}`;
    const uploadUrl = await signer.presignedPutObject(BUCKET, objectName, EXPIRES_IN);
    res.json({ uploadUrl, method: 'PUT', bucket: BUCKET, objectName,
      contentType, expiresIn: EXPIRES_IN, expiresAt: new Date(Date.now() + EXPIRES_IN * 1000).toISOString() });
  });
  return finishApp(app);
}

async function start() {
  const config = {
    port: Number(process.env.MINIO_PORT || 9000), useSSL: false,
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin123',
    region: 'us-east-1',
  };
  const internal = new Minio.Client({ ...config, endPoint: process.env.MINIO_ENDPOINT || 'localhost' });
  // URL phải ký bằng hostname mà client truy cập được, không sửa hostname sau khi ký.
  const signer = new Minio.Client({ ...config, endPoint: process.env.MINIO_PUBLIC_ENDPOINT || 'localhost' });
  for (let attempt = 1; ; attempt++) {
    try {
      if (!await internal.bucketExists(BUCKET)) await internal.makeBucket(BUCKET, 'us-east-1');
      break;
    } catch (error) {
      if (attempt >= 30) throw error;
      console.log(`Đợi MinIO (${attempt}/30)...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  createUserService(signer).listen(3001, '0.0.0.0', () => console.log('User: http://localhost:3001'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch(error => { console.error(error.message); process.exitCode = 1; });
}
