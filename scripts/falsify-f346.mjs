// ============================================================
//  Стенд фальсифікації пакета F3 / F4 / F6 (с55, хвости фази 4 аудиту).
//
//  Головне питання те саме, що і в сусідів: чи ЧЕРВОНІЄ саме ТОЙ сторож, заради
//  якого позиція написана. Стенд від народження адресний — кожна червона
//  позиція називає ІМʼЯ тесту (`expect`), і підсумок друкує чесне «N/M».
//
//  ⚠️ Правлю БОЙОВІ файли → try/finally + обробники сигналів.
//  ⚠️ Кожен якір перевіряється на УНІКАЛЬНІСТЬ (у СИРОМУ джерелі, з
//     коментарями: коментарі тут теж згадують `pinnedKey`, тож якорем беремо
//     сам виклик, а не імʼя поля).
//  ⚠️ Базова лінія мусить бути ЗЕЛЕНОЮ.
//
//  Запуск: node scripts/falsify-f346.mjs      Звіт: falsify-f346.md (gitignore)
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { verdictOf } from "./lib/falsify-verdict.mjs";

const FILES = {
  fu: "lib/useFollowToday.ts",
  sc: "lib/serverClock.ts",
  sync: "components/ServerClockSync.tsx",
  qb: "components/QueueBoard.tsx",
  rb: "components/RadiologistBoard.tsx",
  rp: "components/ReferralPortal.tsx",
};
const FT = "tests/followToday.test.ts";
const SC = "tests/serverClock.test.ts";
const CT = "tests/clockTrust.test.ts";
const SPECS = [FT, SC, CT];
const OUT = "falsify-f346.md";
const REPORT = ".falsify-f346.json";

/* ⚠️ Число прибите ТУТ, а не рахується з таблиці: інакше «0/0 адресних» було б
   зеленим підсумком порожнечі — рівно та вада, проти якої писався U-80б. */
const EXPECTED_ADDRESSED = 32;

