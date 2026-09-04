/* Адресна фальсифікація пакета привілеїв (0166 + 0167).
   Протокол той самий, що у falsify-u33/u13/u37: `.vt.json` чиститься перед
   кожним прогоном, «звіту немає» — окремий статус ПОМИЛКА, звіряється ІМʼЯ
   тесту, а не сам факт червоного.

   ⚠️ Тут є новий вид мутації — ПОЗИТИВНИЙ КОНТРОЛЬ (`GREEN`). Сторож пінів
      навмисне навчений кільком легальним формам (`is distinct from`, `<>`,
      `!=`), і мутація, що переписує пін з однієї легальної форми в іншу,
      МУСИТЬ лишитись зеленою. Без такої мутації «розширив регексп» довелось
      би приймати на слово: сторож, який червоніє на будь-яку зміну, не
      відрізняє поломки від переписування.

   Запуск: node scripts/falsify-0166.mjs   (звіт → falsify-0166.md) */
import { readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";

const MIG  = "supabase/migrations/0166_privilege_surface.sql";
const HARD = "supabase/migrations/0167_privilege_surface_hardening.sql";

/* ⚠️ ЖИВИЙ ПЕРЕДРУК, А НЕ ПРИБИТИЙ ФАЙЛ (с55, ревізія після 0170).
   Позиції N15–N24 стріляють у ТІЛО `invariants_check`, а обидва спеки-сторожі
   читають не 0167, а ОСТАННЮ за іменем міграцію, що його передруковує
   (`guardSrc()` в unreadChanges, `checksInLatestReprint()` в
   invariantsCheckedPins). Поки 0167 і був останнім, це не мало значення.
   0170 передрукував сторожа (16-та перевірка policy_digest) — і всі десять
   мутацій почали правити файл, якого сторож НЕ ЧИТАЄ: ревізія дала десять
   «сторож дивиться не туди». Це ДОСЛІВНО той самий дефект, який у с51 уже
   знайшли і полагодили у `falsify-u37` (шість мертвих позицій, коментар там
   закінчується словами «наступна ж міграція, що передрукує сторожа, знову
   зробить стенд сліпим — мовчки»). Так і сталось — у сусідньому стенді.
   Правило одне на всі три місця: якір на початок рядка + терміналізатор.
   `HARD` лишається для N08–N14: вони стріляють у власний вміст 0167
   (розтяжки, спільна функція «це клієнт?»), а не в передрук. */
function latestReprint() {
  const dir = "supabase/migrations";
  let best = "";
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const txt = readFileSync(`${dir}/${f}`, "utf8");
    const at = txt.search(/^create or replace function public\.invariants_check/m);
    if (at < 0) continue;
    if (txt.indexOf("\n$function$;", at) < 0) continue;
    best = dir + "/" + f;
  }
  if (!best) { console.error("НЕ ЗНАЙДЕНО жодного передруку invariants_check"); process.exit(2); }
  return best;
}
const REPRINT = latestReprint();
/* Число перевірок — з ТОГО САМОГО передруку, а не константа: інакше піни
   N32–N37 протухають при кожному наступному передруку (с55: шість «якір не
   знайдено» рівно з цієї причини). */
const CHECKS = (() => {
  const txt = readFileSync(REPRINT, "utf8");
  const at = txt.search(/^create or replace function public\.invariants_check/m);
  const body = txt.slice(at, txt.indexOf("\n$function$;", at));
  return (body.match(/v_n := v_n \+ 1;/g) || []).length;
})();
const SMK  = "supabase/smoke/privilege_surface_smoke.sql";
const CMP  = "supabase/smoke/change_markers_purge_smoke.sql";
const RBS  = "supabase/smoke/room_busy_slots_scope_smoke.sql";
const GCAL = "supabase/smoke/gcal_pg_cron_smoke.sql";
/* ⚠️ ЯКІР N35 БЕРЕТЬСЯ З ФАЙЛУ, А НЕ ПЕРЕДБАЧАЄТЬСЯ. Історія в два кроки:
   у с56 він був прибитий до `(0170)`, хоч 18 прийшло з 0171 — атрибуція вже
   брехала, і стенд ЗАОХОЧУВАВ тримати брехню (чесна правка ламала якір,
   замір 1 → 0). Пакет 20 зробив номер самооновлюваним із передруку — і 0173
   миттєво показав, що цього мало: провенанс у СМОУЦІ лишався ручним, стенд
   чекав `(0173)`, файл казав `(0172)`, позиція дала «ЯКІР НЕ ЗНАЙДЕНО».
   Передбачати текст чужого файлу — та сама рот, лише на крок далі. Тому
   рядок ЗНАХОДИТЬСЯ регекспом, а мутація псує в ньому саме ЧИСЛО. */
