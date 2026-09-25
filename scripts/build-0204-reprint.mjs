// build-0204-reprint.mjs — збирає supabase/migrations/0204_referrer_grant_read.sql
// і scripts/frag/0204_{apply,dryrun,rollback,falsify}.sql.
//
// ЩО РОБИТЬ ПАКЕТ (рішення власника 25.09.2026, с80: Н-14 «відкликання гранту
// забирає читання», плюс Н-17):
//   1. Три політики читання — `queue_select`, `waitlist_select`,
//      `cases_select_referrer`: гілка за ключем `created_by` / `referrer_id`
//      тепер вимагає `clinic_id in (select auth_referrer_clinics())`, тобто
//      АКТИВНИЙ грант до центру запису. Решта політик не змінюється.
//   2. `change_marker_recipients(…)`: CTE `referrer` для `entry` — лише з
//      АКТИВНИМ грантом `p_referrer` до `p_clinic` (дзеркало політик: позначка
//      про запис, якого отримувач не бачить, не гаситься нічим); `access` — як
//      було (повідомлення про відкликання мусить дійти).
//   3. Нова мітла `tg_ref_entry_markers_prune_on_access()` (тригер
//      `trg_zzz_ref_entry_markers_prune` AFTER DELETE OR UPDATE на
//      `referral_access`): коли грант ПЕРЕСТАЄ бути активним — видалити
//      позначки ЗАПИСІВ цього направника в цьому центрі (стара пара).
//   4. №14 — гілка `unreachable:<тип>:<к-сть>` (пін ВЛАСТИВОСТІ: ловить і
//      вихолощену мітлу, і відкат п.2).
//   5. Н-17 — №17 гілка `order:<таблиця>-><тригер>`: останній BEFORE-тригер
//      рядка на INSERT/UPDATE трьох таблиць гарда мусить бути
//      `zz_guard_read_keys` (предикат — дослівно асерт накату 0203).
//   6. Передрук сторожа: №14 (гілка + проза), №16 (три дайджести + проза), №17
//      (+1 пара, гілка, проза), №19 (рядок `change_marker_recipients`), №25.
//      `checked` 26. №22 / №23 / №26 НЕ змінюються — генератор це ДОВОДИТЬ:
//      код тіла без коментарів відрізняється від 0203 рівно заявленими рядками.
//
// ⚠️ ФОРМА — ПОВНИЙ ПЕРЕДРУК з 0203 якірними вставками (канон build-0203):
//    `latestReprint()` у тестах і стендах бере ОСТАННІЙ файл, де рядок
//    ПОЧИНАЄТЬСЯ з create-or-replace сторожа.
//
// ⚠️ ПОРЯДОК У НАКАТІ (урок 0196): функції → передрук → пін → ПОВНИЙ сторож
//    (≈9 с, мусить назвати РІВНО три `changed:` №16 і один `missing:` №17 —
//    червона база, побудована самим накатом) → DDL (три `alter policy` —
//    ACCESS EXCLUSIVE на три гарячі таблиці, тригер на `referral_access`) →
//    дослівні запити №16 і №17 (мілісекунди) → леджер.
//
// ⚠️ ПІСЛЯ `npm run db:gate` ЦЕЙ ГЕНЕРАТОР НЕ ЗАПУСКАТИ: він перезаписує файл
//    міграції, чий md5 уже в леджері. Без `--force` відмовляється, якщо зміст інший.
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const count = (s, needle) => s.split(needle).length - 1;
const FORCE = process.argv.includes("--force");

const MIGDIR = "supabase/migrations";
const SRC_NAME = "0203_audit_pii_referrer_grant.sql";
const SRC_MIG = `${MIGDIR}/${SRC_NAME}`;
const DST_NAME = "0204_referrer_grant_read.sql";
const DST_MIG = `${MIGDIR}/${DST_NAME}`;
const PREV_LEDGER = SRC_NAME;
/** Прод 25.09 (замір оркестратора і цього пакета): тіло сторожа = тіло у файлі 0203. */
const PRE_MD5 = "8c8e6403db7653949e03d026320c6099";
const PRE_LEN = 170446;
const PRE_PIN = `guard_body_md5=${PRE_MD5};len=${PRE_LEN}`;
const CHECKED = 26;
/** Перевірки, червоні на проді ДО пакета не з його вини (замір 24–25.09: лише №13). */
const KNOWN_RED = ["gcal_sync_overdue"];

const OPEN = "\nas $function$";
const CLOSE = "\n$function$;";
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

/** Код без коментарів — той самий вирізувач, що в `tests/guardFnBodiesInvariant.test.ts`. */
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
const normWs = (s) => s.replace(/\s+/g, " ").trim();
/** Рецепт №19 (`md5(btrim(regexp_replace(prosrc, '\s+', ' ', 'g')))`) збігається з JS лише на ASCII-пробілах. */
const exoticWs = (s) => [...s].some((ch) => {
  const c = ch.codePointAt(0);
  return c === 0x09 || c === 0x0b || c === 0x0c || c === 0x0d || c === 0xa0 || c === 0x1680
    || (c >= 0x2000 && c <= 0x200b) || c === 0x2028 || c === 0x2029 || c === 0x202f
    || c === 0x205f || c === 0x3000 || c === 0xfeff;
});

// ---------------------------------------------------------------------------
// 1. БАЗИСИ ДЖЕРЕЛА. Кожен — числом.
// ---------------------------------------------------------------------------
const SRC = split(SRC_MIG);
if (md5(SRC.body) !== PRE_MD5 || SRC.body.length !== PRE_LEN) {
  throw new Error(`ВИТЯГ ЗЛАМАНИЙ: 0203 дав ${md5(SRC.body)} / ${SRC.body.length}, а в проді ${PRE_MD5} / ${PRE_LEN}`);
}
if (SRC.head + SRC.prologue + SRC.body + "$function$;" + SRC.tail !== SRC.raw) {
  throw new Error("СКЛЕЙКА ЗЛАМАНА: 0203 не збирається назад побайтово");
}
{
  const pins = [...SRC.raw.matchAll(GUARD_PIN_RE)].map((m) => m[1]);
  if (pins.length !== 1 || pins[0] !== PRE_PIN) {
    throw new Error(`ПІН 0203 у файлі ${JSON.stringify(pins)}, а в проді ${PRE_PIN}`);
  }
}
{
  const later = readdirSync(MIGDIR)
    .filter((f) => f.endsWith(".sql") && f > SRC_NAME && f !== DST_NAME).sort();
  if (later.length) throw new Error(`після 0203 на диску вже є ${later.join(", ")} — номер 0204 зайнятий чи черга зсунулась`);
}

// ---------------------------------------------------------------------------
// 2. ОБʼЄКТИ ПАКЕТА.
// ---------------------------------------------------------------------------

/* ── 2.1. Політики читання. DDL — дослівно з постановки оркестратора (25.09);
   рендер `pg_policies.qual` і дайджест №16 — ПРОДОВІ (PG17, проба з відкотом),
   на реплеї PG16 вони ті самі. Старі DDL — для відкату і мутацій фальсифікації:
   їх рендер дає рівно старі дайджести (реплей). ── */
const POLICIES = [
  {
    tbl: "patient_cases", pol: "cases_select_referrer", oldDig: "d6b423f8c727", newDig: "a406bc42d13d",
    newDdl: [
      "alter policy cases_select_referrer on public.patient_cases using (",
      "  ((created_by = (select auth.uid())) or (referrer_id = (select auth.uid()))) and (clinic_id in (select auth_referrer_clinics()))",
      ");",
    ].join("\n"),
    oldDdl: [
      "alter policy cases_select_referrer on public.patient_cases using (",
      "  (created_by = (select auth.uid())) or (referrer_id = (select auth.uid()))",
      ");",
    ].join("\n"),
    newRender: "(((created_by = ( SELECT auth.uid() AS uid)) OR (referrer_id = ( SELECT auth.uid() AS uid))) AND (clinic_id IN ( SELECT auth_referrer_clinics() AS auth_referrer_clinics)))",
    oldRender: "((created_by = ( SELECT auth.uid() AS uid)) OR (referrer_id = ( SELECT auth.uid() AS uid)))",
  },
  {
    tbl: "queue_entries", pol: "queue_select", oldDig: "ff3f89d6a1a2", newDig: "6061c08c210b",
    newDdl: [
      "alter policy queue_select on public.queue_entries using (",
      "  ((clinic_id = auth_clinic_id()) and (((select auth_role()) is distinct from 'radiologist'::user_role) or auth_radiologist_room_ok(room_id)))",
      "  or (((created_by = (select auth.uid())) or (referrer_id = (select auth.uid()))) and (clinic_id in (select auth_referrer_clinics())))",
      ");",
    ].join("\n"),
    oldDdl: [
      "alter policy queue_select on public.queue_entries using (",
      "  ((clinic_id = auth_clinic_id()) and (((select auth_role()) is distinct from 'radiologist'::user_role) or auth_radiologist_room_ok(room_id)))",
      "  or (created_by = (select auth.uid())) or (referrer_id = (select auth.uid()))",
      ");",
    ].join("\n"),
    newRender: "(((clinic_id = auth_clinic_id()) AND ((( SELECT auth_role() AS auth_role) IS DISTINCT FROM 'radiologist'::user_role) OR auth_radiologist_room_ok(room_id))) OR (((created_by = ( SELECT auth.uid() AS uid)) OR (referrer_id = ( SELECT auth.uid() AS uid))) AND (clinic_id IN ( SELECT auth_referrer_clinics() AS auth_referrer_clinics))))",
    oldRender: "(((clinic_id = auth_clinic_id()) AND ((( SELECT auth_role() AS auth_role) IS DISTINCT FROM 'radiologist'::user_role) OR auth_radiologist_room_ok(room_id))) OR (created_by = ( SELECT auth.uid() AS uid)) OR (referrer_id = ( SELECT auth.uid() AS uid)))",
  },
  {
    tbl: "waitlist_entries", pol: "waitlist_select", oldDig: "659164e8f637", newDig: "0cf225150efe",
    newDdl: [
      "alter policy waitlist_select on public.waitlist_entries using (",
      "  ((clinic_id = (select auth_clinic_id())) and (((select auth_role()) is distinct from 'radiologist'::user_role) or auth_radiologist_room_ok(room_id)))",
      "  or (((created_by = (select auth.uid())) or (referrer_id = (select auth.uid()))) and (clinic_id in (select auth_referrer_clinics())))",
      ");",
    ].join("\n"),
    oldDdl: [
      "alter policy waitlist_select on public.waitlist_entries using (",
      "  ((clinic_id = (select auth_clinic_id())) and (((select auth_role()) is distinct from 'radiologist'::user_role) or auth_radiologist_room_ok(room_id)))",
      "  or (created_by = (select auth.uid())) or (referrer_id = (select auth.uid()))",
      ");",
    ].join("\n"),
    newRender: "(((clinic_id = ( SELECT auth_clinic_id() AS auth_clinic_id)) AND ((( SELECT auth_role() AS auth_role) IS DISTINCT FROM 'radiologist'::user_role) OR auth_radiologist_room_ok(room_id))) OR (((created_by = ( SELECT auth.uid() AS uid)) OR (referrer_id = ( SELECT auth.uid() AS uid))) AND (clinic_id IN ( SELECT auth_referrer_clinics() AS auth_referrer_clinics))))",
    oldRender: "(((clinic_id = ( SELECT auth_clinic_id() AS auth_clinic_id)) AND ((( SELECT auth_role() AS auth_role) IS DISTINCT FROM 'radiologist'::user_role) OR auth_radiologist_room_ok(room_id))) OR (created_by = ( SELECT auth.uid() AS uid)) OR (referrer_id = ( SELECT auth.uid() AS uid)))",
  },
];
/** Дайджест №16 (0170): md5(cmd|permissive|roles|qual|with_check), пробіли злиті, 12 знаків.
 *  Усі три — SELECT, PERMISSIVE, `{authenticated}`, без with_check (замір 25.09). */
const dig16 = (render) => md5(`SELECT|PERMISSIVE|authenticated|${render.replace(/\s+/g, " ")}|`).slice(0, 12);
for (const p of POLICIES) {
  if (dig16(p.newRender) !== p.newDig) throw new Error(`№16 ${p.pol}: рендер дає ${dig16(p.newRender)}, а прод ${p.newDig}`);
  if (dig16(p.oldRender) !== p.oldDig) throw new Error(`№16 ${p.pol}: старий рендер дає ${dig16(p.oldRender)}, а в 0203 ${p.oldDig}`);
  if (!p.newDdl.includes("clinic_id in (select auth_referrer_clinics())")) throw new Error(`${p.pol}: у DDL немає умови гранту`);
}
if (POLICIES.map((p) => p.tbl).join() !== "patient_cases,queue_entries,waitlist_entries") throw new Error("POLICIES не в C-порядку таблиць");
const NEW_POLICY_DDL = POLICIES.map((p) => p.newDdl).join("\n");
const OLD_POLICY_DDL = POLICIES.map((p) => p.oldDdl).join("\n");
/** Порушники №16 до DDL — рівно ці три (C-порядок). */
const WANT16_BEFORE = POLICIES.map((p) => `changed:${p.tbl}.${p.pol}`);

/* ── 2.2. `change_marker_recipients` — тіло з ПРОДУ. Прод 25.09: prosrc =
   тіло у файлі 0184 побайтово (сирий md5 cef6f91b…, 6812 символів; рецепт №19
   259d744f…). Пізніше функцію не визначала жодна міграція (перевіряємо). ── */
const CMR = "change_marker_recipients";
const CMR_SIG = "change_marker_recipients(p_clinic uuid, p_actor uuid, p_scope_kind text, p_room uuid, p_referrer uuid, p_severity text, p_room_relevant boolean)";
const CMR_REGPROC = "public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean)";
const CMR_SRC_NAME = "0184_rf03b_sched_marker_fanout.sql";
const CMR_PRE_RAW = "cef6f91b5dd1dcdc35e93fd732cf7162";
const CMR_PRE_LEN = 6812;
const CMR_PRE_REC19 = "259d744f8db5189360b6b3ef2f81b3cc";
const CMR_ATTRS = "secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres";
const FN_ACL = "postgres=X/postgres,service_role=X/postgres";
const CMR_TAG = "$cmr$";
const CMR_PRE = (() => {
  const txt = readFileSync(`${MIGDIR}/${CMR_SRC_NAME}`, "utf8").replace(/\r/g, "");
  const head = `create or replace function public.${CMR}(`;
  const a = txt.indexOf(head);
  if (a < 0 || count(txt, head) !== 1) throw new Error(`${CMR_SRC_NAME}: визначення ${CMR} не одне`);
  const o = txt.indexOf("\nas $function$\n", a);
  const e = txt.indexOf("\n$function$;", o);
  if (o < 0 || e < 0) throw new Error(`${CMR_SRC_NAME}: межі тіла ${CMR} не знайдено`);
  return { header: txt.slice(a, o), body: txt.slice(o + "\nas $function$".length, e + 1) };
})();
if (md5(CMR_PRE.body) !== CMR_PRE_RAW || CMR_PRE.body.length !== CMR_PRE_LEN || md5(normWs(CMR_PRE.body)) !== CMR_PRE_REC19) {
  throw new Error(`${CMR}: тіло 0184 дало ${md5(CMR_PRE.body)} / ${CMR_PRE.body.length} / ${md5(normWs(CMR_PRE.body))}, а на проді ${CMR_PRE_RAW} / ${CMR_PRE_LEN} / ${CMR_PRE_REC19}`);
}
{
  /* Жодна міграція ПІСЛЯ 0184 (до 0203 включно) не перевизначала функцію —
     інакше «остання редакція» не 0184, і тіло з проду треба брати звідти. */
  const later = readdirSync(MIGDIR).filter((f) => f.endsWith(".sql") && f > CMR_SRC_NAME && f !== DST_NAME)
    .filter((f) => new RegExp(`create\\s+(or\\s+replace\\s+)?function\\s+public\\.${CMR}\\s*\\(`)
      .test(codeOf(readFileSync(`${MIGDIR}/${f}`, "utf8"))));
  if (later.length) throw new Error(`${CMR} перевизначено пізніше за 0184: ${later.join(", ")}`);
}
/** Правка — лише CTE `referrer`: проза і РІВНО п'ять рядків умови гранту. */
const CMR_REF_FROM = [
  "  referrer as (",
  "    -- Направник отримує позначку лише про ЙОГО направлення. Активність",
  "    -- referral_access тут НЕ перевіряємо навмисно: позначка про відкликання",
  "    -- доступу мусить дійти саме до того, у кого доступ щойно забрали (вимога",
  "    -- ТЗ; RLS позначок тримається на recipient_id, а не на клініці).",
  "    --",
].join("\n") + "\n";
const CMR_REF_TO = [
  "  referrer as (",
  "    -- Направник отримує позначку лише про ЙОГО направлення. Для 'access'",
  "    -- активність referral_access НЕ перевіряємо навмисно: позначка про",
  "    -- відкликання доступу мусить дійти саме до того, у кого доступ щойно",
  "    -- забрали (вимога ТЗ; RLS позначок тримається на recipient_id, а не на",
  "    -- клініці).",
  "    --",
  "    -- 0204 (Н-14, рішення власника 25.09.2026): для 'entry' — ЛИШЕ з",
  "    -- АКТИВНИМ грантом до p_clinic. Дзеркало політик читання 0204",
  "    -- (`queue_select`, `waitlist_select`, `cases_select_referrer`): за",
  "    -- `created_by` / `referrer_id` запис читає лише власник активного гранту",
  "    -- до центру запису. Позначка про запис, якого отримувач не бачить, —",
  "    -- крапка ні про що: `queue_entry` гаситься лише з відрендереного рядка",
  "    -- (для невидимого — ніколи), `patient_case` ack поки не має взагалі, а",
  "    -- `waitlist_entry` направника гасить поверхня «Лист очікування»",
  "    -- (surface-ack, 0138), але до того крапка на вкладці світить про рядок,",
  "    -- якого в списку немає. Ретенція чистить тільки прочитані (правило",
  "    -- «позначка без поверхні для ack — дефект»). Позначки, що лежали на",
  "    -- мить, коли грант перестав бути активним, знімає тригер",
  "    -- `trg_zzz_ref_entry_markers_prune` на `referral_access`; вцілілу",
  "    -- НЕПРОЧИТАНУ (гонка з відкликанням) називає №14 гілкою `unreachable:`.",
  "    --",
].join("\n") + "\n";
const CMR_COND_FROM = "       and exists (select 1 from public.profiles pr where pr.id = p_referrer)\n  ),\n";
const CMR_COND_LINES = [
  "       and (p_scope_kind = 'access'",
  "            or exists (select 1 from public.referral_access ra",
  "                        where ra.referrer_id = p_referrer",
  "                          and ra.clinic_id = p_clinic",
  "                          and ra.status = 'active'))",
];
const CMR_COND_TO = "       and exists (select 1 from public.profiles pr where pr.id = p_referrer)\n"
  + CMR_COND_LINES.join("\n") + "\n  ),\n";
const CMR_NEW_BODY = (() => {
  let b = CMR_PRE.body;
  for (const [f, t, lbl] of [[CMR_REF_FROM, CMR_REF_TO, "проза CTE referrer"], [CMR_COND_FROM, CMR_COND_TO, "умова гранту в CTE referrer"]]) {
    if (count(b, f) !== 1) throw new Error(`${CMR}: якір «${lbl}» — ${count(b, f)} влучань, а треба 1`);
    b = b.split(f).join(t);
  }
  return b;
})();
const CMR_NEW_RAW = md5(CMR_NEW_BODY);
const CMR_NEW_REC19 = md5(normWs(CMR_NEW_BODY));
const CMR_STMT_OF = (body) => `${CMR_PRE.header}\nas ${CMR_TAG}${body}${CMR_TAG};`;
const CMR_PRE_STMT = CMR_STMT_OF(CMR_PRE.body);
const CMR_NEW_STMT = CMR_STMT_OF(CMR_NEW_BODY);
const CMR_ACL_DDL = [
  `revoke all on function ${CMR_REGPROC} from public, anon, authenticated;`,
  `grant execute on function ${CMR_REGPROC} to service_role;`,
].join("\n");
{
  if (exoticWs(CMR_NEW_STMT)) throw new Error(`${CMR}: у тексті є не-ASCII пробіл або табуляція`);
  if (!CMR_PRE.header.includes("language sql\nstable\nsecurity definer\nset search_path to 'public', 'pg_temp'")) {
    throw new Error(`${CMR}: шапка 0184 не та (мова/волатильність/definer/шлях)`);
  }
  /* Код без коментарів: старий + РІВНО п'ять рядків умови гранту після рядка
     про існування профілю. Нічого іншого в коді функції не змінено. */
  const oldCode = codeOf(CMR_PRE.body).split("\n");
  const newCode = codeOf(CMR_NEW_BODY).split("\n");
  const at = oldCode.indexOf("       and exists (select 1 from public.profiles pr where pr.id = p_referrer)");
  if (at < 0) throw new Error(`${CMR}: рядок про існування профілю не знайдено в коді`);
  const want = [...oldCode.slice(0, at + 1), ...CMR_COND_LINES, ...oldCode.slice(at + 1)];
  if (JSON.stringify(newCode) !== JSON.stringify(want)) throw new Error(`${CMR}: код без коментарів змінено не лише умовою гранту`);
  if (count(codeOf(CMR_NEW_BODY), "ra.status = 'active'") !== 2) throw new Error(`${CMR}: 'active' у коді не двічі (sched_referrers + referrer)`);
  if (!/select distinct s\.id\n {4}from \(\n {6}select id from staff\n {6}union select id from rads\n {6}union select id from referrer\n {6}union select id from sched_referrers\n {4}\) s/.test(CMR_NEW_BODY)) {
    throw new Error(`${CMR}: фінальний union змінився`);
  }
}

/* ── 2.3. Мітла позначок записів при відкликанні гранту. Форма й атрибути — як
   у `tg_sched_markers_prune_on_access` (0184): SECURITY DEFINER, volatile,
   `search_path = public, pg_temp`, EXECUTE лише службовій ролі (пастка 0122). ── */
