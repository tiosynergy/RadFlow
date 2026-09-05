// ============================================================
//  Стенд фальсифікації пакета Ф4-3 / Ф4-10 / Ф4-11 (портал направника, с50).
//
//  Питання стенда: чи почервоніє САМЕ ТОЙ тест, якщо повернути дефект назад.
//
//  ⚠️ Правлю БОЙОВІ файли → try/finally + обробники сигналів обовʼязкові.
//  ⚠️ Кожен якір перевіряється на УНІКАЛЬНІСТЬ: неунікальний якір робить звіт
//     брехливим (мутація сідає не туди, куди задумано).
//  ⚠️ БАЗОВА ЛІНІЯ обовʼязкова: немутований набір мусить бути ЗЕЛЕНИМ.
//  ⚠️ Половина мутацій — «правка БЕЗ дефекту» (green: true): вона мусить
//     лишитись ЗЕЛЕНОЮ, інакше сторож надто чутливий і червонітиме на
//     форматуванні замість регресії.
//
//  Запуск: node scripts/falsify-f4-portal.mjs
//  Звіт:   falsify-f4-portal.md (корінь, у .gitignore)
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { verdictOf, finishStand } from "./lib/falsify-verdict.mjs";

const FILES = {
  portal: "components/ReferralPortal.tsx",
  lib: "lib/unreadChanges.ts",
};
const SPECS = ["tests/referrerWaitlistSync.test.ts", "tests/unreadChanges.test.ts"];
const OUT = "falsify-f4-portal.md";
const REPORT = ".falsify-f4-portal.json";

