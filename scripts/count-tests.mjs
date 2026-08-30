/* Лічильник підсумків vitest із .full.json: у цьому середовищі немає ні
   ConvertFrom-Json, ні надійного `node -e`, тож рахуємо файлом. */
import { readFileSync } from "node:fs";
const j = JSON.parse(readFileSync(".full.json", "utf8"));
console.log(
  `files=${j.numTotalTestSuites} suitesFailed=${j.numFailedTestSuites} ` +
  `tests=${j.numTotalTests} passed=${j.numPassedTests} failed=${j.numFailedTests}`,
);