const PRUNE = "tg_ref_entry_markers_prune_on_access";
const PRUNE_SIG = `${PRUNE}()`;
const PRUNE_TAG = "$prune$";
const PRUNE_TG = "trg_zzz_ref_entry_markers_prune";
const PRUNE_STMT = [
  `create or replace function public.${PRUNE}()`,
  "returns trigger",
  "language plpgsql",
  "security definer",
  "set search_path = public, pg_temp",
  `as ${PRUNE_TAG}`,
  "begin",
  "  -- 0204 (Н-14, рішення власника 25.09.2026: «відкликання гранту забирає",
  "  -- читання»). Політики читання 0204 пускають за `created_by` / `referrer_id`",
  "  -- лише з АКТИВНИМ грантом до центру запису. Щойно грант перестає бути",
  "  -- активним, позначки ЗАПИСІВ цього центру вказують на рядки, яких",
  "  -- направник уже не бачить: `queue_entry` гаситься лише з відрендереного",
  "  -- рядка (тобто ніколи), `patient_case` ack поки не має, `waitlist_entry`",
  "  -- погасила б поверхня «Лист очікування», але до того крапка світить про",
  "  -- рядок, якого в списку немає; ретенція чистить тільки прочитані. Тому",
  "  -- видаляємо їх — позначки черги, листа очікування й кейсів цього",
  "  -- направника в цьому центрі, і НЕПРОЧИТАНІ, і ПРОЧИТАНІ (гігієна:",
  "  -- прочитана крапки не запалює, але до 180 днів лежала б позначкою про",
  "  -- невидимий запис; №14 рахує лише непрочитані). Позначки `centers` /",
  "  -- `referral_access` (саме повідомлення про відкликання) НЕ чіпаємо: воно",
  "  -- мусить дійти.",
  "  --",
  "  -- «Перестає бути активним» — за СТАРОЮ парою (направник, центр):",
  "  --   • UPDATE з active у будь-який інший статус;",
  "  --   • DELETE активного гранту (зокрема каскадом із profiles);",
  "  --   • UPDATE активного гранту, що міняє `clinic_id` або `referrer_id`.",
  "  -- Вкладений IF, а не кон'юнкт: на DELETE рядок `new` порожній (канон",
  "  -- `tg_sched_markers_prune_on_access`, 0184). Кабінети гранту (`room_ids`)",
  "  -- — не межа читання за ключем, тож їх зміна нічого не знімає.",
  "  --",
  "  -- Не був активним — читання за ним не було, знімати нічого.",
  "  if old.status is distinct from 'active' then",
  "    return null;",
  "  end if;",
  "  -- Той самий живий грант (пара та сама, статус active) — теж нічого.",
  "  if tg_op = 'UPDATE' then",
  "    if new.status = 'active'",
  "       and new.referrer_id is not distinct from old.referrer_id",
  "       and new.clinic_id is not distinct from old.clinic_id then",
  "      return null;",
  "    end if;",
  "  end if;",
  "",
  "  delete from public.user_change_markers m",
  "   where m.recipient_id = old.referrer_id",
  "     and m.clinic_id    = old.clinic_id",
  "     and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case');",
  "  return null;",
  "end;",
  `${PRUNE_TAG};`,
].join("\n");
const PRUNE_BODY = (() => {
  const a = PRUNE_STMT.indexOf(`as ${PRUNE_TAG}\n`);
  const b = PRUNE_STMT.lastIndexOf(`\n${PRUNE_TAG};`);
  if (a < 0 || b < 0 || count(PRUNE_STMT, PRUNE_TAG) !== 2) throw new Error("мітла: межі тіла не знайдено");
  return PRUNE_STMT.slice(a + `as ${PRUNE_TAG}`.length, b + 1);
})();
const PRUNE_RAW = md5(PRUNE_BODY);
const PRUNE_ATTRS = "secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres";
const PRUNE_ACL_DDL = [
  `revoke all on function public.${PRUNE_SIG} from public, anon, authenticated;`,
  `grant execute on function public.${PRUNE_SIG} to service_role;`,
].join("\n");
const PRUNE_TG_DEF = `CREATE TRIGGER ${PRUNE_TG} AFTER DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION ${PRUNE}()`;
const PRUNE_TG_DDL = [
  `drop trigger if exists ${PRUNE_TG} on public.referral_access;`,
  `create trigger ${PRUNE_TG}`,
  "  after delete or update on public.referral_access",
  `  for each row execute function public.${PRUNE}();`,
].join("\n");
const ENTRY_TYPES = ["queue_entry", "waitlist_entry", "patient_case"];
{
  if (exoticWs(PRUNE_STMT)) throw new Error("мітла: у тексті є не-ASCII пробіл або табуляція");
  const code = codeOf(PRUNE_BODY);
  for (const [lbl, ok] of [
    ["рівно один DELETE і лише з user_change_markers", count(code, "delete from") === 1 && code.includes("delete from public.user_change_markers m")],
    ["стара пара: recipient = old.referrer_id, центр = old.clinic_id",
      code.includes("where m.recipient_id = old.referrer_id") && code.includes("and m.clinic_id    = old.clinic_id")],
    ["лише три типи ЗАПИСІВ (позначки centers/referral_access не чіпає)",
      code.includes("and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case');") && !/referral_access'|centers|surface_key/.test(code)],
    ["не був активним — вихід до будь-якого DELETE",
      code.indexOf("if old.status is distinct from 'active' then") >= 0
      && code.indexOf("if old.status is distinct from 'active' then") < code.indexOf("delete from")],
    ["UPDATE того самого живого гранту (пара та сама) — вихід; пара = referrer_id + clinic_id",
      normWs(code).includes("if tg_op = 'UPDATE' then if new.status = 'active' and new.referrer_id is not distinct from old.referrer_id and new.clinic_id is not distinct from old.clinic_id then return null; end if; end if;")],
    ["`new.` — лише в гілці UPDATE (на DELETE він порожній)", (code.match(/\bnew\./g) || []).length === 3],
    ["рівно три `return null;` і жодного return new", count(code, "return null;") === 3 && !/return\s+new/.test(code)],
    ["жодних обходів за сесією і жодного raise", !/current_user|session_user|current_setting|request\.jwt|auth\.|raise|exception/i.test(code)],
    ["жодного слова invite_token (№15 g2)", !PRUNE_STMT.includes("invite_token")],
  ]) if (!ok) throw new Error(`МІТЛА: не виконано «${lbl}»`);
}

// ---------------------------------------------------------------------------
// 3. ПАРИ ВСТАВКИ В ТІЛО СТОРОЖА. Якір — ПОВНИЙ рядок (рядки); кожен — рівно одне
//    влучання в тілі 0203. Абзаци прози — без `'`, `$`, кроків і міток.
// ---------------------------------------------------------------------------

/* ── №14: гілка `unreachable:` і абзац прози (ПЕРЕД абзацом про referral_access:
   хвіст «переживає видалення).» + крок лічильника — якір стенда falsify-u37 N10). ── */
const P14_BRANCH_ANCHOR = "         and not exists (select 1 from public.clinics x where x.id = m.entity_id)\n      having count(*) > 0\n";
const P14_BRANCH_LINES = [
  "      union all",
  "      -- 0204 (Н-14): НЕПРОЧИТАНА позначка ЗАПИСУ, якого отримувач не бачить —",
  "      -- він не персонал центру позначки і не має АКТИВНОГО гранту до нього",
  "      select 'unreachable:' || m.entity_type || ':' || count(*)",
  "        from public.user_change_markers m",
  "        join public.profiles p on p.id = m.recipient_id",
  "       where m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')",
  "         and m.seen_at is null",
  "         and p.clinic_id is distinct from m.clinic_id",
  "         and not exists (select 1 from public.referral_access ra",
  "                          where ra.referrer_id = m.recipient_id",
  "                            and ra.clinic_id = m.clinic_id",
  "                            and ra.status = 'active')",
  "       group by m.entity_type",
];
const P14_BRANCH_TO = P14_BRANCH_ANCHOR + P14_BRANCH_LINES.join("\n") + "\n";
const P14_PROSE_ANCHOR = "  --     ⚠️ referral_access НЕ рахуємо свідомо: його DELETE-гілка емітить\n";
const PROSE14_0204 = [
  "  --     ⚠️ 0204 (с80, Н-14, рішення власника 25.09) ДОДАЛА ГІЛКУ `unreachable:`:",
  "  --        НЕПРОЧИТАНА позначка ЗАПИСУ (`queue_entry`, `waitlist_entry`,",
  "  --        `patient_case`), чий отримувач не персонал центру позначки",
  "  --        (`profiles.clinic_id` інший) і не має АКТИВНОГО гранту до нього. З",
  "  --        0204 політики читання пускають за `created_by` / `referrer_id` лише",
  "  --        з активним грантом, отже така позначка — крапка про запис, якого",
  "  --        отримувач не бачить: `queue_entry` гаситься лише з відрендереного",
  "  --        рядка (тобто ніколи), `patient_case` ack поки не має, а",
  "  --        `waitlist_entry` направника гасить поверхня «Лист очікування», але",
  "  --        до того крапка світить про рядок, якого в списку немає. Прочитані",
  "  --        НЕ рахуємо свідомо: крапки вони не запалюють, а ретенція прибирає",
  "  --        їх за 180 днів — інакше переведення персоналу з повністю",
  "  --        прочитаними позначками червонило б ніч до пів року. Це пін",
  "  --        ВЛАСТИВОСТІ, а не функцій: він червоніє і на вихолощеній мітлі",
  "  --        `tg_ref_entry_markers_prune_on_access()` (її тіла №19 не пінить),",
  "  --        і на відкаті умови гранту в `change_marker_recipients` (гілка",
  "  --        `entry`). Формат — `unreachable:<тип>:<кількість>`, без uuid.",
  "  --        ⚠️ МЕЖІ, названі вголос:",
  "  --         • гонка «емісія позначки ‖ відкликання гранту» (READ COMMITTED)",
  "  --           може лишити НОВИЙ рядок позначки за БУДЬ-ЯКОГО порядку commit:",
  "  --           (а) першою — емісія: рядок, вставлений емітером, закомічено вже",
  "  --           після DELETE мітли, тож мітла його не бачила (UPSERT НАЯВНОЇ",
  "  --           позначки в цьому порядку мітла дочекається і видалить);",
  "  --           (б) першим — відкликання: UPSERT емітера, що ще бачив грант",
  "  --           активним, чекає на рядок, який видаляє мітла, а після commit",
  "  --           відкликання конфлікту вже не має і вставляє НОВИЙ рядок.",
  "  --           №14 ловить обидва порядки; тоді — ручна зачистка ЛИШЕ за явним",
  "  --           списком id зі свіжого знімка (правило AGENTS.md про видалення",
  "  --           даних проду). Закрити обидва порядки — `for share` на рядку",
  "  --           гранту в емітерах записів (PR-0204, §12);",
  "  --         • отримувач без профілю (видалений акаунт: `delete_clinic_member`",
  "  --           знімає радіолога разом із профілем, а позначки лишаються) сюди НЕ",
  "  --           потрапляє — join із `profiles`. Це окремий клас «позначка",
  "  --           невідомому отримувачу» (0134), і червоніти на штатному",
  "  --           видаленні радіолога ця гілка не мусить;",
  "  --         • персонал, якого службова роль перевела в інший центр, лишає",
  "  --           НЕПРОЧИТАНІ позначки старого центру недосяжними — гілка їх",
  "  --           НАЗВЕ, мітла не зніме (її тригер — на `referral_access`, не на",
  "  --           `profiles`): переводити разом із зачисткою за явним списком id",
  "  --           (процедура — AGENTS.md).",
].join("\n") + "\n";

/* ── №16: три дайджести і абзац прози. ── */
const row16 = (tbl, pol, dig) => `      ('${tbl}','${pol}','${dig}'),\n`;
const P16_ROWS = POLICIES.map((p) => [row16(p.tbl, p.pol, p.oldDig), row16(p.tbl, p.pol, p.newDig), `№16: ${p.pol} ${p.oldDig} → ${p.newDig}`]);
const P16_PROSE_ANCHOR = "  --     випустіть нову міграцію. Якщо змінилось кілька — читайте кожну.\n";
const PROSE16_0204 = [
  "  --",
  "  --     ⚠️ 0204 (с80, Н-14, рішення власника 25.09: «відкликання гранту",
  "  --        забирає читання») ПЕРЕЗНЯЛА ТРИ ДАЙДЖЕСТИ, список той самий (63):",
  "  --        `queue_select`, `waitlist_select`, `cases_select_referrer` — гілка",
  "  --        читання за `created_by` / `referrer_id` тепер вимагає `clinic_id in",
  "  --        (select auth_referrer_clinics())`, тобто АКТИВНИЙ грант до центру",
  "  --        запису. Дайджести — рецептом №16 від рендеру `pg_policies`;",
  "  --        реплей PG16 рендерить ті самі вирази, що й прод.",
  "  --        ⚠️ ПОБІЧНІ НАСЛІДКИ, названі вголос: радіолог більше не бачить",
  "  --           записів, створених ним поза своїми кабінетами; персонал, що",
  "  --           змінив центр, — створених ним записів старого центру (обидва",
  "  --           читали їх лише за `created_by`). Політики запису",
  "  --           `queue_write_referrer` (FOR ALL) і `waitlist_write_referrer`",
  "  --           грант уже вимагали — 0204 їх не чіпала.",
].join("\n") + "\n";

/* ── №17: пара мітли, гілка `order:`, правка прози 0203 і абзац 0204. ── */
const row17 = (t, tg, def, last = false) => `      ('${t}','${tg}','${def}')${last ? "" : ","}\n`;
const P17_PAIR_ANCHOR = row17("referral_access", "trg_audit_referral_access",
  "CREATE TRIGGER trg_audit_referral_access AFTER INSERT OR DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION fn_audit()");
const P17_PAIR_NEXT = row17("referral_access", "trg_zzz_sched_markers_prune",
  "CREATE TRIGGER trg_zzz_sched_markers_prune AFTER DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION tg_sched_markers_prune_on_access()");
const P17_PAIR_NEW = row17("referral_access", PRUNE_TG, PRUNE_TG_DEF);
const GUARD_TABLES = ["patient_cases", "queue_entries", "waitlist_entries"];
const GUARD_TG = "zz_guard_read_keys";
/** Бічний підзапит порядку — ДОСЛІВНО (з точністю до відступу) асерт накату 0203. */
const ORDER_LATERAL = [
  "select t.tgname from pg_trigger t",
  " where t.tgrelid = c.oid and not t.tgisinternal",
  "   and (t.tgtype & 3) = 3 and (t.tgtype & 20) <> 0",
  " order by t.tgname collate \"C\" desc limit 1) x",
];
const P17_ORDER_ANCHOR = "         and t.tgenabled not in ('O', 'A')\n    ) x;\n  if v_tmp is not null then\n    v_fail := v_fail || jsonb_build_array(jsonb_build_object(\n      'check', 'guard_triggers'";
const P17_ORDER_LINES = [
  "      union all",
  "      -- 0204 (Н-17): ПОРЯДОК — `zz_guard_read_keys` мусить бути ОСТАННІМ",
  "      -- BEFORE-тригером рядка на INSERT/UPDATE кожної з трьох таблиць гарда",
  "      -- (бічний підзапит — дослівно асерт накату 0203; вимкнені теж рахуються)",
  "      select 'order:' || c.relname || '->' || x.tgname",
  "        from pg_class c",
  "        cross join lateral (",
  "          " + ORDER_LATERAL[0],
  "          " + ORDER_LATERAL[1],
  "          " + ORDER_LATERAL[2],
  "          " + ORDER_LATERAL[3],
  "       where c.oid in (to_regclass('public.patient_cases'), to_regclass('public.queue_entries'),",
  "                       to_regclass('public.waitlist_entries'))",
  `         and x.tgname <> '${GUARD_TG}'`,
];
const P17_ORDER_TO = "         and t.tgenabled not in ('O', 'A')\n" + P17_ORDER_LINES.join("\n")
  + "\n    ) x;\n  if v_tmp is not null then\n    v_fail := v_fail || jsonb_build_array(jsonb_build_object(\n      'check', 'guard_triggers'";
const P17_BULLET_FROM = [
  "  --         • ПОРЯДОК спрацювання ця перевірка НЕ пінить: новий BEFORE-тригер",
  "  --           з імʼям, що за абеткою після гарда, і правкою ключа обійшов би",
  "  --           його мовчки. Порядок тримають асерт накату і статичний тест",
  "  --           пакета (`tests/auditPiiReferrerGrant.test.ts`);",
].join("\n") + "\n";
const P17_BULLET_TO = [
  "  --         • ПОРЯДОК спрацювання з 0204 пінить гілка `order:` (Н-17, абзац",
  "  --           0204 нижче): новий BEFORE-тригер з імʼям, що за абеткою після",
  "  --           гарда, червонить ніч, навіть створений поза міграціями; статичний",
  "  --           тест пакета (`tests/auditPiiReferrerGrant.test.ts`) лишається;",
].join("\n") + "\n";
const P17_PROSE_ANCHOR = "  --           перевірці невидима — гілки за властивістю 0203 не додає.\n";
const PROSE17_0204 = [
  "  --",
  "  --     ⚠️ 0204 (с80, Н-14 і Н-17) ДОДАЛА ПАРУ І ГІЛКУ, `checked` той самий:",
  "  --         • пара `referral_access` / `trg_zzz_ref_entry_markers_prune`",
  "  --           (30 → 31) — мітла позначок ЗАПИСІВ, коли грант перестає бути",
  "  --           активним (UPDATE з active, DELETE активного, зміна пари",
  "  --           направник/центр). Без неї відкликаний направник лишався б із",
  "  --           вічними крапками: з 0204 записів цього центру він не бачить.",
  "  --           Тіло `tg_ref_entry_markers_prune_on_access()` №19 НЕ пінить (як",
  "  --           і сусідньої мітли графіка) — вихолощене тіло ловить №14 гілкою",
  "  --           `unreachable:`;",
  "  --         • гілка `order:<таблиця>-><тригер>` (Н-17): на `patient_cases`,",
  "  --           `queue_entries`, `waitlist_entries` ОСТАННІЙ за `tgname collate",
  "  --           \"C\"` не-внутрішній BEFORE-тригер рядка на INSERT/UPDATE мусить",
  "  --           бути `zz_guard_read_keys` — бічний підзапит дослівно з асерту",
  "  --           накату 0203. Пізніший BEFORE-тригер (`zzz_…`), що правив би",
  "  --           ключ, обійшов би гард мовчки — тепер його назве ніч, навіть якщо",
  "  --           його створено поза міграціями. Вимкнені тригери теж рахуються:",
  "  --           їх можуть увімкнути. Таблиці — через `to_regclass`: зникла",
  "  --           таблиця дає `missing:` пари гарда, а не виняток на всю перевірку.",
  "  --        ⚠️ МЕЖІ 0204: `session_replication_role = replica` гасить усі",
  "  --           тригери, не торкаючись каталогу (межа вище); таблиця без жодного",
  "  --           BEFORE-тригера рядка дає не `order:`, а `missing:` пари гарда.",
].join("\n") + "\n";

/* ── №19: рядок `change_marker_recipients` (новий md5, `attrs` ті самі) і абзац. ── */
const row19 = (sig, dig, attrs) => `      ('${sig}','${dig}','${attrs}'),\n`;
const ROW19_OLD = row19(CMR_SIG, CMR_PRE_REC19, CMR_ATTRS);
const ROW19_NEW = row19(CMR_SIG, CMR_NEW_REC19, CMR_ATTRS);
const P19_PROSE_ANCHOR = "  --           вихолощене тіло червонить саме цю перевірку (`body:`).\n";
const PROSE19_0204 = [
  "  --     ⚠️ 0204 (с80, Н-14) ПЕРЕДРУКУВАЛА ОДИН md5 БЕЗ ЗМІНИ СКЛАДУ (список так",
  "  --        само 60): `change_marker_recipients(…)` — гілка `entry` у CTE",
  "  --        `referrer` тепер вимагає АКТИВНИЙ грант направника до центру",
  "  --        (дзеркало політик читання 0204), гілка `access` — як була.",
  "  --        Фальсифікація 0204 ставить назад тіло 0184 і вимагає від цієї",
  "  --        перевірки `body:` рівно з його дайджестом.",
  "  --        ⚠️ МЕЖА, названа вголос: нова `tg_ref_entry_markers_prune_on_access()`",
  "  --           у список НЕ внесена — як і `tg_sched_markers_prune_on_access()`",
  "  --           (0184): мітли позначок бережуть досяжність крапок, а не доступ",
  "  --           до ПДн. Її вихолощення ловить №14 (`unreachable:`), а не №19.",
].join("\n") + "\n";

const PAIRS = [
  [P14_BRANCH_ANCHOR, P14_BRANCH_TO, "№14: гілка unreachable:"],
  [P14_PROSE_ANCHOR, PROSE14_0204 + P14_PROSE_ANCHOR, "проза №14: абзац 0204"],
  ...P16_ROWS,
  [P16_PROSE_ANCHOR, P16_PROSE_ANCHOR + PROSE16_0204, "проза №16: абзац 0204"],
  [P17_PAIR_ANCHOR, P17_PAIR_ANCHOR + P17_PAIR_NEW, `№17: після referral_access/trg_audit_referral_access + ${PRUNE_TG}`],
  [P17_ORDER_ANCHOR, P17_ORDER_TO, "№17: гілка order:"],
  [P17_BULLET_FROM, P17_BULLET_TO, "проза №17: пункт про порядок"],
  [P17_PROSE_ANCHOR, P17_PROSE_ANCHOR + PROSE17_0204, "проза №17: абзац 0204"],
  [ROW19_OLD, ROW19_NEW, `№19: ${CMR} ${CMR_PRE_REC19} → ${CMR_NEW_REC19}`],
  [P19_PROSE_ANCHOR, P19_PROSE_ANCHOR + PROSE19_0204, "проза №19: абзац 0204"],
];

// ---------------------------------------------------------------------------
// 4. ХІД УПЕРЕД.
// ---------------------------------------------------------------------------
let NEW_BODY = SRC.body;
for (const [from, to, lbl] of PAIRS) {
  const hits = count(NEW_BODY, from);
  if (hits !== 1) throw new Error(`ЯКІР «${lbl}»: ${hits} влучань, а треба 1`);
  NEW_BODY = NEW_BODY.split(from).join(to);
}
const NEW_MD5 = md5(NEW_BODY);
const NEW_LEN = NEW_BODY.length;
const PIN = `guard_body_md5=${NEW_MD5};len=${NEW_LEN}`;
if (!/^guard_body_md5=[0-9a-f]{32};len=[0-9]+$/.test(PIN)) throw new Error(`ПІН не за регуляркою №25: ${PIN}`);
{
  const want = PRE_LEN + PAIRS.reduce((s, [f, t]) => s + t.length - f.length, 0);
  if (NEW_LEN !== want) throw new Error(`ДОВЖИНА ${NEW_LEN}, а з пар виходить ${want}`);
  if ([...NEW_BODY].length !== NEW_LEN) throw new Error("тіло має символи поза BMP — length у PG і JS розійдуться");
}

// ---------------------------------------------------------------------------
// 5. ЗМІСТОВІ ПЕРЕВІРКИ.
// ---------------------------------------------------------------------------
const SIG19_RE = /^ {6}\('[A-Za-z0-9_]+\([^)]*\)','[0-9a-f]{32}','[^']*'\),?$/gm;
const list19 = (body) => {
  const open = "with expd(fn, body, attrs) as (values";
  const a = body.indexOf(open);
  const b = body.indexOf("    ), cur as (", a);
  if (a < 0 || b < 0) throw new Error("список №19 не знайдено");
  return body.slice(a, b);
};
const list16 = (body) => {
  const open = "  ), expd(tbl, pol, dig) as (values\n";
  const a = body.indexOf(open);
  if (a < 0 || count(body, open) !== 1) throw new Error("список №16 не знайдено або не один");
  const b = body.indexOf("\n  )\n", a);
  return body.slice(a + open.length, b + 1);
};
const ROW16_RE = /^ {6}\('([a-z_]+)','([a-z_]+)','([0-9a-f]{12})'\),?$/;
const rows16 = (body) => list16(body).split("\n").filter((l) => l.trim()).map((l) => {
  const m = ROW16_RE.exec(l);
  if (!m) throw new Error(`№16: рядок не за формою: ${l.slice(0, 90)}`);
  return { tbl: m[1], pol: m[2], dig: m[3], line: l };
});
const list17 = (body) => {
  const open = "      select case when a.def is null";
  const a = body.indexOf(open);
  if (a < 0 || count(body, open) !== 1) throw new Error("№17: початок запиту не один");
  const v = body.indexOf("        from (values\n", a);
  const e = body.indexOf("        ) as e(tbl, tg, def)", v);
  if (v < 0 || e < 0) throw new Error("№17: межі списку не знайдено");
  return body.slice(v + "        from (values\n".length, e);
};
const ROW17_RE = /^ {6}\('([a-z_]+)','([a-z0-9_]+)','(CREATE TRIGGER [^']+)'\),?$/;
const rows17 = (body) => list17(body).split("\n").filter((l) => l.trim()).map((l) => {
  const m = ROW17_RE.exec(l);
  if (!m) throw new Error(`№17: рядок не за формою: ${l.slice(0, 90)}`);
  return { tbl: m[1], tg: m[2], def: m[3], line: l };
});
const OLD16 = rows16(SRC.body);
const NEW16 = rows16(NEW_BODY);
const OLD17 = rows17(SRC.body);
const NEW17 = rows17(NEW_BODY);
const OLD_CODE = codeOf(SRC.body);
const NEW_CODE = codeOf(NEW_BODY);
const STEP = /^  v_n := v_n \+ 1;$/gm;
const cmpC = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** Код, який пакет ДОДАЄ або МІНЯЄ (без рядків-коментарів). */
const codeLinesOf = (s) => codeOf(s).split("\n").filter((l) => l.length);
const ADDED_CODE = [
  ...codeLinesOf(P14_BRANCH_LINES.join("\n")),
  ...codeLinesOf(P17_PAIR_NEW),
  ...codeLinesOf(P17_ORDER_LINES.join("\n")),
];
const CHANGED_CODE = [
  ...P16_ROWS.map(([f, t]) => [f.replace(/\n$/, ""), t.replace(/\n$/, "")]),
  [ROW19_OLD.replace(/\n$/, ""), ROW19_NEW.replace(/\n$/, "")],
];
/* Код 0203 з рівно заявленими правками — ті самі підстановки, застосовані до
   КОДУ (без коментарів): вставки гілок №14 і №17, пара №17, чотири рядки. */
