/* Адресна фальсифікація U-37 (0164/0165 — мітла позначок на DELETE).
   Кожна мутація відтворює РЕАЛЬНИЙ спосіб зламати фікс і мусить пофарбувати
   САМЕ ТОЙ тест, що названий у колонці `expect`.

   ⚠️ Три правки після ревʼю с49 (протокол сам був напівдекоративним):
     1) `.vt.json` видаляється ПЕРЕД кожним прогоном — інакше нечитаний або
        застряглий звіт мовчки приносив результат попередньої мутації;
     2) відсутній/непарсабельний звіт — ОКРЕМИЙ статус ПОМИЛКА, а не «червоний»
        («червоний» без даних — це не результат, а збій вимірювання);
     3) звіряємо ІМʼЯ: будь-який червоний більше не зараховується.
   Файли відновлюються завжди — try/finally плюс обробники сигналів. */
import { readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const M64   = "supabase/migrations/0164_change_markers_purge_on_delete.sql";

/* ⚠️ ЖИВИЙ ПЕРЕДРУК, А НЕ ПРИБИТИЙ ФАЙЛ (с51, U-80в).
   Раніше тут стояла константа `M65 = ".../0165_markers_purge_corrections.sql"`, і
   ШІСТЬ мутацій цілили в неї. Але обидва спеки-сторожі читають НЕ 0165, а
   ОСТАННЮ за іменем міграцію, що передруковує `invariants_check`
   (`tests/unreadChanges.test.ts` — `guardSrc()`, `tests/invariantsCheckedPins.test.ts`
   — `checksInLatestReprint()`), і це зроблено НАВМИСНО: «пін по конкретному
   файлу стеріг би мертвий текст».

   Стенд писався в с49, коли 0165 і був останнім. Потім прийшли 0166 і 0167 —
   і всі шість мутацій почали правити файл, якого сторож НЕ ЧИТАЄ. Вони не
   ламали нічого, тому чесно лишались зеленими, а стенд рапортував «сторож не
   тримає» — тобто звинувачував сторожа у власному промаху. Шість позицій із
   26 «мертвих» у ревізії — саме звідси.

   Тепер ціль резолвиться ТИМ САМИМ способом, що й у тестах. Прибити її знову
   константою не можна: наступна ж міграція, що передрукує сторожа, знову
   зробить стенд сліпим — мовчки. */
function latestReprint() {
  const dir = "supabase/migrations";
  let best = "";
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const txt = readFileSync(resolve(dir, f), "utf8");
    /* ⚠️ ЯКІР НА ПОЧАТОК РЯДКА, а не гола підрядка (знахідка ревʼю Д). Міграції
       регулярно ЗГАДУЮТЬ сторожа в закоментованому відкаті — 0167 робить саме
       так. Гола підрядка навела б стенд на файл БЕЗ тіла сторожа, і всі шість
       мутацій дали б «якір не знайдено» з неправильної причини.
       І терміналізатор мусить БУТИ: тест `guardSrc` вимагає `\n$function$;`,
       тож без цієї ж вимоги стенд міг би цілитись у передрук, який тест
       відкидає — тобто вони б розійшлись мовчки.
       ⚠️ ГУЧНО, а не `continue` (с56). До 0171 усі три місця мовчки
       пропускали передрук без терміналізатора, і це був однаковий БРАК, а не
       узгодженість: міграція, що закриє тіло іншим доларовим тегом, лишила б
       і тести, і стенд на ПОПЕРЕДНЬОМУ передруку — зелено скрізь, червоно в
       проді. Тести тепер падають; падає й стенд. Зелена база на момент
       правки: 12 передруків, у всіх тег `$function$`, без терміналізатора —
       жодного. */
    const at = txt.search(/^create or replace function public\.invariants_check/m);
    if (at < 0) continue;
    if (txt.indexOf("\n$function$;", at) < 0) {
      console.error(`⛔ ${f}: передрук invariants_check не закритий "$function$;" — `
        + "стенд НЕ прогнано, інакше він цілився б у попередній передрук мовчки.");
      process.exit(2);
    }
    best = dir + "/" + f;
  }
  if (!best) { console.error("НЕ ЗНАЙДЕНО жодного передруку invariants_check"); process.exit(2); }
  return best;
}
const M65 = latestReprint();
const M0138 = "supabase/migrations/0138_schedule_override_lockdown_and_marker_audience.sql";
const SMOKE = "supabase/smoke/change_markers_purge_smoke.sql";
const SWATCH = "supabase/smoke/invariants_watch_smoke.sql";

