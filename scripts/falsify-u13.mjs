/* Адресна фальсифікація U-13 («не читали = не знаємо» для графіка кабінету).
   Протокол той самий, що у falsify-u33/u37: `.vt.json` чиститься перед кожним
   прогоном, «звіту немає» — окремий статус ПОМИЛКА, звіряється ІМʼЯ тесту.
   Регексп очікування мусить збігатися з РЕАЛЬНИМ іменем: у U-33 саме на цьому
   стенд двічі сказав «ЧЕРВОНИЙ НЕ ТОЙ» на правильному сторожі. */
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";

const LIB = "lib/roomSchedule.ts";
const BM  = "components/BookingModal.tsx";
const RM  = "components/RescheduleModal.tsx";
const SEM = "components/StudyEditModal.tsx";
const RP  = "components/ReferralPortal.tsx";
const QRB = "components/QuickRescheduleButton.tsx";
const CP  = "components/CollisionPanel.tsx";
const ACT = "app/queue/actions.ts";
const SLOTS = "lib/slots.ts";   // сюди підсаджуємо «нового читача» для сканера

const MISSING = /рядка немає \(RLS сховала кабінет або його видалили\)/;
const DEFAULTOK = /schedule = null → ЗНАЄМО/;
const ERRSRC  = /помилка читання → не знаємо \(reason: error\)/;
const FAILCLOSED = /відповіді немає взагалі/;
const REASON  = /причина доїжджає в текст помилки/;
const MANY_MISS = /один кабінет НЕ прийшов/;
const MANY_KEYS = /перевірка ПО КЛЮЧАХ, а не по довжині/;
const SCAN    = /новий читач rooms\.schedule валить тест/;
/* ⚠️ Імʼя тесту, а не моя памʼять про нього: перший прогін дав «ЧЕРВОНИЙ НЕ ТОЙ»
   на шести мутаціях, бо привʼязка жила третім `expect` у тесті з іншим іменем.
   Сторожа розділено — тепер у неї власне імʼя, і мутація його називає. */
const bind = (f) => new RegExp(f.replace(/[.[\]/]/g, "\\$&") + ": незнання ЗУПИНЯЄ потік у КОЖНОМУ місці виклику");
const rollback = (f) => new RegExp(f.replace(/[.[\]/]/g, "\\$&") + ": старий тихий відкат не повернувся");

const M = [
  /* ── саме правило ─────────────────────────────────────────────────────── */
  ["N01 порожній рядок знову «графіка немає» (той самий дефект)", LIB, MISSING,
   'if (!res.data) return { known: false, reason: "missing" };',
   'if (!res.data) return { known: true, schedule: null };'],
  ["N02 легітимний дефолт (schedule=null) оголошено незнанням", LIB, DEFAULTOK,
   "return { known: true, schedule: res.data.schedule ?? null };",
   'if (res.data.schedule == null) return { known: false, reason: "missing" };\n  return { known: true, schedule: res.data.schedule };'],
  ["N03 помилку читання знову ковтають", LIB, ERRSRC,
   'if (res.error) return { known: false, reason: "error" };', ""],
  ["N04 fail-open на порожній відповіді", LIB, FAILCLOSED,
   'if (!res) return { known: false, reason: "error" };',
   "if (!res) return { known: true, schedule: null };"],
  ["N05 причина втрачена — обидва тексти однакові", LIB, REASON,
   '? "room schedule row not readable (RLS or deleted)"\n      : "room schedule read failed",',
   '? "room schedule unavailable"\n      : "room schedule unavailable",'],
  ["N06 спискова форма: повноту більше не перевіряють", LIB, MANY_MISS,
   'for (const id of wanted) if (!(id in byId)) return { known: false, reason: "missing" };', ""],
  ["N07 спискова форма: повнота по ДОВЖИНІ (зелено на дублікатах)", LIB, MANY_KEYS,
   'for (const id of wanted) if (!(id in byId)) return { known: false, reason: "missing" };',
   'if (rows.length !== wanted.length) return { known: false, reason: "missing" };'],
];

