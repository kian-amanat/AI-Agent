export type Command = {
  id: string;
  title: string;
  run: () => void;
};

const registry: Command[] = [];

export function registerCommand(command: Command): void {
  registry.push(command);
}

export function listCommands(): Command[] {
  return registry;
}

// TODO: register the real commands here — the palette has nothing to show yet.
