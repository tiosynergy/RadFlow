/* Адресна фальсифікація U-56 — «журнал аварійної зупинки не залежить від
   ДРУГОГО читання». Протокол той самий, що в u55/u33/0166: перед мутаціями
   стенд один раз ганяє немутований набір і вимагає ЗЕЛЕНОГО; якір перевіряється
   на УНІКАЛЬНІСТЬ; звіряється ІМʼЯ червоного тесту, а не сам факт червоного.

   ⚠️ Половина мутацій нижче відтворює знахідки РЕВʼЮ цього ж пакета, а не
   гіпотетичні диверсії: перша редакція справді гейтила журнал на нерозібраному
   `stopped_rooms` (N05), справді вбивала всі події через один битий елемент
   (N08), справді підміняла невідомий кабінет порожнім рядком (N10) і справді
   мала пін, який не бачив багаторядкового `.from("incidents")` (N13). */
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { finishStand } from "./lib/falsify-verdict.mjs";

const ACT = "app/queue/actions.ts";
const LIB = "lib/incidents.ts";
const SPEC = "tests/stoppedIncidents.test.ts";
const PINS = "tests/roomModalityRead.test.ts";
const MIG = "supabase/migrations/0168_emergency_stop_returns_incident_ids.sql";

const E = {
  absent:   /поля немає взагалі → absent/,
  notArr:   /не масив → absent/,
  empty:    /порожній масив — ЗАКОННА відповідь/,
  keep:     /зіпсований елемент відкидається, РЕШТА лишається/,
  roomless: /кабінет без roomId подію НЕ скасовує/,
  gapAbs:   /поля немає → absent_in_rpc/,
  gapMal:   /елементи не читаються → malformed/,
  gapOrder: /причина переважає над симптомом/,
  gapShort: /менше, ніж зупинили → short_in_rpc/,
  gapRoom:  /події є, але без кабінету → no_room_in_rpc/,
  gapQuiet: /усе на місці → мовчимо/,
  noRead:   /ДРУГОГО читання інцидентів більше немає/,
  sameNum:  /очікувана кількість береться з того самого поля/,
  perInc:   /подія пишеться на КОЖЕН інцидент/,
  viaPure:  /вибір коду делеговано чистій функції/,
  canon:    /імʼя події канонічне/,
  noFail:   /дію користувача НЕ валить/,
  migCols:  /міграція віддає саме `stopped_incidents`/,
  migKeys:  /ключі елемента — `id` і `roomId`/,
  migLater: /ЖОДНА міграція, новіша за 0168/,
  migMech:  /механізм піна робочий/,
  migOrder: /обидва агрегати впорядковані/,
  migAcl:   /revoke після drop\+create на місці/,
  migAssert:/ACL перевіряється В ТІЙ САМІЙ транзакції/,
  types:    /згенеровані типи знають про нову колонку/,
};