/* ── привʼязка: правило кличуть, але результат більше не зупиняє потік ──── */
const BINDS = [
  ["N08 BookingModal", BM, "sched"], ["N09 RescheduleModal", RM, "sched"],
  ["N10 StudyEditModal", SEM, "sched"], ["N11 ReferralPortal", RP, "sched"],
  ["N12 QuickRescheduleButton", QRB, "read"], ["N13 CollisionPanel", CP, "read"],
  ["N14 серверний гейт app/queue/actions", ACT, "sched0"],
];
for (const [name, file, v] of BINDS) {
  M.push([`${name}: незнання більше не зупиняє потік`, file, bind(file),
    `if (!${v}.known) throw roomScheduleReadError(${v}.reason);`, ""]);
}

/* ── мутації з РЕВʼЮ СТОРОЖІВ: кожна колись була зеленою ─────────────────── */
const ARITY   = /рівно один параметр — мʼякого режиму не існує/;
const RULEBIND = (f) => new RegExp(f.replace(/[.[\]/]/g, "\\$&") + ": відповідь розбирає правило");
const ROUTE404 = /гілка !room ціла/;
const SCREENSTATE = /BookingModal: збій читання доводиться до стану екрана/;

M.push(
  ["N17 правилу дописали мʼякий режим — дефект вертається в усі 7 місць", LIB, ARITY,
   "export function readRoomScheduleRow(\n  res: { data: RoomScheduleRow; error: unknown } | null | undefined,\n): RoomScheduleRead {",
   "export function readRoomScheduleRow(\n  res: { data: RoomScheduleRow; error: unknown } | null | undefined,\n  opts?: { missingIsDefault?: boolean },\n): RoomScheduleRead {\n  if (res && !res.error && !res.data && opts?.missingIsDefault) return { known: true, schedule: null };"],
  /* ⚠️ Очікуване імʼя виправлене за прогоном: перевірка «аргумент — це саме
     біндер читання» живе в тесті про ГЕЙТ (пара «виклик + гейт»), а не в тесті
     про наявність виклику. Стенд назвав це «ЧЕРВОНИЙ НЕ ТОЙ» — і був правий. */
  ["N18 правилу підсунули СИНТЕЗОВАНУ відповідь (гілка «немає» недосяжна)", BM, bind(BM),
   "const sched = readRoomScheduleRow(roomRes);",
   "const sched = readRoomScheduleRow({ data: roomRes.data ?? { schedule: null }, error: roomRes.error });"],
  ["N19 між викликом і гейтом вставили ранній вихід (fail-OPEN на сервері)", ACT, bind(ACT),
   "  const sched0 = readRoomScheduleRow(roomRes);\n  if (!sched0.known) throw roomScheduleReadError(sched0.reason);",
   "  const sched0 = readRoomScheduleRow(roomRes);\n  if (!roomRes.data) return null;\n  if (!sched0.known) throw roomScheduleReadError(sched0.reason);"],
  ["N20 правило перекрито локальною обгорткою, що пом'якшує відповідь", QRB, RULEBIND(QRB),
   "        const read = readRoomScheduleRow(schedRes);",
   "        const readRoomScheduleRow = (r: Parameters<typeof readRoomScheduleRowLib>[0]) => { const x = readRoomScheduleRowLib(r); return x.known ? x : { known: true as const, schedule: null }; };\n        const read = readRoomScheduleRow(schedRes);"],
  ["N21 партнерський фасад перестав відсікати «рядка немає»", "app/api/integrations/v1/slots/route.ts", ROUTE404,
   "if (!room || room.clinic_id !== clinicId) {",
   "if (room && room.clinic_id !== clinicId) {"],
  ["N22 BookingModal: збій більше не доводиться до стану екрана", BM, SCREENSTATE,
   "if (req === schedReqRef.current) { setOverride(null); setRoomSchedule(null); setSchedErr(true); }",
   "if (req === schedReqRef.current) setSchedErr(true);"],
  ["N23 банер «особливий графік» знову стверджує на недовірених даних", BM, SCREENSTATE,
   "{availTrusted && roomId && !roomSched.closed && roomSched.custom &&",
   "{roomId && !roomSched.closed && roomSched.custom &&"],
  ["N15 BookingModal: повернувся тихий відкат `?.schedule ?? null`", BM, rollback(BM),
   "const sched = readRoomScheduleRow(roomRes);",
   "const sched = { known: true, schedule: (roomRes.data as { schedule?: unknown } | null)?.schedule ?? null } as const;"],
  /* ⚠️ Сканер перевіряє те, чого немає в переписі. Мутація підсаджує НОВОГО
     читача графіка у файл, якого в переписі немає, — саме так виглядає новий
     екран, який завтра забудуть провести через правило. */
  ["N16 новий читач графіка заїхав повз перепис", SLOTS, SCAN,
   "export function buildSlots(",
   'export async function readsRoomsSchedule(sb: { from: (t: string) => { select: (c: string) => unknown } }) {\n  return sb.from("rooms").select("id, schedule");\n}\nexport function buildSlots('],
);

