// Checks that the UI's curve math (src/accel.ts) matches the engine's (engine/src/accel.rs).
// Run with: node tests/accel-parity.ts
import { readFileSync } from "node:fs";
import { buildCurve } from "../src/accel.ts";
import type { Accel, Steady } from "../src/engine.ts";

interface Row {
  accel: Accel;
  steady?: Steady;
  speeds: number[];
  values: number[];
}

const rows: Row[] = JSON.parse(readFileSync(new URL("./accel-golden.json", import.meta.url), "utf8"));
let bad = 0;
for (const [i, row] of rows.entries()) {
  const curve = buildCurve(row.accel, row.steady);
  row.speeds.forEach((v, j) => {
    const got = curve.multiplier(v);
    // The engine stores f32; the UI uses f64. Allow for that rounding.
    if (Math.abs(got - row.values[j]) > 2e-3 * Math.max(1, Math.abs(row.values[j]))) {
      bad++;
      console.log(`MISMATCH case ${i} (${row.accel.mode}/${row.accel.kind}) at speed ${v}: engine ${row.values[j]}, ui ${got}`);
    }
  });
}
console.log(bad === 0 ? `OK: ${rows.length} curves match the engine` : `${bad} mismatches`);
process.exit(bad === 0 ? 0 : 1);
