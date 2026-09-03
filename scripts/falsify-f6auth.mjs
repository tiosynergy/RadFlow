// ============================================================
//  Стенд фальсифікації сканера ПОВЕРХНІ АВТОРИЗАЦІЇ (Ф6, пакет 1, с55).
//
//  Сканер зелений із першого прогону — саме тому він тут. Питання те саме:
//  чи ЧЕРВОНІЄ названий тест, коли ламаєш рівно те, що він нібито стереже.
//  Кожна червона позиція називає імʼя сторожа (`expect`).
//
//  ⚠️ Правлю БОЙОВІ файли → try/finally + обробники сигналів.
//  ⚠️ Кожен якір перевіряється на УНІКАЛЬНІСТЬ у СИРОМУ джерелі.
//  Запуск: node scripts/falsify-f6auth.mjs      Звіт: falsify-f6auth.md
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { verdictOf } from "./lib/falsify-verdict.mjs";

const FILES = {
  mw: "lib/supabase/middleware.ts",
  cl: "app/call-list/page.tsx",
  qb: "app/queue/page.tsx",
  st: "app/staff/page.tsx",
  jr: "app/journal/page.tsx",
  sv: "app/services/page.tsx",
  rf: "app/referral/page.tsx",
  se: "app/search/page.tsx",
  ty: "supabase/types.ts",
};
const AS = "tests/authSurface.test.ts";
const SPECS = [AS];
const OUT = "falsify-f6auth.md";
const REPORT = ".falsify-f6auth.json";
const EXPECTED_ADDRESSED = 13;

const MUTATIONS = [
  {
    id: "M1", file: "mw", spec: AS, expect: /PROTECTED покриває РІВНО захищені роути/,
    what: "з PROTECTED прибрано /call-list — на дошку обдзвону пустить БЕЗ сесії",
    from: '  "/call-list",\n', to: "",
  },
  {
    id: "M2", file: "mw", spec: AS, expect: /PROTECTED покриває РІВНО захищені роути/,
    what: "у PROTECTED повернувся мертвий запис (Ф6-2)",
    from: '  "/queue",\n', to: '  "/queue",\n  "/incidents",\n',
  },
  {
    id: "M3", file: "mw", spec: AS, expect: /PROTECTED покриває РІВНО захищені роути/,
    what: "у PROTECTED потрапив /login — вхід став недосяжним для незалогіненого",
    from: '  "/setup",\n', to: '  "/setup",\n  "/login",\n',
  },
  {
    id: "M4", file: "mw", spec: AS, expect: /AUTH_PAGES — рівно ті публічні/,
    what: "/set-password дописано в AUTH_PAGES — залогіненого відводить із встановлення пароля",
    from: 'const AUTH_PAGES = ["/login", "/register"];',
    to: 'const AUTH_PAGES = ["/login", "/register", "/set-password"];',
  },
  {
    id: "M5", file: "cl", spec: AS, expect: /\/call-list — гейт на місці/,
    what: "Ф6-3 повернена: з дошки обдзвону знято гейт на ceo і порожній clinic_id",
    from: '  if (profile.role === "ceo" || !profile.clinic_id) redirect("/ceo");\n', to: "",
  },
  {
    id: "M6", file: "st", spec: AS, expect: /\/staff — гейт на місці/,
    what: "гейт /staff пустив реєстратора замість адміна",
    from: 'if (profile.role !== "admin") redirect("/queue"); // лише адміністратор',
    to: 'if (profile.role !== "registrar") redirect("/queue"); // лише адміністратор',
  },
  {
    id: "M7", file: "jr", spec: AS, expect: /\/journal — заявлений closes збігається з кодом/,
    what: "із /journal знято закриваючий позитив — лишився самий негативний ланцюг",
    from: '  if (profile.role !== "admin") redirect("/queue"); // лише адміністратор\n', to: "",
  },
  {
    id: "M8", file: "sv", spec: AS, expect: /\/services — гейт на місці/,
    what: "з гейта /services зникла перевірка центру — адмін без клініки проходить",
    from: 'if (profile.role !== "admin" || !profile.clinic_id) redirect("/queue");',
    to: 'if (profile.role !== "admin") redirect("/queue");',
  },
  {
    id: "M9", file: "rf", spec: AS, expect: /\/referral — гейт на місці/,
    what: "«і» замінено на «або» — гейт порталу пропускає будь-кого",
    from: 'if (profile.role !== "admin" && profile.role !== "referrer") redirect("/queue");',
    to: 'if (profile.role !== "admin" || profile.role !== "referrer") redirect("/queue");',
  },
  {
    id: "M10", file: "qb", spec: AS, expect: /\/queue — гейт на місці/,
    what: "з /queue знято відведення керівника — ceo потрапляє на дошку черги",
    from: '  if (profile.role === "ceo") redirect("/ceo"); // керівник — на свій дашборд\n', to: "",
  },
  {
    id: "M11", file: "ty", spec: AS, expect: /словник ролей у гейтах не розійшовся з ENUM/,
    what: "у базі зʼявилась шоста роль — інвентар гейтів її не знає",
    from: 'user_role: "admin" | "radiologist" | "registrar" | "referrer" | "ceo"',
    to: 'user_role: "admin" | "radiologist" | "registrar" | "referrer" | "ceo" | "auditor"',
  },
  {
    id: "M12", file: "sv", spec: AS, expect: /словник ролей у гейтах не розійшовся з ENUM/,
    what: "опечатка в назві ролі — гейт вимкнено мовчки",
    from: 'if (profile.role !== "admin" || !profile.clinic_id) redirect("/queue");',
    to: 'if (profile.role !== "admln" || !profile.clinic_id) redirect("/queue");',
  },
  {
    id: "M13", file: "se", spec: AS, expect: /\/search — заявлений closes збігається з кодом/,
    what: "із /search знято термінальну гілку — роль поза ланцюгом проходить",
    from: "  } else {\n    redirect(\"/queue\");\n  }", to: "  }",
  },
  // ---------- ЗЕЛЕНІ ----------
  {
    id: "G1", file: "st", green: true,
    what: "над гейтом дописано коментар — codeOf його зріже, зміст той самий",
    from: '  if (profile.role !== "admin") redirect("/queue"); // лише адміністратор',
    to: '  /* перевірено в с55 */\n  if (profile.role !== "admin") redirect("/queue"); // лише адміністратор',
  },
  {
    id: "G2", file: "jr", green: true,
    what: "гейт переформатовано на два рядки — пін про ЗМІСТ, не про розкладку",
    from: '  if (profile.role !== "admin") redirect("/queue"); // лише адміністратор',
    to: '  if (profile.role !== "admin")\n    redirect("/queue"); // лише адміністратор',
  },
];