/** Число перевірок, ЗНЯТЕ з живого смоука (див. N21 нижче). */
const CHECKED = (() => {
  const m = readFileSync(SWATCH, "utf8").match(/\(v_res ->> 'checked'\)::int is distinct from (\d+) then/);
  if (!m) { console.error(`НЕ ЗНАЙДЕНО пін числа перевірок у ${SWATCH}`); process.exit(2); }
  return Number(m[1]);
})();

const PURGE = /мітла фільтрує по ДВОХ колонках/;
const PAIRS = /проводка 0164 — рівно пʼять пар/;
const SCAN  = /КОЖЕН тип сутності/;
const CLEAN = /разова чистка покриває/;
const GUARD = /сторож дізнався про мітлу/;
const SMK   = /смоук 0164 живий/;
const PINS  = /кожен пін у смоуках/;

const M = [
  ["N01 мітла більше не дивиться на тип сутності", M64, PURGE,
   "where entity_type = tg_argv[0]", "where entity_type = 'queue_entry'"],
  ["N02 мітла без фільтра по рядку — зносить позначки ВСІХ сутностей типу", M64, PURGE,
   "\n     and entity_id   = old.id;", ";"],
  ["N03 мітлу посадили під прапорець емісії", M64, PURGE,
   "  delete from public.user_change_markers\n   where entity_type",
   "  if not public.change_markers_enabled() then return null; end if;\n  delete from public.user_change_markers\n   where entity_type"],
  ["N04 мітла перестала бути security definer — RLS зʼїсть DELETE мовчки", M64, PURGE,
   "security definer\nset search_path = public, pg_temp\nas $fn$",
   "set search_path = public, pg_temp\nas $fn$"],
  ["N05 тригер кабінетів дістав чужий аргумент (виглядає живим, не робить нічого)", M64, PAIRS,
   "for each row execute function public.tg_change_markers_purge('room');",
   "for each row execute function public.tg_change_markers_purge('queue_entry');"],
  ["N06 тригер на чергу знято зовсім", M64, PAIRS,
   "drop trigger if exists trg_zzz_markers_purge on public.queue_entries;\ncreate trigger trg_zzz_markers_purge\n  after delete on public.queue_entries\n  for each row execute function public.tg_change_markers_purge('queue_entry');\n",
   ""],
  ["N07 НОВИЙ тип сутності в емітері без мітли (шлях, яким дефект і виник)", M0138, SCAN,
   "p_event_type => 'service.room_override_changed',\n    p_surface => 'services', p_entity_type => 'room',",
   "p_event_type => 'service.room_override_changed',\n    p_surface => 'services', p_entity_type => 'service',"],
  ["N08 разова чистка забула тип incident", M64, CLEAN,
   "    or (m.entity_type = 'incident'\n        and not exists (select 1 from public.incidents        x where x.id = m.entity_id))",
   ""],
  ["N09 результат перевірки кладеться під чужим імʼям", M65, GUARD,
   "'check', 'ucm_orphan_markers'", "'check', 'ucm_orphan'"],
  /* ⚠️ ЦЯ ПОЗИЦІЯ ЗНАЙШЛА СПРАВЖНІЙ ДЕФЕКТ У СТОРОЖІ (с51). Після переїзду на
     живий передрук вона дала «ЧЕРВОНИЙ НЕ ТОЙ»: названий сторож
     («сторож дізнався про мітлу») мовчав, а ловив її сусідній тест про піни.
     Причина була не в назві, а в самому сторожі — його поріг стояв на
     ЗАМОРОЖЕНІЙ константі `>= 14`, тоді як живих перевірок уже 15. Тобто
     «монотонність» перетворилась на межу, під якою перевірку можна втратити
     мовчки, і саме це мутація й робила.
     Поріг полагоджено (`Math.max(14, prevChecks)` — межа рухається за
     попереднім передруком), і сторож знову тримає СВІЙ клас. Тому тут GUARD, а
     не PINS: перейменувати сторожа було б лікуванням симптому. */
  ["N10 перевірку додали, але лічильник не зріс — сторож про неї не знає", M65, GUARD,
   "  --     переживає видалення).\n  v_n := v_n + 1;",
   "  --     переживає видалення)."],
  ["N11 сторож перестав перевіряти ПРОВОДКУ (лишився самий наслідок)", M65, GUARD,
   "select 'bad_trigger:' || t.tbl as txt", "select 'x:' || t.tbl as txt"],
  ["N12 сторож перестав рахувати сиріт-простоїв", M65, GUARD,
   "'orphan:incident:'", "'orphan:xxx:'"],
  ["N13 смоук звіряє чужу пару (таблиця, аргумент)", SMOKE, SMK,
   "      ('incidents',        'incident'),\n      ('rooms',            'room')) as t(tbl, arg)",
   "      ('incidents',        'room'),\n      ('rooms',            'incident')) as t(tbl, arg)"],
  ["N14 смоук перестав робити живий постріл", SMOKE, SMK,
   "  delete from public.incidents where id = v_incident;", "  -- postril prybrano"],
  /* ── додано після ревʼю с49 ─────────────────────────────────────────── */
  ["N15 сторож знову рахує клінічний якір каталогу сиротою (дефект 0164)", M65, GUARD,
   "\n         and not exists (select 1 from public.clinics x where x.id = m.entity_id)", ""],
  ["N16 сторож перестав звіряти АРГУМЕНТ тригера (чужий аргумент пройде)", M65, GUARD,
   "like '%tg_change_markers_purge(''' || t.arg || ''')%')",
   "like '%tg_change_markers_purge%')"],
  ["N17 у 0164 задвоєно тригер на кабінети (Map сховав би дубль)", M64, PAIRS,
   "drop trigger if exists trg_zzz_markers_purge on public.rooms;\ncreate trigger trg_zzz_markers_purge\n  after delete on public.rooms\n  for each row execute function public.tg_change_markers_purge('room');",
   "drop trigger if exists trg_zzz_markers_purge on public.rooms;\ncreate trigger trg_zzz_markers_purge\n  after delete on public.rooms\n  for each row execute function public.tg_change_markers_purge('room');\ncreate trigger trg_zzz_markers_purge\n  after delete on public.rooms\n  for each row execute function public.tg_change_markers_purge('room');"],
  ["N18 смоук утратив НЕГАТИВНИЙ контроль сторожа", SMOKE, SMK,
   "raise exception 'СМОУК 0164/7: сирота є, а сторож мовчить — перевірка декоративна';",
   "null;"],
  ["N19 успіх смоука знову невидимий (notice замість exception)", SMOKE, SMK,
   "raise exception 'SMOKE_OK: 0164/0165", "raise notice 'SMOKE_OK: 0164/0165"],
  ["N20 смоук перестав перевіряти клінічний якір каталогу", SMOKE, SMK,
   "raise exception 'СМОУК 0164/8: клінічний якір каталогу порахований сиротою: %',",
   "raise exception 'СМОУК 0164/8: shos ne tak: %',"],
  /* ⚠️ ЯКІР РАХУЄТЬСЯ, А НЕ ПРИБИВАЄТЬСЯ (с51, U-80в). Тут стояло `from 14`, і
     воно протухло на 0166, який довів число перевірок до 15. Це САМОПРОТУХАЮЧИЙ
     клас: будь-який наступний передрук сторожа знову зробив би мутацію
     сліпою — мовчки. Тепер число знімається з живого смоука, а мутація
     ставить `n − 1`. */
  ["N21 один смоук лишився зі старим числом перевірок", SWATCH, PINS,
   `if (v_res ->> 'checked')::int is distinct from ${CHECKED} then`,
   `if (v_res ->> 'checked')::int is distinct from ${CHECKED - 1} then`],
];

