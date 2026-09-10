// ============================================================
//  Стенд фальсифікації вердиктів харнеса конкурентності (с62).
//
//  Головне питання: чи почервоніє сторож, якщо ВИМКНУТИ гарант мовчки.
//
//  ⚠️ ЧОМУ ЦЕЙ СТЕНД ЗʼЯВИВСЯ ТІЛЬКИ ЗАРАЗ — і чому це діра, а не педантизм.
//  `race-check-lib.mjs` живе з с32, `tests/raceCheck.test.ts` — з с38, а
//  стенда на них не було ЖОДНОГО. При тому шапка самого спека каже: «вердикт —
//  єдине, що відрізняє доказ від збігу». Тобто найдорожчий файл харнеса не мав
//  перевірки на те, що його власні тести хоч щось тримають.
//
//  ⚠️ ОСОБЛИВІСТЬ СЦЕНАРІЮ `waitlist`, заради якого стенд і написаний:
//  його гарант — не тригер і не індекс, а УМОВНИЙ UPDATE у тілі
//  `schedule_from_waitlist_rpc`. 23P01 і 23505 породжує двигун; 55000 тут
//  піднято РУКАМИ після `row_count = 0`. Отже гарант можна зняти, не отримавши
//  ЖОДНОЇ помилки БД — лише двох переможців. Мутація M2 — рівно це.
//
//  ⚠️ НАЗВАНА МЕЖА ЦЬОГО СТЕНДА (знахідка ревʼю Б, с62): він мутує ЛИШЕ
//  `race-check-lib.mjs`. Половина харнеса — CLI `race-check.mjs` — не покрита
//  ні цим стендом, ні vitest: рішення «вердикт → код виходу», гейт контролю,
//  форма `Promise.all`, дочитування звʼязку. Мутація `code = 0` там лишиться
//  зеленою скрізь. Частину діри закриває гейт `windowsOverlap` у самому
//  вердикті (M11): переписаний на послідовний `for … await` клієнт більше не
//  дає PASS. Решта — відкритий борг, і краще назвати його тут, ніж лишити
//  читача з враженням, що стенд покриває харнес цілком.
//
//  ⚠️ Правлю БОЙОВИЙ файл → try/finally + обробники сигналів.
//  ⚠️ Кожен якір перевіряється на УНІКАЛЬНІСТЬ.
//
//  Запуск: node scripts/falsify-race-check.mjs   Звіт: falsify-race-check.md
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { verdictOf, finishStand } from "./lib/falsify-verdict.mjs";

const FILES = {
  lib: "scripts/race-check-lib.mjs",
};
const NEW_SPEC = "tests/raceCheck.test.ts";
const SPECS = [NEW_SPEC];
const OUT = "falsify-race-check.md";
const REPORT = ".falsify-race-check.json";