const EXPECTED_CODE = (() => {
  let c = OLD_CODE;
  const sub = (f, t, lbl) => {
    if (count(c, f) !== 1) throw new Error(`КОД: якір «${lbl}» — ${count(c, f)} влучань`);
    c = c.split(f).join(t);
  };
  sub(codeOf(P14_BRANCH_ANCHOR), codeOf(P14_BRANCH_TO), "№14 гілка");
  for (const [f, t, lbl] of P16_ROWS) sub(f, t, lbl);
  sub(P17_PAIR_ANCHOR, P17_PAIR_ANCHOR + P17_PAIR_NEW, "№17 пара");
  sub(codeOf(P17_ORDER_ANCHOR), codeOf(P17_ORDER_TO), "№17 order");
  sub(ROW19_OLD, ROW19_NEW, "№19 рядок");
  return c;
})();

const CHECKS = [
  ["№16: було 63, стало 63; змінено рівно три дайджести, ключі й порядок ті самі", () => {
    if (OLD16.length !== 63 || NEW16.length !== 63) return false;
    const changed = NEW16.map((r, i) => [r, OLD16[i]]).filter(([n, o]) => n.line !== o.line);
    return OLD16.every((o, i) => o.tbl === NEW16[i].tbl && o.pol === NEW16[i].pol)
      && JSON.stringify(changed.map(([n, o]) => [n.tbl, n.pol, o.dig, n.dig]))
        === JSON.stringify(POLICIES.map((p) => [p.tbl, p.pol, p.oldDig, p.newDig]));
  }],
  ["№17: було 30, стало 31", () => OLD17.length === 30 && NEW17.length === 31],
  ["№17: старі 30 рядків — ті самі і в тому самому порядку", () =>
    JSON.stringify(NEW17.filter((r) => r.tg !== PRUNE_TG).map((r) => r.line)) === JSON.stringify(OLD17.map((r) => r.line))],
  ["№17: нова пара — між trg_audit_referral_access і trg_zzz_sched_markers_prune, визначення = DDL", () => {
    const at = NEW17.findIndex((r) => r.tg === PRUNE_TG);
    return at > 0 && NEW17[at].tbl === "referral_access" && NEW17[at].def === PRUNE_TG_DEF
      && NEW17[at - 1].tg === "trg_audit_referral_access" && NEW17[at + 1].tg === "trg_zzz_sched_markers_prune"
      && NEW17[at + 1].line === P17_PAIR_NEXT.replace(/\n$/, "");
  }],
  ["№17: список відсортований (таблиця, тригер) — C-порядок, пари унікальні", () =>
    NEW17.every((r, i) => i === 0 || cmpC(`${NEW17[i - 1].tbl} ${NEW17[i - 1].tg}`, `${r.tbl} ${r.tg}`) < 0)
      && new Set(NEW17.map((r) => `${r.tbl}/${r.tg}`)).size === 31],
  ["№17: останній рядок — гард листа очікування без коми; у кожній таблиці гарда він останній", () =>
    NEW17.slice(0, -1).every((r) => r.line.endsWith("),")) && NEW17.at(-1).line.endsWith("')")
      && `${NEW17.at(-1).tbl}/${NEW17.at(-1).tg}` === `waitlist_entries/${GUARD_TG}`
      && GUARD_TABLES.every((t) => NEW17.filter((r) => r.tbl === t).at(-1).tg === GUARD_TG)],
  ["№17: гілка order: рівно одна, бічний підзапит = асерт накату 0203, таблиці — три гарда", () => {
    const apply0203 = readFileSync("scripts/frag/0203_apply.sql", "utf8").replace(/\r/g, "");
    const lat = ORDER_LATERAL.join("\n");
    const in0203 = normWs(apply0203).includes(normWs("cross join lateral ( " + lat));
    return count(NEW_BODY, "select 'order:' || c.relname || '->' || x.tgname") === 1 && in0203
      && normWs(NEW_BODY).includes(normWs("cross join lateral ( " + lat))
      && GUARD_TABLES.every((t) => NEW_BODY.includes(`to_regclass('public.${t}')`))
      && count(NEW_BODY, `and x.tgname <> '${GUARD_TG}'`) === 1;
  }],
  ["№14: гілка unreachable: рівно одна — join profiles, клініка позначки, активний грант, три типи", () =>
    count(NEW_BODY, "select 'unreachable:' || m.entity_type || ':' || count(*)") === 1
      && normWs(codeOf(NEW_BODY)).includes(normWs(P14_BRANCH_LINES.filter((l) => !/^\s*--/.test(l)).join("\n")))
      && count(NEW_BODY, "'check', 'ucm_orphan_markers', 'offenders', to_jsonb(v_tmp)") === 1],
  ["№19: 60 → 60 — змінено лише рядок change_marker_recipients (md5), attrs і позиція ті самі", () => {
    const o = list19(SRC.body).match(SIG19_RE) || [];
    const n = list19(NEW_BODY).match(SIG19_RE) || [];
    const diff = n.map((l, i) => [l, o[i]]).filter(([a, b]) => a !== b);
    return o.length === 60 && n.length === 60 && diff.length === 1
      && diff[0][0] === ROW19_NEW.replace(/\n$/, "") && diff[0][1] === ROW19_OLD.replace(/\n$/, "");
  }],
  ["проза №19: «сьогодні 60 підписів» = фактичний склад списку", () =>
    count(NEW_BODY, "ЩО ПІНИМО (сьогодні 60 підписів;") === 1 && (list19(NEW_BODY).match(SIG19_RE) || []).length === 60],
  ["код без коментарів: рівно заявлені правки (гілки №14 і №17, пара №17, три рядки №16, рядок №19), решта — 0203", () =>
    NEW_CODE === EXPECTED_CODE],
  ["нових рядків коду — рівно заявлені (гілка №14, пара №17, гілка №17), змінених — рівно чотири", () => {
    const oldL = OLD_CODE.split("\n"), newL = NEW_CODE.split("\n");
    const bag = (xs) => xs.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
    const ob = bag(oldL), nb = bag(newL);
    const plus = [], minus = [];
    for (const [l, k] of nb) for (let i = (ob.get(l) || 0); i < k; i++) plus.push(l);
    for (const [l, k] of ob) for (let i = (nb.get(l) || 0); i < k; i++) minus.push(l);
    const wantPlus = [...ADDED_CODE, ...CHANGED_CODE.map(([, t]) => t)].sort();
    const wantMinus = CHANGED_CODE.map(([f]) => f).sort();
    return JSON.stringify(plus.sort()) === JSON.stringify(wantPlus) && JSON.stringify(minus.sort()) === JSON.stringify(wantMinus);
  }],
  ["число кроків `v_n := v_n + 1` те саме (checked 26)", () =>
    (SRC.body.match(STEP) || []).length === CHECKED && (NEW_BODY.match(STEP) || []).length === CHECKED],
  ["перевірки №22, №23, №26 і хвіст тіла не зачеплені (від мітки №20 до кінця — байт у байт)", () =>
    NEW_BODY.slice(NEW_BODY.indexOf("  -- 20. У `profiles` типове значення")) === SRC.body.slice(SRC.body.indexOf("  -- 20. У `profiles` типове значення"))
      && NEW_BODY.indexOf("  -- 20. У `profiles` типове значення") > 0],
  ["перший рядок тіла — як у 0203", () => NEW_BODY.startsWith(SRC.body.slice(0, 200))],
  ["проза №17: «НЕ пінить» про порядок знято, опис гілки є", () =>
    !NEW_BODY.includes("ПОРЯДОК спрацювання ця перевірка НЕ пінить") && count(NEW_BODY, "ПОРЯДОК спрацювання з 0204 пінить гілка `order:`") === 1],
  ["абзаци 0204 — рівно по одному в №14, №16, №17, №19", () =>
    count(NEW_BODY, "0204 (с80, Н-14, рішення власника 25.09) ДОДАЛА ГІЛКУ `unreachable:`") === 1
      && count(NEW_BODY, "ПЕРЕЗНЯЛА ТРИ ДАЙДЖЕСТИ, список той самий (63)") === 1
      && count(NEW_BODY, "0204 (с80, Н-14 і Н-17) ДОДАЛА ПАРУ І ГІЛКУ") === 1
      && count(NEW_BODY, "0204 (с80, Н-14) ПЕРЕДРУКУВАЛА ОДИН md5 БЕЗ ЗМІНИ СКЛАДУ") === 1],
  ["проза не несе чужих тегів, кроків, міток і лапок", () =>
    [PROSE14_0204, PROSE16_0204, PROSE17_0204, PROSE19_0204, P17_BULLET_TO].every((x) => !/\$|'|v_n := v_n|'check',|\/\*|\*\/|invite_token/.test(x)
      && x.split("\n").filter(Boolean).every((l) => l.startsWith("  --")))],
  ["зворотний хід дає 0203 побайтово", () => {
    let back = NEW_BODY;
    for (const [from, to, lbl] of [...PAIRS].reverse()) {
      if (count(back, to) !== 1) throw new Error(`ЗВОРОТНИЙ ХІД «${lbl}»: ${count(back, to)} влучань`);
      back = back.split(to).join(from);
    }
    return back === SRC.body && md5(back) === PRE_MD5;
  }],
];
for (const [what, fn] of CHECKS) {
  if (!fn()) throw new Error(`ПЕРЕВІРКА НЕ ПРОЙШЛА: ${what}`);
}

// ---------------------------------------------------------------------------
// 6. ВИРАЗИ, ВИРІЗАНІ з тіла сторожа ДОСЛІВНО: `cur` №19, запити №14, №16, №17
//    (нове і старе тіло), №19 (нове). Фрагменти виконують їх як є —
//    мілісекунди замість девʼяти секунд повного прогону (урок 0196, Low-1).
// ---------------------------------------------------------------------------
const CUR_EXPR = (() => {
  const open = "    ), cur as (";
  const close = "\n    )\n    select";
  if (count(NEW_BODY, open) !== 1) throw new Error("якір `    ), cur as (` у тілі не 1");
  const a = NEW_BODY.indexOf(open);
  const b = NEW_BODY.indexOf(close, a);
  const label = NEW_BODY.indexOf("'check', 'guard_fn_bodies'", a);
  if (b < 0 || label < 0 || b > label) throw new Error("термінатор виразу cur не знайдено до мітки №19");
  return NEW_BODY.slice(a + open.length, b);
})();
if (/--|\/\*|\$/.test(CUR_EXPR)) throw new Error("ВИРАЗ cur містить коментар або долар");

