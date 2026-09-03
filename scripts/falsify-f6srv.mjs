// ============================================================
//  Стенд фальсифікації сканера СЕРВЕРНОЇ поверхні авторизації (Ф6, пакет 2, с55).
//
//  Сканер зелений із першого прогону — саме тому він тут. Питання те саме:
//  чи ЧЕРВОНІЄ названий тест, коли ламаєш рівно те, що він нібито стереже.
//
//  ⚠️ Половина позицій — типу `newFile`: клас, від якого написаний сканер, це
//  НОВИЙ роут / НОВИЙ файл actions / НОВИЙ імпортер service-role. Правити лише
//  вміст наявних файлів означало б не перевірити ГОЛОВНОГО напряму — саме на
//  цьому в пакеті 1 ревʼю спіймало переоцінку «13/13 адресних».
//
//  ⚠️ Правлю БОЙОВІ файли → try/finally + обробники сигналів.
//  Запуск: node scripts/falsify-f6srv.mjs      Звіт: falsify-f6srv.md
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { verdictOf } from "./lib/falsify-verdict.mjs";

const SA = "tests/serverAuthSurface.test.ts";
const FILES = {
  api: "lib/apiAuth.ts",
  int: "lib/integrationAuth.ts",
  sva: "app/services/actions.ts",
  qba: "app/queue/actions.ts",
  sa: SA,
};
const SPECS = [SA];
const OUT = "falsify-f6srv.md";
const REPORT = ".falsify-f6srv.json";

const ROUTE_NO_GATE = [
  'import { NextResponse } from "next/server";',
  'import { createAdminClient } from "@/lib/supabase/admin";',
  "export async function GET() {",
  "  const admin = createAdminClient();",
  '  const { data } = await admin.from("profiles").select("id");',
  "  return NextResponse.json({ data });",
  "}",
  "",
].join("\n");

const ROUTE_LATE_GATE = [
  'import { NextResponse } from "next/server";',
  'import { createAdminClient } from "@/lib/supabase/admin";',
  'import { requireRole } from "@/lib/apiAuth";',
  "export async function GET() {",
  "  const admin = createAdminClient();",
  '  const gate = await requireRole(["admin"]);',
  "  if (!gate.ok) return gate.res;",
  '  const { data } = await admin.from("profiles").select("id");',
  "  return NextResponse.json({ data });",
  "}",
  "",
].join("\n");

const ROUTE_GOOD = [
  'import { NextResponse } from "next/server";',
  'import { createAdminClient } from "@/lib/supabase/admin";',
  'import { requireRole } from "@/lib/apiAuth";',
  "export async function GET() {",
  '  const gate = await requireRole(["admin"]);',
  "  if (!gate.ok) return gate.res;",
  "  const admin = createAdminClient();",
  '  const { data } = await admin.from("profiles").select("id");',
  "  return NextResponse.json({ data });",
  "}",
  "",
].join("\n");

const ACTIONS_STUB = '"use server";\n\nexport async function zzFalsify() {\n  return { ok: true };\n}\n';
const ADMIN_IMPORTER = 'import { createAdminClient } from "@/lib/supabase/admin";\n\nexport const zz = () => createAdminClient();\n';