const MUTATIONS = [
  {
    /* ⚠️ Ця мутація вже спрацювала як треба: у ПЕРШОМУ прогоні вона лишила
       набір ЗЕЛЕНИМ і показала, що тести подавали ту саму константу і на
       вхід, і в очікування. Дефект тестів виправлено (пін констант + літерали
       на вході), і сторож тепер називається саме піном. */
    id: "M1", file: "lib", green: false,
    expect: /55000 WAITLIST_STALE зі schedule_from_waitlist_rpc/,
    what: "сценарій листа чекає SQLSTATE слота (23P01) замість свого 55000",
    from: 'export const WAITLIST_STALE_SQLSTATE = "55000";',
    to: 'export const WAITLIST_STALE_SQLSTATE = "23P01";',
  },
  {
    /* ⚠️ ЦЕ ГОЛОВНА МУТАЦІЯ СТЕНДА. Саме так виглядає знята умова
       `and status = 'waiting'` у RPC: жодної помилки, просто два переможці. */
    id: "M2", file: "lib", green: false,
    expect: /ДВОЄ записали одного кандидата → FAIL/,
    what: "драбинка перестала вважати ДВОХ переможців дефектом",
    /* ⚠️ ЯКІР ШИРШИЙ, НІЖ ХОЧЕТЬСЯ, і це не стиль. `if (wins.length > 1) {`
       у файлі ДВА рази — у спільній драбинці `verdictExclusive` і в
       `verdictCas`; перший прогін стенда це й показав («ЯКІР НЕ УНІКАЛЬНИЙ
       (2)»). Беремо разом із наступним рядком, який у цих двох місцях
       різний. */
    from: "  if (wins.length > 1) {\n    return {\n      verdict: \"FAIL\", spread,\n      reason: `${doubleWin}",
    to: "  if (wins.length > 2) {\n    return {\n      verdict: \"FAIL\", spread,\n      reason: `${doubleWin}",
  },
  {
    id: "M3", file: "lib", green: false,
    expect: /невдаха впав на 42501/,
    what: "«кандидата немає» (42501) зараховано як програш у гонці",
    from: "    sqlstate: WAITLIST_STALE_SQLSTATE,\n    guard: \"CAS-застовплення в schedule_from_waitlist_rpc\",",
    to: "    sqlstate: WAITLIST_NOT_FOUND_SQLSTATE,\n    guard: \"CAS-застовплення в schedule_from_waitlist_rpc\",",
  },
  {
    id: "M4", file: "lib", green: false,
    expect: /не записав ніхто \(23P01 у обох\) → FAIL/,
    what: "нуль переможців більше не FAIL — непридатна фікстура зійде за доказ",
    from: "  if (wins.length === 0) {\n    return {\n      verdict: \"FAIL\", spread,\n      reason: `${noWin}",
    to: "  if (wins.length === -1) {\n    return {\n      verdict: \"FAIL\", spread,\n      reason: `${noWin}",
  },
  {
    /* ⚠️ `expect` НЕСЕ ІМʼЯ DESCRIBE (знахідка ревʼю Б, с62). «розкид 3 с»
       зустрічається в ТРЬОХ тестах файлу, і два з них матчились попередньою
       регуляркою. Оцінка йде через `redInNew.some(...)`, тож мутація
       зараховувалась би ✅, навіть якби тест сценарію листа видалили. */
    id: "M5", file: "lib", green: false,
    expect: /verdictWaitlistRace.*розкид 3 с\) → INCONCLUSIVE/,
    what: "поріг одночасності роздутий у 100 разів — послідовний прогін стане PASS",
    from: "  if (spread > spreadLimitMs) {\n    return {\n      verdict: \"INCONCLUSIVE\", spread,\n      reason: `розкид стартів ${spread} мс > ${spreadLimitMs} мс — одночасність не доведена`,\n    };\n  }\n  return {\n    verdict: \"PASS\", spread,\n    reason: `1 удача з ${outcomes.length}",
    to: "  if (spread > spreadLimitMs * 100) {\n    return {\n      verdict: \"INCONCLUSIVE\", spread,\n      reason: `розкид стартів ${spread} мс > ${spreadLimitMs} мс — одночасність не доведена`,\n    };\n  }\n  return {\n    verdict: \"PASS\", spread,\n    reason: `1 удача з ${outcomes.length}",
  },
  {
    id: "M6", file: "lib", green: false,
    expect: /рядок листа несе modality/,
    what: "фікстура листа втратила modality — прогін упав би на 23514 як «гонка зламалась»",
    from: "    studies: [study],\n    modality,\n    duration_min: FIXTURE_DUR_MIN, buffer_time_min: FIXTURE_BUF_MIN,\n  };\n}",
    to: "    studies: [study],\n    duration_min: FIXTURE_DUR_MIN, buffer_time_min: FIXTURE_BUF_MIN,\n  };\n}",
  },
  {
    id: "M7", file: "lib", green: false,
    expect: /рядок листа НЕ задає status/,
    what: "харнес продублював дефолт БД (status: 'waiting')",
    from: "    studies: [study],\n    modality,",
    to: "    studies: [study],\n    status: \"waiting\",\n    modality,",
  },
  {
    id: "M8", file: "lib", green: false,
    expect: /рядок листа НЕ привʼязує кабінет/,
    what: "кандидату привʼязали кабінет — у сценарій заліз другий гарант",
    from: "    modality,\n    duration_min: FIXTURE_DUR_MIN, buffer_time_min: FIXTURE_BUF_MIN,\n  };\n}",
    to: "    modality,\n    room_id: null,\n    duration_min: FIXTURE_DUR_MIN, buffer_time_min: FIXTURE_BUF_MIN,\n  };\n}",
  },
  {
    /* ⚠️ ЯКІР ПЕРЕПИСАНО (с62). Він починався з `studies: [study],` і став
       НЕУНІКАЛЬНИМ, щойно поруч зʼявився `buildCaseStep` із таким самим
       хвостом. Стенд це й показав — «ЯКІР НЕ УНІКАЛЬНИЙ (2)». Тепер якір
       починається з рядка, який є ЛИШЕ в `buildWaitlistBooking`. */
    id: "M9", file: "lib", green: false,
    expect: /p_booking несе всі NOT NULL-поля/,
    what: "з p_booking зникла duration_min — вставка впала б на NOT NULL",
    from: "    patient_phone: FIXTURE_PHONE,\n    studies: [study],\n    duration_min: FIXTURE_DUR_MIN,\n    buffer_time_min: FIXTURE_BUF_MIN,\n    scheduled_date: day,",
    to: "    patient_phone: FIXTURE_PHONE,\n    studies: [study],\n    buffer_time_min: FIXTURE_BUF_MIN,\n    scheduled_date: day,",
  },
  {
    /* `scheduled_time` у БД — text-колонка без касту, тож зайві секунди
       доїхали б у рядок як є і зламали б формат мовчки. */
    id: "M10", file: "lib", green: false,
    expect: /p_booking несе всі NOT NULL-поля/,
    what: "у scheduled_time додано секунди — text-колонка проковтне й зіпсує формат",
    from: "    buffer_time_min: FIXTURE_BUF_MIN,\n    scheduled_date: day,\n    scheduled_time: time,\n  };\n}\n\n/** Рядок КЕЙСА",
    to: "    buffer_time_min: FIXTURE_BUF_MIN,\n    scheduled_date: day,\n    scheduled_time: `${time}:00`,\n  };\n}\n\n/** Рядок КЕЙСА",
  },
  {
    /* Гейт перетину вікон — єдиний свідок того, що КОРИСТУВАЦЬКИЙ клієнт
       стріляв паралельно. Знявши його, послідовний прогін дав би PASS. */
    id: "M11", file: "lib", green: false,
    expect: /вікна НЕ перетнулись → INCONCLUSIVE/,
    what: "знято гейт перетину вікон у сценарії листа",
    from: '  if (base.verdict === "PASS" && !windowsOverlap(outcomes)) {',
    to: '  if (false && base.verdict === "PASS" && !windowsOverlap(outcomes)) {',
  },
  {
    /* Гейт мусить стояти ПІСЛЯ драбинки, а не замість неї: подвійний запис —
       доведений дефект і лишається FAIL навіть без перетину вікон. */
    id: "M12", file: "lib", green: false,
    expect: /ДВОЄ переможців без перетину вікон — усе одно FAIL/,
    what: "гейт перетину вікон переїхав поперед перевірки на подвійного переможця",
    from: '  if (base.verdict === "PASS" && !windowsOverlap(outcomes)) {',
    to: '  if (!windowsOverlap(outcomes)) {',
  },
  {
    /* ⚠️ ГОЛОВНА МУТАЦІЯ СЦЕНАРІЮ «КЕЙС». Заборонений стан — кейс `cancelled`
       з живим кроком — це ЄДИНЕ, заради чого сценарій існує. Знявши гілку,
       отримуємо PASS на стані, який у проді означає скасований кейс із
       пацієнтом, що досі стоїть у сітці кабінету. */
    id: "M13", file: "lib", green: false,
    expect: /кейс cancelled із АКТИВНИМ кроком → FAIL/,
    what: "вердикт кейса перестав вважати «cancelled + активний крок» дефектом",
    from: '  if (final.caseStatus === "cancelled" && active.length) {',
    to: '  if (false && final.caseStatus === "cancelled" && active.length) {',
  },
  {
    /* Список активних статусів — дзеркало ТРЬОХ місць у БД. Викинувши один,
       робимо вердикт мʼякшим за базу: крок у цьому статусі БД вважає живим,
       а харнес — уже ні. */
    id: "M14", file: "lib", green: false,
    expect: /активні статуси кроку — рівно ті чотири/,
    what: "зі списку активних статусів кроку зник needs_reschedule",
    from: 'export const CASE_ACTIVE_STATUSES = ["scheduled", "waiting", "in_progress", "needs_reschedule"];',
    to: 'export const CASE_ACTIVE_STATUSES = ["scheduled", "waiting", "in_progress"];',
  },
  {
    /* Другий бік того самого дефекту: крок, доданий пострілом, лишився живим,
       але статус кейса до `cancelled` не дійшов — за id це ще ловиться. */
    id: "M15", file: "lib", green: false,
    expect: /доданий крок лишився активним при кейсі open → FAIL за id/,
    what: "перевірка «доданий крок зметено» знята",
    from: "    if (mine && CASE_ACTIVE_STATUSES.includes(mine.status)) {",
    to: "    if (false && mine && CASE_ACTIVE_STATUSES.includes(mine.status)) {",
  },
  {
    /* Відмова кроку ЧУЖИМ кодом означає, що перевіряли не те, що обіцяли:
       23505 — «кабінет уже в кейсі», тобто зламана постановка, а не гонка. */
    id: "M16", file: "lib", green: false,
    expect: /крок відмовлено ЧУЖИМ кодом \(23505\) → FAIL/,
    what: "будь-яка відмова кроку зараховується як «через скасування»",
    from: "  } else if (add.sqlstate !== CASE_NOT_OPEN_SQLSTATE) {",
    to: "  } else if (false && add.sqlstate !== CASE_NOT_OPEN_SQLSTATE) {",
  },
  /* ⚠️ РЕФАКТОРНІ КОНТРОЛІ. Без них «усе червоніє» неможливо відрізнити від
     «сторож надчутливий»: спек, який червоніє на будь-яку правку, не сторож,
     а сигналізація на вітер. */
  {
    id: "T1", file: "lib", green: true,
    what: "переставлено порядок полів у p_booking (семантика та сама)",
    from: "    scheduled_date: day,\n    scheduled_time: time,\n  };\n}\n\n/** Рядок КЕЙСА",
    to: "    scheduled_time: time,\n    scheduled_date: day,\n  };\n}\n\n/** Рядок КЕЙСА",
  },
  {
    id: "T2", file: "lib", green: true,
    what: "змінено суфікс імені пацієнта в p_booking (тексту спек не пінить)",
    from: 'patient_name: `${FIXTURE_NAME} лист-запис`,',
    to: 'patient_name: `${FIXTURE_NAME} запис-з-листа`,',
  },
];

