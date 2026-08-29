// Скільки тестів дав КОНКРЕТНИЙ файл і які саме — щоб «зелено» не означало «не запускалось».
const fs = require("fs");
const j = JSON.parse(fs.readFileSync("D:/RadFlowDev/.full.json", "utf8"));
const want = process.argv[2] || "";
let n = 0;
for (const r of j.testResults || []) {
  if (!String(r.name || "").replace(/\\/g, "/").includes(want)) continue;
  for (const a of r.assertionResults || []) {
    n++;
    console.log(a.status.toUpperCase() + " :: " + a.fullName);
  }
}
console.log("--- matched tests: " + n);