/** Вирізувач запиту між межами (кожна — рівно раз), кінець включно з хвостом `tailKeep`. */
const cutter = (start, end, tailKeep) => (body, lbl) => {
  if (count(body, start) !== 1 || count(body, end) !== 1) throw new Error(`запит ${lbl}: межі не по одній (${count(body, start)} / ${count(body, end)})`);
  const a = body.indexOf(start);
  const b = body.indexOf(end, a);
  if (b < 0) throw new Error(`запит ${lbl}: кінець не після початку`);
  return body.slice(a, b + tailKeep.length);
};
const Q14_START = "  select array_agg(x.txt order by x.txt) into v_tmp\n    from (\n      select 'bad_trigger:' || t.tbl as txt";
const Q14_END = "\n    ) x;\n  if v_tmp is not null then\n    v_fail := v_fail || jsonb_build_array(jsonb_build_object(\n      'check', 'ucm_orphan_markers'";
const q14Of = cutter(Q14_START, Q14_END, "\n    ) x;");
const Q16_START = "  with cur as (\n    select p.tablename as tbl, p.policyname as pol,";
const Q16_END = "\n  ) x;\n  if v_tmp is not null then\n    v_fail := v_fail || jsonb_build_array(jsonb_build_object(\n      'check', 'policy_digest'";
const q16Of = cutter(Q16_START, Q16_END, "\n  ) x;");
const Q17_START = "  select array_agg(x.txt order by x.txt) into v_tmp\n    from (\n      select case when a.def is null";
const Q17_END = "\n    ) x;\n  if v_tmp is not null then\n    v_fail := v_fail || jsonb_build_array(jsonb_build_object(\n      'check', 'guard_triggers'";
const q17Of = cutter(Q17_START, Q17_END, "\n    ) x;");
const Q14_NEW = q14Of(NEW_BODY, "№14 нове");
const Q14_OLD = q14Of(SRC.body, "№14 старе");
const Q16_NEW = q16Of(NEW_BODY, "№16 нове");
const Q16_OLD = q16Of(SRC.body, "№16 старе");
const Q17_NEW = q17Of(NEW_BODY, "№17 нове");
const Q17_OLD = q17Of(SRC.body, "№17 старе");
for (const [lbl, q, n] of [["новий", Q17_NEW, 31], ["старий", Q17_OLD, 30]]) {
  if ((q.match(/^ {6}\('[a-z_]+','[a-z0-9_]+','CREATE TRIGGER /gm) || []).length !== n) throw new Error(`запит №17 (${lbl}): рядків не ${n}`);
  if (!q.includes("regexp_replace(pg_get_triggerdef(t.oid), '\\s+', ' ', 'g')")) throw new Error(`запит №17 (${lbl}): рендер не той`);
  if (!q.includes("and t.tgenabled not in ('O', 'A')")) throw new Error(`запит №17 (${lbl}): гілки вимкнення немає`);
  if (/\$/.test(q)) throw new Error(`запит №17 (${lbl}) містить долар`);
}
if (!Q17_NEW.includes("select 'order:' || c.relname") || Q17_OLD.includes("'order:'")) throw new Error("запит №17: гілка order: не там");
if (!Q14_NEW.includes("select 'unreachable:'") || Q14_OLD.includes("'unreachable:'")) throw new Error("запит №14: гілка unreachable: не там");
for (const p of POLICIES) {
  if (!Q16_NEW.includes(row16(p.tbl, p.pol, p.newDig)) || !Q16_OLD.includes(row16(p.tbl, p.pol, p.oldDig))) throw new Error(`запит №16: рядок ${p.pol} не той`);
}
for (const [lbl, q] of [["№14", Q14_NEW], ["№14 старий", Q14_OLD], ["№16", Q16_NEW], ["№16 старий", Q16_OLD]]) {
  if (/\$/.test(q)) throw new Error(`запит ${lbl} містить долар`);
}
const Q19_START = "  v_tmp := null;\n  select regexp_replace(pg_get_triggerdef(t.oid), '\\s+', ' ', 'g') || '/' || t.tgenabled::text\n    into v_atg\n";
const Q19_END = "  exception when others then\n    v_tmp := array['guard_fn_bodies_raised:' || sqlstate || ':' || left(sqlerrm, 120)];\n  end;\n";
const Q19_NEW = (() => {
  if (count(NEW_BODY, Q19_START) !== 1 || count(NEW_BODY, Q19_END) !== 1) throw new Error("запит №19: якорі не по одному");
  const a = NEW_BODY.indexOf(Q19_START);
  const b = NEW_BODY.indexOf(Q19_END, a);
  if (b < 0) throw new Error("запит №19: кінець не після початку");
  return NEW_BODY.slice(a, b + Q19_END.length);
})();
if ((Q19_NEW.match(SIG19_RE) || []).length !== 60 || !Q19_NEW.includes(ROW19_NEW)) throw new Error("запит №19: не 60 рядків або немає нового рядка change_marker_recipients");
if (!Q19_NEW.includes("), cur as (" + CUR_EXPR)) throw new Error("запит №19: вираз cur не той");
if (/\$/.test(Q19_NEW) || /v_n := v_n/.test(Q19_NEW)) throw new Error("запит №19 містить долар або крок лічильника");

// ---------------------------------------------------------------------------
// 7. ЗВІРКА СТЕНДОВИХ ЯКОРІВ ЗА ЛІТЕРАЛАМИ (лексер із 0201/0202/0203).
// ---------------------------------------------------------------------------
function literalsOf(src, spans = null) {
  const out = [];
  const n = src.length;
  let i = 0;
  let prev = "";
  const decode = (raw) => raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, e) => {
    if (e[0] === "u" && e[1] === "{") return String.fromCodePoint(parseInt(e.slice(2, -1), 16));
    if (e[0] === "u" && e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e[0] === "x" && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
    return { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0", "\n": "" }[e] ?? e;
  });
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1, raw = "";
      while (j < n && src[j] !== c && src[j] !== "\n") { if (src[j] === "\\") { raw += src[j] + src[j + 1]; j += 2; } else raw += src[j++]; }
      const v = decode(raw);
      if (v.length >= 12) out.push(v);
      if (spans) spans.push({ v, a: i, b: j + 1 });
      i = j + 1; prev = c; continue;
    }
    if (c === "`") {
      let j = i + 1, raw = "", plain = true;
      while (j < n && src[j] !== "`") {
        if (src[j] === "\\") { raw += src[j] + src[j + 1]; j += 2; continue; }
        if (src[j] === "$" && src[j + 1] === "{") {
          plain = false; let depth = 1; j += 2;
          while (j < n && depth > 0) { if (src[j] === "{") depth++; else if (src[j] === "}") depth--; j++; }
          continue;
        }
        raw += src[j++];
      }
      if (plain) { const v = decode(raw); if (v.length >= 12) out.push(v); if (spans) spans.push({ v, a: i, b: j + 1 }); }
      i = j + 1; prev = "`"; continue;
    }
    if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^\n".includes(prev))) {
      let j = i + 1, cls = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "[") cls = true; else if (src[j] === "]") cls = false;
        else if (src[j] === "/" && !cls) break;
        j++;
      }
      i = j + 1; prev = "/"; continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}
/** Складені якорі: літерали, зшиті `+` (як у falsify-0180), — ОДИН якір. */
function compositesOf(src) {
  const spans = [];
  literalsOf(src, spans);
  const out = [];
  for (let k = 0; k < spans.length; k++) {
    let v = spans[k].v, b = spans[k].b;
    while (k + 1 < spans.length && /^\s*\+\s*$/.test(src.slice(b, spans[k + 1].a))) {
      k++; v += spans[k].v; b = spans[k].b;
    }
    if (v.length >= 12) out.push(v);
  }
  return out;
}
/** Усі літерали всіх стендів — для звірки ФАЙЛУ (секція 9): стенди мутують
 *  файл останнього передруку ЦІЛКОМ і вимагають унікальності якоря. */
const STAND_LITERALS = new Set();
let STANDS_N = 0;
let STAND_LITS_CHECKED = 0;
{
  const stands = readdirSync("scripts").filter((f) => /^falsify-.*\.mjs$/.test(f));
  STANDS_N = stands.length;
  if (stands.length < 30) throw new Error(`ЯКОРІ: лише ${stands.length} стендів — очікувалось ≥30`);
  const migs = readdirSync(MIGDIR).filter((f) => f.endsWith(".sql") && f !== DST_NAME);
  const stale = [];
  const ambiguous = [];
  for (const f of stands) {
    const txt = readFileSync(`scripts/${f}`, "utf8").replace(/\r/g, "");
    const named = migs.filter((m) => txt.includes(`${MIGDIR}/${m}`) && m !== SRC_NAME);
    for (const x of compositesOf(txt)) STAND_LITERALS.add(x);
    for (const lit of new Set(literalsOf(txt))) {
      const before = count(SRC.body, lit);
      if (before === 0) continue;
      STAND_LITS_CHECKED++;
      const after = count(NEW_BODY, lit);
      const broken = (before === 1 && after !== 1) || after === 0;
      if (!broken) continue;
      const livesInNamed = named.some((m) =>
        readFileSync(`${MIGDIR}/${m}`, "utf8").replace(/\r/g, "").includes(lit));
      const line = `${f} ← ${JSON.stringify(lit.slice(0, 70))} (${before} → ${after})`;
      if (livesInNamed) ambiguous.push(line); else stale.push(line);
    }
  }
  if (ambiguous.length) console.log(`  ⚠️ якорі, що живуть і в поіменній старій міграції (розібрати руками):\n    ${ambiguous.join("\n    ")}`);
  if (STAND_LITS_CHECKED < 100) throw new Error(`ЯКОРІ: звірено лише ${STAND_LITS_CHECKED} літералів — розбір стендів зламався`);
  if (stale.length) throw new Error(`ЯКОРІ ПРОТУХЛИ:\n  ${stale.join("\n  ")}`);
  console.log(`  якорі стендів: ${stands.length} файлів, ${STAND_LITS_CHECKED} літералів у тілі сторожа, 0 протухлих`);
}

// ---------------------------------------------------------------------------
// 8. ФРАГМЕНТИ. Теги: $p$ — рядки підстановок; $fxa$ — change_marker_recipients;
//    $fxb$ — мітла; $fxc$ — мутації фальсифікації; блоки —
//    $apply$/$dryrun$/$back$/$falsify$. Жоден текст не сміє нести чужий тег.
// ---------------------------------------------------------------------------
const FRAG_TAGS = ["$p$", "$apply$", "$dryrun$", "$back$", "$falsify$", "$fxa$", "$fxb$", "$fxc$", "$pre$", "$chk$", "$post$", "$cmr$", "$prune$"];
for (const t of FRAG_TAGS) {
  if (NEW_BODY.includes(t)) throw new Error(`тіло сторожа містить тег ${t}`);
  for (const [f, to, lbl] of PAIRS) if ((f + to).includes(t)) throw new Error(`пара «${lbl}» містить тег ${t}`);
  for (const [lbl, x] of [["cur", CUR_EXPR], ["№14", Q14_NEW], ["№14 ст", Q14_OLD], ["№16", Q16_NEW], ["№16 ст", Q16_OLD], ["№17", Q17_NEW], ["№17 ст", Q17_OLD], ["№19", Q19_NEW]]) {
    if (x.includes(t)) throw new Error(`вираз ${lbl} містить тег ${t}`);
  }
  if (t !== CMR_TAG && (CMR_NEW_STMT.includes(t) || CMR_PRE_STMT.includes(t))) throw new Error(`${CMR} містить тег ${t}`);
  if (t !== PRUNE_TAG && PRUNE_STMT.includes(t)) throw new Error(`мітла містить тег ${t}`);
}
const q = (s) => `$p$${s}$p$`;
const lit = (s) => `'${s.replace(/'/g, "''")}'`;
const arr = (xs) => "array[\n" + xs.map((x) => `    ${q(x)}`).join(",\n") + "\n  ]";
const sqlArr = (xs) => `array[${xs.map(lit).join(", ")}]::text[]`;
const indent = (s, pad = "  ") => s.split("\n").map((l) => (l ? pad + l : l)).join("\n");
const GUARD_RELS_SQL = GUARD_TABLES.map((t) => `'public.${t}'::regclass`).join(", ");

const PRE = (tag) => [
  "  perform set_config('lock_timeout', '5s', true);",
  "  -- Шлях фіксуємо явно: інакше читання pg_proc, рендер політик і тригерів",
  "  -- залежали б від налаштування ролі оператора (урок 0196).",
  "  perform set_config('search_path', 'public, pg_temp', true);",
  "  if current_user <> 'postgres' then",
  `    raise exception '${tag}: мусить іти від ролі postgres, а йде від %', current_user;`,
  "  end if;",
].join("\n");

const LEDGER_GUARDS = (tag) => [
  `  if exists (select 1 from public.migration_ledger where name = '${DST_NAME}') then`,
  `    raise exception '${tag}: рядок уже в леджері — повторний накат заборонено';`,
  "  end if;",
  `  if not exists (select 1 from public.migration_ledger where name = '${PREV_LEDGER}') then`,
  `    raise exception '${tag}: у леджері немає 0203 — накат не в свою чергу';`,
  "  end if;",
  "  if (select max(name) from public.migration_ledger) is distinct from",
  `     '${PREV_LEDGER}' then`,
  `    raise exception '${tag}: останній рядок леджера % — не 0203, черга зсунулась',`,
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
  "  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc')",
  `     is distinct from '${wantPin}' then`,
  `    raise exception '${tag}: самопін % не збігається з тілом ${what} — спершу розібратись',`,
  "      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');",
  "  end if;",
].join("\n");

/** Дайджести трьох політик — формулою №16 (0170), дослівно з `cur` перевірки.
 *  Аліас — параметр: у КАНОНІЧНОМУ ФАЙЛІ рядки не сміють повторювати рядки тіла
 *  сторожа (якорі стендів шукають по файлу підрядком), тож там аліас `pp`;
 *  фрагменти — окремі файли, там дослівно `p`. Семантика одна — шаблон один. */
const polDigSql = (a = "p") => [
  `  select array_agg(${a}.tablename || '.' || ${a}.policyname || '=' ||`,
  `           substr(md5(coalesce(${a}.cmd, '') || '|' || coalesce(${a}.permissive, '') || '|'`,
  `                      || coalesce(array_to_string(array(select unnest(${a}.roles) order by 1), ','), '') || '|'`,
  `                      || coalesce(regexp_replace(${a}.qual, '\\s+', ' ', 'g'), '') || '|'`,
  `                      || coalesce(regexp_replace(${a}.with_check, '\\s+', ' ', 'g'), '')), 1, 12)`,
  `           order by ${a}.tablename collate "C", ${a}.policyname collate "C") into v_pol`,
  `    from pg_policies ${a}`,
  `   where ${a}.schemaname = 'public'`,
  `     and (${a}.tablename, ${a}.policyname) in (${POLICIES.map((p) => `('${p.tbl}', '${p.pol}')`).join(", ")});`,
].join("\n");
const POL_DIG_SQL = polDigSql("p");
const POL_DIG_SQL_MIG = polDigSql("pp");
const polArr = (which) => sqlArr(POLICIES.map((p) => `${p.tbl}.${p.pol}=${which === "new" ? p.newDig : p.oldDig}`));

/** Атрибути й ACL `change_marker_recipients` і мітли: пряма звірка каталогу. */
const fnAttrsAssert = (tag, regproc, what, { lang, vol, rawMd5, rettype }) => [
  "  if not exists (",
  "    select 1 from pg_proc p join pg_language l on l.oid = p.prolang",
  `     where p.oid = to_regprocedure('${regproc}')`,
  `       and p.prosecdef and p.provolatile = '${vol}' and l.lanname = '${lang}'`,
  "       and pg_get_userbyid(p.proowner) = 'postgres'",
  "       and p.proconfig = array['search_path=public, pg_temp']",
  `       and ${rettype}`,
  `       and md5(replace(p.prosrc, chr(13), '')) = '${rawMd5}'`,
  "  ) then",
  `    raise exception '${tag}: ${what} не та (атрибути або сирий md5 тіла ${rawMd5})';`,
  "  end if;",
].join("\n");
const fnAclAssert = (tag, regproc) => [
  "  -- ── ACL: пастка 0122 (дефолтний ACL схеми public роздає EXECUTE і anon,",
  "  --    і PUBLIC) — асерт у ТІЙ САМІЙ транзакції ──",
  `  if has_function_privilege('anon', '${regproc}', 'EXECUTE')`,
  `     or has_function_privilege('authenticated', '${regproc}', 'EXECUTE')`,
  "     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f'::\"char\", p.proowner))) a",
  `                 where p.oid = to_regprocedure('${regproc}') and a.grantee = 0) then`,
  `    raise exception '${tag}: ${regproc} виконують anon/authenticated/PUBLIC — ACL не звужено';`,
  "  end if;",
  `  if not has_function_privilege('service_role', '${regproc}', 'EXECUTE') then`,
  `    raise exception '${tag}: service_role втратив EXECUTE на ${regproc}';`,
  "  end if;",
  "  select array_to_string(array(select t from unnest(p.proacl::text[]) t order by t collate \"C\"), ',')",
  "    into v_acl from pg_proc p",
  `   where p.oid = to_regprocedure('${regproc}');`,
  `  if v_acl is distinct from '${FN_ACL}' then`,
  `    raise exception '${tag}: ACL ${regproc} = % замість ${FN_ACL}', v_acl;`,
  "  end if;",
].join("\n");
const CMR_ATTRS_OPTS = (raw) => ({ lang: "sql", vol: "s", rawMd5: raw, rettype: "p.proretset and p.prorettype = 'uuid'::regtype and pg_get_function_result(p.oid) = 'TABLE(recipient_id uuid)'" });
const PRUNE_ATTRS_OPTS = { lang: "plpgsql", vol: "v", rawMd5: PRUNE_RAW, rettype: "p.prorettype = 'trigger'::regtype" };

/** Рядок №19 `change_marker_recipients` — рецептом `cur` (вирізаний із тіла). */
const cmrRow19 = (tag, rec19, what) => [
  `  -- ── ${CMR} ${what}: рецепт №19 (\`cur\`, вирізаний із тіла) ──`,
  "  with expd(fn, body, attrs) as (values",
  `      ('${CMR_SIG}','${rec19}','${CMR_ATTRS}')`,
  "    ), cur as (" + CUR_EXPR,
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
  `    raise exception '${tag}: ${CMR} ${what} не та: %', v_bad;`,
  "  end if;",
].join("\n");

/** Недосяжні НЕПРОЧИТАНІ позначки ЗАПИСІВ — предикат гілки №14 `unreachable:` (агрегат).
 *  Аліаси — параметр з тієї ж причини, що й у `polDigSql` (файл: `um`/`pf`/`g`). */
const unreachSql = (into, { m = "m", p = "p", ra = "ra" } = {}) => [
  "  select coalesce(jsonb_object_agg(u.entity_type, u.n order by u.entity_type), '{}'::jsonb)",
  `    into ${into}`,
  `    from (select ${m}.entity_type, count(*) as n`,
  `            from public.user_change_markers ${m}`,
  `            join public.profiles ${p} on ${p}.id = ${m}.recipient_id`,
  `           where ${m}.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')`,
  `             and ${m}.seen_at is null`,
  `             and ${p}.clinic_id is distinct from ${m}.clinic_id`,
  `             and not exists (select 1 from public.referral_access ${ra}`,
  `                              where ${ra}.referrer_id = ${m}.recipient_id`,
  `                                and ${ra}.clinic_id = ${m}.clinic_id`,
  `                                and ${ra}.status = 'active')`,
  `           group by ${m}.entity_type) u;`,
].join("\n");
const UNREACH_SQL = (into) => unreachSql(into);
const UNREACH_SQL_MIG = (into) => unreachSql(into, { m: "um", p: "pf", ra: "g" });

/** Нових обʼєктів НЕМАЄ — строгий предстан накату. */
const ABSENT = (tag) => [
  `  if to_regprocedure('public.${PRUNE_SIG}') is not null then`,
  `    raise exception '${tag}: функція ${PRUNE_SIG} уже існує — чиясь чернетка? спершу розібратись';`,
  "  end if;",
  "  if exists (select 1 from pg_trigger t",
  "              where t.tgrelid = 'public.referral_access'::regclass and not t.tgisinternal",
  `                and t.tgname = '${PRUNE_TG}') then`,
  `    raise exception '${tag}: тригер ${PRUNE_TG} уже існує — спершу розібратись';`,
  "  end if;",
].join("\n");

/** Гард — ОСТАННІЙ BEFORE-тригер рядка на INSERT/UPDATE кожної з трьох таблиць
    (асерт накату 0203 дослівно). Тут — передумова: інакше нова гілка №17
    `order:` почервоніла б ще до DDL. */
const ZZ_LAST = (tag) => [
  `  -- ── ${GUARD_TG} — ОСТАННІЙ BEFORE-тригер рядка на INSERT/UPDATE кожної таблиці ──`,
  "  select array_agg(c.relname || '.' || x.tgname order by c.relname) into v_bad",
  "    from pg_class c",
  "    cross join lateral (",
  "      " + ORDER_LATERAL[0],
  "      " + ORDER_LATERAL[1],
  "      " + ORDER_LATERAL[2],
  "      " + ORDER_LATERAL[3],
  `   where c.oid in (${GUARD_RELS_SQL})`,
  `     and x.tgname <> '${GUARD_TG}';`,
  "  if v_bad is not null then",
  `    raise exception '${tag}: останній BEFORE-тригер рядка — не ${GUARD_TG}: % (гілка order: №17 почервоніє)', v_bad;`,
  "  end if;",
].join("\n");

/** Передумови, на яких стоїть дизайн (звіряємо, а не віримо). */
const PREMISES = (tag, { unreachStop = true } = {}) => [
  "  -- ── Передумови: прод-тіло change_marker_recipients, старі дайджести трьох",
  "  --    політик, колонки й мітки, хелпери політик, порядок гарда ──",
  "  if not exists (",
  "    select 1 from pg_proc p join pg_language l on l.oid = p.prolang",
  `     where p.oid = to_regprocedure('${CMR_REGPROC}')`,
  "       and p.prosecdef and p.provolatile = 's' and l.lanname = 'sql'",
  "       and pg_get_userbyid(p.proowner) = 'postgres'",
  "       and p.proconfig = array['search_path=public, pg_temp']",
  `       and md5(replace(p.prosrc, chr(13), '')) = '${CMR_PRE_RAW}'`,
  "  ) then",
  `    raise exception '${tag}: ${CMR} на проді не тіло 0184 (${CMR_PRE_RAW}) або атрибути інші — правка наосліп заборонена';`,
  "  end if;",
  "  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace",
  `        and p.proname = '${CMR}') <> 1 then`,
  `    raise exception '${tag}: ${CMR} має перевантаження — create or replace не про ту функцію';`,
  "  end if;",
  POL_DIG_SQL,
  `  if v_pol is distinct from ${polArr("old")} then`,
  `    raise exception '${tag}: політики читання не у формі 0203: % — правка наосліп заборонена', v_pol;`,
  "  end if;",
  "  select array_agg(x order by x) into v_bad from (",
  "    select t || '.' || col as x",
  "      from (values ('user_change_markers', 'recipient_id'), ('user_change_markers', 'clinic_id'),",
  "                   ('referral_access', 'referrer_id'), ('referral_access', 'clinic_id'),",
  "                   ('profiles', 'clinic_id'), ('queue_entries', 'created_by'), ('queue_entries', 'referrer_id'),",
  "                   ('queue_entries', 'clinic_id'), ('waitlist_entries', 'created_by'),",
  "                   ('waitlist_entries', 'referrer_id'), ('waitlist_entries', 'clinic_id'),",
  "                   ('patient_cases', 'created_by'), ('patient_cases', 'referrer_id'),",
  "                   ('patient_cases', 'clinic_id')) as v(t, col)",
  "     where not exists (select 1 from pg_attribute a",
  "                        where a.attrelid = to_regclass('public.' || t)",
  "                          and a.attname = col and a.attnum > 0 and not a.attisdropped",
  "                          and a.atttypid = 'uuid'::regtype)",
  "  ) m;",
  "  if v_bad is not null then",
  `    raise exception '${tag}: колонок немає або вони не uuid: %', v_bad;`,
  "  end if;",
  "  if (select a.atttypid from pg_attribute a",
  "       where a.attname = 'status' and a.attrelid = 'public.referral_access'::regclass)",
  "       is distinct from 'public.referral_access_status'::regtype",
  "     or not exists (select 1 from pg_enum e",
  "                     where e.enumtypid = 'public.referral_access_status'::regtype",
  "                       and e.enumlabel = 'active')",
  "     or (select a.atttypid from pg_attribute a",
  "          where a.attname = 'entity_type' and a.attrelid = 'public.user_change_markers'::regclass)",
  "          is distinct from 'text'::regtype then",
  `    raise exception '${tag}: тип статусу гранту, мітка active або тип entity_type не ті';`,
  "  end if;",
  "  if (select count(*) from pg_constraint co",
  "       where co.conrelid = 'public.user_change_markers'::regclass and co.conname = 'ucm_entity_type_chk'",
  "         and pg_get_constraintdef(co.oid) like '%''queue_entry''%'",
  "         and pg_get_constraintdef(co.oid) like '%''waitlist_entry''%'",
  "         and pg_get_constraintdef(co.oid) like '%''patient_case''%') <> 1 then",
  `    raise exception '${tag}: ucm_entity_type_chk не знає трьох типів записів — мітла й №14 міряли б не те';`,
  "  end if;",
  "  select array_agg(f order by f) into v_bad",
  "    from unnest(array['public.auth_referrer_clinics()', 'public.auth_clinic_id()', 'public.auth_role()',",
  "                       'public.auth_radiologist_room_ok(uuid)']) f",
  "   where to_regprocedure(f) is null;",
  "  if v_bad is not null then",
  `    raise exception '${tag}: хелперів політик немає: %', v_bad;`,
  "  end if;",
  ZZ_LAST(tag),
  "  -- Недосяжні НЕПРОЧИТАНІ позначки ЗАПИСІВ уже зараз (предикат нової гілки",
  "  -- №14): на проді 26.09 — 0 (прочитаних — теж 0). Є — повний сторож нижче",
  "  -- почервонів би `unreachable:`; до накату їх прибирають ЛИШЕ за явним",
  "  -- списком id зі свіжого знімка (AGENTS.md). Прочитані — не стоп: крапки не",
  "  -- запалюють, ретенція прибирає їх сама.",
  UNREACH_SQL("v_unreach"),
  ...(unreachStop ? [
    "  if v_unreach <> '{}'::jsonb then",
    `    raise exception '${tag}: уже є недосяжні НЕПРОЧИТАНІ позначки записів % — до накату ручна зачистка за явним списком id (AGENTS.md, видалення даних проду)', v_unreach;`,
    "  end if;",
  ] : []),
].join("\n");

const fnExec = (tag, stmt) => `  execute ${tag}\n${stmt.replace(/;\s*$/, "")}\n${tag};`;

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
  "  -- ── Самопін №25 — у ТІЙ САМІЙ транзакції ─────────────────────────────────",
  "  v_pin_db := 'guard_body_md5=' || md5(v_src) || ';len=' || length(v_src);",
  `  if v_pin_db is distinct from '${wantPin}' then`,
  `    raise exception '${tag}: пін із БД (%) розійшовся з піном із файлу (${wantPin})', v_pin_db;`,
  "  end if;",
  "  execute format('comment on function public.invariants_check(boolean) is %L', v_pin_db);",
  "  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc') is distinct from v_pin_db then",
  `    raise exception '${tag}: пін не ліг — у коментарі %',`,
  "      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');",
  "  end if;",
].join("\n");

const WANT17_BEFORE = [`missing:referral_access.${PRUNE_TG}`];
const KNOWN_RED_SQL = `(${[...KNOWN_RED, "policy_digest", "guard_triggers"].map(lit).join(", ")})`;
/** ПОВНИЙ сторож ДО DDL. Червона база, побудована самим накатом: нове тіло вже
    чекає нові дайджести і нову пару — №16 МУСИТЬ назвати рівно три `changed:`,
    №17 — рівно один `missing:`. Зелене тут = списки не живі. */
const SENTINEL_CALL = "  v_res := public.invariants_check(false);";
const SENTINEL_BEFORE = (tag) => [
  "  -- ── ПОВНИЙ сторож ДО DDL на таблицях (≈9 с — замків на таблиці ще немає) ──",
  SENTINEL_CALL,
  `  if (v_res->>'checked')::int <> ${CHECKED} then`,
  `    raise exception '${tag}: сторож перевірив % замість ${CHECKED}', v_res->>'checked';`,
  "  end if;",
  "  select array_agg(e.value->>'check' order by e.value->>'check') into v_failed",
  "    from jsonb_array_elements(v_res->'failed') e",
  `   where e.value->>'check' not in ${KNOWN_RED_SQL};`,
  "  if v_failed is not null then",
  `    raise exception '${tag}: до DDL сторож червоний не від пакета: % — %', v_failed, v_res->'failed';`,
  "  end if;",
  "  select array_agg(o.value order by o.value collate \"C\") into v_off16",
  "    from jsonb_array_elements(v_res->'failed') e,",
  "         jsonb_array_elements_text(e.value->'offenders') o",
  "   where e.value->>'check' = 'policy_digest';",
  `  if v_off16 is distinct from ${sqlArr(WANT16_BEFORE)} then`,
  `    raise exception '${tag}: №16 до DDL мусить назвати рівно три changed: політик читання, а назвав % — список №16 не живий?', v_off16;`,
  "  end if;",
  "  select array_agg(o.value order by o.value collate \"C\") into v_off17",
  "    from jsonb_array_elements(v_res->'failed') e,",
  "         jsonb_array_elements_text(e.value->'offenders') o",
  "   where e.value->>'check' = 'guard_triggers';",
  `  if v_off17 is distinct from ${sqlArr(WANT17_BEFORE)} then`,
  `    raise exception '${tag}: №17 до DDL мусить назвати рівно одну відсутню пару мітли, а назвав % — список №17 не живий?', v_off17;`,
  "  end if;",
].join("\n");

/** Запит перевірки ДОСЛІВНО з тіла (мілісекунди). */
const Q_ASSERT = (tag, lbl, qtext, what) => [
  `  -- ── ${lbl} ${what}: запит вирізано ДОСЛІВНО з тіла ──`,
  "  v_tmp := null;",
  qtext,
  "  if v_tmp is not null then",
  `    raise exception '${tag}: ${lbl} ${what} червоний: %', v_tmp;`,
  "  end if;",
].join("\n");

const DECL = (tag, fromXs, toXs, lblXs, extra = []) => [
  "-- ⚠️ Бюджет часу — ЗОВНІ блоку: `set statement_timeout` усередині `do` інертний",
  "--    (канон 0192). MCP жене батч однією транзакцією, після `raise` set відкочується.",
  "set statement_timeout = '5min';",
  `do $${tag}$`,
  "declare",
  "  v_def text; v_body text; v_src text; v_head text; v_new text;",
  "  v_hits int; v_rows int; v_res jsonb; v_pin_db text; v_bad text[]; v_tmp text[];",
  "  v_failed text[]; v_off16 text[]; v_off17 text[]; v_acl text; v_pol text[]; v_unreach jsonb;",
  ...extra,
  `  v_from constant text[] := ${arr(fromXs)};`,
  `  v_to   constant text[] := ${arr(toXs)};`,
  `  v_lbl  constant text[] := ${arr(lblXs)};`,
  "begin",
].join("\n");