const MUTATIONS = [
  {
    id: "M1", file: "portal", green: false,
    expect: /КОЖНА гілка вибірки має власну підписку/,
    what: "прибрано підписку на гілку referrer_id (сам дефект Ф4-3)",
    from: '      { table: "waitlist_entries", filter: "referrer_id=eq." + doctorId, onChange: reloadWaitlist, debounceKey: "wl" },\n',
    to: "",
  },
  {
    id: "M1b", file: "portal", green: false,
    expect: /обидві підписки листа ведуть в один лоадер зі спільним ключем дебаунсу/,
    what: "з підписки листа знято спільний ключ — одна подія дає два перезавантаження",
    from: '{ table: "waitlist_entries", filter: "created_by=eq." + doctorId, onChange: reloadWaitlist, debounceKey: "wl" },',
    to: '{ table: "waitlist_entries", filter: "created_by=eq." + doctorId, onChange: reloadWaitlist },',
  },
  {
    /* Дзеркальний бік контракту: вибірку розширили, підписку — ні. Саме так
       дефект Ф4-3 і зʼявився в 0138, тож сторож мусить ловити НАПРЯМОК, а не
       два конкретні літерали. */
    id: "M1c", file: "portal", green: false,
    expect: /КОЖНА гілка вибірки має власну підписку/,
    what: "у вибірку додано третю гілку без підписки (той шлях, яким Ф4-3 і зʼявився)",
    from: '.or("created_by.eq." + doctorId + ",referrer_id.eq." + doctorId)',
    to: '.or("created_by.eq." + doctorId + ",referrer_id.eq." + doctorId + ",clinic_id.eq." + doctorId)',
  },
  {
    id: "M2", file: "portal", green: false,
    expect: /у КОЖНОЇ гілки refresh спільний debounceKey/,
    what: "з однієї гілки router.refresh() знято спільний ключ (дефект Ф4-11)",
    /* ⚠️ ПЕРЕЯКОРЕНО в с57 (U-65). Підписка на `rooms` була БЕЗ фільтра —
       саме її й закрив фан-аут по центрах направника, тож старий якір
       («{ table: "rooms", onChange: … }») зник, і стенд чесно відхилив
       позицію. Властивість, яку вона стереже, не змінилась. */
    from: '        { table: "rooms", filter: "clinic_id=eq." + c.clinicId, onChange: () => router.refresh(), debounceKey: "rsc", skipInitial: true },',
    to: '        { table: "rooms", filter: "clinic_id=eq." + c.clinicId, onChange: () => router.refresh() },',
  },
  {
    id: "M3", file: "portal", green: false,
    expect: /рідка звірка при живому сокеті увімкнена саме в цьому каналі/,
    what: "прибрано рідку звірку при живому сокеті (третій шар Ф4-3)",
    from: "    pollWhenSubscribedMs: 60_000,\n",
    to: "",
  },
  {
    id: "M4", file: "portal", green: false,
    expect: /ack поверхні waitlist отримує ключ перезаморозки/,
    what: "ack листа повернуто до двох аргументів — без перезаморозки (дефект Ф4-10)",
    from: '  useAckWhenVisible(\n    { kind: "surface", surface: "waitlist" },\n    loaded && !loadErr,\n    surfaceRefreezeKey(list, unreadForSurface(unreadIx, "waitlist")),\n  );',
    to: '  useAckWhenVisible({ kind: "surface", surface: "waitlist" }, loaded && !loadErr);',
  },
  {
    id: "M9", file: "portal", green: false,
    expect: /reloadWaitlist: лічильник поколінь і гейт перед записом стану/,
    what: "знято гейт поколінь у reloadWaitlist — старий відповідь затирає свіжий список (ревʼю р.1)",
    from: "      if (stale()) return;\n      if (error) { setWlErr(true); setWlLoaded(true); return; }",
    to: "      if (error) { setWlErr(true); setWlLoaded(true); return; }",
  },
  {
    id: "M10", file: "portal", green: false,
    /* Без `Waitlist` у назві: «reload:» і «reloadWaitlist:» — різні тести. */
    expect: /\breload: лічильник поколінь і гейт перед записом стану/,
    what: "знято гейт поколінь у reload (список направлень)",
    from: "      if (stale()) return;\n      if (error) { setListErr(true); return; }",
    to: "      if (error) { setListErr(true); return; }",
  },
  {
    id: "M11", file: "lib", green: false,
    expect: /позначка, що ОБІГНАЛА свій рядок, у ключ НЕ входить/,
    what: "критерій «дозрілості» позначки ослаблено до «рядок показаний» (варіант QueueBoard)",
    from: "      return Number.isFinite(born) && born <= shown;",
    to: "      void born; return true;",
  },
  {
    id: "M12", file: "lib", green: false,
    expect: /позначка ОДНІЄЇ транзакції з рядком входить у ключ/,
    what: "критерій зроблено строгим «<» — позначка ОДНІЄЇ транзакції випадає з ключа",
    from: "      return Number.isFinite(born) && born <= shown;",
    to: "      return Number.isFinite(born) && born < shown;",
  },
  {
    id: "M13", file: "portal", green: false,
    expect: /при збої «Лист порожній» не малюється/,
    what: "порожній стан знову малюється поверх збою («Лист порожній» + «Додайте пацієнта»)",
    from: '        loadErr ? null : (\n          <div className="empty">',
    to: '        (\n          <div className="empty">',
  },
  {
    id: "M5", file: "portal", green: false,
    expect: /лоадер листа не піднімає прапорець списку направлень/,
    what: "збій листа знову піднімає прапорець СПИСКУ НАПРАВЛЕНЬ",
    from: "if (error) { setWlErr(true); setWlLoaded(true); return; }",
    to: "if (error) { setListErr(true); setWlErr(true); setWlLoaded(true); return; }",
  },
  {
    id: "M6", file: "portal", green: false,
    expect: /вкладка листа показує власний збій і дає повторити читання/,
    what: "плашку збою на вкладці листа видалено — порожньо знову читається як «нікого немає»",
    from: "      {loadErr && (\n        <div className=\"ctx-hint red\" style={{ display: \"flex\", alignItems: \"center\", gap: 10, flexWrap: \"wrap\" }} role=\"alert\">\n          <span>⚠ Лист очікування не завантажився — показане може бути неповним або застарілим.</span>\n          <button className=\"btn btn-secondary btn-sm\" onClick={onRetry}>↻ Спробувати ще раз</button>\n        </div>\n      )}\n",
    to: "",
  },
  {
    id: "M7", file: "lib", green: false,
    expect: /перестановка того самого складу ключ НЕ змінює/,
    what: "з відбитка списку знято сортування (ложні перезаморозки на перестановці)",
    from: '    .map((r) => JSON.stringify([r.id, r.status ?? "", r.updated_at ?? ""]))\n    .sort()\n',
    to: '    .map((r) => JSON.stringify([r.id, r.status ?? "", r.updated_at ?? ""]))\n',
  },
  {
    id: "M8", file: "lib", green: false,
    expect: /правка, що не чіпає статус, ключ змінює через updated_at/,
    what: "з відбитка знято updated_at (правка без зміни статусу лишається невидимою для ключа)",
    from: 'JSON.stringify([r.id, r.status ?? "", r.updated_at ?? ""])',
    to: 'JSON.stringify([r.id, r.status ?? ""])',
  },
  /* ↓↓↓ ПРАВКИ БЕЗ ДЕФЕКТУ — мусять лишитись ЗЕЛЕНИМИ ↓↓↓ */
  {
    id: "G1", file: "portal", green: true,
    /* ⚠️ ЗЕЛЕНИЙ ЗА ПОБУДОВОЮ (с52): спек читає файл через `codeOf`, який ріже
       коментарі, — цю правку він не бачить і почервоніти на ній не може. Запис
       про намір, а не доказ чутливості; чутливість міряють G2–G6. */
    what: "змінено лише текст коментаря над хуком (зелений за побудовою: codeOf ріже коментарі)",
    from: "  // TD-3: единый realtime-хук.",
    to: "  // TD-3: единый realtime-хук (текст коментаря змінено стендом).",
  },
  {
    id: "G2", file: "portal", green: true,
    what: "виклик ack зібрано в один рядок (сенс не змінено)",
    from: '  useAckWhenVisible(\n    { kind: "surface", surface: "waitlist" },\n    loaded && !loadErr,\n    surfaceRefreezeKey(list, unreadForSurface(unreadIx, "waitlist")),\n  );',
    to: '  useAckWhenVisible({ kind: "surface", surface: "waitlist" }, loaded && !loadErr, surfaceRefreezeKey(list, unreadForSurface(unreadIx, "waitlist")));',
  },
  {
    id: "G3", file: "portal", green: true,
    what: "переформульовано текст плашки збою (пін мусить тримати структуру, не копірайт)",
    from: "<span>⚠ Лист очікування не завантажився — показане може бути неповним або застарілим.</span>",
    to: "<span>⚠ Не вдалося прочитати лист очікування — показане може бути застарілим.</span>",
  },
  {
    id: "G7", file: "lib", green: true,
    what: "перейменовано локальні змінні у критерії дозрілості (поведінка не змінена)",
    from: "      const shown = shownAt.get(m.entity_id);\n      if (shown === undefined || !Number.isFinite(shown)) return false;\n      const born = Date.parse(m.created_at);\n      return Number.isFinite(born) && born <= shown;",
    to: "      const rowAt = shownAt.get(m.entity_id);\n      if (rowAt === undefined || !Number.isFinite(rowAt)) return false;\n      const markerAt = Date.parse(m.created_at);\n      return Number.isFinite(markerAt) && markerAt <= rowAt;",
  },
  {
    id: "G4", file: "portal", green: true,
    what: "підписку rooms розбито на два рядки (пін мусить терпіти переніс)",
    /* ⚠️ Переякорено в с57 разом із M2 — та сама причина (U-65). */
    from: '        { table: "rooms", filter: "clinic_id=eq." + c.clinicId, onChange: () => router.refresh(), debounceKey: "rsc", skipInitial: true },',
    to: '        { table: "rooms", filter: "clinic_id=eq." + c.clinicId, onChange: () => router.refresh(),\n          debounceKey: "rsc", skipInitial: true },',
  },
  {
    id: "G5", file: "lib", green: true,
    what: "перейменовано параметр у фільтрі відбитка (поведінка не змінена)",
    from: "    .filter((r) => r && r.id)",
    to: "    .filter((x) => x && x.id)",
  },
  {
    id: "G6", file: "portal", green: true,
    what: "дві підписки листа переставлені місцями (порядок значення не має)",
    from: '      { table: "waitlist_entries", filter: "created_by=eq." + doctorId, onChange: reloadWaitlist, debounceKey: "wl" },\n      { table: "waitlist_entries", filter: "referrer_id=eq." + doctorId, onChange: reloadWaitlist, debounceKey: "wl" },',
    to: '      { table: "waitlist_entries", filter: "referrer_id=eq." + doctorId, onChange: reloadWaitlist, debounceKey: "wl" },\n      { table: "waitlist_entries", filter: "created_by=eq." + doctorId, onChange: reloadWaitlist, debounceKey: "wl" },',
  },
];

