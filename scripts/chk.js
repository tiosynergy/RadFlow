// Читач JSON-звіту vitest: імена ЧЕРВОНИХ тестів, без розбору ANSI.
// Шлях до звіту — аргументом (за замовчуванням .full.json у корені).
const f = process.argv[2] || ".full.json";
const j = require("../" + f);
console.log("total", j.numTotalTests, "passed", j.numPassedTests, "failed", j.numFailedTests);
for (const file of j.testResults) {
  for (const a of file.assertionResults) {
    if (a.status === "failed") console.log("RED >>", a.fullName);
  }
}
