/* Збирає importable n8n-експорт radflow-price-import.workflow.json із джерел нод
   у ./nodes (єдине джерело істини для Code-нод). Секрет уже редаговано в .js.
   Запуск: node automation/n8n/build-export.mjs  (з кореня репо або звідусіль). */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const code = (f) => readFileSync(join(here, "nodes", f), "utf8");

const nodes = [
  {
    parameters: { httpMethod: "POST", path: "radflow-price-import", responseMode: "responseNode", options: { rawBody: true } },
    id: "447a1d4a-598b-4d17-ae3f-6bdf0eec8d00", name: "Webhook Import",
    type: "n8n-nodes-base.webhook", typeVersion: 2.1, position: [240, 304],
    webhookId: "b9941277-9475-49cf-972e-40e6564976df",
  },
  {
    parameters: { jsCode: code("verify-and-decode.js") },
    id: "ee111625-18a9-4f3f-81a0-874391362b72", name: "Verify & Decode",
    type: "n8n-nodes-base.code", typeVersion: 2, position: [528, 304],
  },
  {
    id: "1d548185-53be-4a62-aa3c-c426197b2abd", name: "Route Kind",
    type: "n8n-nodes-base.switch", typeVersion: 3.2, position: [800, 304],
    parameters: {
      rules: { values: ["xlsx", "csv", "pdf", "image", "text", "url"].map((k) => ({
        outputKey: k,
        conditions: {
          options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 2 },
          conditions: [{ leftValue: "={{ $json.kind }}", operator: { type: "string", operation: "equals" }, rightValue: k }],
          combinator: "and",
        },
      })) },
      options: {},
    },
  },
  {
    parameters: { operation: "xlsx", binaryPropertyName: "file", options: { headerRow: true, includeEmptyCells: true } },
    id: "a42f12c0-4f52-4bdf-89b6-66c56f222dfc", name: "Extract XLSX",
    type: "n8n-nodes-base.extractFromFile", typeVersion: 1.1, position: [1088, 192], alwaysOutputData: true,
  },
  {
    parameters: { binaryPropertyName: "file", options: { relaxQuotes: true, headerRow: true, skipRecordsWithErrors: { value: { enabled: true } }, includeEmptyCells: true } },
    id: "ad33c638-3a0d-434b-bfb6-c2d0899a074c", name: "Extract CSV",
    type: "n8n-nodes-base.extractFromFile", typeVersion: 1.1, position: [1088, 432], alwaysOutputData: true,
  },
  {
    parameters: { operation: "pdf", binaryPropertyName: "file", options: { joinPages: true, maxPages: 60 } },
    id: "72fc2487-db38-47f8-8453-a799d44498a3", name: "Extract PDF",
    type: "n8n-nodes-base.extractFromFile", typeVersion: 1.1, position: [1088, 560],
  },
  {
    // ⚠️ Редиректи ВИМКНЕНО (SSRF M1): 302 на приватний хост зняв би гарди.
    parameters: { method: "GET", url: "={{ $json.url }}", options: { timeout: 15000, redirect: { redirect: { followRedirects: false } }, response: { response: { responseFormat: "text", outputPropertyName: "data" } } } },
    id: "bab0e040-cc05-4d1d-8665-41aea0f2177a", name: "Fetch Page",
    type: "n8n-nodes-base.httpRequest", typeVersion: 4.4, position: [1088, 832],
  },
  {
    parameters: { jsCode: code("build-ai-request.js") },
    id: "bab6d091-0726-4a12-942a-0f070f39f68b", name: "Build AI Request",
    type: "n8n-nodes-base.code", typeVersion: 2, position: [1360, 688],
  },
  {
    // credential «xAi account» (xAiApi) переобирається при імпорті — секрет не в репо.
    parameters: { method: "POST", url: "https://api.x.ai/v1/chat/completions", authentication: "predefinedCredentialType", nodeCredentialType: "xAiApi", sendBody: true, contentType: "json", specifyBody: "json", jsonBody: "={{ $json.aiBody }}", options: { timeout: 240000 } },
    id: "14259d17-78bb-4c97-90d1-6a25a6b6f3d0", name: "Call Grok",
    type: "n8n-nodes-base.httpRequest", typeVersion: 4.4, position: [1632, 688],
  },
  {
    parameters: { jsCode: code("parse-ai-rows.js") },
    id: "e70c8627-014a-4b8a-8e47-f33c723c36ec", name: "Parse AI Rows",
    type: "n8n-nodes-base.code", typeVersion: 2, position: [1904, 688], alwaysOutputData: true,
  },
  {
    parameters: { jsCode: code("sign-response.js") },
    id: "8b382aeb-121a-488e-82bc-0375801483fd", name: "Sign Response",
    type: "n8n-nodes-base.code", typeVersion: 2, position: [1360, 304],
  },
  {
    parameters: { options: {} },
    id: "c785031a-2110-429a-909a-b2bd3d7be280", name: "Respond",
    type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.5, position: [1648, 304],
  },
];

const connections = {
  "Webhook Import": { main: [[{ node: "Verify & Decode", type: "main", index: 0 }]] },
  "Verify & Decode": { main: [[{ node: "Route Kind", type: "main", index: 0 }]] },
  "Route Kind": { main: [
    [{ node: "Extract XLSX", type: "main", index: 0 }],
    [{ node: "Extract CSV", type: "main", index: 0 }],
    [{ node: "Extract PDF", type: "main", index: 0 }],
    [{ node: "Build AI Request", type: "main", index: 0 }],
    [{ node: "Build AI Request", type: "main", index: 0 }],
    [{ node: "Fetch Page", type: "main", index: 0 }],
  ] },
  "Extract XLSX": { main: [[{ node: "Sign Response", type: "main", index: 0 }]] },
  "Extract CSV": { main: [[{ node: "Sign Response", type: "main", index: 0 }]] },
  "Extract PDF": { main: [[{ node: "Build AI Request", type: "main", index: 0 }]] },
  "Fetch Page": { main: [[{ node: "Build AI Request", type: "main", index: 0 }]] },
  "Build AI Request": { main: [[{ node: "Call Grok", type: "main", index: 0 }]] },
  "Call Grok": { main: [[{ node: "Parse AI Rows", type: "main", index: 0 }]] },
  "Parse AI Rows": { main: [[{ node: "Sign Response", type: "main", index: 0 }]] },
  "Sign Response": { main: [[{ node: "Respond", type: "main", index: 0 }]] },
};

const workflow = {
  name: "radflow-price-import",
  nodes,
  connections,
  settings: { executionOrder: "v1", binaryMode: "separate" },
};

// Захист від витоку: якщо в зібраному JSON лишився живий секрет — падаємо.
const out = JSON.stringify(workflow, null, 2);
if (/const SECRET = '[0-9a-f]{64}'/.test(out)) {
  throw new Error("LEAK: у зібраному експорті лишився 64-hex секрет — перевір nodes/*.js");
}
writeFileSync(join(here, "radflow-price-import.workflow.json"), out + "\n");
console.log("OK: radflow-price-import.workflow.json зібрано, секрет-плейсхолдер на місці");
