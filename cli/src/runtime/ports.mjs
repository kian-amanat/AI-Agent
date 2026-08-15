/**
 * src/runtime/ports.mjs — port selection.
 *
 * `--port 0` means "pick a free one", which is what the E2E test uses so it can
 * run on a machine that already has a Kodo server up. Everything else is an
 * explicit request and is honoured exactly: silently sliding a requested 4173
 * to 4174 because something else holds it produces a URL the user did not ask
 * for and cannot predict, so a taken explicit port is an error, not a nudge.
 */

import net from "net";

/** Is `port` bindable on `host` right now? */
export function isPortFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/** Ask the OS for an unused port. */
export function findFreePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen({ port: 0, host, exclusive: true }, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * @param {number} requested 0 means "any free port"
 * @returns {Promise<{port: number, chosen: "requested"|"auto"}>}
 */
export async function resolvePort(requested, host) {
  if (requested === 0) return { port: await findFreePort(host), chosen: "auto" };
  const free = await isPortFree(requested, host);
  return { port: requested, chosen: "requested", free };
}
