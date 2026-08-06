/**
 * The interesting check is the last one: the titles must be DERIVED from
 * getPosts(), not transcribed. A page that hardcodes today's three titles
 * satisfies every structural check and is still wrong.
 */
import { check } from "../../_lib/checks.mjs";

export default async function validate({ helpers, run }) {
  const checks = [];

  const pagePath = "app/posts/page.tsx";
  const page = await helpers.read(pagePath);
  checks.push(check(`${pagePath} exists`, page !== null,
    `no App Router page at ${pagePath}. Files: ${(await helpers.listFiles()).join(", ")}`));

  const files = await helpers.listFiles();
  checks.push(check("used the App Router, not the pages directory",
    !files.some((f) => f.startsWith("pages/")),
    `created ${files.filter((f) => f.startsWith("pages/")).join(", ")} — this app uses the App Router`, { guard: true }));

  // Checked before the early return: the two halves of this task are
  // independent, and a run that linked to /posts without building the page is
  // a different (and more interesting) failure than one that did neither.
  const home = await helpers.read("app/page.tsx");
  checks.push(check("the home page links to /posts",
    /href\s*=\s*["']\/posts["']/.test(home ?? ""),
    "app/page.tsx has no link to /posts"));
  checks.push(check("the home page kept its existing content",
    /My Blog/.test(home ?? ""),
    "the existing home page heading was removed", { critical: false, guard: true }));

  if (page === null) return checks;

  checks.push(check("the page default-exports a component",
    /export default (?:async )?function|export default \w+/.test(page),
    "an App Router page must have a default export"));

  checks.push(check("imports getPosts from lib/posts",
    /import[^;]*\bgetPosts\b[^;]*from\s*["'][^"']*lib\/posts["']/.test(page),
    "the page does not import getPosts from lib/posts"));

  checks.push(check("calls getPosts()", /getPosts\s*\(\s*\)/.test(page),
    "getPosts is imported but never called"));

  checks.push(check("renders the titles by mapping over the result",
    /\.map\s*\(/.test(page) && /\.title\b/.test(page),
    "titles are not derived from the data — a page that hardcodes today's titles breaks the moment a post is added"));

  checks.push(check("did not hardcode the fixture's post titles",
    !/Understanding the App Router|Server Components in Practice/.test(page),
    "the post titles were transcribed into the page as literals instead of read from getPosts()"));

  checks.push(check("lib/posts.ts was left alone",
    !run.workspaceChanges.changed.includes("lib/posts.ts"),
    "lib/posts.ts is the data source, not the thing to edit", { critical: false }));

  return checks;
}
