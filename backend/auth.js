
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { getUserByUsername, createSession, getSessionByToken } from './db.js';

const JWT_SECRET = 'your_jwt_secret'; // Replace with a secure secret in production
const JWT_EXPIRATION = '1h';

export async function login(username, password) {
  const user = await getUserByUsername(username);
  if (!user || user.password !== password) {
    throw new Error('Invalid username or password');
  }

  const sessionToken = uuidv4();
  await createSession(user.id, sessionToken);

  const accessToken = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: JWT_EXPIRATION });
  return { accessToken, sessionToken };
}

export async function refresh(sessionToken) {
  const session = await getSessionByToken(sessionToken);
  if (!session) {
    throw new Error('Invalid session token');
  }

  const accessToken = jwt.sign({ userId: session.userId }, JWT_SECRET, { expiresIn: JWT_EXPIRATION });
  return { accessToken };
}
