// ============================================================
//  Стенд фальсифікації пакета 43 (с59): TTL запрошення (хвіст RF-02).
//
//  Головне питання стенда: чи ловлять сторожі САМЕ ті способи зняти TTL,
//  кожен з яких лишає код на вигляд робочим —
//    • вихолостити штамп у базі (тіло під дайджестом №19);
//    • зняти тригер-штамп (№17 бачить наявність і `tgenabled`);
//    • зробити «без штампа» синонімом «дійсне» (fail-OPEN замість closed);
//    • перевірити строк ПІСЛЯ клейму — тоді протухле посилання спалює токен;
//    • повернути лімітеру мовчазний fail-open на enumeration-шляхах.
//
//  ⚠️ Правлю БОЙОВІ файли (міграцію, lib, роут, спеки) → try/finally.
//  ⚠️ Кожен якір перевіряється на УНІКАЛЬНІСТЬ.
//  ⚠️ Базова лінія мусить бути ЗЕЛЕНОЮ.
//  ⚠️ Міграція вже накатана і заштампована `db:gate`: стенд ОБОВʼЯЗКОВО
//     відновлює файл, інакше наступний `db:gate:check` побачить md5-дрейф.
//
//  Запуск: node scripts/falsify-0182.mjs   Звіт: falsify-0182.md
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { verdictOf, finishStand } from "./lib/falsify-verdict.mjs";

function latestReprint() {
  const dir = "supabase/migrations";
  let best = "";
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const txt = readFileSync(`${dir}/${f}`, "utf8");
    const at = txt.search(/^create or replace function public\.invariants_check/m);
    if (at < 0) continue;
    if (txt.indexOf("\n$function$;", at) < 0) continue;
    best = dir + "/" + f;
  }
  if (!best) { console.error("НЕ ЗНАЙДЕНО жодного передруку invariants_check"); process.exit(2); }
  return best;
}
const FILES = {
  mig: latestReprint(),
  lib: "lib/inviteTtl.ts",
  rl: "lib/rateLimit.ts",
  route: "app/api/account/set-password/route.ts",
  trg: "tests/guardTriggersInvariant.test.ts",
};
const SPECS = [
  "tests/inviteTtl.test.ts",
  "tests/guardFnBodiesInvariant.test.ts",
  "tests/guardTriggersInvariant.test.ts",
];
const OUT = "falsify-0182.md";
const REPORT = ".falsify-0182.json";

