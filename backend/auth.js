```javascript
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';

const JWT_SECRET = 'your_jwt_secret'; // در محیط واقعی، این باید در متغیرهای محیطی ذخیره شود
const JWT_EXPIRATION = '15m';
const REFRESH_TOKEN_EXPIRATION = '7d';

/**
 * Generates an access token for a user.
 * @param {Object} user - The user object.
 * @returns {string} - The generated access token.
 */
export function generateAccessToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, {
    expiresIn: JWT_EXPIRATION,
  });
}

/**
 * Generates a refresh token for a user.
 * @param {Object} user - The user object.
 * @returns {string} - The generated refresh token.
 */
export function generateRefreshToken(user) {
  return jwt.sign({ id: user.id }, JWT_SECRET, {
    expiresIn: REFRESH_TOKEN_EXPIRATION,
  });
}

/**
 * Verifies a token and returns the decoded payload.
 * @param {string} token - The token to verify.
 * @returns {Object} - The decoded payload.
 * @throws {Error} - If the token is invalid or expired.
 */
export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

/**
 * Hashes a plain text password.
 * @param {string} password - The plain text password.
 * @returns {Promise<string>} - The hashed password.
 */
export async function hashPassword(password) {
  const saltRounds = 10;
  return bcrypt.hash(password, saltRounds);
}

/**
 * Compares a plain text password with a hashed password.
 * @param {string} password - The plain text password.
 * @param {string} hashedPassword - The hashed password.
 * @returns {Promise<boolean>} - True if the passwords match, false otherwise.
 */
export async function comparePasswords(password, hashedPassword) {
  return bcrypt.compare(password, hashedPassword);
}
```