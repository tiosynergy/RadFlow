// ============================================================
//  Стенд фальсифікації пакета 54 (с63): графік кабінету оновлюється, поки
//  вікно відкрите.
//
//  Головне питання стенда: чи ловлять сторожі САМЕ ті способи відкотити пакет,
//  кожен з яких лишає код на вигляд робочим —
//    • прибрати виклик хука в ОДНІЙ із трьох модалок (решта оновлюються);
//    • лишити виклик, але зробити його мертвим (`onChange: () => {}`);
//    • прибрати ВЛАСНИЙ ефект первинного читання — підписки позначені
//      `skipInitial`, тож вікно відкриється БЕЗ графіка;
//    • занести прапорець завантаження в лоадер — сітка блиматиме на кожному тику;
//    • прибрати одну звірку покоління — фонова відповідь перетре новий кабінет;
//    • повернути в лоадер `cancel` із замикання (на фоновий виклик не діє);
//    • зняти `skipInitial` — кожне відкриття читає графік двічі;
//    • зняти фільтр підписки — крос-тенантний оракул (U-61);
//    • розвести періоди тика графіка й зайнятості;
//    • дати двом вікнам однаковий `scope` — два канали з однаковою назвою.
//
//  ⚠️ Правлю БОЙОВІ файли (три модалки + хук) → try/finally і відновлення.
//  ⚠️ Кожен якір перевіряється на УНІКАЛЬНІСТЬ.
//  ⚠️ Базова лінія мусить бути ЗЕЛЕНОЮ.
//
//  Запуск: node scripts/falsify-sched-refetch.mjs   Звіт: falsify-sched-refetch.md
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { verdictOf, finishStand } from "./lib/falsify-verdict.mjs";

const FILES = {
  hook: "lib/useScheduleRefetch.ts",
  booking: "components/BookingModal.tsx",
  resched: "components/RescheduleModal.tsx",
  study: "components/StudyEditModal.tsx",
};

/* ⚠️ У переліку спеків не лише «свій». `realtimeSubscriptionSurface` — той
   самий сторож U-61 з іншого боку, і мутація S8 мусить показати, що підписки
   цього хука йому ВИДИМІ. Це не формальність: записані скорочено
   (`{ table, filter, onChange }`), вони були б для нього невидимі, і зняття
   фільтра пройшло б повз нього при зеленому тесті. Знайдено при написанні
   цього стенда — і полагоджено в хуку (`onChange: reload`). */
const SPECS = [
  "tests/schedRefetch.test.ts",
  "tests/realtimeSubscriptionSurface.test.ts",
  "tests/realtimeInitialLoad.test.ts",
  "tests/roomScheduleRead.test.ts",
];
const OUT = "falsify-sched-refetch.md";
const REPORT = ".falsify-sched-refetch.json";
const LOCK = ".falsify-sched-refetch.lock";

