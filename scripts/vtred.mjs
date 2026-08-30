/* Червоні імена з .vt.json (звіт vitest --reporter=json).
   Навіщо окремо від scripts/chk.js: той читає .full.json (повний гейт), і на
   точковому прогоні показує СТАРИЙ звіт — тобто відповідає не на те питання. */
import { readFileSync } from "node:fs";

const file = process.argv[2] || ".vt.json";
const j = JSON.parse(readFileSync(file, "utf8"));
let pass = 0, fail = 0;
for (const f of j.testResults) {
  for (const a of f.assertionResults) {
    if (a.status === "failed") {
      fail++;
      console.log("RED >> " + a.fullName);
      const msg = (a.failureMessages || [])[0] || "";
      console.log("       " + msg.split("\n").slice(0, 3).join(" | ").slice(0, 400));
    } else pass++;
  }
}
console.log(`--- ${file}: passed ${pass}, failed ${fail}`);