const RBS_J_LINE = (() => {
  const m = readFileSync(RBS, "utf8")
    .match(/^--   \(j\) invariants_check\(false\): checked = \d+ \([^)]*\)/m);
  if (!m) {
    console.error("⛔ ІНВЕНТАР БРЕШЕ: рядка (j) у шапці room_busy_slots_scope_smoke немає. Стенд НЕ прогнано.");
    process.exit(1);
  }
  return m[0];
})();

const LIB  = "lib/incidents.ts";           // сюди підсаджуємо «застосунок видаляє простій»

const GREEN = Symbol("мутація мусить лишитись зеленою");

/* ── очікувані імена (звірені з реальними назвами it(), не з памʼяті) ────── */
const E = {
  truncate:  (t) => new RegExp(`знімає TRUNCATE на ${t} у ОБОХ клієнтських ролей`),
  defacl:    /міняє DEFAULT-привілеї/,
  incdel:    /знімає DELETE на incidents і розбиває політику ALL/,
  srv:       /НЕ чіпає службову роль/,
  grantor:   /гілка default_acl звужена до грантора postgres/,
  rollback:  /має секцію відкату в КІНЦІ/,
  ledger:    /самореєструється в леджері/,
  pred:      /не накотиться поперед свого попередника/,
  isclient:  /спільна відповідь «це клієнт\?»/,
  tripwire:  (f) => new RegExp(`розтяжка ${f} питає спільну функцію`),
  canon8:    /канон 8 знає і таблицю, і всі три функції/,
  privdrift: /priv_drift не зникла з живого сторожа/,
  prevchk:   /не загублено жодної попередньої перевірки/,
  roles:     /ролі в priv_drift беруться з членства authenticator/,
  relkind:   /гілка \(a\) бачить і foreign table/,
  branchB:   /гілка \(b\) ловить default-ACL без `in schema` і грант на PUBLIC/,
  regclass:  /зникла таблиця дає offender, а не вбиває всю функцію/,
  branchD:   /гілка \(d\) звужена до PERMISSIVE і клієнтських ролей/,
  branchE:   /гілка \(e\) стереже САМУ розтяжку/,
  catalog:   /перевіряє TRUNCATE по КАТАЛОГУ, а не за списком/,
  negctl:    /має ЧОТИРИ негативні контролі/,
  noskip:    /немає skip: без фікстури смоук ПАДАЄ/,
  bothbars:  /розтяжку перевіряє з ПОВЕРНЕНИМИ грантом І політикою/,
  platform:  /фіксує межу платформи видимо/,
  smokeok:   /завершується SMOKE_OK через exception/,
  pins:      /кожен пін у смоуках дорівнює цьому числу/,
  pinform:   /кожен смоук, що читає ключ 'checked', має асерт у формі/,
  del1:      /жодного \.delete\(\) по incidents \(канал 1/,
  del2:      /жодного \.delete\(\) по incidents \(канал 2/,
  /* 0174 — «сторож не падає мовчки». Імена звірені з `it()`, не з памʼяті. */
  wrapAll:    /має свою обгортку/,
  handlers20: /обробників рівно двадцять/,
  counterOut: /лічильник лишається ЗЗОВНІ обгортки/,
  ownName:    (l) => new RegExp(`обробник перевірки ${l} називає САМЕ її`),
  diagnosis:  /обробник несе SQLSTATE і текст/,
  stripBack:  /зняття рядків обгортки лишає ТІЛЬКИ код перевірок/,
};

const M = [];

/* ── 0166: DDL привілеїв ─────────────────────────────────────────────────── */
M.push(
  ["N01 забули зняти TRUNCATE на rooms", MIG, E.truncate("rooms"),
   "revoke truncate on public.rooms                    from anon, authenticated;\n", ""],
  ["N02 default-ACL не чіпають — revoke живе до першої нової таблиці", MIG, E.defacl,
   "alter default privileges for role postgres in schema public\n  revoke truncate on tables from anon, authenticated;", ""],
  ["N03 DELETE на простоях лишили", MIG, E.incdel,
   "revoke delete on public.incidents from anon, authenticated;", ""],
  ["N04 зачепили службову роль", MIG, E.srv,
   "revoke delete on public.incidents from anon, authenticated;",
   "revoke delete on public.incidents from anon, authenticated;\nrevoke truncate on public.incidents from service_role;"],
  ["N05 гілка default_acl розширена на грантора, якого не контролюємо", MIG, E.grantor,
   "d.defaclrole = 'postgres'::regrole", "d.defaclrole is not null"],
  ["N06 відкат не повертає одну з таблиць", MIG, E.rollback,
   "--   public.radiologist_rooms, public.rate_limits, public.referral_access,",
   "--   public.rate_limits, public.referral_access,"],
  ["N07 міграція не реєструє себе в леджері", MIG, E.ledger,
   "values ('0166_privilege_surface.sql')", "values ('0166_priv.sql')"],
);

/* ── 0167: гарт ──────────────────────────────────────────────────────────── */
M.push(
  ["N08 знято сторожу попередника — 0167 накотиться без 0166", HARD, E.pred,
   "where name = '0166_privilege_surface.sql'", "where name is not null"],
  ["N09 «це клієнт?» стало SECURITY DEFINER — умова тотожно хибна", HARD, E.isclient,
   "returns boolean\nlanguage sql\nstable", "returns boolean\nlanguage sql\nstable\nsecurity definer"],
  ["N10 роль із JWT більше не питають — DEFINER знову обходить розтяжку", HARD, E.isclient,
   "      or coalesce(\n           nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',\n           '') in ('anon', 'authenticated');", ";"],
  ["N11 розтяжка запису забула про каскад — впаде видалення клініки", HARD,
   E.tripwire("guard_no_client_delete"),
   "begin\n  /* Каскад (RI від clinics/rooms) пропускаємо: у ньому JWT-роль ще жива, і без\n     цієї гілки правка мовчки заборонила б видалення клініки й кабінету.\n     Прийом той самий, що в `guard_delete_room` (0126). */\n  if pg_trigger_depth() > 1 then\n    return old;\n  end if;",
   "begin"],
  ["N12 розтяжка простою забула про каскад", HARD,
   E.tripwire("guard_no_client_delete_incident"),
   "as $fn$\nbegin\n  if pg_trigger_depth() > 1 then\n    return old;\n  end if;\n  if public.request_is_client_role() then\n    raise exception 'FORBIDDEN: простій не видаляють",
   "as $fn$\nbegin\n  if public.request_is_client_role() then\n    raise exception 'FORBIDDEN: простій не видаляють"],
  /* ⚠️ Якір мусить бути УНІКАЛЬНИМ: те саме повідомлення стоїть і в секції
     відкату (закоментоване). Перший прогін дав «ЯКІР НЕ УНІКАЛЬНИЙ (2×)» —
     стенд був правий, бо мутація в коментарі нічого б не довела. */
  ["N13 розтяжка простою бреше чужим повідомленням (урок 0163)", HARD,
   E.tripwire("guard_no_client_delete_incident"),
   "  if public.request_is_client_role() then\n    raise exception 'FORBIDDEN: простій не видаляють — його завершують (resolved)'\n      using errcode = '42501';",
   "  if public.request_is_client_role() then\n    raise exception 'FORBIDDEN: запис не видаляють — його скасовують'\n      using errcode = '42501';"],
  ["N14 канон 8 більше не стереже спільну функцію", HARD, E.canon8,
   "      ('function:request_is_client_role()'),\n", ""],
);

/* ── живий сторож: перевірки в ОСТАННЬОМУ передруку (ціль — REPRINT, не файл) ── */
M.push(
  ["N15 priv_drift тихо зникла з передруку", REPRINT, E.privdrift,
   "'check', 'priv_drift', 'offenders', to_jsonb(v_tmp)", "'check', 'priv', 'offenders', to_jsonb(v_tmp)"],
  ["N16 із передруку випала стара перевірка ucm_orphan_markers", REPRINT, E.prevchk,
   "'check', 'ucm_orphan_markers', 'offenders', to_jsonb(v_tmp)",
   "'check', 'ucm_orphan', 'offenders', to_jsonb(v_tmp)"],
  ["N17 ролі знову хардкод — нова клієнтська роль невидима", REPRINT, E.roles,
   "        cross join (select g.rolname as rol\n                      from pg_auth_members m\n                      join pg_roles g on g.oid = m.roleid\n                      join pg_roles a on a.oid = m.member\n                     where a.rolname = 'authenticator'\n                       and g.rolname <> 'service_role') r",
   "        cross join (values ('anon'), ('authenticated')) as r(rol)"],
  ["N18 foreign table випала з гілки (a) — грантор supabase_admin поза наглядом", REPRINT, E.relkind,
   "c.relkind in ('r', 'p', 'v', 'm', 'f')", "c.relkind in ('r', 'p', 'v', 'm')"],
  ["N19 гілка (b): inner join знову губить defaclnamespace = 0", REPRINT, E.branchB,
   "        left join pg_namespace n on n.oid = d.defaclnamespace",
   "        join pg_namespace n on n.oid = d.defaclnamespace"],
  ["N20 гілка (b): грант на PUBLIC перестав бути порушником", REPRINT, E.branchB,
   "and (a.grantee = 0 or a.grantee::regrole::text in ('anon', 'authenticated'))",
   "and a.grantee::regrole::text in ('anon', 'authenticated')"],
  ["N21 зникла таблиця знову вбиває сторожа винятком", REPRINT, E.regclass,
   "       where to_regclass('public.incidents') is not null\n         and has_table_privilege(r.rol, 'public.incidents', 'DELETE')",
   "       where has_table_privilege(r.rol, 'public.incidents', 'DELETE')"],
  ["N22 гілка (d) ловить і restrictive/службові політики — вічно червона", REPRINT, E.branchD,
   "         and p.polpermissive\n", ""],
  ["N23 гілка (e) перестала стерегти SECURITY DEFINER розтяжок", REPRINT, E.branchE,
   "      select 'tripwire_definer:' || pr.proname", "      select 'x' where false --"],
  ["N24 гілка (e) забула розтяжку на queue_entries", REPRINT, E.branchE,
   "from (values ('queue_entries'), ('waitlist_entries'), ('incidents')) as t(tbl)",
   "from (values ('waitlist_entries'), ('incidents')) as t(tbl)"],
);

/* ── 0174: сторож не падає МОВЧКИ ────────────────────────────────────────────
   ⚠️ ДІРКА, ЯКУ ЗНАЙШЛА РЕВІЗІЯ с57. `tests/invariantsFailLoud.test.ts` (23
   тести) приїхав у коміті 67f8a49 БЕЗ ЖОДНОЇ позиції фальсифікації: `SPEC`
   цього стенда знав два тестові файли, і третій не запускав ніхто з 24 стендів.
   Сторож без названого червоного тесту не вважається зробленим — нижче по одній
   позиції на кожен блок `it`/`it.each` того файлу.

   Ціль — REPRINT (останній передрук), а не файл 0174 за іменем: наступний
   передрук успадкує обгортки, і стенд мусить їхати за ним (урок с47/с55). */
M.push(
  ["N40 одна перевірка лишилась БЕЗ обгортки — виняток у ній знову вбʼє весь виклик",
   REPRINT, E.wrapAll,
   "  v_n := v_n + 1;\n  /* 0174 */ begin\n  if exists (\n    select 1 from pg_proc\n     where proname = 'cleanup_orphan_clinic'",
   "  v_n := v_n + 1;\n  if exists (\n    select 1 from pg_proc\n     where proname = 'cleanup_orphan_clinic'"],
  ["N41 обробник звужено до одного SQLSTATE — решта винятків знову тихі",
   REPRINT, E.handlers20,
   "  /* 0174 */ exception when others then\n  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(\n  /* 0174 */     'check', 'canonical_objects', 'offenders',",
   "  /* 0174 */ exception when division_by_zero then\n  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(\n  /* 0174 */     'check', 'canonical_objects', 'offenders',"],
  ["N42 лічильник заїхав УСЕРЕДИНУ обгортки — впала перевірка перестане рахуватись",
   REPRINT, E.counterOut,
   "  v_n := v_n + 1;\n  /* 0174 */ begin\n  if exists (\n    select 1 from pg_proc\n     where proname = 'cleanup_orphan_clinic'",
   "  /* 0174 */ begin\n  v_n := v_n + 1;\n  if exists (\n    select 1 from pg_proc\n     where proname = 'cleanup_orphan_clinic'"],
  ["N43 обробник назвав ЧУЖУ перевірку — червоне вкаже чергувальнику не туди",
   REPRINT, E.ownName("orphan_broom_no_hardcode"),
   "  /* 0174 */     'check', 'orphan_broom_no_hardcode', 'offenders',",
   "  /* 0174 */     'check', 'canonical_objects', 'offenders',"],
  ["N44 діагноз без SQLSTATE — «щось впало» замість коду і тексту",
   REPRINT, E.diagnosis,
   "  /* 0174 */     'check', 'ledger_md5', 'offenders',\n  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));",
   "  /* 0174 */     'check', 'ledger_md5', 'offenders',\n  /* 0174 */     to_jsonb(array['raised'])));"],
  ["N45 маркер 0174 просочився в рядок КОДУ — зняття маркерів більше не оборотне",
   REPRINT, E.stripBack,
   "  end if;\n  /* 0174 */ exception when others then\n  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(\n  /* 0174 */     'check', 'orphan_broom_no_hardcode', 'offenders',",
   "  end if; /* 0174 */\n  /* 0174 */ exception when others then\n  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(\n  /* 0174 */     'check', 'orphan_broom_no_hardcode', 'offenders',"],
);

/* ── смоук ───────────────────────────────────────────────────────────────── */
M.push(
  ["N25 смоук звіряє список замість каталогу — нова таблиця проїде мовчки", SMK, E.catalog,
   "    from pg_class c join pg_namespace n on n.oid = c.relnamespace\n    cross join (values ('anon'), ('authenticated')) as r(rol)\n   where n.nspname = 'public' and c.relkind in ('r','p','v','m','f')\n     and has_table_privilege(r.rol, c.oid, 'TRUNCATE');",
   "   where has_table_privilege('anon', 'public.audit_log', 'TRUNCATE');"],
  ["N26 зона h(b) звіряє обрізаний префікс offender-а", SMK, E.negctl,
   '"default_acl:postgres:public:anon"', '"default_acl:postgres"'],
  ["N27 зона h(d) прибрана — гілку політик ніхто не стріляє", SMK, E.negctl,
   "  if not (v_res -> 'failed' @> '[{\"offenders\":[\"incidents_policy:zz_probe_delete\"]}]'::jsonb) then\n    raise exception 'SMOKE FAIL h(d): політика DELETE не названа, failed=%', v_res -> 'failed';\n  end if;",
   ""],
  ["N28 повернувся skip: смоук друкує зелене без зон f/g", SMK, E.noskip,
   "    raise exception 'SMOKE FAIL: немає фікстури (reg=% room=%) — зони f/g не доведені', v_reg, v_room;",
   "    v_ok := v_ok || ' f:skip g:skip';"],
  ["N29 зона (f) без політики — RLS відсікає раніше за тригер", SMK, E.bothbars,
   "    execute 'create policy zz_smoke_delete on public.incidents for delete to authenticated\n               using (clinic_id = (select public.auth_clinic_id()) and (select public.auth_is_desk()))';",
   ""],
  ["N30 межу платформи більше не фіксують видимо", SMK, E.platform,
   "  v_ok := v_ok || (case when v_cnt > 0 then ' b2:supabase_admin_still_grants' else ' b2:gone' end);",
   "  v_ok := v_ok || ' b2';"],
  ["N31 успіх без exception — сліди зон (f)/(h) лишаються в проді", SMK, E.smokeok,
   "  raise exception 'SMOKE_OK (%)', v_ok;", "  raise notice 'SMOKE_OK (%)', v_ok;"],
);

/* ── сторож пінів: три канали + позитивний контроль ──────────────────────── */
M.push(
  ["N32 асерт-пін розійшовся з передруком", GCAL, E.pins,
   `if (v_res ->> 'checked')::int is distinct from ${CHECKS} then`,
   `if (v_res ->> 'checked')::int is distinct from ${CHECKS - 1} then`],
  ["N33 текст «очікував» бреше окремо від коду", GCAL, E.pins,
   `raise exception 'SMOKE_FAIL e: checked = %, очікував ${CHECKS}'`,
   `raise exception 'SMOKE_FAIL e: checked = %, очікував ${CHECKS - 1}'`],
  /* N34/N35 — саме ті два канали, яких у першій редакції сторожа НЕ БУЛО. */
  ["N34 текст «замість N» бреше (канал, якого сторож не бачив)", CMP, E.pins,
   `raise exception 'СМОУК 0164/6: сторож дає % перевірок замість ${CHECKS}'`,
   `raise exception 'СМОУК 0164/6: сторож дає % перевірок замість ${CHECKS - 1}'`],
  ["N35 шапка смоуку бреше числом (канал, якого сторож не бачив)", RBS, E.pins,
   RBS_J_LINE,
   `--   (j) invariants_check(false): checked = 12 (0159)`],
  ["N36 пін переписали формою, якої сторож не розбирає", GCAL, E.pinform,
   `if (v_res ->> 'checked')::int is distinct from ${CHECKS} then`,
   `if (v_res ->> 'checked')::int = ${CHECKS} then null; elsif true then`],
  /* ⚠️ ПОЗИТИВНИЙ КОНТРОЛЬ. `<>` — легальна форма, і сторож мусить її ПРИЙНЯТИ.
     Якби він червонів і тут, «розширення регекспа» було б фікцією: сторож
     реагував би на будь-яку зміну тексту, а не на розбіжність чисел. */
  ["N37 [позитивний контроль] пін через `<>` — легальна форма, має лишитись зеленою",
   GCAL, GREEN,
   `if (v_res ->> 'checked')::int is distinct from ${CHECKS} then`,
   `if (v_res ->> 'checked')::int <> ${CHECKS} then`],
);

/* ── припущення, на якому побудований revoke DELETE ──────────────────────── */
M.push(
  ["N38 застосунок почав видаляти простої (канал 1)", LIB, E.del1,
   "export function studyBlockedByFeed<T extends IncidentLike>(",
   'export async function zzDeleteIncident(sb: any, id: string) {\n  return sb.from("incidents").delete().eq("id", id);\n}\n\nexport function studyBlockedByFeed<T extends IncidentLike>('],
  /* ⚠️ ЗАДОКУМЕНТОВАНА МЕЖА, а не пропущений дефект. Спершу ця мутація стояла
     як «канал 2 мусить упіймати» — і прогін показав ЗЕЛЕНЕ. Розбір: обидва
     канали лексичні. Канал 1 бере найближчий `.from(` ЗЛІВА, канал 2 — вікно
     ВПЕРЕД до наступного `.from(`; видалення через ЗБЕРЕЖЕНЕ ПОСИЛАННЯ, між
     оголошенням і викликом якого стоїть чужий `.from(`, вислизає від обох.
     Розширювати лексику до розбору змінних — не тут: сторож стереже ПРИПУЩЕННЯ
     («застосунок простої не видаляє»), а не сам барʼєр. Барʼєр у БД —
     `revoke delete` + розтяжка `a01_no_client_delete` + гілки (c)/(d) сторожа,
     і всі троє заміряні живим смоуком, який жодного вихідника не читає.
     Тому мутація лишається в наборі — але як ЗЕЛЕНА, щоб межа була написана,
     а не забута. */
  ["N39 [межа] видалення через збережене посилання — лексичний сторож не бачить (барʼєр у БД)",
   LIB, GREEN,
   "export function studyBlockedByFeed<T extends IncidentLike>(",
   'export async function zzDeleteIncident2(sb: any, id: string) {\n  const q = sb.from("incidents");\n  const r = sb.from("rooms");\n  return q.delete().eq("id", id) ?? r;\n}\n\nexport function studyBlockedByFeed<T extends IncidentLike>('],
);

/* ── стенд ───────────────────────────────────────────────────────────────── */
const files = [...new Set(M.map((m) => m[1]))];
const orig = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const restore = () => { for (const [f, t] of orig) writeFileSync(f, t); };
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { restore(); process.exit(1); });
process.on("uncaughtException", (e) => { restore(); console.error(e); process.exit(1); });

/* ⚠️ Третій файл доданий у с57 разом із позиціями N40–N45: до того сторожа
   0174 не запускав жоден стенд. Зайві червоні від нього нікому не шкодять —
   вердикт вимагає, щоб серед червоних був НАЗВАНИЙ, а не щоб він був один. */
const SPEC = "tests/privilegeSurface.test.ts tests/invariantsCheckedPins.test.ts tests/invariantsFailLoud.test.ts";
const lines = ["# Фальсифікація пакета привілеїв (0166 + 0167)", ""];
let bad = 0;

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
  try {
    rmSync(".vt.json", { force: true });
    writeFileSync(file, src.replace(from, () => to));
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
  else if (expectRe === GREEN) {
    if (red.length) {
      bad++;
      lines.push(`- **${name}** → ❌ ЧЕРВОНИЙ, а мав лишитись зеленим: ` + red.map((n) => `«${n}»`).join("; "));
    } else {
      lines.push(`- **${name}** → ✅ ЗЕЛЕНИЙ, як і мусив`);
    }
  }
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
writeFileSync("falsify-0166.md", lines.join("\n"), "utf8");
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
