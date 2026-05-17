import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyJwt } from './utils.js';

export async function jwtMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.status(401).send({ error: 'Unauthorized' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = verifyJwt(token);
    if (!payload) {
      reply.status(401).send({ error: 'Invalid token' });
      return;
    }

    request.user = payload;
  } catch (err) {
    reply.status(401).send({ error: 'Invalid token' });
    return;
  }
}
