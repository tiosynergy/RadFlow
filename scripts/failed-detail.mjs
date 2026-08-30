/* Повідомлення червоних тестів із довільного JSON-звіту vitest. */
import { readFileSync } from "node:fs";
const file = process.argv[2] || ".full.json";
const j = JSON.parse(readFileSync(file, "utf8"));
for (const f of j.testResults) {
  for (const a of f.assertionResults) {
    if (a.status === "failed") {
      console.log("=== " + a.fullName);
      console.log((a.failureMessages || []).join("\n").slice(0, 1200));
    }
  }
}
