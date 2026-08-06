export const USERS = {
  u1: { id: "u1", name: "Ada Lovelace", email: "ada@example.com" },
  u2: { id: "u2", name: "Grace Hopper", email: "grace@example.com" },
};

/** Handlers receive (params) and return { status, body }. */
export const routes = [
  {
    method: "GET",
    pattern: /^\/api\/users$/,
    handler: () => ({ status: 200, body: Object.values(USERS) }),
  },
];

export function handle(method, url) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(url);
    if (match) return route.handler(match.slice(1));
  }
  return { status: 404, body: { error: "not found" } };
}
