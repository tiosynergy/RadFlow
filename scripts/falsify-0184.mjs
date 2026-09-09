// ============================================================
//  Стенд фальсифікації пакета 46 (с61): RF-03b — позначка про графік дня.
//
//  Головне питання стенда: чи ловлять сторожі САМЕ ті способи зламати віяло,
//  кожен з яких лишає код на вигляд робочим —
//    • оголосити CTE віяла і забути додати його в union (жодного отримувача);
//    • зняти `pr.approved` (крапка тому, хто на портал не потрапляє → вічна);
//    • зняти фільтр по грантах кабінетів (та сама діра, що закрила 0183a,
//      але вже в каналі СПОВІЩЕНЬ, а не читання);
//    • повернути персонал і радіолога в аудиторію 'schedule' (крапка, яку
//      немає де погасити);
//    • прибрати третій аргумент ack (заморозка береться раз → крапка не гасне);
//    • прибрати пункт із карти навігації або гілку в сайдбарі (крапка є, але
//      її ніде не видно);
//    • прибрати гілку підпису (крапка каже «змінено дату, час або кабінет»
//      про запис, якого не існує);
//    • перевести якір на рядок графіка (позначка переживає сутність — 0150).
//
//  ⚠️ Правлю БОЙОВІ файли (міграцію, lib, екрани) → try/finally.
//  ⚠️ Кожен якір перевіряється на УНІКАЛЬНІСТЬ.
//  ⚠️ Базова лінія мусить бути ЗЕЛЕНОЮ.
//  ⚠️ Після накату міграція заштампована `db:gate`: стенд ОБОВʼЯЗКОВО
//     відновлює файл, інакше наступний `db:gate` побачить md5-дрейф.
//
//  Запуск: node scripts/falsify-0184.mjs   Звіт: falsify-0184.md
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { verdictOf, finishStand } from "./lib/falsify-verdict.mjs";

const FILES = {
  mig: "supabase/migrations/0184_rf03b_sched_marker_fanout.sql",
  portal: "components/ReferralPortal.tsx",
  sidebar: "components/ReferrerSidebar.tsx",
  lib: "lib/unreadChanges.ts",
  ackvis: "lib/ackVisibility.ts",
};
const SPECS = ["tests/schedMarkerFanout.test.ts"];
const OUT = "falsify-0184.md";
const REPORT = ".falsify-0184.json";