const MUTATIONS = [
  // ---------- F3: пін дошок повертають назад ----------
  {
    id: "M1", file: "qb", spec: FT, expect: /QueueBoard.*дошка черги слідує за/,
    what: "F3: `pinnedKey: initialDate` повернувся у правило дошки черги",
    from: "  useFollowToday({ clinicTz, busy: anyModalOpen, value: selectedDate, setDate: setSelectedDate,",
    to: "  useFollowToday({ clinicTz, pinnedKey: initialDate, busy: anyModalOpen, value: selectedDate, setDate: setSelectedDate,",
  },
  {
    id: "M2", file: "qb", spec: CT, expect: /дошка черги будує заявку ТИМИ САМИМИ аргументами/,
    what: "F3: заявка Г1-F дошки знову пінується дип-лінком — гард мовчить на «сьогодні»",
    from: "  const boardClock = () => clockClaimOf({ clinicTz, curKey: dateKey(selectedDate) });",
    to: "  const boardClock = () => clockClaimOf({ clinicTz, curKey: dateKey(selectedDate), pinnedKey: initialDate });",
  },
  {
    id: "M3", file: "rb", spec: FT, expect: /RadiologistBoard.*дошка радіолога — те саме правило/,
    what: "F3: `pinnedKey` повернувся на дошку радіолога",
    from: "  useFollowToday({\n    clinicTz,\n    busy: !!completeFor",
    to: "  useFollowToday({\n    clinicTz,\n    pinnedKey: initialDate,\n    busy: !!completeFor",
  },
  {
    /* ⚠️ ЗНАХІДКА СТЕНДА (перший прогін с55). `expect` спершу вказував на
       «на ЧУЖІЙ даті пін не додає нічого» — і мутація лишала той тест ЗЕЛЕНИМ:
       усі його випадки про чужу дату, де перша умова спрацьовує раніше.
       Червонів сусідній СТАРИЙ тест. Виправлено НЕ переписуванням очікування, а
       дописуванням відсутньої половини властивості у сам блок F3. */
    id: "M4", file: "fu", spec: FT, expect: /пін, який НЕ дорівнює значенню, не глушить нічого/,
    what: "F3: пін почав глушити правило на БУДЬ-ЯКІЙ даті, а не лише на дефолті",
    from: "  if (pinnedKey && curKey === pinnedKey) return false;",
    to: "  if (pinnedKey) return false;",
  },
  {
    id: "M5", file: "fu", spec: FT, expect: /на дефолті пін — ЄДИНЕ, що міняє відповідь/,
    what: "F3: другу умову предиката знято — форми втратили захист збереженої дати",
    from: "  if (pinnedKey && curKey === pinnedKey) return false;\n  return true;",
    to: "  return true;",
  },
  // ---------- F4: перемикання центру ----------
  {
    id: "M6", file: "fu", spec: FT, expect: /центр із добою ПОЗАДУ/,
    what: "F4 повернена: дату тягнемо лише коли вона вже СТРОГО минула",
    from: "  if (!wasDefault && value >= nextToday) return value;",
    to: "  if (value >= nextToday) return value;",
  },
  {
    id: "M7", file: "fu", spec: FT, expect: /центр із добою ПОЗАДУ/,
    what: "F4: питання «це дефолт?» задається БЕЗ зсуву форми — відповідь завжди «ні»",
    from: "  const wasDefault = derivedFromToday({ todayDay: prevToday, curKey: dateKeyOf(value), offsetDays });",
    to: "  const wasDefault = derivedFromToday({ todayDay: prevToday, curKey: dateKeyOf(value), offsetDays: 0 });",
  },
  {
    id: "M8", file: "fu", spec: FT, expect: /доба нового центру та сама/,
    what: "F4: втрачено збереження посилання — зайвий рендер і новий знімок значення",
    from: "  return dateKeyOf(def) === dateKeyOf(value) ? value : def;",
    to: "  return def;",
  },
  {
    id: "M9", file: "rp", spec: FT, expect: /портал направника кличе правило тими самими добами/,
    what: "F4: у правило поїхала доба НОВОГО центру як «попередня» — дефолт не розпізнається ніколи",
    from: "      value: cur, prevToday: wallToday0(prevTz), nextToday: wallToday0(selTz), offsetDays: 1,",
    to: "      value: cur, prevToday: wallToday0(selTz), nextToday: wallToday0(selTz), offsetDays: 1,",
  },
  {
    id: "M10", file: "rp", spec: FT, expect: /портал направника кличе правило тими самими добами/,
    what: "F4: прапорець попередньої зони не оновлюється — друге перемикання судить по протухлій зоні",
    from: "    const prevTz = prevTzRef.current;\n    prevTzRef.current = selTz;",
    to: "    const prevTz = prevTzRef.current;",
  },
  // ---------- F6: вартовий сирого годинника ----------
  {
    id: "M11", file: "sc", spec: SC, expect: /годинник крокнув УПЕРЕД на добу/,
    what: "F6: поріг вартового задертий — крок годинника не помічається ніколи",
    from: "  return Math.abs((wall - prevWall) - (mono - prevMono)) > CLOCK_STEP_MIN_MS;",
    to: "  return Math.abs((wall - prevWall) - (mono - prevMono)) > Number.MAX_SAFE_INTEGER;",
  },
  {
    id: "M12", file: "sc", spec: SC, expect: /ПЕРШЕ спостереження порівнювати нема з чим/,
    what: "F6: перше спостереження оголошено стрибком — проба на кожному монтуванні",
    from: "  if (!Number.isFinite(prevWall) || !Number.isFinite(prevMono)) return false;",
    to: "  if (!Number.isFinite(prevWall) || !Number.isFinite(prevMono)) return true;",
  },
  {
    id: "M13", file: "sc", spec: SC, expect: /НЕ роблять вартового ГЛУХИМ/,
    what: "F6: знято гард на нефінітний вхід — NaN осідає в парі, вартовий глухне назавжди",
    from: "  if (!Number.isFinite(wall) || !Number.isFinite(mono)) return false;\n  const prevWall",
    to: "  const prevWall",
  },
  {
    id: "M14", file: "sc", spec: SC, expect: /годинник крокнув НАЗАД/,
    what: "F6: розбіжність рахується без модуля — крок НАЗАД («ПК спішив») не ловиться",
    from: "  return Math.abs((wall - prevWall) - (mono - prevMono)) > CLOCK_STEP_MIN_MS;",
    to: "  return ((wall - prevWall) - (mono - prevMono)) > CLOCK_STEP_MIN_MS;",
  },
  {
    id: "M15", file: "sc", spec: SC, expect: /вартовий НЕ крутить епоху/,
    what: "F6: вартовий сам крутить епоху — доба поїде і після звичайного сну ноутбука",
    from: "  return Math.abs((wall - prevWall) - (mono - prevMono)) > CLOCK_STEP_MIN_MS;",
    to: "  const stepped = Math.abs((wall - prevWall) - (mono - prevMono)) > CLOCK_STEP_MIN_MS;\n  if (stepped) _epoch++;\n  return stepped;",
  },
  {
    id: "M16", file: "sc", spec: SC, expect: /resetServerClock скидає і пару вартового/,
    what: "F6: скидання не чистить пару вартового — сусідній тест ловить вигаданий стрибок",
    from: "  _epoch = 0;\n  _watchWall = Number.NEGATIVE_INFINITY;\n  _watchMono = Number.NEGATIVE_INFINITY;",
    to: "  _epoch = 0;",
  },
  {
    id: "M17", file: "sync", spec: SC, expect: /ВЕДЕ до свіжої проби/,
    what: "F6: вартовий викликається, але його вислід нікуди не веде — декорація",
    from: "      markClockStale();\n      void sync();",
    to: "      markClockStale();\n      void 0;",
  },
  {
    id: "M18", file: "sync", spec: SC, expect: /живе на ОКРЕМОМУ інтервалі/,
    what: "F6: інтервал вартового не прибирається — таймер переживе розмонтування",
    from: "      clearInterval(w);\n",
    to: "",
  },
  {
    id: "M19", file: "sync", spec: SC, expect: /відліки знімаються ПАРОЮ/,
    what: "F6: обидва відліки з одного годинника — розбіжності не буде ніколи",
    from: "observeWallStep(Date.now(), performance.now())",
    to: "observeWallStep(Date.now(), Date.now())",
  },
  {
    id: "M20", file: "sync", spec: SC, expect: /живе на ОКРЕМОМУ інтервалі/,
    what: "F6: крок вартового зрівняли з перезаміром — вартовий нічого не пришвидшує",
    from: "    }, WATCH_MS);",
    to: "    }, RESYNC_MS);",
  },
  // ---------- ДРУГИЙ ПРОХІД: позиції на знахідки двох раундів ревʼю ----------
  {
    /* ⚠️ Ця позиція БУЛА зеленою (`G1`, перестановка двох присвоєнь) — і ревʼю Б
       показало, що вона зелена ЗА ПОБУДОВОЮ: жоден із трьох спеків не читає
       `lib/serverClock.ts` як ДЖЕРЕЛО, тож перестановка не могла почервоніти
       навіть теоретично. Позиція, яка не здатна впасти, займає рядок і читається
       як доказ. Замінено на справжню ваду того ж місця. */
    id: "M21", file: "sc", spec: SC, expect: /годинник крокнув УПЕРЕД на добу/,
    what: "F6: пару знімають ПІСЛЯ запису — різниця тотожно нуль, вартовий сліпий назавжди",
    from: "  const prevWall = _watchWall, prevMono = _watchMono;\n  _watchWall = wall;\n  _watchMono = mono;",
    to: "  _watchWall = wall;\n  _watchMono = mono;\n  const prevWall = _watchWall, prevMono = _watchMono;",
  },
  {
    id: "M22", file: "sync", spec: SC, expect: /ПРОТУХЛЮЄ чинну оцінку перед пробою/,
    what: "F6: вартовий не протухлює чинну оцінку — його пробу відкинуть як «гіршу за свіжу»",
    from: "      markClockStale();\n      void sync();",
    to: "      void sync();",
  },
  {
    id: "M23", file: "sc", spec: SC, expect: /markClockStale змушує ПРИЙНЯТИ свіжу пробу/,
    what: "F6: протухлення заразом СКИДАЄ зсув — показ повертається на годинник ПК",
    from: "export function markClockStale(): void {\n  _measuredAtMono = Number.NEGATIVE_INFINITY;",
    to: "export function markClockStale(): void {\n  _offsetMs = 0;\n  _measuredAtMono = Number.NEGATIVE_INFINITY;",
  },
  {
    id: "M24", file: "sc", spec: SC, expect: /markClockStale змушує ПРИЙНЯТИ свіжу пробу/,
    what: "F6: протухлення нічого не робить — вартовий знову декорація",
    from: "  _measuredAtMono = Number.NEGATIVE_INFINITY;\n  _measuredAtWall = Number.NEGATIVE_INFINITY;\n}",
    to: "}",
  },
  {
    id: "M25", file: "sync", spec: SC, expect: /крок вартового МЕНШИЙ за перезамір/,
    what: "F6: крок вартового задерли до перезаміру — він нічого не пришвидшує",
    from: "const WATCH_MS = 10 * 1000;",
    to: "const WATCH_MS = 10 * 60 * 1000;",
  },
  {
    id: "M26", file: "sync", spec: SC, expect: /крок вартового МЕНШИЙ за перезамір/,
    what: "F6: нижню межу між пробами вартового знято — сотні RPC на годину на вкладку",
    from: "const WATCH_MIN_GAP_MS = 60 * 1000;",
    to: "const WATCH_MIN_GAP_MS = 0;",
  },
  {
    id: "M27", file: "sc", spec: SC, expect: /сама ВЕЛИЧИНА порога закріплена зверху/,
    what: "F6: поріг вартового мовчки розширено до години — типова корекція NTP невидима",
    from: "export const CLOCK_STEP_MIN_MS = 2000;",
    to: "export const CLOCK_STEP_MIN_MS = 3_500_000;",
  },
  {
    id: "M28", file: "rp", spec: FT, expect: /портал направника кличе правило тими самими добами/,
    what: "F4: ефект більше не будиться зміною зони — F4 повертається цілком",
    from: "    setCenterShift((s) => dayShiftNoticeOf(s, cur, next));\n  }, [selTz]);",
    to: "    setCenterShift((s) => dayShiftNoticeOf(s, cur, next));\n  }, []);",
  },
  {
    id: "M29", file: "rp", spec: FT, expect: /портал направника кличе правило тими самими добами/,
    what: "F4: зміна центру рухає добу, не скидаючи обраний час",
    from: "    setBookDate(next);\n    setTime(\"\");\n    setCenterShift(",
    to: "    setBookDate(next);\n    setCenterShift(",
  },
  {
    id: "M30", file: "rp", spec: FT, expect: /портал направника кличе правило тими самими добами/,
    what: "F4: банер про перенесення від зміни центру знято — доба їде мовчки",
    from: "{centerShift && centerShiftSay !== \"none\" && (",
    to: "{false && centerShiftSay !== \"none\" && (",
  },
  {
    id: "M31", file: "rp", spec: FT, expect: /портал направника кличе правило тими самими добами/,
    what: "F4: банер зміни центру не гасне, коли дату взяла ЛЮДИНА",
    from: "setDateShifted(null); setCenterShift(null); }}",
    to: "setDateShifted(null); }}",
  },
  {
    id: "M32", file: "rb", spec: FT, expect: /RadiologistBoard.*дошка радіолога — те саме правило/,
    what: "U-70/F3: у виклик дошки радіолога вставлено зсув — дошка на сьогодні дефолтом не вважається НІКОЛИ",
    from: "  useFollowToday({\n    clinicTz,\n    busy: !!completeFor",
    to: "  useFollowToday({\n    clinicTz,\n    offsetDays: 1,\n    busy: !!completeFor",
  },
  // ---------- ЗЕЛЕНІ: чесний рефактор мусить лишитись зеленим ----------
  {
    id: "G2", file: "fu", green: true,
    what: "`def` обчислюється до раннього виходу — вислід той самий",
    from: "  if (!wasDefault && value >= nextToday) return value;\n  const def = shiftDays(nextToday, offsetDays);",
    to: "  const def = shiftDays(nextToday, offsetDays);\n  if (!wasDefault && value >= nextToday) return value;",
  },
  {
    /* ⚠️ ЗЕЛЕНА НАВМИСНО, і це ВИМІР, а не пропуск: гілка «перше спостереження»
       сьогодні надлишкова — без неї −Infinity дає NaN, а `NaN > поріг` теж
       `false`. Позиція існує, щоб ця надлишковість була ЗАПИСАНА, а не
       виявлена колись мутацією, яку хтось прийме за дірку. Червоний бік тієї
       самої гілки тримає M12. */
    id: "G3", file: "sc", green: true,
    what: "гілку «перше спостереження» знято — поведінка тримається на NaN, тобто випадково",
    from: "  if (!Number.isFinite(prevWall) || !Number.isFinite(prevMono)) return false;\n",
    to: "",
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

/* Прогін, який НЕ ВІДБУВСЯ, не сміє рахуватись за «сторож спіймав» (канон Ф4-2).
   `fullName`, а не `title` (урок U-80б): у `describe.each` заголовки збігаються,
   і по самому `title` адресну мутацію не відрізнити від сусідньої. */
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
  lines.push(`# Стенд фальсифікації F3 / F4 / F6 (с55)\n`);
  lines.push(`**БАЗОВА ЛІНІЯ:** ${base.ok ? "ЗЕЛЕНА" : "ЧЕРВОНА"} (${base.total} тестів у ${SPECS.length} спеках)\n`);
  if (!base.ok) {
    lines.push(`\n⛔ Базова лінія червона — стенд НІЧОГО не доводить. Червоні: ${base.red.join(", ")}\n`);
  } else {
    lines.push(`\n| # | мутація | очікування | спек-сторож | факт | вердикт |`);
    lines.push(`|---|---|---|---|---|---|`);
    for (const m of MUTATIONS) {
      const path = FILES[m.file];
      const src = readFileSync(path, "utf8");
      const edits = m.edits ?? [{ from: m.from, to: m.to }];
      let mutated = src, bad = "";
      for (const e of edits) {
        const n = mutated.split(e.from).length - 1;
        if (n !== 1) { bad = `ЯКІР НЕ УНІКАЛЬНИЙ (${n}): ${e.from.slice(0, 46)}…`; break; }
        mutated = mutated.replace(e.from, () => e.to);
      }
      if (bad) { lines.push(`| ${m.id} | ${m.what} | — | — | ${bad} | ⛔ відхилено |`); continue; }
      writeFileSync(path, mutated);
      const res = run();
      writeFileSync(path, src);
      const wantRed = !m.green;
      if (res.crashed) {
        lines.push(`| ${m.id} | ${m.what} | ${wantRed ? "ЧЕРВОНЕ" : "ЗЕЛЕНЕ"} | ${m.spec || "—"} | прогін не відбувся | ⛔ мутація зламала збірку |`);
        continue;
      }
      const gotRed = !res.ok;
      const inNamed = m.spec ? (res.redBySpec[m.spec] || []) : [];
      const heldByNamed = !wantRed || inNamed.length > 0;
      /* АДРЕСНІСТЬ: мутація з `expect` мусить почервонити ІМЕННО названий тест.
         Окремо розрізняємо «такого імені в дереві немає» — це дефект СТЕНДА
         (інвентар бреше), а не продукту. */
      const missedName = wantRed && gotRed && m.expect && !res.red.some((t) => m.expect.test(t));
      const noSuchGuard = missedName && !base.all.some((t) => m.expect.test(t));
      const verdict = noSuchGuard
        ? "⛔ СТОРОЖА З ТАКИМ ІМЕНЕМ НЕМАЄ (дефект стенда)"
        : missedName
          ? "⛔ ЧУЖИЙ спек"
          : wantRed !== gotRed
            ? "⛔ СТОРОЖ НЕ ТРИМАЄ"
            : (heldByNamed ? "✅" : "⚠️ спіймав ЧУЖИЙ спек, не названий сторож");
      if (verdict === "✅" && wantRed && m.expect) addressedOk++;
      const others = res.red.length - inNamed.length;
      const fact = gotRed
        ? (inNamed.map((t) => `«${t}»`).join("; ") || "—") + (others > 0 ? ` (+${others} в інших спеках)` : "")
        : "усе зелене";
      lines.push(`| ${m.id} | ${m.what} | ${wantRed ? "ЧЕРВОНЕ" : "ЗЕЛЕНЕ"} | ${m.spec ? m.spec.replace("tests/", "") : "—"} | ${fact} | ${verdict} |`);
    }
  }
} finally {
  restore();
  if (existsSync(REPORT)) unlinkSync(REPORT);
  const verdict = verdictOf(lines, MUTATIONS.length);
  const declared = MUTATIONS.filter((m) => m.expect && !m.green).length;
  const inventoryLies = declared !== EXPECTED_ADDRESSED;
  const addressedBad = addressedOk !== EXPECTED_ADDRESSED;
  lines.push(`\n## ПІДСУМОК: ${addressedOk}/${EXPECTED_ADDRESSED} адресних (названий сторож), `
    + `${MUTATIONS.filter((m) => !m.green && !m.expect).length} — лише за спек-файлом`);
  if (inventoryLies) {
    lines.push(`\n⛔ ІНВЕНТАР БРЕШЕ: мутацій із \`expect\` ${declared}, а заявлено ${EXPECTED_ADDRESSED}.`);
  }
  lines.push(`\n${verdict.summary}`);
  if (!verdict.ok || addressedBad || inventoryLies) {
    lines.push(`\n**ВЕРДИКТ: ⛔ СТЕНД ЧЕРВОНИЙ**${addressedBad && verdict.ok ? " — адресних менше, ніж заявлено" : ""}`);
  }
  writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  console.log(lines.join("\n"));
  console.log(`\nЗвіт: ${OUT}. Файли відновлено.`);
  if (!verdict.ok || addressedBad || inventoryLies) process.exitCode = 1;
}
