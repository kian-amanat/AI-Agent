/**
 * Scored entirely from src/Dialog.tsx on disk.
 *
 * The load-bearing check is the last one: the handler must still be there AFTER
 * the file is re-validated by the very gate that used to reject it. That closes
 * the loop — a regression in utils/syntax.util.mjs cannot make this benchmark
 * green by simply refusing the write, because a refused write leaves the TODO
 * in place and the handler absent.
 */
import { check, guard } from "../../_lib/checks.mjs";
import { validateSyntax } from "../../../backend1/utils/syntax.util.mjs";

export default async function validate({ helpers, run }) {
  const checks = [];
  const src = await helpers.read("src/Dialog.tsx");

  checks.push(guard("src/Dialog.tsx still exists", src !== null, "the component is gone"));
  if (src === null) return checks;

  checks.push(guard(
    "kept the existing component structure",
    /useState/.test(src) && /role="dialog"/.test(src),
    "the existing component was replaced rather than finished"
  ));

  // Comments are stripped first: the fixture's own TODO says the word
  // "Escape", so a bare text search would be satisfied by the untouched file —
  // the check would pass hardest exactly when nothing had been done.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  checks.push(check(
    "handles the Escape key in code, not just in a comment",
    /["']Escape["']/.test(code),
    `no code compares a key against "Escape":\n${src.slice(0, 400)}`
  ));

  checks.push(check(
    "has a key handler wired to the element",
    /onKeyDown\s*=\s*\{/.test(src) || /addEventListener\s*\(\s*["']keydown/.test(src),
    "no onKeyDown prop or keydown listener is attached"
  ));

  checks.push(check(
    "calls onClose() on Escape",
    /onClose\s*\(\s*\)/.test(src),
    "onClose is never invoked"
  ));

  checks.push(check(
    "no TODO left behind",
    !/TODO/i.test(src),
    `still contains: ${(src.match(/\/\/\s*TODO.*/gi) ?? []).join(" | ")}`
  ));

  // The regression probe itself. The idiomatic handler is typed; the point of
  // the fix is that typing it does not make the file unwritable. An agent that
  // reached for `e: any` to get past the gate has worked around the bug rather
  // than benefited from the fix, so that is called out separately.
  const typedHandler = /:\s*React\.(?:Keyboard|Ui|UI)Event|:\s*KeyboardEvent\b/.test(src);
  checks.push(check(
    "the event parameter is typed",
    typedHandler,
    "the handler's event parameter is untyped or `any` — the idiomatic typed form is what this benchmark exists to keep writable",
    { critical: false }
  ));

  // And the file the agent produced must itself survive the pre-write gate:
  // if it would not, the agent could never have written it in the first place.
  const gateErr = validateSyntax(src, helpers.resolve("src/Dialog.tsx"));
  checks.push(check(
    "the finished file passes Kodo's own pre-write validation",
    gateErr === null,
    `the pre-write gate would reject the very file that is on disk: ${gateErr}`
  ));

  checks.push(check(
    "only Dialog.tsx was changed",
    run.workspaceChanges.changed.every((f) => f === "src/Dialog.tsx"),
    `also changed: ${run.workspaceChanges.changed.filter((f) => f !== "src/Dialog.tsx").join(", ")}`,
    { critical: false }
  ));

  return checks;
}