const MUTATIONS = [
  {
    id: "S1", file: "resched", green: false,
    expect: /кличе useScheduleRefetch зі СВОЇМ лоадером/,
    what: "виклик хука прибрано з RescheduleModal (решта двох оновлюються)",
    from: '  useScheduleRefetch({ clinicId, dateStr, roomId, scope: "resched", onChange: loadSched });\n',
    to: "",
  },
  {
    /* Той самий сторож, що в S1, але тихіший: виклик на місці, лоадер живий,
       а звʼязок між ними перерізано. */
    id: "S2", file: "study", green: false,
    expect: /кличе useScheduleRefetch зі СВОЇМ лоадером/,
    what: "onChange у StudyEditModal підмінено на no-op",
    from: 'scope: "study", onChange: loadSched });',
    to: 'scope: "study", onChange: () => {} });',
  },
  {
    /* Найдорожча регресія пакета: `skipInitial` робить її МОЖЛИВОЮ, тож
       сторож первинного ефекту — плата за цей прапорець. */
    id: "S3", file: "booking", green: false,
    expect: /ефект первинного читання на місці/,
    what: "ефект первинного читання прибрано з BookingModal (вікно відкриється без графіка)",
    from: "  useEffect(() => { setSchedLoading(true); loadSched(); }, [loadSched]);\n",
    to: "",
  },
  {
    id: "S4", file: "booking", green: false,
    expect: /прапорець завантаження НЕ всередині лоадера/,
    what: "setSchedLoading(true) занесено в лоадер (сітка блимає на кожному тику)",
    from: "    const req = ++schedReqRef.current;\n    try {",
    to: "    const req = ++schedReqRef.current;\n    setSchedLoading(true);\n    try {",
  },
  {
    id: "S5", file: "study", green: false,
    expect: /звірок поколінь рівно стільки/,
    what: "одну звірку покоління прибрано (фонова відповідь перетирає новий стан)",
    from: "          if (req !== schedReqRef.current) return;\n          setOverride((ov.data as unknown as DayOverride) || null);",
    to: "          setOverride((ov.data as unknown as DayOverride) || null);",
  },
  {
    id: "S6", file: "resched", green: false,
    expect: /немає прапорця cancel/,
    what: "у лоадер повернуто `cancel` із замикання (на фоновий виклик він не діє)",
    from: "    const req = ++schedReqRef.current;\n    {",
    to: "    const req = ++schedReqRef.current;\n    let cancel = false;\n    {\n      if (cancel) return;",
  },
  {
    id: "S7", file: "hook", green: false,
    expect: /обидві підписки позначені skipInitial/,
    what: "skipInitial знято з підписки на rooms (кожне відкриття читає графік двічі)",
    from: '{ table: "rooms", filter: "clinic_id=eq." + clinicId, onChange: reload, debounceKey: "sched", skipInitial: true },',
    to: '{ table: "rooms", filter: "clinic_id=eq." + clinicId, onChange: reload, debounceKey: "sched" },',
  },
  {
    /* ⚠️ Ця мутація доводить ДВА твердження одразу: свій пін на `clinic_id` і
       те, що підписки хука ВЗАГАЛІ ВИДИМІ загальному сканеру U-61. Друге
       важливіше: воно про те, що поверхню меряють, а не припускають. */
    id: "S8", file: "hook", green: false,
    expect: /обидві підписки фільтровані по клініці/,
    what: "фільтр знято з підписки на schedule_overrides (крос-тенантний оракул, U-61)",
    from: '{ table: "schedule_overrides", filter: "clinic_id=eq." + clinicId, onChange: reload, debounceKey: "sched", skipInitial: true },',
    to: '{ table: "schedule_overrides", onChange: reload, debounceKey: "sched", skipInitial: true },',
  },
  {
    id: "S9", file: "hook", green: false,
    expect: /тик графіка дорівнює тику зайнятості/,
    what: "період тика графіка розведено з періодом тика зайнятості",
    from: "export const SCHED_POLL_MS = 30_000;",
    to: "export const SCHED_POLL_MS = 60_000;",
  },
  {
    id: "S10", file: "resched", green: false,
    expect: /scope саме той, що заміряний/,
    what: "RescheduleModal отримав scope «booking» — два канали з однаковою назвою",
    from: 'scope: "resched", onChange: loadSched });',
    to: 'scope: "booking", onChange: loadSched });',
  },
  {
    /* РЕФАКТОРНИЙ КОНТРОЛЬ: виклик переформатовано на кілька рядків і ключі
       переставлені. Якщо сторож від цього червоніє — він пінить ФОРМАТ, а не
       поведінку (урок U-55). */
    id: "T1", file: "study", green: true,
    what: "виклик хука переформатовано і ключі переставлені",
    from: '  useScheduleRefetch({ clinicId, dateStr: scheduledDate, roomId: patient.room_id, scope: "study", onChange: loadSched });',
    to: "  useScheduleRefetch({\n"
      + '    scope: "study",\n'
      + "    clinicId,\n"
      + "    dateStr: scheduledDate,\n"
      + "    roomId: patient.room_id,\n"
      + "    onChange: loadSched,\n"
      + "  });",
  },
  {
    /* РЕФАКТОРНИЙ КОНТРОЛЬ: дві підписки помінялись місцями. Порядок у масиві
       не інваріант — його не звіряє ані цей сторож, ані сам хук. */
    id: "T2", file: "hook", green: true,
    what: "дві підписки в хуку помінялись місцями (порядок не інваріант)",
    from: '      { table: "schedule_overrides", filter: "clinic_id=eq." + clinicId, onChange: reload, debounceKey: "sched", skipInitial: true },\n'
      + '      { table: "rooms", filter: "clinic_id=eq." + clinicId, onChange: reload, debounceKey: "sched", skipInitial: true },\n',
    to: '      { table: "rooms", filter: "clinic_id=eq." + clinicId, onChange: reload, debounceKey: "sched", skipInitial: true },\n'
      + '      { table: "schedule_overrides", filter: "clinic_id=eq." + clinicId, onChange: reload, debounceKey: "sched", skipInitial: true },\n',
  },
  {
    /* РЕФАКТОРНИЙ КОНТРОЛЬ: лічильник поколінь перейменовано. Пін на ІМʼЯ
       біндера змушував би переписувати робочий код заради сторожа. */
    id: "T3", file: "booking", green: true,
    what: "лічильник поколінь перейменовано req → gen у BookingModal",
    edits: [
      { file: "booking", from: "const req = ++schedReqRef.current;", to: "const gen = ++schedReqRef.current;" },
      { file: "booking", from: "        if (req !== schedReqRef.current) return;\n        setOverride(", to: "        if (gen !== schedReqRef.current) return;\n        setOverride(" },
      { file: "booking", from: "if (!roomId) { if (req === schedReqRef.current)", to: "if (!roomId) { if (gen === schedReqRef.current)" },
      { file: "booking", from: "      if (req !== schedReqRef.current) return;\n      setRoomSchedule(", to: "      if (gen !== schedReqRef.current) return;\n      setRoomSchedule(" },
      { file: "booking", from: "      if (req === schedReqRef.current) { setOverride(null);", to: "      if (gen === schedReqRef.current) { setOverride(null);" },
      { file: "booking", from: "      if (req === schedReqRef.current) setSchedLoading(false);", to: "      if (gen === schedReqRef.current) setSchedLoading(false);" },
    ],
  },
];

