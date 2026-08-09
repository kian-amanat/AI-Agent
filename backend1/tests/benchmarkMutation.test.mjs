/**
 * tests/benchmarkMutation.test.mjs
 * Run with: node tests/benchmarkMutation.test.mjs
 *
 * Guards the guards. Every graded benchmark must (a) pass its own known-good
 * solution and (b) reject every realistic wrong answer. A validator that
 * survives a mutation has a hole: that shape of wrong answer scores as a pass,
 * and every result the benchmark has ever produced is worth less than it looked.
 *
 * This ran once as an experiment and immediately found four real holes,
 * including an optional check in react/command-palette-resume that let an agent
 * run the WRONG command on Enter and still score 12/12. Making it permanent is
 * the only way that stays fixed.
 */

import assert from "assert";
import { loadCorpus } from "../bench/corpus.mjs";
import { gradeAll } from "../bench/mutation/index.mjs";
import { specsFor } from "../bench/mutation/specs.mjs";

const corpus = await loadCorpus();
const specs = specsFor(corpus);

let passed = 0;
let failed = 0;
const report = await gradeAll(specs);

for (const r of report.results) {
  const ok = r.trustworthy;
  console.log(`  ${ok ? "✅" : "❌"} ${r.benchmarkId} — ${r.caught}/${r.total} mutation(s) caught`);
  if (ok) passed++;
  else {
    failed++;
    for (const f of r.findings.filter((x) => !x.caught)) console.error(`       ✗ MISSES ${f.name}: ${f.detail}`);
  }
}

try {
  assert.ok(specs.length >= 10, `only ${specs.length} benchmark(s) have mutation coverage`);
  assert.deepStrictEqual(report.holes, [], "a wrong answer of this shape would score as a PASS");
  console.log(`  ✅ every graded validator detects every mutation (${report.results.reduce((n, r) => n + r.total, 0)} mutations)`);
  passed++;
} catch (err) {
  console.error(`  ❌ ${err.message}`);
  failed++;
}

console.log(`\n${"═".repeat(62)}`);
console.log(`  validator mutation: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(62)}\n`);
process.exit(failed === 0 ? 0 : 1);
