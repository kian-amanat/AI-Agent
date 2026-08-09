/**
 * Structural, but about the BOUNDARY rather than about text: which file carries
 * "use client", where the hook lives, and whether the server-only import can be
 * reached from client code. Those are the actual failure modes.
 */
import { check, guard, behaviourCheck, importFromWorkspace } from "../../_lib/checks.mjs";

const CLIENT_RE = /^\s*["']use client["']/m;

export default async function validate({ helpers, run }) {
  const checks = [];
  const page = await helpers.read("app/products/page.tsx");
  checks.push(guard("the page still exists", page !== null, "app/products/page.tsx is gone"));
  if (page === null) return checks;

  const files = await helpers.listFiles();
  const tsx = files.filter((f) => /\.(t|j)sx$/.test(f) && f !== "app/products/page.tsx");
  const bodies = {};
  for (const f of tsx) bodies[f] = (await helpers.read(f)) ?? "";
  const clientFiles = Object.entries(bodies).filter(([, src]) => CLIENT_RE.test(src));

  // 1 — the page must stay a Server Component.
  checks.push(check("the page is still a Server Component",
    !CLIENT_RE.test(page),
    'the page itself was marked "use client" — that makes the whole route client-rendered and drags the server-only db import into the browser bundle'));

  // 2 — hooks and handlers must have moved off the page.
  checks.push(check("no client hooks remain in the page",
    !/\buseState\s*(?:<[^>]*>)?\s*\(|\buseEffect\s*\(|\buseReducer\s*(?:<[^>]*>)?\s*\(/.test(page),
    "the page still calls a client hook, which a Server Component cannot do"));
  checks.push(check("no event handler remains in the page",
    !/\bon[A-Z]\w*\s*=\s*\{/.test(page),
    "the page still attaches an event handler, which a Server Component cannot do"));

  // 3 — the interactive part must exist somewhere, as a client component.
  checks.push(check("an interactive client component was created",
    clientFiles.length > 0,
    `no file declares "use client". Files: ${tsx.join(", ") || "(none besides the page)"}`));
  checks.push(check("the client component holds the cart interaction",
    // `useState<string[]>(` — the generic sits between the name and the paren,
    // and a stricter regex rejected the reference solution itself. Found by
    // `bench quality`, which requires the known-good answer to pass first.
    clientFiles.some(([, src]) => /useState\s*(?:<[^>]*>)?\s*\(/.test(src) && /onClick\s*=\s*\{/.test(src)),
    "no client component contains both the state and the click handler — the interactive half was dropped rather than moved"));

  // 4 — the server-only module must not be reachable from a client component.
  checks.push(check("the server-only module is not imported by client code",
    !clientFiles.some(([, src]) => /from\s+["'][^"']*lib\/db["']/.test(src)),
    "a \"use client\" file imports lib/db — server-only code cannot be bundled for the browser"));

  // 5 — params must be treated as a Promise (Next 15).
  checks.push(check("params is awaited as a Promise",
    /params\s*:\s*Promise</.test(page) || /await\s+params\b/.test(page),
    "params is still typed and read synchronously; in Next 15 it is a Promise and must be awaited"));

  // 6 — the page must still render the data.
  checks.push(check("the page still fetches and renders the products",
    /getProducts\s*\(/.test(page) && /\.map\s*\(/.test(page + Object.values(bodies).join("")),
    "the product list is no longer rendered"));

  checks.push(check("lib/db.ts was left alone",
    !run.workspaceChanges.changed.includes("lib/db.ts"),
    "the data module is not the bug", { critical: false, guard: true }));
  return checks;
}