const MUTATIONS = [
  {
    id: "M1", spec: SA, expect: /кожен роут або має гейт/,
    what: "новий роут бере service-role і не має жодного гейта — рівно той клас, від якого написаний сканер",
    newFile: "app/api/zz-falsify/route.ts", content: ROUTE_NO_GATE,
  },
  {
    id: "M2", file: "sa", spec: SA, expect: /PRE_AUTH не описує роута/,
    what: "в інвентарі pre-auth зʼявився роут-привид",
    from: '  "/api/auth/reset": ',
    to: '  "/api/zz-ghost": "привид, якого в дереві немає",\n  "/api/auth/reset": ',
  },
  {
    id: "M3", spec: SA, expect: /service-role ніколи не раніше за гейт/,
    what: "гейт у новому роуті стоїть ПІСЛЯ createAdminClient — перевірка ролі перестала бути умовою доступу",
    newFile: "app/api/zz-order/route.ts", content: ROUTE_LATE_GATE,
  },
  {
    id: "M4", spec: SA, expect: /склад файлів із "use server"/,
    what: "зʼявився новий файл server actions — модель розділення ніхто не перечитав",
    newFile: "app/zz-falsify/actions.ts", content: ACTIONS_STUB,
  },
  {
    id: "M5", file: "sva", spec: SA, expect: /server actions ніколи не беруть service-role/,
    what: "server action узяв service-role — RLS для нього більше не діє, іншого гейта в actions немає",
    from: "  const { data: { user } } = await supabase.auth.getUser();",
    to: "  const _admin = createAdminClient();\n  const { data: { user } } = await supabase.auth.getUser();",
  },
  {
    id: "M6", spec: SA, expect: /імпорт service-role поза роутами/,
    what: "service-role зʼявився у файлі поза названим кругом інфраструктури",
    newFile: "lib/zzFalsifyAdmin.ts", content: ADMIN_IMPORTER,
  },
  {
    id: "M7", file: "api", spec: SA, expect: /requireRole: порядок кроків/,
    what: "відмову «чужа роль» замінено на УСПІХ — гейт пускає будь-кого з профілем",
    from: '    return err(opts?.forbidden ?? "Недостатньо прав", 403);',
    to: "    return { ok: true, supabase, user: { id: user.id }, me: me as Caller };",
  },
  {
    id: "M8", file: "int", spec: SA, expect: /requireIntegrationKey: fail-closed/,
    what: "з перевірки ключа знято revoked_at — ВІДКЛИКАНИЙ ключ знову проходить",
    from: "  if (!key || !key.active || key.revoked_at !== null) {",
    to: "  if (!key || !key.active) {",
  },

  /* ---------- ЗЕЛЕНІ ---------- */
  {
    id: "G1", green: true,
    what: "новий ПРАВИЛЬНИЙ роут (гейт, потім service-role) — сторож не сміє червоніти на здоровому коді",
    newFile: "app/api/zz-good/route.ts", content: ROUTE_GOOD,
  },
  {
    id: "G2", file: "qba", green: true,
    /* ⚠️ Не наповнювач: без codeOf текст із коментаря потрапив би в скан і
       сторож «actions не беруть service-role» почервонів би на порожньому
       місці. Зелено тут може бути ЛИШЕ тому, що коментарі зрізаються. */
    what: "у actions вставлено КОМЕНТАР із текстом createAdminClient() — codeOf його зріже",
    from: "export async function saveQueueDelayPolicy",
    to: "/* історія: тут колись стояв createAdminClient() */\nexport async function saveQueueDelayPolicy",
  },
];

const orig = {};
for (const [k, p] of Object.entries(FILES)) orig[k] = readFileSync(p, "utf8");
const created = new Set();
let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  for (const [k, p] of Object.entries(FILES)) writeFileSync(p, orig[k]);
  for (const p of created) { try { rmSync(p, { recursive: true, force: true }); } catch { /* нічого */ } }
  created.clear();
}
process.on("SIGINT", () => { restore(); process.exit(130); });
process.on("SIGTERM", () => { restore(); process.exit(143); });
process.on("uncaughtException", (e) => { restore(); console.error(e); process.exit(2); });

/** Створити файл; повернути НАЙВИЩИЙ каталог, якого до мутації не існувало —
    саме його зносимо, інакше лишиться порожня папка. */
function addFile(rel, content) {
  const parts = rel.split("/");
  let top = null, cur = "";
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur ? `${cur}/${parts[i]}` : parts[i];
    if (!existsSync(cur) && top === null) top = cur;
  }
  mkdirSync(dirname(rel), { recursive: true });
  writeFileSync(rel, content);
  return top ?? rel;
}

function run() {
  if (existsSync(REPORT)) unlinkSync(REPORT);
  spawnSync("npx", ["vitest", "run", ...SPECS, "--reporter=json", `--outputFile.json=${REPORT}`],
    { shell: true, stdio: "ignore", timeout: 10 * 60 * 1000 });
  if (!existsSync(REPORT)) return { crashed: true, ok: false, redBySpec: {}, red: [], all: [] };
  let r;
  try { r = JSON.parse(readFileSync(REPORT, "utf8")); }
  catch { return { crashed: true, ok: false, redBySpec: {}, red: [], all: [] }; }
  const red = [], redBySpec = {}, all = [];
  for (const f of r.testResults || []) {
    const name = String(f.name || "").replace(/\\/g, "/");
    for (const a of f.assertionResults || []) {
      all.push(a.fullName || a.title);
      if (a.status === "passed") continue;
      const full = a.fullName || a.title;
      red.push(full);
      for (const s of SPECS) if (name.endsWith(s)) (redBySpec[s] ??= []).push(full);
    }
  }
  return { crashed: false, ok: r.success === true && red.length === 0, red, redBySpec, all, total: r.numTotalTests };
}

const labelOf = (full) => String(full).replace(/\/[a-z-]+ — /, "");

