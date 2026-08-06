/**
 * Two independent questions, both answered from disk:
 *   1. is the duplication actually gone (structure), and
 *   2. does every input still produce exactly what it did before (behaviour).
 * A refactor that only satisfies one of those is not a refactor.
 */
import { check, behaviourCheck, importFromWorkspace } from "../../_lib/checks.mjs";

// The pre-existing contract, pinned here so "behaviour unchanged" is a fact
// about outputs rather than a promise in the summary.
const CASES = [
  ["Hello World", "hello-world"],
  ["  Spaced  Out  ", "spaced-out"],
  ["Multiple---Separators!!!", "multiple-separators"],
  ["--leading and trailing--", "leading-and-trailing"],
  ["MiXeD CaSe 123", "mixed-case-123"],
  ["!!!", ""],
];

export default async function validate({ workspace, helpers, run }) {
  const checks = [];
  const posts = await helpers.read("posts.mjs");
  const tags = await helpers.read("tags.mjs");

  const defines = (src) => /function\s+slugify\s*\(|(?:const|let)\s+slugify\s*=/.test(src ?? "");
  checks.push(check("posts.mjs no longer defines slugify", !defines(posts),
    "posts.mjs still carries its own copy"));
  checks.push(check("tags.mjs no longer defines slugify", !defines(tags),
    "tags.mjs still carries its own copy"));

  const importsSlugify = (src) => /import\s*\{[^}]*\bslugify\b[^}]*\}\s*from\s*["']([^"']+)["']/.exec(src ?? "");
  const postsImport = importsSlugify(posts);
  const tagsImport = importsSlugify(tags);
  checks.push(check("posts.mjs imports slugify", !!postsImport, "no slugify import in posts.mjs"));
  checks.push(check("tags.mjs imports slugify", !!tagsImport, "no slugify import in tags.mjs"));

  // Extraction means a THIRD module. Importing from each other is coupling.
  const from = (m) => (m ? m[1].replace(/^\.\//, "").replace(/\.mjs$/, "") : null);
  const postsFrom = from(postsImport);
  const tagsFrom = from(tagsImport);
  checks.push(check(
    "both import from the same, separate shared module",
    !!postsFrom && postsFrom === tagsFrom && !["posts", "tags"].includes(postsFrom),
    `posts.mjs imports from "${postsFrom}", tags.mjs from "${tagsFrom}" — extraction means one new shared module, not one feature module depending on the other`
  ));

  if (postsFrom && postsFrom === tagsFrom) {
    checks.push(check("the shared module exists on disk",
      await helpers.exists(`${postsFrom}.mjs`) || await helpers.exists(postsFrom),
      `${postsFrom} was imported but never created`));
  }

  // Behaviour, exhaustively, through the real public API.
  checks.push(await behaviourCheck("postPath still produces identical output for every case", async () => {
    const mod = await importFromWorkspace(workspace, "index.mjs");
    if (typeof mod.postPath !== "function") return "index.mjs no longer exports postPath";
    for (const [input, expected] of CASES) {
      const got = mod.postPath(input);
      if (got !== `/posts/${expected}`) return `postPath(${JSON.stringify(input)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(`/posts/${expected}`)}`;
    }
  }, { guard: true }));

  checks.push(await behaviourCheck("tagPath still produces identical output for every case", async () => {
    const mod = await importFromWorkspace(workspace, "index.mjs");
    if (typeof mod.tagPath !== "function") return "index.mjs no longer exports tagPath";
    for (const [input, expected] of CASES) {
      const got = mod.tagPath(input);
      if (got !== `/tags/${expected}`) return `tagPath(${JSON.stringify(input)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(`/tags/${expected}`)}`;
    }
  }, { guard: true }));

  checks.push(check("index.mjs was left alone",
    !run.workspaceChanges.changed.includes("index.mjs"),
    "index.mjs did not need to change for this refactor", { critical: false }));

  return checks;
}
