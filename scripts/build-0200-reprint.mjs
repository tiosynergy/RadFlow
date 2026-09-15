// build-0200-reprint.mjs — збирає supabase/migrations/0200_pin_desk_and_waitlist_rpcs.sql
// і scripts/frag/0200_{apply,dryrun,rollback,falsify}.sql.
//
// ЩО РОБИТЬ ПАКЕТ (пункт 4.2 плану; розбір —
// docs/audit/PHASE3-2026-09-15-definer-pin-gap.md §4, §5, §8):
//   три підписи в список перевірки №19 `guard_fn_bodies` — `auth_is_desk()`,
//   `schedule_from_waitlist_rpc`, `set_waitlist_status_rpc`. Список 40 -> 43.
//   `checked` НЕ змінюється (25). Даних пакет не чіпає.
//
// ⚠️ ФОРМА — ПОВНИЙ ПЕРЕДРУК, А НЕ ЯКІРНА ПІДМІНА (знахідка ревʼю с73).
//    `latestReprint()` у семи тестах бере список №19 з ОСТАННЬОГО файла, де
//    рядок ПОЧИНАЄТЬСЯ з create-or-replace сторожа. Якірна міграція такого
//    рядка не має — тест розбирав би список 0198, і `PINNED` на 43 дав би
//    червоне з діагнозом не туди. Чернетка якірної форми лишилась у
//    `claude/drafts/0200_pin_desk_and_waitlist_rpcs.DRAFT.sql` — логіка та
//    сама, форма непридатна.
//
// ⚠️ ДЖЕРЕЛО — 0198, а НЕ 0199: 0199 сторожа не передруковує (замір с74:
//    заголовка передруку в ній немає). Генератор це АСЕРТИТЬ, а не вірить.
//
// ⚠️ РЯДКИ ПІНА ЗНЯТІ НА ПРОДІ, а не пораховані тут — генератор не бачить БД.
//    Формула — гілка `cur` самої №19 (замір 15.09, повторений у с74 перед
//    збіркою: усі три рядки збіглись побайтово, перевантажень немає).
//    Тому фрагмент накату ПЕРЕД передруком проганяє ці три рядки через ТОЙ
//    САМИЙ вираз `cur`, ВИРІЗАНИЙ генератором із тіла сторожа (не переписаний
//    руками): `grant`, виданий між заміром і накатом, зупиняє накат, а не
//    кладе сторожа, червоного з першої секунди.
//
// ⚠️ ЗАМІР с74, який уточнює розбір с73: «`auth_is_desk` — єдиний `auth_*` поза
//    списком №19» — НЕТОЧНО. Поза №19 їх пʼять; чотири (`auth_ceo_clinics`,
//    `auth_is_ceo_of`, `auth_radiologist_case_ok`, `auth_referrer_can_book_room`)
//    досяжні з `anon`, і їхні тіла тримає №22 (по одному ключу `f:` кожна).
//    `auth_is_desk` з `anon` недосяжний — тож він ЄДИНИЙ `auth_*`, якого не
//    пінило НІЩО. Висновок пакета від цього не міняється, формулювання — так.
//
// ⚠️ ПІСЛЯ `npm run db:gate` ЦЕЙ ГЕНЕРАТОР НЕ ЗАПУСКАТИ: він перезаписує файл
//    міграції, чий md5 уже в леджері. Захист: якщо файл уже є і його зміст
//    ІНШИЙ, генератор відмовляється без `--force`.
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const count = (s, needle) => s.split(needle).length - 1;
const FORCE = process.argv.includes("--force");

const MIGDIR = "supabase/migrations";
const SRC_NAME = "0198_guard_self_pin.sql";
const SRC_MIG = `${MIGDIR}/${SRC_NAME}`;
const DST_NAME = "0200_pin_desk_and_waitlist_rpcs.sql";
const DST_MIG = `${MIGDIR}/${DST_NAME}`;
const PREV_LEDGER = "0199_tenant_locks_and_radiologist_oracle.sql";
const PRE_MD5 = "d7f87fff05d4ec8cad62ae2f7df30d19";
const PRE_LEN = 137081;
const PRE_PIN = `guard_body_md5=${PRE_MD5};len=${PRE_LEN}`;

const OPEN = "\nas $function$";
const CLOSE = "\n$function$;";
/** Та сама регулярка, що в `scripts/migration-gate-lib.mjs` і тестах. */
const REPRINT_RE_G = /^create or replace function public\.invariants_check/gm;
const GUARD_PIN_RE =
  /comment on function public\.invariants_check\(boolean\) is '(guard_body_md5=[0-9a-f]{32};len=\d+)';/g;

function split(file) {
  const txt = readFileSync(file, "utf8").replace(/\r/g, "");
  const heads = txt.match(REPRINT_RE_G) || [];
  if (heads.length !== 1) throw new Error(`${file}: заголовків передруку ${heads.length}, а треба 1`);
  const ddl0 = txt.search(/^create or replace function public\.invariants_check/m);
  const a = txt.indexOf(OPEN, ddl0);
  const b = txt.indexOf(CLOSE, a);
  if (a < 0 || b < 0) throw new Error(`${file}: не знайдено межі тіла`);
  if (txt.indexOf(OPEN, a + 1) >= 0) throw new Error(`${file}: \`as $function$\` не один`);
  if (txt.indexOf(CLOSE, b + 1) >= 0) throw new Error(`${file}: \`$function$;\` не один`);
  return {
    raw: txt,
    head: txt.slice(0, ddl0),
    prologue: txt.slice(ddl0, a + OPEN.length),
    body: txt.slice(a + OPEN.length, b + 1),
    tail: txt.slice(b + CLOSE.length),
  };
}

// ---------------------------------------------------------------------------
// 1. БАЗИСИ ДЖЕРЕЛА. Кожен — числом, а не «схоже на те».
// ---------------------------------------------------------------------------
const S98 = split(SRC_MIG);
if (md5(S98.body) !== PRE_MD5 || S98.body.length !== PRE_LEN) {
  throw new Error(`ВИТЯГ ЗЛАМАНИЙ: 0198 дав ${md5(S98.body)} / ${S98.body.length}, а в проді ${PRE_MD5} / ${PRE_LEN}`);
}
if (S98.head + S98.prologue + S98.body + "$function$;" + S98.tail !== S98.raw) {
  throw new Error("СКЛЕЙКА ЗЛАМАНА: 0198 не збирається назад побайтово");
}
{
  const pins = [...S98.raw.matchAll(GUARD_PIN_RE)].map((m) => m[1]);
  if (pins.length !== 1 || pins[0] !== PRE_PIN) {
    throw new Error(`ПІН 0198 у файлі ${JSON.stringify(pins)}, а в проді ${PRE_PIN}`);
  }
}
// 0199 (і все, що після 0198, крім самого 0200) сторожа НЕ передруковує.
{
  const later = readdirSync(MIGDIR)
    .filter((f) => f.endsWith(".sql") && f > SRC_NAME && f !== DST_NAME).sort();
  if (!later.includes(PREV_LEDGER)) throw new Error(`на диску немає ${PREV_LEDGER} — черга не та`);
  for (const f of later) {
    if (/^create or replace function public\.invariants_check/m.test(readFileSync(`${MIGDIR}/${f}`, "utf8"))) {
      throw new Error(`${f} передруковує сторожа — джерелом має бути ВІН, а не 0198`);
    }
  }
  const newest = later[later.length - 1];
  if (newest !== PREV_LEDGER) throw new Error(`після 0199 на диску вже є ${newest} — номер 0200 зайнятий чи черга зсунулась`);
}

