// build-0203-reprint.mjs — збирає supabase/migrations/0203_audit_pii_referrer_grant.sql
// і scripts/frag/0203_{apply,dryrun,rollback,falsify}.sql.
//
// ЩО РОБИТЬ ПАКЕТ (рішення власника 24.09 і 25.09.2026, с79):
//   1. Р2, варіант (б): аудит-слід `fn_audit()` ще на ЧОТИРИ таблиці — з ПІІ
//      `patient_cases`, `doctors`, `referrer_private` і прайс `services`
//      (критерій «ПІІ АБО невідновна правка»; привід — RF-03: 26.08 за одну
//      мілісекунду змінились 37 позицій `services`, відновити було нічим).
//      Тіло `fn_audit` НЕ чіпаємо (його пінить №19).
//   2. Н-9 + Р-1 + Р-2: гард `guard_record_read_keys()` (тригер
//      `zz_guard_read_keys`) на `queue_entries`, `waitlist_entries`,
//      `patient_cases`. У запису ДВА ключі читання — `referrer_id` і
//      `created_by`: політики читання (`queue_select`, `waitlist_select`,
//      `cases_select_referrer`) пропускають `created_by = auth.uid() or
//      referrer_id = auth.uid()` без гранту і центру. Ключ без законного
//      доступу до центру запису гард МОВЧКИ ставить у NULL (Р-2, не відмова);
//      `doctor` не чіпає. Тригер БЕЗ списку колонок і ОСТАННІЙ серед
//      BEFORE-тригерів рядка (імʼя `zz_`, L4 ревʼю) — бачить остаточні ключі.
//   3. Передрук сторожа: +7 пар у №17 (23 -> 30), +1 рядок у №19 (59 -> 60) і
//      проза. `checked` 26. №22 / №23 / №26 НЕ змінюються — генератор це
//      ДОВОДИТЬ: код тіла без коментарів відрізняється від 0202 рівно вісьмома
//      новими рядками і комою в колишньому останньому рядку №17.
//
// ⚠️ ФОРМА — ПОВНИЙ ПЕРЕДРУК з 0202 якірними вставками (канон build-0202):
//    `latestReprint()` у тестах і стендах бере ОСТАННІЙ файл, де рядок
//    ПОЧИНАЄТЬСЯ з create-or-replace сторожа.
//
// ⚠️ ПОРЯДОК У НАКАТІ — не косметика (урок 0196, замір: `invariants_check` =
//    9065 мс, а в `authenticated` `statement_timeout = 8s`): повний прогін
//    сторожа йде ДО DDL на таблицях. `create trigger` бере SHARE ROW EXCLUSIVE
//    (а `drop trigger` — ACCESS EXCLUSIVE) на шість живих таблиць; тримати їх
//    девʼять секунд = не «почекати», а ВПАСТИ кожному запису реєстратури.
//    Тому: функція → передрук → пін → ПОВНИЙ сторож (мусить назвати рівно сім
//    відсутніх пар — червона база №17, побудована самим накатом) → DDL
//    тригерів → порядок BEFORE-тригерів → вирізаний ДОСЛІВНО запит №17
//    (мілісекунди) → леджер. Фальсифікація — так само: повний сторож ДО
//    мутацій, під мутаціями лише дослівні запити №17 і №19 (Low-1 ревʼю).
//
// ⚠️ ПІСЛЯ `npm run db:gate` ЦЕЙ ГЕНЕРАТОР НЕ ЗАПУСКАТИ: він перезаписує файл
//    міграції, чий md5 уже в леджері. Без `--force` відмовляється, якщо зміст інший.
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const count = (s, needle) => s.split(needle).length - 1;
const FORCE = process.argv.includes("--force");

const MIGDIR = "supabase/migrations";
const SRC_NAME = "0202_tz_kyiv_no_catalog_scan.sql";
const SRC_MIG = `${MIGDIR}/${SRC_NAME}`;
const DST_NAME = "0203_audit_pii_referrer_grant.sql";
const DST_MIG = `${MIGDIR}/${DST_NAME}`;
const PREV_LEDGER = SRC_NAME;
/** Прод 24.09 ≈19:00 UTC (замір оркестратора): тіло сторожа = тіло у файлі 0202. */
const PRE_MD5 = "e1f1fdcfcea99906f02b0af193b814fa";
const PRE_LEN = 165537;
const PRE_PIN = `guard_body_md5=${PRE_MD5};len=${PRE_LEN}`;
const CHECKED = 26;
/** Перевірки, червоні на проді ДО пакета не з його вини (замір 24.09: лише №13). */
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

// ---------------------------------------------------------------------------
// 1. БАЗИСИ ДЖЕРЕЛА. Кожен — числом.
// ---------------------------------------------------------------------------
const SRC = split(SRC_MIG);
if (md5(SRC.body) !== PRE_MD5 || SRC.body.length !== PRE_LEN) {
  throw new Error(`ВИТЯГ ЗЛАМАНИЙ: 0202 дав ${md5(SRC.body)} / ${SRC.body.length}, а в проді ${PRE_MD5} / ${PRE_LEN}`);
}
if (SRC.head + SRC.prologue + SRC.body + "$function$;" + SRC.tail !== SRC.raw) {
  throw new Error("СКЛЕЙКА ЗЛАМАНА: 0202 не збирається назад побайтово");
}
{
  const pins = [...SRC.raw.matchAll(GUARD_PIN_RE)].map((m) => m[1]);
  if (pins.length !== 1 || pins[0] !== PRE_PIN) {
    throw new Error(`ПІН 0202 у файлі ${JSON.stringify(pins)}, а в проді ${PRE_PIN}`);
  }
}
{
  const later = readdirSync(MIGDIR)
    .filter((f) => f.endsWith(".sql") && f > SRC_NAME && f !== DST_NAME).sort();
  if (later.length) throw new Error(`після 0202 на диску вже є ${later.join(", ")} — номер 0203 зайнятий чи черга зсунулась`);
}

// ---------------------------------------------------------------------------
// 2. ОБʼЄКТИ ПАКЕТА. Визначення тригерів — нормалізований пробілами рендер
//    `pg_get_triggerdef` (події в порядку INSERT, DELETE, UPDATE; функція без
//    схеми, бо `public` у шляху сторожа). Сухий прогін звіряє їх ЖИВИМ
//    рендером — вирізаним дослівно запитом №17 — і при розбіжності друкує
//    справжній рендер.
// ---------------------------------------------------------------------------
const FN = "guard_record_read_keys";
const FN_SIG = `${FN}()`;
/** Імʼя тригера: `zz_` — щоб у C-порядку йти ПІСЛЯ всіх BEFORE-тригерів рядка
    трьох таблиць (прецедент — `zz_invite_issued_at` на `profiles`). */
const TG = "zz_guard_read_keys";
const auditDef = (t) =>
  `CREATE TRIGGER trg_audit_${t} AFTER INSERT OR DELETE OR UPDATE ON public.${t} FOR EACH ROW EXECUTE FUNCTION fn_audit()`;
const guardDef = (t) =>
  `CREATE TRIGGER ${TG} BEFORE INSERT OR UPDATE ON public.${t} FOR EACH ROW EXECUTE FUNCTION ${FN}()`;
/** Сім нових пар — у порядку списку №17 (таблиця, потім тригер; C-порядок). */
const NEW_TRIGGERS = [
  ["doctors", "trg_audit_doctors", auditDef("doctors")],
  ["patient_cases", "trg_audit_patient_cases", auditDef("patient_cases")],
  ["patient_cases", TG, guardDef("patient_cases")],
  ["queue_entries", TG, guardDef("queue_entries")],
  ["referrer_private", "trg_audit_referrer_private", auditDef("referrer_private")],
  ["services", "trg_audit_services", auditDef("services")],
  ["waitlist_entries", TG, guardDef("waitlist_entries")],
];
const AUDIT_TABLES = NEW_TRIGGERS.filter(([, tg]) => tg.startsWith("trg_audit_")).map(([t]) => t);
const GUARD_TABLES = NEW_TRIGGERS.filter(([, tg]) => tg === TG).map(([t]) => t);
if (AUDIT_TABLES.join() !== "doctors,patient_cases,referrer_private,services") throw new Error("склад аудит-таблиць не той");
if (GUARD_TABLES.join() !== "patient_cases,queue_entries,waitlist_entries") throw new Error("склад гард-таблиць не той");

/** DDL тригера — канонічним статементом (drop if exists → create). Гард — БЕЗ
    списку колонок (L4 ревʼю): `UPDATE OF` пропускав би правку ключа, що
    прийшла не згадкою колонки, а від пізнішого тригера. */
const trgDdl = (t, tg) => tg.startsWith("trg_audit_")
  ? [`drop trigger if exists ${tg} on public.${t};`,
     `create trigger ${tg}`,
     `  after insert or delete or update on public.${t}`,
     `  for each row execute function public.fn_audit();`].join("\n")
  : [`drop trigger if exists ${tg} on public.${t};`,
     `create trigger ${tg}`,
     `  before insert or update on public.${t}`,
     `  for each row execute function public.${FN}();`].join("\n");
/** Порядок DDL: спершу аудит (AFTER, нічого не змінює), потім гарди. */
const DDL_ORDER = [...NEW_TRIGGERS.filter(([, tg]) => tg.startsWith("trg_audit_")),
                   ...NEW_TRIGGERS.filter(([, tg]) => !tg.startsWith("trg_audit_"))];
const TRIGGERS_DDL = DDL_ORDER.map(([t, tg]) => trgDdl(t, tg)).join("\n\n");

/** Тег тіла гарда — лише літери (`tests/slotOccupancy.test.ts` читає теги
    регуляркою `\$([A-Za-z_]*)\$`) і не `$function$` (межі тіла сторожа мусять
    лишатись унікальними у файлі — `split()`). */
const FN_TAG = "$fnbody$";
const FN_STMT = [
  `create or replace function public.${FN}()`,
  "returns trigger",
  "language plpgsql",
  "security definer",
  "set search_path = public, pg_temp",
  `as ${FN_TAG}`,
  "declare",
  "  v_actor uuid;",
  "  v_actor_role text;",
  "  v_ref boolean := true;",
  "  v_cb boolean := true;",
  "begin",
  "  -- Н-9, Р-1, Р-2 (0203; рішення власника 24 і 25.09.2026).",
  "  -- У запису ДВА ключі читання: `queue_select` і `waitlist_select` пускають",
  "  -- `… or created_by = auth.uid() or referrer_id = auth.uid()`, а",
  "  -- `cases_select_referrer` — `created_by = uid or referrer_id = uid`; жодна",
  "  -- не питає ні гранту, ні центру, ні кабінету. Хто виставив ключ, той",
  "  -- вирішив, хто ще читатиме ПІБ і телефон пацієнта. Політики запису",
  "  -- персоналу значень ключів не обмежують, `queue_write_referrer` вимагає",
  "  -- лише, щоб СОБОЮ був один із двох, а definer-RPC беруть `referrer_id` із",
  "  -- параметра.",
  "  -- Р-2: гард НЕ відмовляє. Ключ без законного доступу до центру ЗАПИСУ він",
  "  -- ставить у NULL — рядок лягає, а чужий профіль його не читає.",
  "  -- `doctor` (текст направлення) не чіпає. Слід — `raise warning`",
  "  -- READ_KEY_CLEARED (таблиця, ключ, роль актора; БЕЗ uuid і ПДн) у лог",
  "  -- сервера: запису він не перериває і поведінки не змінює (L-a ревʼю).",
  "  -- ПРАВИЛО `referrer_id`: NULL або профіль із роллю `referrer` і АКТИВНИМ",
  "  --   грантом (`referral_access`, статус active) саме до центру запису;",
  "  --   актор-направник — лише NULL або сам (колезі запис не призначає).",
  "  -- ПРАВИЛО `created_by`: NULL; сам актор; адмін чи реєстратор ЦЬОГО центру;",
  "  --   направник з активним грантом до нього. Радіолог — лише як актор:",
  "  --   читання за `created_by` минає його кабінетну межу. Актор-направник —",
  "  --   лише NULL або сам (другий ключ — той самий канал, що й перший).",
  "  -- Службова роль (auth.uid() порожній) — ті самі правила без гілки актора.",
  "",
  "  -- UPDATE: незмінний ключ при незмінному центрі нового доступу не відкриває",
  "  -- і не перевіряється — кожен ключ окремо (інакше грант, відкликаний ПІСЛЯ",
  "  -- призначення, стирав би ключ при правці телефону чи нотатки). Зміна",
  "  -- центру перевіряє обидва ключі наново.",
  "  if tg_op = 'UPDATE' then",
  "    if new.clinic_id is not distinct from old.clinic_id then",
  "      v_ref := new.referrer_id is distinct from old.referrer_id;",
  "      v_cb := new.created_by is distinct from old.created_by;",
  "    end if;",
  "  end if;",
  "  v_ref := v_ref and new.referrer_id is not null;",
  "  v_cb := v_cb and new.created_by is not null;",
  "  if not (v_ref or v_cb) then",
  "    return new;",
  "  end if;",
  "",
  "  -- Актора читаємо ЛИШЕ тут: масові UPDATE без зміни ключів (перенос, статус)",
  "  -- виходять вище без жодного читання.",
  "  v_actor := auth.uid();",
  "  v_cb := v_cb and new.created_by is distinct from v_actor;",
  "  if not (v_ref or v_cb) then",
  "    return new;",
  "  end if;",
  "  if v_actor is not null then",
  "    select p.role::text into v_actor_role",
  "      from public.profiles p",
  "     where p.id = v_actor;",
  "  end if;",
  "",
  "  if v_ref then",
  "    if (v_actor_role = 'referrer' and new.referrer_id is distinct from v_actor)",
  "       or not exists (",
  "         select 1",
  "           from public.profiles p",
  "           join public.referral_access ra on ra.referrer_id = p.id",
  "          where p.id = new.referrer_id",
  "            and p.role = 'referrer'",
  "            and ra.clinic_id = new.clinic_id",
  "            and ra.status = 'active'",
  "       ) then",
  "      new.referrer_id := null;",
  "      raise warning 'READ_KEY_CLEARED table=% key=% actor_role=%', tg_table_name, 'referrer_id', coalesce(v_actor_role, 'service');",
  "    end if;",
  "  end if;",
  "",
  "  -- Тут `created_by` уже не актор: сам актор відсіяний вище.",
  "  if v_cb then",
  "    if v_actor_role = 'referrer'",
  "       or not exists (",
  "         select 1",
  "           from public.profiles p",
  "          where p.id = new.created_by",
  "            and ((p.role in ('admin', 'registrar') and p.clinic_id = new.clinic_id)",
  "                 or (p.role = 'referrer' and exists (",
  "                       select 1",
  "                         from public.referral_access ra",
  "                        where ra.referrer_id = p.id",
  "                          and ra.clinic_id = new.clinic_id",
  "                          and ra.status = 'active')))",
  "       ) then",
  "      new.created_by := null;",
  "      raise warning 'READ_KEY_CLEARED table=% key=% actor_role=%', tg_table_name, 'created_by', coalesce(v_actor_role, 'service');",
  "    end if;",
  "  end if;",
  "",
  "  -- МЕЖІ, названі вголос:",
  "  --   • наявні рядки гард не переписує: ключ, виставлений до 0203 або з",
  "  --     грантом, відкликаним ПІСЛЯ, читання не забирає, доки його (чи центр)",
  "  --     не змінюють — політики читання не змінено (друга половина Н-9);",
  "  --   • кабінет (`room_ids` гранту) не перевіряється — лише центр;",
  "  --   • відновлення рядка з before-образу `audit_log` теж іде крізь гард: для",
  "  --     точного образу — `disable trigger zz_guard_read_keys` у тій самій",
  "  --     транзакції (№17 ловить `trigger_off:`, якщо забути ввімкнути);",
  "  --   • тіло пінить №19 (md5 разом з `attrs`), визначення тригерів — №17;",
  "  --     ПОРЯДОК (гард — останній BEFORE-тригер рядка, імʼя `zz_`) не пінить",
  "  --     жоден: його тримають асерт накату і статичний тест. Будь-яка правка",
  "  --     функції — лише разом із передруком сторожа.",
  "  return new;",
  "end;",
  `${FN_TAG};`,
].join("\n");
/** prosrc = текст між `as $fnbody$` і `$fnbody$;` — від `\n` після тега до `\n` перед ним. */
const FN_BODY = (() => {
  const a = FN_STMT.indexOf(`as ${FN_TAG}\n`);
  const b = FN_STMT.lastIndexOf(`\n${FN_TAG};`);
  if (a < 0 || b < 0 || count(FN_STMT, FN_TAG) !== 2) throw new Error("гард: межі тіла не знайдено");
  return FN_STMT.slice(a + `as ${FN_TAG}`.length, b + 1);
})();
const normWs = (s) => s.replace(/\s+/g, " ").trim();
/** Рецепт №19 (`md5(btrim(regexp_replace(prosrc, '\s+', ' ', 'g')))`) — тільки ASCII-пробіли. */
if ([...FN_STMT].some((ch) => { const c = ch.codePointAt(0); return c === 0x09 || c === 0x0b || c === 0x0c || c === 0x0d || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200b) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff; })) {
  throw new Error("гард: у тексті є не-ASCII пробіл або табуляція — рецепт №19 у PG і JS розійдеться");
}
const FN_RAW_MD5 = md5(FN_BODY);
const FN_NORM_MD5 = md5(normWs(FN_BODY));
const FN_ATTRS = "secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres";
const FN_ACL = "postgres=X/postgres,service_role=X/postgres";
const FN_ACL_DDL = [
  `revoke all on function public.${FN}() from public, anon, authenticated;`,
  `grant execute on function public.${FN}() to service_role;`,
].join("\n");