const FWD = [PAIRS.map((p) => p[0]), PAIRS.map((p) => p[1]), PAIRS.map((p) => p[2])];
const BWD = [[...PAIRS].reverse().map((p) => p[1]), [...PAIRS].reverse().map((p) => p[0]),
  [...PAIRS].reverse().map((p) => `назад: ${p[2]}`)];

const LEDGER_INSERT = (tag) => [
  "  insert into public.migration_ledger (name)",
  `  values ('${DST_NAME}');`,
  "  get diagnostics v_rows = row_count;",
  "  if v_rows <> 1 then",
  `    raise exception '${tag}: рядок леджера не ліг (% рядків)', v_rows;`,
  "  end if;",
].join("\n");

/** DDL на таблицях — ОСТАННІМ кроком перед леджером: три `alter policy`
    (ACCESS EXCLUSIVE на три гарячі таблиці) і тригер мітли на `referral_access`. */
const TABLE_DDL = [NEW_POLICY_DDL, "", PRUNE_TG_DDL].join("\n");

/** Тіло накату — спільне для apply і dryrun. `beforeDdl` — замір сухого прогону
    (ДО DDL: після нього на таблицях уже замки). */
const FORWARD = (tag, beforeDdl = null, premOpts = {}) => [
  PRE(tag),
  LEDGER_GUARDS(tag),
  readGuard(tag, PRE_MD5, PRE_LEN, PRE_PIN, "0203"),
  ABSENT(tag),
  PREMISES(tag, premOpts),
  "",
  `  -- ── 1. ${CMR}: гілка entry — лише з АКТИВНИМ грантом (замків на таблиці не бере) ──`,
  fnExec("$fxa$", CMR_NEW_STMT),
  indent(CMR_ACL_DDL),
  cmrRow19(tag, CMR_NEW_REC19, "після заміни"),
  fnAttrsAssert(tag, CMR_REGPROC, `${CMR} після заміни`, CMR_ATTRS_OPTS(CMR_NEW_RAW)),
  fnAclAssert(tag, CMR_REGPROC),
  "",
  "  -- ── 2. Мітла позначок записів і її ACL (замків на таблиці не бере) ──",
  fnExec("$fxb$", PRUNE_STMT),
  indent(PRUNE_ACL_DDL),
  fnAttrsAssert(tag, `public.${PRUNE_SIG}`, `${PRUNE_SIG} після створення`, PRUNE_ATTRS_OPTS),
  fnAclAssert(tag, `public.${PRUNE_SIG}`),
  "",
  "  -- ── 3. Передрук сторожа: №14, №16, №17, №19 і проза ─────────────────────",
  substitute(tag, "v_from", "v_to", "v_lbl", NEW_MD5, NEW_LEN, "файл 0204"),
  "",
  pinBlock(tag, PIN),
  "",
  SENTINEL_BEFORE(tag),
  ...(beforeDdl ? ["", beforeDdl] : []),
  "",
  "  -- ── 4. DDL на таблицях — ОСТАННІМ кроком перед леджером: ACCESS EXCLUSIVE на",
  "  --    queue_entries, waitlist_entries, patient_cases (alter policy) і на",
  "  --    referral_access (тригер) тримається мілісекунди ──",
  indent(TABLE_DDL),
  "",
  Q_ASSERT(tag, "№16", Q16_NEW, "після DDL"),
  "",
  Q_ASSERT(tag, "№17", Q17_NEW, "після DDL"),
  "",
  LEDGER_INSERT(tag),
].join("\n");

const READBACK = [
  "select md5(replace(p.prosrc, chr(13), '')) as guard_md5,",
  "       length(replace(p.prosrc, chr(13), '')) as guard_len,",
  "       obj_description(p.oid, 'pg_proc') as guard_pin,",
  "       (select count(*) from public.migration_ledger) as ledger_rows,",
  "       (select max(name) from public.migration_ledger) as ledger_last,",
  "       (select string_agg(pp.tablename || '.' || pp.policyname || '=' ||",
  "                substr(md5(coalesce(pp.cmd, '') || '|' || coalesce(pp.permissive, '') || '|'",
  "                           || coalesce(array_to_string(array(select unnest(pp.roles) order by 1), ','), '') || '|'",
  "                           || coalesce(regexp_replace(pp.qual, '\\s+', ' ', 'g'), '') || '|'",
  "                           || coalesce(regexp_replace(pp.with_check, '\\s+', ' ', 'g'), '')), 1, 12),",
  "                ',' order by pp.tablename collate \"C\")",
  "          from pg_policies pp",
  "         where pp.schemaname = 'public'",
  `           and (pp.tablename, pp.policyname) in (${POLICIES.map((x) => `('${x.tbl}', '${x.pol}')`).join(", ")})) as policies,`,
  `       (select md5(replace(f.prosrc, chr(13), '')) from pg_proc f where f.oid = to_regprocedure('${CMR_REGPROC}')) as cmr_raw_md5,`,
  `       to_regprocedure('public.${PRUNE_SIG}') is not null as prune_fn,`,
  "       (select array_to_string(array(select t from unnest(f.proacl::text[]) t order by t collate \"C\"), ',')",
  `          from pg_proc f where f.oid = to_regprocedure('public.${PRUNE_SIG}')) as prune_fn_acl,`,
  "       (select count(*) from pg_trigger t",
  `         where t.tgrelid = 'public.referral_access'::regclass and t.tgname = '${PRUNE_TG}' and t.tgenabled = 'O') as prune_trigger,`,
  "       (select count(*) from pg_class c",
  "          cross join lateral (",
  "            " + ORDER_LATERAL[0],
  "            " + ORDER_LATERAL[1],
  "            " + ORDER_LATERAL[2],
  "            " + ORDER_LATERAL[3],
  `         where c.oid in (${GUARD_RELS_SQL})`,
  `           and x.tgname = '${GUARD_TG}') as zz_last_tables`,
  "  from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  " where n.nspname = 'public' and p.proname = 'invariants_check'",
  "   and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';",
].join("\n");
const policiesReadback = (which) => POLICIES.map((x) => `${x.tbl}.${x.pol}=${which === "new" ? x.newDig : x.oldDig}`).join(",");

const RED_WINDOW = [
  "-- ⚠️ ЧЕРВОНЕ ВІКНО (AGENTS.md, «Миграции и БД»): з commit цього блоку і до пушу",
  "--    `main` з файлом 0204 падає КОЖНА прод-збірка (гейт: рядок леджера без файла",
  "--    на диску). У вікні: жодного Redeploy, нічого іншого в `main`. Закрити ОДНИМ",
  "--    заходом: `npm run db:gate` → `npm test` → гілка → dev → main → push → деплой;",
  "--    перевірка — `npm run db:gate:check` на `main` І на `dev`. Не закрили в цей",
  "--    захід — `scripts/frag/0204_rollback.sql`, а не «доробимо завтра». Ліміт",
  "--    03:50 UTC (06:50 Київ) — на ВЕСЬ відрізок «накат → db:gate».",
].join("\n");

const APPLY = [
  "-- 0204 APPLY — ЗГЕНЕРОВАНО `node scripts/build-0204-reprint.mjs`. Одним запитом,",
  "-- ОДНА транзакція: change_marker_recipients → мітла + ACL → передрук сторожа →",
  "-- пін → ПОВНИЙ сторож (до DDL на таблицях) → три політики + тригер мітли →",
  "-- запити №16 і №17 дослівно → леджер.",
  "-- ⚠️ Канонічний файл міграції накатувати НЕ можна (кілька верхньорівневих",
  "--    стейтментів; тут — суворий предстан, у файлі — ідемпотентний).",
  "-- ⚠️ ТЕКСТ СЛАТИ ДОСЛІВНО (краще — базою через net.http_get, AGENTS.md с79):",
  "--    тіла функцій усередині $fxa$/$fxb$ і якорі всередині $p$ входять у md5 —",
  "--    «прибрати рядки-коментарі» зламає пост-перевірки, і накат зупиниться.",
  "-- ⚠️ ТРИВАЛІСТЬ ≈10 с, і майже вся — повний прогін сторожа. Він стоїть ДО",
  "--    DDL на таблицях свідомо (урок 0196: 9 с під замком = впалі записи",
  "--    реєстратури, бо в authenticated statement_timeout 8 с). ACCESS EXCLUSIVE",
  "--    на queue_entries / waitlist_entries / patient_cases (alter policy) і на",
  "--    referral_access (тригер) живуть мілісекунди до commit.",
  RED_WINDOW,
  "-- ⚠️ `invariants_check(false)` ПІСЛЯ commit — окремим запитом. Очікування:",
  `--    checked ${CHECKED}; failed ⊆ {${KNOWN_RED.join(", ")}, ledger_md5} (ledger_md5 — до \`npm run db:gate\`).`,
  DECL("apply", ...FWD),
  FORWARD("0204"),
  "",
  "  raise notice 'APPLY_0204_OK guard=% len=% pin=% ledger=%',",
  "    md5(v_src), length(v_src), v_pin_db, (select count(*) from public.migration_ledger);",
  "end;",
  "$apply$;",
  "",
  "-- Читання назад: очікування",
  `--   guard_md5 = ${NEW_MD5}, guard_len = ${NEW_LEN},`,
  `--   guard_pin = ${PIN}, ledger_rows = 204, ledger_last = ${DST_NAME},`,
  `--   policies = ${policiesReadback("new")},`,
  `--   cmr_raw_md5 = ${CMR_NEW_RAW}, prune_fn = true, prune_fn_acl = ${FN_ACL},`,
  "--   prune_trigger = 1, zz_last_tables = 3",
  READBACK,
  "",
  "-- ⚠️ `invariants_check` — ОКРЕМИМ запитом ПІСЛЯ commit. Не в 03:45–04:05 UTC.",
  "--      select public.invariants_check(false);",
  `--      -- очікування: checked ${CHECKED}; до \`npm run db:gate\` failed ⊆ {${KNOWN_RED.join(", ")}, ledger_md5}.`,
].join("\n");

/** Сухий прогін додає ЗАМІР радіуса (агрегати, без ПДн; ДО DDL): скільки
    рядків черги / листа / кейсів і скільки профілів (за ролями) ВТРАЧАЮТЬ
    читання за ключем `created_by` / `referrer_id` — тобто ключ є, а жодна
    гілка політик 0204 (персонал центру з кабінетною межею радіолога, активний
    грант, CEO центру для черги й листа) його не пускає. Дзеркало ВСІХ
    SELECT-політик цих таблиць після 0204 (`*_write_*` FOR ALL теж: їх гілки
    для направника вимагають гранту, для персоналу — центру). */
const RADIUS = [
  "  -- ── ЗАМІР (не умова зупинки; агрегати, без ПДн): хто ВТРАЧАЄ читання ──",
  "  --    radius_rows(q/w/c) — рядки, де хоч один власник ключа (created_by /",
  "  --    referrer_id) після 0204 рядка не бачить; radius_profiles — такі профілі",
  "  --    за роллю (distinct); radius_keys — пари «таблиця:ключ:роль». Стоїть ДО",
  "  --    DDL — після нього на таблицях уже замки ──",
  "  with keyed as (",
  "    select 'q' as t, q.id, q.clinic_id as c, q.room_id as room, k.key, k.pid",
  "      from public.queue_entries q",
  "      cross join lateral (values ('created_by', q.created_by), ('referrer_id', q.referrer_id)) as k(key, pid)",
  "     where k.pid is not null",
  "    union all",
  "    select 'w', w.id, w.clinic_id, w.room_id, k.key, k.pid",
  "      from public.waitlist_entries w",
  "      cross join lateral (values ('created_by', w.created_by), ('referrer_id', w.referrer_id)) as k(key, pid)",
  "     where k.pid is not null",
  "    union all",
  "    select 'c', pc.id, pc.clinic_id, null::uuid, k.key, k.pid",
  "      from public.patient_cases pc",
  "      cross join lateral (values ('created_by', pc.created_by), ('referrer_id', pc.referrer_id)) as k(key, pid)",
  "     where k.pid is not null",
  "  ), judged as (",
  "    select x.t, x.id, x.key, x.pid, coalesce(p.role::text, 'no_profile') as role,",
  "           -- ⚠️ coalesce: у направника `profiles.clinic_id` NULL, і без нього",
  "           -- `keeps` ставав NULL, а `not keeps` — теж NULL: рядок випадав із",
  "           -- лічби (перша редакція заміру показала на проді 0 замість 2)",
  "           coalesce(( -- персонал центру запису (перша гілка політик; радіолог — лише свої кабінети / кейси)",
  "             (coalesce(p.clinic_id = x.c, false)",
  "              and (p.role is distinct from 'radiologist'",
  "                   or (x.t <> 'c' and x.room is not null",
  "                       and exists (select 1 from public.radiologist_rooms rr",
  "                                    where rr.profile_id = x.pid and rr.room_id = x.room))",
  "                   or (x.t = 'c'",
  "                       and exists (select 1 from public.queue_entries q2",
  "                                     join public.radiologist_rooms rr",
  "                                       on rr.room_id = q2.room_id and rr.profile_id = x.pid",
  "                                    where q2.case_id = x.id))))",
  "             -- АКТИВНИЙ грант до центру запису (нова гілка ключа)",
  "             or exists (select 1 from public.referral_access ra",
  "                         where ra.referrer_id = x.pid and ra.clinic_id = x.c and ra.status = 'active')",
  "             -- CEO центру (queue_ceo_read / waitlist_ceo_read; кейсів CEO не читає)",
  "             or (x.t <> 'c'",
  "                 and exists (select 1 from public.ceo_access ca",
  "                              where ca.ceo_id = x.pid and ca.clinic_id = x.c and ca.status = 'active'))",
  "           ), false) as keeps",
  "      from keyed x",
  "      left join public.profiles p on p.id = x.pid",
  "  )",
  "  select count(distinct j.id) filter (where j.t = 'q' and not j.keeps),",
  "         count(distinct j.id) filter (where j.t = 'w' and not j.keeps),",
  "         count(distinct j.id) filter (where j.t = 'c' and not j.keeps),",
  "         coalesce((select jsonb_object_agg(r.role, r.n order by r.role)",
  "                     from (select j2.role, count(distinct j2.pid) as n from judged j2",
  "                            where not j2.keeps group by j2.role) r), '{}'::jsonb),",
  "         coalesce((select jsonb_object_agg(r.k, r.n order by r.k)",
  "                     from (select j3.t || ':' || j3.key || ':' || j3.role as k, count(distinct j3.id) as n",
  "                             from judged j3 where not j3.keeps group by 1) r), '{}'::jsonb)",
  "    into v_rq, v_rw, v_rc, v_rprof, v_rkeys",
  "    from judged j;",
].join("\n");

const DRYRUN = [
  "-- 0204 DRY RUN — ЗГЕНЕРОВАНО `node scripts/build-0204-reprint.mjs`. Те саме, що",
  "-- APPLY, плюс ЗАМІР радіуса (до DDL); транзакція СВІДОМО валиться в кінці.",
  "-- ⚠️ Маркер відкоту ОБОВʼЯЗКОВИЙ: «сухий» прогін без нього — це НАКАТ.",
  "-- ⚠️ Запит ПОЧИНАЄТЬСЯ з `set statement_timeout` (перший стейтмент), другий —",
  "--    `do` з тегом `dryrun`. Перед вставкою перевірити обидва і маркер",
  "--    `DRYRUN_0204_ROLLBACK` у кінці блоку: без них це НАКАТ.",
  "-- ⚠️ УСПІХ = ПОМИЛКА з текстом `DRYRUN_0204_ROLLBACK …`, `ok16=true`, `ok17=true`.",
  "--    Будь-який інший текст — провал, прочитати і розібратись.",
  "-- ⚠️ `radius_*` — ЗАМІР, не стоп: інше число — переглянути абзац ціни в",
  "--    PR-доці. Недосяжні НЕПРОЧИТАНІ позначки записів — СТОП (`уже є недосяжні",
  "--    НЕПРОЧИТАНІ позначки записів …`; повний сторож назвав би їх червоними):",
  "--    ручна зачистка за явним списком id ДО накату. `unreachable={}` у рядку",
  "--    успіху — підтвердження, що їх 0.",
  "-- ⚠️ ТРИВАЛІСТЬ ≈10 с; замки на таблиці — лише наприкінці і мілісекунди.",
  DECL("dryrun", ...FWD, ["  v_rq bigint; v_rw bigint; v_rc bigint; v_rprof jsonb; v_rkeys jsonb;"]),
  FORWARD("0204-суха", RADIUS),
  "",
  "  raise exception 'DRYRUN_0204_ROLLBACK guard=% len=% pin=% checked=% ok16=true ok17=true failed_before_ddl=% unreachable=% radius_rows(q/w/c)=%/%/% radius_profiles=% radius_keys=%',",
  "    md5(v_src), length(v_src), v_pin_db, v_res->>'checked', v_res->'failed', v_unreach, v_rq, v_rw, v_rc, v_rprof, v_rkeys;",
  "end;",
  "$dryrun$;",
  "",
  "-- ⚠️ `failed_before_ddl` містить `policy_digest` з РІВНО трьома `changed:` і",
  "--    `guard_triggers` з РІВНО одним `missing:` — це червона база, так і мусить",
  "--    бути (асерти в блоці це вже перевірили).",
].join("\n");

const ROLLBACK = [
  "-- 0204 ROLLBACK — ЗГЕНЕРОВАНО `node scripts/build-0204-reprint.mjs`.",
  "-- Знімає тригер і функцію мітли, повертає change_marker_recipients (тіло 0184),",
  "-- три політики читання (форма 0203), тіло сторожа і самопін 0203, знімає",
  "-- рядок леджера. Позначки, які мітла ВЖЕ видалила, відкат НЕ повертає (мітла",
  "-- не пише, що зняла; це позначки записів, яких направник і так не бачив).",
  "-- ⚠️ Одна транзакція. Перевіряти ОКРЕМИМ запитом після commit.",
  DECL("back", ...BWD),
  PRE("0204-відкат"),
  `  if not exists (select 1 from public.migration_ledger where name = '${DST_NAME}') then`,
  "    raise exception '0204-відкат: рядка 0204 у леджері немає — відкочувати нічого';",
  "  end if;",
  "  if (select max(name) from public.migration_ledger) is distinct from",
  `     '${DST_NAME}' then`,
  "    raise exception '0204-відкат: після 0204 уже накатано % — спершу відкотити його',",
  "      (select max(name) from public.migration_ledger);",
  "  end if;",
  readGuard("0204-відкат", NEW_MD5, NEW_LEN, PIN, "0204"),
  cmrRow19("0204-відкат", CMR_NEW_REC19, "до відкату"),
  fnAttrsAssert("0204-відкат", `public.${PRUNE_SIG}`, `${PRUNE_SIG} до відкату`, PRUNE_ATTRS_OPTS),
  Q_ASSERT("0204-відкат", "№16", Q16_NEW, "до відкату"),
  Q_ASSERT("0204-відкат", "№17", Q17_NEW, "до відкату"),
  "",
  "  -- ── Функції (замків на таблиці не беруть): change_marker_recipients — тіло 0184 ──",
  fnExec("$fxa$", CMR_PRE_STMT),
  indent(CMR_ACL_DDL),
  cmrRow19("0204-відкат", CMR_PRE_REC19, "після відкату"),
  fnAttrsAssert("0204-відкат", CMR_REGPROC, `${CMR} після відкату`, CMR_ATTRS_OPTS(CMR_PRE_RAW)),
  fnAclAssert("0204-відкат", CMR_REGPROC),
  "",
  substitute("0204-відкат", "v_from", "v_to", "v_lbl", PRE_MD5, PRE_LEN, "0203"),
  "",
  pinBlock("0204-відкат", PRE_PIN),
  "",
  "  -- ── DDL на таблицях — останнім: політики форми 0203, тригер і функція мітли ──",
  indent(OLD_POLICY_DDL),
  `  drop trigger if exists ${PRUNE_TG} on public.referral_access;`,
  `  drop function public.${PRUNE_SIG};`,
  `  if to_regprocedure('public.${PRUNE_SIG}') is not null`,
  "     or exists (select 1 from pg_trigger t where t.tgrelid = 'public.referral_access'::regclass",
  `                  and t.tgname = '${PRUNE_TG}') then`,
  "    raise exception '0204-відкат: мітла лишилась (функція або тригер)';",
  "  end if;",
  "",
  Q_ASSERT("0204-відкат", "№16", Q16_OLD, "після відкату"),
  "",
  Q_ASSERT("0204-відкат", "№17", Q17_OLD, "після відкату"),
  "",
  `  delete from public.migration_ledger where name = '${DST_NAME}';`,
  "  get diagnostics v_rows = row_count;",
  "  if v_rows <> 1 then",
  "    raise exception '0204-відкат: знято % рядків леджера замість 1', v_rows;",
  "  end if;",
  "",
  "  raise notice 'ROLLBACK_0204_OK guard=% len=% pin=% ledger=%',",
  "    md5(v_src), length(v_src), v_pin_db, (select count(*) from public.migration_ledger);",
  "end;",
  "$back$;",
  "",
  "-- Читання назад: очікування",
  `--   guard_md5 = ${PRE_MD5}, guard_len = ${PRE_LEN},`,
  `--   guard_pin = ${PRE_PIN}, ledger_rows = 203, ledger_last = ${PREV_LEDGER},`,
  `--   policies = ${policiesReadback("old")},`,
  `--   cmr_raw_md5 = ${CMR_PRE_RAW}, prune_fn = false, prune_fn_acl = NULL,`,
  "--   prune_trigger = 0, zz_last_tables = 3",
  READBACK,
  "",
  "-- ⚠️ ЦЕЙ ФРАГМЕНТ НЕ ДОВОДИТЬ ВІДКАТУ: асерти — усередині транзакції. Після",
  "--    commit ОКРЕМИМ запитом читання назад вище і `select public.invariants_check(false);`",
  `--    (checked ${CHECKED}, без \`policy_digest\` і \`guard_triggers\`). Git-частина — секція ВІДКАТ у міграції.`,
].join("\n");