const M = [
  /* ── правило розбору ──────────────────────────────────────────────────── */
  ["N01 «поля немає» знову рахується порожнім списком", LIB, E.absent,
   '  if (!Array.isArray(value)) {\n    return { incidents: [], absent: true, dropped: 0, roomless: 0 };\n  }',
   '  if (!Array.isArray(value)) {\n    return { incidents: [], absent: false, dropped: 0, roomless: 0 };\n  }'],
  ["N02 рядок «[]» проходить за масив", LIB, E.notArr,
   '  if (!Array.isArray(value)) {',
   '  if (value == null) {'],
  ["N03 порожній масив оголошено незнанням", LIB, E.empty,
   '  const out: StoppedIncident[] = [];\n  let dropped = 0, roomless = 0;',
   '  if (value.length === 0) return { incidents: [], absent: true, dropped: 0, roomless: 0 };\n  const out: StoppedIncident[] = [];\n  let dropped = 0, roomless = 0;'],
  /* ⚠️ Відтворює знахідку ревʼю: перша редакція вбивала ВЕСЬ масив через один
     непридатний елемент — при зупинці 20 кабінетів це нуль подій замість 19. */
  ["N08 один битий елемент знову вбиває решту", LIB, E.keep,
   '    if (typeof id !== "string" || id === "") { dropped++; continue; }',
   '    if (typeof id !== "string" || id === "") { return { incidents: [], absent: true, dropped: 0, roomless: 0 }; }'],
  ["N09 биті елементи мовчки не рахуються", LIB, E.keep,
   '{ dropped++; continue; }', '{ continue; }'],
  /* ⚠️ Друга знахідка ревʼю: `""` у журналі виглядає як «кабінет відомий». */
  ["N10 невідомий кабінет знову підміняється порожнім рядком", LIB, E.roomless,
   '    const roomId = typeof raw === "string" && raw !== "" ? raw : null;\n    if (roomId === null) roomless++;',
   '    const roomId = typeof raw === "string" ? raw : "";'],

  /* ── вибір коду ───────────────────────────────────────────────────────── */
  ["N11 «немає поля» і «не розібрали» знову злиті в один код", LIB, E.gapMal,
   '  if (read.dropped > 0) return "incidents_malformed_in_rpc";', ''],
  ["N12 гілки причини й симптому помінялись місцями", LIB, E.gapOrder,
   '  if (read.dropped > 0) return "incidents_malformed_in_rpc";\n  if (read.incidents.length < expected) return "incidents_short_in_rpc";',
   '  if (read.incidents.length < expected) return "incidents_short_in_rpc";\n  if (read.dropped > 0) return "incidents_malformed_in_rpc";'],
  ["N04 незнання поля перестало бути окремим кодом", LIB, E.gapAbs,
   '  if (read.absent) return "incidents_absent_in_rpc";', ''],
  ["N06 «менше, ніж зупинили» більше не помічають", LIB, E.gapShort,
   '  if (read.incidents.length < expected) return "incidents_short_in_rpc";', ''],
  ["N07 події без кабінету проходять мовчки", LIB, E.gapRoom,
   '  if (read.roomless > 0) return "incidents_no_room_in_rpc";', ''],
  ["N14 сторож кричить і тоді, коли все на місці", LIB, E.gapQuiet,
   '  if (read.incidents.length < expected) return "incidents_short_in_rpc";',
   '  if (read.incidents.length !== expected) return "incidents_short_in_rpc";'],

  /* ── місце склейки ────────────────────────────────────────────────────── */
  /* ⚠️ Відтворює BLOCKER ревʼю: гейт журналу на полі, якого ніхто не розбирає. */
  ["N05 журнал знову під гейтом нерозібраного stopped_rooms", ACT, E.sameNum,
   '  const stoppedCount = typeof res?.stopped === "number" ? res.stopped : 0;\n  {',
   '  const stoppedRooms: string[] = res?.stopped_rooms ?? [];\n  const stoppedCount = stoppedRooms.length;\n  if (stoppedRooms.length > 0) {'],
  ["N15 подія пишеться лише про перший інцидент", ACT, E.perInc,
   '    await Promise.all(incs.incidents.map((inc) => emitImportantEvent({',
   '    await Promise.all(incs.incidents.slice(0, 1).map((inc) => emitImportantEvent({'],
  ["N16 у полі сутності опинився кабінет, а не інцидент", ACT, E.perInc,
   '      entityId: inc.id,\n      details: inc.roomId ? { roomId: inc.roomId } : null,',
   '      entityId: inc.roomId ?? inc.id,\n      details: { roomId: inc.roomId },'],
  ["N17 лог сховано за прапорцем середовища", ACT, E.viaPure,
   '    if (gap) {\n      /* ⚠️ `event`', '    if (gap && process.env.LOG_GAPS) {\n      /* ⚠️ `event`'],
  ["N18 імʼя події неканонічне — запит про пропуски його не знайде", ACT, E.canon,
   '        event: "important_event.skipped",\n        clinicId,\n        actorId: user.id,\n        entityId: null,\n        errorCode: gap,',
   '        event: "incident.emergency_stop",\n        clinicId,\n        actorId: user.id,\n        entityId: null,\n        errorCode: gap,'],
  ["N19 неповний журнал знову валить уже закомічену зупинку", ACT, E.noFail,
   '    const gap = stoppedIncidentsGap(incs, stoppedCount);',
   '    const gap = stoppedIncidentsGap(incs, stoppedCount);\n    if (gap) return { ok: false, error: "Не вдалося записати журнал", code: "generic" };'],
  /* ⚠️ Відтворює BLOCKER ревʼю: пін не бачив багаторядкового стилю, який лежить
     у ЦЬОМУ Ж файлі (`incidentSpansFor`). */
  ["N13 друге читання повернулось У СТИЛІ сусідньої функції", ACT, E.noRead,
   '    const incs = readStoppedIncidents(res?.stopped_incidents);',
   '    const back = await supabase\n      .from("incidents")\n      .select("id, room_id");\n    void back;\n    const incs = readStoppedIncidents(res?.stopped_incidents);'],

  /* ── контракт міграції ────────────────────────────────────────────────── */
  ["N20 у міграції перейменували ключ кабінету", MIG, E.migKeys,
   "jsonb_build_object('id', id, 'roomId', room_id)", "jsonb_build_object('id', id, 'room_id', room_id)"],
  ["N21 OUT-колонка зникла з підпису", MIG, E.migCols,
   'returns table(stopped int, affected int, stopped_rooms uuid[],\n              stopped_incidents jsonb, patients jsonb)',
   'returns table(stopped int, affected int, stopped_rooms uuid[], patients jsonb)'],
  ["N22 агрегати знову невпорядковані", MIG, E.migOrder,
   'array_agg(room_id order by room_id)', 'array_agg(room_id)'],
  /* ⚠️ Якорі з ПРОВІДНИМ переносом рядка: ті самі revoke/grant стоять іще й у
     секції ВІДКАТ, закоментовані (`-- revoke …`), і короткий якір стенд чесно
     відхилив як НЕунікальний. Перенос рядка відрізняє виконуваний рядок від
     закоментованого. */
  ["N23 revoke після drop+create загубився — пастка 0122", MIG, E.migAcl,
   '\nrevoke execute on function public.emergency_stop_rpc(uuid[], date, text) from anon, public;\n', '\n'],
  ["N24 service_role знову заручник дефолту", MIG, E.migAcl,
   '\ngrant  execute on function public.emergency_stop_rpc(uuid[], date, text) to authenticated, service_role;',
   '\ngrant  execute on function public.emergency_stop_rpc(uuid[], date, text) to authenticated;'],
  /* ⚠️ Перша редакція цієї мутації нічого не рухала (`-- MOVED` усередині блоку)
     і стенд справедливо показав ЗЕЛЕНЕ. Щоб «ассерт після commit» справді
     сталося, досить закомітити РАНІШЕ за нього. */
  ["N25 ассерт ACL опинився ЗА commit — він нічого не відкотить", MIG, E.migAssert,
   '\ndo $acl$\ndeclare', '\ncommit;\ndo $acl$\ndeclare'],
  ["N26 ассерт втратив зонд PUBLIC", MIG, E.migAssert,
   '              where p.oid = v_fn and a.grantee = 0 and a.privilege_type = \'EXECUTE\') then',
   '              where p.oid = v_fn and a.grantee = -1 and a.privilege_type = \'EXECUTE\') then'],

  /* ── самі сторожі ─────────────────────────────────────────────────────── */
  /* ⚠️ Перша редакція цілила в пін «новіших міграцій немає» — і стенд показав
     ЗЕЛЕНЕ, бо зламаний пошук дає порожній список, а порожній список і є
     очікуваний результат того піна. Це не хиба мутації, а хиба СТОРОЖА: він не
     фальсифікується сам по собі. Полагоджено в тесті (додано половину з ВІДОМОЮ
     непорожньою відповіддю), і мутація тепер цілить у неї. */
  ["N27 пошук по міграціях зламано — пін «новіших немає» став вакуумним", SPEC, E.migMech,
   "      .filter((f) => /^\\d{4}_.*\\.sql$/.test(f) && f > after)",
   "      .filter((f) => /^\\d{4}_.*\\.sql$/.test(f) && f > \"9999\")"],
  ["N28 типи більше не знають про колонку", "supabase/types.ts", E.types,
   '          stopped_incidents: Json;\n', ''],
];

