import http from "http";

/**
 * The route table. Every endpoint this service exposes lives here, keyed by
 * "<METHOD> <path>". Handlers return { status, body }.
 */
export const routes = {
  "GET /api/ping": () => ({ status: 200, body: { pong: true } }),
};

export function handle(method, url) {
  const handler = routes[`${method} ${url}`];
  if (!handler) return { status: 404, body: { error: "not found" } };
  return handler();
}

// Only listens when explicitly asked, so the module is safe to import in tests.
if (process.env.START_SERVER) {
  http
    .createServer((req, res) => {
      const { status, body } = handle(req.method, req.url);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    })
    .listen(Number(process.env.PORT) || 3000);
}