const MUTATIONS = [
  {
    id: "A1", file: "mig", green: false,
    expect: /guard_invite_issued_at/,
    what: "рядок штампа прибрано зі списку №19 (тіло більше не пінується)",
    from: "      ('guard_invite_issued_at()','f5f04a4bf959614f4060d97c5220094d','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),\n",
    to: "",
  },
  {
    /* ⚠️ Той самий сторож, що в A3, але з ІНШОГО боку: тут всихає список у
       ФАЙЛІ міграції, там — інвентар у тесті. Однакове `expect` тут не
       недогляд: перевірка одна, а способи її обійти різні, і обидва мусять
       червоніти. Перша редакція мала тут `/zz_invite_issued_at/` і дала
       «сторожа з таким іменем немає» — регулярка цілила в імʼя тригера, а не
       в назву тесту. */
    id: "A2", file: "mig", green: false,
    expect: /21 пара/,
    what: "пару (profiles, zz_invite_issued_at) прибрано зі списку №17",
    from: "      ('profiles','zz_invite_issued_at','CREATE TRIGGER zz_invite_issued_at BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION guard_invite_issued_at()'),\n",
    to: "",
  },
  {
    /* Другий бік лічильника: інвентар у ТЕСТІ всох, а файл цілий. */
    id: "A3", file: "trg", green: false,
    expect: /21 пара/,
    what: "пару прибрано з інвентарю GUARDS у самому тесті",
    from: '  ["profiles", "zz_invite_issued_at"],\n',
    to: "",
  },
  {
    /* САМЕ та підміна, заради якої стан «без штампа» окремий. */
    id: "A4", file: "lib", green: false,
    expect: /БЕЗ штампа/,
    what: "«без штампа» стало «дійсним» (fail-open замість fail-closed)",
    from: '  if (!issuedAt) return "unstamped";',
    to: '  if (!issuedAt) return "valid";',
  },
  {
    id: "A5", file: "lib", green: false,
    expect: /на межі TTL/,
    what: "межу TTL зсунуто на добу",
    from: "  return now.getTime() - t > INVITE_TTL_MS ? \"expired\" : \"valid\";",
    to: "  return now.getTime() - t > INVITE_TTL_MS + 86400000 ? \"expired\" : \"valid\";",
  },
  {
    id: "A6", file: "lib", green: false,
    expect: /сім днів/,
    what: "строк тихо збільшено до 30 днів",
    from: "export const INVITE_TTL_DAYS = 7;",
    to: "export const INVITE_TTL_DAYS = 30;",
  },
  {
    /* Порядок, через який протухле посилання спалювало б токен. */
    id: "A7", file: "route", green: false,
    expect: /ДО клейму/,
    what: "перевірку строку прибрано з POST — лишилась тільки на GET",
    from: "  if (pre && inviteState(pre.invite_issued_at) !== \"valid\") {\n    return NextResponse.json({ error: EXPIRED }, { status: 400 });\n  }\n",
    to: "",
  },
  {
    id: "A8", file: "route", green: false,
    expect: /GET теж перевіряє/,
    what: "перевірку строку прибрано з GET",
    from: "  if (inviteState(profile.invite_issued_at) !== \"valid\") {\n    return NextResponse.json({ error: EXPIRED }, { status: 400 });\n  }\n",
    to: "",
  },
  {
    id: "A9", file: "route", green: false,
    expect: /РІЗНІ тексти/,
    what: "текст протухлого злито з недійсним",
    from: 'const EXPIRED = "Термін дії посилання минув. Зверніться до адміністратора за новим.";',
    to: "const EXPIRED = INVALID;",
  },
  {
    /* Повернення мовчазного fail-open на enumeration-шлях. */
    id: "A10", file: "route", green: false,
    expect: /fail-closed/,
    what: "lookup-шлях повернуто на мовчазний fail-open",
    from: 'rateLimitOk(`setpw:lookup:${ip}`, 30, 600, "closed")',
    to: "rateLimitOk(`setpw:lookup:${ip}`, 30, 600)",
  },
  {
    id: "A11", file: "rl", green: false,
    expect: /рішення бере ВИКЛИКАЧ/,
    what: "лімітер знову вирішує сам: завжди пропускає",
    from: "  const fallback = onFailure === \"open\";",
    to: "  const fallback = true;",
  },
  {
    id: "A12", file: "rl", green: false,
    expect: /лишає СЛІД/,
    what: "слід про відмову лімітера прибрано — мовчазний fail-open повернувся",
    from: "  logError({\n    event: \"ratelimit.unavailable\",",
    to: "  if (prefix) return;\n  logError({\n    event: \"ratelimit.unavailable\",",
  },
  {
    id: "A13", file: "rl", green: false,
    expect: /НЕ на кожен виклик/,
    what: "throttle слідів знято — перший же збій топить лог",
    from: "  if (now - prev < 60_000) return;",
    to: "  if (false) return;",
  },
  /* ---------------- T: позитивні контролі ---------------- */
  {
    id: "T1", file: "lib", green: true,
    what: "коментар у шапці TTL переписано",
    from: "   Рішення власника: 7 днів.",
    to: "   Рішення власника (с59): 7 днів.",
  },
  {
    id: "T2", file: "mig", green: true,
    what: "коментар про 0182 у тілі сторожа переписано",
    /* ⚠️ ЯКІР ПЕРЕЦІЛЕНО РЕВІЗІЄЮ с60, і причина структурна, а не випадкова.
       Було: рядок із ШАПКИ файла 0182. Але `file: "mig"` — це не «моя
       міграція», а `latestReprint()`, тобто ЗАВЖДИ найновіший передрук. Щойно
       вийшла 0183, шапка стала чужою, якір дав 0 збігів, і контроль мовчки
       перестав щось контролювати. Будь-який якір у ШАПКУ міграції приречений
       протухнути на наступному ж передруку.
       Тепер ціль — коментар, який 0182 вписала в ТІЛО сторожа (№19): передрук
       переносить тіло вперед дослівно, тож цей рядок переживе всі наступні
       міграції за побудовою. */
    from: "  --     ⚠️ 0182 (RF-02): додано `guard_invite_issued_at()` — штамп часу видачі\n",
    to: "  --     ⚠️ 0182 (RF-02): доданий `guard_invite_issued_at()` — штамп часу видачі\n",
  },
];

const editsOf = (m) => m.edits ?? [{ file: m.file, from: m.from, to: m.to }];

for (const m of MUTATIONS) {
  const eds = editsOf(m);
  const bad =
    (!m.green && !m.expect) ? "мутація мусить червоніти, але не називає сторожа (`expect`)"
    : (m.green && m.expect) ? "`expect` у рядку, який МУСИТЬ лишитись зеленим — сторожа тут не буває"
    : (m.expect && /\|/.test(m.expect.source)) ? "у регулярці `|` — вона зламає таблицю звіту"
    : null;
  if (bad) {
    console.error(`⛔ ІНВЕНТАР БРЕШЕ: ${m.id} — ${bad}. Стенд НЕ прогнано.`);
    process.exit(1);
  }
  for (const e of eds) {
    if (!e.file || !FILES[e.file] || typeof e.from !== "string" || typeof e.to !== "string") {
      console.error(`⛔ ІНВЕНТАР БРЕШЕ: ${m.id} — правка без файлу з FILES або без from/to.`);
      process.exit(1);
    }
  }
}

