/**
 * src/commands/completion.mjs — `kodo completion <bash|zsh|fish>`.
 *
 * Generated from the same COMMANDS table that produces `kodo help`, so a new
 * command becomes completable without anyone remembering to update a second
 * list.
 */

import { parseArgs } from "../args.mjs";
import { EXIT, usageError } from "../exit.mjs";
import { COMMANDS } from "./help.mjs";
import { out, log, style } from "../term.mjs";

const SPEC = { help: { type: "boolean", short: "h" }, color: { type: "boolean", default: true }, verbose: { type: "boolean" }, debug: { type: "boolean" } };

const NAMES = Object.keys(COMMANDS).join(" ");
const UI_ACTIONS = "start stop restart status logs";
const CONFIG_ACTIONS = "get set unset list path";

const bash = () => `# kodo bash completion — add to ~/.bashrc:
#   eval "$(kodo completion bash)"
_kodo_completions() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  case "\${prev}" in
    ui|server) COMPREPLY=( $(compgen -W "${UI_ACTIONS}" -- "\${cur}") ); return ;;
    config)    COMPREPLY=( $(compgen -W "${CONFIG_ACTIONS}" -- "\${cur}") ); return ;;
    help)      COMPREPLY=( $(compgen -W "${NAMES}" -- "\${cur}") ); return ;;
  esac
  if [ "\${COMP_CWORD}" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${NAMES}" -- "\${cur}") )
  fi
}
complete -F _kodo_completions kodo`;

const zsh = () => `# kodo zsh completion — add to ~/.zshrc:
#   eval "$(kodo completion zsh)"
_kodo() {
  local -a commands
  commands=(${Object.entries(COMMANDS).map(([n, c]) => `'${n}:${c.summary.replace(/'/g, "")}'`).join(" ")})
  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi
  case "\${words[2]}" in
    ui|server) _values 'action' ${UI_ACTIONS.split(" ").join(" ")} ;;
    config)    _values 'action' ${CONFIG_ACTIONS.split(" ").join(" ")} ;;
    help)      _values 'command' ${Object.keys(COMMANDS).join(" ")} ;;
  esac
}
compdef _kodo kodo`;

const fish = () => [
  "# kodo fish completion — save to ~/.config/fish/completions/kodo.fish:",
  "#   kodo completion fish > ~/.config/fish/completions/kodo.fish",
  ...Object.entries(COMMANDS).map(([n, c]) =>
    `complete -c kodo -n __fish_use_subcommand -a ${n} -d '${c.summary.replace(/'/g, "")}'`),
  ...UI_ACTIONS.split(" ").map((a) => `complete -c kodo -n '__fish_seen_subcommand_from ui server' -a ${a}`),
  ...CONFIG_ACTIONS.split(" ").map((a) => `complete -c kodo -n '__fish_seen_subcommand_from config' -a ${a}`),
].join("\n");

export async function completionCommand({ argv }) {
  const { positional } = parseArgs(argv, SPEC);
  const shell = positional[0];

  const generators = { bash, zsh, fish };
  if (!shell) {
    log(style.dim("Usage: kodo completion <bash|zsh|fish>"));
    log(style.dim('  bash:  eval "$(kodo completion bash)"   in ~/.bashrc'));
    log(style.dim('  zsh:   eval "$(kodo completion zsh)"    in ~/.zshrc'));
    log(style.dim("  fish:  kodo completion fish > ~/.config/fish/completions/kodo.fish"));
    return EXIT.OK;
  }
  if (!generators[shell]) {
    throw usageError(`Unsupported shell "${shell}".`, "Supported: bash, zsh, fish");
  }
  out(generators[shell]());
  return EXIT.OK;
}