/* Кількість адресних мутацій — КОНСТАНТА (урок U-80г). S1 знятий виклик,
   S2 мертвий onChange, S3 знятий первинний ефект, S4 прапорець у лоадері,
   S5 знята звірка покоління, S6 повернутий cancel, S7 зняте skipInitial,
   S8 знятий фільтр, S9 розведені періоди тика, S10 продубльований scope.
   T1/T2/T3 — рефакторні контролі. */
const EXPECTED_RED = 10;
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

/* ⚠️ ЛОКФАЙЛ (урок с63, стенд race-check). Стенд правит БОЙОВІ файли; якщо
   поруч іде другий прогін або я сам редагую ці файли, `restore()` запише
   ЧУЖИЙ знімок — і мутація мовчки запечеться в код. */
if (existsSync(LOCK)) {
  console.error(`⛔ ${LOCK} існує: стенд уже йде або впав, не відновивши файли. Розберіться вручну.`);
  process.exit(2);
}
writeFileSync(LOCK, String(process.pid));

const orig = {};
for (const [k, p] of Object.entries(FILES)) orig[k] = readFileSync(p, "utf8");
let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  for (const [k, p] of Object.entries(FILES)) writeFileSync(p, orig[k]);
  if (existsSync(LOCK)) unlinkSync(LOCK);
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

const editsOf = (m) => m.edits ?? [{ file: m.file, from: m.from, to: m.to }];

const lines = [];
let addressedOk = 0;
/* ⚠️ ДЕТЕКТОР ДРЕЙФУ (урок с63). Перед кожною мутацією звіряємо файли з тим
   знімком, який `restore()` збирається записати. Розбіжність означає, що
   правки прилетіли ЗЗОВНІ під час прогону — і відновлення затре їх. */
const driftSeen = [];
try {
  const base = run();
  lines.push(`# Стенд фальсифікації пакета 54 — графік у модалках оновлюється (с63)\n`);
  lines.push(`**БАЗОВА ЛІНІЯ:** ${base.ok ? "ЗЕЛЕНА" : "ЧЕРВОНА"} (${base.total} тестів)\n`);
  if (!base.ok) {
    lines.push(`\n⛔ Базова лінія червона — стенд НІЧОГО не доводить. Червоні: ${base.red.join(", ")}\n`);
  } else {
    lines.push(`\n| # | мутація | очікування | факт | вердикт |`);
    lines.push(`|---|---|---|---|---|`);
    for (const m of MUTATIONS) {
      for (const [k, p] of Object.entries(FILES)) {
        if (readFileSync(p, "utf8") !== orig[k] && !driftSeen.includes(p)) driftSeen.push(p);
      }
      const eds = editsOf(m).map((e) => ({ ...e, path: FILES[e.file], src: readFileSync(FILES[e.file], "utf8") }));
      /* Унікальність якоря перевіряємо по ПОТОЧНОМУ вмісту файла з урахуванням
         уже застосованих правок цієї ж мутації — інакше багатокрокові `edits`
         міряли б унікальність не в тому тексті. */
      const cur = {};
      let dead = null;
      for (const e of eds) {
        const base2 = cur[e.path] ?? e.src;
        const n = base2.split(e.from).length - 1;
        if (n !== 1) { dead = { path: e.path, n }; break; }
        cur[e.path] = base2.replace(e.from, () => e.to);
      }
      if (dead) {
        lines.push(`| ${m.id} | ${m.what} | — | ЯКІР НЕ УНІКАЛЬНИЙ (${dead.n}) у ${dead.path} | ⛔ відхилено |`);
        continue;
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
  if (driftSeen.length) {
    lines.push(`\n⛔ ДРЕЙФ ФАЙЛІВ під час прогону: ${driftSeen.join(", ")}.`);
    lines.push(`Знімок для відновлення знято ДО цих правок — прогін недійсний.`);
  }
  lines.push(`\n${verdict.summary}`);
  lines.push(`\n## ПІДСУМОК: ${addressedOk}/${EXPECTED_RED} адресних, ${MUTATIONS.length - EXPECTED_RED} рефакторних`);
  writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log(`\nЗвіт: ${OUT}. Файли відновлено.`);
  finishStand({
    ok: verdict.ok === true && driftSeen.length === 0,
    red: "\n⛔ ВЕРДИКТ: СТЕНД ЧЕРВОНИЙ — причина в таблиці вище.",
  });
}
