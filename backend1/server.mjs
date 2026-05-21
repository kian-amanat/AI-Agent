import Fastify from "fastify";
import plannerAgentRoute from "./routes/plannerAgent.mjs";

const fastify = Fastify({
  logger: true,
});

// ✅ CORS دستی - بدون پکیج
fastify.addHook('onRequest', async (request, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type');
  
  if (request.method === 'OPTIONS') {
    reply.code(200).send();
  }
});

fastify.register(plannerAgentRoute, { prefix: "/api/agent" });

fastify.get("/health", async () => {
  return { status: "ok" };
});

const start = async () => {
  try {
    await fastify.listen({ port: 9000, host: "0.0.0.0" });
    console.log("✅ Server on http://localhost:9000");
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