/* ⚠️ Кожна мутація, яка МУСИТЬ почервоніти, називає ТЕСТ-СТОРОЖА. Без цього
   вердикт спирався б на «набір червоний», байдуже який тест — а в цьому спеку
   38 тестів про пʼять різних сценаріїв, і зачепити сусіда тут дуже легко. */
for (const m of MUTATIONS) {
  const bad =
    (!m.green && !m.expect) ? "мутація мусить червоніти, але не називає сторожа (`expect`)"
    : (m.green && m.expect) ? "`expect` у рядку, який МУСИТЬ лишитись зеленим — сторожа тут не буває"
    /* Вертикальна риска зламала б markdown-таблицю, а її розбирає `verdictOf`. */
    : (m.expect && /\|/.test(m.expect.source)) ? "у регулярці `|` — вона зламає таблицю звіту"
    : null;
  if (bad) {
    console.error(`⛔ ІНВЕНТАР БРЕШЕ: ${m.id} — ${bad}. Стенд НЕ прогнано.`);
    process.exit(1);
  }
}

/* ⚠️ ПІН НА КІЛЬКІСТЬ АДРЕСНИХ ПОЗИЦІЙ. Правило вище ВИМАГАЄ прибрати `expect`
   у рядка з `green: true` — а отже саме воно й дає найдешевший спосіб погасити
   червону позицію: перевести її в зелені і зняти сторожа. Мутація при цьому
   далі застосовується, набір лишається зеленим, рядок друкує ✅, слідів немає.
   Тому кількість адресних — константа. */
