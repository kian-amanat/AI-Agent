import test from "node:test";
import assert from "node:assert";
import { registerCommand, listCommands } from "./commands.mjs";

// The registry is the half of this feature that can be verified without a
// browser or a build step. It runs offline, instantly, with Node alone — so
// there is never a reason to install a frontend toolchain to check the work.
test("the palette has at least one real command registered", () => {
  const commands = listCommands();
  assert.ok(commands.length > 0, "no commands are registered, so the palette has nothing to show");
});

test("every registered command has an id, a title and a runnable action", () => {
  for (const c of listCommands()) {
    assert.ok(c.id, `a command is missing an id: ${JSON.stringify(c)}`);
    assert.ok(c.title, `command ${c.id} is missing a title`);
    assert.strictEqual(typeof c.run, "function", `command ${c.id} has no run() function`);
  }
});

test("registerCommand appends to the registry", () => {
  const before = listCommands().length;
  registerCommand({ id: "__probe", title: "Probe", run: () => {} });
  assert.strictEqual(listCommands().length, before + 1);
});
