import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema.js';
import { db } from '../db/client.js';
import { hashPassword, comparePassword } from '../auth/utils.js';
import { signJwt } from '../auth/utils.js';
import { jwtMiddleware } from '../auth/jwt-middleware.js';

// Schemas
const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(1),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

export default async function authRoutes(fastify: FastifyInstance) {
  fastify.post('/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = registerSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid input' });
    }
    const { email, password, name } = body.data;

    const existing = await db.select().from(users).where(eq(users.email, email)).get();
    if (existing) {
      return reply.status(409).send({ error: 'Email already registered' });
    }

    const hashed = await hashPassword(password);
    const user = await db
      .insert(users)
      .values({ email, passwordHash: hashed, name })
      .returning().get();

    const token = await signJwt({ userId: user.id });
    return reply.status(201).send({ token });
  });

  fastify.post('/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = loginSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid input' });
    }
    const { email, password } = body.data;

    const user = await db.select().from(users).where(eq(users.email, email)).get();
    if (!user) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const valid = await comparePassword(password, user.passwordHash);
    if (!valid) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const token = await signJwt({ userId: user.id });
    return reply.send({ token });
  });

  fastify.get('/me', { preHandler: jwtMiddleware }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.user?.userId;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    const user = await db.select().from(users).where(eq(users.id, userId)).get();
    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }
    return reply.send({ id: user.id, email: user.email, name: user.name });
  });

  fastify.post('/forgot-password', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = forgotPasswordSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid input' });
    }
    // For demo: always respond success, don't leak user existence
    return reply.send({ ok: true });
  });
}