const files = [...new Set(M.map((m) => m[1]))];
const orig = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const restore = () => { for (const [f, t] of orig) writeFileSync(f, t); };
/* Канонічні коди сигналів (с50): 1 плутав «стенд знайшов дефект» із «стенд
   убили». */
process.on("SIGINT", () => { restore(); process.exit(130); });
process.on("SIGTERM", () => { restore(); process.exit(143); });
process.on("uncaughtException", (e) => { restore(); console.error(e); process.exit(2); });

const SPEC = "tests/unreadChanges.test.ts tests/invariantsCheckedPins.test.ts";
/* ⚠️ ВЛАСНИЙ звіт, а не спільний `.vt.json` (с51, U-80в). Спільний файл ділили
   `u17-u18`, `u13`, `u33`, `0166` — і під `falsify-all`, який ганяє стенди
   один за одним, застряглий звіт ЧУЖОГО стенда читався б як свій. */
const REPORT = ".falsify-u37.json";

/** ОДИН прогін пари спеків. Повертає `null` РІВНО тоді, коли вимір не
    відбувся — і це окремий стан, а не «зелено». */
function run() {
  rmSync(REPORT, { force: true });
  try {
    execSync(`npx vitest run ${SPEC} --reporter=json --outputFile=${REPORT}`,
      { stdio: "ignore", timeout: 180000 });
  } catch { /* ненульовий код = є червоні, це й треба */ }
  if (!existsSync(REPORT)) return null;
  let j;
  try { j = JSON.parse(readFileSync(REPORT, "utf8")); } catch { return null; }
  const red = [];
  for (const f of j.testResults || []) for (const a of f.assertionResults || []) {
    if (a.status === "failed") red.push(a.fullName);
  }
  /* ⚠️ ГІЛКА `crashed` (канон із с50, сюди не доїхала до с51): набір упав, а
     впалих АСЕРТІВ немає — це зламана збірка/трансформ, а не «сторож дивиться
     не туди». Без цієї перевірки мутація, що ламає SQL до непарсабельності,
     друкувалась як звинувачення сторожу. */
  if (j.success !== true && red.length === 0) return null;
  return red;
}