const orig = {};
for (const [k, p] of Object.entries(FILES)) orig[k] = readFileSync(p, "utf8");
let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  for (const [k, p] of Object.entries(FILES)) writeFileSync(p, orig[k]);
}
process.on("SIGINT", () => { restore(); process.exit(130); });
process.on("SIGTERM", () => { restore(); process.exit(143); });
process.on("uncaughtException", (e) => { restore(); console.error(e); process.exit(2); });

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

let addressedOk = 0;
const lines = [];
try {
  const base = run();
  lines.push(`# Стенд фальсифікації сканера поверхні авторизації (Ф6, с55)\n`);
  lines.push(`**БАЗОВА ЛІНІЯ:** ${base.ok ? "ЗЕЛЕНА" : "ЧЕРВОНА"} (${base.total} тестів)\n`);
  if (!base.ok) {
    lines.push(`\n⛔ Базова лінія червона — стенд НІЧОГО не доводить. Червоні: ${base.red.join(", ")}\n`);
  } else {
    lines.push(`\n| # | мутація | очікування | факт | вердикт |`);
    lines.push(`|---|---|---|---|---|`);
    for (const m of MUTATIONS) {
      const path = FILES[m.file];
      const s = readFileSync(path, "utf8");
      const n = s.split(m.from).length - 1;
      if (n !== 1) { lines.push(`| ${m.id} | ${m.what} | — | ЯКІР НЕ УНІКАЛЬНИЙ (${n}): ${m.from.slice(0, 46)}… | ⛔ відхилено |`); continue; }
      writeFileSync(path, s.replace(m.from, () => m.to));
      const res = run();
      writeFileSync(path, s);
      const wantRed = !m.green;
      if (res.crashed) { lines.push(`| ${m.id} | ${m.what} | ${wantRed ? "ЧЕРВОНЕ" : "ЗЕЛЕНЕ"} | прогін не відбувся | ⛔ мутація зламала збірку |`); continue; }
      const gotRed = !res.ok;
      const missedName = wantRed && gotRed && m.expect && !res.red.some((t) => m.expect.test(t));
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
  const declared = MUTATIONS.filter((m) => m.expect && !m.green).length;
  const inventoryLies = declared !== EXPECTED_ADDRESSED;
  const addressedBad = addressedOk !== EXPECTED_ADDRESSED;
  lines.push(`\n## ПІДСУМОК: ${addressedOk}/${EXPECTED_ADDRESSED} адресних (названий сторож), 0 — лише за спек-файлом`);
  if (inventoryLies) lines.push(`\n⛔ ІНВЕНТАР БРЕШЕ: мутацій із \`expect\` ${declared}, а заявлено ${EXPECTED_ADDRESSED}.`);
  lines.push(`\n${verdict.summary}`);
  if (!verdict.ok || addressedBad || inventoryLies) lines.push(`\n**ВЕРДИКТ: ⛔ СТЕНД ЧЕРВОНИЙ**`);
  writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  console.log(lines.join("\n"));
  if (!verdict.ok || addressedBad || inventoryLies) process.exitCode = 1;
}
