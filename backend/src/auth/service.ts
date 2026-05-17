import { eq } from "drizzle-orm";
import bcrypt from "bcrypt";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { signJwt, verifyJwt } from "./utils.js";

type RegisterInput = {
  email: string;
  password: string;
  name: string;
};

type LoginInput = {
  email: string;
  password: string;
};

type TokenPayload = {
  userId: number;
};

export async function register(input: RegisterInput) {
  const existing = await db.select().from(users).where(eq(users.email, input.email)).get();
  if (existing) {
    throw new Error("Email already registered");
  }
  const hashed = await bcrypt.hash(input.password, 10);
  const user = await db.insert(users).values({
    email: input.email,
    passwordHash: hashed,
    name: input.name,
  }).returning().get();
  const token = signJwt({ userId: user.id });
  return { user: { id: user.id, email: user.email, name: user.name, passwordHash: hashed }, token };
}

export async function login(input: LoginInput) {
  const user = await db.select().from(users).where(eq(users.email, input.email)).get();
  if (!user) {
    throw new Error("Invalid credentials");
  }
  const valid = await bcrypt.compare(input.password, user.passwordHash);
  if (!valid) {
    throw new Error("Invalid credentials");
  }
  const token = signJwt({ userId: user.id });
  return { user: { id: user.id, email: user.email, name: user.name, passwordHash: user.passwordHash }, token };
}

export async function findUserByEmail(email: string) {
  return await db.select().from(users).where(eq(users.email, email)).get();
}

export function verifyToken(token: string): TokenPayload | null {
  return verifyJwt(token);
}

export async function changePassword(userId: number, oldPassword: string, newPassword: string) {
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) {
    throw new Error("User not found");
  }
  const valid = await bcrypt.compare(oldPassword, user.passwordHash);
  if (!valid) {
    throw new Error("Invalid old password");
  }
  const hashed = await bcrypt.hash(newPassword, 10);
  await db.update(users).set({ passwordHash: hashed }).where(eq(users.id, userId)).run();
  return true;
}

export async function resetPassword(email: string, newPassword: string) {
  const user = await db.select().from(users).where(eq(users.email, email)).get();
  if (!user) {
    throw new Error("User not found");
  }
  const hashed = await bcrypt.hash(newPassword, 10);
  await db.update(users).set({ passwordHash: hashed }).where(eq(users.email, email)).run();
  return true;
}