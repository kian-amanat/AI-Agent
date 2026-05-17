import { test } from 'vitest';
import Fastify from 'fastify';
import authRoutes from './auth.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect } from 'vitest';
import * as authUtils from '../auth/utils.js';

const fastify = Fastify();
fastify.register(authRoutes);

const TEST_USER = {
  email: 'testuser@example.com',
  password: 'testpass123',
};

beforeEach(async () => {
  // Clean up users table before each test
  await db.delete(users);
});

afterEach(async () => {
  // Clean up users table after each test
  await db.delete(users);
});

test('POST /auth/register - success', async () => {
  const response = await fastify.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      email: TEST_USER.email,
      password: TEST_USER.password,
      name: 'Test User',
    },
  });

  expect(response.statusCode).toBe(201);
  const body = JSON.parse(response.body);
  expect(body).toHaveProperty('id');
  expect(body).toHaveProperty('email', TEST_USER.email);

  // Check user exists in DB
  const dbUser = await db.select().from(users).where(eq(users.email, TEST_USER.email));
  expect(dbUser.length).toBe(1);
  expect(dbUser[0].email).toBe(TEST_USER.email);
  // Password should be hashed
  expect(await authUtils.comparePassword(TEST_USER.password, dbUser[0].passwordHash)).toBe(true);
});

test('POST /auth/register - duplicate email', async () => {
  // Register first user
  await fastify.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      email: TEST_USER.email,
      password: TEST_USER.password,
      name: 'Test User',
    },
  });

  // Try registering again
  const response = await fastify.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      email: TEST_USER.email,
      password: TEST_USER.password,
      name: 'Test User',
    },
  });

  expect(response.statusCode).toBe(409);
  const body = JSON.parse(response.body);
  expect(body).toHaveProperty('error');
});

test('POST /auth/login - success', async () => {
  // Register user first
  await fastify.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      email: TEST_USER.email,
      password: TEST_USER.password,
      name: 'Test User',
    },
  });

  const response = await fastify.inject({
    method: 'POST',
    url: '/auth/login',
    payload: {
      email: TEST_USER.email,
      password: TEST_USER.password,
    },
  });

  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.body);
  expect(body).toHaveProperty('token');
  expect(typeof body.token).toBe('string');
});

test('POST /auth/login - wrong password', async () => {
  // Register user first
  await fastify.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      email: TEST_USER.email,
      password: TEST_USER.password,
      name: 'Test User',
    },
  });

  const response = await fastify.inject({
    method: 'POST',
    url: '/auth/login',
    payload: {
      email: TEST_USER.email,
      password: 'wrongpassword',
    },
  });

  expect(response.statusCode).toBe(401);
  const body = JSON.parse(response.body);
  expect(body).toHaveProperty('error');
});

test('POST /auth/login - user not found', async () => {
  const response = await fastify.inject({
    method: 'POST',
    url: '/auth/login',
    payload: {
      email: 'nouser@example.com',
      password: 'nopass',
    },
  });

  expect(response.statusCode).toBe(401);
  const body = JSON.parse(response.body);
  expect(body).toHaveProperty('error');
});