/* ── стенд ───────────────────────────────────────────────────────────────── */
const files = [...new Set(M.map((m) => m[1]))];
const orig = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const restore = () => { for (const [f, t] of orig) writeFileSync(f, t); };
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { restore(); process.exit(1); });
process.on("uncaughtException", (e) => { restore(); console.error(e); process.exit(1); });

const SPECS = `${SPEC} ${PINS}`;
const lines = ["# Фальсифікація U-56", ""];
let bad = 0;

function runSpec() {
  rmSync(".vt.json", { force: true });
  try {
    execSync(`npx vitest run ${SPECS} --reporter=json --outputFile=.vt.json`,
      { stdio: "ignore", timeout: 180000 });
  } catch { /* ненульовий код = є червоні */ }
  try {
    const j = JSON.parse(readFileSync(".vt.json", "utf8"));
    const red = [];
    for (const f of j.testResults) for (const a of f.assertionResults) {
      if (a.status === "failed") red.push(a.fullName);
    }
    return red;
  } catch { return null; }
}

const base = runSpec();
if (base === null) { lines.push("- **БАЗОВА ЛІНІЯ** — ❌ звіту немає"); bad++; }
else if (base.length) {
  bad++;
  lines.push("- **БАЗОВА ЛІНІЯ** — ❌ набір ЧЕРВОНИЙ ще до мутацій: " + base.map((n) => `«${n}»`).join("; "));
} else lines.push("- **БАЗОВА ЛІНІЯ** → ✅ зелено до мутацій");
console.log(lines.at(-1));