/** Серверний слід обнулення (L-a ревʼю р3): таблиця, ключ, роль актора — БЕЗ
    uuid і ПДн; `warning` запису не перериває. Рівно два, по одному на ключ. */
const WARN_CLEARED = ["referrer_id", "created_by"].map((k) =>
  `raise warning 'READ_KEY_CLEARED table=% key=% actor_role=%', tg_table_name, '${k}', coalesce(v_actor_role, 'service');`);
/** Код без коментарів — той самий вирізувач, що в `tests/guardFnBodiesInvariant.test.ts`. */
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
{
  const code = codeOf(FN_BODY);
  const firstRead = Math.min(...["select ", "auth.uid()"].map((x) => code.indexOf(x)).filter((i) => i >= 0));
  for (const [lbl, ok] of [
    ["UPDATE: незмінний центр — кожен ключ окремо, і лише в гілці UPDATE",
      /if tg_op = 'UPDATE' then\n\s+if new\.clinic_id is not distinct from old\.clinic_id then\n\s+v_ref := new\.referrer_id is distinct from old\.referrer_id;\n\s+v_cb := new\.created_by is distinct from old\.created_by;\n\s+end if;\n\s+end if;/.test(code)],
    ["порожні й незмінні ключі виходять ДО будь-якого читання",
      /v_ref := v_ref and new\.referrer_id is not null;\n\s+v_cb := v_cb and new\.created_by is not null;\n\s+if not \(v_ref or v_cb\) then\n\s+return new;/.test(code)
      && code.indexOf("if not (v_ref or v_cb) then") < firstRead],
    ["auth.uid() — рівно раз і лише як актор", count(code, "auth.uid()") === 1 && code.includes("v_actor := auth.uid();")],
    ["сам актор знімає перевірку created_by — і лише її; v_actor ще лише в L3 і читанні ролі",
      code.includes("v_cb := v_cb and new.created_by is distinct from v_actor;")
      && (code.match(/\bv_actor\b/g) || []).length === 6
      && code.includes("if v_actor is not null then") && code.includes("where p.id = v_actor;")],
    ["referrer_id: роль referrer + active саме до центру запису + L3 актора-направника",
      normWs(code).includes("if (v_actor_role = 'referrer' and new.referrer_id is distinct from v_actor) or not exists ( select 1 from public.profiles p join public.referral_access ra on ra.referrer_id = p.id where p.id = new.referrer_id and p.role = 'referrer' and ra.clinic_id = new.clinic_id and ra.status = 'active' ) then new.referrer_id := null;")],
    ["created_by: персонал ЦЬОГО центру або направник з active; актор-направник — лише сам",
      normWs(code).includes("if v_actor_role = 'referrer' or not exists ( select 1 from public.profiles p where p.id = new.created_by and ((p.role in ('admin', 'registrar') and p.clinic_id = new.clinic_id) or (p.role = 'referrer' and exists ( select 1 from public.referral_access ra where ra.referrer_id = p.id and ra.clinic_id = new.clinic_id and ra.status = 'active'))) ) then new.created_by := null;")],
    ["грант — лише active і лише центр запису, в обох гілках",
      count(code, "ra.status") === 2 && count(code, "ra.status = 'active'") === 2 && count(code, "ra.clinic_id = new.clinic_id") === 2],
    ["присвоєння лише двом ключам і лише NULL",
      (code.match(/new\.\w+\s*:=/g) || []).join() === "new.referrer_id :=,new.created_by :=" && code.includes("new.referrer_id := null;") && code.includes("new.created_by := null;")],
    ["Р-2: жодної відмови, жодного ковтання рядка; `raise` — лише два warning-сліди без uuid і ПДн",
      JSON.stringify((code.match(/\braise\b[^;]*;/gi) || []).map(normWs)) === JSON.stringify(WARN_CLEARED.map(normWs))
      && !/return\s+null|exception\s+when|raise\s+exception/i.test(code)],
    ["`doctor` не чіпає", !/doctor/i.test(code)],
    ["жодних обходів за сесією", !/current_user|session_user|current_setting|request\.jwt|service_role|pg_has_role|rolsuper|replication_role|auth\.(role|jwt)\s*\(/i.test(code)],
    ["жодного слова invite_token (№15 g2)", !FN_STMT.includes("invite_token")],
    ["рівно три `return new;`", count(code, "return new;") === 3],
  ]) if (!ok) throw new Error(`ГАРД: не виконано «${lbl}»`);
}

// ---------------------------------------------------------------------------
// 3. ПАРИ ВСТАВКИ В ТІЛО СТОРОЖА. Якір — ПОВНИЙ рядок списку №17, за яким
//    стає нова пара; кожен — рівно одне влучання. Колишній ОСТАННІЙ рядок
//    (`waitlist_entries/trg_guard_waitlist_room`, без коми) отримує кому, а
//    новий останній — `waitlist_entries/zz_guard_read_keys` — іде без неї.
//    Плюс абзац прози №17.
// ---------------------------------------------------------------------------
const rowLine = (t, tg, def, last = false) => `      ('${t}','${tg}','${def}')${last ? "" : ","}\n`;
const LAST_OLD = ["waitlist_entries", "trg_guard_waitlist_room",
  "CREATE TRIGGER trg_guard_waitlist_room BEFORE INSERT OR UPDATE OF room_id, clinic_id ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_waitlist_room()"];
const ANCHOR_ROWS = {
  "ceo_access/trg_audit_ceo_access": rowLine("ceo_access", "trg_audit_ceo_access",
    "CREATE TRIGGER trg_audit_ceo_access AFTER INSERT OR DELETE OR UPDATE ON public.ceo_access FOR EACH ROW EXECUTE FUNCTION fn_audit()"),
  "patient_cases/a00_radiologist_no_write": rowLine("patient_cases", "a00_radiologist_no_write",
    "CREATE TRIGGER a00_radiologist_no_write BEFORE INSERT OR DELETE OR UPDATE ON public.patient_cases FOR EACH ROW EXECUTE FUNCTION guard_radiologist_no_write()"),
  "queue_entries/trg_guard_status_referrer": rowLine("queue_entries", "trg_guard_status_referrer",
    "CREATE TRIGGER trg_guard_status_referrer BEFORE UPDATE OF status ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_status_change_referrer()"),
  "referral_access/trg_zzz_sched_markers_prune": rowLine("referral_access", "trg_zzz_sched_markers_prune",
    "CREATE TRIGGER trg_zzz_sched_markers_prune AFTER DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION tg_sched_markers_prune_on_access()"),
  "schedule_overrides/trg_zz_change_markers": rowLine("schedule_overrides", "trg_zz_change_markers",
    "CREATE TRIGGER trg_zz_change_markers AFTER INSERT OR DELETE OR UPDATE ON public.schedule_overrides FOR EACH ROW EXECUTE FUNCTION tg_change_markers_sched_override()"),
  /* колишній останній рядок — ЯКІР без коми; після вставки він із комою */
  "waitlist_entries/trg_guard_waitlist_room": rowLine(...LAST_OLD, true),
};
const LAST_KEY = "waitlist_entries/trg_guard_waitlist_room";
const LAST_NEW_KEY = `waitlist_entries/${TG}`;
const NEW_ROW = Object.fromEntries(NEW_TRIGGERS.map(([t, tg, def]) =>
  [`${t}/${tg}`, rowLine(t, tg, def, `${t}/${tg}` === LAST_NEW_KEY)]));
/** [якір-пара, нові пари після нього] */
const INSERTS = [
  ["ceo_access/trg_audit_ceo_access", ["doctors/trg_audit_doctors"]],
  ["patient_cases/a00_radiologist_no_write", ["patient_cases/trg_audit_patient_cases", `patient_cases/${TG}`]],
  ["queue_entries/trg_guard_status_referrer", [`queue_entries/${TG}`]],
  ["referral_access/trg_zzz_sched_markers_prune", ["referrer_private/trg_audit_referrer_private"]],
  ["schedule_overrides/trg_zz_change_markers", ["services/trg_audit_services"]],
  [LAST_KEY, [LAST_NEW_KEY]],
];
if (INSERTS.flatMap(([, xs]) => xs).sort().join() !== Object.keys(NEW_ROW).sort().join()) {
  throw new Error("INSERTS не покривають рівно сім нових пар");
}
const ROW_PAIRS = INSERTS.map(([anchor, adds]) => [
  ANCHOR_ROWS[anchor],
  (anchor === LAST_KEY ? rowLine(...LAST_OLD) : ANCHOR_ROWS[anchor]) + adds.map((k) => NEW_ROW[k]).join(""),
  `№17: після ${anchor} + ${adds.join(", ")}`,
]);

const P17_FROM = "  --          список». Це рішення власника, а не пропуск.\n  v_n := v_n + 1;\n";
const PROSE_0203 = [
  "  --",
  "  --     ⚠️ 0203 (с79, рішення власника 24–25.09: Р2(б), Н-9, Р-1, Р-2) ДОДАЛА",
  "  --        СІМ ПАР (23 → 30), `checked` той самий:",
  "  --         • ЧОТИРИ аудит-тригери `trg_audit_*` — на `patient_cases`,",
  "  --           `doctors`, `referrer_private` (ПІІ) і `services` (прайс:",
  "  --           невідновна правка; привід — RF-03, 26.08 за одну мілісекунду",
  "  --           змінились 37 позицій, відновити було нічим). Функція та сама —",
  "  --           `fn_audit()`; її тіло пінить №19, і 0203 його НЕ змінювала.",
  "  --         • ТРИ гарди `zz_guard_read_keys` — на `queue_entries`,",
  "  --           `waitlist_entries`, `patient_cases`, `BEFORE INSERT OR UPDATE`",
  "  --           БЕЗ списку колонок. `referrer_id` і `created_by` — КЛЮЧІ",
  "  --           ЧИТАННЯ: політики читання пропускають їх без гранту і центру,",
  "  --           тож ключ без законного доступу до центру запису гард ставить",
  "  --           у NULL (не відмова; слід — warning READ_KEY_CLEARED у лозі",
  "  --           сервера, без uuid і ПДн). Імʼя `zz_` — щоб гард ішов",
  "  --           ОСТАННІМ серед BEFORE-тригерів рядка і бачив остаточні ключі.",
  "  --        ⚠️ МЕЖІ 0203, названі вголос:",
  "  --         • тут лише ВИЗНАЧЕННЯ тригерів; тіло `guard_record_read_keys()`",
  "  --           тримає №19 (0203 внесла його туди ж, 59 → 60) — так само, як",
  "  --           тіла одинадцяти гардів 0171–0172. Фальсифікація 0203 вихолощує",
  "  --           тіло і вимагає `body:` саме від №19, а не від цієї перевірки;",
  "  --         • ПОРЯДОК спрацювання ця перевірка НЕ пінить: новий BEFORE-тригер",
  "  --           з імʼям, що за абеткою після гарда, і правкою ключа обійшов би",
  "  --           його мовчки. Порядок тримають асерт накату і статичний тест",
  "  --           пакета (`tests/auditPiiReferrerGrant.test.ts`);",
  "  --         • `referrer_private` не має ні `id`, ні `clinic_id`: `fn_audit`",
  "  --           пише `row_id` і `clinic_id` NULL. Такий рядок бачить лише",
  "  --           службова роль (читання `audit_log` — за `clinic_id`), тобто",
  "  --           приватна пошта направника адміну центру не відкривається;",
  "  --           звʼязок із направником — поле `referrer_id` у before/after;",
  "  --         • список ІМЕННИЙ: нова таблиця з ПІБ без аудит-тригера цій",
  "  --           перевірці невидима — гілки за властивістю 0203 не додає.",
].join("\n") + "\n";
const P17_TO = "  --          список». Це рішення власника, а не пропуск.\n" + PROSE_0203 + "  v_n := v_n + 1;\n";

/* ── №19: рядок гарда 0203. Рішення оркестратора 24.09 за постановкою Н-9
   («міграція + передрук №17/№19») і уроком «пінити того, хто ВИРІШУЄ доступ».
   Позиція — у відсортованому хвості списку, між сусідами за абеткою
   `guard_radiologist_scope()` і `guard_referrer_doctor()`; md5 і `attrs` — з
   ФІНАЛЬНОГО тексту функції (FN_NORM_MD5, FN_ATTRS), формат — як у сусідів. ── */
const ROW19_ANCHOR = "      ('guard_radiologist_scope()','16fab10b6de82574e5f103fd0e40d8d5','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),\n";
const ROW19_NEXT = "      ('guard_referrer_doctor()','4b60225a9b22453cad33b1190af31950','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),\n";
const ROW19_NEW = `      ('${FN_SIG}','${FN_NORM_MD5}','${FN_ATTRS}'),\n`;
if (!/^secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=[^']+$/.test(FN_ATTRS)) {
  throw new Error("FN_ATTRS не за формою сусідніх рядків №19");
}
if (!(FN_SIG > "guard_radiologist_scope()" && FN_SIG < "guard_referrer_doctor()")) {
  throw new Error("рядок гарда не між сусідами за абеткою");
}
const PROSE19_0203 = [
  "  --     ⚠️ 0203 (с79, Н-9 і Р-1) ДОДАЛА ОДНУ: `guard_record_read_keys()` — тіло",
  "  --        трьох тригерів `zz_guard_read_keys` (`queue_entries`,",
  "  --        `waitlist_entries`, `patient_cases`). Список став 60. Підстава —",
  "  --        постановка Н-9 («міграція + передрук №17/№19») і урок проєкту:",
  "  --        пінити того, хто ВИРІШУЄ доступ, а не лише того, хто рішення",
  "  --        застосовує. Ця функція вирішує, чиї `referrer_id` і `created_by`",
  "  --        відкриють читання ПІБ і телефону пацієнта: вихолощене тіло",
  "  --        (`return new;`) повернуло б обидва канали МОВЧКИ — №17 бачить",
  "  --        лише визначення тригерів. Прецеденти тригерних функцій у цьому",
  "  --        списку — `fn_audit()`, `guard_invite_issued_at()`. Рішення",
  "  --        оркестратора 24.09 за постановкою Н-9; пакет —",
  "  --        `docs/audit/PR-0203-audit-pii-referrer-grant.md`.",
  "  --        ⚠️ ЦІНА та сама, що в абзацах 0200/0201: будь-яка правка функції —",
  "  --           тіло, `grant`/`revoke`, `alter function` — лише разом із",
  "  --           передруком сторожа. Фальсифікація 0203 доводить, що",
  "  --           вихолощене тіло червонить саме цю перевірку (`body:`).",
].join("\n") + "\n";
const P19_FROM = "  --           ВИЗНАЧЕННЯ тригерів.\n  v_n := v_n + 1;\n";
const P19_TO = "  --           ВИЗНАЧЕННЯ тригерів.\n" + PROSE19_0203 + "  v_n := v_n + 1;\n";
const P19_COUNT_FROM = "  --     ЩО ПІНИМО (сьогодні 59 підписів; ключ — імʼя РАЗОМ із типами\n";
const P19_COUNT_TO = "  --     ЩО ПІНИМО (сьогодні 60 підписів; ключ — імʼя РАЗОМ із типами\n";
const P19_HIST_FROM = "  --        зміни складу), а заголовок ніхто не перечитував: 0192 оновила\n";
const P19_HIST_TO = "  --        зміни складу; 0203 → 60), а заголовок ніхто не перечитував: 0192 оновила\n";

const PAIRS = [
  ...ROW_PAIRS,
  [P17_FROM, P17_TO, "проза №17: абзац 0203"],
  [ROW19_ANCHOR, ROW19_ANCHOR + ROW19_NEW, `№19: після guard_radiologist_scope() + ${FN_SIG}`],
  [P19_FROM, P19_TO, "проза №19: абзац 0203"],
  [P19_COUNT_FROM, P19_COUNT_TO, "проза №19: сьогодні 59 → 60 підписів"],
  [P19_HIST_FROM, P19_HIST_TO, "проза №19: історія складу + 0203 → 60"],
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
  // length() у PG рахує символи, .length у JS — одиниці UTF-16: поза BMP вони розходяться
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
/** Список №17 — між `from (values` і `) as e(tbl, tg, def)` під міткою перевірки. */
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
const OLD17 = rows17(SRC.body);
const NEW17 = rows17(NEW_BODY);
const OLD_CODE = codeOf(SRC.body).split("\n");
const NEW_CODE = codeOf(NEW_BODY).split("\n");
const STEP = /^  v_n := v_n \+ 1;$/gm;
/** C-порядок — той, в якому стоїть список (таблиця, потім тригер). */
const cmpC = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const LAST_OLD_LINE = rowLine(...LAST_OLD, true).replace(/\n$/, "");
const LAST_OLD_LINE_COMMA = rowLine(...LAST_OLD).replace(/\n$/, "");

const CHECKS = [
  ["№17: було 23, стало 30", () => OLD17.length === 23 && NEW17.length === 30],
  ["№17: старі 23 рядки — ті самі і в тому самому відносному порядку (колишній останній — лише з комою)", () =>
    JSON.stringify(NEW17.filter((r) => !NEW_ROW[`${r.tbl}/${r.tg}`]).map((r) => r.line))
      === JSON.stringify(OLD17.map((r) => (r.line === LAST_OLD_LINE ? LAST_OLD_LINE_COMMA : r.line)))],
  ["№17: сім нових — рівно ті, що в NEW_TRIGGERS, з тими самими визначеннями", () =>
    JSON.stringify(NEW17.filter((r) => NEW_ROW[`${r.tbl}/${r.tg}`]).map((r) => [r.tbl, r.tg, r.def]))
      === JSON.stringify(NEW_TRIGGERS)],
  ["№17: список відсортований (таблиця, тригер) — C-порядок", () =>
    NEW17.every((r, i) => i === 0 || cmpC(`${NEW17[i - 1].tbl} ${NEW17[i - 1].tg}`, `${r.tbl} ${r.tg}`) < 0)],
  ["№17: пари унікальні", () => new Set(NEW17.map((r) => `${r.tbl}/${r.tg}`)).size === 30],
  ["№17: останній рядок — гард листа очікування, без коми; решта з комою", () =>
    NEW17.slice(0, -1).every((r) => r.line.endsWith("),")) && NEW17.at(-1).line.endsWith("')")
      && `${NEW17.at(-1).tbl}/${NEW17.at(-1).tg}` === LAST_NEW_KEY],
  ["№17: у кожній таблиці гарда `zz_guard_read_keys` — останній рядок таблиці", () =>
    GUARD_TABLES.every((t) => NEW17.filter((r) => r.tbl === t).at(-1).tg === TG)],
  ["код без коментарів: рівно 8 НОВИХ рядків (7 у №17, 1 у №19) і кома в колишньому останньому рядку №17, решта — 0202", () => {
    const want = [...Object.values(NEW_ROW), ROW19_NEW].map((x) => x.replace(/\n$/, ""));
    const added = NEW_CODE.filter((l) => want.includes(l));
    const rest = NEW_CODE.filter((l) => !want.includes(l));
    const oldPatched = OLD_CODE.map((l) => (l === LAST_OLD_LINE ? LAST_OLD_LINE_COMMA : l));
    return added.length === 8 && count(OLD_CODE.join("\n"), LAST_OLD_LINE) === 1
      && JSON.stringify(rest) === JSON.stringify(oldPatched);
  }],
  [`№19: 59 → 60 — старі 59 рядків дослівно й у тому ж порядку, новий — між guard_radiologist_scope() і guard_referrer_doctor()`, () => {
    const o = list19(SRC.body).match(SIG19_RE) || [];
    const n = list19(NEW_BODY).match(SIG19_RE) || [];
    const row = ROW19_NEW.replace(/\n$/, "");
    const at = n.indexOf(row);
    return o.length === 59 && n.length === 60 && at > 0 && n.lastIndexOf(row) === at
      && n[at - 1] === ROW19_ANCHOR.replace(/\n$/, "") && n[at + 1] === ROW19_NEXT.replace(/\n$/, "")
      && JSON.stringify(n.filter((_, i) => i !== at)) === JSON.stringify(o)
      && list19(NEW_BODY).replace(ROW19_NEW, "") === list19(SRC.body);
  }],
  ["проза №19: «сьогодні 60 підписів» = фактичний склад списку", () =>
    count(NEW_BODY, "ЩО ПІНИМО (сьогодні 60 підписів;") === 1 && count(NEW_BODY, "сьогодні 59 підписів") === 0
      && (list19(NEW_BODY).match(SIG19_RE) || []).length === 60],
  ["число кроків `v_n := v_n + 1` те саме (checked 26)", () =>
    (SRC.body.match(STEP) || []).length === CHECKED && (NEW_BODY.match(STEP) || []).length === CHECKED],
  ["перевірка №26 і хвіст тіла не зачеплені", () =>
    NEW_BODY.slice(NEW_BODY.indexOf("with recursive cr(oid) as (")) === SRC.body.slice(SRC.body.indexOf("with recursive cr(oid) as ("))],
  ["перший рядок тіла і хвіст — як у 0202", () =>
    NEW_BODY.startsWith(SRC.body.slice(0, 200)) && NEW_BODY.endsWith(SRC.body.slice(-400))],
  ["проза 0203 названа рівно раз — і в №17, і в №19", () =>
    count(NEW_BODY, "0203 (с79, рішення власника 24–25.09: Р2(б), Н-9, Р-1, Р-2)") === 1
      && count(NEW_BODY, "0203 (с79, Н-9 і Р-1) ДОДАЛА ОДНУ") === 1],
  ["проза не несе чужих тегів, кроків, міток і лапок", () =>
    [PROSE_0203, PROSE19_0203].every((x) => !/\$|'|v_n := v_n|'check',|\/\*|\*\/|invite_token/.test(x)
      && x.split("\n").filter(Boolean).every((l) => l.startsWith("  --")))],
  ["зворотний хід дає 0202 побайтово", () => {
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
// 6. ВИРАЗИ, ВИРІЗАНІ з тіла сторожа ДОСЛІВНО:
//    • `cur` №19 — рецепт піна тіла й атрибутів: фрагменти звіряють ним гард
//      0203 (рядок №19) ОДРАЗУ після створення — з названою причиною, ще до
//      повного прогону сторожа;
//    • запит №17 — зі старого (23 пари) і нового (30 пар) тіла;
//    • запит №19 цілком (від `v_atg` до обробника) — фальсифікація виконує
//      його ПІД мутаціями замість повного сторожа (Low-1: мілісекунди під
//      замками замість девʼяти секунд).
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
for (const [lbl, re] of [
  ["джерело pg_proc", /from pg_proc p\n/],
  ["повний md5 нормалізованого тіла", /md5\(btrim\(regexp_replace\(/],
  ["поле ;acl=", /';acl='\s*\|\|\s*case when p\.proacl is null then '<default>'/],
  ["розширення по голому імені", /p\.proname = any \(select split_part\(e\.fn, '\(', 1\) from expd e\)/],
]) if (!re.test(CUR_EXPR)) throw new Error(`ВИРАЗ cur: немає «${lbl}»`);
if (/--|\/\*|\$/.test(CUR_EXPR)) throw new Error("ВИРАЗ cur містить коментар або долар");

/** Межі запиту №17 у тілі сторожа — ОДНІ на генератор і на пост-асерт файлу
 *  (там запит вирізається з ЖИВОГО тіла за цими ж межами, див. MIG_POST). */
const Q17_START = "  select array_agg(x.txt order by x.txt) into v_tmp\n    from (\n      select case when a.def is null";
const Q17_END = "\n    ) x;\n  if v_tmp is not null then\n    v_fail := v_fail || jsonb_build_array(jsonb_build_object(\n      'check', 'guard_triggers'";
/** Запит №17 від `select array_agg(...) into v_tmp` до `) x;` — дослівно. */
const q17Of = (body) => {
  if (count(body, Q17_START) !== 1 || count(body, Q17_END) !== 1) throw new Error("запит №17: якорі не по одному");
  const a = body.indexOf(Q17_START);
  const b = body.indexOf(Q17_END, a);
  if (b < 0) throw new Error("запит №17: термінатор не після початку");
  return body.slice(a, b + "\n    ) x;".length);
};
const Q17_NEW = q17Of(NEW_BODY);
const Q17_OLD = q17Of(SRC.body);
for (const [lbl, q, n] of [["новий", Q17_NEW, 30], ["старий", Q17_OLD, 23]]) {
  if ((q.match(/^ {6}\('[a-z_]+','[a-z0-9_]+','CREATE TRIGGER /gm) || []).length !== n) throw new Error(`запит №17 (${lbl}): рядків не ${n}`);
  if (!q.includes("regexp_replace(pg_get_triggerdef(t.oid), '\\s+', ' ', 'g')")) throw new Error(`запит №17 (${lbl}): рендер не той`);
  if (!q.includes("and t.tgenabled not in ('O', 'A')")) throw new Error(`запит №17 (${lbl}): гілки вимкнення немає`);
  if (/\$/.test(q)) throw new Error(`запит №17 (${lbl}) містить долар`);
}
/** Запит №19 — від `v_tmp := null;` + читання тригера `auth.users` до кінця
 *  обробника `guard_fn_bodies_raised:` включно. Дає `v_tmp` (порушники). */
const Q19_START = "  v_tmp := null;\n  select regexp_replace(pg_get_triggerdef(t.oid), '\\s+', ' ', 'g') || '/' || t.tgenabled::text\n    into v_atg\n";
const Q19_END = "  exception when others then\n    v_tmp := array['guard_fn_bodies_raised:' || sqlstate || ':' || left(sqlerrm, 120)];\n  end;\n";
const Q19_NEW = (() => {
  if (count(NEW_BODY, Q19_START) !== 1 || count(NEW_BODY, Q19_END) !== 1) throw new Error("запит №19: якорі не по одному");
  const a = NEW_BODY.indexOf(Q19_START);
  const b = NEW_BODY.indexOf(Q19_END, a);
  if (b < 0) throw new Error("запит №19: кінець не після початку");
  return NEW_BODY.slice(a, b + Q19_END.length);
})();
if ((Q19_NEW.match(SIG19_RE) || []).length !== 60 || !Q19_NEW.includes(ROW19_NEW)) throw new Error("запит №19: не 60 рядків або немає рядка гарда");
if (!Q19_NEW.includes("), cur as (" + CUR_EXPR)) throw new Error("запит №19: вираз cur не той");
if (/\$/.test(Q19_NEW) || /v_n := v_n/.test(Q19_NEW)) throw new Error("запит №19 містить долар або крок лічильника");
if (NEW_BODY.indexOf(Q19_NEW) > NEW_BODY.indexOf("'check', 'guard_fn_bodies'")) throw new Error("запит №19 не перед міткою перевірки");

// ---------------------------------------------------------------------------
// 7. ЗВІРКА СТЕНДОВИХ ЯКОРІВ ЗА ЛІТЕРАЛАМИ (лексер із 0201/0202).
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

/** Складені якорі: літерали, зшиті `+` (як у falsify-0180), — ОДИН якір.
 *  Окремий шматок такого якоря (`"  if v_tmp is not null then\n"`) якорем не є,
 *  і звіряти його унікальність у файлі — хибна тривога. */
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
 *  файл останнього передруку ЦІЛКОМ, і якір, скопійований поза тіло (пост-асерт,
 *  шапка), стає «ЯКІР НЕ УНІКАЛЬНИЙ (2)» — ревізія стендів 24.09 так і впала
 *  (0181 — сім якорів виразу `cur`, 0182 — рядок №17), коли пост-асерт файлу
 *  ніс дослівні копії запиту №17 і виразу `cur`. */
const STAND_LITERALS = new Set();
{
  const stands = readdirSync("scripts").filter((f) => /^falsify-.*\.mjs$/.test(f));
  if (stands.length < 30) throw new Error(`ЯКОРІ: лише ${stands.length} стендів — очікувалось ≥30`);
  const migs = readdirSync(MIGDIR).filter((f) => f.endsWith(".sql") && f !== DST_NAME);
  const stale = [];
  const ambiguous = [];
  let checked = 0;
  for (const f of stands) {
    const txt = readFileSync(`scripts/${f}`, "utf8").replace(/\r/g, "");
    const named = migs.filter((m) => txt.includes(`${MIGDIR}/${m}`) && m !== SRC_NAME);
    for (const x of compositesOf(txt)) STAND_LITERALS.add(x);
    for (const lit of new Set(literalsOf(txt))) {
      const before = count(SRC.body, lit);
      if (before === 0) continue;
      checked++;
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
  if (checked < 100) throw new Error(`ЯКОРІ: звірено лише ${checked} літералів — розбір стендів зламався`);
  if (stale.length) throw new Error(`ЯКОРІ ПРОТУХЛИ:\n  ${stale.join("\n  ")}`);
  console.log(`  якорі стендів: ${stands.length} файлів, ${checked} літералів у тілі сторожа, 0 протухлих`);
}

// ---------------------------------------------------------------------------
// 8. ФРАГМЕНТИ. Теги: $p$ — рядки підстановок; $fxa$ — statement гарда;
//    блоки — $apply$/$dryrun$/$back$/$falsify$. Жоден текст не сміє нести чужий тег.
// ---------------------------------------------------------------------------
const FRAG_TAGS = ["$p$", "$apply$", "$dryrun$", "$back$", "$falsify$", "$fxa$", "$fxb$", "$pre$", "$chk$", "$post$", "$fnbody$"];
for (const t of FRAG_TAGS) {
  if (NEW_BODY.includes(t)) throw new Error(`тіло сторожа містить тег ${t}`);
  for (const [f, to, lbl] of PAIRS) if ((f + to).includes(t)) throw new Error(`пара «${lbl}» містить тег ${t}`);
  if (CUR_EXPR.includes(t) || Q17_NEW.includes(t) || Q17_OLD.includes(t) || Q19_NEW.includes(t)) throw new Error(`вираз cur/№17/№19 містить тег ${t}`);
  if (t !== FN_TAG && FN_STMT.includes(t)) throw new Error(`гард містить тег ${t}`);
}
const q = (s) => `$p$${s}$p$`;
const lit = (s) => `'${s.replace(/'/g, "''")}'`;
const arr = (xs) => "array[\n" + xs.map((x) => `    ${q(x)}`).join(",\n") + "\n  ]";
const sqlArr = (xs) => `array[${xs.map(lit).join(", ")}]::text[]`;
const PAIRS_SQL = NEW_TRIGGERS.map(([t, tg]) => `(${lit(t)}, ${lit(tg)})`).join(", ");
const GUARD_RELS_SQL = GUARD_TABLES.map((t) => `'public.${t}'::regclass`).join(", ");

const PRE = (tag) => [
  "  perform set_config('lock_timeout', '5s', true);",
  "  -- Шлях фіксуємо явно: інакше читання pg_proc і рендер pg_get_triggerdef",
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
  `    raise exception '${tag}: у леджері немає 0202 — накат не в свою чергу';`,
  "  end if;",
  "  if (select max(name) from public.migration_ledger) is distinct from",
  `     '${PREV_LEDGER}' then`,
  `    raise exception '${tag}: останній рядок леджера % — не 0202, черга зсунулась',`,
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

/** Нових обʼєктів НЕМАЄ — строгий предстан накату (чернетка через execute_sql,
    клас 0195/0201, мусить зупинити, а не тихо перезаписатись). */
const ABSENT = (tag) => [
  `  if to_regprocedure('public.${FN_SIG}') is not null then`,
  `    raise exception '${tag}: функція ${FN_SIG} уже існує — чиясь чернетка? спершу розібратись';`,
  "  end if;",
  "  select array_agg(c.relname || '.' || t.tgname order by c.relname, t.tgname) into v_bad",
  "    from pg_trigger t join pg_class c on c.oid = t.tgrelid",
  "   where c.relnamespace = 'public'::regnamespace and not t.tgisinternal",
  `     and (c.relname::text, t.tgname::text) in (${PAIRS_SQL});`,
  "  if v_bad is not null then",
  `    raise exception '${tag}: тригери пакета вже існують: % — спершу розібратись', v_bad;`,
  "  end if;",
].join("\n");

/** Передумови, на яких стоїть проза і дизайн (звіряємо, а не віримо). */
const PREMISES = (tag) => [
  "  -- ── Передумови дизайну: колонки ключів і центру, мітки енумів, межа referrer_private ──",
  "  select array_agg(x order by x) into v_bad from (",
  "    select t || '.' || col as x",
  `      from unnest(array['queue_entries', 'waitlist_entries', 'patient_cases']) t,`,
  "           unnest(array['referrer_id', 'created_by', 'clinic_id']) col",
  "     where not exists (select 1 from pg_attribute a",
  "                        where a.attrelid = to_regclass('public.' || t)",
  "                          and a.attname = col and a.attnum > 0 and not a.attisdropped",
  "                          and a.atttypid = 'uuid'::regtype)",
  "  ) m;",
  "  if v_bad is not null then",
  `    raise exception '${tag}: гард стоїть на колонках, яких немає або вони не uuid: %', v_bad;`,
  "  end if;",
  "  -- Мітки, з якими порівнює гард: хибна мітка — це «invalid input value for",
  "  -- enum» на КОЖНІЙ вставці з ключем, тобто зупинена реєстратура.",
  "  if (select a.atttypid from pg_attribute a",
  "       where a.attname = 'role' and a.attrelid = 'public.profiles'::regclass)",
  "       is distinct from 'public.user_role'::regtype",
  "     or (select a.atttypid from pg_attribute a",
  "          where a.attname = 'status' and a.attrelid = 'public.referral_access'::regclass)",
  "       is distinct from 'public.referral_access_status'::regtype",
  "     or (select count(*) from pg_enum e",
  "          where e.enumtypid = 'public.user_role'::regtype",
  "            and e.enumlabel in ('admin', 'registrar', 'referrer')) <> 3",
  "     or not exists (select 1 from pg_enum e",
  "                     where e.enumtypid = 'public.referral_access_status'::regtype",
  "                       and e.enumlabel = 'active') then",
  `    raise exception '${tag}: типи або мітки ролі/статусу гранту не ті, з якими порівнює гард';`,
  "  end if;",
  "  if exists (select 1 from pg_attribute a",
  "              where a.attrelid = 'public.referrer_private'::regclass",
  "                and a.attname in ('id', 'clinic_id') and a.attnum > 0 and not a.attisdropped) then",
  `    raise exception '${tag}: у referrer_private зʼявились id/clinic_id — проза про NULL у audit_log протухла, переглянути';`,
  "  end if;",
  "  if to_regprocedure('public.fn_audit()') is null then",
  `    raise exception '${tag}: fn_audit() немає — аудит-тригерам нічого кликати';`,
  "  end if;",
].join("\n");

const fnExec = (tag) => `  execute ${tag}\n${FN_STMT.replace(/;\s*$/, "")}\n${tag};`;

/** Рядок гарда — рецептом `cur` №19 (тіло нормалізоване + атрибути з ACL). */
const fnRow = (tag, what) => [
  `  -- ── Гард ${what}: рецепт №19 (\`cur\`, вирізаний із тіла) + сирий md5 prosrc ──`,
  "  with expd(fn, body, attrs) as (values",
  `      ('${FN_SIG}','${FN_NORM_MD5}','${FN_ATTRS}')`,
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
  `    raise exception '${tag}: гард ${what} не той: %', v_bad;`,
  "  end if;",
  `  if (select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = 'public.${FN_SIG}'::regprocedure)`,
  `     is distinct from '${FN_RAW_MD5}' then`,
  `    raise exception '${tag}: сирий md5 тіла гарда ${what} не ${FN_RAW_MD5}';`,
  "  end if;",
].join("\n");

/** Клієнтські ролі НЕ можуть виконати гард — ні прямо, ні через PUBLIC. */
const fnAclAssert = (tag) => [
  "  -- ── ACL гарда: пастка 0122 (дефолтний ACL схеми public роздає EXECUTE і anon,",
  "  --    і PUBLIC) — асерт у ТІЙ САМІЙ транзакції ──",
  `  if has_function_privilege('anon', 'public.${FN_SIG}', 'EXECUTE')`,
  `     or has_function_privilege('authenticated', 'public.${FN_SIG}', 'EXECUTE')`,
  "     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f'::\"char\", p.proowner))) a",
  `                 where p.oid = 'public.${FN_SIG}'::regprocedure and a.grantee = 0) then`,
  `    raise exception '${tag}: ${FN_SIG} виконують anon/authenticated/PUBLIC — ACL не звужено';`,
  "  end if;",
  `  if not has_function_privilege('service_role', 'public.${FN_SIG}', 'EXECUTE') then`,
  `    raise exception '${tag}: service_role втратив EXECUTE на ${FN_SIG}';`,
  "  end if;",
  "  select array_to_string(array(select t from unnest(p.proacl::text[]) t order by t collate \"C\"), ',')",
  "    into v_acl from pg_proc p",
  `   where p.oid = 'public.${FN_SIG}'::regprocedure;`,
  `  if v_acl is distinct from '${FN_ACL}' then`,
  `    raise exception '${tag}: ACL ${FN_SIG} = % замість ${FN_ACL}', v_acl;`,
  "  end if;",
].join("\n");

/** Гард — ОСТАННІЙ BEFORE-тригер рядка на INSERT/UPDATE кожної з трьох таблиць
    (L4). Порядок спрацювання — за імʼям у C-порядку; пізніший BEFORE-тригер,
    що правив би ключ, обійшов би гард мовчки. Бітові маски `tgtype`:
    ROW = 1, BEFORE = 2, INSERT = 4, UPDATE = 16. Вимкнені теж рахуються —
    їх можуть увімкнути. */
const ZZ_LAST = (tag) => [
  `  -- ── ${TG} — ОСТАННІЙ BEFORE-тригер рядка на INSERT/UPDATE кожної таблиці ──`,
  "  select array_agg(c.relname || '.' || x.tgname order by c.relname) into v_bad",
  "    from pg_class c",
  "    cross join lateral (",
  "      select t.tgname from pg_trigger t",
  "       where t.tgrelid = c.oid and not t.tgisinternal",
  "         and (t.tgtype & 3) = 3 and (t.tgtype & 20) <> 0",
  "       order by t.tgname collate \"C\" desc limit 1) x",
  `   where c.oid in (${GUARD_RELS_SQL})`,
  `     and x.tgname <> '${TG}';`,
  "  if v_bad is not null then",
  `    raise exception '${tag}: останній BEFORE-тригер рядка — не ${TG}: %', v_bad;`,
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

const WANT_MISSING = NEW_TRIGGERS.map(([t, tg]) => `missing:${t}.${tg}`).sort(cmpC);
const KNOWN_RED_SQL = `(${[...KNOWN_RED, "guard_triggers"].map(lit).join(", ")})`;
/** ПОВНИЙ сторож ДО DDL на таблицях. Червона база №17, побудована самим
    накатом: нове тіло вже чекає 30 пар, а тригерів ще немає — №17 МУСИТЬ
    назвати рівно сім `missing:`. Зелене тут = список №17 не живий. */
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
  "  select array_agg(o.value order by o.value collate \"C\") into v_off17",
  "    from jsonb_array_elements(v_res->'failed') e,",
  "         jsonb_array_elements_text(e.value->'offenders') o",
  "   where e.value->>'check' = 'guard_triggers';",
  `  if v_off17 is distinct from ${sqlArr(WANT_MISSING)} then`,
  `    raise exception '${tag}: №17 до DDL мусить назвати рівно сім відсутніх пар, а назвав % — список №17 не живий?', v_off17;`,
  "  end if;",
].join("\n");

/** №17 — ДОСЛІВНО тим запитом, що в тілі (нове тіло → 30 пар). */
const Q17_ASSERT = (tag, which, what) => [
  `  -- ── №17 ${what}: запит вирізано ДОСЛІВНО з тіла ${which === "new" ? "0203" : "0202"} ──`,
  "  v_tmp := null;",
  which === "new" ? Q17_NEW : Q17_OLD,
  "  if v_tmp is not null then",
  `    raise exception '${tag}: №17 ${what} червоний: %', v_tmp;`,
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
  "  v_failed text[]; v_off17 text[]; v_acl text;",
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

const indent = (s, pad = "  ") => s.split("\n").map((l) => (l ? pad + l : l)).join("\n");

/** Тіло накату — спільне для apply і dryrun. `beforeDdl` — замір сухого прогону:
    він стоїть ДО DDL (Low-4 ревʼю: після DDL на таблицях уже замки). */
const FORWARD = (tag, beforeDdl = null) => [
  PRE(tag),
  LEDGER_GUARDS(tag),
  readGuard(tag, PRE_MD5, PRE_LEN, PRE_PIN, "0202"),
  ABSENT(tag),
  PREMISES(tag),
  "",
  "  -- ── 1. Гард-функція і її ACL (замків на таблиці не бере) ─────────────────",
  fnExec("$fxa$"),
  indent(FN_ACL_DDL),
  fnRow(tag, "після створення"),
  fnAclAssert(tag),
  "",
  "  -- ── 2. Передрук сторожа: +7 пар у №17, рядок гарда в №19 і проза ─────────",
  substitute(tag, "v_from", "v_to", "v_lbl", NEW_MD5, NEW_LEN, "файл 0203"),
  "",
  pinBlock(tag, PIN),
  "",
  SENTINEL_BEFORE(tag),
  ...(beforeDdl ? ["", beforeDdl] : []),
  "",
  "  -- ── 3. Сім тригерів — ОСТАННІМ кроком перед леджером: SHARE ROW EXCLUSIVE /",
  "  --    ACCESS EXCLUSIVE на шість живих таблиць тримається мілісекунди ──",
  indent(TRIGGERS_DDL),
  "",
  ZZ_LAST(tag),
  "",
  Q17_ASSERT(tag, "new", "після DDL"),
  "",
  LEDGER_INSERT(tag),
].join("\n");

const ZZ_COUNT_SQL = [
  "       (select count(*) from pg_class c",
  "          cross join lateral (",
  "            select t.tgname from pg_trigger t",
  "             where t.tgrelid = c.oid and not t.tgisinternal",
  "               and (t.tgtype & 3) = 3 and (t.tgtype & 20) <> 0",
  "             order by t.tgname collate \"C\" desc limit 1) x",
  `         where c.oid in (${GUARD_RELS_SQL})`,
  `           and x.tgname = '${TG}') as zz_last_tables,`,
].join("\n");
const READBACK = [
  "select md5(replace(p.prosrc, chr(13), '')) as guard_md5,",
  "       length(replace(p.prosrc, chr(13), '')) as guard_len,",
  "       obj_description(p.oid, 'pg_proc') as guard_pin,",
  "       (select count(*) from public.migration_ledger) as ledger_rows,",
  "       (select max(name) from public.migration_ledger) as ledger_last,",
  "       (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid",
  "         where c.relnamespace = 'public'::regnamespace and not t.tgisinternal",
  `           and (c.relname::text, t.tgname::text) in (${PAIRS_SQL})) as new_triggers,`,
  ZZ_COUNT_SQL,
  `       to_regprocedure('public.${FN_SIG}') is not null as guard_fn,`,
  "       (select array_to_string(array(select t from unnest(f.proacl::text[]) t order by t collate \"C\"), ',')",
  `          from pg_proc f where f.oid = to_regprocedure('public.${FN_SIG}')) as guard_fn_acl`,
  "  from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  " where n.nspname = 'public' and p.proname = 'invariants_check'",
  "   and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';",
].join("\n");

const RED_WINDOW = [
  "-- ⚠️ ЧЕРВОНЕ ВІКНО (AGENTS.md, «Миграции и БД»): з commit цього блоку і до пушу",
  "--    `main` з файлом 0203 падає КОЖНА прод-збірка (гейт: рядок леджера без файла",
  "--    на диску). У вікні: жодного Redeploy, нічого іншого в `main`. Закрити ОДНИМ",
  "--    заходом: `npm run db:gate` → `npm test` → гілка → dev → main → push → деплой;",
  "--    перевірка — `npm run db:gate:check` на `main` І на `dev`. Не закрили в цей",
  "--    захід — `scripts/frag/0203_rollback.sql`, а не «доробимо завтра». Ліміт",
  "--    03:50 UTC (06:50 Київ) — на ВЕСЬ відрізок «накат → db:gate».",
].join("\n");

const APPLY = [
  "-- 0203 APPLY — ЗГЕНЕРОВАНО `node scripts/build-0203-reprint.mjs`. Одним запитом,",
  "-- ОДНА транзакція: гард-функція + ACL → передрук сторожа → пін → ПОВНИЙ сторож",
  "-- (до DDL на таблицях) → сім тригерів → порядок BEFORE-тригерів → запит №17",
  "-- дослівно → леджер.",
  "-- ⚠️ Канонічний файл міграції накатувати НЕ можна (кілька верхньорівневих",
  "--    стейтментів; тут — суворий предстан, у файлі — ідемпотентний).",
  "-- ⚠️ ТЕКСТ СЛАТИ ДОСЛІВНО: тіло гарда всередині $fxa$ і якорі всередині $p$",
  "--    входять у md5 — «прибрати рядки-коментарі» зламає пост-перевірки, і накат",
  "--    зупиниться (fail-closed, дрейфу не буде, але й накату теж).",
  "-- ⚠️ ТРИВАЛІСТЬ ≈10 с, і майже вся — повний прогін сторожа. Він стоїть ДО",
  "--    DDL на таблицях свідомо (урок 0196: 9 с під замком на запис = впалі",
  "--    записи реєстратури, бо в authenticated statement_timeout 8 с). Замки",
  "--    на шість таблиць (create/drop trigger) живуть мілісекунди до commit.",
  RED_WINDOW,
  "-- ⚠️ `invariants_check(false)` ПІСЛЯ commit — окремим запитом. Очікування:",
  `--    checked ${CHECKED}; failed ⊆ {${KNOWN_RED.join(", ")}, ledger_md5} (ledger_md5 — до \`npm run db:gate\`).`,
  DECL("apply", ...FWD),
  FORWARD("0203"),
  "",
  "  raise notice 'APPLY_0203_OK guard=% len=% pin=% ledger=%',",
  "    md5(v_src), length(v_src), v_pin_db, (select count(*) from public.migration_ledger);",
  "end;",
  "$apply$;",
  "",
  "-- Читання назад: очікування",
  `--   guard_md5 = ${NEW_MD5}, guard_len = ${NEW_LEN},`,
  `--   guard_pin = ${PIN}, ledger_rows = 203, ledger_last = ${DST_NAME},`,
  `--   new_triggers = 7, zz_last_tables = 3, guard_fn = true, guard_fn_acl = ${FN_ACL}`,
  READBACK,
  "",
  "-- ⚠️ `invariants_check` — ОКРЕМИМ запитом ПІСЛЯ commit. Не в 03:45–04:05 UTC.",
  "--      select public.invariants_check(false);",
  `--      -- очікування: checked ${CHECKED}; до \`npm run db:gate\` failed ⊆ {${KNOWN_RED.join(", ")}, ledger_md5}.`,
].join("\n");

/** Сухий прогін додає ЗАМІР (Low-4, Low-7 ревʼю): скільки наявних рядків гард
    поставив би в NULL, якби їхній ключ або центр ЗМІНИЛИ, — окремо для
    `referrer_id` і для `created_by` (за роллю творця). Агрегати, без ПДн. Це
    радіус для відновлень із before-образів і переносу між центрами, а НЕ
    умова зупинки. Стоїть ДО DDL: після нього на таблицях уже замки. */
const KEYS_UNION = (col) => [
  `      select 'q' as t, q.${col} as k, q.clinic_id as c from public.queue_entries q where q.${col} is not null`,
  "      union all",
  `      select 'w', w.${col}, w.clinic_id from public.waitlist_entries w where w.${col} is not null`,
  "      union all",
  `      select 'c', pc.${col}, pc.clinic_id from public.patient_cases pc where pc.${col} is not null`,
];
const ORPHANS = [
  "  -- ── ЗАМІР (не умова зупинки; агрегати, без ПДн): наявні рядки, чий ключ гард",
  "  --    поставив би в NULL, якби ключ або центр ЗМІНИЛИ чи рядок відновили з",
  "  --    before-образу. Стоїть ДО DDL — після нього на таблицях уже замки.",
  "  --    orphans_ref — referrer_id без активного гранту до центру запису (замір",
  "  --    24.09: черга 2, лист 0, кейси 0); orphans_cb — created_by поза правилом",
  "  --    БЕЗ гілки актора, за роллю творця (radiologist — рядки, які радіолог",
  "  --    створив сам: законні, доки ключ і центр не змінюють) ──",
  "  select count(*) filter (where x.t = 'q'), count(*) filter (where x.t = 'w'), count(*) filter (where x.t = 'c')",
  "    into v_oq, v_ow, v_oc",
  "    from (",
  ...KEYS_UNION("referrer_id"),
  "    ) x",
  "   where not exists (select 1 from public.profiles p join public.referral_access ra on ra.referrer_id = p.id",
  "                      where p.id = x.k and p.role = 'referrer' and ra.clinic_id = x.c and ra.status = 'active');",
  "  select coalesce(jsonb_object_agg(g.bucket, g.n order by g.bucket), '{}'::jsonb) into v_ocb",
  "    from (",
  "      select y.t || ':' || y.cat as bucket, count(*) as n",
  "        from (",
  "          select x.t,",
  "                 case",
  "                   when p.id is null then 'no_profile'",
  "                   when p.role in ('admin', 'registrar') and p.clinic_id = x.c then null",
  "                   when p.role in ('admin', 'registrar') then 'staff_other_clinic'",
  "                   when p.role = 'referrer' and exists (select 1 from public.referral_access ra",
  "                          where ra.referrer_id = p.id and ra.clinic_id = x.c and ra.status = 'active') then null",
  "                   when p.role = 'referrer' then 'referrer_no_grant'",
  "                   else p.role::text",
  "                 end as cat",
  "            from (",
  ...KEYS_UNION("created_by").map((l) => "    " + l),
  "            ) x",
  "            left join public.profiles p on p.id = x.k",
  "        ) y",
  "       where y.cat is not null",
  "       group by y.t, y.cat",
  "    ) g;",
].join("\n");

const DRYRUN = [
  "-- 0203 DRY RUN — ЗГЕНЕРОВАНО `node scripts/build-0203-reprint.mjs`. Те саме, що",
  "-- APPLY, плюс ЗАМІР для наявних даних (до DDL); транзакція СВІДОМО валиться в кінці.",
  "-- ⚠️ Маркер відкоту ОБОВʼЯЗКОВИЙ: «сухий» прогін без нього — це НАКАТ.",
  "-- ⚠️ Запит ПОЧИНАЄТЬСЯ з `set statement_timeout` (перший стейтмент), другий —",
  "--    `do` з тегом `dryrun`. Перед вставкою перевірити обидва і маркер",
  "--    `DRYRUN_0203_ROLLBACK` у кінці блоку: без них це НАКАТ.",
  "-- ⚠️ УСПІХ = ПОМИЛКА з текстом `DRYRUN_0203_ROLLBACK …`, `ok17=true` і",
  "--    `zz_last=true`. Будь-який інший текст — провал, прочитати і розібратись.",
  "--    Якщо визначення тригера розійшлось із рендером Postgres, помилка скаже",
  "--    `№17 після DDL червоний: {wrong_def:<таблиця>.<тригер>-><СПРАВЖНІЙ рендер>}`",
  "--    — його і повернути в генератор.",
  "-- ⚠️ `orphans_ref(q/w/c)` і `orphans_cb` — ЗАМІР, а не умова зупинки: інше",
  "--    число = переглянути абзац ціни в PR-доці, не стоп.",
  "-- ⚠️ ТРИВАЛІСТЬ ≈10 с; замки на таблиці — лише наприкінці і мілісекунди.",
  DECL("dryrun", ...FWD, ["  v_oq bigint; v_ow bigint; v_oc bigint; v_ocb jsonb;"]),
  FORWARD("0203-суха", ORPHANS),
  "",
  "  raise exception 'DRYRUN_0203_ROLLBACK guard=% len=% pin=% checked=% ok17=true zz_last=true failed_before_ddl=% orphans_ref(q/w/c)=%/%/% orphans_cb=%',",
  "    md5(v_src), length(v_src), v_pin_db, v_res->>'checked', v_res->'failed', v_oq, v_ow, v_oc, v_ocb;",
  "end;",
  "$dryrun$;",
  "",
  "-- ⚠️ `failed_before_ddl` містить `guard_triggers` із РІВНО сімома `missing:` — це",
  "--    червона база №17, так і мусить бути (асерт у блоці це вже перевірив).",
].join("\n");

const DROP_TRIGGERS = NEW_TRIGGERS.map(([t, tg]) => `drop trigger if exists ${tg} on public.${t};`).join("\n");

const ROLLBACK = [
  "-- 0203 ROLLBACK — ЗГЕНЕРОВАНО `node scripts/build-0203-reprint.mjs`.",
  "-- Знімає сім тригерів і гард-функцію, повертає тіло сторожа і самопін до 0202,",
  "-- знімає рядок леджера. Рядки, які аудит-тригери ВЖЕ записали в `audit_log`,",
  "-- лишаються (це журнал; їх обробить ретенція 0149/0152). Ключі, які гард уже",
  "-- поставив у NULL, відкат НЕ повертає (гард не пише, звідки що зняв).",
  "-- ⚠️ Одна транзакція. Перевіряти ОКРЕМИМ запитом після commit.",
  DECL("back", ...BWD),
  PRE("0203-відкат"),
  `  if not exists (select 1 from public.migration_ledger where name = '${DST_NAME}') then`,
  "    raise exception '0203-відкат: рядка 0203 у леджері немає — відкочувати нічого';",
  "  end if;",
  "  if (select max(name) from public.migration_ledger) is distinct from",
  `     '${DST_NAME}' then`,
  "    raise exception '0203-відкат: після 0203 уже накатано % — спершу відкотити його',",
  "      (select max(name) from public.migration_ledger);",
  "  end if;",
  readGuard("0203-відкат", NEW_MD5, NEW_LEN, PIN, "0203"),
  fnRow("0203-відкат", "до відкату"),
  Q17_ASSERT("0203-відкат", "new", "до відкату"),
  "",
  "  -- ── Тригери, потім функція (вона має залежних) ──",
  indent(DROP_TRIGGERS),
  `  drop function public.${FN_SIG};`,
  "  select array_agg(c.relname || '.' || t.tgname) into v_bad",
  "    from pg_trigger t join pg_class c on c.oid = t.tgrelid",
  "   where c.relnamespace = 'public'::regnamespace and not t.tgisinternal",
  `     and (c.relname::text, t.tgname::text) in (${PAIRS_SQL});`,
  `  if v_bad is not null or to_regprocedure('public.${FN_SIG}') is not null then`,
  "    raise exception '0203-відкат: обʼєкти пакета лишились: % / функція %', v_bad,",
  `      to_regprocedure('public.${FN_SIG}');`,
  "  end if;",
  "",
  substitute("0203-відкат", "v_from", "v_to", "v_lbl", PRE_MD5, PRE_LEN, "0202"),
  "",
  pinBlock("0203-відкат", PRE_PIN),
  "",
  Q17_ASSERT("0203-відкат", "old", "після відкату"),
  "",
  `  delete from public.migration_ledger where name = '${DST_NAME}';`,
  "  get diagnostics v_rows = row_count;",
  "  if v_rows <> 1 then",
  "    raise exception '0203-відкат: знято % рядків леджера замість 1', v_rows;",
  "  end if;",
  "",
  "  raise notice 'ROLLBACK_0203_OK guard=% len=% pin=% ledger=%',",
  "    md5(v_src), length(v_src), v_pin_db, (select count(*) from public.migration_ledger);",
  "end;",
  "$back$;",
  "",
  "-- Читання назад: очікування",
  `--   guard_md5 = ${PRE_MD5}, guard_len = ${PRE_LEN},`,
  `--   guard_pin = ${PRE_PIN}, ledger_rows = 202, ledger_last = ${PREV_LEDGER},`,
  "--   new_triggers = 0, zz_last_tables = 0, guard_fn = false, guard_fn_acl = NULL",
  READBACK,
  "",
  "-- ⚠️ ЦЕЙ ФРАГМЕНТ НЕ ДОВОДИТЬ ВІДКАТУ: асерти — усередині транзакції. Після",
  "--    commit ОКРЕМИМ запитом читання назад вище і `select public.invariants_check(false);`",
  `--    (checked ${CHECKED}, без \`guard_triggers\`). Git-частина — секція ВІДКАТ у міграції.`,
].join("\n");

// ── ФАЛЬСИФІКАЦІЯ ──────────────────────────────────────────────────────────
const M3_DDL = "create or replace trigger trg_audit_services\n    after insert or update on public.services\n    for each row execute function public.fn_audit();";
const M4_DDL = `create or replace trigger ${TG}\n    before insert or update of referrer_id on public.patient_cases\n    for each row execute function public.${FN}();`;
const WANT17_EXACT = ["missing:referrer_private.trg_audit_referrer_private", "trigger_off:doctors.trg_audit_doctors=D"];
const WANT17_PREFIX = [`wrong_def:patient_cases.${TG}->`, "wrong_def:services.trg_audit_services->"];
for (const w of [...WANT17_EXACT, ...WANT17_PREFIX]) if (/'/.test(w)) throw new Error(`WANT: лапка в ${w}`);
/** Порожнє тіло B1 — ТА САМА шапка (secdef, search_path, мова), а `create or
    replace` зберігає власника і ACL: `attrs` не зміниться, тож №19 мусить
    назвати РІВНО один порушник — `body:` з md5 порожнього тіла (рецепт №19). */
const B1_STMT = [
  `create or replace function public.${FN}()`,
  "returns trigger",
  "language plpgsql",
  "security definer",
  "set search_path = public, pg_temp",
  "as $fxb$",
  "begin",
  "  -- falsify 0203 B1: вихолощене тіло",
  "  return new;",
  "end;",
  "$fxb$",
].join("\n");
const B1_BODY = B1_STMT.slice(B1_STMT.indexOf("as $fxb$") + "as $fxb$".length, B1_STMT.lastIndexOf("\n$fxb$") + 1);
const WANT19 = [`body:${FN_SIG}->${md5(normWs(B1_BODY))}`];
if (md5(normWs(B1_BODY)) === FN_NORM_MD5) throw new Error("B1: порожнє тіло дає той самий md5, що справжнє");

/* ── Проби гарда: ТИМЧАСОВА таблиця, на ній ЛИШЕ цей тригер (ізоляція: жоден
   інший гард не відповість замість нього). Кожна проба — дія, потім ЧИТАННЯ
   обох ключів і звірка з очікуванням; помилка дії — теж промах із назвою.
   Актор — `request.jwt.claims` (канон AGENTS.md), службова роль — `'{}'`.
   У повідомленнях — лише «NULL» / «є», жодних uuid. ── */
const REF_STATUSES = ["active", "pending_referrer", "pending_clinic", "declined", "revoked"];
const claimsOf = (who) => (who ? `json_build_object('sub', ${who}, 'role', 'authenticated')::text` : "'{}'");
const symOf = (v) => `case when ${v} is null then 'NULL' else 'є' end`;
const PROBE_LABELS = [];
function probe({ label, actor = null, id, ins = null, upd = null, want, opt = null }) {
  if (PROBE_LABELS.includes(label)) throw new Error(`проба ${label} двічі`);
  PROBE_LABELS.push(label);
  const [wantRef, wantCb] = want;
  const action = ins
    ? `insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (${id}, ${ins.join(", ")});`
    : `update falsify_0203_g set ${upd} where id = ${id};`;
  const body = [
    `  -- ${label}`,
    `  perform set_config('request.jwt.claims', ${claimsOf(actor)}, true);`,
    "  begin",
    `    ${action}`,
    `    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = ${id};`,
    `    if v_r is not distinct from ${wantRef} and v_c is not distinct from ${wantCb} then`,
    `      v_ok := v_ok || ${lit(label)}::text;`,
    "    else",
    `      v_miss := v_miss || (${lit(`${label}: ref=`)} || ${symOf("v_r")} || ' cb=' || ${symOf("v_c")});`,
    "    end if;",
    "  exception when others then",
    "    get stacked diagnostics v_msg = message_text;",
    `    v_miss := v_miss || (${lit(`${label}: `)} || sqlstate || ' ' || left(v_msg, 80));`,
    "  end;",
  ].join("\n");
  if (!opt) return body;
  return [
    `  if ${opt} is null then`,
    `    v_na := v_na || ${lit(label)}::text;`,
    "  else",
    indent(body),
    "  end if;",
  ].join("\n");
}
const grantOf = (ref, clinic, status) => [
  "  perform set_config('request.jwt.claims', '{}', true);",
  `  insert into public.referral_access (referrer_id, clinic_id, status) values (${ref}, ${clinic}, '${status}')`,
  "    on conflict (referrer_id, clinic_id) do update set status = excluded.status;",
].join("\n");
const optGrantOf = (opt, ref, clinic, status) => `  if ${opt} is not null then\n${indent(grantOf(ref, clinic, status))}\n  end if;`;

let PID = 0;
const nid = () => ++PID;
const PROBE_BLOCKS = [
  "  -- ── G: ГАРД ІЗОЛЬОВАНО — тимчасова таблиця, на ній ЛИШЕ цей тригер ──────",
  "  create temp table falsify_0203_g (id int primary key, clinic_id uuid, referrer_id uuid, created_by uuid) on commit drop;",
  `  create trigger ${TG} before insert or update on falsify_0203_g`,
  `    for each row execute function public.${FN}();`,
  "  -- Фікстури: центр з адміном, ІНШИЙ центр, направник (обовʼязкові); другий",
  "  -- направник, радіолог, реєстратор і CEO — якщо є (інакше проба = n/a у звіті).",
  "  -- Гранти ФАБРИКУЄМО в транзакції (канон referrer_cases_smoke): стан",
  "  -- задаємо, а не шукаємо.",
  "  select p.clinic_id, p.id into v_clinic, v_admin from public.profiles p",
  "   where p.role = 'admin' and p.clinic_id is not null order by p.created_at, p.id limit 1;",
  "  select c.id into v_clinic2 from public.clinics c where c.id <> v_clinic order by c.created_at, c.id limit 1;",
  "  select p.id into v_ref from public.profiles p where p.role = 'referrer' order by p.created_at, p.id limit 1;",
  "  if v_clinic is null or v_clinic2 is null or v_ref is null then",
  "    raise exception '0203-фальсифікація: фікстур немає (центр з адміном / другий центр / направник): % % %',",
  "      v_clinic is not null, v_clinic2 is not null, v_ref is not null;",
  "  end if;",
  "  select p.id into v_ref2 from public.profiles p",
  "   where p.role = 'referrer' and p.id <> v_ref order by p.created_at, p.id limit 1;",
  "  select p.id, p.clinic_id into v_rad, v_rad_clinic from public.profiles p",
  "   where p.role = 'radiologist' and p.clinic_id is not null order by p.created_at, p.id limit 1;",
  "  select p.id, p.clinic_id into v_reg, v_reg_clinic from public.profiles p",
  "   where p.role = 'registrar' and p.clinic_id is not null order by p.created_at, p.id limit 1;",
  "  select p.id into v_ceo from public.profiles p where p.role = 'ceo' order by p.created_at, p.id limit 1;",
  "",
  "  -- ── R/C: ключ за статусом гранту (L1), службова роль ──",
  grantOf("v_admin", "v_clinic", "active") + "   -- не-направник ІЗ активним грантом: відмова — від РОЛІ",
  grantOf("v_ref", "v_clinic2", "revoked"),
];
for (const s of REF_STATUSES) {
  const keep = s === "active";
  PROBE_BLOCKS.push(
    grantOf("v_ref", "v_clinic", s),
    probe({ label: `R-${s}`, id: nid(), ins: ["v_clinic", "v_ref", "null"], want: [keep ? "v_ref" : "null", "null"] }),
    probe({ label: `C-ref-${s}`, id: nid(), ins: ["v_clinic", "null", "v_ref"], want: ["null", keep ? "v_ref" : "null"] }),
  );
}
PROBE_BLOCKS.push(
  "  -- грант лише до ІНШОГО центру (до центру запису — revoked з циклу вище)",
  grantOf("v_ref", "v_clinic2", "active"),
  probe({ label: "R-other-clinic", id: nid(), ins: ["v_clinic", "v_ref", "null"], want: ["null", "null"] }),
  probe({ label: "C-ref-other-clinic", id: nid(), ins: ["v_clinic", "null", "v_ref"], want: ["null", "null"] }),
  probe({ label: "R-not-referrer", id: nid(), ins: ["v_clinic", "v_admin", "null"], want: ["null", "null"] }),
  probe({ label: "R-ghost", id: nid(), ins: ["v_clinic", "v_ghost", "null"], want: ["null", "null"] }),
  probe({ label: "C-admin-own", id: nid(), ins: ["v_clinic", "null", "v_admin"], want: ["null", "v_admin"] }),
  probe({ label: "C-admin-foreign", id: nid(), ins: ["v_clinic2", "null", "v_admin"], want: ["null", "null"] }),
  probe({ label: "C-ghost", id: nid(), ins: ["v_clinic", "null", "v_ghost"], want: ["null", "null"] }),
  probe({ label: "C-registrar-own", id: nid(), ins: ["v_reg_clinic", "null", "v_reg"], want: ["null", "v_reg"], opt: "v_reg" }),
  probe({ label: "C-radiologist", id: nid(), ins: ["v_rad_clinic", "null", "v_rad"], want: ["null", "null"], opt: "v_rad" }),
  "  -- CEO з АКТИВНИМ доступом до центру (фабрикуємо) — усе одно не творець запису",
  "  if v_ceo is not null then",
  "    insert into public.ceo_access (ceo_id, clinic_id, status) values (v_ceo, v_clinic, 'active')",
  "      on conflict (ceo_id, clinic_id) do update set status = excluded.status;",
  "  end if;",
  probe({ label: "C-ceo", id: nid(), ins: ["v_clinic", "null", "v_ceo"], want: ["null", "null"], opt: "v_ceo" }),
  "",
  "  -- ── A: актор (`request.jwt.claims`) ──",
  probe({ label: "A-admin-self-foreign", actor: "v_admin", id: nid(), ins: ["v_clinic2", "null", "v_admin"], want: ["null", "v_admin"] }),
  probe({ label: "A-radiologist-self", actor: "v_rad", id: nid(), ins: ["v_rad_clinic", "null", "v_rad"], want: ["null", "v_rad"], opt: "v_rad" }),
  grantOf("v_ref", "v_clinic", "pending_referrer"),
  probe({ label: "A-ref-self-pending", actor: "v_ref", id: nid(), ins: ["v_clinic", "v_ref", "v_ref"], want: ["null", "v_ref"] }),
  grantOf("v_ref", "v_clinic", "active"),
  optGrantOf("v_ref2", "v_ref2", "v_clinic", "active"),
  probe({ label: "A-L3-ref-colleague", actor: "v_ref", id: nid(), ins: ["v_clinic", "v_ref2", "v_ref"], want: ["null", "v_ref"], opt: "v_ref2" }),
  probe({ label: "A-L3-ref-self", actor: "v_ref", id: nid(), ins: ["v_clinic", "v_ref", "v_ref"], want: ["v_ref", "v_ref"] }),
  probe({ label: "A-L3-cb-staff", actor: "v_ref", id: nid(), ins: ["v_clinic", "v_ref", "v_admin"], want: ["v_ref", "null"] }),
  probe({ label: "A-L3-cb-colleague", actor: "v_ref", id: nid(), ins: ["v_clinic", "v_ref", "v_ref2"], want: ["v_ref", "null"], opt: "v_ref2" }),
  probe({ label: "A-staff-assigns-ref", actor: "v_admin", id: nid(), ins: ["v_clinic", "v_ref", "v_admin"], want: ["v_ref", "v_admin"] }),
  "",
  "  -- ── U: UPDATE — незмінний ключ не перевіряється (кожен окремо), зміна центру — обидва ──",
);
const U0 = 100, U4 = 101, U6 = 102;
PROBE_BLOCKS.push(
  probe({ label: "U-insert", id: U0, ins: ["v_clinic", "v_ref", "v_ref"], want: ["v_ref", "v_ref"] }),
  grantOf("v_ref", "v_clinic", "revoked"),
  probe({ label: "U-mention", id: U0, upd: "referrer_id = referrer_id, created_by = created_by", want: ["v_ref", "v_ref"] }),
  probe({ label: "U-cb-change-keeps-ref", id: U0, upd: "created_by = v_admin", want: ["v_ref", "v_admin"] }),
  probe({ label: "U-ref-to-nonref", id: U0, upd: "referrer_id = v_admin", want: ["null", "v_admin"] }),
  grantOf("v_ref", "v_clinic", "active"),
  probe({ label: "U-insert-2", id: U4, ins: ["v_clinic", "v_ref", "v_admin"], want: ["v_ref", "v_admin"] }),
  grantOf("v_ref", "v_clinic2", "revoked"),
  probe({ label: "U-clinic-move", id: U4, upd: "clinic_id = v_clinic2", want: ["null", "null"] }),
  grantOf("v_ref", "v_clinic2", "active"),
  probe({ label: "U-insert-3", id: U6, ins: ["v_clinic", "v_ref", "null"], want: ["v_ref", "null"] }),
  probe({ label: "U-clinic-move-granted", id: U6, upd: "clinic_id = v_clinic2", want: ["v_ref", "null"] }),
  "  perform set_config('request.jwt.claims', '{}', true);",
);
if (PID >= U0) throw new Error("ідентифікатори проб перетнулись");
const PROBES = PROBE_BLOCKS.join("\n");
const N_PROBES = PROBE_LABELS.length;
const N_OPT = [...PROBES.matchAll(/v_na := v_na \|\| '([^']+)'::text;/g)].length;

/** Під мутаціями — ЛИШЕ дослівні запити №17 і №19 (мілісекунди), а не повний
    сторож: замки мутацій (ACCESS EXCLUSIVE на `referrer_private`, SHARE ROW
    EXCLUSIVE на `doctors`, `services`, `patient_cases`) тримаються до кінця
    транзакції, а в `authenticated` statement_timeout 8 с (Low-1 ревʼю). */
const FALSIFY = [
  "-- 0203 FALSIFY — ЗГЕНЕРОВАНО `node scripts/build-0203-reprint.mjs`.",
  "-- Гард і піни мусять ЛОВИТИ, а не лише лягти. Транзакція СВІДОМО валиться в",
  "-- кінці. Предстан перевіряти ОКРЕМИМ запитом.",
  "-- ⚠️ ПЕРЕДУМОВА: 0203 у леджері, тіло/пін 0203, гард = текст генератора, №17",
  "--    зелена, гард — останній BEFORE-тригер рядка.",
  "-- ПОРЯДОК (Low-1 ревʼю): ПОВНИЙ сторож — ДО проб і мутацій (база для",
  "--    base_other_failed, ≈9 с без замків на таблиці); під мутаціями — лише",
  "--    дослівні запити №17 і №19 (мілісекунди).",
  `-- ПРОБИ ГАРДА (${N_PROBES}, з них ${N_OPT} необовʼязкові) — на ТИМЧАСОВІЙ таблиці, де висить лише`,
  "--    цей тригер; кожна читає ОБИДВА ключі після дії:",
  "--   R-<статус> / C-ref-<статус> (L1): referrer_id / created_by = направник із",
  "--     грантом у статусі active → ключ лишається; pending_referrer,",
  "--     pending_clinic, declined, revoked → NULL;",
  "--   R-other-clinic, C-ref-other-clinic: грант лише до ІНШОГО центру → NULL;",
  "--   R-not-referrer: не-направник з АКТИВНИМ грантом → NULL (роль);",
  "--   R-ghost, C-ghost: профілю немає → NULL;",
  "--   C-admin-own → лишається; C-admin-foreign: адмін ІНШОГО центру → NULL;",
  "--   C-registrar-own → лишається; C-radiologist (не актор) → NULL;",
  "--   C-ceo: CEO з активним доступом до центру → NULL (роль, не доступ);",
  "--   A-admin-self-foreign: актор = created_by у чужому центрі → лишається",
  "--     (гілка актора; без неї — як C-admin-foreign);",
  "--   A-radiologist-self: радіолог-актор = created_by → лишається;",
  "--   A-ref-self-pending: актор-направник без активного гранту —",
  "--     created_by (сам) лишається, referrer_id (сам) → NULL;",
  "--   A-L3-ref-colleague (L3): актор-направник ставить колегу в referrer_id → NULL;",
  "--   A-L3-ref-self → лишається; A-L3-cb-staff / A-L3-cb-colleague: актор-",
  "--     направник ставить у created_by адміна центру / колегу → NULL;",
  "--   A-staff-assigns-ref: адмін ставить направника з активним грантом → лишається;",
  "--   U-mention: незмінна згадка обох ключів (грант уже відкликано) → лишаються;",
  "--   U-cb-change-keeps-ref: змінено лише created_by → referrer_id без гранту НЕ",
  "--     перевіряється (кожен ключ окремо); U-ref-to-nonref → NULL;",
  "--   U-clinic-move: зміна центру → обидва наново → NULL;",
  "--   U-clinic-move-granted: зміна центру, грант до нового є → лишається.",
  "--   Необовʼязкові (немає другого направника / радіолога / реєстратора / CEO) → n/a",
  "--   у звіті; вердикт вимагає ok + n/a = усі проби і жодного промаху.",
  "-- МУТАЦІЇ СТОРОЖА:",
  "--   M1 drop trigger trg_audit_referrer_private → №17 `missing:`;",
  "--   M2 disable trigger trg_audit_doctors → №17 `trigger_off:…=D`;",
  "--   M3 аудит services без DELETE (create or replace trigger) → `wrong_def:`;",
  `--   M4 гард patient_cases знову зі списком колонок (UPDATE OF referrer_id) → \`wrong_def:\`;`,
  "--   B1 тіло гарда вихолощено (create or replace, та сама шапка) → №19 МУСИТЬ",
  `--      назвати рівно ${WANT19[0].slice(0, 42)}…;`,
  "--   B1b проба після вихолощення: ключ без доступу ЛИШАЄТЬСЯ — проби не вакуумні.",
  "-- ⚠️ БЛОКУВАННЯ — мілісекунди в кінці: referrer_private — ACCESS EXCLUSIVE",
  "--    (drop trigger); doctors, services, patient_cases — SHARE ROW EXCLUSIVE.",
  `-- ⚠️ base_other_failed СТРОГИЙ: у базовому прогоні поза ${KNOWN_RED.join(", ")} і ledger_md5`,
  "--    (до db:gate) червоним не сміє бути НІЩО, зокрема guard_triggers і",
  "--    guard_fn_bodies. Будь-яка інша червона — FAIL не від пакета: прочитати",
  "--    base_other_failed і повторити, а не «підправити» вердикт.",
  "set statement_timeout = '5min';",
  "do $falsify$",
  "declare",
  "  v_def text; v_body text; v_src text; v_head text; v_bad text[]; v_tmp text[]; v_atg text;",
  "  v_res jsonb; v_base_other text[]; v_off17 text[]; v_off19 text[]; v_missed text[]; v_extra text[];",
  "  v_ok text[] := '{}'; v_miss text[] := '{}'; v_na text[] := '{}'; v_msg text; v_r uuid; v_c uuid;",
  "  v_clinic uuid; v_clinic2 uuid; v_admin uuid; v_ref uuid; v_ref2 uuid;",
  "  v_rad uuid; v_rad_clinic uuid; v_reg uuid; v_reg_clinic uuid; v_ceo uuid; v_ghost uuid := gen_random_uuid();",
  "  v_b1b boolean := false; v_b19 boolean;",
  `  v_want_exact constant text[] := ${sqlArr(WANT17_EXACT)};`,
  `  v_want_prefix constant text[] := ${sqlArr(WANT17_PREFIX)};`,
  `  v_want19 constant text[] := ${sqlArr(WANT19)};`,
  "begin",
  PRE("0203-фальсифікація"),
  `  if not exists (select 1 from public.migration_ledger where name = '${DST_NAME}') then`,
  "    raise exception '0203-фальсифікація: 0203 не накатано — фальсифікувати нічого';",
  "  end if;",
  readGuard("0203-фальсифікація", NEW_MD5, NEW_LEN, PIN, "0203"),
  fnRow("0203-фальсифікація", "(передумова)"),
  Q17_ASSERT("0203-фальсифікація", "new", "(передумова)"),
  ZZ_LAST("0203-фальсифікація"),
  "",
  "  -- ── БАЗА: ПОВНИЙ сторож ДО проб і мутацій (≈9 с, замків на таблиці немає) ──",
  SENTINEL_CALL,
  `  if (v_res->>'checked')::int <> ${CHECKED} then`,
  `    raise exception '0203-фальсифікація: сторож перевірив % замість ${CHECKED}', v_res->>'checked';`,
  "  end if;",
  "  select array_agg(e.value->>'check' order by e.value->>'check') into v_base_other",
  "    from jsonb_array_elements(v_res->'failed') e",
  `   where e.value->>'check' not in (${[...KNOWN_RED, "ledger_md5"].map(lit).join(", ")});`,
  "",
  PROBES,
  "",
  "  -- ── M1–M4 + B1: мутації (замки — від цієї миті до кінця транзакції) ────────",
  "  drop trigger trg_audit_referrer_private on public.referrer_private;",
  "  alter table public.doctors disable trigger trg_audit_doctors;",
  "  " + M3_DDL,
  "  " + M4_DDL,
  "  execute $fxa$",
  B1_STMT,
  "$fxa$;",
  "  -- B1b: після вихолощення ключ без доступу мусить ЛИШИТИСЬ (інакше проби міряли не гард)",
  "  perform set_config('request.jwt.claims', '{}', true);",
  "  begin",
  "    insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (200, v_clinic, v_ghost, v_ghost);",
  "    select g.referrer_id is not distinct from v_ghost and g.created_by is not distinct from v_ghost",
  "      into v_b1b from falsify_0203_g g where g.id = 200;",
  "  exception when others then",
  "    v_b1b := false;",
  "  end;",
  "",
  "  -- ── №17 під мутаціями — дослівно з тіла 0203 ──",
  "  v_tmp := null;",
  Q17_NEW,
  "  select array_agg(o order by o collate \"C\") into v_off17 from unnest(v_tmp) o;",
  "  -- ── №19 під мутаціями — дослівно з тіла 0203 (разом з обробником помилки) ──",
  Q19_NEW.replace(/\n$/, ""),
  "  select array_agg(o order by o collate \"C\") into v_off19 from unnest(v_tmp) o;",
  "",
  "  select array_agg(w) into v_missed from (",
  "    select w from unnest(v_want_exact) w where not (w = any (coalesce(v_off17, '{}')))",
  "    union all",
  "    select w from unnest(v_want_prefix) w",
  "     where not exists (select 1 from unnest(coalesce(v_off17, '{}')) o where starts_with(o, w))",
  "  ) m;",
  "  select array_agg(o) into v_extra from (",
  "    select o from unnest(coalesce(v_off17, '{}')) o",
  "     where not (o = any (v_want_exact))",
  "       and not exists (select 1 from unnest(v_want_prefix) w where starts_with(o, w))",
  "  ) x;",
  "  -- B1: №19 мусить назвати РІВНО порожнє тіло гарда — не більше і не менше",
  "  v_b19 := v_off19 is not distinct from v_want19;",
  "",
  "  raise exception 'FALSIFY_0203_ROLLBACK verdict=% probes_ok=%/% probes_missed=% na=% n17=% missed=% extra=% b1_body19=% off19=% b1b_probe_sensitive=% base_other_failed=%',",
  `    case when cardinality(v_miss) = 0 and cardinality(v_ok) + cardinality(v_na) = ${N_PROBES}`,
  "              and v_missed is null and v_extra is null and v_base_other is null",
  "              and coalesce(array_length(v_off17, 1), 0) = 4 and v_b19 and v_b1b then 'PASS' else 'FAIL' end,",
  `    cardinality(v_ok), ${N_PROBES}, v_miss, v_na, coalesce(array_length(v_off17, 1), 0), v_missed, v_extra,`,
  "    v_b19, v_off19, v_b1b, v_base_other;",
  "end;",
  "$falsify$;",
  "",
  "-- ⚠️ ПІСЛЯ — окремим запитом, що прод не змінився:",
  "--      select public.invariants_check(false);   -- guard_triggers і guard_fn_bodies ВІДСУТНІ",
  "--      select count(*) from pg_proc where prosrc like '%falsify 0203%';   -- 0",
  `--      ${READBACK.split("\n")[0]} …   -- (повне читання назад — у 0203_apply.sql)`,
].join("\n");

// ---------------------------------------------------------------------------
// 9. ФАЙЛ МІГРАЦІЇ (канонічний, ІДЕМПОТЕНТНИЙ).
//    ⚠️ Шапка НЕ сміє містити фразу create-or-replace сторожа одним рядком:
//       `tests/privilegeSurface.test.ts` шукає її `indexOf` БЕЗ якоря. Асерт нижче.
// ---------------------------------------------------------------------------
const MIG_PRE = [
  "do $pre$",
  "declare v_src text; v_bad text[];",
  "begin",
  "  if current_user <> 'postgres' then",
  "    raise exception '0203: мусить іти від ролі postgres, а йде від %', current_user;",
  "  end if;",
  `  if not exists (select 1 from public.migration_ledger where name = '${PREV_LEDGER}') then`,
  "    raise exception '0203: у леджері немає 0202 — накат не в свою чергу';",
  "  end if;",
  "  if (select max(name) from public.migration_ledger) not in",
  `     ('${PREV_LEDGER}', '${DST_NAME}') then`,
  "    raise exception '0203: останній рядок леджера % — не 0202/0203, черга зсунулась',",
  "      (select max(name) from public.migration_ledger);",
  "  end if;",
  "  select replace(p.prosrc, chr(13), '') into v_src",
  "    from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  "   where n.nspname = 'public' and p.proname = 'invariants_check'",
  "     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';",
  `  if md5(v_src) not in ('${PRE_MD5}', '${NEW_MD5}') then`,
  "    raise exception '0203: тіло сторожа % — ні 0202, ні 0203; правка наосліп заборонена', md5(v_src);",
  "  end if;",
  "  -- ⚠️ `to_regprocedure`, а не `::regprocedure`: SQL не зобовʼязаний обчислювати",
  "  --    `and` зліва направо, а приведення константи падає ще на плануванні",
  "  --    (зловив локальний стенд: «function … does not exist» на першому накаті).",
  `  if to_regprocedure('public.${FN_SIG}') is not null`,
  `     and (select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = to_regprocedure('public.${FN_SIG}'))`,
  `         is distinct from '${FN_RAW_MD5}' then`,
  `    raise exception '0203: ${FN_SIG} уже є з ІНШИМ тілом — чиясь чернетка? спершу розібратись';`,
  "  end if;",
  PREMISES("0203").split("\n").slice(1).join("\n"),
  "end",
  "$pre$;",
].join("\n");

const MIG_CHK = [
  "do $chk$",
  "declare v_res jsonb; v_failed text[]; v_off17 text[];",
  "begin",
  SENTINEL_CALL,
  `  if (v_res->>'checked')::int <> ${CHECKED} then`,
  `    raise exception '0203: сторож перевірив % замість ${CHECKED}', v_res->>'checked';`,
  "  end if;",
  "  -- ідемпотентно: ledger_md5 допустима лише з offender-ом самої 0203 (повторний прогін до db:gate)",
  "  select array_agg(e.value->>'check' order by e.value->>'check') into v_failed",
  "    from jsonb_array_elements(v_res->'failed') e",
  `   where e.value->>'check' not in ${KNOWN_RED_SQL}`,
  "     and not (e.value->>'check' = 'ledger_md5'",
  `              and e.value->'offenders' = jsonb_build_array('${DST_NAME}'));`,
  "  if v_failed is not null then",
  "    raise exception '0203: до DDL сторож червоний не від пакета: % — %', v_failed, v_res->'failed';",
  "  end if;",
  "  select array_agg(o.value order by o.value collate \"C\") into v_off17",
  "    from jsonb_array_elements(v_res->'failed') e,",
  "         jsonb_array_elements_text(e.value->'offenders') o",
  "   where e.value->>'check' = 'guard_triggers';",
  `  if v_off17 is not null and v_off17 is distinct from ${sqlArr(WANT_MISSING)} then`,
  "    raise exception '0203: №17 до DDL назвав не рівно сім відсутніх пар пакета: %', v_off17;",
  "  end if;",
  "end",
  "$chk$;",
].join("\n");

/* ⚠️ ПОСТ-АСЕРТ ФАЙЛУ — БЕЗ КОПІЙ ТЕКСТУ ТІЛА СТОРОЖА. Стенди мутують ФАЙЛ
   останнього передруку і вимагають, щоб кожен якір траплявся в ньому РІВНО
   раз; дослівна копія запиту №17 чи виразу `cur` №19 тут задвоїла б їхні якорі
   (ревізія 24.09: falsify-0181 — сім, falsify-0182 — один). Тому у файлі:
     • №17 після DDL — запит САМОГО сторожа, вирізаний із ЖИВОГО тіла за тими ж
       межами Q17_START/Q17_END і виконаний як є (мілісекунди; повний прогін під
       замками на таблиці — ні, урок 0196). Межі зібрано через chr(10), md5
       вирізаного запиту звірено з генератором — зсув на символ не пройде мовчки;
     • гард — прямі атрибути і сирий md5 prosrc (строгіше за рецепт №19);
     • порядок BEFORE-тригерів — той самий асерт, що в накаті.
   Фрагменти стенди не чіпають — там дослівні копії лишаються. */
const sqlJoinLines = (s) => s.split("\n").map((x) => lit(x)).join(" || chr(10) || ").replace(/^'' \|\| /, "");
/* Початок — без хвоста « is null»: повний третій рядок унікальний у тілі, і його
   копія в літералі стала б другим входженням (сітка унікальних рядків нижче). */
const Q17_START_SQL = Q17_START.slice(0, -" is null".length);
if (!Q17_START.endsWith(" is null") || count(NEW_BODY, Q17_START_SQL) !== 1 || NEW_BODY.indexOf(Q17_START_SQL) !== NEW_BODY.indexOf(Q17_START)) {
  throw new Error("межа початку запиту №17 для SQL не унікальна або зсунута");
}
const Q17_SEL_INTO = "select array_agg(x.txt order by x.txt) into v_tmp";
const Q17_SEL = "select array_agg(x.txt order by x.txt)";
if (count(Q17_NEW, Q17_SEL_INTO) !== 1) throw new Error("запит №17: `into v_tmp` не рівно один");
const Q17_DYN = Q17_NEW.replace(/;$/, "").replace(Q17_SEL_INTO, Q17_SEL);
if (Q17_DYN === Q17_NEW || /\binto\b/.test(Q17_DYN)) throw new Error("запит №17 для execute: `into` лишився");
const Q17_DYN_MD5 = md5(Q17_DYN);
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
  "    raise exception '0203: тіло сторожа або самопін не ті: % / %', md5(v_src), length(v_src);",
  "  end if;",
  "  -- ── №17 після DDL: запит САМОГО сторожа, вирізаний із ЖИВОГО тіла і виконаний",
  "  --    як є. Копії тексту тут немає свідомо: стенди мутують файл останнього",
  "  --    передруку і вимагають унікальності якорів ──",
  `  v_a := strpos(v_src, ${sqlJoinLines(Q17_START_SQL)});`,
  `  v_b := strpos(v_src, ${sqlJoinLines(Q17_END)});`,
  "  if v_a = 0 or v_b <= v_a then",
  "    raise exception '0203: межі запиту №17 у живому тілі не знайдено (% / %)', v_a, v_b;",
  "  end if;",
  `  v_q := replace(substr(v_src, v_a, v_b - v_a) || chr(10) || ${lit("    ) x")},`,
  `                 ${lit(Q17_SEL_INTO)}, ${lit(Q17_SEL)});`,
  `  if md5(v_q) is distinct from '${Q17_DYN_MD5}' then`,
  "    raise exception '0203: вирізаний запит №17 не той (md5 %) — межі зсунулись', md5(v_q);",
  "  end if;",
  "  execute v_q into v_tmp;",
  "  if v_tmp is not null then",
  "    raise exception '0203: №17 після DDL червоний: %', v_tmp;",
  "  end if;",
  ZZ_LAST("0203"),
  "  -- ── Гард після створення: атрибути і сирий md5 тіла (рецепт №19 — у фрагментах) ──",
  "  if not exists (",
  "    select 1 from pg_proc p join pg_language l on l.oid = p.prolang",
  `     where p.oid = 'public.${FN_SIG}'::regprocedure`,
  "       and p.prosecdef and p.provolatile = 'v' and p.prorettype = 'trigger'::regtype",
  "       and pg_get_userbyid(p.proowner) = 'postgres' and l.lanname = 'plpgsql'",
  "       and p.proconfig = array['search_path=public, pg_temp']",
  `       and md5(replace(p.prosrc, chr(13), '')) = '${FN_RAW_MD5}'`,
  "  ) then",
  `    raise exception '0203: ${FN_SIG} після створення не той (атрибути або сирий md5 тіла)';`,
  "  end if;",
  fnAclAssert("0203"),
  "end",
  "$post$;",
].join("\n");
/* атрибути в пост-асерті файлу = FN_ATTRS (рецепт №19), лише іншою формою */
if (!FN_ATTRS.startsWith("secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=")) {
  throw new Error("FN_ATTRS розійшовся з прямими атрибутами пост-асерту файлу");
}

const MIG_HEAD = [
  "-- ============================================================================",
  "--  RadFlow — Міграція 0203: аудит-слід на чотирьох таблицях (Р2, варіант б) і",
  "--  гард ключів читання запису `referrer_id` / `created_by` (Н-9, Р-1, Р-2);",
  "--  передрук сторожа (+7 пар у №17, +1 рядок у №19).",
  "--",
  "--  Максимальна ЗАСТОСОВАНА на момент написання — 0202.",
  `--  \`checked\` ${CHECKED} -> ${CHECKED}. Список №17: 23 -> 30; №19: 59 -> 60 (\`${FN_SIG}\`).`,
  "--  №22 / №23 / №26 — без змін (генератор доводить: код тіла без коментарів",
  "--  відрізняється від 0202 рівно вісьмома новими рядками — сім у №17, один у",
  "--  №19 — і комою в колишньому останньому рядку №17). Даних не змінює.",
  "--",
  "--  ЗВІДКИ ПАКЕТ — рішення власника 24.09 і 25.09.2026 (с79):",
  "--   1. Р2(б), критерій «ПІІ АБО невідновна правка». Аудит `fn_audit()` висів на",
  "--      шести таблицях; без нього лишались `patient_cases` (повна картка",
  "--      пацієнта), `doctors`, `referrer_private` — і прайс `services`, заради",
  "--      якого правило й приймалось (RF-03: 26.08 за одну мілісекунду змінились",
  "--      37 позицій, відновити було нічим). Тіло `fn_audit` НЕ чіпаємо (пін №19).",
  "--   2. Н-9 (знахідка с77) і Р-1 (ревʼю 0203). У запису ДВА ключі читання:",
  "--      `queue_select` / `waitlist_select` пускають `… or created_by = uid or",
  "--      referrer_id = uid`, `cases_select_referrer` — те саме, і жодна не питає",
  "--      ні гранту, ні центру, ні кабінету. Політики запису персоналу значень",
  "--      ключів не обмежують (направнику — лише «один із двох — я»): персонал",
  "--      міг виставити БУДЬ-ЯКИЙ профіль (направника без гранту, адміна іншого",
  "--      центру, радіолога повз його кабінети), направник — колегу, і той",
  "--      профіль починав ЧИТАТИ ПДн.",
  "--   3. Р-2: гард НЕ відмовляє — ключ без законного доступу до центру запису",
  "--      він ставить у NULL; `doctor` не чіпає. Слід (L-a ревʼю р3) — `raise",
  "--      warning` READ_KEY_CLEARED (таблиця, ключ, роль актора; без uuid і ПДн)",
  "--      у лог сервера: запису не перериває, клієнтам через PostgREST не видно.",
  "--  Лікування — BEFORE-тригер `zz_guard_read_keys` (`guard_record_read_keys()`,",
  "--  SECURITY DEFINER, EXECUTE лише службовій ролі) на `queue_entries`,",
  "--  `waitlist_entries`, `patient_cases` — БЕЗ списку колонок і ОСТАННІЙ серед",
  "--  BEFORE-тригерів рядка (імʼя `zz_`, асерт у накаті), тобто бачить",
  "--  остаточні значення ключів.",
  "--",
  "--  ПРАВИЛО (тіло функції нижче):",
  "--     • `referrer_id` — NULL або направник з АКТИВНИМ грантом до центру",
  "--       запису; актор-направник — лише NULL або сам (L3 ревʼю);",
  "--     • `created_by` — NULL; сам актор; адмін/реєстратор цього центру;",
  "--       направник з активним грантом до нього. Радіолог — лише як актор.",
  "--       Актор-направник — лише NULL або сам (розширення L3 на другий ключ);",
  "--     • інакше ключ стає NULL. UPDATE: незмінний ключ при незмінному центрі",
  "--       не перевіряється (кожен окремо); зміна центру — обидва наново;",
  "--       службова роль — ті самі правила без гілки актора.",
  "--",
  "--  ⚠️ ЦІНА І НАСЛІДКИ, названі заздалегідь:",
  "--     • `fn_audit` пише ПОВНИЙ знімок рядка: картка пацієнта з `patient_cases`",
  "--       тепер копіюється в `audit_log` (знеособлення — через 90 днів,",
  "--       видалення — через 365, ретенція 0149/0152, ліміт 5000 рядків на прогін;",
  "--       імпорт прайсу на сотні позицій = сотні рядків журналу за раз).",
  "--       Читати їх може адмін свого центру (`audit_read_admin`) — він і так",
  "--       бачить ці таблиці.",
  "--     • `referrer_private` не має `id` і `clinic_id` → у журналі `row_id` і",
  "--       `clinic_id` NULL. Такий рядок бачить лише службова роль — приватна",
  "--       пошта направника адміну центру НЕ відкривається (саме так і треба).",
  "--     • Успадкування ключа (крок кейса, кейс із запису, запис із листа",
  "--       очікування) — не глухий кут: рядок лягає, ключ без доступу — NULL,",
  "--       `doctor` лишається.",
  "--     • Відновлення рядків із before-образів `audit_log` теж іде крізь гард:",
  "--       ключі без законного доступу стануть NULL. Точний before-образ — лише з",
  "--       `alter table … disable trigger zz_guard_read_keys` у ТІЙ САМІЙ",
  "--       транзакції і `enable` після (№17 ловить `trigger_off:`, якщо забути).",
  "--     • Застосунок не змінюється: відмови немає, класифікувати нічого. Журнал",
  "--       дій (`important_events`) застосунок пише з ВХІДНИХ даних — подія",
  "--       може назвати направника, якого гард зняв (читають лише адмін і CEO",
  "--       центру; ПДн там немає).",
  "--     • Тіло `guard_record_read_keys()` пінить №19 (59 → 60; рішення",
  "--       оркестратора 24.09 за постановкою Н-9 «міграція + передрук №17/№19»):",
  "--       будь-яка правка функції — тіло, `grant`/`revoke`, `alter function` —",
  "--       лише разом із передруком сторожа (ритуал №19, AGENTS.md).",
  "--       Фальсифікація 0203 вихолощує тіло і ВИМАГАЄ від №19 `body:`.",
  "--",
  "--  ⚠️ МЕЖІ, НАЗВАНІ І ПОКАЗАНІ:",
  "--     • наявні рядки гард не переписує: ключ, виставлений до 0203 (або грант",
  "--       відкликано ПІСЛЯ), читання не забирає, доки ключ і центр не змінюють —",
  "--       політики читання не змінено (друга половина Н-9, окреме рішення);",
  "--     • кабінет (`room_ids` гранту) гард не перевіряє — лише центр;",
  "--     • порядок спрацювання (гард — останній BEFORE-тригер рядка) сторож не",
  "--       пінить: його тримають асерт накату і статичний тест пакета;",
  "--     • список №17 ІМЕННИЙ: нова таблиця з ПІБ без аудит-тригера невидима —",
  "--       гілки «за властивістю» (с68) цей пакет не додає.",
  "--",
  "--  ⚠️ ⚠️ ЦЕЙ ФАЙЛ НЕ НАКАТУВАТИ — ні вставкою в SQL Editor, ні MCP",
  "--     `apply_migration`, ні `supabase db push`: він ідемпотентний і канонічний,",
  "--     а накат має СУВОРИЙ предстан і один блок. Шлях один —",
  "--     `scripts/frag/0203_apply.sql`, весь одним запитом.",
  "--",
  "--  ПОРЯДОК:",
  "--   0. Дерево чисте; `node scripts/build-0203-reprint.mjs` → `git diff --exit-code`;",
  "--      `npx vitest run`, `npx tsc --noEmit`; ревізія стендів. Усе — ДО проду.",
  "--   1. `scripts/frag/0203_dryrun.sql` цілком (перший стейтмент — `set",
  "--      statement_timeout`, другий — `do` з тегом `dryrun`) →",
  `--      DRYRUN_0203_ROLLBACK з checked=${CHECKED}, ok17=true, zz_last=true, failed_before_ddl`,
  `--      = лише ${KNOWN_RED.join(", ")} і guard_triggers із сімома \`missing:\`.`,
  "--      orphans_ref(q/w/c) і orphans_cb — ЗАМІР, а не умова зупинки (24.09:",
  "--      orphans_ref 2/0/0): інше число — переглянути абзац ціни, не стоп.",
  "--   2. `scripts/frag/0203_apply.sql` — ОДРАЗУ після сухого прогону. Читання назад:",
  `--      guard_md5 = ${NEW_MD5}, guard_len = ${NEW_LEN}, ledger_rows = 203,`,
  "--      new_triggers = 7, zz_last_tables = 3, guard_fn = true. Помилка = НІЧОГО",
  "--      не закомічено. Таймаут клієнта = не повторювати наосліп: спершу select",
  "--      читання назад.",
  "--      ⚠️ ЧЕРВОНЕ ВІКНО: з цього commit і до пушу `main` з файлом 0203 падає",
  "--      КОЖНА прод-збірка (гейт: рядок леджера без файла). Жодного Redeploy,",
  "--      нічого іншого в `main`; кроки 3–7 — одним заходом. Ліміт 03:50 UTC",
  "--      (06:50 Київ) — на ВЕСЬ відрізок «накат → db:gate».",
  `--   3. ОКРЕМИМ запитом \`select public.invariants_check(false);\` — checked ${CHECKED},`,
  `--      failed ⊆ {${KNOWN_RED.join(", ")}, ledger_md5}.`,
  "--   4. Смоук `supabase/smoke/audit_pii_referrer_grant_smoke.sql` → `SMOKE_OK …`.",
  `--   5. \`scripts/frag/0203_falsify.sql\` → verdict=PASS (probes_ok+na = ${N_PROBES}, n17=4,`,
  "--      b1_body19=t, b1b_probe_sensitive=t). Після — окремим запитом №17 і №19 зелені.",
  "--   6. `npm run db:gate` (ЛИШЕ з машини власника) → `invariants_check`: failed лише",
  `--      ${KNOWN_RED.join(", ")} (або порожньо).`,
  "--   7. git ОДНИМ заходом: гілка → dev → main → push → штамп деплою; вікно",
  "--      закрите, коли `npm run db:gate:check` зелений на `main` І на `dev`. Не",
  "--      закрили 6–7 у цей захід — `scripts/frag/0203_rollback.sql`, а не",
  "--      «доробимо завтра».",
  "--   8. ⚠️ ПІСЛЯ КРОКУ 6 генератор НЕ ЗАПУСКАТИ (перезаписує файл із md5 у леджері).",
  "-- ============================================================================",
  "",
  "begin;",
  "",
  "-- ── 0. Предстан (ідемпотентний: 0202 або вже 0203) ─────────────────────────",
  MIG_PRE,
  "",
  "-- ── 1. Гард-функція (Н-9, Р-1, Р-2) і її ACL — пастка 0122: лише службова роль",
  FN_STMT,
  "",
  FN_ACL_DDL,
  "",
  "-- ── 2. Передрук сторожа: +7 пар у №17, рядок гарда в №19, проза ─────────────",
  "",
].join("\n");

const MIG_TAIL = [
  "",
  `comment on function public.invariants_check(boolean) is '${PIN}';`,
  "",
  "-- ── 3. ПОВНИЙ сторож ДО DDL на таблицях (≈9 с без замків на таблиці; урок 0196) ─",
  MIG_CHK,
  "",
  "-- ── 4. Сім тригерів: чотири аудит-сліди (Р2(б)) і три гарди ключів читання ──",
  TRIGGERS_DDL,
  "",
  "-- ── 5. Пост-асерти: №17 запитом із живого тіла, порядок BEFORE-тригерів, гард",
  "--       атрибутами, ACL, пін ──",
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
  "--  1. База: `scripts/frag/0203_rollback.sql` — знімає сім тригерів і",
  `--     \`${FN_SIG}\`, тіло сторожа до 0202 (${PRE_MD5} / ${PRE_LEN}),`,
  "--     самопін 0202, рядок леджера. Рядки, які аудит-тригери вже записали в",
  "--     `audit_log`, лишаються (журнал; їх обробить ретенція); ключі, які гард",
  "--     уже поставив у NULL, відкат не повертає. Перевіряти ОКРЕМИМ запитом",
  "--     після commit.",
  "--  2. Git — ОДНИМ кроком: видалити цей файл, `scripts/frag/0203_*.sql`,",
  "--     `scripts/build-0203-reprint.mjs`, `tests/auditPiiReferrerGrant.test.ts`,",
  "--     `supabase/smoke/audit_pii_referrer_grant_smoke.sql`; повернути",
  "--     `tests/guardTriggersInvariant.test.ts` (GUARDS 30 → 23), `PINNED` у",
  `--     \`tests/guardFnBodiesInvariant.test.ts\` (60 → 59, без \`${FN_SIG}\`),`,
  "--     лічильник №19 у `tests/tzKyivPhase2.test.ts` (60 → 59) і рядок про",
  "--     відновлення з before-образів у `AGENTS.md` («Миграции и БД»).",
  "--     Нового стенда пакет НЕ заводить — фальсифікація разова, протокол у",
  "--     `docs/audit/PR-0203-audit-pii-referrer-grant.md`.",
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
  for (const t of ["$apply$", "$dryrun$", "$back$", "$falsify$", "$fxa$", "$fxb$", "$p$"]) {
    if (MIG.includes(t)) throw new Error(`ФАЙЛ містить тег фрагмента ${t}`);
  }
  /* ⚠️ Самореєстрація — ОСТАННІЙ statement перед `commit;` (канон 0143). */
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
  // ⚠️ фрагменти: тег блоку — другий стейтмент після шапки коментарів
  for (const [fr, tag] of [[APPLY, "$apply$"], [DRYRUN, "$dryrun$"], [ROLLBACK, "$back$"], [FALSIFY, "$falsify$"]]) {
    const stmts = fr.split("\n").filter((l) => l.trim() && !l.startsWith("--"));
    if (stmts[0] !== "set statement_timeout = '5min';" || stmts[1] !== `do ${tag}`) {
      throw new Error(`фрагмент ${tag}: перші стейтменти «${stmts[0]}», «${stmts[1]}»`);
    }
    if (count(fr, tag) !== 2) throw new Error(`фрагмент ${tag}: тег не двічі`);
  }
  const fnInExec = FN_STMT.replace(/;\s*$/, "");   // у фрагменті statement іде в `execute $fxa$ … $fxa$`
  if (count(APPLY, fnInExec) !== 1 || count(DRYRUN, fnInExec) !== 1 || count(MIG, FN_STMT) !== 1) {
    throw new Error("текст гарда не рівно раз у файлі/накаті/сухому прогоні");
  }
  if (count(APPLY, indent(TRIGGERS_DDL)) !== 1 || count(DRYRUN, indent(TRIGGERS_DDL)) !== 1) throw new Error("DDL тригерів у накаті/сухому прогоні не раз");
  if (count(MIG, TRIGGERS_DDL) !== 1) throw new Error("DDL тригерів у файлі не раз");
  if (count(APPLY, indent(FN_ACL_DDL)) !== 1 || count(DRYRUN, indent(FN_ACL_DDL)) !== 1 || count(MIG, FN_ACL_DDL) !== 1) {
    throw new Error("revoke/grant гарда не рівно раз у файлі/накаті/сухому прогоні");
  }
  /* ⚠️ ЯКОРІ СТЕНДІВ У ФАЙЛІ. Стенди мутують ФАЙЛ останнього передруку цілком і
     вимагають унікальності якоря — тож кожен літерал стенда, що живе в тілі,
     мусить траплятися у файлі рівно стільки разів, скільки в тілі. Друга,
     ширша сітка — для стендів, яких ще немає: жоден УНІКАЛЬНИЙ у тілі рядок
     (≥ 24 знаки без відступу) не має копії поза тілом. */
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
     0196 (замки). Шукаємо в КОДІ (Low-2 ревʼю): перше входження назви в шапці-
     коментарі нічого не доводить. */
  for (const [fr, lbl] of [[APPLY, "накат"], [DRYRUN, "сухий прогін"], [MIG, "файл"], [FALSIFY, "фальсифікація"]]) {
    const code = codeOf(fr);
    const call = code.indexOf(SENTINEL_CALL);
    const ddl = Math.min(...["create trigger trg_audit_", `create trigger ${TG}`, "drop trigger trg_audit_", "create or replace trigger "]
      .map((x) => code.indexOf(x)).filter((i) => i >= 0));
    if (count(code, SENTINEL_CALL) !== 1) throw new Error(`${lbl}: повний сторож у коді не рівно раз`);
    if (call < 0 || !Number.isFinite(ddl) || call > ddl) throw new Error(`${lbl}: повний сторож не ПЕРЕД DDL тригерів`);
    if (/invariants_check\s*\((true|false)?\)/.test(code.slice(ddl))) throw new Error(`${lbl}: виклик сторожа ПІСЛЯ DDL — під замками`);
  }
  /* Замір сухого прогону — ДО DDL (Low-4). */
  {
    const code = codeOf(DRYRUN);
    if (!(code.indexOf("into v_oq, v_ow, v_oc") < code.indexOf("create trigger ") && code.indexOf("into v_ocb") < code.indexOf("create trigger "))) {
      throw new Error("сухий прогін: замір orphans не ДО DDL");
    }
  }
  /* Фальсифікація: проби ДО мутацій, база ДО проб, №17/№19 дослівно ПІСЛЯ мутацій. */
  {
    const iBase = FALSIFY.indexOf(SENTINEL_CALL);
    const iProbe = FALSIFY.indexOf("create temp table falsify_0203_g");
    const iMut = FALSIFY.indexOf("drop trigger trg_audit_referrer_private on public.referrer_private;");
    const iQ17 = FALSIFY.lastIndexOf(Q17_NEW);
    const iQ19 = FALSIFY.lastIndexOf(Q19_NEW.replace(/\n$/, ""));
    if (!(iBase > 0 && iBase < iProbe && iProbe < iMut && iMut < iQ17 && iQ17 < iQ19)) throw new Error("фальсифікація: порядок база → проби → мутації → №17 → №19 порушено");
  }
}

if (existsSync(DST_MIG)) {
  const old = readFileSync(DST_MIG, "utf8").replace(/\r/g, "");
  if (old !== MIG && !FORCE) {
    throw new Error(`${DST_MIG} уже є і його зміст ІНШИЙ. Якщо md5 файла вже в леджері — перезапис = дрейф = червона збірка. Свідомо: --force`);
  }
}
writeFileSync(DST_MIG, MIG);
writeFileSync("scripts/frag/0203_apply.sql", APPLY + "\n");
writeFileSync("scripts/frag/0203_dryrun.sql", DRYRUN + "\n");
writeFileSync("scripts/frag/0203_rollback.sql", ROLLBACK + "\n");
writeFileSync("scripts/frag/0203_falsify.sql", FALSIFY + "\n");

{
  const back = split(DST_MIG);
  if (md5(back.body) !== NEW_MD5 || back.body.length !== NEW_LEN) {
    throw new Error(`ЗАПИСАНИЙ ФАЙЛ дає ${md5(back.body)} / ${back.body.length}, а зібрано ${NEW_MD5} / ${NEW_LEN}`);
  }
  if (back.prologue !== SRC.prologue) throw new Error("DDL сторожа у записаному файлі розʼїхався з 0202");
}

console.log("0203 зібрано.");
console.log(`  сторож:   ${PRE_MD5} / ${PRE_LEN}  ->  ${NEW_MD5} / ${NEW_LEN}`);
console.log(`  checked:  ${CHECKED};  №17: ${OLD17.length} -> ${NEW17.length};  №19: ${(list19(SRC.body).match(SIG19_RE) || []).length} -> ${(list19(NEW_BODY).match(SIG19_RE) || []).length} (+ ${FN_SIG} між guard_radiologist_scope() і guard_referrer_doctor())`);
console.log(`  гард:     ${FN_SIG} raw md5 ${FN_RAW_MD5}, №19-рецепт ${FN_NORM_MD5}`);
console.log(`  пін:      ${PIN}`);
console.log(`  фальсифікація: проб ${N_PROBES} (необовʼязкових ${N_OPT}); B1 → ${WANT19[0]}`);
console.log(`  пар підстановки: ${PAIRS.length}; змістових перевірок: ${CHECKS.length}; зворотний хід -> 0202`);
for (const [t, tg, def] of NEW_TRIGGERS) console.log(`  №17 + ${t}/${tg}: ${def}`);
console.log(`  файли: ${DST_MIG}, scripts/frag/0203_{apply,dryrun,rollback,falsify}.sql`);