/* Кількість адресних мутацій — КОНСТАНТА (урок U-80г). A1/A2 два нові рядки
   case-RPC, A3 сам гард, A4 регресія 0179, A5 другий бік лічильника пінів,
   A1 сирий SHA, A2 довжина, A3 заглушка замість no-system-env, A4 форма SHA,
   A5 регістр, A6 константний штамп, A7 no-store, A8 force-dynamic,
   A1/A2 списки №19 і №17, A3 другий бік лічильника пар, A4 fail-open на
   «без штампа», A5 межа TTL, A6 тихе збільшення строку, A7/A8 порядок і
   наявність перевірки в POST/GET, A9 злиття текстів, A10 повернення
   мовчазного fail-open на lookup, A11 лімітер вирішує сам, A12 зниклий слід,
   A13 знятий throttle. T1/T2 — рефакторні контролі. */
const EXPECTED_RED = 13;
const redCount = MUTATIONS.filter((m) => !m.green).length;
if (redCount !== EXPECTED_RED) {
  console.error(`⛔ ІНВЕНТАР БРЕШЕ: адресних мутацій ${redCount}, а очікується ${EXPECTED_RED}. Стенд НЕ прогнано.`);
  process.exit(1);
}

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
    { shell: true, stdio: "ignore" });
  if (!existsSync(REPORT)) return { crashed: true, ok: false, red: [] };
  let r;
  try { r = JSON.parse(readFileSync(REPORT, "utf8")); }
  catch { return { crashed: true, ok: false, red: [] }; }
  const red = [], all = [];
  for (const f of r.testResults || []) {
    for (const a of f.assertionResults || []) {
      const n = a.fullName || a.title;
      all.push(n);
      if (a.status !== "passed") red.push(n);
    }
  }
  return { crashed: false, ok: r.success === true && red.length === 0, red, all, total: r.numTotalTests };
}

const lines = [];
let addressedOk = 0;
try {
  const base = run();
  lines.push(`# Стенд фальсифікації пакета 43 — TTL запрошення (RF-02)\n`);
  lines.push(`**БАЗОВА ЛІНІЯ:** ${base.ok ? "ЗЕЛЕНА" : "ЧЕРВОНА"} (${base.total} тестів)\n`);
  if (!base.ok) {
    lines.push(`\n⛔ Базова лінія червона — стенд НІЧОГО не доводить. Червоні: ${base.red.join(", ")}\n`);
  } else {
    lines.push(`\n| # | мутація | очікування | факт | вердикт |`);
    lines.push(`|---|---|---|---|---|`);
    for (const m of MUTATIONS) {
      const eds = editsOf(m).map((e) => ({ ...e, path: FILES[e.file], src: readFileSync(FILES[e.file], "utf8") }));
      const dead = eds.find((e) => e.src.split(e.from).length - 1 !== 1);
      if (dead) {
        const n = dead.src.split(dead.from).length - 1;
        lines.push(`| ${m.id} | ${m.what} | — | ЯКІР НЕ УНІКАЛЬНИЙ (${n}) у ${dead.path} | ⛔ відхилено |`);
        continue;
      }
      const cur = {};
      for (const e of eds) {
        const base2 = cur[e.path] ?? e.src;
        cur[e.path] = base2.replace(e.from, () => e.to);
      }
      for (const [p, txt] of Object.entries(cur)) writeFileSync(p, txt);
      const res = run();
      for (const e of eds) writeFileSync(e.path, e.src);
      const wantRed = !m.green;
      if (res.crashed) {
        lines.push(`| ${m.id} | ${m.what} | ${wantRed ? "ЧЕРВОНЕ" : "ЗЕЛЕНЕ"} | прогін не відбувся | ⛔ мутація зламала збірку |`);
        continue;
      }
      const gotRed = !res.ok;
      const fact = gotRed ? res.red.map((t) => `«${t}»`).join("; ") : "усе зелене";
      const missed = wantRed && gotRed && !res.red.some((t) => m.expect.test(t));
      const noSuchGuard = missed && !res.all.some((t) => m.expect.test(t));
      const verdict = noSuchGuard ? "⛔ СТОРОЖА З ТАКИМ ІМЕНЕМ НЕМАЄ (дефект стенда)"
        : missed ? "⛔ ЧУЖИЙ спек"
        : (wantRed === gotRed ? "✅" : "⛔ СТОРОЖ НЕ ТРИМАЄ");
      if (verdict === "✅" && wantRed) addressedOk++;
      const want = wantRed ? `ЧЕРВОНЕ: ${m.expect.source}` : "ЗЕЛЕНЕ";
      lines.push(`| ${m.id} | ${m.what} | ${want} | ${fact} | ${verdict} |`);
    }
  }
} finally {
  restore();
  if (existsSync(REPORT)) unlinkSync(REPORT);
  const verdict = verdictOf(lines, MUTATIONS.length);
  lines.push(`\n${verdict.summary}`);
  lines.push(`\n## ПІДСУМОК: ${addressedOk}/${EXPECTED_RED} адресних, ${MUTATIONS.length - EXPECTED_RED} рефакторних`);
  writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log(`\nЗвіт: ${OUT}. Файли відновлено.`);
  finishStand({
    ok: !(!verdict.ok),
    red: "\n⛔ ВЕРДИКТ: СТЕНД ЧЕРВОНИЙ — причина в таблиці вище.",
  });
}