const files = [...new Set(M.map((m) => m[1]))];
const orig = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const restore = () => { for (const [f, t] of orig) writeFileSync(f, t); };
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { restore(); process.exit(1); });
process.on("uncaughtException", (e) => { restore(); console.error(e); process.exit(1); });

const SPEC = "tests/roomScheduleRead.test.ts tests/roomScheduleReadContract.test.ts";
const lines = ["# Фальсифікація U-13", ""];
let bad = 0;

for (const [name, file, expectRe, from, to] of M) {
  const src = orig.get(file);
  if (!src.includes(from)) {
    bad++; lines.push(`- **${name}** — ❌ ЯКІР НЕ ЗНАЙДЕНО`); console.log(lines.at(-1)); continue;
  }
  let red = null;
  try {
    rmSync(".vt.json", { force: true });
    writeFileSync(file, src.replace(from, to));
    try {
      execSync(`npx vitest run ${SPEC} --reporter=json --outputFile=.vt.json`,
        { stdio: "ignore", timeout: 180000 });
    } catch { /* ненульовий код = є червоні */ }
    try {
      const j = JSON.parse(readFileSync(".vt.json", "utf8"));
      red = [];
      for (const f of j.testResults) for (const a of f.assertionResults) {
        if (a.status === "failed") red.push(a.fullName);
      }
    } catch { red = null; }
  } finally {
    writeFileSync(file, src);
  }
  if (red === null) { bad++; lines.push(`- **${name}** — ❌ ПОМИЛКА: звіту немає`); }
  else if (!red.length) { bad++; lines.push(`- **${name}** — ⚠️ ЗЕЛЕНИЙ: сторож дивиться не туди`); }
  else if (!red.some((n) => expectRe.test(n))) {
    bad++;
    lines.push(`- **${name}** → ⚠️ ЧЕРВОНИЙ НЕ ТОЙ (чекали ${expectRe}): ` + red.map((n) => `«${n}»`).join("; "));
  } else {
    lines.push(`- **${name}** → ЧЕРВОНИЙ: ` + red.map((n) => `«${n}»`).join("; "));
  }
  console.log(lines.at(-1));
}

restore();
lines.push("", bad ? `## ПІДСУМОК: ${bad} проблемних із ${M.length}` : `## ПІДСУМОК: ${M.length}/${M.length} адресних`);
writeFileSync("falsify-u13.md", lines.join("\n"), "utf8");
console.log(lines.at(-1));

/* U-74: ненайдений або неунікальний якір, «сторож дивиться не туди» і чужий
   червоний — це ЧЕРВОНИЙ вердикт СТЕНДА, а не рядок у звіті. До с51 стенд
   виходив нулем при будь-якому вмісті таблиці, і мутація, яка НЕ ВІДБУЛАСЬ,
   читалась як успіх. */
if (bad) {
  console.log(`\n⛔ ВЕРДИКТ: СТЕНД ЧЕРВОНИЙ — ${bad} проблемних позицій. Стенд НЕ доводить нічого.`);
  process.exitCode = 1;
} else {
  console.log(`\n✅ ВЕРДИКТ: стенд зелений.`);
}