// ── ФАЛЬСИФІКАЦІЯ ──────────────────────────────────────────────────────────
/* Проби — під імперсонацією (`request.jwt.claims` + `set local role
   authenticated`) на СИНТЕТИЧНИХ рядках трьох таблиць, створених у транзакції;
   гранти фабрикуються в ній же. Мутації — лише після проб; під ними — дослівні
   запити №14, №16, №17, №19 (мілісекунди). У повідомленнях — лише числа. */
const PROBE_LABELS = [];
const probeName = (l) => { if (PROBE_LABELS.includes(l)) throw new Error(`проба ${l} двічі`); PROBE_LABELS.push(l); return l; };
const claims = (who) => `json_build_object('sub', ${who}, 'role', 'authenticated')::text`;
/** Скільки з трьох синтетичних рядків (q/w/c) бачить `who` крізь RLS. */
const readProbe = (label, who, want, opt = null) => {
  probeName(label);
  const body = [
    `  -- ${label}`,
    "  begin",
    `    perform set_config('request.jwt.claims', ${claims(who)}, true);`,
    "    set local role authenticated;",
    "    select (select count(*) from public.queue_entries where id = v_q)",
    "           || '/' || (select count(*) from public.waitlist_entries where id = v_w)",
    "           || '/' || (select count(*) from public.patient_cases where id = v_c)",
    "      into v_seen;",
    "    reset role;",
    "    perform set_config('request.jwt.claims', '{}', true);",
    `    if v_seen = '${want}' then`,
    `      v_ok := v_ok || ${lit(label)}::text;`,
    "    else",
    `      v_miss := v_miss || (${lit(`${label}: бачить `)} || v_seen || ${lit(` замість ${want}`)});`,
    "    end if;",
    "  exception when others then",
    "    get stacked diagnostics v_msg = message_text;",
    `    v_miss := v_miss || (${lit(`${label}: `)} || sqlstate || ' ' || left(v_msg, 80));`,
    "  end;",
    "  reset role;",
    "  perform set_config('request.jwt.claims', '{}', true);",
  ].join("\n");
  if (!opt) return body;
  return [`  if ${opt} is null then`, `    v_na := v_na || ${lit(label)}::text;`, "  else", indent(body), "  end if;"].join("\n");
};
/** Довільна булева перевірка стану (службова роль). */
const stateProbe = (label, cond, detail, opt = null) => {
  probeName(label);
  const body = [
    `  -- ${label}`,
    "  begin",
    `    if ${cond} then`,
    `      v_ok := v_ok || ${lit(label)}::text;`,
    "    else",
    `      v_miss := v_miss || (${lit(`${label}: `)} || ${detail});`,
    "    end if;",
    "  exception when others then",
    "    get stacked diagnostics v_msg = message_text;",
    `    v_miss := v_miss || (${lit(`${label}: `)} || sqlstate || ' ' || left(v_msg, 80));`,
    "  end;",
  ].join("\n");
  if (!opt) return body;
  return [`  if ${opt} is null then`, `    v_na := v_na || ${lit(label)}::text;`, "  else", indent(body), "  end if;"].join("\n");
};
const setGrant = (ref, clinic, status) => [
  "  perform set_config('request.jwt.claims', '{}', true);",
  `  insert into public.referral_access (referrer_id, clinic_id, status) values (${ref}, ${clinic}, '${status}')`,
  "    on conflict (referrer_id, clinic_id) do update set status = excluded.status;",
].join("\n");
/** Позначки ЗАПИСІВ направника в центрі (усі три типи) — рахунок. */
const entryMarks = (ref, clinic) => `(select count(*) from public.user_change_markers m where m.recipient_id = ${ref} and m.clinic_id = ${clinic} and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case'))`;
const accessMarks = (ref, clinic) => `(select count(*) from public.user_change_markers m where m.recipient_id = ${ref} and m.clinic_id = ${clinic} and m.entity_type = 'referral_access')`;
/** Фабрикована позначка запису (для проб мітли — стан задаємо, а не шукаємо). */
/* ⚠️ `ucm_unread_unique_idx` — (recipient_id, entity_type, entity_id, field_scope)
   серед непрочитаних, БЕЗ clinic_id: позначка того самого запису в іншому центрі
   мусить мати інший field_scope, інакше вставка впаде на унікальності (стенд). */
/* `subj` — `subject_referrer_id`: справжня емісія пише направника запису в
   КОЖНУ позначку (і адміну, і іншим), тож позначки «інших» фабрикуємо з ним —
   інакше мітла, що видаляє ще й за `subject_referrer_id`, пройшла б пробу. */
const fakeMark = (ref, clinic, etype, eid, scope = "record", subj = null) => [
  "  insert into public.user_change_markers (recipient_id, clinic_id, event_type, surface_key, entity_type, entity_id,",
  `                                          field_scope, actor_id, actor_role, severity${subj ? ", subject_referrer_id" : ""})`,
  `    values (${ref}, ${clinic}, 'falsify.probe', ${etype === "queue_entry" ? "'queue'" : etype === "waitlist_entry" ? "'waitlist'" : "'cases'"}, '${etype}', ${eid},`,
  `            '${scope}', null, 'system', 'info'${subj ? ", " + subj : ""});`,
].join("\n");
const fakeMarks3 = (ref, clinic) => [fakeMark(ref, clinic, "queue_entry", "v_q"), fakeMark(ref, clinic, "waitlist_entry", "v_w"), fakeMark(ref, clinic, "patient_case", "v_c")].join("\n");

/** Правка персоналу, що ГАРАНТОВАНО міняє пріоритет (перемикач urgent ↔ planned):
 *  «set 'urgent'» двічі поспіль нічого б не змінив і нічого б не емітував —
 *  проба мовчки стала б вакуумною. */
const FLIP_PRIORITY = [
  "  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);",
  "  update public.queue_entries",
  "     set priority_level = case when priority_level = 'urgent' then 'planned'::public.patient_priority",
  "                               else 'urgent'::public.patient_priority end",
  "   where id = v_q;",
  "  perform set_config('request.jwt.claims', '{}', true);",
].join("\n");
/** Позначки ІНШИХ отримувачів (адмін центру, другий направник) на ті самі записи:
 *  мітла мусить знімати лише позначки СТАРОЇ ПАРИ. field_scope `studies` —
 *  жодна проба склад не міняє, тож з емісією унікальність не перетнеться. */
const othersMarks = "(select count(*) from public.user_change_markers m where m.clinic_id = v_clinic and m.recipient_id in (v_admin, v_ref2) and m.event_type = 'falsify.probe' and m.field_scope = 'studies')";
const othersCheck = (ev) => [
  `  if ${othersMarks} <> v_n_others then`,
  `    v_others := coalesce(v_others || ', ', '') || ${lit(ev + ": ")} || ${othersMarks} || '/' || v_n_others;`,
  "  end if;",
].join("\n");
const BOOKING_ERRS = "array['ROOM_CLOSED', 'BEFORE_OPEN', 'TOO_LATE', 'OFF_SCHEDULE', 'PAST_SLOT', 'BREAK', 'OVERLAP', 'INCIDENT']";
const PROBES = [
  "  -- ── ФІКСТУРИ: центр з адміном (кабінет, що приймає запис), направник; другий центр,",
  "  --    другий направник, CEO — якщо є (інакше проба = n/a у звіті). Гранти ФАБРИКУЄМО",
  "  --    в транзакції (канон referrer_cases_smoke): стан задаємо, а не шукаємо.",
  "  perform set_config('request.jwt.claims', '{}', true);",
  "  select p.id into v_ref from public.profiles p where p.role = 'referrer' order by p.created_at, p.id limit 1;",
  "  if v_ref is null then",
  "    raise exception '0204-фальсифікація: у базі немає жодного направника';",
  "  end if;",
  "  select p.id into v_ref2 from public.profiles p",
  "   where p.role = 'referrer' and p.id <> v_ref order by p.created_at, p.id limit 1;",
  "  <<slot>>",
  "  for r in",
  "    select rm.id as room_id, rm.clinic_id, rm.modality::text as mod",
  "      from public.rooms rm",
  "     where rm.active and rm.modality::text in ('MRI', 'CT', 'US', 'XRAY', 'MAMMO')",
  "       and exists (select 1 from public.profiles a where a.clinic_id = rm.clinic_id and a.role = 'admin')",
  "     order by exists (select 1 from public.clinics c2 where c2.id <> rm.clinic_id) desc, rm.clinic_id, rm.id",
  "  loop",
  "    select a.id into v_admin from public.profiles a",
  "     where a.clinic_id = r.clinic_id and a.role = 'admin' order by a.created_at, a.id limit 1;",
  "    insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, r.clinic_id, 'active')",
  "      on conflict (referrer_id, clinic_id) do update set status = excluded.status, room_ids = null;",
  "    for d in 28..34 loop",
  "      foreach v_t in array array['10:00', '11:30', '13:00', '15:30'] loop",
  "        begin",
  "          insert into public.queue_entries (clinic_id, room_id, created_by, referrer_id, patient_name, doctor,",
  "              studies, duration_min, buffer_time_min, scheduled_date, scheduled_time, status, call_status)",
  "            values (r.clinic_id, r.room_id, v_ref, v_ref, 'FALSIFY 0204 Q', 'FALSIFY 0204',",
  "              jsonb_build_array(jsonb_build_object('type', r.mod)), 30, 5, current_date + d, v_t,",
  "              'scheduled', 'not_called')",
  "            returning id into v_q;",
  "          v_clinic := r.clinic_id; v_room := r.room_id; v_mod := r.mod;",
  "          exit slot;",
  "        exception when others then",
  "          get stacked diagnostics v_msg = message_text;",
  `          if sqlstate not in ('23514', '23P01') or split_part(v_msg, ':', 1) <> all (${BOOKING_ERRS}) then`,
  "            raise exception '0204-фальсифікація: пошук слота — чужа помилка % %', sqlstate, v_msg;",
  "          end if;",
  "        end;",
  "      end loop;",
  "    end loop;",
  "  end loop;",
  "  if v_q is null then",
  "    raise exception '0204-фальсифікація: не знайшли слота, що проходить живі тригери';",
  "  end if;",
  "  insert into public.waitlist_entries (clinic_id, patient_name, modality, status, referrer_id, created_by)",
  "    values (v_clinic, 'FALSIFY 0204 W', v_mod::public.modality, 'waiting', v_ref, v_ref) returning id into v_w;",
  "  insert into public.patient_cases (clinic_id, referrer_id, created_by, patient_name)",
  "    values (v_clinic, v_ref, v_ref, 'FALSIFY 0204 C') returning id into v_c;",
  "  if (select referrer_id from public.queue_entries where id = v_q) is distinct from v_ref",
  "     or (select created_by from public.waitlist_entries where id = v_w) is distinct from v_ref",
  "     or (select referrer_id from public.patient_cases where id = v_c) is distinct from v_ref then",
  "    raise exception '0204-фальсифікація: ключі синтетичних рядків не лягли (гард 0203?)';",
  "  end if;",
  "  select c.id into v_clinic2 from public.clinics c",
  "   where c.id <> v_clinic",
  "     and not exists (select 1 from public.referral_access ra where ra.referrer_id = v_ref and ra.clinic_id = c.id)",
  "   order by c.created_at, c.id limit 1;",
  "  select p.id into v_ceo from public.profiles p where p.role = 'ceo' order by p.created_at, p.id limit 1;",
  "",
  "  -- ── R: читання за ключем — лише з АКТИВНИМ грантом до центру запису ──",
  readProbe("R-granted", "v_ref", "1/1/1"),
  readProbe("R-staff", "v_admin", "1/1/1"),
  "  if v_ceo is not null then",
  "    insert into public.ceo_access (ceo_id, clinic_id, status) values (v_ceo, v_clinic, 'active')",
  "      on conflict (ceo_id, clinic_id) do update set status = excluded.status;",
  "  end if;",
  readProbe("R-ceo", "v_ceo", "1/1/0", "v_ceo"),
  "",
  "  -- ── E/P: позначки. Правка персоналу з активним грантом → направнику позначка ──",
  "  delete from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic;",
  FLIP_PRIORITY,
  stateProbe("E-granted", `${entryMarks("v_ref", "v_clinic")} = 1`, `'позначок записів ' || ${entryMarks("v_ref", "v_clinic")}`),
  "  -- позначка в ІНШОМУ центрі (грант туди активний) — мітла центру А її не чіпає",
  "  if v_clinic2 is not null then",
  "    insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic2, 'active')",
  "      on conflict (referrer_id, clinic_id) do update set status = excluded.status;",
  indent(fakeMark("v_ref", "v_clinic2", "queue_entry", "v_q", "status")),
  "  end if;",
  "  v_n_access := " + accessMarks("v_ref", "v_clinic") + ";",
  "  -- позначки ІНШИХ отримувачів на ті самі записи — мітла їх не чіпає (P-others-kept);",
  "  -- subject_referrer_id = направник проби, як у справжньої емісії (мітла за ним — червоне)",
  fakeMark("v_admin", "v_clinic", "queue_entry", "v_q", "studies", "v_ref"),
  fakeMark("v_admin", "v_clinic", "waitlist_entry", "v_w", "studies", "v_ref"),
  fakeMark("v_admin", "v_clinic", "patient_case", "v_c", "studies", "v_ref"),
  "  if v_ref2 is not null then",
  indent(fakeMark("v_ref2", "v_clinic", "queue_entry", "v_q", "studies", "v_ref")),
  indent(fakeMark("v_ref2", "v_clinic", "waitlist_entry", "v_w", "studies", "v_ref")),
  indent(fakeMark("v_ref2", "v_clinic", "patient_case", "v_c", "studies", "v_ref")),
  "  end if;",
  `  v_n_others := ${othersMarks};`,
  "  -- ПРОЧИТАНА позначка направника — мітла знімає і її (гігієна; №14 рахує лише непрочитані)",
  "  insert into public.user_change_markers (recipient_id, clinic_id, event_type, surface_key, entity_type, entity_id,",
  "                                          field_scope, actor_id, actor_role, severity, seen_at)",
  "    values (v_ref, v_clinic, 'falsify.probe', 'waitlist', 'waitlist_entry', v_w,",
  "            'status', null, 'system', 'info', now());",
  "",
  "  -- відкликання: UPDATE active → revoked",
  setGrant("v_ref", "v_clinic", "revoked"),
  othersCheck("revoke"),
  readProbe("R-revoked", "v_ref", "0/0/0"),
  stateProbe("P-revoke-update", `${entryMarks("v_ref", "v_clinic")} = 0`, `'позначок записів після відкликання ' || ${entryMarks("v_ref", "v_clinic")} || ' (прочитаних ' || (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.seen_at is not null) || ')'`),
  stateProbe("P-access-kept", `${accessMarks("v_ref", "v_clinic")} > v_n_access`, `'позначок доступу ' || ${accessMarks("v_ref", "v_clinic")} || ' (було ' || v_n_access || ')'`),
  stateProbe("P-other-clinic-kept", `${entryMarks("v_ref", "v_clinic2")} = 1`, `'позначок записів в іншому центрі ' || ${entryMarks("v_ref", "v_clinic2")}`, "v_clinic2"),
  "  -- емісія після відкликання: направнику позначки НЕ йде",
  FLIP_PRIORITY,
  stateProbe("E-revoked", `${entryMarks("v_ref", "v_clinic")} = 0`, `'позначок записів ' || ${entryMarks("v_ref", "v_clinic")}`),
  "  -- інші неактивні статуси — теж без читання і без позначок (мутація матриці",
  "  -- `status = 'active'` → `<> 'revoked'` пропускала б саме їх)",
  ...["pending_referrer", "pending_clinic", "declined"].flatMap((s) => [
    setGrant("v_ref", "v_clinic", s),
    readProbe(`R-${s}`, "v_ref", "0/0/0"),
    FLIP_PRIORITY,
    stateProbe(`E-${s}`, `${entryMarks("v_ref", "v_clinic")} = 0`, `'позначок записів ' || ${entryMarks("v_ref", "v_clinic")}`),
  ]),
  "  -- UPDATE НЕактивного гранту — мітла нічого не чіпає (фабрикована позначка лишається)",
  fakeMarks3("v_ref", "v_clinic"),
  setGrant("v_ref", "v_clinic", "revoked"),
  stateProbe("P-inactive-update", `${entryMarks("v_ref", "v_clinic")} = 3`, `'позначок записів ' || ${entryMarks("v_ref", "v_clinic")}`),
  "  delete from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.event_type = 'falsify.probe';",
  "  -- грант лише до ІНШОГО центру — рядків центру А не бачить",
  readProbe("R-other-clinic-only", "v_ref", "0/0/0", "v_clinic2"),
  "  -- повторний грант — знову бачить; емісія знову йде",
  setGrant("v_ref", "v_clinic", "active"),
  readProbe("R-regrant", "v_ref", "1/1/1"),
  FLIP_PRIORITY,
  stateProbe("E-regrant", `${entryMarks("v_ref", "v_clinic")} = 1`, `'позначок записів ' || ${entryMarks("v_ref", "v_clinic")}`),
  "  -- UPDATE активного гранту без зміни пари (кабінети) — мітла нічого не чіпає",
  "  update public.referral_access set room_ids = array[v_room] where referrer_id = v_ref and clinic_id = v_clinic;",
  stateProbe("P-same-pair", `${entryMarks("v_ref", "v_clinic")} = 1`, `'позначок записів ' || ${entryMarks("v_ref", "v_clinic")}`),
  "  update public.referral_access set room_ids = null where referrer_id = v_ref and clinic_id = v_clinic;",
  "  -- DELETE активного гранту — мітла",
  "  delete from public.referral_access where referrer_id = v_ref and clinic_id = v_clinic;",
  othersCheck("delete"),
  stateProbe("P-delete", `${entryMarks("v_ref", "v_clinic")} = 0`, `'позначок записів після DELETE ' || ${entryMarks("v_ref", "v_clinic")}`),
  "  -- UPDATE активного гранту, що міняє центр (стара пара) — мітла по старій парі",
  setGrant("v_ref", "v_clinic", "active"),
  fakeMarks3("v_ref", "v_clinic"),
  "  if v_clinic2 is not null then",
  "    delete from public.referral_access where referrer_id = v_ref and clinic_id = v_clinic2;",
  "    update public.referral_access set clinic_id = v_clinic2 where referrer_id = v_ref and clinic_id = v_clinic;",
  indent(othersCheck("move")),
  "  end if;",
  stateProbe("P-move-pair", `${entryMarks("v_ref", "v_clinic")} = 0`, `'позначок записів старого центру ' || ${entryMarks("v_ref", "v_clinic")}`, "v_clinic2"),
  "  if v_clinic2 is not null then",
  "    update public.referral_access set clinic_id = v_clinic where referrer_id = v_ref and clinic_id = v_clinic2;",
  "  end if;",
  "  delete from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.event_type = 'falsify.probe';",
  "  -- позначки ІНШИХ отримувачів пережили всі три спрацювання мітли (відкликання, DELETE, зміна пари)",
  stateProbe("P-others-kept", "v_others is null and v_n_others >= 3", "'змінились після ' || coalesce(v_others, '(нічого)') || '; заведено ' || v_n_others"),
  "  delete from public.user_change_markers m",
  "   where m.clinic_id = v_clinic and m.recipient_id in (v_admin, v_ref2) and m.event_type = 'falsify.probe';",
  "  -- другий направник: pending ніколи не був активним → не читає",
  "  if v_ref2 is not null then",
  "    insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref2, v_clinic, 'active')",
  "      on conflict (referrer_id, clinic_id) do update set status = excluded.status;",
  "    update public.waitlist_entries set referrer_id = v_ref2 where id = v_w;",
  "    update public.referral_access set status = 'pending_referrer' where referrer_id = v_ref2 and clinic_id = v_clinic;",
  "  end if;",
  readProbe("R-colleague-pending", "v_ref2", "0/0/0", "v_ref2"),
  "  if v_ref2 is not null then",
  "    update public.waitlist_entries set referrer_id = v_ref where id = v_w;",
  "  end if;",
  "  perform set_config('request.jwt.claims', '{}', true);",
].join("\n");
const N_PROBES = PROBE_LABELS.length;
const N_OPT = [...PROBES.matchAll(/v_na := v_na \|\| '([^']+)'::text;/g)].length;

/* ── Мутації. M14 — мітла вихолощена (та сама шапка, ACL зберігається) і
   відкликання → №14 МУСИТЬ назвати рівно три `unreachable:<тип>:1`; M19 — тіло
   change_marker_recipients 0184 → №19 рівно `body:` з дайджестом 0184 (+ проба
   чутливості: зі старим тілом відкликаному направнику позначка знову йде);
   M16 — три політики у формі 0203 → №16 рівно три `changed:`; M17a — мітлу
   вимкнено + пізній BEFORE-тригер `zzz_…` → `trigger_off:` + `order:`; M17b —
   мітлу знято → `missing:` + `order:`. ── */