// ---------------------------------------------------------------------------
// 2. ТРИ РЯДКИ ПІНА. Зняті на проді формулою `cur` (див. шапку). Порядок у
//    списку косметичний — тест і сторож звіряють МНОЖИНИ, — тож усі три
//    стають одразу після `auth_is_admin()`: стенди якорів у цьому місці не
//    мають (замір с74), а посередині списку їх сім (`falsify-0181/0182/0183`).
// ---------------------------------------------------------------------------
const NEW_ROWS = [
  ["auth_is_desk()", "30c8b71fff4236d07de6dd01706795d2",
    "secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres"],
  ["schedule_from_waitlist_rpc(p_waitlist_id uuid, p_booking jsonb)", "5e0a4b2cc069e604c5eb3634fbad04aa",
    "secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres"],
  ["set_waitlist_status_rpc(p_id uuid, p_status waitlist_status)", "1e04ab4ebb01c08a23d1280b29465d55",
    "secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres"],
];
for (const [fn, body, attrs] of NEW_ROWS) {
  if (/'/.test(fn + body + attrs)) throw new Error(`РЯДОК ${fn}: одинарна лапка зламала б літерал`);
  if (!/^[0-9a-f]{32}$/.test(body)) throw new Error(`РЯДОК ${fn}: md5 не 32 hex`);
  if (!attrs.includes(";acl=")) throw new Error(`РЯДОК ${fn}: без ;acl=`);
}
const rowText = ([fn, body, attrs]) => `      ('${fn}','${body}','${attrs}'),`;
const ADD = NEW_ROWS.map(rowText).join("\n") + "\n";

const ANCHOR_ADMIN =
  "      ('auth_is_admin()','b795042a9dd18520b7a80e466fd231a1','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),\n";

// ---------------------------------------------------------------------------
// 3. ПРОЗА №19. Два місця, обидва — урок самої прози: «0192 оновила сусідній
//    рядок і проминула цей», тож лічильник у заголовку міняється РАЗОМ зі
//    списком, а причина пакета дописується туди, де її шукатиме наступний.
// ---------------------------------------------------------------------------
const PROSE_COUNT_FROM = "ЩО ПІНИМО (сьогодні 40 підписів; ключ";
const PROSE_COUNT_TO = "ЩО ПІНИМО (сьогодні 43 підписи; ключ";

const ANCHOR_PROSE_END =
  "  --        РІШЕННЯ ВЛАСНИКА 14.09 (межа прози №19 вимагає саме цього).\n"
  + "  v_n := v_n + 1;\n";
const PROSE_0200 = [
  "  --     ⚠️ 0200 ДОДАЛА ТРИ: `auth_is_desk()`, `schedule_from_waitlist_rpc`,",
  "  --        `set_waitlist_status_rpc`. Список став 43. Розбір —",
  "  --        `docs/audit/PHASE3-2026-09-15-definer-pin-gap.md` і",
  "  --        `docs/audit/PR-0200-pin-desk-waitlist.md`.",
  "  --        • `auth_is_desk` — не застосовувач, а РІШАЛЬНИК, і вирішує він у",
  "  --          ДВОХ шарах. RLS: пʼять політик (`doctors_desk_insert`,",
  "  --          `doctors_desk_update`, `incidents_desk_insert`,",
  "  --          `incidents_desk_update`, `sched_desk_write`), усі у формі",
  "  --          «свій центр І `auth_is_desk()`» — тіло на `true` відкривало б",
  "  --          ЗАПИС у три таблиці будь-якій ролі СВОГО центру. І гейт усередині",
  "  --          восьми definer-RPC, три з яких у цьому списку вже були",
  "  --          (`emergency_stop_rpc`, `queue_set_status_rpc`,",
  "  --          `submit_incident_rpc`): їхні піни тримали ВИКЛИК, а не рішення.",
  "  --          Замір с74: це ЄДИНИЙ `auth_*`, якого не пінило НІЩО — девʼять",
  "  --          інших у цьому списку, ще чотири досяжні з `anon` і їх тримає №22.",
  "  --          Урок той самий, що з `auth_can_see_slot_details` у 0190;",
  "  --        • дві waitlist-RPC — їхні тіла переписала 0199 (відсічка",
  "  --          радіолога), і результат не тримало ніщо.",
  "  --        ⚠️ ЦІНА: рядок пінує md5 тіла РАЗОМ з `attrs`, тобто і `;acl=`.",
  "  --           Будь-яка правка цих трьох функцій — тіло (і якірна, як у 0199),",
  "  --           `grant`, `revoke`, `alter function`, перейменування параметра —",
  "  --           тепер іде в одній міграції з передруком сторожа. CI цього НЕ",
  "  --           ловить: `PINNED` тримає підписи, а не md5, — червоніє прод.",
  "  --        ⚠️ МЕЖА — і вона НЕ «гучна відмова», як назвав решту розбір с73",
  "  --           (ревʼю с74 це спростувало замірами тіл). Решта 18 definer-",
  "  --           функцій, доступних `authenticated` і поза списком, здебільшого",
  "  --           САМІ несуть гейт: у 12 це `auth_is_admin()` чи `auth_is_desk()`,",
  "  --           у 2 — хелпери направника й радіолога (`auth_can_refer`,",
  "  --           `auth_referrer_can_book_room`, `auth_radiologist_room_ok`), у 2 —",
  "  --           лише `auth.uid()`, дві пошукові гейта не мають.",
  "  --           Вихолощення такого гейта МОВЧАЗНЕ. Обсяг «три» заданий",
  "  --           власником; чи пінити решту — окреме рішення власника, як і",
  "  --           місце `integration_apply_status` (недоступна `authenticated`).",
  "  --        РІШЕННЯ ВЛАСНИКА 15.09 (стартовий промпт с74).",
].join("\n") + "\n";
for (const l of PROSE_0200.split("\n").filter(Boolean)) {
  if (!l.startsWith("  --")) throw new Error(`ПРОЗА: рядок не коментар: ${l}`);
}
for (const bad of ["$q$", "$function$", "/*", "*/", "$apply$"]) {
  if (PROSE_0200.includes(bad)) throw new Error(`ПРОЗА містить ${bad}`);
}

const PAIRS = [
  [ANCHOR_ADMIN, ANCHOR_ADMIN + ADD, "три рядки в список №19 після auth_is_admin()"],
  [PROSE_COUNT_FROM, PROSE_COUNT_TO, "лічильник у заголовку прози №19: 40 -> 43"],
  // Історія росту списку — те саме місце, де проза сама записала урок «оновили
  // сусідній рядок і проминули цей» (знахідка ревʼю с74, лінза Б).
  ["0193 → 40), а заголовок", "0193 → 40, 0200 → 43), а заголовок",
    "історія росту списку в прозі №19: + 0200 → 43"],
  [ANCHOR_PROSE_END,
    "  --        РІШЕННЯ ВЛАСНИКА 14.09 (межа прози №19 вимагає саме цього).\n"
    + PROSE_0200 + "  v_n := v_n + 1;\n",
    "абзац 0200 у прозі №19 перед кроком лічильника"],
];
// Пара i.to не сміє нести from пари j>i: інакше послідовна підстановка
// зачепила б уже вставлене (перевірка з 0193).
for (let i = 0; i < PAIRS.length; i++) {
  for (let j = i + 1; j < PAIRS.length; j++) {
    if (PAIRS[i][1].includes(PAIRS[j][0])) throw new Error(`ПОРЯДОК: «${PAIRS[i][2]}».to несе «${PAIRS[j][2]}».from`);
  }
}

// ---------------------------------------------------------------------------
// 4. ХІД УПЕРЕД. Кожна пара — рівно одне влучання.
// ---------------------------------------------------------------------------
let NEW_BODY = S98.body;
for (const [from, to, lbl] of PAIRS) {
  const hits = count(NEW_BODY, from);
  if (hits !== 1) throw new Error(`ЯКІР «${lbl}»: ${hits} влучань, а треба 1`);
  NEW_BODY = NEW_BODY.split(from).join(to);
}
const NEW_MD5 = md5(NEW_BODY);
const NEW_LEN = NEW_BODY.length;
const PIN = `guard_body_md5=${NEW_MD5};len=${NEW_LEN}`;
if (!/^guard_body_md5=[0-9a-f]{32};len=[0-9]+$/.test(PIN)) {
  throw new Error(`ПІН не збігається з регуляркою перевірки №25: ${PIN}`);
}
{
  const want = PRE_LEN + PAIRS.reduce((s, [f, t]) => s + t.length - f.length, 0);
  if (NEW_LEN !== want) throw new Error(`ДОВЖИНА ${NEW_LEN}, а з пар виходить ${want}`);
}

// ---------------------------------------------------------------------------
// 5. ЗМІСТОВІ ПЕРЕВІРКИ. Кожна — з очікуваним ЧИСЛОМ.
// ---------------------------------------------------------------------------
/** Той самий вирізувач, що в `tests/guardFnBodiesInvariant.test.ts`. */
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
const ROW_RE = /^ {6}\('[A-Za-z0-9_]+\([^)]*\)','[0-9a-f]{32}','[^']*'\),?$/gm;
const listOf = (body) => {
  const open = "with expd(fn, body, attrs) as (values";
  const close = "    ), cur as (";
  if (count(body, open) !== 1 || count(body, close) !== 1) throw new Error("межі списку №19 не унікальні");
  const a = body.indexOf(open);
  return body.slice(a + open.length, body.indexOf(close, a));
};
const sigsOf = (list) => (list.match(ROW_RE) || []).map((r) => r.slice(r.indexOf("('") + 2, r.indexOf("',")));

const OLD_SIGS = sigsOf(listOf(S98.body));
const NEW_SIGS = sigsOf(listOf(NEW_BODY));
const WANT_SIGS = new Set([...OLD_SIGS, ...NEW_ROWS.map((r) => r[0])]);
const OLD_CODE = codeOf(S98.body);
const NEW_CODE = codeOf(NEW_BODY);

const CHECKS = [
  ["у старому списку 40 підписів", OLD_SIGS.length, 40],
  ["жодного з трьох підписів у старому тілі", NEW_ROWS.filter((r) => S98.body.includes(`('${r[0]}',`)).length, 0],
  ["у новому списку 43 розпізнаних рядки", NEW_SIGS.length, 43],
  ["усі рядки нового списку розпізнано (формат не поїхав)",
    listOf(NEW_BODY).split("\n").filter((l) => l.trim().startsWith("('")).length, 43],
  ["множина = стара ∪ три нові, без дублів", new Set(NEW_SIGS).size === WANT_SIGS.size
    && NEW_SIGS.every((s) => WANT_SIGS.has(s)) ? 1 : 0, 1],
  ["`;acl=` у КОЖНОМУ рядку нового списку",
    (listOf(NEW_BODY).match(/^ {6}\('[^']+','[0-9a-f]{32}','[^']*;acl=[^']*'\),?$/gm) || []).length, 43],
  ["кожен новий рядок трапляється в тілі рівно раз",
    NEW_ROWS.filter((r) => count(NEW_BODY, rowText(r)) === 1).length, 3],
  ["лічильник перевірок не змінився (25)", count(NEW_BODY, "v_n := v_n + 1;"), 25],
  ["мітка №19 на місці рівно раз у звіті", count(NEW_CODE, "'check', 'guard_fn_bodies'"), 1],
  ["заголовок прози каже 43", count(NEW_BODY, "ЩО ПІНИМО (сьогодні 43 підписи"), 1],
  ["заголовок прози більше не каже 40", count(NEW_BODY, "сьогодні 40 підписів"), 0],
  ["історія росту списку дописана", count(NEW_BODY, "0193 → 40, 0200 → 43)"), 1],
  ["рішення власника 15.09 назване в прозі", count(NEW_BODY, "РІШЕННЯ ВЛАСНИКА 15.09"), 1],
  // ⚠️ ГОЛОВНИЙ БАЗИС: у КОДІ (без коментарів) змінилось РІВНО одне — додано
  //    три рядки. Проза сюди не входить за побудовою, а будь-яка випадкова
  //    правка виразу, гейта чи гілки дала б тут 0.
  ["код без коментарів = код 0198 + три рядки, і більше нічого",
    count(NEW_CODE, ADD) === 1 && NEW_CODE.split(ADD).join("") === OLD_CODE ? 1 : 0, 1],
];
for (const [lbl, got, want] of CHECKS) {
  if (got !== want) throw new Error(`ЗМІСТ: «${lbl}» — ${got}, а треба ${want}`);
}

// ⚠️ ЗВОРОТНИЙ ХІД має власний базис (урок 0196).
{
  let back = NEW_BODY;
  for (let i = PAIRS.length - 1; i >= 0; i--) {
    const [from, to, lbl] = PAIRS[i];
    const hits = count(back, to);
    if (hits !== 1) throw new Error(`ЗВОРОТНИЙ ЯКІР «${lbl}»: ${hits} влучань, а треба 1`);
    back = back.split(to).join(from);
  }
  if (md5(back) !== PRE_MD5 || back.length !== PRE_LEN) {
    throw new Error(`ЗВОРОТНИЙ ХІД дав ${md5(back)} / ${back.length}, а 0198 це ${PRE_MD5} / ${PRE_LEN}`);
  }
}

// ---------------------------------------------------------------------------
// 6. ВИРАЗ `cur` — ВИРІЗАНИЙ із тіла сторожа, а не переписаний руками. Ним
//    фрагмент накату звіряє три рядки з живою БД. Межі — ті самі, що у виразі
//    `CUR` тесту; вираз не змінився (базис «код = код 0198 + рядки» вище).
// ---------------------------------------------------------------------------
const CUR_EXPR = (() => {
  // ⚠️ Відступ ЧОТИРИ пробіли — і це не косметика: `  ), cur as (` із двома
  //    стоїть ще в №22 і №23 (перший прогін генератора впав саме тут). Тест
  //    ріже в межах BLOCK19; генератор тіла №19 окремо не має, тож тримає
  //    унікальність відступом і перевіряє, що виріз закінчується ДО мітки №19.
  const open = "    ), cur as (";
  const close = "\n    )\n    select";
  if (count(NEW_BODY, open) !== 1) throw new Error("якір `    ), cur as (` у тілі не 1");
  const a = NEW_BODY.indexOf(open);
  const b = NEW_BODY.indexOf(close, a);
  const label = NEW_BODY.indexOf("'check', 'guard_fn_bodies'", a);
  if (b < 0 || label < 0 || b > label) throw new Error("термінатор виразу cur не знайдено до мітки №19");
  return NEW_BODY.slice(a + open.length, b);
})();
for (const [lbl, re] of [
  ["джерело pg_proc", /from pg_proc p\n/],
  ["мова з pg_language", /join pg_language l on l\.oid = p\.prolang/],
  ["повний md5 нормалізованого тіла", /md5\(btrim\(regexp_replace\(/],
  ["поле ;acl= з двома гілками", /';acl='\s*\|\|\s*case when p\.proacl is null then '<default>'/],
  ["розширення по голому імені зі expd", /p\.proname = any \(select split_part\(e\.fn, '\(', 1\) from expd e\)/],
]) {
  if (!re.test(CUR_EXPR)) throw new Error(`ВИРАЗ cur: немає «${lbl}» — виріз поїхав`);
}
if (/--|\/\*|\$/.test(CUR_EXPR)) throw new Error("ВИРАЗ cur містить коментар або долар — у фрагмент його так не вставити");

// ---------------------------------------------------------------------------
// 7. МЕХАНІЧНА ЗВІРКА СТЕНДОВИХ ЯКОРІВ (заведено в 0196). Евристика, і вона
//    названа: стенд, що склеює якір із шматків, цим не ловиться — для того і
//    повна ревізія `falsify-all.mjs`. Ловиться дві речі:
//    (а) текст `from`, що ЗНИК із тіла, але лишився у стенді;
//    (б) 60-символьне вікно навколо точки вставки в СТАРОМУ тілі, якого в
//        новому більше немає (якір через межу рядків).
//    ⚠️ Виняток — стенд, що ПОІМЕННО читає старий файл міграції, де цей текст
//       живе й далі (так `falsify-0193-room-gate` мутує саме 0193, а не
//       останній передрук). Інакше звірка червоніла б на чесному стенді.
// ---------------------------------------------------------------------------
{
  const stands = readdirSync("scripts").filter((f) => /^falsify-.*\.mjs$/.test(f));
  if (stands.length < 30) {
    throw new Error(`ЯКОРІ: лише ${stands.length} файлів за маскою falsify-*.mjs — очікувалось ≥30`);
  }
  const migs = readdirSync(MIGDIR).filter((f) => f.endsWith(".sql") && f !== DST_NAME);
  const probes = [];
  for (const [from, to, lbl] of PAIRS) {
    if (!NEW_BODY.includes(from)) probes.push([from, `${lbl} (from зник)`]);
    /* ⚠️ Вікна — навколо ЗМІНЕНОГО ПРОМІЖКУ, а не навколо меж `from` (знахідка
       ревʼю с74, лінза Б). У пар «вставка всередину якоря» зміна лежить МІЖ
       межами `from`, і вікна на його краях її не бачили. Проміжок = `from` без
       спільного з `to` префікса і суфікса. */
    let p = 0;
    while (p < from.length && p < to.length && from[p] === to[p]) p++;
    let s = 0;
    while (s < from.length - p && s < to.length - p
      && from[from.length - 1 - s] === to[to.length - 1 - s]) s++;
    const i = S98.body.indexOf(from);
    for (const [edge, side] of [[i + p, "початку"], [i + from.length - s, "кінця"]]) {
      const w = S98.body.slice(Math.max(0, edge - 30), edge + 30);
      if (!NEW_BODY.includes(w)) probes.push([w, `${lbl} (вікно ${side} зміни)`]);
    }
  }
  const stale = [];
  for (const f of stands) {
    const txt = readFileSync(`scripts/${f}`, "utf8").replace(/\r/g, "");
    const named = migs.filter((m) => txt.includes(`${MIGDIR}/${m}`) && m !== SRC_NAME);
    for (const [probe, lbl] of probes) {
      if (!txt.includes(probe)) continue;
      const livesInNamed = named.some((m) =>
        readFileSync(`${MIGDIR}/${m}`, "utf8").replace(/\r/g, "").includes(probe));
      if (!livesInNamed) stale.push(`${f} ← ${lbl}`);
    }
  }
  if (stale.length) throw new Error(`ЯКОРІ ПРОТУХЛИ:\n  ${stale.join("\n  ")}`);
  console.log(`  якорі стендів: ${stands.length} файлів, ${probes.length} зондів, 0 протухлих`);
}

// ---------------------------------------------------------------------------
// 8. ФРАГМЕНТИ. Долар-лапки: $p$ — рядки підстановок; блоки — $apply$/$dryrun$/
//    $back$/$falsify$, тіло мутації M1 — $m1$. Жоден текст не сміє нести чужий
//    тег. ⚠️ Зонди якорів у розділі 7 — евристика: якір коротший за вікно, що
//    перетинає зміну, не ловиться; для того повна ревізія `falsify-all.mjs`.
// ---------------------------------------------------------------------------
for (const t of ["$p$", "$apply$", "$dryrun$", "$back$", "$falsify$", "$m1$"]) {
  for (const [f, to, lbl] of PAIRS) {
    if ((f + to).includes(t)) throw new Error(`пара «${lbl}» містить тег ${t} — змініть долар-лапки`);
  }
  if (CUR_EXPR.includes(t)) throw new Error(`вираз cur містить тег ${t}`);
}
const q = (s) => `$p$${s}$p$`;
const arr = (xs) => "array[\n" + xs.map((x) => `    ${q(x)}`).join(",\n") + "\n  ]";

const PRE = [
  "  perform set_config('lock_timeout', '5s', true);",
  "  -- Шлях фіксуємо явно: інакше читання pg_proc залежало б від налаштування",
  "  -- ролі оператора (урок 0196).",
  "  perform set_config('search_path', 'public, pg_temp', true);",
  "  if current_user <> 'postgres' then",
  "    raise exception '0200: мусить іти від ролі postgres, а йде від %', current_user;",
  "  end if;",
].join("\n");

const LEDGER_GUARDS = [
  `  if exists (select 1 from public.migration_ledger where name = '${DST_NAME}') then`,
  "    raise exception '0200: рядок уже в леджері — повторний накат заборонено';",
  "  end if;",
  `  if not exists (select 1 from public.migration_ledger where name = '${PREV_LEDGER}') then`,
  "    raise exception '0200: у леджері немає 0199 — накат не в свою чергу';",
  "  end if;",
  "  if (select max(name) from public.migration_ledger) is distinct from",
  `     '${PREV_LEDGER}' then`,
  "    raise exception '0200: останній рядок леджера % — не 0199, черга зсунулась',",
  "      (select max(name) from public.migration_ledger);",
  "  end if;",
].join("\n");

const readGuard = (tag, wantMd5, wantLen, wantPin, what) => [
  "  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body",
  "    from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  "   where n.nspname = 'public' and p.proname = 'invariants_check'",
  "     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';",
  "  if v_body is null then",
  `    raise exception '${tag}: invariants_check не знайдено';`,
  "  end if;",
  "  v_src := replace(v_body, chr(13), '');",
  `  if md5(v_src) is distinct from '${wantMd5}' or length(v_src) <> ${wantLen} then`,
  `    raise exception '${tag}: у проді не ${what} (% / %) — правка наосліп заборонена', md5(v_src), length(v_src);`,
  "  end if;",
  "  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);",
  "  -- ⚠️ САМОПІН №25 мусить збігатися з тілом ДО правки. Якщо ні — на проді",
  "  --    вже дрейф, і чинити його цим пакетом не можна.",
  "  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc')",
  `     is distinct from '${wantPin}' then`,
  `    raise exception '${tag}: самопін % не збігається з тілом ${what} — спершу розібратись',`,
  "      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');",
  "  end if;",
].join("\n");

const EXPD_ROWS = NEW_ROWS.map(rowText).join("\n").replace(/,$/, "");
const LIVE_ROWS = [
  "  -- ── Живі рядки трьох функцій — ТИМ САМИМ виразом `cur`, вирізаним ────────",
  "  --    генератором із тіла сторожа. Генератор БД не бачить, рядки зняті",
  "  --    замірами 15.09 і с74; `grant` чи правка тіла між заміром і накатом",
  "  --    зупиняють накат ТУТ, а не кладуть червоного сторожа.",
  "  select count(*) into v_hits",
  "    from pg_proc p",
  "   where p.pronamespace = 'public'::regnamespace",
  "     and p.proname in ('auth_is_desk', 'schedule_from_waitlist_rpc', 'set_waitlist_status_rpc');",
  "  if v_hits <> 3 then",
  "    raise exception '0200: обʼєктів із трьома іменами % замість 3 — перевантаження дало б extra: одразу після накату', v_hits;",
  "  end if;",
  "  with expd(fn, body, attrs) as (values",
  EXPD_ROWS,
  "    ), cur as (" + CUR_EXPR,
  // (виріз починається одразу ПІСЛЯ `    ), cur as (`, тож якір повторюємо тут)
  "    )",
  "  select array_agg(x.txt order by x.txt) into v_bad",
  "    from (",
  "      select 'missing:' || e.fn as txt from expd e",
  "       where not exists (select 1 from cur c where c.fn = e.fn)",
  "      union all",
  "      select 'body:' || e.fn || '->' || c.body from expd e join cur c on c.fn = e.fn",
  "       where c.body <> e.body",
  "      union all",
  "      select 'attrs:' || e.fn || '->' || c.attrs from expd e join cur c on c.fn = e.fn",
  "       where c.attrs <> e.attrs",
  "      union all",
  "      select 'extra:' || c.fn from cur c",
  "       where not exists (select 1 from expd e where e.fn = c.fn)",
  "    ) x;",
  "  if v_bad is not null then",
  "    raise exception '0200: живі рядки не збіглися з піном — перезняти замір, а не накатувати: %', v_bad;",
  "  end if;",
].join("\n");

const substitute = (tag, fromVar, toVar, lblVar, wantMd5, wantLen, what) => [
  "  v_new := v_src;",
  `  for i in 1 .. array_length(${fromVar}, 1) loop`,
  `    v_hits := (length(v_new) - length(replace(v_new, ${fromVar}[i], ''))) / length(${fromVar}[i]);`,
  "    if v_hits <> 1 then",
  `      raise exception '${tag}: якір «%» трапляється % раз(ів), а треба 1', ${lblVar}[i], v_hits;`,
  "    end if;",
  `    v_new := replace(v_new, ${fromVar}[i], ${toVar}[i]);`,
  "  end loop;",
  `  if md5(v_new) is distinct from '${wantMd5}' or length(v_new) <> ${wantLen} then`,
  `    raise exception '${tag}: підстановка дала % / %, а ${what} це ${wantMd5} / ${wantLen}',`,
  "      md5(v_new), length(v_new);",
  "  end if;",
  "  execute v_head || v_new || '$function$';",
  "",
  "  select replace(p.prosrc, chr(13), '') into v_src",
  "    from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  "   where n.nspname = 'public' and p.proname = 'invariants_check'",
  "     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';",
  `  if md5(v_src) is distinct from '${wantMd5}' or length(v_src) <> ${wantLen} then`,
  `    raise exception '${tag}: у БД лягло % / % замість ${wantMd5} / ${wantLen}', md5(v_src), length(v_src);`,
  "  end if;",
].join("\n");

const pinBlock = (tag, wantPin) => [
  "  -- ── Самопін №25 — у ТІЙ САМІЙ транзакції, інакше сторож червоніє ────────",
  "  -- ⚠️ Пін БЕРЕТЬСЯ З БД і лише потім звіряється з тим, що порахував",
  "  --    генератор: `length()` у Postgres рахує СИМВОЛИ, `.length` у JS —",
  "  --    одиниці UTF-16. Розбіжність ЗУПИНЯЄ накат (урок 0198).",
  "  v_pin_db := 'guard_body_md5=' || md5(v_src) || ';len=' || length(v_src);",
  `  if v_pin_db is distinct from '${wantPin}' then`,
  `    raise exception '${tag}: пін із БД (%) розійшовся з піном із файлу (${wantPin})', v_pin_db;`,
  "  end if;",
  "  execute format('comment on function public.invariants_check(boolean) is %L', v_pin_db);",
  "  -- Читання НАЗАД: `comment on` мовчазний, «виконалось» — не доказ.",
  "  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc') is distinct from v_pin_db then",
  `    raise exception '${tag}: пін не ліг — у коментарі %',`,
  "      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');",
  "  end if;",
].join("\n");

const DECL = (tag, fromXs, toXs, lblXs) => [
  `do $${tag}$`,
  "declare",
  "  v_def text; v_body text; v_src text; v_head text; v_new text;",
  "  v_hits int; v_rows int; v_res jsonb; v_pin_db text; v_bad text[];",
  `  v_from constant text[] := ${arr(fromXs)};`,
  `  v_to   constant text[] := ${arr(toXs)};`,
  `  v_lbl  constant text[] := ${arr(lblXs)};`,
  "begin",
].join("\n");

const FWD = [PAIRS.map((p) => p[0]), PAIRS.map((p) => p[1]), PAIRS.map((p) => p[2])];
const BWD = [[...PAIRS].reverse().map((p) => p[1]), [...PAIRS].reverse().map((p) => p[0]),
  [...PAIRS].reverse().map((p) => `назад: ${p[2]}`)];

const LEDGER_INSERT = [
  "  -- ⚠️ БЕЗ `on conflict do nothing` (ревʼю с74, лінза А): рядок, вставлений",
  "  --    паралельною сесією між перевіркою і вставкою, мусить ВАЛИТИ накат, а не",
  "  --    мовчки лишати тіло й пін закоміченими поверх чужого рядка.",
  "  insert into public.migration_ledger (name)",
  `  values ('${DST_NAME}');`,
  "  get diagnostics v_rows = row_count;",
  "  if v_rows <> 1 then",
  "    raise exception '0200: рядок леджера не ліг (% рядків)', v_rows;",
  "  end if;",
].join("\n");

/** Читання назад ОКРЕМИМ стейтментом того ж запиту: `raise notice` через MCP
 *  не повертається, тож без цього «успіх» накату був би невидимий (ревʼю с74). */
const READBACK = [
  "select md5(replace(p.prosrc, chr(13), '')) as guard_md5,",
  "       length(replace(p.prosrc, chr(13), '')) as guard_len,",
  "       obj_description(p.oid, 'pg_proc') as guard_pin,",
  "       (select count(*) from public.migration_ledger) as ledger_rows,",
  "       (select max(name) from public.migration_ledger) as ledger_last",
  "  from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  " where n.nspname = 'public' and p.proname = 'invariants_check'",
  "   and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';",
].join("\n");

const BODY_FWD = [
  PRE,
  LEDGER_GUARDS,
  readGuard("0200", PRE_MD5, PRE_LEN, PRE_PIN, "0198"),
  "",
  LIVE_ROWS,
  "",
  "  -- ── Передрук сторожа: + три рядки списку №19, + проза ───────────────────",
  substitute("0200", "v_from", "v_to", "v_lbl", NEW_MD5, NEW_LEN, "файл 0200"),
  "",
  pinBlock("0200", PIN),
  "",
  LEDGER_INSERT,
].join("\n");

const APPLY = [
  "-- 0200 APPLY — ЗГЕНЕРОВАНО `node scripts/build-0200-reprint.mjs`. Одним запитом,",
  "-- ОДНА транзакція.",
  "-- ⚠️ Канонічний файл міграції накатувати НЕ можна: передрук і пін там — два",
  "--    верхньорівневі стейтменти, тобто дві транзакції; обрив між ними лишає",
  "--    нове тіло зі СТАРИМ піном, і №25 червоніє одразу (урок 0198).",
  DECL("apply", ...FWD),
  BODY_FWD,
  "",
  "  raise notice 'APPLY_0200_OK guard=% len=% pin=% ledger=%',",
  "    md5(v_src), length(v_src), v_pin_db, (select count(*) from public.migration_ledger);",
  "end;",
  "$apply$;",
  "",
  "-- Читання назад: очікування",
  `--   guard_md5 = ${NEW_MD5}, guard_len = ${NEW_LEN},`,
  `--   guard_pin = ${PIN}, ledger_rows = 200, ledger_last = ${DST_NAME}`,
  READBACK,
  "",
  "-- ⚠️ `invariants_check` — ОКРЕМИМ запитом ПІСЛЯ commit (≈9–15 с). Не поруч з",
  "--    іншим деплоєм чи DDL: сторож тримає AccessShare на таблицях, що читає, і",
  "--    DDL у черзі за ним поставив би в чергу запити продукту (ревʼю с74).",
  "--    І не в 03:45–04:05 UTC: там крон `invariants` пише результат із",
  "--    `ledger_md5` червоною, доки `npm run db:gate` не проштампував рядок.",
  "--      select public.invariants_check(false);",
  "--      -- очікування: checked 25; до `npm run db:gate` єдиний ОЧІКУВАНИЙ",
  "--      -- порушник — `ledger_md5` (md5 файла ще не проштамповано).",
].join("\n");

const DRYRUN = [
  "-- 0200 DRY RUN — ЗГЕНЕРОВАНО `node scripts/build-0200-reprint.mjs`. Те саме, що",
  "-- APPLY, але транзакція СВІДОМО валиться в кінці.",
  "-- ⚠️ Маркер відкоту ОБОВʼЯЗКОВИЙ: «сухий» прогін без нього — це НАКАТ",
  "--    (урок 0195: execute_sql жене батч однією транзакцією).",
  "-- ⚠️ Тег блоку — dryrun, а не apply: перші ~185 рядків тут збігаються з",
  "--    APPLY, і переплутаний файл закомітив би прод (ревʼю с74, лінза А).",
  "--    Перед вставкою перевірити, що запит ПОЧИНАЄТЬСЯ з тегу dryrun.",
  DECL("dryrun", ...FWD),
  BODY_FWD,
  "",
  "  -- Сторожа кличемо ТУТ, бо прогін усе одно відкотиться: треба бачити",
  "  -- `checked = 25` і зелені №19 та №25 ДО того, як чіпати прод.",
  "  v_res := public.invariants_check(false);",
  "  if (v_res->>'checked')::int <> 25 then",
  "    raise exception '0200-суха: сторож перевірив % замість 25', v_res->>'checked';",
  "  end if;",
  "  -- ⚠️ Окремо — що САМЕ №19 і №25 зелені. «checked=25» означає лише",
  "  --    «перевірки виконались», а не «пін звівся».",
  "  if exists (select 1 from jsonb_array_elements(v_res->'failed') e",
  "              where e.value->>'check' in ('guard_fn_bodies', 'guard_self_pin')) then",
  "    raise exception '0200-суха: №19 або №25 ЧЕРВОНА одразу після передруку: %', v_res->'failed';",
  "  end if;",
  "",
  "  raise exception 'DRYRUN_0200_ROLLBACK guard=% len=% pin=% checked=% ok=% failed=%',",
  "    md5(v_src), length(v_src), v_pin_db, v_res->>'checked', v_res->>'ok', v_res->'failed';",
  "end;",
  "$dryrun$;",
  "",
  "-- ⚠️ `ledger_md5` у сухому прогоні червона ОЧІКУВАНО: md5 рядка штампує",
  "--    `npm run db:gate` після коміту файла (так само в 0197 і 0198).",
].join("\n");

const ROLLBACK = [
  "-- 0200 ROLLBACK — ЗГЕНЕРОВАНО `node scripts/build-0200-reprint.mjs`.",
  "-- Повертає тіло сторожа до 0198, ПОВЕРТАЄ самопін 0198 і знімає рядок леджера.",
  "--",
  "-- ⚠️ Пін НЕ знімається, а повертається: до 0200 він БУВ (0198). Зняти його —",
  "--    зробити №25 червоною на гілці «пін ВІДСУТНІЙ».",
  "-- ⚠️ Одна транзакція: проміжний стан «тіло 0198, пін 0200» існує лише всередині",
  "--    неї і назовні не видний.",
  DECL("back", ...BWD),
  PRE,
  `  if not exists (select 1 from public.migration_ledger where name = '${DST_NAME}') then`,
  "    raise exception '0200-відкат: рядка 0200 у леджері немає — відкочувати нічого';",
  "  end if;",
  "  -- ⚠️ 0200 мусить бути ОСТАННІМ рядком (ревʼю с74, обидві лінзи): інакше",
  "  --    відкат вирізав би рядок із середини історії, а наступник міг на 0200",
  "  --    спиратися.",
  "  if (select max(name) from public.migration_ledger) is distinct from",
  `     '${DST_NAME}' then`,
  "    raise exception '0200-відкат: після 0200 уже накатано % — спершу відкотити його',",
  "      (select max(name) from public.migration_ledger);",
  "  end if;",
  readGuard("0200-відкат", NEW_MD5, NEW_LEN, PIN, "0200"),
  "",
  substitute("0200-відкат", "v_from", "v_to", "v_lbl", PRE_MD5, PRE_LEN, "0198"),
  "",
  pinBlock("0200-відкат", PRE_PIN),
  "",
  `  delete from public.migration_ledger where name = '${DST_NAME}';`,
  "  get diagnostics v_rows = row_count;",
  "  if v_rows <> 1 then",
  "    raise exception '0200-відкат: знято % рядків леджера замість 1', v_rows;",
  "  end if;",
  "",
  "  raise notice 'ROLLBACK_0200_OK guard=% len=% pin=% ledger=%',",
  "    md5(v_src), length(v_src), v_pin_db, (select count(*) from public.migration_ledger);",
  "end;",
  "$back$;",
  "",
  "-- Читання назад: очікування",
  `--   guard_md5 = ${PRE_MD5}, guard_len = ${PRE_LEN},`,
  `--   guard_pin = ${PRE_PIN}, ledger_rows = 199, ledger_last = ${PREV_LEDGER}`,
  READBACK,
  "",
  "-- ⚠️ ЦЕЙ ФРАГМЕНТ НЕ ДОВОДИТЬ ВІДКАТУ: усі асерти вище — УСЕРЕДИНІ транзакції.",
  "--    Після commit ОКРЕМИМ запитом:",
  "--      select md5(replace(p.prosrc, chr(13), '')) as body, length(p.prosrc) as len,",
  "--             obj_description(p.oid, 'pg_proc') as pin",
  "--        from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  "--       where n.nspname = 'public' and p.proname = 'invariants_check';",
  `--      -- очікування: body = ${PRE_MD5}, len = ${PRE_LEN}, pin = ${PRE_PIN}`,
  "--      select public.invariants_check(false);   -- checked 25",
  "--    Git-частина — див. секцію ВІДКАТ у файлі міграції.",
].join("\n");

const FALSIFY = [
  "-- 0200 FALSIFY — ЗГЕНЕРОВАНО `node scripts/build-0200-reprint.mjs`.",
  "-- Пін мусить ЛОВИТИ, а не лише лягти. Три мутації — по одній на КОЖЕН новий",
  "-- рядок і на КОЖНУ частину рядка (тіло, cfg=, acl=), — один прогін сторожа,",
  "-- і транзакція СВІДОМО валиться в кінці.",
  "-- ⚠️ Маркер відкоту ОБОВʼЯЗКОВИЙ і безумовний: `raise exception` стоїть у",
  "--    КОЖНІЙ гілці. Перевіряти предстан — ОКРЕМИМ запитом після (див. кінець).",
  "-- ⚠️ Вердикт вимагає РІВНО три порушники №19, кожен зі своїм підписом: зайвий",
  "--    (дрейф до мутацій, або мутація зачепила ще й attrs) — це теж FAIL.",
  "do $falsify$",
  "declare",
  "  v_res jsonb; v_off text[]; v_miss text[];",
  "  v_want constant text[] := array[",
  "    'body:auth_is_desk()->',",
  "    'attrs:schedule_from_waitlist_rpc(p_waitlist_id uuid, p_booking jsonb)->',",
  "    'attrs:set_waitlist_status_rpc(p_id uuid, p_status waitlist_status)->'",
  "  ];",
  "begin",
  PRE.replaceAll("0200:", "0200-фальсифікація:"),
  `  if not exists (select 1 from public.migration_ledger where name = '${DST_NAME}') then`,
  "    raise exception '0200-фальсифікація: 0200 не накатано — фальсифікувати нічого';",
  "  end if;",
  "  -- Предстан — тіло і пін саме 0200 (ревʼю с74, лінза А): інакше FAIL вказав би",
  "  -- не на ту причину.",
  "  if (select md5(replace(p.prosrc, chr(13), '')) || '/' || length(replace(p.prosrc, chr(13), ''))",
  "             || '|' || coalesce(obj_description(p.oid, 'pg_proc'), '(NULL)')",
  "        from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  "       where n.nspname = 'public' and p.proname = 'invariants_check'",
  "         and pg_get_function_identity_arguments(p.oid) = 'p_write boolean')",
  `     is distinct from '${NEW_MD5}/${NEW_LEN}|${PIN}' then`,
  "    raise exception '0200-фальсифікація: у проді не тіло/пін 0200 — спершу розібратись';",
  "  end if;",
  "",
  "  -- M1: РІШАЛЬНИК вихолощено — рівно та підміна, заради якої пакет. Атрибути",
  "  --     ті самі, тож червоніти мусить лише `body:`.",
  "  create or replace function public.auth_is_desk()",
  "    returns boolean language sql stable security definer",
  "    set search_path = public, pg_temp",
  "  as $m1$ select true $m1$;",
  "  -- M2: ЗНАЧЕННЯ search_path (його стереже лише `cfg=` цього списку, №2",
  "  --     вимагає тільки наявності).",
  "  alter function public.schedule_from_waitlist_rpc(uuid, jsonb) set search_path = pg_temp, public;",
  "  -- M3: право виконання забрано (`;acl=`).",
  "  revoke execute on function public.set_waitlist_status_rpc(uuid, public.waitlist_status) from authenticated;",
  "",
  "  v_res := public.invariants_check(false);",
  "  select array_agg(o.value order by o.value) into v_off",
  "    from jsonb_array_elements(v_res->'failed') e,",
  "         jsonb_array_elements_text(e.value->'offenders') o",
  "   where e.value->>'check' = 'guard_fn_bodies';",
  "  select array_agg(w) into v_miss from unnest(v_want) w",
  "   where not exists (select 1 from unnest(coalesce(v_off, '{}')) o where starts_with(o, w));",
  "",
  "  raise exception 'FALSIFY_0200_ROLLBACK verdict=% offenders=% missed=% other_failed=%',",
  "    case when v_miss is null and coalesce(array_length(v_off, 1), 0) = 3 then 'PASS' else 'FAIL' end,",
  "    v_off, v_miss,",
  "    (select jsonb_agg(e.value->>'check') from jsonb_array_elements(v_res->'failed') e",
  "      where e.value->>'check' <> 'guard_fn_bodies');",
  "end;",
  "$falsify$;",
  "",
  "-- ⚠️ ПІСЛЯ — окремим запитом, що прод не змінився: сирий md5 тут нічого не",
  "--    доведе (у списку — нормалізований), тож доказ — сам сторож:",
  "--      select public.invariants_check(false);",
  "--      -- очікування: `guard_fn_bodies` ВІДСУТНЯ в failed, checked 25",
  "--      -- (до `npm run db:gate` у failed лишається лише `ledger_md5`).",
].join("\n");

// ---------------------------------------------------------------------------
// 9. ФАЙЛ МІГРАЦІЇ.
//    ⚠️ Шапка НЕ сміє містити фразу create-or-replace сторожа одним рядком:
//       `tests/privilegeSurface.test.ts` шукає її `indexOf` БЕЗ якоря на
//       початок рядка і взяв би тіло від коментаря. Асерт нижче.
// ---------------------------------------------------------------------------
const MIG_HEAD = [
  "-- ============================================================================",
  "--  RadFlow — Міграція 0200: три підписи в список перевірки №19 guard_fn_bodies.",
  "--",
  "--  Максимальна ЗАСТОСОВАНА на момент написання — 0199.",
  "--  Даних НЕ чіпає. `checked` НЕ змінюється (25). Список №19: 40 -> 43.",
  "--",
  "--  ЗВІДКИ ПАКЕТ. Пункт 4.2 плану `docs/audit/PLAN-audit-completion-2026-09-13.md`;",
  "--  розбір — `docs/audit/PHASE3-2026-09-15-definer-pin-gap.md` (§4, §5, §8).",
  "--  Замір 15.09: SECURITY DEFINER у `public` — 115; доступних `authenticated` —",
  "--  44; із них недосяжних з `anon` і ПОЗА списком №19 — 21. Пінуються ТРИ:",
  "--",
  "--  1. `auth_is_desk()` — не застосовувач рішення, а РІШАЛЬНИК, у двох шарах.",
  "--     RLS: пʼять політик (doctors_desk_insert, doctors_desk_update,",
  "--     incidents_desk_insert, incidents_desk_update, sched_desk_write), усі у",
  "--     формі «свій центр І auth_is_desk()». Тіло на `true` відкривало б ЗАПИС у",
  "--     три таблиці будь-якій ролі СВОГО центру — при зеленому сторожі. І гейт",
  "--     усередині восьми definer-RPC; три з них (emergency_stop_rpc,",
  "--     queue_set_status_rpc, submit_incident_rpc) уже були в №19, але їхні піни",
  "--     тримали виклик хелпера, а не його рішення.",
  "--     Замір с74: це ЄДИНИЙ `auth_*`, якого не пінило НІЩО. Девʼять інших — у",
  "--     списку №19; ще чотири (`auth_ceo_clinics`, `auth_is_ceo_of`,",
  "--     `auth_radiologist_case_ok`, `auth_referrer_can_book_room`) досяжні з",
  "--     `anon`, і їхні тіла тримає №22. `auth_is_desk` з `anon` недосяжний, тож",
  "--     його не бачила жодна з двох перевірок.",
  "--  2-3. `schedule_from_waitlist_rpc`, `set_waitlist_status_rpc` — їхні тіла",
  "--     переписала 0199 (відсічка радіолога), і результат не тримало ніщо.",
  "--",
  "--  ⚠️ ЧОМУ НЕ ВСІ 21 — і чесно, бо перша підстава виявилась хибною. Розбір с73",
  "--     назвав решту 18 «застосовувачами з гучною відмовою». Ревʼю с74 заміряло",
  "--     тіла: у 12 із 18 власний гейт `auth_is_admin()`/`auth_is_desk()`, у 2 —",
  "--     хелпери направника й радіолога, у 2 — лише `auth.uid()`, дві пошукові",
  "--     гейта не мають. Вихолощення такого гейта МОВЧАЗНЕ. Обсяг «три» задав",
  "--     власник 15.09; чи пінити решту — окреме рішення власника",
  "--     (`docs/audit/PR-0200-pin-desk-waitlist.md`), як і місце",
  "--     `integration_apply_status` (недоступна `authenticated`) у №19/№22.",
  "--",
  "--  ⚠️ ЦІНА, названа заздалегідь: №19 пінує ПОВНИЙ рядок — md5 тіла + `attrs`",
  "--     разом із `;acl=`. БУДЬ-ЯКА правка цих трьох функцій — тіло (і якірна, як",
  "--     у 0199), `grant`, `revoke`, `alter function`, перейменування параметра —",
  "--     тепер іде в одній міграції з передруком сторожа. ⚠️ CI цього НЕ ловить:",
  "--     `PINNED` тримає підписи, а не md5, і гейт звіряє пін лише з тілом у тому",
  "--     ж файлі. Забута правка червонить №19 уже на ПРОДІ.",
  "--",
  "--  ⚠️ ФОРМА — ПОВНИЙ ПЕРЕДРУК, А НЕ ЯКІРНА ПІДМІНА. Тести (`latestReprint()`)",
  "--     розбирають список №19 з ОСТАННЬОГО файла, що передруковує сторожа;",
  "--     якірна міграція була б ними пропущена, і `PINNED` на 43 дав би червоне з",
  "--     діагнозом не туди. Зібрано `node scripts/build-0200-reprint.mjs` із 0198",
  "--     (0199 сторожа не передруковує — генератор це асертить).",
  "--     У КОДІ сторожа змінилось рівно одне — три рядки списку; решта різниці —",
  "--     проза №19 (лічильник 40 -> 43 і абзац 0200). Базис у генераторі.",
  "--",
  "--  ⚠️ РЯДКИ ПІНА ЗНЯТІ НА ПРОДІ формулою гілки `cur` самої №19. Фрагмент",
  "--     накату ПЕРЕД передруком проганяє їх через ТОЙ САМИЙ вираз `cur`,",
  "--     вирізаний генератором із тіла сторожа: `grant`, виданий між заміром і",
  "--     накатом, зупиняє накат, а не кладе червоного сторожа.",
  "--",
  "--  ⚠️ ⚠️ ЦЕЙ ФАЙЛ НЕ НАКАТУВАТИ — ні вставкою в SQL Editor, ні MCP",
  "--     `apply_migration`, ні `supabase db push`. У ньому немає ЖОДНОГО",
  "--     запобіжника: ні звірки предстану 0198 (тіло і самопін), ні звірки живих",
  "--     рядків, ні черги леджера; а поза одним батчем передрук і самопін №25 —",
  "--     різні стейтменти, і обрив між ними лишає нове тіло зі СТАРИМ піном.",
  "--     Шлях один — `scripts/frag/0200_apply.sql`, весь одним запитом.",
  "--",
  "--  ПОРЯДОК (ревʼю с74 переставило перевірки без БД ПЕРЕД накатом):",
  "--   0. Дерево чисте; `node scripts/build-0200-reprint.mjs` → `git diff",
  "--      --exit-code` (файли відповідають генератору); `npm test`,",
  "--      `npx tsc --noEmit`; повна ревізія `node scripts/falsify-all.mjs`.",
  "--      Усе це — ДО проду: червоне тут не лишає прод у половинчастому стані.",
  "--   1. `scripts/frag/0200_dryrun.sql` (запит ПОЧИНАЄТЬСЯ з тегу dryrun) →",
  "--      помилка DRYRUN_0200_ROLLBACK з checked=25 і failed лише `ledger_md5`.",
  "--   2. `scripts/frag/0200_apply.sql` → таблиця читання назад:",
  `--      guard_md5 = ${NEW_MD5}, guard_len = ${NEW_LEN}, ledger_rows = 200.`,
  "--      Помилка = НІЧОГО не закомічено. Таймаут клієнта = накат НЕ повторювати,",
  "--      виконати окремо лише select читання назад із кінця фрагмента.",
  "--      ⚠️ Відрізок «накат → db:gate» не сміє перетнути 03:50 UTC (06:50 Київ):",
  "--         крон `invariants` запише прогін із червоною `ledger_md5`.",
  "--   3. ОКРЕМИМ запитом `select public.invariants_check(false);` — checked 25,",
  "--      failed лише `ledger_md5` (це і є доказ коміту: до накату її немає).",
  "--      ⚠️ Кілька перевірок залежать від ДАНИХ і ЧАСУ (cron_*, outbox_*,",
  "--         gcal_*, ucm_orphan_markers) і можуть почервоніти не від пакета.",
  "--   4. `scripts/frag/0200_falsify.sql` → verdict=PASS; після — окремим запитом",
  "--      `invariants_check(false)`: №19 знову зелена.",
  "--   5. `npm run db:gate` (ЛИШЕ з машини власника) → повтор `invariants_check`:",
  "--      `ok:true`, `failed:[]`.",
  "--   6. git ОДНИМ заходом: гілка → dev → main → push → штамп деплою. До пушу",
  "--      в `main` кожна прод-збірка падає (рядок у леджері є, файла немає).",
  "--      Якщо кроки 5–6 не закрити в цей захід — `scripts/frag/0200_rollback.sql`",
  "--      і перевірка окремим запитом, а не «доробимо завтра».",
  "--   7. Аудит-док `docs/audit/PR-0200-pin-desk-waitlist.md` (протокол",
  "--      фальсифікації і читань назад) — ДО мержу: на нього посилається проза.",
  "--   8. ⚠️ ПІСЛЯ КРОКУ 5 генератор НЕ ЗАПУСКАТИ: він перезаписує файл, чий md5",
  "--      уже в леджері. Без `--force` генератор відмовиться сам, якщо зміст інший.",
  "-- ============================================================================",
].join("\n");

const MIG_TAIL = [
  "",
  "-- ⚠️ Пін — НЕ прикраса: його читає перевірка №25 у тілі вище, і його ж звіряє",
  "--    `planGuardPin` у гейті кожної збірки.",
  `comment on function public.invariants_check(boolean) is '${PIN}';`,
  "",
  "insert into public.migration_ledger (name)",
  `values ('${DST_NAME}')`,
  "on conflict (name) do nothing;",
  "",
  "-- ============================================================================",
  "-- === ВІДКАТ ===",
  "--",
  "--  1. База: `scripts/frag/0200_rollback.sql` — тіло сторожа повертається до 0198",
  `--     (${PRE_MD5} / ${PRE_LEN}), САМОПІН повертається до 0198 (не`,
  "--     знімається: до 0200 він був), рядок леджера знімається. Перевіряти",
  "--     ОКРЕМИМ запитом після commit (запит — у кінці фрагмента).",
  "--  2. Git — ОДНИМ неподільним кроком: прибрати три підписи з `PINNED` у",
  "--     `tests/guardFnBodiesInvariant.test.ts` І видалити цей файл. У будь-якому",
  "--     іншому порядку набір червоний: поки файл на диску, список ріжеться з",
  "--     нього (43 рядки проти 40 у `PINNED`), і навпаки.",
  "--  3. Разом із ним — `scripts/frag/0200_*.sql` і `scripts/build-0200-reprint.mjs`.",
  "--     Нового стенда пакет НЕ заводить (`EXPECTED_STANDS` не міняється):",
  "--     властивість «знятий рядок списку червоніє» тримають звірка МНОЖИН у",
  "--     тесті і позиція B5 `falsify-0181`; три нові рядки фальсифіковано",
  "--     разовим прогоном — протокол у `docs/audit/PR-0200-pin-desk-waitlist.md`.",
  "--  ⚠️ Між кроками 1 і 2 гейт червоний в обидва боки — закривати одним заходом.",
  "-- ============================================================================",
].join("\n");

const MIG = MIG_HEAD + "\n\n" + S98.prologue + NEW_BODY + "$function$;\n" + MIG_TAIL + "\n";

// ⚠️ АСЕРТИ ПО ФАЙЛУ ЦІЛКОМ — те, що читають гейт і тести, а не рядок у памʼяті.
{
  const heads = MIG.match(REPRINT_RE_G) || [];
  if (heads.length !== 1) throw new Error(`ФАЙЛ: заголовків передруку ${heads.length}, а треба 1`);
  // Перше входження фрази БЕЗ якоря мусить бути саме заголовком (у тілі вона
  // законно цитується прозою №25 — тож «рівно раз» тут було б неправдою).
  const loose = MIG.indexOf("create or replace function public.invariants_check");
  const anchored = MIG.search(/^create or replace function public\.invariants_check/m);
  if (loose !== anchored) throw new Error(`ФАЙЛ: фраза create-or-replace сторожа вперше трапляється на ${loose}, а заголовок на ${anchored} — privilegeSurface взяв би тіло від коментаря`);
  const pins = [...MIG.matchAll(GUARD_PIN_RE)].map((m) => m[1]);
  if (pins.length !== 1 || pins[0] !== PIN) throw new Error(`ФАЙЛ: піни ${JSON.stringify(pins)}, а треба рівно ${PIN}`);
  if (count(MIG, OPEN) !== 1 || count(MIG, CLOSE) !== 1) throw new Error("ФАЙЛ: межі тіла не унікальні");
}

if (existsSync(DST_MIG)) {
  const old = readFileSync(DST_MIG, "utf8").replace(/\r/g, "");
  if (old !== MIG && !FORCE) {
    throw new Error(`${DST_MIG} уже є і його зміст ІНШИЙ. Якщо md5 файла вже в леджері — перезапис = дрейф = червона збірка. Свідомо: --force`);
  }
}
writeFileSync(DST_MIG, MIG);
writeFileSync("scripts/frag/0200_apply.sql", APPLY + "\n");
writeFileSync("scripts/frag/0200_dryrun.sql", DRYRUN + "\n");
writeFileSync("scripts/frag/0200_rollback.sql", ROLLBACK + "\n");
writeFileSync("scripts/frag/0200_falsify.sql", FALSIFY + "\n");

// ⚠️ І ЗВОРОТНИЙ ХІД ПО ЗАПИСАНОМУ ФАЙЛУ (урок 0193): витяг із диска мусить дати
//    те саме тіло, інакше збирач довів би властивість рядка в памʼяті.
{
  const back = split(DST_MIG);
  if (md5(back.body) !== NEW_MD5 || back.body.length !== NEW_LEN) {
    throw new Error(`ЗАПИСАНИЙ ФАЙЛ дає ${md5(back.body)} / ${back.body.length}, а зібрано ${NEW_MD5} / ${NEW_LEN}`);
  }
  if (back.prologue !== S98.prologue) throw new Error("DDL сторожа у записаному файлі розʼїхався з 0198");
}

console.log("0200 зібрано.");
console.log(`  сторож:   ${PRE_MD5} / ${PRE_LEN}  ->  ${NEW_MD5} / ${NEW_LEN}`);
console.log(`  checked:  25 (без змін);  список №19: ${OLD_SIGS.length} -> ${NEW_SIGS.length}`);
console.log(`  пін:      ${PIN}`);
console.log(`  пар підстановки: ${PAIRS.length}; змістових перевірок: ${CHECKS.length}; зворотний хід -> 0198`);
console.log(`  файли: ${DST_MIG}, scripts/frag/0200_{apply,dryrun,rollback,falsify}.sql`);