/* ⚠️ U-80б (с52). Кожна мутація, яка МУСИТЬ почервоніти, називає ТЕСТ-СТОРОЖА.
   Досі вердикт спирався на «набір червоний», байдуже який тест: `SPECS` тут —
   `referrerWaitlistSync` (14 тестів) І `unreadChanges` (87 тестів про пʼять
   чужих механізмів). Мутація в `lib/unreadChanges.ts` чіпає купу сусідів. */
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

/* ⚠️ ПІН НА КІЛЬКІСТЬ АДРЕСНИХ ПОЗИЦІЙ (с52, знахідка ревʼю U-80б). Правило
   вище ВИМАГАЄ прибрати `expect` у рядка з `green: true` — а отже саме воно й
   дає найдешевший спосіб погасити червону позицію: перевести її в зелені і
   зняти сторожа. Мутація при цьому далі застосовується, набір лишається
   зеленим, рядок друкує ✅, і слідів не лишається взагалі. */
const EXPECTED_RED = 15;
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

/** Прогін набору. JSON-репортер, а не текст: текстовий вивід несе ANSI. */
function run() {
  if (existsSync(REPORT)) unlinkSync(REPORT);
  spawnSync("npx", ["vitest", "run", ...SPECS, "--reporter=json", `--outputFile.json=${REPORT}`],
    { shell: true, stdio: "ignore" });
  /* ⚠️ U-80 (с51): прогін, який НЕ ВІДБУВСЯ, — окремий стан. До с51 він
     повертав `ok: false`, тобто «сторож спіймав»: мутація, що зламала збірку,
     друкувалась як ✅ (канон уже стояв у Ф4-2 і Ф4-8, сюди не доїхав). */
  if (!existsSync(REPORT)) return { crashed: true, ok: false, red: [] };
  let r;
  try { r = JSON.parse(readFileSync(REPORT, "utf8")); }
  catch { return { crashed: true, ok: false, red: [] }; }
  const red = [], all = [];
  for (const f of r.testResults || []) {
    /* ⚠️ U-80б (с52): `fullName`, а не `title` — назва describe теж частина
       адреси сторожа, і без неї однойменні тести з різних блоків зливаються.
       Повний перелік `all` — щоб відрізнити «спіймав чужий сторож» від
       «сторожа з таким іменем немає взагалі» (опечатка в стенді). */
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
  lines.push(`# Стенд фальсифікації Ф4-3 / Ф4-10 / Ф4-11 (портал направника, с50)\n`);
  lines.push(`**БАЗОВА ЛІНІЯ:** ${base.ok ? "ЗЕЛЕНА" : "ЧЕРВОНА"} (${base.total} тестів)\n`);
  if (!base.ok) {
    lines.push(`\n⛔ Базова лінія червона — стенд НІЧОГО не доводить. Червоні: ${base.red.join(", ")}\n`);
  } else {
    lines.push(`\n| # | мутація | очікування | факт | вердикт |`);
    lines.push(`|---|---|---|---|---|`);
    for (const m of MUTATIONS) {
      const path = FILES[m.file];
      const src = readFileSync(path, "utf8");
      const n = src.split(m.from).length - 1;
      if (n !== 1) {
        lines.push(`| ${m.id} | ${m.what} | — | ЯКІР НЕ УНІКАЛЬНИЙ (${n}) | ⛔ відхилено |`);
        continue;
      }
      writeFileSync(path, src.replace(m.from, () => m.to));
      const res = run();
      writeFileSync(path, src);
      const wantRed = !m.green;
      if (res.crashed) {
        lines.push(`| ${m.id} | ${m.what} | ${wantRed ? "ЧЕРВОНЕ" : "ЗЕЛЕНЕ"} | прогін не відбувся | ⛔ мутація зламала збірку |`);
        continue;
      }
      const gotRed = !res.ok;
      /* Обрізаємо: мутація в `lib/unreadChanges.ts` червонить десятки тестів, і
         повний перелік робить рядок таблиці нечитаним. `some` — по ПОВНОМУ. */
      const fact = gotRed
        ? res.red.slice(0, 3).map((t) => `«${t}»`).join("; ") + (res.red.length > 3 ? ` (+${res.red.length - 3})` : "")
        : "усе зелене";
      /* ⚠️ U-80б: почервоніти мав НАЗВАНИЙ сторож, а не будь-хто. */
      const missed = wantRed && gotRed && !res.red.some((t) => m.expect.test(t));
      /* Дві РІЗНІ причини одного «не збіглось» (с52): чужий сторож — або тесту
         з таким іменем немає взагалі, тобто дефект самого стенда. */
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
  /* U-74: відхилений якір — ЧЕРВОНИЙ вердикт стенда, а не рядок у таблиці.
     Лічильник звіряється з MUTATIONS.length: мутація, що не дала рядка,
     валить прогін так само, як протухлий якір. */
  const verdict = verdictOf(lines, MUTATIONS.length);
  lines.push(`\n${verdict.summary}`);
  /* ⚠️ ЧЕСНЕ ЧИСЛО ДЛЯ РЕВІЗІЇ (с52): `verdictOf` рахує в `passed` будь-який ✅,
     разом із рефакторними рядками, які нічого не сторожать за побудовою. */
  lines.push(`\n## ПІДСУМОК: ${addressedOk}/${EXPECTED_RED} адресних, ${MUTATIONS.length - EXPECTED_RED} рефакторних`);
  writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log(`\nЗвіт: ${OUT}. Файли відновлено.`);
  finishStand({
  ok: !(!verdict.ok),
  red: "\n⛔ ВЕРДИКТ: СТЕНД ЧЕРВОНИЙ — причина в таблиці вище.",
});
}