let addressedOk = 0;
let baseAll = [];
let baseOk = false;
const lines = [];
try {
  const base = run();
  baseAll = base.all;
  baseOk = base.ok;
  lines.push(`# Стенд фальсифікації сканера серверної поверхні авторизації (Ф6 пакет 2, с55)\n`);
  lines.push(`**БАЗОВА ЛІНІЯ:** ${base.ok ? "ЗЕЛЕНА" : "ЧЕРВОНА"} (${base.total} тестів)\n`);
  if (!base.ok) {
    lines.push(`\n⛔ Базова лінія червона — стенд НІЧОГО не доводить. Червоні: ${base.red.join(", ")}\n`);
  } else {
    lines.push(`\n| # | мутація | очікування | факт | вердикт |`);
    lines.push(`|---|---|---|---|---|`);
    for (const m of MUTATIONS) {
      let path = null, s = null, top = null;
      if (m.newFile) {
        if (existsSync(m.newFile)) { lines.push(`| ${m.id} | ${m.what} | — | ФАЙЛ УЖЕ ІСНУЄ: ${m.newFile} | ⛔ відхилено |`); continue; }
        top = addFile(m.newFile, m.content);
        created.add(top);
      } else {
        path = FILES[m.file];
        s = readFileSync(path, "utf8");
        const n = s.split(m.from).length - 1;
        if (n !== 1) { lines.push(`| ${m.id} | ${m.what} | — | ЯКІР НЕ УНІКАЛЬНИЙ (${n}): ${m.from.slice(0, 46)}… | ⛔ відхилено |`); continue; }
        writeFileSync(path, s.replace(m.from, () => m.to));
      }
      const res = run();
      if (m.newFile) { rmSync(top, { recursive: true, force: true }); created.delete(top); }
      else writeFileSync(path, s);
      const wantRed = !m.green;
      if (res.crashed) { lines.push(`| ${m.id} | ${m.what} | ${wantRed ? "ЧЕРВОНЕ" : "ЗЕЛЕНЕ"} | прогін не відбувся | ⛔ мутація зламала збірку |`); continue; }
      const gotRed = !res.ok;
      const ownRed = (res.redBySpec[m.spec] || []);
      const missedName = wantRed && gotRed && m.expect && !ownRed.some((t) => m.expect.test(t));
      const noSuchGuard = missedName && !base.all.some((t) => m.expect.test(t));
      const verdict = noSuchGuard ? "⛔ СТОРОЖА З ТАКИМ ІМЕНЕМ НЕМАЄ (дефект стенда)"
        : missedName ? "⛔ ЧУЖИЙ спек"
        : wantRed !== gotRed ? "⛔ СТОРОЖ НЕ ТРИМАЄ" : "✅";
      if (verdict === "✅" && wantRed && m.expect) addressedOk++;
      const fact = gotRed ? res.red.map((t) => `«${t}»`).slice(0, 3).join("; ") : "усе зелене";
      lines.push(`| ${m.id} | ${m.what} | ${wantRed ? "ЧЕРВОНЕ" : "ЗЕЛЕНЕ"} | ${fact} | ${verdict} |`);
    }
  }
} finally {
  restore();
  if (existsSync(REPORT)) unlinkSync(REPORT);
  const verdict = verdictOf(lines, MUTATIONS.length);

  /* Покриття рахується по ІМЕНАХ сторожів із базового прогону, а не по ручній
     константі: новий `it` у спеку без своєї мутації лишається неадресованим і
     валить стенд. Підкрутити число, щоб приховати зняту мутацію, тут нічим. */
  const declared = MUTATIONS.filter((m) => m.expect && !m.green).length;
  const labels = [...new Set(baseAll.map(labelOf))];
  const coveredLabels = new Set();
  for (const m of MUTATIONS) {
    if (m.green || !m.expect) continue;
    for (const n of baseAll) if (m.expect.test(n)) coveredLabels.add(labelOf(n));
  }
  const uncovered = labels.filter((l) => !coveredLabels.has(l));
  const addressedBad = baseOk && addressedOk !== declared;

  lines.push(`\n## ПІДСУМОК: ${addressedOk}/${declared} адресних (названий сторож почервонів у СВОЄМУ спеку); сторожів у спеку ${labels.length}, з них без власної мутації ${uncovered.length}`);
  if (uncovered.length) lines.push(`\n⛔ СТОРОЖІ БЕЗ МУТАЦІЇ (нічим не фальсифіковані):\n${uncovered.map((l) => `* ${l}`).join("\n")}`);
  lines.push(`\n${verdict.summary}`);
  if (!verdict.ok || addressedBad || uncovered.length) lines.push(`\n**ВЕРДИКТ: ⛔ СТЕНД ЧЕРВОНИЙ**`);
  writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  console.log(lines.join("\n"));
  if (!verdict.ok || addressedBad || uncovered.length) process.exitCode = 1;
}