const LATE_TG = "zzz_falsify_0204_late";
const PRUNE_HOLLOW = [
  `create or replace function public.${PRUNE}()`,
  "returns trigger",
  "language plpgsql",
  "security definer",
  "set search_path = public, pg_temp",
  `as ${PRUNE_TAG}`,
  "begin",
  "  -- falsify 0204 M14: вихолощена мітла",
  "  return null;",
  "end;",
  `${PRUNE_TAG}`,
].join("\n");
const WANT14 = ENTRY_TYPES.map((t) => `unreachable:${t}:1`).sort(cmpC);
const WANT19 = [`body:${CMR_SIG}->${CMR_PRE_REC19}`];
const WANT16 = WANT16_BEFORE;
const WANT17A = [`order:queue_entries->${LATE_TG}`, `trigger_off:referral_access.${PRUNE_TG}=D`].sort(cmpC);
const WANT17B = [`missing:referral_access.${PRUNE_TG}`, `order:queue_entries->${LATE_TG}`].sort(cmpC);
for (const w of [...WANT14, ...WANT19, ...WANT16, ...WANT17A, ...WANT17B]) if (/'/.test(w)) throw new Error(`WANT: лапка в ${w}`);

const offOf = (q, into) => [
  "  v_tmp := null;",
  q,
  `  select array_agg(o order by o collate "C") into ${into} from unnest(v_tmp) o;`,
].join("\n");

const FALSIFY = [
  "-- 0204 FALSIFY — ЗГЕНЕРОВАНО `node scripts/build-0204-reprint.mjs`.",
  "-- Політики, мітла і піни мусять ЛОВИТИ, а не лише лягти. Транзакція СВІДОМО",
  "-- валиться в кінці. Предстан перевіряти ОКРЕМИМ запитом.",
  "-- ⚠️ ПЕРЕДУМОВА: 0204 у леджері, тіло/пін 0204, функції = текст генератора,",
  "--    №16 і №17 зелені (зокрема order:).",
  "-- ПОРЯДОК (Low-1 ревʼю 0203): ПОВНИЙ сторож — ДО проб і мутацій (база для",
  "--    base_other_failed, ≈9 с без замків на таблиці); під мутаціями — лише",
  "--    дослівні запити №14, №16, №17 і №19 (мілісекунди).",
  `-- ПРОБИ (${N_PROBES}, з них ${N_OPT} необовʼязкові) — під імперсонацією (request.jwt.claims +`,
  "--    `set local role authenticated`) на СИНТЕТИЧНИХ рядках черги, листа і кейсів",
  "--    центру з адміном; гранти фабрикуються в транзакції. Читання — «q/w/c»:",
  "--   R-granted 1/1/1 (направник із активним грантом читає свої рядки);",
  "--   R-staff 1/1/1 (адмін центру); R-ceo 1/1/0 (CEO центру: черга й лист, кейсів — ні);",
  "--   R-revoked, R-pending_referrer, R-pending_clinic, R-declined — 0/0/0;",
  "--   R-other-clinic-only 0/0/0 (грант лише до ІНШОГО центру); R-regrant 1/1/1;",
  "--   R-colleague-pending 0/0/0 (другий направник, грант pending);",
  "--   E-granted / E-regrant: правка персоналу → направнику РІВНО одна позначка;",
  "--   E-revoked, E-pending_referrer, E-pending_clinic, E-declined: жодної;",
  "--   P-revoke-update / P-delete / P-move-pair: мітла знімає позначки ЗАПИСІВ старої",
  "--     пари (P-revoke-update — і ПРОЧИТАНУ); P-access-kept: позначка про",
  "--     відкликання лишається (і додалась); P-others-kept: позначки ІНШИХ",
  "--     отримувачів (адмін, другий направник) на ті самі записи пережили всі три",
  "--     спрацювання; P-other-clinic-kept: позначка в ІНШОМУ центрі лишається;",
  "--   P-inactive-update, P-same-pair: UPDATE неактивного гранту / без зміни пари —",
  "--     мітла не чіпає.",
  "--   Необовʼязкові (немає CEO / другого направника / іншого центру) → n/a у звіті;",
  "--   вердикт вимагає ok + n/a = усі проби і жодного промаху.",
  "-- МУТАЦІЇ:",
  `--   M14 мітла вихолощена + відкликання → №14 рівно ${WANT14.join(", ")};`,
  "--   M14b після вихолощення позначки лишились (проби не вакуумні);",
  `--   M19 ${CMR} — тіло 0184 → №19 рівно body: з дайджестом ${CMR_PRE_REC19};`,
  "--   M19b зі старим тілом відкликаному направнику позначка знову йде (чутливість);",
  "--   M16 три політики у формі 0203 → №16 рівно три changed:;",
  `--   M17a мітлу вимкнено + пізній BEFORE-тригер ${LATE_TG} на queue_entries →`,
  "--        №17 рівно trigger_off: і order:;",
  "--   M17b мітлу знято → №17 рівно missing: і order:.",
  "-- ⚠️ БЛОКУВАННЯ — мілісекунди в кінці: queue_entries, waitlist_entries,",
  "--    patient_cases — ACCESS EXCLUSIVE (alter policy), referral_access — ACCESS",
  "--    EXCLUSIVE (drop trigger), queue_entries — SHARE ROW EXCLUSIVE (create trigger).",
  `-- ⚠️ base_other_failed СТРОГИЙ: у базовому прогоні поза ${KNOWN_RED.join(", ")} і ledger_md5`,
  "--    (до db:gate) червоним не сміє бути НІЩО. Інша червона — FAIL не від пакета.",
  "set statement_timeout = '5min';",
  "do $falsify$",
  "declare",
  "  v_def text; v_body text; v_src text; v_head text; v_bad text[]; v_tmp text[]; v_atg text; v_acl text;",
  "  v_res jsonb; v_base_other text[]; v_off14 text[]; v_off16 text[]; v_off17a text[]; v_off17b text[]; v_off19 text[];",
  "  v_ok text[] := '{}'; v_miss text[] := '{}'; v_na text[] := '{}'; v_msg text; v_seen text; v_t text;",
  "  v_clinic uuid; v_clinic2 uuid; v_admin uuid; v_ref uuid; v_ref2 uuid; v_ceo uuid; v_room uuid; v_mod text;",
  "  v_q uuid; v_w uuid; v_c uuid; v_n_access bigint; v_b14 boolean := false; v_b19 boolean := false;",
  "  v_n_others bigint; v_others text;",
  "  r record;",
  `  v_want14 constant text[] := ${sqlArr(WANT14)};`,
  `  v_want16 constant text[] := ${sqlArr(WANT16)};`,
  `  v_want17a constant text[] := ${sqlArr(WANT17A)};`,
  `  v_want17b constant text[] := ${sqlArr(WANT17B)};`,
  `  v_want19 constant text[] := ${sqlArr(WANT19)};`,
  "begin",
  PRE("0204-фальсифікація"),
  `  if not exists (select 1 from public.migration_ledger where name = '${DST_NAME}') then`,
  "    raise exception '0204-фальсифікація: 0204 не накатано — фальсифікувати нічого';",
  "  end if;",
  readGuard("0204-фальсифікація", NEW_MD5, NEW_LEN, PIN, "0204"),
  cmrRow19("0204-фальсифікація", CMR_NEW_REC19, "(передумова)"),
  fnAttrsAssert("0204-фальсифікація", `public.${PRUNE_SIG}`, `${PRUNE_SIG} (передумова)`, PRUNE_ATTRS_OPTS),
  Q_ASSERT("0204-фальсифікація", "№16", Q16_NEW, "(передумова)"),
  Q_ASSERT("0204-фальсифікація", "№17", Q17_NEW, "(передумова)"),
  Q_ASSERT("0204-фальсифікація", "№14", Q14_NEW, "(передумова)"),
  "",
  "  -- ── БАЗА: ПОВНИЙ сторож ДО проб і мутацій (≈9 с, замків на таблиці немає) ──",
  SENTINEL_CALL,
  `  if (v_res->>'checked')::int <> ${CHECKED} then`,
  `    raise exception '0204-фальсифікація: сторож перевірив % замість ${CHECKED}', v_res->>'checked';`,
  "  end if;",
  "  select array_agg(e.value->>'check' order by e.value->>'check') into v_base_other",
  "    from jsonb_array_elements(v_res->'failed') e",
  `   where e.value->>'check' not in (${[...KNOWN_RED, "ledger_md5"].map(lit).join(", ")});`,
  "",
  PROBES,
  "",
  "  -- ── M14: мітла вихолощена; три фабриковані позначки записів; відкликання ──",
  "  perform set_config('request.jwt.claims', '{}', true);",
  "  delete from public.user_change_markers m",
  "   where m.recipient_id = v_ref and m.clinic_id = v_clinic",
  "     and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case');",
  setGrant("v_ref", "v_clinic", "active"),
  fakeMarks3("v_ref", "v_clinic"),
  fnExec("$fxc$", PRUNE_HOLLOW),
  setGrant("v_ref", "v_clinic", "revoked"),
  `  v_b14 := ${entryMarks("v_ref", "v_clinic")} = 3;`,
  offOf(Q14_NEW, "v_off14"),
  "",
  `  -- ── M19: ${CMR} — тіло 0184 (без умови гранту) ──`,
  fnExec("$fxc$", CMR_PRE_STMT),
  "  -- чутливість: зі старим тілом відкликаному направнику позначка знову йде",
  "  delete from public.user_change_markers m",
  "   where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.event_type = 'falsify.probe';",
  FLIP_PRIORITY,
  `  v_b19 := ${entryMarks("v_ref", "v_clinic")} >= 1;`,
  Q19_NEW.replace(/\n$/, ""),
  "  select array_agg(o order by o collate \"C\") into v_off19 from unnest(v_tmp) o;",
  "",
  "  -- ── M17a: мітлу вимкнено + пізній BEFORE-тригер (замки — від цієї миті) ──",
  "  alter table public.referral_access disable trigger " + PRUNE_TG + ";",
  `  create trigger ${LATE_TG} before update on public.queue_entries`,
  "    for each row execute function public.touch_updated_at();",
  offOf(Q17_NEW, "v_off17a"),
  "  -- ── M17b: мітлу знято ──",
  `  drop trigger ${PRUNE_TG} on public.referral_access;`,
  offOf(Q17_NEW, "v_off17b"),
  "",
  "  -- ── M16: три політики у формі 0203 ──",
  indent(OLD_POLICY_DDL),
  offOf(Q16_NEW, "v_off16"),
  "",
  "  raise exception 'FALSIFY_0204_ROLLBACK verdict=% probes_ok=%/% probes_missed=% na=% off14=% b14_kept=% off19=% b19_emits=% off16=% off17a=% off17b=% base_other_failed=%',",
  `    case when cardinality(v_miss) = 0 and cardinality(v_ok) + cardinality(v_na) = ${N_PROBES}`,
  "              and v_off14 is not distinct from v_want14 and v_b14",
  "              and v_off19 is not distinct from v_want19 and v_b19",
  "              and v_off16 is not distinct from v_want16",
  "              and v_off17a is not distinct from v_want17a and v_off17b is not distinct from v_want17b",
  "              and v_base_other is null then 'PASS' else 'FAIL' end,",
  `    cardinality(v_ok), ${N_PROBES}, v_miss, v_na, v_off14, v_b14, v_off19, v_b19, v_off16, v_off17a, v_off17b, v_base_other;`,
  "end;",
  "$falsify$;",
  "",
  "-- ⚠️ ПІСЛЯ — окремим запитом, що прод не змінився:",
  "--      select public.invariants_check(false);   -- policy_digest, guard_triggers, ucm_orphan_markers, guard_fn_bodies ВІДСУТНІ",
  "--      select count(*) from pg_proc where prosrc like '%falsify 0204%';   -- 0",
  "--      select count(*) from pg_trigger where tgname = '" + LATE_TG + "';   -- 0",
  `--      ${READBACK.split("\n")[0]} …   -- (повне читання назад — у 0204_apply.sql)`,
].join("\n");

// ---------------------------------------------------------------------------
// 9. ФАЙЛ МІГРАЦІЇ (канонічний, ІДЕМПОТЕНТНИЙ).
//    ⚠️ Шапка НЕ сміє містити фразу create-or-replace сторожа одним рядком:
//       `tests/privilegeSurface.test.ts` шукає її `indexOf` БЕЗ якоря.
// ---------------------------------------------------------------------------
const MIG_PRE = [
  "do $pre$",
  "declare v_src text; v_bad text[]; v_pol text[]; v_unreach jsonb;",
  "begin",
  "  if current_user <> 'postgres' then",
  "    raise exception '0204: мусить іти від ролі postgres, а йде від %', current_user;",
  "  end if;",
  `  if not exists (select 1 from public.migration_ledger where name = '${PREV_LEDGER}') then`,
  "    raise exception '0204: у леджері немає 0203 — накат не в свою чергу';",
  "  end if;",
  "  if (select max(name) from public.migration_ledger) not in",
  `     ('${PREV_LEDGER}', '${DST_NAME}') then`,
  "    raise exception '0204: останній рядок леджера % — не 0203/0204, черга зсунулась',",
  "      (select max(name) from public.migration_ledger);",
  "  end if;",
  "  select replace(p.prosrc, chr(13), '') into v_src",
  "    from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  "   where n.nspname = 'public' and p.proname = 'invariants_check'",
  "     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';",
  `  if md5(v_src) not in ('${PRE_MD5}', '${NEW_MD5}') then`,
  "    raise exception '0204: тіло сторожа % — ні 0203, ні 0204; правка наосліп заборонена', md5(v_src);",
  "  end if;",
  `  if (select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = to_regprocedure('${CMR_REGPROC}'))`,
  `     not in ('${CMR_PRE_RAW}', '${CMR_NEW_RAW}') then`,
  `    raise exception '0204: ${CMR} — ні тіло 0184, ні 0204; правка наосліп заборонена';`,
  "  end if;",
  "  -- ⚠️ `to_regprocedure`, а не `::regprocedure`: приведення константи падає ще на",
  "  --    плануванні, коли функції немає (урок локального стенда 0203).",
  `  if to_regprocedure('public.${PRUNE_SIG}') is not null`,
  `     and (select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = to_regprocedure('public.${PRUNE_SIG}'))`,
  `         is distinct from '${PRUNE_RAW}' then`,
  `    raise exception '0204: ${PRUNE_SIG} уже є з ІНШИМ тілом — чиясь чернетка? спершу розібратись';`,
  "  end if;",
  POL_DIG_SQL_MIG,
  `  if v_pol is distinct from ${polArr("old")} and v_pol is distinct from ${polArr("new")} then`,
  "    raise exception '0204: політики читання — ні форма 0203, ні 0204: % — правка наосліп заборонена', v_pol;",
  "  end if;",
  UNREACH_SQL_MIG("v_unreach"),
  "  if v_unreach <> '{}'::jsonb then",
  "    raise exception '0204: уже є недосяжні НЕПРОЧИТАНІ позначки записів % — до накату ручна зачистка за явним списком id', v_unreach;",
  "  end if;",
  "end",
  "$pre$;",
].join("\n");

const MIG_CHK = [
  "do $chk$",
  "declare v_res jsonb; v_failed text[]; v_off16 text[]; v_off17 text[];",
  "begin",
  SENTINEL_CALL,
  `  if (v_res->>'checked')::int <> ${CHECKED} then`,
  `    raise exception '0204: сторож перевірив % замість ${CHECKED}', v_res->>'checked';`,
  "  end if;",
  "  -- ідемпотентно: ledger_md5 допустима лише з offender-ом самої 0204 (повторний прогін до db:gate)",
  "  select array_agg(e.value->>'check' order by e.value->>'check') into v_failed",
  "    from jsonb_array_elements(v_res->'failed') e",
  `   where e.value->>'check' not in ${KNOWN_RED_SQL}`,
  "     and not (e.value->>'check' = 'ledger_md5'",
  `              and e.value->'offenders' = jsonb_build_array('${DST_NAME}'));`,
  "  if v_failed is not null then",
  "    raise exception '0204: до DDL сторож червоний не від пакета: % — %', v_failed, v_res->'failed';",
  "  end if;",
  "  select array_agg(o.value order by o.value collate \"C\") into v_off16",
  "    from jsonb_array_elements(v_res->'failed') e,",
  "         jsonb_array_elements_text(e.value->'offenders') o",
  "   where e.value->>'check' = 'policy_digest';",
  `  if v_off16 is not null and v_off16 is distinct from ${sqlArr(WANT16_BEFORE)} then`,
  "    raise exception '0204: №16 до DDL назвав не рівно три політики читання пакета: %', v_off16;",
  "  end if;",
  "  select array_agg(o.value order by o.value collate \"C\") into v_off17",
  "    from jsonb_array_elements(v_res->'failed') e,",
  "         jsonb_array_elements_text(e.value->'offenders') o",
  "   where e.value->>'check' = 'guard_triggers';",
  `  if v_off17 is not null and v_off17 is distinct from ${sqlArr(WANT17_BEFORE)} then`,
  "    raise exception '0204: №17 до DDL назвав не рівно одну відсутню пару мітли: %', v_off17;",
  "  end if;",
  "end",
  "$chk$;",
].join("\n");

/* ⚠️ ПОСТ-АСЕРТ ФАЙЛУ — БЕЗ КОПІЙ ТЕКСТУ ТІЛА СТОРОЖА (стенди мутують ФАЙЛ
   останнього передруку і вимагають, щоб кожен якір траплявся в ньому РІВНО
   раз). №16 і №17 після DDL — запити САМОГО сторожа, вирізані з ЖИВОГО тіла
   за тими ж межами, що в генераторі, звірені md5 і виконані як є. */
const sqlJoinLines = (s) => s.split("\n").map((x) => lit(x)).join(" || chr(10) || ").replace(/^'' \|\| /, "");
const dynOf = (Q, selInto, sel, lbl) => {
  if (count(Q, selInto) !== 1) throw new Error(`запит ${lbl}: \`into v_tmp\` не рівно один`);
  const d = Q.replace(/;$/, "").replace(selInto, sel);
  if (d === Q || /\binto\b/.test(d)) throw new Error(`запит ${lbl} для execute: \`into\` лишився`);
  return d;
};
const Q17_SEL_INTO = "select array_agg(x.txt order by x.txt) into v_tmp";
const Q17_SEL = "select array_agg(x.txt order by x.txt)";
const Q17_DYN_MD5 = md5(dynOf(Q17_NEW, Q17_SEL_INTO, Q17_SEL, "№17"));
const Q16_SEL_INTO = "select array_agg(x.what order by x.what) into v_tmp";
const Q16_SEL = "select array_agg(x.what order by x.what)";
const Q16_DYN_MD5 = md5(dynOf(Q16_NEW, Q16_SEL_INTO, Q16_SEL, "№16"));
/* Початок — без хвоста рядка: повний рядок-межа унікальний у тілі, і його
   копія в літералі стала б другим входженням (сітка унікальних рядків нижче). */
const Q17_START_SQL = Q17_START.slice(0, -" is null".length);
const Q16_START_SQL = Q16_START.slice(0, -" p.policyname as pol,".length);
for (const [lbl, full, cut] of [["№17", Q17_START, Q17_START_SQL], ["№16", Q16_START, Q16_START_SQL]]) {
  if (count(NEW_BODY, cut) !== 1 || NEW_BODY.indexOf(cut) !== NEW_BODY.indexOf(full)) {
    throw new Error(`межа початку запиту ${lbl} для SQL не унікальна або зсунута`);
  }
}
const liveCut = (lbl, startSql, endMark, tailLine, selInto, sel, dynMd5) => [
  `  v_a := strpos(v_src, ${sqlJoinLines(startSql)});`,
  `  v_b := strpos(v_src, ${sqlJoinLines(endMark)});`,
  "  if v_a = 0 or v_b <= v_a then",
  `    raise exception '0204: межі запиту ${lbl} у живому тілі не знайдено (% / %)', v_a, v_b;`,
  "  end if;",
  `  v_q := replace(substr(v_src, v_a, v_b - v_a) || chr(10) || ${lit(tailLine)},`,
  `                 ${lit(selInto)}, ${lit(sel)});`,
  `  if md5(v_q) is distinct from '${dynMd5}' then`,
  `    raise exception '0204: вирізаний запит ${lbl} не той (md5 %) — межі зсунулись', md5(v_q);`,
  "  end if;",
  "  execute v_q into v_tmp;",
  "  if v_tmp is not null then",
  `    raise exception '0204: ${lbl} після DDL червоний: %', v_tmp;`,
  "  end if;",
].join("\n");
const MIG_POST = [
  "do $post$",
  "declare v_tmp text[]; v_bad text[]; v_acl text; v_src text; v_a int; v_b int; v_q text;",
  "begin",
  "  perform set_config('search_path', 'public, pg_temp', true);",
  "  select replace(p.prosrc, chr(13), '') into v_src",
  "    from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  "   where n.nspname = 'public' and p.proname = 'invariants_check'",
  "     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';",
  `  if md5(v_src) is distinct from '${NEW_MD5}' or length(v_src) <> ${NEW_LEN}`,
  "     or obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc')",
  "        is distinct from 'guard_body_md5=' || md5(v_src) || ';len=' || length(v_src) then",
  "    raise exception '0204: тіло сторожа або самопін не ті: % / %', md5(v_src), length(v_src);",
  "  end if;",
  "  -- ── №16 і №17 після DDL: запити САМОГО сторожа, вирізані з ЖИВОГО тіла і",
  "  --    виконані як є. Копії тексту тут немає свідомо: стенди мутують файл",
  "  --    останнього передруку і вимагають унікальності якорів ──",
  liveCut("№16", Q16_START_SQL, Q16_END, "  ) x", Q16_SEL_INTO, Q16_SEL, Q16_DYN_MD5),
  liveCut("№17", Q17_START_SQL, Q17_END, "    ) x", Q17_SEL_INTO, Q17_SEL, Q17_DYN_MD5),
  "  -- ── Функції після заміни/створення: атрибути, сирий md5, ACL ──",
  fnAttrsAssert("0204", CMR_REGPROC, `${CMR} після заміни`, CMR_ATTRS_OPTS(CMR_NEW_RAW)),
  fnAclAssert("0204", CMR_REGPROC),
  fnAttrsAssert("0204", `public.${PRUNE_SIG}`, `${PRUNE_SIG} після створення`, PRUNE_ATTRS_OPTS),
  fnAclAssert("0204", `public.${PRUNE_SIG}`),
  "  if not exists (select 1 from pg_trigger t",
  `                  where t.tgrelid = 'public.referral_access'::regclass and t.tgname = '${PRUNE_TG}'`,
  "                    and t.tgenabled = 'O') then",
  `    raise exception '0204: тригер ${PRUNE_TG} не стоїть або вимкнений';`,
  "  end if;",
  "end",
  "$post$;",
].join("\n");

const MIG_HEAD = [
  "-- ============================================================================",
  "--  RadFlow — Міграція 0204: відкликання гранту забирає читання (Н-14) і порядок",
  "--  гарда ключів читання під нічним сторожем (Н-17); передрук сторожа.",
  "--",
  "--  Максимальна ЗАСТОСОВАНА на момент написання — 0203.",
  `--  \`checked\` ${CHECKED} -> ${CHECKED}. №14 +гілка \`unreachable:\`; №16 — три дайджести; №17: 30 -> 31`,
  "--  (+ мітла) і гілка `order:`; №19 — рядок `change_marker_recipients` (склад 60).",
  "--  №22 / №23 / №26 — без змін (генератор доводить: код тіла без коментарів",
  "--  відрізняється від 0203 рівно заявленими рядками). Даних не змінює (мітла",
  "--  спрацьовує лише на МАЙБУТНІХ відкликаннях).",
  "--",
  "--  ЗВІДКИ ПАКЕТ — рішення власника 25.09.2026 (с80):",
  "--   • Н-14 «відкликання гранту забирає читання». `queue_select`,",
  "--     `waitlist_select`, `cases_select_referrer` пускали за `created_by` /",
  "--     `referrer_id` без гранту і центру: грант, відкликаний ПІСЛЯ призначення,",
  "--     читання не забирав (0203 закрила лише появу нових незаконних ключів;",
  "--     замір 25.09 — дві записи черги з направником без активного гранту).",
  "--   • Н-17: порядок «гард — останній BEFORE-тригер рядка» тримали лише асерт",
  "--     накату 0203 і CI-тест; тригер, створений поза міграціями, не бачив ніхто.",
  "--",
  "--  ЩО ЗМІНЮЄТЬСЯ:",
  "--   1. Три політики читання: гілка ключа + `clinic_id in (select",
  "--      auth_referrer_clinics())`. Решта політик — ні (`queue_write_referrer` і",
  "--      `waitlist_write_referrer` грант уже вимагали).",
  "--   2. `change_marker_recipients`: для `entry` — лише з АКТИВНИМ грантом",
  "--      направника до центру (позначка про запис, якого не бачиш, не гаситься",
  "--      нічим); для `access` — як було (повідомлення про відкликання мусить дійти).",
  "--   3. Мітла `tg_ref_entry_markers_prune_on_access()` / тригер",
  "--      `trg_zzz_ref_entry_markers_prune` (AFTER DELETE OR UPDATE на",
  "--      `referral_access`): грант перестав бути активним — позначки ЗАПИСІВ",
  "--      цього направника в цьому центрі видаляються (стара пара); позначки",
  "--      `centers` / `referral_access` лишаються.",
  "--   4. №14 `unreachable:<тип>:<к-сть>` — пін ВЛАСТИВОСТІ; №17 `order:` — пін",
  "--      ПОРЯДКУ гарда (предикат — асерт накату 0203).",
  "--",
  "--  ⚠️ ЦІНА І НАСЛІДКИ, названі заздалегідь:",
  "--     • направник після відкликання (чи pending/declined) НЕ бачить своїх",
  "--       записів того центру — рішення власника; повторний грант повертає;",
  "--     • радіолог більше не бачить записів, створених ним поза своїми",
  "--       кабінетами; персонал, що змінив центр, — створених ним записів старого",
  "--       центру (обидва читали їх лише за `created_by`). Радіус — замір сухого",
  "--       прогону (`radius_*`); read-only агрегат проду 25.09 (с80): 2/0/0 рядків",
  "--       q/w/c, один профіль — направник із грантом `pending_referrer`, обидва",
  "--       записи в минулому (майбутніх 0); персоналу й радіологів — 0;",
  "--     • позначки, які мітла видалила, відкат не повертає;",
  "--     • тіло `change_marker_recipients` пінить №19 (рядок передруковано); тіло",
  "--       мітли №19 НЕ пінить (як і мітли графіка 0184) — її ловить №14.",
  "--",
  "--  ⚠️ МЕЖІ, НАЗВАНІ І ПОКАЗАНІ:",
  "--     • гонка «емісія позначки ‖ відкликання гранту» може лишити НОВИЙ рядок",
  "--       позначки за БУДЬ-ЯКОГО порядку commit (емісія закомічена після DELETE",
  "--       мітли — або UPSERT емітера, що чекав на commit відкликання, вставляє",
  "--       новий рядок) — червоне №14 `unreachable:` ловить обидва → ручна",
  "--       зачистка за явним списком id; закрити обидва порядки — `for share` на",
  "--       рядку гранту в емітерах записів (PR-0204, §12);",
  "--     • переведення персоналу між центрами (у застосунку шляху немає) лишає",
  "--       непрочитані позначки старого центру — №14 назве; переводити разом із",
  "--       зачисткою за явним списком id (AGENTS.md). Переведеному радіологу CTE",
  "--       `rads` у `change_marker_recipients` клініку профілю не звіряє, а",
  "--       `radiologist_rooms` при переводі не чистяться — позначки старого",
  "--       центру йдуть і далі (на проді 26.09 таких рядків 0);",
  "--     • кабінети гранту (`room_ids`) — не межа читання за ключем (як і в",
  "--       гарді 0203): направник з грантом на один кабінет читає свої записи",
  "--       будь-якого кабінету центру;",
  "--     • `session_replication_role = replica` гасить тригери повз каталог —",
  "--       ні №17, ні `order:` цього не бачать (межа №17).",
  "--",
  "--  ⚠️ ⚠️ ЦЕЙ ФАЙЛ НЕ НАКАТУВАТИ — ні вставкою в SQL Editor, ні MCP",
  "--     `apply_migration`, ні `supabase db push`: він ідемпотентний і канонічний,",
  "--     а накат має СУВОРИЙ предстан і один блок. Шлях один —",
  "--     `scripts/frag/0204_apply.sql`, весь одним запитом (базою через net.http_get).",
  "--",
  "--  ПОРЯДОК:",
  "--   0. Дерево чисте; `node scripts/build-0204-reprint.mjs` → `git diff --exit-code`;",
  "--      `npx vitest run`, `npx tsc --noEmit`; ревізія стендів. Усе — ДО проду.",
  "--   1. `scripts/frag/0204_dryrun.sql` цілком (перший стейтмент — `set",
  "--      statement_timeout`, другий — `do` з тегом `dryrun`) →",
  `--      DRYRUN_0204_ROLLBACK з checked=${CHECKED}, ok16=true, ok17=true, failed_before_ddl`,
  `--      = лише ${KNOWN_RED.join(", ")}, policy_digest (три changed:) і guard_triggers (один`,
  "--      missing:). radius_* — ЗАМІР, не стоп (інше число — переглянути абзац",
  "--      ціни); недосяжні НЕПРОЧИТАНІ позначки записів — СТОП (ручна зачистка",
  "--      за явним списком id ДО накату).",
  "--   2. `scripts/frag/0204_apply.sql` — ОДРАЗУ після сухого прогону. Читання назад:",
  `--      guard_md5 = ${NEW_MD5}, guard_len = ${NEW_LEN}, ledger_rows = 204,`,
  "--      три нові дайджести, prune_fn = true, prune_trigger = 1, zz_last_tables = 3.",
  "--      Помилка = НІЧОГО не закомічено. Таймаут клієнта = не повторювати",
  "--      наосліп: спершу select читання назад.",
  "--      ⚠️ ЧЕРВОНЕ ВІКНО: з цього commit і до пушу `main` з файлом 0204 падає",
  "--      КОЖНА прод-збірка (гейт: рядок леджера без файла). Жодного Redeploy,",
  "--      нічого іншого в `main`; кроки 3–7 — одним заходом. Ліміт 03:50 UTC",
  "--      (06:50 Київ) — на ВЕСЬ відрізок «накат → db:gate».",
  `--   3. ОКРЕМИМ запитом \`select public.invariants_check(false);\` — checked ${CHECKED},`,
  `--      failed ⊆ {${KNOWN_RED.join(", ")}, ledger_md5}.`,
  "--   4. Смоук `supabase/smoke/0204_referrer_grant_read_smoke.sql` → `SMOKE_OK …`.",
  `--   5. \`scripts/frag/0204_falsify.sql\` → verdict=PASS (probes_ok+na = ${N_PROBES}). Після —`,
  "--      окремим запитом №14, №16, №17 і №19 зелені.",
  "--   6. `npm run db:gate` (ЛИШЕ з машини власника) → `invariants_check`: failed лише",
  `--      ${KNOWN_RED.join(", ")} (або порожньо).`,
  "--   7. git ОДНИМ заходом: гілка → dev → main → push → штамп деплою; вікно",
  "--      закрите, коли `npm run db:gate:check` зелений на `main` І на `dev`. Не",
  "--      закрили 6–7 у цей захід — `scripts/frag/0204_rollback.sql`, а не",
  "--      «доробимо завтра».",
  "--   8. ⚠️ ПІСЛЯ КРОКУ 6 генератор НЕ ЗАПУСКАТИ (перезаписує файл із md5 у леджері).",
  "-- ============================================================================",
  "",
  "begin;",
  "",
  "-- ── 0. Предстан (ідемпотентний: 0203 або вже 0204) ─────────────────────────",
  MIG_PRE,
  "",
  `-- ── 1. ${CMR}: гілка entry — лише з АКТИВНИМ грантом (Н-14) ─────────────`,
  CMR_NEW_STMT,
  "",
  CMR_ACL_DDL,
  "",
  "-- ── 2. Мітла позначок записів при відкликанні гранту — пастка 0122: лише службова роль",
  PRUNE_STMT,
  "",
  PRUNE_ACL_DDL,
  "",
  "-- ── 3. Передрук сторожа: №14, №16, №17, №19 і проза ─────────────────────────",
  "",
].join("\n");

const MIG_TAIL = [
  "",
  `comment on function public.invariants_check(boolean) is '${PIN}';`,
  "",
  "-- ── 4. ПОВНИЙ сторож ДО DDL на таблицях (≈9 с без замків на таблиці; урок 0196) ─",
  MIG_CHK,
  "",
  "-- ── 5. DDL на таблицях: три політики читання (Н-14) і тригер мітли ──────────",
  TABLE_DDL,
  "",
  "-- ── 6. Пост-асерти: №16 і №17 запитами з живого тіла, функції, ACL, тригер ──",
  MIG_POST,
  "",
  "insert into public.migration_ledger (name)",
  `values ('${DST_NAME}')`,
  "on conflict (name) do nothing;",
  "",
  "commit;",
  "",
  "-- ============================================================================",
  "-- === ВІДКАТ ===",
  "--",
  "--  1. База: `scripts/frag/0204_rollback.sql` — знімає тригер і функцію мітли,",
  `--     \`${CMR}\` — тіло 0184 (${CMR_PRE_RAW}), три політики — форма 0203,`,
  `--     тіло сторожа 0203 (${PRE_MD5} / ${PRE_LEN}), самопін 0203, рядок`,
  "--     леджера. Позначки, які мітла вже видалила, відкат не повертає.",
  "--     Перевіряти ОКРЕМИМ запитом після commit.",
  "--  2. Git — ОДНИМ кроком: видалити цей файл, `scripts/frag/0204_*.sql`,",
  "--     `scripts/build-0204-reprint.mjs`, `tests/referrerGrantRead0204.test.ts`,",
  "--     `supabase/smoke/0204_referrer_grant_read_smoke.sql`; повернути",
  "--     `tests/guardTriggersInvariant.test.ts` (GUARDS 31 → 30, без гілки order:),",
  "--     `supabase/smoke/rls_initplan_smoke.sql` (еталон `queue_select` форми 0203),",
  "--     крок 3 `supabase/smoke/search_roles_smoke.sql` (правило «свій ключ І",
  "--     активний грант»), фікстуру C1 `supabase/smoke/user_change_markers_smoke.sql`",
  "--     (направник з активним грантом), блок №14 `unreachable:` у",
  "--     `tests/unreadChanges.test.ts`, рядки 0204 у `docs/UNREAD_CHANGES.md` і абзаци",
  "--     0204 в `AGENTS.md` («Роли и авторизация», «Контекстные красные точки»,",
  "--     «Миграции и БД» — порядок гарда і ручний перевод сотрудника). Нового стенда",
  "--     пакет НЕ заводить — фальсифікація разова, протокол у",
  "--     `docs/audit/PR-0204-referrer-grant-read.md`.",
  "-- ============================================================================",
].join("\n");

const MIG = MIG_HEAD + "\n" + SRC.prologue + NEW_BODY + "$function$;\n" + MIG_TAIL + "\n";

{
  const heads = MIG.match(REPRINT_RE_G) || [];
  if (heads.length !== 1) throw new Error(`ФАЙЛ: заголовків передруку ${heads.length}, а треба 1`);
  const loose = MIG.indexOf("create or replace function public.invariants_check");
  const anchored = MIG.search(/^create or replace function public\.invariants_check/m);
  if (loose !== anchored) throw new Error(`ФАЙЛ: фраза create-or-replace сторожа вперше на ${loose}, а заголовок на ${anchored}`);
  const pins = [...MIG.matchAll(GUARD_PIN_RE)].map((m) => m[1]);
  if (pins.length !== 1 || pins[0] !== PIN) throw new Error(`ФАЙЛ: піни ${JSON.stringify(pins)}, а треба рівно ${PIN}`);
  if (count(MIG, OPEN) !== 1 || count(MIG, CLOSE) !== 1) throw new Error("ФАЙЛ: межі тіла не унікальні");
  for (const t of ["$apply$", "$dryrun$", "$back$", "$falsify$", "$fxa$", "$fxb$", "$fxc$", "$p$"]) {
    if (MIG.includes(t)) throw new Error(`ФАЙЛ містить тег фрагмента ${t}`);
  }
  const tail = MIG.slice(MIG.lastIndexOf("insert into public.migration_ledger (name)"));
  if (!tail.startsWith(`insert into public.migration_ledger (name)\nvalues ('${DST_NAME}')\non conflict (name) do nothing;\n\ncommit;\n`)) {
    throw new Error("ФАЙЛ: рядок леджера не останній перед commit");
  }
  if (count(MIG, "\nbegin;\n") !== 1 || count(MIG, "\ncommit;\n") !== 1) throw new Error("ФАЙЛ: begin/commit не по одному");
  if (!MIG.trimEnd().endsWith("-- ============================================================================")
      || MIG.indexOf("=== ВІДКАТ ===") < MIG.indexOf("\ncommit;\n")) throw new Error("ФАЙЛ: секція ВІДКАТ не в кінці");
  for (const fr of [APPLY, DRYRUN, ROLLBACK, FALSIFY]) {
    if (fr.includes("$p$$p$")) throw new Error("фрагмент має порожній рядок підстановки");
  }
  for (const [fr, tag] of [[APPLY, "$apply$"], [DRYRUN, "$dryrun$"], [ROLLBACK, "$back$"], [FALSIFY, "$falsify$"]]) {
    const stmts = fr.split("\n").filter((l) => l.trim() && !l.startsWith("--"));
    if (stmts[0] !== "set statement_timeout = '5min';" || stmts[1] !== `do ${tag}`) {
      throw new Error(`фрагмент ${tag}: перші стейтменти «${stmts[0]}», «${stmts[1]}»`);
    }
    if (count(fr, tag) !== 2) throw new Error(`фрагмент ${tag}: тег не двічі`);
  }
  /* Low-3 (канон 0203): тексти функцій, ACL і DDL на таблицях — у файлі, накаті й
     сухому прогоні ДОСЛІВНО однакові. */
  const inExec = (s) => s.replace(/;\s*$/, "");
  /* Долар-лапки `execute $x$ … $x$;` не сміють містити власного тега всередині
     (інакше тіло функції закриває обгортку достроково — синтаксична помилка
     лише на базі). Ловимо тут, а не на стенді. */
  for (const [fr, lbl] of [[APPLY, "накат"], [DRYRUN, "сухий прогін"], [ROLLBACK, "відкат"], [FALSIFY, "фальсифікація"]]) {
    const re = /execute (\$[a-z0-9_]*\$)\n/g;
    let m;
    let n = 0;
    while ((m = re.exec(fr))) {
      const tag = m[1];
      const from = m.index + m[0].length;
      const end = fr.indexOf(`\n${tag};`, from);
      if (end < 0) throw new Error(`${lbl}: execute ${tag} без закриття`);
      if (fr.slice(from, end).includes(tag)) throw new Error(`${lbl}: усередині execute ${tag} є той самий тег — обгортка закриється достроково`);
      n++;
    }
    if (!n) throw new Error(`${lbl}: жодного execute-блоку — перевірка вкладення нічого не бачила`);
  }
  for (const [lbl, x] of [["change_marker_recipients", CMR_NEW_STMT], ["мітла", PRUNE_STMT]]) {
    if (count(APPLY, inExec(x)) !== 1 || count(DRYRUN, inExec(x)) !== 1 || count(MIG, x) !== 1) {
      throw new Error(`текст «${lbl}» не рівно раз у файлі/накаті/сухому прогоні`);
    }
  }
  if (count(ROLLBACK, inExec(CMR_PRE_STMT)) !== 1 || count(FALSIFY, inExec(CMR_PRE_STMT)) !== 1) throw new Error("тіло 0184 не рівно раз у відкаті/фальсифікації");
  for (const [lbl, x] of [["ACL change_marker_recipients", CMR_ACL_DDL], ["ACL мітли", PRUNE_ACL_DDL], ["DDL на таблицях", TABLE_DDL]]) {
    if (count(APPLY, indent(x)) !== 1 || count(DRYRUN, indent(x)) !== 1 || count(MIG, x) !== 1) {
      throw new Error(`«${lbl}» не рівно раз у файлі/накаті/сухому прогоні`);
    }
  }
  /* ⚠️ ЯКОРІ СТЕНДІВ У ФАЙЛІ (канон 0203): кожен літерал стенда, що живе в тілі,
     трапляється у файлі рівно стільки разів, скільки в тілі; і жоден
     УНІКАЛЬНИЙ у тілі рядок (≥ 24 знаки) не має копії поза тілом. */
  {
    const dup = [];
    let n = 0;
    for (const x of STAND_LITERALS) {
      const inBody = count(NEW_BODY, x);
      if (!inBody) continue;
      n++;
      const inFile = count(MIG, x);
      if (inFile !== inBody) dup.push(`стенд ${JSON.stringify(x.slice(0, 70))}: тіло ${inBody}, файл ${inFile}`);
    }
    let lines = 0;
    for (const line of new Set(NEW_BODY.split("\n"))) {
      if (line.trim().length < 24 || count(NEW_BODY, line) !== 1) continue;
      lines++;
      if (count(MIG, line) !== 1) dup.push(`рядок ${JSON.stringify(line.trim().slice(0, 70))}: у файлі ${count(MIG, line)}`);
    }
    if (dup.length) throw new Error(`ФАЙЛ: текст тіла скопійовано поза тіло (стенди отримають «ЯКІР НЕ УНІКАЛЬНИЙ»):\n  ${dup.join("\n  ")}`);
    console.log(`  файл: ${n} якорів стендів і ${lines} унікальних рядків тіла — жодної копії поза тілом`);
  }
  /* Повний сторож ПЕРЕД DDL на таблицях і жодного виклику сторожа ПІСЛЯ — урок
     0196 (замки). Шукаємо в КОДІ (Low-2): згадка в шапці нічого не доводить. */
  const DDL_MARKS = ["alter policy ", "create trigger ", "drop trigger ", "alter table public.referral_access disable trigger"];
  for (const [fr, lbl] of [[APPLY, "накат"], [DRYRUN, "сухий прогін"], [MIG, "файл"], [FALSIFY, "фальсифікація"]]) {
    const code = codeOf(fr);
    const call = code.indexOf(SENTINEL_CALL);
    const ddl = Math.min(...DDL_MARKS.map((x) => code.indexOf(x)).filter((i) => i >= 0));
    if (count(code, SENTINEL_CALL) !== 1) throw new Error(`${lbl}: повний сторож у коді не рівно раз`);
    if (call < 0 || !Number.isFinite(ddl) || call > ddl) throw new Error(`${lbl}: повний сторож не ПЕРЕД DDL на таблицях`);
    if (/invariants_check\s*\((true|false)?\)/.test(code.slice(ddl))) throw new Error(`${lbl}: виклик сторожа ПІСЛЯ DDL — під замками`);
  }
  /* Замір сухого прогону — ДО DDL (Low-4 ревʼю 0203). */
  {
    const code = codeOf(DRYRUN);
    if (!(code.indexOf("into v_rq, v_rw, v_rc, v_rprof, v_rkeys") < code.indexOf("alter policy "))) {
      throw new Error("сухий прогін: замір радіуса не ДО DDL");
    }
  }
  /* Фальсифікація: база ДО проб, проби ДО мутацій, дослівні запити ПІСЛЯ мутацій. */
  {
    const iBase = FALSIFY.indexOf(SENTINEL_CALL);
    const iProbe = FALSIFY.indexOf("  -- R-granted\n");
    const iMut = FALSIFY.indexOf("-- falsify 0204 M14: вихолощена мітла");
    const iQ14 = FALSIFY.lastIndexOf(Q14_NEW);
    const iQ19 = FALSIFY.lastIndexOf(Q19_NEW.replace(/\n$/, ""));
    const iQ17 = FALSIFY.lastIndexOf(Q17_NEW);
    const iQ16 = FALSIFY.lastIndexOf(Q16_NEW);
    if (!(iBase > 0 && iBase < iProbe && iProbe < iMut && iMut < iQ14 && iQ14 < iQ19 && iQ19 < iQ17 && iQ17 < iQ16)) {
      throw new Error("фальсифікація: порядок база → проби → мутації → №14 → №19 → №17 → №16 порушено");
    }
  }
}

if (existsSync(DST_MIG)) {
  const old = readFileSync(DST_MIG, "utf8").replace(/\r/g, "");
  if (old !== MIG && !FORCE) {
    throw new Error(`${DST_MIG} уже є і його зміст ІНШИЙ. Якщо md5 файла вже в леджері — перезапис = дрейф = червона збірка. Свідомо: --force`);
  }
}
writeFileSync(DST_MIG, MIG);
writeFileSync("scripts/frag/0204_apply.sql", APPLY + "\n");
writeFileSync("scripts/frag/0204_dryrun.sql", DRYRUN + "\n");
writeFileSync("scripts/frag/0204_rollback.sql", ROLLBACK + "\n");
writeFileSync("scripts/frag/0204_falsify.sql", FALSIFY + "\n");

{
  const back = split(DST_MIG);
  if (md5(back.body) !== NEW_MD5 || back.body.length !== NEW_LEN) {
    throw new Error(`ЗАПИСАНИЙ ФАЙЛ дає ${md5(back.body)} / ${back.body.length}, а зібрано ${NEW_MD5} / ${NEW_LEN}`);
  }
  if (back.prologue !== SRC.prologue) throw new Error("DDL сторожа у записаному файлі розʼїхався з 0203");
}

console.log("0204 зібрано.");
console.log(`  сторож:   ${PRE_MD5} / ${PRE_LEN}  ->  ${NEW_MD5} / ${NEW_LEN}`);
console.log(`  checked:  ${CHECKED};  №16: 63 (3 дайджести);  №17: ${OLD17.length} -> ${NEW17.length} (+ order:);  №19: 60 (1 md5)`);
console.log(`  ${CMR}: raw ${CMR_PRE_RAW} -> ${CMR_NEW_RAW}; №19 ${CMR_PRE_REC19} -> ${CMR_NEW_REC19}`);
console.log(`  мітла:    ${PRUNE_SIG} raw md5 ${PRUNE_RAW}`);
console.log(`  пін:      ${PIN}`);
console.log(`  фальсифікація: проб ${N_PROBES} (необовʼязкових ${N_OPT})`);
console.log(`  пар підстановки: ${PAIRS.length}; змістових перевірок: ${CHECKS.length}; зворотний хід -> 0203`);
for (const p of POLICIES) console.log(`  №16 ${p.tbl}.${p.pol}: ${p.oldDig} -> ${p.newDig}`);
console.log(`  файли: ${DST_MIG}, scripts/frag/0204_{apply,dryrun,rollback,falsify}.sql`);
