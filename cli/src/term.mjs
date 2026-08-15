/**
 * src/term.mjs — terminal presentation.
 *
 * Two rules hold this file together, and both exist because `kodo run --json`
 * has to be pipeable into `jq`:
 *
 *  1. stdout carries RESULTS ONLY. Progress, spinners, warnings and diagnostics
 *     all go to stderr. In JSON mode stdout is a pure event stream.
 *  2. Colour is opt-out (--no-color), auto-disabled when not a TTY, and honours
 *     NO_COLOR (https://no-color.org) — so redirected output has no escapes in
 *     it even if the caller forgets a flag.
 */

const NO_COLOR = process.env.NO_COLOR !== undefined || process.env.TERM === "dumb";

// Both streams must be terminals. Styled text is written to whichever stream
// fits (help and results to stdout, progress to stderr), and a single flag
// cannot be right for both unless both are interactive — so `kodo help | less`
// and `kodo status > file` come out clean rather than full of escape codes.
let colorEnabled = !NO_COLOR && process.stdout.isTTY === true && process.stderr.isTTY === true;

export function setColor(enabled) {
  // --no-color always wins; --color cannot force escapes into a pipe.
  colorEnabled = enabled && !NO_COLOR && process.stdout.isTTY === true && process.stderr.isTTY === true;
}

const wrap = (open, close) => (text) =>
  colorEnabled ? `\u001b[${open}m${text}\u001b[${close}m` : String(text);

export const style = {
  bold:      wrap(1, 22),
  dim:       wrap(2, 22),
  italic:    wrap(3, 23),
  red:       wrap(31, 39),
  green:     wrap(32, 39),
  yellow:    wrap(33, 39),
  blue:      wrap(34, 39),
  magenta:   wrap(35, 39),
  cyan:      wrap(36, 39),
  gray:      wrap(90, 39),
};

/** Results. The only thing a piping caller is entitled to. */
export const out = (text = "") => process.stdout.write(`${text}\n`);

/** Everything a human wants to see and a pipe does not. */
export const log = (text = "") => process.stderr.write(`${text}\n`);

export const info  = (text) => log(text);
export const warn  = (text) => log(`${style.yellow("warning")} ${text}`);
export const error = (text) => log(`${style.red("error")} ${text}`);
export const ok    = (text) => log(`${style.green("✓")} ${text}`);
export const fail  = (text) => log(`${style.red("✗")} ${text}`);

let debugEnabled = false;
export function setDebug(on) { debugEnabled = on; }
export const debug = (text) => { if (debugEnabled) log(style.gray(`[debug] ${text}`)); };

/** The banner shown by bare `kodo`. Intentionally small — it is not the product. */
export function banner(version) {
  const line = "─".repeat(36);
  return [
    style.cyan(`╭${line}╮`),
    `${style.cyan("│")}${style.bold("              KODO".padEnd(36))}${style.cyan("│")}`,
    `${style.cyan("│")}${style.dim("       AI Coding Agent".padEnd(36))}${style.cyan("│")}`,
    `${style.cyan("╰")}${style.cyan(line)}${style.cyan("╯")}`,
    style.dim(`  v${version}`),
  ].join("\n");
}

/**
 * A spinner that degrades to nothing when stderr is not a TTY — otherwise CI
 * logs fill with thousands of redraw frames.
 */
export function spinner(initialText = "") {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const active = process.stderr.isTTY === true && !NO_COLOR;
  let text = initialText;
  let timer = null;
  let i = 0;

  const clear = () => { if (active) process.stderr.write("\r\u001b[2K"); };

  return {
    start() {
      if (!active || timer) return this;
      timer = setInterval(() => {
        clear();
        process.stderr.write(`${style.cyan(frames[i++ % frames.length])} ${text}`);
      }, 80);
      timer.unref?.();
      return this;
    },
    update(next) {
      text = next;
      if (!active) return this;
      return this;
    },
    stop(finalLine = "") {
      if (timer) { clearInterval(timer); timer = null; }
      clear();
      if (finalLine) log(finalLine);
      return this;
    },
  };
}

/**
 * Move console.log/info/debug onto stderr for the rest of the process.
 *
 * The agent loop narrates itself with console.log (`[AgentLoop] 8/40 → bash…`),
 * which is exactly right for a server writing to its own log, and exactly wrong
 * for a CLI: it lands on stdout, so `kodo run --json | jq` gets a stream of
 * JSON with agent chatter interleaved through it, and `kodo run > answer.md`
 * captures the trace instead of the answer.
 *
 * Redirecting rather than silencing keeps the diagnostics — they are genuinely
 * useful while watching a run — but puts them on the channel that carries
 * everything else humans read.
 */
export function routeConsoleToStderr() {
  const write = (...args) => process.stderr.write(`${args.map(fmt).join(" ")}\n`);
  console.log = write;
  console.info = write;
  console.debug = write;
  // console.warn/error already go to stderr.
}

function fmt(value) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

/** Key/value block used by status and doctor. */
export function kv(pairs, indent = "  ") {
  const width = Math.max(0, ...pairs.map(([k]) => String(k).length));
  return pairs
    .map(([k, v]) => `${indent}${style.dim(`${k}:`.padEnd(width + 1))} ${v}`)
    .join("\n");
}

/** Human-readable duration for uptime reporting. */
export function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
