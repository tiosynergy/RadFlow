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
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";

const M64   = "supabase/migrations/0164_change_markers_purge_on_delete.sql";
const M65   = "supabase/migrations/0165_markers_purge_corrections.sql";
const M0138 = "supabase/migrations/0138_schedule_override_lockdown_and_marker_audience.sql";
const SMOKE = "supabase/smoke/change_markers_purge_smoke.sql";
const SWATCH = "supabase/smoke/invariants_watch_smoke.sql";

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
  ["N21 один смоук лишився зі старим числом перевірок", SWATCH, PINS,
   "if (v_res ->> 'checked')::int is distinct from 14 then",
   "if (v_res ->> 'checked')::int is distinct from 13 then"],
];

const files = [...new Set(M.map((m) => m[1]))];
const orig = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const restore = () => { for (const [f, t] of orig) writeFileSync(f, t); };
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { restore(); process.exit(1); });
process.on("uncaughtException", (e) => { restore(); console.error(e); process.exit(1); });

const SPEC = "tests/unreadChanges.test.ts tests/invariantsCheckedPins.test.ts";
const lines = ["# Фальсифікація U-37 (0164/0165)", ""];
let bad = 0;

for (const [name, file, expectRe, from, to] of M) {
  const src = orig.get(file);
  if (!src.includes(from)) {
    bad++; lines.push(`- **${name}** — ❌ ЯКІР НЕ ЗНАЙДЕНО`); console.log(lines.at(-1)); continue;
  }
  let red = null;
  try {
    rmSync(".vt.json", { force: true });          // (1) чистий звіт на кожен прогін
    writeFileSync(file, src.replace(from, to));
    try {
      execSync(`npx vitest run ${SPEC} --reporter=json --outputFile=.vt.json`,
        { stdio: "ignore", timeout: 180000 });
    } catch { /* ненульовий код = є червоні, це й треба */ }
    try {
      const j = JSON.parse(readFileSync(".vt.json", "utf8"));
      red = [];
      for (const f of j.testResults) for (const a of f.assertionResults) {
        if (a.status === "failed") red.push(a.fullName);
      }
    } catch { red = null; }                        // (2) звіту немає — це ПОМИЛКА
  } finally {
    restore();
  }
  let verdict;
  if (red === null) { bad++; verdict = `❌ ПОМИЛКА — звіт не прочитано (прогін не відбувся?)`; }
  else if (!red.length) { bad++; verdict = `⚠️ ЗЕЛЕНИЙ — сторож дивиться не туди`; }
  else if (!red.some((r) => expectRe.test(r))) {   // (3) саме той чи будь-який?
    bad++; verdict = `⚠️ ЧЕРВОНИЙ НЕ ТОЙ (чекали ${expectRe}): ${red.map((r) => `«${r}»`).join("; ")}`;
  } else verdict = `ЧЕРВОНИЙ: ${red.map((r) => `«${r}»`).join("; ")}`;
  lines.push(`- **${name}** → ${verdict}`);
  console.log(lines.at(-1));
}

restore();
lines.push("", bad ? `## ПІДСУМОК: ${bad} проблемних із ${M.length}` : `## ПІДСУМОК: ${M.length}/${M.length} адресних`);
console.log(lines.at(-1));
writeFileSync("falsify-u37.md", lines.join("\n") + "\n");
console.log("DONE");

/* U-74: ненайдений/неунікальний якір і «сторож дивиться не туди» — ЧЕРВОНИЙ
   вердикт СТЕНДА, а не рядок у звіті. До с51 код повернення був завжди 0. */
if (bad) {
  console.log(`\n⛔ ВЕРДИКТ: СТЕНД ЧЕРВОНИЙ — ${bad} проблемних позицій. Стенд НЕ доводить нічого.`);
  process.exitCode = 1;
} else console.log(`\n✅ ВЕРДИКТ: стенд зелений.`);
