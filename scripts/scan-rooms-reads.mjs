/* Разовий інвентар: хто читає таблицю rooms і чи є в списку колонок schedule.
   Потрібен, щоб списки-винятки в тесті були ЗАМІРЯНІ, а не переказані. */
import { readdirSync, readFileSync } from "node:fs";

const out = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = dir + "/" + e.name;
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); continue; }
    if (!/\.(ts|tsx)$/.test(e.name)) continue;
    const code = readFileSync(p, "utf8");
    for (const m of code.matchAll(/\.from\(\s*["'`]rooms["'`]\s*\)([\s\S]{0,160})/g)) {
      const tail = m[1];
      const sel = tail.match(/\.select\(\s*(["'`])([\s\S]*?)\1/);
      out.push({ file: p.replace(/^\.\//, ""), cols: sel ? sel[2] : "(?)", hasSchedule: !!(sel && /schedule/.test(sel[2])) });
    }
  }
};
for (const r of ["./app", "./components", "./lib", "./scripts", "./automation"]) {
  try { walk(r); } catch { /* теки може не бути */ }
}
for (const o of out) console.log((o.hasSchedule ? "SCHED " : "      ") + o.file + "  ::  " + o.cols.slice(0, 60));
console.log("\nусього читань rooms: " + out.length + ", із них із schedule: " + out.filter((o) => o.hasSchedule).length);
