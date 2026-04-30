import bcrypt from "bcrypt";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../utils/jwt.js";
import { findUserByEmail } from "../models/user.model.js";
import {
  createRefreshTokenRecord,
  findRefreshTokenRecord,
  rotateRefreshTokenRecord,
} from "../models/token.model.js";

export async function login({ email, password }) {
  if (!email || !password) {
    const error = new Error("Email and password are required");
    error.status = 400;
    throw error;
  }

  const user = await findUserByEmail(email);
  if (!user) {
    const error = new Error("Invalid credentials");
    error.status = 401;
    throw error;
  }

  const isMatch = await bcrypt.compare(password, user.password_hash);
  if (!isMatch) {
    const error = new Error("Invalid credentials");
    error.status = 401;
    throw error;
  }

  const accessToken = signAccessToken({ userId: user.id });
  const refreshJwt = signRefreshToken({ userId: user.id });
  await createRefreshTokenRecord({ userId: user.id, token: refreshJwt });

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name || null,
    },
    accessToken,
    refreshToken: refreshJwt,
  };
}

export async function refreshToken({ refreshToken }) {
  if (!refreshToken) {
    const error = new Error("Refresh token is required");
    error.status = 400;
    throw error;
  }

  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    const error = new Error("Invalid refresh token");
    error.status = 401;
    throw error;
  }

  const existing = await findRefreshTokenRecord(refreshToken);
  if (!existing || existing.is_revoked) {
    const error = new Error("Refresh token revoked or not found");
    error.status = 401;
    throw error;
  }

  const newAccessToken = signAccessToken({ userId: payload.userId });
  const newRefreshJwt = signRefreshToken({ userId: payload.userId });

  await rotateRefreshTokenRecord({
    oldToken: refreshToken,
    newToken: newRefreshJwt,
    userId: payload.userId,
  });

  return {
    accessToken: newAccessToken,
    refreshToken: newRefreshJwt,
  };
}
