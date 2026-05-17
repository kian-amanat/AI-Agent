import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      userId: number;
      email?: string;
      // هر چیز دیگری که در middleware واقعاً ست می‌کنی
    };
  }
}
