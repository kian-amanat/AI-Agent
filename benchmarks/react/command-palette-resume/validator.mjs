/**
 * Resume tasks fail in two directions, and both are checked: not finishing the
 * existing work, and throwing it away to start fresh. The second is why the
 * pre-existing structure (useState, the filter, the registry API) is asserted
 * to still be there.
 */
import { check } from "../../_lib/checks.mjs";

export default async function validate({ helpers, run }) {
  const checks = [];
  const palette = await helpers.read("src/components/CommandPalette.tsx");
  const app = await helpers.read("src/App.tsx");
  const commands = await helpers.read("src/commands.ts");

  checks.push(check("the existing component still exists", palette !== null,
    "src/components/CommandPalette.tsx is gone — the half-built work was deleted rather than resumed", { guard: true }));
  if (palette === null) return checks;

  checks.push(check("resumed the existing implementation rather than restarting",
    /useState/.test(palette) && /listCommands/.test(palette) && /query/.test(palette),
    "the component no longer uses the state, filtering and registry the existing code was built around", { guard: true }));

  checks.push(check("no TODOs left in the component",
    !/TODO/i.test(palette),
    `still contains: ${(palette.match(/\/\/\s*TODO.*/gi) ?? []).join(" | ")}`));

  // TODO 1 — close on Escape.
  checks.push(check("closes on Escape",
    /Escape/.test(palette) && /(onKeyDown|onKeyUp|addEventListener\s*\(\s*["']keydown)/.test(palette) && /onClose\s*\(/.test(palette),
    "no key handler that calls onClose() on Escape"));

  // TODO 2 — run the selected command on Enter.
  // Two legitimate ways to execute the selected command, and this check must
  // accept both — it is asserting a BEHAVIOUR, not an implementation.
  //
  //   a) the component calls it directly:      commands[selected].run()
  //   b) the component hands it to its parent: onCommand(commands[selected].id)
  //
  // (b) was observed in a real run whose feature worked end to end: App.tsx
  // received the id and invoked the matching handler. Requiring a literal
  // `.run()` failed that run at 11/12, which is a false negative — the grep was
  // measuring which design the model happened to pick, not whether Enter does
  // anything. A component with no Enter handling at all still fails, because
  // `Enter` must appear and something must be invoked with the selected item.
  const runsDirectly = /\.run\s*\(\s*\)/.test(palette);
  const delegatesSelected = /\w+\s*\(\s*(?:commands|filtered\w*|results)\s*\[\s*selected\s*\][^)]*\)/.test(palette);
  checks.push(check("runs the selected command on Enter",
    /Enter/.test(palette) && (runsDirectly || delegatesSelected),
    "nothing invokes the selected command on Enter — neither `.run()` nor handing the selected command to a handler"));
  checks.push(check("Enter uses the SELECTED command, not just the first",
    /\[\s*selected\s*\]|commands\s*\[\s*selected/.test(palette),
    "the Enter handler does not index into the list by the selected offset",
    { critical: false }));

  // TODO 3 — register real commands.
  checks.push(check("real commands are registered",
    /registerCommand\s*\(/.test(commands ?? ""),
    "src/commands.ts still registers nothing, so the palette has nothing to show"));
  checks.push(check("the registry API was kept intact",
    /export function registerCommand/.test(commands ?? "") && /export function listCommands/.test(commands ?? ""),
    "the existing registry exports were removed or renamed", { guard: true }));

  // The wiring nobody remembers: it has to actually be rendered.
  checks.push(check("App.tsx imports CommandPalette",
    /import[^;]*\bCommandPalette\b[^;]*from/.test(app ?? ""),
    "src/App.tsx never imports the palette"));
  checks.push(check("App.tsx renders CommandPalette",
    /<CommandPalette\b/.test(app ?? ""),
    "the palette is finished but never rendered — the feature still does not exist for a user"));
  checks.push(check("App.tsx passes it open/onClose",
    /<CommandPalette[^>]*\bopen\b/.test(app ?? "") && /<CommandPalette[^>]*onClose/.test(app ?? ""),
    "the palette is rendered without the props it requires"));

  checks.push(check("the pre-existing counter was left alone",
    /count is \{count\}|count is/.test(app ?? ""),
    "unrelated existing UI was removed while wiring the palette in",
    { critical: false }));

  // Critical, not advisory. The observed failure was a run whose ONLY change
  // was App.tsx: the palette was imported and rendered, so every "is it wired"
  // check passed, while the component named in the prompt still carried both
  // its TODOs. Wiring a half-built component in is not resuming it, and this
  // is the check that says so from the file list rather than from the content.
  checks.push(check("the half-built component itself was actually changed",
    run.workspaceChanges.changed.includes("src/components/CommandPalette.tsx"),
    `CommandPalette.tsx was never modified — changed: ${run.workspaceChanges.changed.join(", ") || "(nothing)"}`));

  checks.push(check("the integration point was changed too",
    run.workspaceChanges.changed.includes("src/App.tsx"),
    `src/App.tsx was never modified — changed: ${run.workspaceChanges.changed.join(", ") || "(nothing)"}`));

  return checks;
}