const lines = ["# Фальсифікація U-37 (0164 + живий передрук сторожа)", ""];
lines.push(`Ціль передруку цього прогону: \`${M65}\`\n`);
let bad = 0;

/* ⚠️ БАЗОВА ЛІНІЯ (с51, U-80в). Її тут не було ЗОВСІМ — тобто всі 21 вердикт
   отримані інструментом, який не перевірив, що до мутацій усе зелене. Саме
   тому шість «сторож не тримає» треба було перечитати після лікування. */
const base = run();
const baseOk = base !== null && base.length === 0;
lines.push(`**БАЗОВА ЛІНІЯ:** ${baseOk ? "ЗЕЛЕНА" : "ЧЕРВОНА"}\n`);
if (!baseOk) {
  bad += M.length;
  lines.push(`⛔ Базова лінія не зелена — стенд НІЧОГО не доводить. ${base === null ? "Прогін не відбувся." : "Червоні: " + base.join(", ")}\n`);
}

for (const [name, file, expectRe, from, to] of baseOk ? M : []) {
  const src = orig.get(file);
  /* ⚠️ УНІКАЛЬНІСТЬ якоря, а не просто «є» (с51, U-80в): два входження означають,
     що мутація править НЕ ТЕ місце, і вердикт про неї нічого не каже. */
  const hits = src.split(from).length - 1;
  if (hits !== 1) {
    bad++;
    lines.push(`- **${name}** — ❌ ЯКІР ${hits === 0 ? "НЕ ЗНАЙДЕНО" : `НЕ УНІКАЛЬНИЙ (${hits})`}`);
    console.log(lines.at(-1)); continue;
  }
  let red = null;
  try {
    /* Функціональна форма заміни: у рядковій `$&`, `$1` тощо тлумачаться як
       спецпослідовності і мовчки псують мутацію. */
    writeFileSync(file, src.replace(from, () => to));
    red = run();
  } finally {
    restore();
  }
  let verdict;
  if (red === null) { bad++; verdict = `❌ ПОМИЛКА — вимір не відбувся (звіт відсутній або мутація зламала збірку)`; }
  else if (!red.length) { bad++; verdict = `⚠️ ЗЕЛЕНИЙ — сторож дивиться не туди`; }
  else if (!red.some((r) => expectRe.test(r))) {   // саме той чи будь-який?
    bad++; verdict = `⚠️ ЧЕРВОНИЙ НЕ ТОЙ (чекали ${expectRe}): ${red.map((r) => `«${r}»`).join("; ")}`;
  } else verdict = `ЧЕРВОНИЙ: ${red.map((r) => `«${r}»`).join("; ")}`;
  lines.push(`- **${name}** → ${verdict}`);
  console.log(lines.at(-1));
}

restore();
rmSync(REPORT, { force: true });
lines.push("", bad ? `## ПІДСУМОК: ${bad} проблемних із ${M.length}` : `## ПІДСУМОК: ${M.length}/${M.length} адресних`);
console.log(lines.at(-1));
writeFileSync("falsify-u37.md", lines.join("\n") + "\n");
console.log("DONE");
if (bad) process.exitCode = 1;

/* U-74: ненайдений/неунікальний якір і «сторож дивиться не туди» — ЧЕРВОНИЙ
   вердикт СТЕНДА, а не рядок у звіті. До с51 код повернення був завжди 0. */
if (bad) {
  console.log(`\n⛔ ВЕРДИКТ: СТЕНД ЧЕРВОНИЙ — ${bad} проблемних позицій. Стенд НЕ доводить нічого.`);
  process.exitCode = 1;
} else console.log(`\n✅ ВЕРДИКТ: стенд зелений.`);
