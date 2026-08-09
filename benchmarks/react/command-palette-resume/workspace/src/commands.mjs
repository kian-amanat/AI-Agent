/**
 * The command registry. Plain ESM so it can be imported and tested with Node
 * alone — no build step, no toolchain to install.
 *
 * @typedef {{ id: string, title: string, run: () => void }} Command
 */

/** @type {Command[]} */
const registry = [];

/** @param {Command} command */
export function registerCommand(command) {
  registry.push(command);
}

/** @returns {Command[]} */
export function listCommands() {
  return registry;
}

// TODO: register the real commands here — the palette has nothing to show yet.