const EXPECTED_RED = 16;   // +M13..M16 (с62): сценарій «кейс»
const redCount = MUTATIONS.filter((m) => !m.green).length;
if (redCount !== EXPECTED_RED) {
  console.error(`⛔ ІНВЕНТАР БРЕШЕ: адресних мутацій ${redCount}, а очікується ${EXPECTED_RED}. `
    + "Якщо позицію знято свідомо — поправте EXPECTED_RED разом із нею. Стенд НЕ прогнано.");
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
  if (!existsSync(REPORT)) return { crashed: true, ok: false, red: [], redInNew: [], all: [] };
  let r;
  try { r = JSON.parse(readFileSync(REPORT, "utf8")); }
  catch { return { crashed: true, ok: false, red: [], redInNew: [], all: [] }; }
  const red = [], redInNew = [], all = [];
  for (const f of r.testResults || []) {
    const isNew = String(f.name || "").replace(/\\/g, "/").endsWith(NEW_SPEC);
    for (const a of f.assertionResults || []) {
      /* Повний перелік імен потрібен, щоб відрізнити «спіймав чужий сторож» від
         «сторожа з таким іменем узагалі немає» (тобто опечатки в стенді). */
      if (isNew) all.push(a.fullName || a.title);
      if (a.status === "passed") continue;
      const n = a.fullName || a.title;
      red.push(n);
      if (isNew) redInNew.push(n);
    }
  }
  return { crashed: false, ok: r.success === true && red.length === 0, red, redInNew, all, total: r.numTotalTests };
}