for (const [name, file, expectRe, from, to] of M) {
  const src = orig.get(file);
  if (!src.includes(from)) {
    bad++; lines.push(`- **${name}** — ❌ ЯКІР НЕ ЗНАЙДЕНО`); console.log(lines.at(-1)); continue;
  }
  if (src.split(from).length > 2) {
    bad++; lines.push(`- **${name}** — ❌ ЯКІР НЕ УНІКАЛЬНИЙ (${src.split(from).length - 1}×)`);
    console.log(lines.at(-1)); continue;
  }
  let red = null;
  try { writeFileSync(file, src.replace(from, () => to)); red = runSpec(); }
  finally { writeFileSync(file, src); }

  if (red === null) { bad++; lines.push(`- **${name}** — ❌ ПОМИЛКА: звіту немає`); }
  else if (expectRe === "GREEN") {
    if (red.length) {
      bad++;
      lines.push(`- **${name}** → ❌ ЧЕРВОНИЙ, а мав лишитись зеленим: ` + red.map((n) => `«${n}»`).join("; "));
    } else lines.push(`- **${name}** → ✅ ЗЕЛЕНИЙ, як і мусив (еквівалентна правка)`);
  }
  else if (!red.length) { bad++; lines.push(`- **${name}** — ⚠️ ЗЕЛЕНИЙ: сторож дивиться не туди`); }
  else if (!red.some((n) => expectRe.test(n))) {
    bad++;
    lines.push(`- **${name}** → ⚠️ ЧЕРВОНИЙ НЕ ТОЙ (чекали ${expectRe}): ` + red.map((n) => `«${n}»`).join("; "));
  } else lines.push(`- **${name}** → ЧЕРВОНИЙ: ` + red.map((n) => `«${n}»`).join("; "));
  console.log(lines.at(-1));
}

restore();
lines.push("", bad ? `## ПІДСУМОК: ${bad} проблемних із ${M.length}` : `## ПІДСУМОК: ${M.length}/${M.length} адресних`);
writeFileSync("falsify-u56.md", lines.join("\n"), "utf8");
console.log(lines.at(-1));

/* U-74: ненайдений або неунікальний якір, «сторож дивиться не туди» і чужий
   червоний — це ЧЕРВОНИЙ вердикт СТЕНДА, а не рядок у звіті. До с51 стенд
   виходив нулем при будь-якому вмісті таблиці, і мутація, яка НЕ ВІДБУЛАСЬ,
   читалась як успіх. */
finishStand({
  ok: !bad,
  red: `\n⛔ ВЕРДИКТ: СТЕНД ЧЕРВОНИЙ — ${bad} проблемних позицій. Стенд НЕ доводить нічого.`,
  green: `\n✅ ВЕРДИКТ: стенд зелений.`,
});