const MUTATIONS = [
  {
    id: "A1", file: "mig", green: false,
    expect: /підключений до union/,
    what: "CTE віяла оголошено, але прибрано з union (жодного нового отримувача)",
    from: "      union select id from sched_referrers\n",
    to: "",
  },
  {
    id: "A2", file: "mig", green: false,
    expect: /непідтверджений направник/,
    what: "знято `pr.approved` — крапка тому, хто на портал не потрапляє",
    from: "       and pr.approved\n",
    to: "",
  },
  {
    /* Рівно та діра, яку 0183a закрила в ЧИТАННІ, але з боку сповіщень:
       направник із грантом на один кабінет дізнається про зміни в чужих. */
    id: "A3", file: "mig", green: false,
    expect: /фільтр по грантах кабінетів/,
    what: "знято фільтр по грантах кабінетів — віяло на весь центр",
    from: "       and (p_room is null\n            or ra.room_ids is null\n            or p_room = any (ra.room_ids))\n",
    to: "",
  },
  {
    /* Якір ІЗ СУСІДНІМ РЯДКОМ: сам предикат стоїть двічі (staff і rads), і
       короткий якір відхилився б як неунікальний — саме для цього перевірка
       унікальності в стенді й існує. */
    id: "A4", file: "mig", green: false,
    expect: /персонал виключений/,
    what: "персонал повернуто в аудиторію 'schedule' (крапку немає де погасити)",
    from: "       and p.role in ('admin', 'registrar')\n       and p_scope_kind <> 'schedule'\n",
    to: "       and p.role in ('admin', 'registrar')\n",
  },
  {
    id: "A5", file: "mig", green: false,
    expect: /радіолог виключений/,
    what: "радіолога повернуто в аудиторію 'schedule' (знято fail-closed)",
    from: "       and p_room_relevant\n       and p_scope_kind <> 'schedule'\n",
    to: "       and p_room_relevant\n",
  },
  {
    /* 0150/0164/0165: позначка не сміє переживати сутність. Рядок особливого
       графіка ВИДАЛЯЮТЬ — і саме видалення є новиною. */
    id: "A6", file: "mig", green: false,
    expect: /якір — кабінет або клініка/,
    what: "якір переведено на рядок schedule_overrides (позначка переживає сутність)",
    from: "      p_entity_type  => 'room',\n      p_entity_id    => v_room,",
    to: "      p_entity_type  => 'schedule_override',\n      p_entity_id    => v_row.id,",
  },
  {
    /* Найтихіша з усіх: усе працює, крапка приходить — і не гасне до F5.
       Рівно борг поверхні `services`, повторений на новій поверхні. */
    id: "A7", file: "portal", green: false,
    expect: /ключ перезаморозки/,
    what: "третій аргумент ack прибрано — заморозка береться один раз",
    from: "    schedAckKey,\n  );",
    to: "  );",
  },
  {
    id: "A8", file: "sidebar", green: false,
    expect: /питає позначки для пункту/,
    what: "гілку 'new' прибрано з сайдбара — крапка є, показати нема де",
    from: '    : key === "new" ? unreadForNav(unreadIx, "new")\n',
    to: "",
  },
  {
    id: "A9", file: "lib", green: false,
    expect: /веде рівно на schedule/,
    what: "пункт 'new' прибрано з карти SURFACE_BY_NAV",
    from: '  new: ["schedule"],\n',
    to: "",
  },
  {
    /* Крапка почне казати «змінено дату, час або кабінет» — про запис, якого
       не існує: `field_scope='schedule'` уже мав це значення для рядка черги. */
    id: "A10", file: "lib", green: false,
    expect: /підпис про графік/,
    what: "гілку підпису по поверхні прибрано — крапка бреше про неіснуючий запис",
    from: '  if (m.surface_key === "schedule") return scheduleSurfaceText(m);\n',
    to: "",
  },
  {
    /* ⚠️ КЛАС, ЯКОГО СТЕНД НЕ ПРОБУВАВ ДО РЕВʼЮ: усі мутації вище — ВИДАЛЕННЯ.
       Найприродніша реальна правка — не «прибрати предикат», а «щоб іще й такі
       отримували», тобто РОЗШИРИТИ його через OR. Літерал лишається на місці,
       усі піни на присутність зелені, а відкликані гранти повернулись в
       аудиторію. Ловить лише пін на ДОСЛІВНИЙ текст предиката. */
    id: "A11", file: "mig", green: false,
    expect: /збігається ДОСЛІВНО/,
    what: "предикат активності розширено через OR (відкликані гранти повернулись)",
    from: "       and ra.status = 'active'\n",
    to: "       and (ra.status = 'active' or ra.status = 'revoked')\n",
  },
  {
    id: "A12", file: "mig", green: false,
    expect: /збігається ДОСЛІВНО/,
    what: "предикат підтвердження розширено через OR (крапка тому, хто не має портала)",
    from: "       and pr.approved\n",
    to: "       and (pr.approved or pr.role = 'referrer')\n",
  },
  {
    /* ⚠️ САМА ТИХА МУТАЦІЯ ПАКЕТА, і до ревʼю її не ловило НІЩО: ім'я змінної
       на місці, виклик на місці, всі лексичні піни зелені — а перезаморозки
       більше немає, бо ключ перестав залежати від графіка. Позначка, що
       прилетіла при відкритому екрані, не гасне до F5. Ловить лише
       поведінкова перевірка чистої функції. */
    id: "A13", file: "ackvis", green: false,
    expect: /зміна САМОГО ГРАФІКА міняє ключ/,
    what: "з ключа заморозки прибрано сам графік (перезаморозка не відбувається)",
    from: "    JSON.stringify(i.override ?? null),\n",
    to: "",
  },
  {
    /* РЕФАКТОРНИЙ КОНТРОЛЬ: переформатування ключа. Якщо сторож від цього
       червоніє — він пінить ФОРМАТ, а не поведінку, і його приберуть (0141). */
    id: "T1", file: "portal", green: true,
    what: "виклик ключа переформатовано на кілька рядків",
    from: "    () => schedAckKeyOf({ clinicId: centerId, date, roomId, override, loadFailed: slotsErr }),",
    to: "    () =>\n      schedAckKeyOf({\n        clinicId: centerId, date, roomId, override,\n        loadFailed: slotsErr,\n      }),",
  },
  {
    /* РЕФАКТОРНИЙ КОНТРОЛЬ: порядок пунктів меню — не інваріант. */
    id: "T2", file: "sidebar", green: true,
    what: "два пункти меню помінялись місцями (порядок не інваріант)",
    from: '    { key: "mine", label: "Мої направлення", icon: "▦", badge: counts.mine },\n    { key: "waitlist", label: "Лист очікування", icon: "⏳", badge: counts.waitlist },\n',
    to: '    { key: "waitlist", label: "Лист очікування", icon: "⏳", badge: counts.waitlist },\n    { key: "mine", label: "Мої направлення", icon: "▦", badge: counts.mine },\n',
  },
];

/* Кількість адресних мутацій — КОНСТАНТА (урок U-80г). */
const EXPECTED_RED = 13;   // с61: +A11/A12 розширення предиката через OR, +A13 вихолощений ключ заморозки — усі три від ревʼю
const redCount = MUTATIONS.filter((m) => !m.green).length;
if (redCount !== EXPECTED_RED) {
  console.error(`⛔ ІНВЕНТАР БРЕШЕ: адресних мутацій ${redCount}, а очікується ${EXPECTED_RED}. Стенд НЕ прогнано.`);
  process.exit(1);
}

for (const m of MUTATIONS) {
  const bad =
    (!m.green && !m.expect) ? "мутація мусить червоніти, але не називає сторожа (`expect`)"
    : (m.green && m.expect) ? "`expect` у рядку, який МУСИТЬ лишитись зеленим — сторожа тут не буває"
    : (m.expect && /\|/.test(m.expect.source)) ? "у регулярці `|` — вона зламає таблицю звіту"
    : null;
  if (bad) {
    console.error(`⛔ ІНВЕНТАР БРЕШЕ: ${m.id} — ${bad}. Стенд НЕ прогнано.`);
    process.exit(1);
  }
}

const editsOf = (m) => m.edits ?? [{ file: m.file, from: m.from, to: m.to }];

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
  lines.push(`# Стенд фальсифікації пакета 46 — позначка про графік дня (RF-03b)\n`);
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