const lines = [];
let addressedOk = 0;
try {
  const base = run();
  lines.push(`# Стенд фальсифікації вердиктів харнеса конкурентності (с62)\n`);
  lines.push(`**БАЗОВА ЛІНІЯ:** ${base.ok ? "ЗЕЛЕНА" : "ЧЕРВОНА"} (${base.total} тестів)\n`);
  if (!base.ok) {
    lines.push(`\n⛔ Базова лінія червона — стенд НІЧОГО не доводить. Червоні: ${base.red.join(", ")}\n`);
  } else {
    lines.push(`\n| # | мутація | очікування | факт | вердикт |`);
    lines.push(`|---|---|---|---|---|`);
    for (const m of MUTATIONS) {
      const path = FILES[m.file];
      const src = readFileSync(path, "utf8");
      const edits = m.edits ?? [{ from: m.from, to: m.to }];
      let mutated = src, bad = "";
      for (const e of edits) {
        const n = mutated.split(e.from).length - 1;
        if (n !== 1) { bad = `ЯКІР НЕ УНІКАЛЬНИЙ (${n}): ${e.from.slice(0, 40)}…`; break; }
        mutated = mutated.replace(e.from, () => e.to);
      }
      if (bad) { lines.push(`| ${m.id} | ${m.what} | — | ${bad} | ⛔ відхилено |`); continue; }
      writeFileSync(path, mutated);
      const res = run();
      writeFileSync(path, src);
      const wantRed = !m.green;
      if (res.crashed) {
        lines.push(`| ${m.id} | ${m.what} | ${wantRed ? "ЧЕРВОНЕ" : "ЗЕЛЕНЕ"} | прогін не відбувся | ⛔ мутація зламала збірку |`);
        continue;
      }
      const gotRed = !res.ok;
      const fact = gotRed ? res.redInNew.map((t) => `«${t}»`).join("; ") : "усе зелене";
      const missed = wantRed && gotRed && !res.redInNew.some((t) => m.expect.test(t));
      /* Дві РІЗНІ причини одного «не збіглось»: або сторож існує, але спіймав
         його інший тест, або тесту з таким іменем у наборі НЕМАЄ ВЗАГАЛІ —
         це дефект стенда, а не продукту. */
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
