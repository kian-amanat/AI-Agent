// src/app.ts
import Fastify from 'fastify';
import { config } from './config.js';
import authRoutes from './routes/auth.js'; // خیلی مهم: .js در import

const app = Fastify({
  logger: true,
});

// ثبت روت‌های auth
app.register(authRoutes, { prefix: '/auth' });

// یک روت ساده برای تست
app.get('/', async () => {
  return { ok: true, message: 'Fastify is running' };
});

const PORT =  8000;
const HOST =  '0.0.0.0';

app
  .listen({ port: PORT, host: HOST })
  .then((address) => {
    console.log(`🚀 Server listening at ${address}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
