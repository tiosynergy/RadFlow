-- ============================================================================
--  RadFlow — Міграція 0204: відкликання гранту забирає читання (Н-14) і порядок
--  гарда ключів читання під нічним сторожем (Н-17); передрук сторожа.
--
--  Максимальна ЗАСТОСОВАНА на момент написання — 0203.
--  `checked` 26 -> 26. №14 +гілка `unreachable:`; №16 — три дайджести; №17: 30 -> 31
--  (+ мітла) і гілка `order:`; №19 — рядок `change_marker_recipients` (склад 60).
--  №22 / №23 / №26 — без змін (генератор доводить: код тіла без коментарів
--  відрізняється від 0203 рівно заявленими рядками). Даних не змінює (мітла
--  спрацьовує лише на МАЙБУТНІХ відкликаннях).
--
--  ЗВІДКИ ПАКЕТ — рішення власника 25.09.2026 (с80):
--   • Н-14 «відкликання гранту забирає читання». `queue_select`,
--     `waitlist_select`, `cases_select_referrer` пускали за `created_by` /
--     `referrer_id` без гранту і центру: грант, відкликаний ПІСЛЯ призначення,
--     читання не забирав (0203 закрила лише появу нових незаконних ключів;
--     замір 25.09 — дві записи черги з направником без активного гранту).
--   • Н-17: порядок «гард — останній BEFORE-тригер рядка» тримали лише асерт
--     накату 0203 і CI-тест; тригер, створений поза міграціями, не бачив ніхто.
--
--  ЩО ЗМІНЮЄТЬСЯ:
--   1. Три політики читання: гілка ключа + `clinic_id in (select
--      auth_referrer_clinics())`. Решта політик — ні (`queue_write_referrer` і
--      `waitlist_write_referrer` грант уже вимагали).
--   2. `change_marker_recipients`: для `entry` — лише з АКТИВНИМ грантом
--      направника до центру (позначка про запис, якого не бачиш, не гаситься
--      нічим); для `access` — як було (повідомлення про відкликання мусить дійти).
--   3. Мітла `tg_ref_entry_markers_prune_on_access()` / тригер
--      `trg_zzz_ref_entry_markers_prune` (AFTER DELETE OR UPDATE на
--      `referral_access`): грант перестав бути активним — позначки ЗАПИСІВ
--      цього направника в цьому центрі видаляються (стара пара); позначки
--      `centers` / `referral_access` лишаються.
--   4. №14 `unreachable:<тип>:<к-сть>` — пін ВЛАСТИВОСТІ; №17 `order:` — пін
--      ПОРЯДКУ гарда (предикат — асерт накату 0203).
--
--  ⚠️ ЦІНА І НАСЛІДКИ, названі заздалегідь:
--     • направник після відкликання (чи pending/declined) НЕ бачить своїх
--       записів того центру — рішення власника; повторний грант повертає;
--     • радіолог більше не бачить записів, створених ним поза своїми
--       кабінетами; персонал, що змінив центр, — створених ним записів старого
--       центру (обидва читали їх лише за `created_by`). Радіус — замір сухого
--       прогону (`radius_*`); read-only агрегат проду 25.09 (с80): 2/0/0 рядків
--       q/w/c, один профіль — направник із грантом `pending_referrer`, обидва
--       записи в минулому (майбутніх 0); персоналу й радіологів — 0;
--     • позначки, які мітла видалила, відкат не повертає;
--     • тіло `change_marker_recipients` пінить №19 (рядок передруковано); тіло
--       мітли №19 НЕ пінить (як і мітли графіка 0184) — її ловить №14.
--
--  ⚠️ МЕЖІ, НАЗВАНІ І ПОКАЗАНІ:
--     • гонка «емісія позначки ‖ відкликання гранту» може лишити НОВИЙ рядок
--       позначки за БУДЬ-ЯКОГО порядку commit (емісія закомічена після DELETE
--       мітли — або UPSERT емітера, що чекав на commit відкликання, вставляє
--       новий рядок) — червоне №14 `unreachable:` ловить обидва → ручна
--       зачистка за явним списком id; закрити обидва порядки — `for share` на
--       рядку гранту в емітерах записів (PR-0204, §12);
--     • переведення персоналу між центрами (у застосунку шляху немає) лишає
--       непрочитані позначки старого центру — №14 назве; переводити разом із
--       зачисткою за явним списком id (AGENTS.md). Переведеному радіологу CTE
--       `rads` у `change_marker_recipients` клініку профілю не звіряє, а
--       `radiologist_rooms` при переводі не чистяться — позначки старого
--       центру йдуть і далі (на проді 26.09 таких рядків 0);
--     • кабінети гранту (`room_ids`) — не межа читання за ключем (як і в
--       гарді 0203): направник з грантом на один кабінет читає свої записи
--       будь-якого кабінету центру;
--     • `session_replication_role = replica` гасить тригери повз каталог —
--       ні №17, ні `order:` цього не бачать (межа №17).
--
--  ⚠️ ⚠️ ЦЕЙ ФАЙЛ НЕ НАКАТУВАТИ — ні вставкою в SQL Editor, ні MCP
--     `apply_migration`, ні `supabase db push`: він ідемпотентний і канонічний,
--     а накат має СУВОРИЙ предстан і один блок. Шлях один —
--     `scripts/frag/0204_apply.sql`, весь одним запитом (базою через net.http_get).
--
--  ПОРЯДОК:
--   0. Дерево чисте; `node scripts/build-0204-reprint.mjs` → `git diff --exit-code`;
--      `npx vitest run`, `npx tsc --noEmit`; ревізія стендів. Усе — ДО проду.
--   1. `scripts/frag/0204_dryrun.sql` цілком (перший стейтмент — `set
--      statement_timeout`, другий — `do` з тегом `dryrun`) →
--      DRYRUN_0204_ROLLBACK з checked=26, ok16=true, ok17=true, failed_before_ddl
--      = лише gcal_sync_overdue, policy_digest (три changed:) і guard_triggers (один
--      missing:). radius_* — ЗАМІР, не стоп (інше число — переглянути абзац
--      ціни); недосяжні НЕПРОЧИТАНІ позначки записів — СТОП (ручна зачистка
--      за явним списком id ДО накату).
--   2. `scripts/frag/0204_apply.sql` — ОДРАЗУ після сухого прогону. Читання назад:
--      guard_md5 = cf1a920d2052a6debaff8b46c450aeff, guard_len = 178426, ledger_rows = 204,
--      три нові дайджести, prune_fn = true, prune_trigger = 1, zz_last_tables = 3.
--      Помилка = НІЧОГО не закомічено. Таймаут клієнта = не повторювати
--      наосліп: спершу select читання назад.
--      ⚠️ ЧЕРВОНЕ ВІКНО: з цього commit і до пушу `main` з файлом 0204 падає
--      КОЖНА прод-збірка (гейт: рядок леджера без файла). Жодного Redeploy,
--      нічого іншого в `main`; кроки 3–7 — одним заходом. Ліміт 03:50 UTC
--      (06:50 Київ) — на ВЕСЬ відрізок «накат → db:gate».
--   3. ОКРЕМИМ запитом `select public.invariants_check(false);` — checked 26,
--      failed ⊆ {gcal_sync_overdue, ledger_md5}.
--   4. Смоук `supabase/smoke/0204_referrer_grant_read_smoke.sql` → `SMOKE_OK …`.
--   5. `scripts/frag/0204_falsify.sql` → verdict=PASS (probes_ok+na = 24). Після —
--      окремим запитом №14, №16, №17 і №19 зелені.
--   6. `npm run db:gate` (ЛИШЕ з машини власника) → `invariants_check`: failed лише
--      gcal_sync_overdue (або порожньо).
--   7. git ОДНИМ заходом: гілка → dev → main → push → штамп деплою; вікно
--      закрите, коли `npm run db:gate:check` зелений на `main` І на `dev`. Не
--      закрили 6–7 у цей захід — `scripts/frag/0204_rollback.sql`, а не
--      «доробимо завтра».
--   8. ⚠️ ПІСЛЯ КРОКУ 6 генератор НЕ ЗАПУСКАТИ (перезаписує файл із md5 у леджері).
-- ============================================================================

begin;

-- ── 0. Предстан (ідемпотентний: 0203 або вже 0204) ─────────────────────────
do $pre$
declare v_src text; v_bad text[]; v_pol text[]; v_unreach jsonb;
begin
  if current_user <> 'postgres' then
    raise exception '0204: мусить іти від ролі postgres, а йде від %', current_user;
  end if;
  if not exists (select 1 from public.migration_ledger where name = '0203_audit_pii_referrer_grant.sql') then
    raise exception '0204: у леджері немає 0203 — накат не в свою чергу';
  end if;
  if (select max(name) from public.migration_ledger) not in
     ('0203_audit_pii_referrer_grant.sql', '0204_referrer_grant_read.sql') then
    raise exception '0204: останній рядок леджера % — не 0203/0204, черга зсунулась',
      (select max(name) from public.migration_ledger);
  end if;
  select replace(p.prosrc, chr(13), '') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if md5(v_src) not in ('8c8e6403db7653949e03d026320c6099', 'cf1a920d2052a6debaff8b46c450aeff') then
    raise exception '0204: тіло сторожа % — ні 0203, ні 0204; правка наосліп заборонена', md5(v_src);
  end if;
  if (select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = to_regprocedure('public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean)'))
     not in ('cef6f91b5dd1dcdc35e93fd732cf7162', 'c7a602edb861ecceb598e4d65534345d') then
    raise exception '0204: change_marker_recipients — ні тіло 0184, ні 0204; правка наосліп заборонена';
  end if;
  -- ⚠️ `to_regprocedure`, а не `::regprocedure`: приведення константи падає ще на
  --    плануванні, коли функції немає (урок локального стенда 0203).
  if to_regprocedure('public.tg_ref_entry_markers_prune_on_access()') is not null
     and (select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = to_regprocedure('public.tg_ref_entry_markers_prune_on_access()'))
         is distinct from 'a7d7f8876e46fc9a3b7a0efcf378bbfa' then
    raise exception '0204: tg_ref_entry_markers_prune_on_access() уже є з ІНШИМ тілом — чиясь чернетка? спершу розібратись';
  end if;
  select array_agg(pp.tablename || '.' || pp.policyname || '=' ||
           substr(md5(coalesce(pp.cmd, '') || '|' || coalesce(pp.permissive, '') || '|'
                      || coalesce(array_to_string(array(select unnest(pp.roles) order by 1), ','), '') || '|'
                      || coalesce(regexp_replace(pp.qual, '\s+', ' ', 'g'), '') || '|'
                      || coalesce(regexp_replace(pp.with_check, '\s+', ' ', 'g'), '')), 1, 12)
           order by pp.tablename collate "C", pp.policyname collate "C") into v_pol
    from pg_policies pp
   where pp.schemaname = 'public'
     and (pp.tablename, pp.policyname) in (('patient_cases', 'cases_select_referrer'), ('queue_entries', 'queue_select'), ('waitlist_entries', 'waitlist_select'));
  if v_pol is distinct from array['patient_cases.cases_select_referrer=d6b423f8c727', 'queue_entries.queue_select=ff3f89d6a1a2', 'waitlist_entries.waitlist_select=659164e8f637']::text[] and v_pol is distinct from array['patient_cases.cases_select_referrer=a406bc42d13d', 'queue_entries.queue_select=6061c08c210b', 'waitlist_entries.waitlist_select=0cf225150efe']::text[] then
    raise exception '0204: політики читання — ні форма 0203, ні 0204: % — правка наосліп заборонена', v_pol;
  end if;
  select coalesce(jsonb_object_agg(u.entity_type, u.n order by u.entity_type), '{}'::jsonb)
    into v_unreach
    from (select um.entity_type, count(*) as n
            from public.user_change_markers um
            join public.profiles pf on pf.id = um.recipient_id
           where um.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')
             and um.seen_at is null
             and pf.clinic_id is distinct from um.clinic_id
             and not exists (select 1 from public.referral_access g
                              where g.referrer_id = um.recipient_id
                                and g.clinic_id = um.clinic_id
                                and g.status = 'active')
           group by um.entity_type) u;
  if v_unreach <> '{}'::jsonb then
    raise exception '0204: уже є недосяжні НЕПРОЧИТАНІ позначки записів % — до накату ручна зачистка за явним списком id', v_unreach;
  end if;
end
$pre$;

-- ── 1. change_marker_recipients: гілка entry — лише з АКТИВНИМ грантом (Н-14) ─────────────
create or replace function public.change_marker_recipients(
  p_clinic uuid,
  p_actor uuid,
  p_scope_kind text,
  p_room uuid default null::uuid,
  p_referrer uuid default null::uuid,
  p_severity text default 'info'::text,
  p_room_relevant boolean default true
)
returns table(recipient_id uuid)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $cmr$
  with staff as (
    -- Адміністратори і реєстратори центру: операційне ядро, бачать усе.
    -- Для 'access' — лише адміністратори (реєстратор доступами не керує).
    -- 0138 (F-3): для 'catalog' — теж лише адміністратори. Екран /services
    -- відкривається виключно адміну (app/services/page.tsx), і єдиний
    -- `useAckWhenVisible({surface:'services'})` живе в ServicesManager, тож
    -- реєстратор отримував крапку, яку не міг погасити ЖОДНОЮ дією.
    -- ⚠️ Наслідок, прийнятий свідомо: реєстратор більше не дізнається про зміну
    -- цін із крапки (а ціни він бачить у формах запису). Компенсація — крапка
    -- на блоці ціни у формах — окрема ітерація; повернути його в аудиторію можна
    -- буде рівно тоді, коли в нього зʼявиться поверхня з ack.
    --
    -- 0184 (RF-03b): для 'schedule' персоналу НЕ шлемо ВЗАГАЛІ — ні адміну, ні
    -- реєстратору. Причина та сама, що вище, і вона заміряна, а не припущена:
    -- у всьому дереві `components/` рядок `surface: "schedule"` трапляється
    -- НУЛЬ разів (зелений базис тим самим запитом: `surface: "waitlist"` → 1,
    -- у `MyWaitlist`). ⚠️ Посилання НА ІМʼЯ, а не на номер рядка: перша
    -- редакція вказувала «ReferralPortal.tsx:1774», і цей самий пакет зсунув
    -- файл власною правкою — за місяць читач пішов би не туди й вирішив, що
    -- коментар бреше. Поверхні з ack для графіка не існує в природі,
    -- тож крапка персоналу запалилась би й не гасла НІКОЛИ.
    -- ЯК ПОВЕРНУТИ: завести у персонала екран графіка з
    -- `useAckWhenVisible({surface:'schedule'})` і зняти цей предикат.
    select p.id
      from public.profiles p
     where p.clinic_id = p_clinic
       and p.role in ('admin', 'registrar')
       and p_scope_kind <> 'schedule'
       and (p_scope_kind not in ('access', 'catalog') or p.role = 'admin')
  ),
  rads as (
    -- Радіолог — ЛИШЕ по призначених йому кабінетах і лише коли зміна
    -- стосується виконання в кабінеті (p_room_relevant).
    -- 0184: `p_scope_kind <> 'schedule'` стоїть тут ЯВНО, хоч емітер і так
    -- передає `p_room_relevant => false`. Це fail-CLOSED: майбутній емітер із
    -- `p_room_relevant => true` інакше МОВЧКИ засвітив би радіологу крапку,
    -- яку він не має де погасити. Захист від чужої майбутньої помилки, а не
    -- від власної теперішньої.
    select rr.profile_id as id
      from public.radiologist_rooms rr
     where rr.clinic_id = p_clinic
       and p_room is not null
       and p_room_relevant
       and p_scope_kind <> 'schedule'
       and rr.room_id = p_room
  ),
  referrer as (
    -- Направник отримує позначку лише про ЙОГО направлення. Для 'access'
    -- активність referral_access НЕ перевіряємо навмисно: позначка про
    -- відкликання доступу мусить дійти саме до того, у кого доступ щойно
    -- забрали (вимога ТЗ; RLS позначок тримається на recipient_id, а не на
    -- клініці).
    --
    -- 0204 (Н-14, рішення власника 25.09.2026): для 'entry' — ЛИШЕ з
    -- АКТИВНИМ грантом до p_clinic. Дзеркало політик читання 0204
    -- (`queue_select`, `waitlist_select`, `cases_select_referrer`): за
    -- `created_by` / `referrer_id` запис читає лише власник активного гранту
    -- до центру запису. Позначка про запис, якого отримувач не бачить, —
    -- крапка ні про що: `queue_entry` гаситься лише з відрендереного рядка
    -- (для невидимого — ніколи), `patient_case` ack поки не має взагалі, а
    -- `waitlist_entry` направника гасить поверхня «Лист очікування»
    -- (surface-ack, 0138), але до того крапка на вкладці світить про рядок,
    -- якого в списку немає. Ретенція чистить тільки прочитані (правило
    -- «позначка без поверхні для ack — дефект»). Позначки, що лежали на
    -- мить, коли грант перестав бути активним, знімає тригер
    -- `trg_zzz_ref_entry_markers_prune` на `referral_access`; вцілілу
    -- НЕПРОЧИТАНУ (гонка з відкликанням) називає №14 гілкою `unreachable:`.
    --
    -- ⚠️ Але існування ПРОФІЛЮ перевіряємо (0134, ревʼю р2). Це єдина гілка,
    -- що підставляє сирий uuid, не звіряючись із profiles. Каскад
    -- `delete from profiles` (обидва FK referral_access — ON DELETE CASCADE)
    -- зносив грант, тригер емітив позначку ВЖЕ ВИДАЛЕНОМУ направнику, і
    -- прочитати її не міг ніхто: RLS тримається на recipient_id, а ретенція
    -- чистить лише прочитані. Вічний рядок за побудовою.
    select p_referrer as id
     where p_referrer is not null
       and p_scope_kind in ('entry', 'access')
       and exists (select 1 from public.profiles pr where pr.id = p_referrer)
       and (p_scope_kind = 'access'
            or exists (select 1 from public.referral_access ra
                        where ra.referrer_id = p_referrer
                          and ra.clinic_id = p_clinic
                          and ra.status = 'active'))
  ),
  sched_referrers as (
    -- 0184 (RF-03b). ВІЯЛО по направниках центру — рівно те, чого в цій
    -- функції не було: гілка `referrer` вище адресує ОДНОГО `p_referrer`, а
    -- зміна графіка кабінету не привʼязана до жодного конкретного направлення.
    --
    -- ⚠️ ТРИ предикати, і кожен має названу причину:
    --   • `ra.status = 'active'` — дзеркало гілки (1) `auth_referrer_visible_
    --     rooms()`. Неактивний грант графіка не читає; крапка про те, чого не
    --     видно, недосяжна.
    --   • ФІЛЬТР ПО ГРАНТУ КАБІНЕТІВ — те саме дзеркало: `room_ids is null`
    --     означає «усі кабінети центру», інакше кабінет мусить бути у списку.
    --     Без цього направник із грантом на один кабінет дізнавався б про
    --     зміни в чужих — рівно та діра, яку 0183a щойно закрила у читанні.
    --   • `pr.approved` — направник без підтвердження на портал НЕ потрапляє
    --     (app/referral/page.tsx: `referrer && !approved` віддає «Очікує
    --     підтвердження» замість порталу). Отже погасити крапку він не може
    --     ЖОДНОЮ дією. Це той самий тест, що для персоналу вище.
    --
    -- ⚠️ МЕЖА, названа вголос: `auth_referrer_visible_rooms()` показує ще й
    --    кабінети ВЛАСНИХ записів направника (гілки 2a/2b). Сюди вони НЕ
    --    внесені свідомо — віяло тримається на ГРАНТІ. Наслідок: направник,
    --    який бачить кабінет лише через свій запис, зміну графіка побачить
    --    (читання ширше за віяло), а крапки не отримає. Це вужче, а не ширше
    --    за право читання — тобто помилка в бік мовчання, а не витоку.
    select ra.referrer_id as id
      from public.referral_access ra
      join public.profiles pr on pr.id = ra.referrer_id
     where p_scope_kind = 'schedule'
       and ra.clinic_id = p_clinic
       and ra.status = 'active'
       and pr.approved
       and (p_room is null
            or ra.room_ids is null
            or p_room = any (ra.room_ids))
  )
  /* ⚠️ CEO В МАТРИЦІ НЕМАЄ (0134), і це не забули — це рішення.
     0131 (ревʼю р1, M-9) уже звузив CEO до 'incident' і 'access', бо решти
     сутностей у нього немає на екранах. с28 показала, що екрана з
     referral_access у нього немає теж, а ревʼю пакета №4 — що й інциденти
     він погасити не може: підписка в нього Є (Sidebar монтує
     <UnreadChangesMount /> безумовно) і крапку на «Дошці черги» він БАЧИТЬ,
     але жодного екрана з `useAckWhenVisible` у його дереві немає —
     поверхню 'incidents' рендерить лише QueueBoard на /queue, куди CEO не
     пускає редирект. Крапка, що запалюється й не гасне ніколи, за правилом
     проєкту є дефектом.
     ЯК ПОВЕРНУТИ, коли в CEO зʼявиться екран ІЗ ACK: додати сюди CTE

       ceo as (
         select ca.ceo_id as id from public.ceo_access ca
          where ca.clinic_id = p_clinic and ca.status = 'active'
            and p_scope_kind = 'incident' and p_severity = 'critical'
       )

     і рядок `union select id from ceo` нижче. Рамка по scope_kind
     ОБОВʼЯЗКОВА (без неї сюди провалюється будь-яка подія з
     severity='critical' — скасування запису, cito, скасований кейс). */
  select distinct s.id
    from (
      select id from staff
      union select id from rads
      union select id from referrer
      union select id from sched_referrers
    ) s
   where s.id is not null
     and (p_actor is null or s.id <> p_actor);
$cmr$;

revoke all on function public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean) to service_role;

-- ── 2. Мітла позначок записів при відкликанні гранту — пастка 0122: лише службова роль
create or replace function public.tg_ref_entry_markers_prune_on_access()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $prune$
begin
  -- 0204 (Н-14, рішення власника 25.09.2026: «відкликання гранту забирає
  -- читання»). Політики читання 0204 пускають за `created_by` / `referrer_id`
  -- лише з АКТИВНИМ грантом до центру запису. Щойно грант перестає бути
  -- активним, позначки ЗАПИСІВ цього центру вказують на рядки, яких
  -- направник уже не бачить: `queue_entry` гаситься лише з відрендереного
  -- рядка (тобто ніколи), `patient_case` ack поки не має, `waitlist_entry`
  -- погасила б поверхня «Лист очікування», але до того крапка світить про
  -- рядок, якого в списку немає; ретенція чистить тільки прочитані. Тому
  -- видаляємо їх — позначки черги, листа очікування й кейсів цього
  -- направника в цьому центрі, і НЕПРОЧИТАНІ, і ПРОЧИТАНІ (гігієна:
  -- прочитана крапки не запалює, але до 180 днів лежала б позначкою про
  -- невидимий запис; №14 рахує лише непрочитані). Позначки `centers` /
  -- `referral_access` (саме повідомлення про відкликання) НЕ чіпаємо: воно
  -- мусить дійти.
  --
  -- «Перестає бути активним» — за СТАРОЮ парою (направник, центр):
  --   • UPDATE з active у будь-який інший статус;
  --   • DELETE активного гранту (зокрема каскадом із profiles);
  --   • UPDATE активного гранту, що міняє `clinic_id` або `referrer_id`.
  -- Вкладений IF, а не кон'юнкт: на DELETE рядок `new` порожній (канон
  -- `tg_sched_markers_prune_on_access`, 0184). Кабінети гранту (`room_ids`)
  -- — не межа читання за ключем, тож їх зміна нічого не знімає.
  --
  -- Не був активним — читання за ним не було, знімати нічого.
  if old.status is distinct from 'active' then
    return null;
  end if;
  -- Той самий живий грант (пара та сама, статус active) — теж нічого.
  if tg_op = 'UPDATE' then
    if new.status = 'active'
       and new.referrer_id is not distinct from old.referrer_id
       and new.clinic_id is not distinct from old.clinic_id then
      return null;
    end if;
  end if;

  delete from public.user_change_markers m
   where m.recipient_id = old.referrer_id
     and m.clinic_id    = old.clinic_id
     and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case');
  return null;
end;
$prune$;

revoke all on function public.tg_ref_entry_markers_prune_on_access() from public, anon, authenticated;
grant execute on function public.tg_ref_entry_markers_prune_on_access() to service_role;

-- ── 3. Передрук сторожа: №14, №16, №17, №19 і проза ─────────────────────────

create or replace function public.invariants_check(p_write boolean default true)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_fail   jsonb := '[]'::jsonb;
  v_n      int   := 0;
  v_tmp    text[];
  v_res    jsonb;
  v_claims text;
  v_drift  text;
  v_atg    text;
begin
  /* Кожна перевірка: рахуємо в v_n, а знайдені порушення кладемо в v_fail
     разом з іменем перевірки. Порожній v_fail = все ціле. */

  -- 1. security_invoker на ВСІХ вʼюхах. Без нього вʼюха читає дані повз RLS
  --    правами власника: v_clinic_people віддала б персонал усіх клінік
  --    будь-якому автентифікованому (канон 0147).
  v_n := v_n + 1;
  /* 0174 */ begin
  select array_agg(c.relname order by c.relname) into v_tmp
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'v'
     and coalesce(array_to_string(c.reloptions, ','), '') not like '%security_invoker=%';
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'views_security_invoker', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'views_security_invoker', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 2. search_path у КОЖНОЇ security definer функції дорівнює КАНОНУ
  --    `public, pg_temp`. До 0196 тут перевірялась лише НАЯВНІСТЬ рядка
  --    `search_path`, тож `alter function … set search_path = pg_temp, public`
  --    проходив повз усі 23 перевірки (замір с67 — розвилка Р3).
  --
  --    ⚠️ ЧОМУ РІВНІСТЬ, А НЕ «чи є pg_temp у списку». ЗАМІРЯНО 14.09 на
  --       проді, у відкоченій транзакції, тимчасовою таблицею `cities`
  --       поверх справжньої:
  --         real=[Андріївка]
  --         search_path=public            -> ПІДМІНА-TEMP
  --         search_path=""                -> ПІДМІНА-TEMP
  --         search_path=pg_catalog,pg_temp-> ПІДМІНА-TEMP
  --         search_path=pg_temp,public    -> ПІДМІНА-TEMP
  --         search_path=public, pg_temp   -> Андріївка
  --       Postgres шукає ВІДНОШЕННЯ в тимчасовій схемі ПЕРШОЮ, якщо
  --       `pg_temp` не виписаний у шляху явно. Отже боронить не згадка
  --       `pg_temp`, а те, що СПРАВЖНЯ схема стоїть ПЕРЕД нею. Рецепт
  --       `search_path = ''` від підміни таблиць НЕ боронить — він лише
  --       змушує все кваліфікувати, і ця властивість не була запінена
  --       нічим.
  --
  --    ⚠️ ДО 0196 у проді було 34 функції зі слабкою формою (28 із
  --       `public`, 6 із `""`), з них 12 кликав `authenticated`, 6 —
  --       `anon`. Живої діри не було: механічний пошук неквалiфікованих
  --       посилань по всіх 115 тілах дав НУЛЬ (зелена база на самому
  --       пошуку: `from profiles` ловиться, `from public.profiles` ні).
  --       0196 робить цю властивість структурною.
  --
  --    ЧОТИРИ МЕЖІ, НАЗВАНІ НАВМИСНО (усі знайдені ревʼю до накату):
  --      1. Перевірка читає `proconfig`, а не тіло. Функція з каноном у
  --         `proconfig` може перекинути шлях ЗСЕРЕДИНИ —
  --         `perform set_config('search_path', 'pg_temp, public', true)` —
  --         і №2 лишиться зеленою. Для 36 функцій це ловить пін ТІЛА в
  --         №19; для решти 79 не ловить ніщо.
  --      2. Фільтр `nspname = 'public'`. SECURITY DEFINER в іншій схемі
  --         невидимий №2 узагалі. Сьогодні таких три, усі чужі
  --         (`pgbouncer.get_auth`, `vault.create_secret`,
  --         `vault.update_secret`), клієнтським ролям недоступні.
  --      3. Стиль посилань у тілі: після 0196 неквалiфіковане посилання
  --         безпечне ЗА ПОБУДОВОЮ шляху, але сам стиль не пасе ніхто.
  --      4. ШІСТЬ функцій ішли з `search_path = ""` і на цьому переході
  --         ВТРАЧАЮТЬ те єдине, що порожній шлях справді давав: примус
  --         кваліфікувати ФУНКЦІЇ та ОПЕРАТОРИ. Тепер `public` — кандидат,
  --         а правило перевантажень «точний збіг типів» порядок шляху
  --         ігнорує. Сьогодні це закрито тим, що `CREATE` на схему
  --         `public` є ЛИШЕ у `postgres` (заміряно: anon, authenticated,
  --         service_role — false), і жодна з 23 перевірок цю привілею НЕ
  --         пасе (так було до 0201: для anon, authenticated і PUBLIC її тепер
  --         пасе №26, ключ `n:public:*`; для service_role — як і раніше, ніхто).
  --         Для ВІДНОШЕНЬ і ТИПІВ перехід навпаки звужує: `pg_temp`
  --         їде з неявного першого місця на явне останнє.
  --    ⚠️ Дубль `search_path` у `proconfig` дав би скалярному підзапиту
  --       21000 і БЕЗІМЕННОГО порушника `raised:…`; тому тут
  --       `array_to_string(array(... order by 1), '|')` — дубль стає
  --       значенням, що не дорівнює канону, і порушник називає СЕБЕ.
  v_n := v_n + 1;
  /* 0174 */ begin
  select array_agg(pr.oid::regprocedure::text order by pr.oid::regprocedure::text)
    into v_tmp
    from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
   where n.nspname = 'public' and pr.prosecdef
     and array_to_string(array(select cfg from unnest(pr.proconfig) cfg
                                where cfg like 'search_path=%' order by 1), '|')
         is distinct from 'search_path=public, pg_temp';
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'secdef_search_path', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'secdef_search_path', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 3. RLS увімкнено на всіх таблицях public. Нова таблиця без RLS — відкриті
  --    дані; Supabase лається на це в UI, але міграцію накатують «Run without RLS».
  v_n := v_n + 1;
  /* 0174 */ begin
  select array_agg(c.relname order by c.relname) into v_tmp
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'tables_rls_enabled', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'tables_rls_enabled', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 4. Усі cron-задачі активні. Задача, яку хтось вимкнув, не лишає слідів.
  v_n := v_n + 1;
  /* 0174 */ begin
  select array_agg(jobname order by jobname) into v_tmp
    from cron.job where not active;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'cron_active', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'cron_active', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 5. ПРОТУХЛІ щодобові задачі: прогони БУЛИ, останній старший за 48 годин.
  --    Саме той стан, який ловили руками в с38/с39: задача є, розклад є, а
  --    планувальник її більше не бере. Свіжа задача сюди НЕ потрапляє —
  --    її відсіює exists (0155, було злито з перевіркою «немає прогонів»).
  v_n := v_n + 1;
  /* 0174 */ begin
  select array_agg(j.jobname order by j.jobname) into v_tmp
    from cron.job j
   where j.active
     and j.schedule ~ '^[0-9]+ [0-9]+ \* \* \*$'   -- саме щодобові
     and exists (select 1 from cron.job_run_details d where d.jobid = j.jobid)
     and not exists (select 1 from cron.job_run_details d
                      where d.jobid = j.jobid
                        and d.start_time > now() - interval '48 hours');
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'cron_daily_stalled', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'cron_daily_stalled', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 6. Щодобові задачі БЕЗ ЖОДНОГО прогону. Скаржимось, лише якщо сам журнал
  --    старший за 48 годин: у щойно піднятій системі відсутність прогонів —
  --    норма. Точка відліку — min(ran_at) у maintenance_runs; created_at у
  --    cron.job немає, а окремий реєстр протух би сам.
  --
  --    ⚠️ v_tmp скидаємо ЯВНО: select усередині гілки може не виконатись, і
  --    тоді масив лишився б від перевірки 5 — сторож приписав би порушників
  --    не тій перевірці. Тиха підміна, знайти яку в проді було б нічим.
  v_n := v_n + 1;
  /* 0174 */ begin
  v_tmp := null;
  if (select min(ran_at) from public.maintenance_runs) < now() - interval '48 hours' then
    select array_agg(j.jobname order by j.jobname) into v_tmp
      from cron.job j
     where j.active
       and j.schedule ~ '^[0-9]+ [0-9]+ \* \* \*$'
       and not exists (select 1 from cron.job_run_details d where d.jobid = j.jobid);
  end if;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'cron_daily_never_ran', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'cron_daily_never_ran', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 7. У ledger немає записів без md5: незаштампована міграція означає, що
  --    db:gate не проходив, і deploy-гейт завалить build.
  v_n := v_n + 1;
  /* 0174 */ begin
  select array_agg(name order by name) into v_tmp
    from public.migration_ledger where md5 is null;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'ledger_md5', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'ledger_md5', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 8. Канонічні обʼєкти на місці. Єдиний хардкод у сторожі — і він FAIL-LOUD:
  --    зникла функція чи тригер дають offenders, а не мовчазний вихід. Саме
  --    цим перевірка відрізняється від «<> 16», що вимикало 0141.
  v_n := v_n + 1;
  /* 0174 */ begin
  select array_agg(x.obj order by x.obj) into v_tmp
    from (values
      ('function:cleanup_orphan_clinic()'),
      ('function:audit_log_retention_daily()'),
      ('function:outbox_retention_daily()'),
      ('function:queue_reschedule_rpc(uuid,uuid,date,text,integer,integer,call_status,text,boolean,jsonb)'),
      ('function:invariants_check(boolean)'),
      ('table:maintenance_runs'),
      ('table:migration_ledger'),
      ('trigger:trg_cleanup_orphan_clinic'),
      ('table:incidents'),
      ('function:request_is_client_role()'),
      ('function:guard_no_client_delete()'),
      ('function:guard_no_client_delete_incident()')
    ) as x(obj)
   where case
     when x.obj like 'function:%' then to_regprocedure(substr(x.obj, 10)) is null
     when x.obj like 'table:%'    then to_regclass('public.' || substr(x.obj, 7)) is null
     when x.obj like 'trigger:%'  then not exists (
            select 1 from pg_trigger where tgname = substr(x.obj, 9) and not tgisinternal)
     else true end;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'canonical_objects', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'canonical_objects', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 9. Мітла сиріт не повернулась до магічного числа (регрес 0151).
  --    Код звіряємо БЕЗ коментарів: коментар 0151 цитує старий запобіжник,
  --    і наївний like спрацював би хибно (урок с39).
  v_n := v_n + 1;
  /* 0174 */ begin
  if exists (
    select 1 from pg_proc
     where proname = 'cleanup_orphan_clinic' and pronamespace = 'public'::regnamespace
       and regexp_replace(
             regexp_replace(prosrc, '/\*.*?\*/', ' ', 'gs'),
             '--[^' || chr(10) || ']*', ' ', 'g') like '%<> 16%') then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'orphan_broom_no_hardcode', 'offenders', to_jsonb(array['cleanup_orphan_clinic'])));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'orphan_broom_no_hardcode', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 10. room_busy_slots у контексті service_role віддає зайнятість (регрес C-2
  --     аудиту 23.08 / 0156). Беремо до трьох останніх кабінето-днів із
  --     фактичною зайнятістю (без in_progress: його вікно рахується від
  --     фактичного старту і може лягти на іншу добу) і вимагаємо ≥1 рядок від
  --     RPC для кожного. Немає жодного зайнятого дня — перевірка мовчить:
  --     звіряти нічого. Контекст service_role ставимо самі й повертаємо назад:
  --     сторож крутиться під postgres/cron, де JWT немає.
  --     ⚠️ room_id/scheduled_date is not null — обовʼязково: група з NULL дала б
  --     txt = NULL, а array_agg(NULL) = {NULL} IS NOT NULL → хибна тривога
  --     (ревʼю 0156).
  v_n := v_n + 1;
  /* 0174 */ begin
  v_tmp := null;
  v_claims := current_setting('request.jwt.claims', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select array_agg(x.txt order by x.txt) into v_tmp
    from (
      select d.room_id::text || '@' || d.scheduled_date::text as txt
        from (select q.room_id, q.scheduled_date
                from public.queue_entries q
               where q.room_id is not null            -- FK on delete set null (0001)
                 and q.scheduled_date is not null
                 and q.scheduled_at is not null
                 and q.duration_min is not null
                 and q.status in ('scheduled', 'waiting', 'done')
               group by q.room_id, q.scheduled_date
               order by q.scheduled_date desc, q.room_id
               limit 3) d
       where not exists (select 1 from public.room_busy_slots(d.room_id, d.scheduled_date))
    ) x;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'room_busy_service_role', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'room_busy_service_role', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 11. Тригер емісії 0145 — fail-open за дизайном: доменна зміна проходить,
  --     навіть якщо подію партнеру покласти не вдалося, а єдиний слід —
  --     рядок `integration.emit_failed` в outbox. З 0157 воркер цю службову
  --     подію партнеру НЕ шле (ack із поміткою), тож помітити її може лише
  --     сторож: за останні 26 годин таких рядків має бути нуль. 26, а не 24 —
  --     щодобовий прогін не сміє мати сліпу хвилину на стику. У offenders —
  --     лише префікс clinic_id і час: тексту SQL-помилки (payload.err) у
  --     журналі сторожа не місце.
  v_n := v_n + 1;
  /* 0174 */ begin
  select array_agg(x.txt order by x.txt) into v_tmp
    from (
      select coalesce(left(e.payload ->> 'clinic_id', 8), '?')
             || '@' || to_char(e.created_at, 'YYYY-MM-DD HH24:MI') as txt
        from public.event_outbox e
       where e.event_type = 'integration.emit_failed'
         and e.created_at > now() - interval '26 hours'
       order by e.created_at desc
       limit 10
    ) x;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'outbox_emit_failed_26h', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'outbox_emit_failed_26h', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 12. В event_outbox немає рядків, яким там не місце (0159). Три гілки —
  --     борг ретенції: політика 30/30/90 мала прибрати їх ще позавчора
  --     (+2 доби запасу, щоб один пропущений прогін не кричав). Ловить і
  --     вичерпану партію p_limit, і підміну команди задачі, і зламану
  --     функцію — стани, які інакше не видно місяцями (урок 0152).
  --     Четверта гілка — НЕ ретенція: живий недоставлений рядок, якому
  --     місяць. Ретенція його не чіпає за дизайном (черга доставки — не
  --     сміття), а в DLQ він може не потрапити ніколи: n8n-гілка воркера
  --     відкладає такий рядок без attempts++. Місяць у черзі означає, що
  --     доставка стоїть, — і це єдине місце, де це видно.
  --     У offenders — лише лічильники, жодного вмісту payload.
  --     ⚠️ Горизонти тут ЗАДУБЛЬОВАНІ літералами свідомо: сторож не сміє
  --     читати параметри політики, яку він стереже, — інакше підміна
  --     константи в обгортці тихо перевизначила б і поняття «норма».
  v_n := v_n + 1;
  /* 0174 */ begin
  select array_agg(x.txt order by x.txt) into v_tmp
    from (
      select 'delivered_30d:' || count(*) as txt
        from public.event_outbox
       where delivered_at is not null
         and delivered_at < now() - interval '32 days'
      having count(*) > 0
      union all
      select 'dead_pii_30d:' || count(*)
        from public.event_outbox
       where dead and delivered_at is null
         and created_at < now() - interval '32 days'
         and (payload - 'clinic_id' - 'clinicId') is distinct from '{}'::jsonb
      having count(*) > 0
      union all
      select 'dead_90d:' || count(*)
        from public.event_outbox
       where dead and delivered_at is null
         and created_at < now() - interval '92 days'
      having count(*) > 0
      union all
      -- у цієї гілки політики немає, тож і запасу на пропущений прогін не
      -- треба: рівно 30 діб у черзі — уже аномалія
      select 'undelivered_30d:' || count(*)
        from public.event_outbox
       where delivered_at is null and not dead
         and created_at < now() - interval '30 days'
      having count(*) > 0
    ) x;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'outbox_rows_overdue', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'outbox_rows_overdue', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 13. Увімкнене дзеркало GCal реально синкається (0161). pg_net у джобі
  --     fire-and-forget: job_run_details бачить лише «запит поставлено», а не
  --     HTTP-результат, тож застій роуту/секрету/платформних env видно тільки
  --     по сліду синка. enabled без last_sync_at, свіжішого за 30 хв (тик —
  --     2 хв), означає: дзеркало стоїть, а адмін вважає його живим. Для щойно
  --     увімкнених без жодного синка відлік від connected_at: updated_at НЕ
  --     годиться — його бампає кожен запис мети (зокрема last_error_code у
  --     циклі падінь), і перевірка замовкла б саме тоді, коли мусить кричати.
  --     У offenders — префікс clinic_id, МІТКА ГІЛКИ і вік останнього синка
  --     у хвилинах.
  --
  --     ⚠️ 0194: ДРУГА ГІЛКА — АВАРІЙНО ВИМКНЕНЕ. І причина, чому першої
  --        редакції не хватало, НЕ в тому, що хтось забув умову.
  --        ЗАМІРЯНО 14.09.2026 — `conname` плюс `pg_get_constraintdef`
  --        ДОСЛІВНО (мої тут лише переноси рядків):
  --          gcal_enabled_invariant_chk CHECK (((NOT enabled) OR ((status =
  --            'ready'::text) AND (calendar_id IS NOT NULL) AND
  --            (refresh_secret_id IS NOT NULL) AND (access_role IS NOT NULL)
  --            AND (access_role = ANY (ARRAY['writer'::text, 'owner'::text])))))
  --        Тобто `enabled = true` НЕМОЖЛИВЕ без
  --        `status = 'ready'`, а шлях фатальної відмови
  --        (`lib/googleCalendarService.ts`) атомарно ставить
  --        `enabled=false, status=<аварійний>, last_error_code=<той самий>`
  --        — інакше CHECK його не пустив би. Отже КОЖНА відмова ЗМУШЕНА
  --        вимкнути рядок, і `where g.enabled` перестає його бачити.
  --        Сторож був зелений 11,5 доби (I-7) не через недогляд предиката,
  --        а через те, що предикат стояв на полі, яке відмова ЗОБОВʼЯЗАНА
  --        перекинути. Перевірка «дзеркало живе» не може спиратись на
  --        прапорець, який гасне саме тоді, коли дзеркало вмирає.
  --
  --     ⚠️ ЧОМУ ДРУГА ГІЛКА НЕ ШУМИТЬ — таблиця станів `enabled=false`,
  --        узята з КОДУ, з адресами (не з голови):
  --          `not_connected`         — свідоме відключення
  --                                    (`disconnect/route.ts`; і
  --                                    `gcal_not_connected_empty_chk`
  --                                    вимагає обнулити секрет і календар)
  --                                    → НЕ offender;
  --          `connected_no_calendar` — середина налаштування
  --                                    (`callback/route.ts`) → НЕ offender;
  --          `ready` + enabled=false — адмін зняв галочку «резервна копія»
  --                                    (`enable/route.ts`) → НЕ offender.
  --                                    ⚠️ Але НЕВДАЛА спроба ввімкнути
  --                                    назад кличе `failClosedTransition`
  --                                    (`enable/route.ts`) і переводить
  --                                    рядок в аварійний статус — тобто
  --                                    свідомо вимкнене дзеркало МОЖЕ
  --                                    стати offender-ом через дію адміна;
  --          `reauth_required`       — відмова → OFFENDER;
  --          `access_lost`           — відмова → OFFENDER.
  --        Два аварійні статуси САМІ не проходять: обидва потребують
  --        людини. Тому поріг — БЕЗ відстрочки (рішення власника 14.09,
  --        `docs/audit/DECISIONS-2026-09-14-s69.md`): рядок стає offender-ом
  --        з першого прогону після відмови.
  --
  --     ⚠️ ЯК ЧАСТО ЦЕ БУВАЄ — ЗАМІРЯНО, а не оцінено. `important_events`
  --        дає дві НЕЗАЛЕЖНІ точки: `gcal_connected` 26.08 12:55:54 →
  --        `gcal_reauth_required` 02.09 12:56:03 (7 діб + 9 с) і
  --        27.08 11:16:36 → 03.09 11:18:01 (7 діб + 1 хв 25 с). Обидві —
  --        рівно 7 діб від ПІДКЛЮЧЕННЯ, а не від активності: стільки живе
  --        refresh-токен Google, поки OAuth-застосунок у статусі Testing.
  --        Отже гілка (b) — не рідкісна аварія, а ТИЖНЕВИЙ БУДИЛЬНИК, доки
  --        consent screen не опубліковано. Лікує це ПУБЛІКАЦІЯ, а не поріг:
  --        відстрочка лише пересунула б червоне, бо мертве дзеркало само не
  --        оживає.
  --
  --     ⚠️ ВИХОДІВ ІЗ ЧЕРВОНОГО ДВА, і перший — безпечний:
  --          1. «Підключити» знову: `callback/route.ts` ставить
  --             `connected_no_calendar` — offender зникає, інтеграція
  --             лишається. Обидва реальні виходи в проді 14.09 були саме
  --             такі (`integration.gcal_connected`, action=reconnect).
  --          2. «Відключити»: `disconnect/route.ts` → `not_connected`, але
  --             це НЕОБОРОТНО — `revokeToken` відкликає токен у Google і
  --             `vaultDeleteQuiet` видаляє секрет із Vault.
  --        ⚠️ ПЕРША РЕДАКЦІЯ ЦІЄЇ ПРОЗИ писала «вихід рівно один —
  --           Відключити», тобто гнала читача в НЕОБОРОТНУ дію там, де
  --           досить перепідключення. Знайшло ревʼю ПЕРЕД накатом; у тілі
  --           сторожа така порада коштувала б окремого пакета на зняття.
  --
  --     ⚠️ МЕЖА М-1: гілка (b) ловить відмову, ПРО ЯКУ БАЗА ЗНАЄ. Шлях,
  --        що гасить `enabled` НЕ перекидаючи `status`, лишиться невидимим
  --        для ОБОХ гілок: (a) не бачить через прапорець, (b) — через
  --        статус. Заміряно: у КОДІ таких шляхів нема (усі чотири місця,
  --        що пишуть `enabled=false`, перелічені вище). Але канал ширший за
  --        «ручний update з редактора»: RLS на таблиці УВІМКНЕНА і при цьому
  --        БЕЗ ЖОДНОЇ політики, а `UPDATE` має `service_role` — тобто так
  --        може зробити будь-що з service-role-ключем (Studio, n8n, разовий
  --        скрипт). Закриває це лише пін на самі ці шляхи.
  --     ⚠️ МЕЖА М-4, ширша і чесніша: ТІЛО САМОГО СТОРОЖА не пінить НІХТО.
  --        Заміряно 14.09: у списку №19 НУЛЬ підписів `invariants_check`,
  --        №23 пінить обʼєкти схеми (enum/CHECK/колонки/індекси/view), №7 —
  --        md5 ФАЙЛІВ міграцій. Отже `create or replace` сторожа повз
  --        міграцію не побачить ЖОДНА з 23 перевірок і жоден тест (тести
  --        читають файл на диску, а не `prosrc`). Саме так протухли піни
  --        g/g2 у `gcal_pg_cron_smoke.sql`. Це НЕ лікується цим пакетом —
  --        потрібен окремий: пін на власне тіло, що оновлюється генератором
  --        при кожному передруку.
  v_n := v_n + 1;
  /* 0174 */ begin
  select array_agg(x.txt order by x.txt) into v_tmp
    from (
      select left(g.clinic_id::text, 8) || ':' ||
             case when g.enabled then 'стоїть:'
                  else 'відвалилось(' || g.status || '):' end ||
             coalesce(floor(extract(epoch from now() - g.last_sync_at) / 60)::text || 'хв',
                      'ніколи') as txt
        from public.google_calendar_connections g
       where (g.enabled
              and coalesce(g.last_sync_at, g.connected_at, g.created_at)
                  < now() - interval '30 minutes')
          or (not g.enabled
              and g.status in ('reauth_required', 'access_lost'))
    ) x;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'gcal_sync_overdue', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'gcal_sync_overdue', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 14. Позначка непрочитаного не переживає рядок, на який вказує (0164/0165).
  --     Скарга власника с49: у сайдбарі «Дошка черги ①», календар веде на
  --     день, де НУЛЬ записів, а погасити крапку нічим — ack завʼязаний на
  --     ВІДРЕНДЕРЕНИЙ рядок, якого більше немає.
  --     Перевіряємо ОБИДВІ половини фікса.
  --     ПРОВОДКА: звіряємо не саме лише імʼя тригера, а ПАРУ (таблиця,
  --     аргумент) і AFTER DELETE — тригер із чужим аргументом виглядає живим
  --     і не робить нічого (0165, ревʼю 0164). Відсутність тригера ця ж гілка
  --     покриває: not exists хибний і тоді.
  --     НАСЛІДОК: сирота будь-де в таблиці — уже дефект.
  --     ⚠️ Гілка room звужена (0165). `tg_change_markers_services` і
  --     `tg_change_markers_sro` якорять каталог на `coalesce(new.room_id,
  --     new.clinic_id)`: для послуги рівня клініки entity_id — id КЛІНІКИ, і
  --     в `rooms` його немає ЗАВЖДИ. Позначка при цьому цілком жива — екран
  --     каталогу гасить ПОВЕРХНЮ, не сутність. Сиротою вважаємо лише те,
  --     чого немає ні в `rooms`, ні в `clinics`.
  --     ⚠️ 0204 (с80, Н-14, рішення власника 25.09) ДОДАЛА ГІЛКУ `unreachable:`:
  --        НЕПРОЧИТАНА позначка ЗАПИСУ (`queue_entry`, `waitlist_entry`,
  --        `patient_case`), чий отримувач не персонал центру позначки
  --        (`profiles.clinic_id` інший) і не має АКТИВНОГО гранту до нього. З
  --        0204 політики читання пускають за `created_by` / `referrer_id` лише
  --        з активним грантом, отже така позначка — крапка про запис, якого
  --        отримувач не бачить: `queue_entry` гаситься лише з відрендереного
  --        рядка (тобто ніколи), `patient_case` ack поки не має, а
  --        `waitlist_entry` направника гасить поверхня «Лист очікування», але
  --        до того крапка світить про рядок, якого в списку немає. Прочитані
  --        НЕ рахуємо свідомо: крапки вони не запалюють, а ретенція прибирає
  --        їх за 180 днів — інакше переведення персоналу з повністю
  --        прочитаними позначками червонило б ніч до пів року. Це пін
  --        ВЛАСТИВОСТІ, а не функцій: він червоніє і на вихолощеній мітлі
  --        `tg_ref_entry_markers_prune_on_access()` (її тіла №19 не пінить),
  --        і на відкаті умови гранту в `change_marker_recipients` (гілка
  --        `entry`). Формат — `unreachable:<тип>:<кількість>`, без uuid.
  --        ⚠️ МЕЖІ, названі вголос:
  --         • гонка «емісія позначки ‖ відкликання гранту» (READ COMMITTED)
  --           може лишити НОВИЙ рядок позначки за БУДЬ-ЯКОГО порядку commit:
  --           (а) першою — емісія: рядок, вставлений емітером, закомічено вже
  --           після DELETE мітли, тож мітла його не бачила (UPSERT НАЯВНОЇ
  --           позначки в цьому порядку мітла дочекається і видалить);
  --           (б) першим — відкликання: UPSERT емітера, що ще бачив грант
  --           активним, чекає на рядок, який видаляє мітла, а після commit
  --           відкликання конфлікту вже не має і вставляє НОВИЙ рядок.
  --           №14 ловить обидва порядки; тоді — ручна зачистка ЛИШЕ за явним
  --           списком id зі свіжого знімка (правило AGENTS.md про видалення
  --           даних проду). Закрити обидва порядки — `for share` на рядку
  --           гранту в емітерах записів (PR-0204, §12);
  --         • отримувач без профілю (видалений акаунт: `delete_clinic_member`
  --           знімає радіолога разом із профілем, а позначки лишаються) сюди НЕ
  --           потрапляє — join із `profiles`. Це окремий клас «позначка
  --           невідомому отримувачу» (0134), і червоніти на штатному
  --           видаленні радіолога ця гілка не мусить;
  --         • персонал, якого службова роль перевела в інший центр, лишає
  --           НЕПРОЧИТАНІ позначки старого центру недосяжними — гілка їх
  --           НАЗВЕ, мітла не зніме (її тригер — на `referral_access`, не на
  --           `profiles`): переводити разом із зачисткою за явним списком id
  --           (процедура — AGENTS.md).
  --     ⚠️ referral_access НЕ рахуємо свідомо: його DELETE-гілка емітить
  --     позначку НАВМИСНО (борг U-38 — перенести якір на сутність, що
  --     переживає видалення).
  v_n := v_n + 1;
  /* 0174 */ begin
  v_tmp := null;
  select array_agg(x.txt order by x.txt) into v_tmp
    from (
      select 'bad_trigger:' || t.tbl as txt
        from (values ('queue_entries', 'queue_entry'), ('waitlist_entries', 'waitlist_entry'),
                     ('patient_cases', 'patient_case'), ('incidents', 'incident'),
                     ('rooms', 'room')) as t(tbl, arg)
       where not exists (
               select 1 from pg_trigger g
                 join pg_class c     on c.oid = g.tgrelid
                 join pg_namespace n on n.oid = c.relnamespace
                where not g.tgisinternal and n.nspname = 'public'
                  and c.relname = t.tbl and g.tgname = 'trg_zzz_markers_purge'
                  and pg_get_triggerdef(g.oid) like '%AFTER DELETE%'
                  and pg_get_triggerdef(g.oid)
                      like '%tg_change_markers_purge(''' || t.arg || ''')%')
      union all
      select 'orphan:queue_entry:' || count(*)
        from public.user_change_markers m
       where m.entity_type = 'queue_entry'
         and not exists (select 1 from public.queue_entries x where x.id = m.entity_id)
      having count(*) > 0
      union all
      select 'orphan:waitlist_entry:' || count(*)
        from public.user_change_markers m
       where m.entity_type = 'waitlist_entry'
         and not exists (select 1 from public.waitlist_entries x where x.id = m.entity_id)
      having count(*) > 0
      union all
      select 'orphan:patient_case:' || count(*)
        from public.user_change_markers m
       where m.entity_type = 'patient_case'
         and not exists (select 1 from public.patient_cases x where x.id = m.entity_id)
      having count(*) > 0
      union all
      select 'orphan:incident:' || count(*)
        from public.user_change_markers m
       where m.entity_type = 'incident'
         and not exists (select 1 from public.incidents x where x.id = m.entity_id)
      having count(*) > 0
      union all
      select 'orphan:room:' || count(*)
        from public.user_change_markers m
       where m.entity_type = 'room'
         and not exists (select 1 from public.rooms   x where x.id = m.entity_id)
         and not exists (select 1 from public.clinics x where x.id = m.entity_id)
      having count(*) > 0
      union all
      -- 0204 (Н-14): НЕПРОЧИТАНА позначка ЗАПИСУ, якого отримувач не бачить —
      -- він не персонал центру позначки і не має АКТИВНОГО гранту до нього
      select 'unreachable:' || m.entity_type || ':' || count(*)
        from public.user_change_markers m
        join public.profiles p on p.id = m.recipient_id
       where m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')
         and m.seen_at is null
         and p.clinic_id is distinct from m.clinic_id
         and not exists (select 1 from public.referral_access ra
                          where ra.referrer_id = m.recipient_id
                            and ra.clinic_id = m.clinic_id
                            and ra.status = 'active')
       group by m.entity_type
    ) x;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'ucm_orphan_markers', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'ucm_orphan_markers', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 15. Дрейф привілеїв (0166, посилено 0167 за наслідками ревʼю). Гілки — про
  --     поверхню, якої RLS НЕ бачить: TRUNCATE ігнорує політики й не будить
  --     тригери, а DELETE на `incidents` застосунок не використовує ніде.
  --     `service_role` свідомо НЕ перевіряємо (канон 0163, зона c).
  --
  --     ⚠️ Що виправило 0167 і чому кожне — не косметика:
  --      • РОЛІ більше не хардкод: беремо всіх членів `authenticator`, тобто
  --        всі ролі, досяжні через PostgREST. Із парою ('anon','authenticated')
  --        нова клієнтська роль (портал, кіоск) була б невидима сторожу з дня
  --        появи до дня, коли хтось згадає.
  --      • relkind += 'f': foreign table (Wrappers) створює `supabase_admin` —
  --        рівно той грантор, якого ми не контролюємо і компенсуємо гілкою (a).
  --      • default-ACL: `alter default privileges` БЕЗ `in schema` лягає з
  --        defaclnamespace = 0 і діє на public теж. inner join її губив —
  --        «головна» гілка обходилась пропуском двох слів.
  --      • grantee = 0 (PUBLIC) тепер теж порушник: грант на PUBLIC дає привілей
  --        і anon, і authenticated, а `revoke … from anon` його не знімає.
  --      • `to_regclass` замість прямого приведення: зникла таблиця мусить дати
  --        offender, а не вбити ВСЮ функцію винятком (тоді cron мовчить, і
  --        порожній журнал читається як «сторож не крутиться»).
  --      • політики звужені до permissive і до клієнтських ролей: інакше
  --        звичайний `for all to service_role` або restrictive deny-all робив
  --        би перевірку вічно червоною, а вічно червона = знята (урок 0141).
  --      • (e): сама РОЗТЯЖКА. Без неї тригер знімався `drop trigger` мовчки —
  --        його імені не знав жоден живий сторож.
  v_n := v_n + 1;
  /* 0174 */ begin
  v_tmp := null;
  select array_agg(x.txt order by x.txt) into v_tmp
    from (
      -- (a) TRUNCATE у будь-якої клієнтської ролі на будь-якому обʼєкті public
      select 'truncate:' || r.rol || ':' || c.relname as txt
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        cross join (select g.rolname as rol
                      from pg_auth_members m
                      join pg_roles g on g.oid = m.roleid
                      join pg_roles a on a.oid = m.member
                     where a.rolname = 'authenticator'
                       and g.rolname <> 'service_role') r
       where n.nspname = 'public'
         and c.relkind in ('r', 'p', 'v', 'm', 'f')
         and has_table_privilege(r.rol, c.oid, 'TRUNCATE')
      union all
      -- (b) …і НОВА таблиця не сміє отримати його за замовчуванням
      select 'default_acl:' || d.defaclrole::regrole::text
             || ':' || coalesce(n.nspname, '*')
             || ':' || coalesce(nullif(a.grantee::regrole::text, '-'), 'PUBLIC')
        from pg_default_acl d
        left join pg_namespace n on n.oid = d.defaclnamespace
        cross join lateral aclexplode(d.defaclacl) a
       where (d.defaclnamespace = 0 or n.nspname = 'public')
         and d.defaclobjtype = 'r'
         and d.defaclrole = 'postgres'::regrole
         and a.privilege_type = 'TRUNCATE'
         and (a.grantee = 0 or a.grantee::regrole::text in ('anon', 'authenticated'))
      union all
      -- (c) DELETE на простоях: застосунок не видаляє їх ніде
      select 'incidents_delete:' || coalesce(r.rol, '?')
        from (select g.rolname as rol
                from pg_auth_members m
                join pg_roles g on g.oid = m.roleid
                join pg_roles a on a.oid = m.member
               where a.rolname = 'authenticator'
                 and g.rolname <> 'service_role') r
       where to_regclass('public.incidents') is not null
         and has_table_privilege(r.rol, 'public.incidents', 'DELETE')
      union all
      -- (c2) …і сама таблиця на місці: її зникнення — offender, а не виняток
      select 'incidents_missing'
       where to_regclass('public.incidents') is null
      union all
      -- (d) …і жодна PERMISSIVE політика для клієнтської ролі не відкриває DELETE
      select 'incidents_policy:' || p.polname
        from pg_policy p
       where to_regclass('public.incidents') is not null
         and p.polrelid = to_regclass('public.incidents')
         and p.polcmd in ('*', 'd')
         and p.polpermissive
         and (p.polroles = '{0}'::oid[]
              or exists (select 1 from pg_roles q
                          where q.oid = any(p.polroles)
                            and q.rolname in ('anon', 'authenticated')))
      union all
      -- (e) РОЗТЯЖКИ 0163/0166 на місці, BEFORE DELETE ROW і НЕ security definer
      select 'tripwire:' || t.tbl
        from (values ('queue_entries'), ('waitlist_entries'), ('incidents')) as t(tbl)
       where not exists (
               select 1 from pg_trigger g
                 join pg_class c on c.oid = g.tgrelid
                where not g.tgisinternal and c.relnamespace = 'public'::regnamespace
                  and c.relname = t.tbl and g.tgname = 'a01_no_client_delete'
                  and (g.tgtype & 1) > 0 and (g.tgtype & 2) > 0 and (g.tgtype & 8) > 0)
      union all
      select 'tripwire_definer:' || pr.proname
        from pg_proc pr
       where pr.pronamespace = 'public'::regnamespace
         and pr.proname in ('guard_no_client_delete', 'guard_no_client_delete_incident')
         and pr.prosecdef
      union all
      -- (f) RF-09: одноразовий токен запрошення НЕ читається клієнтськими ролями
      --     ЧЕРЕЗ КОЛОНКОВІ ACL ТАБЛИЦІ — і лише через них (0179: definer-RPC
      --     стережуть (g2) і №19, аудит-слід — (g); роут /api/ceo/grant —
      --     поведінковий тест, поза базою).
      --     ⚠️ Заміряно на чернетці в проді, а не припущено: колоночний
      --     `revoke select (invite_token)` ПОВЕРХ табличного гранта не робить
      --     нічого — has_column_privilege лишається true. Знімає доступ лише
      --     пара «revoke select ON TABLE» + «grant select (перелік колонок)».
      --     Тому сторож перевіряє КОЛОНКОВЕ право: has_table_privilege(...,
      --     'SELECT') після allow-list = false і зеленою перевірку не зробить.
      select 'invite_token_readable:' || r.rol
        from (select g.rolname as rol
                from pg_auth_members m
                join pg_roles g on g.oid = m.roleid
                join pg_roles a on a.oid = m.member
               where a.rolname = 'authenticator'
                 and g.rolname <> 'service_role') r
       where exists (select 1 from pg_attribute a
                      where a.attrelid = to_regclass('public.profiles')
                        and a.attname = 'invite_token'
                        and a.attnum > 0 and not a.attisdropped)
         and has_column_privilege(r.rol, 'public.profiles', 'invite_token', 'SELECT')
      union all
      -- (f2) …і allow-list УТВЕРДЖУВАЛЬНИЙ у другий бік: кожна ІНША колонка
      --      profiles мусить лишатись читаною. Табличного гранта більше немає,
      --      тож НОВА колонка не отримає права автоматично — і сторож
      --      почервоніє того ж дня, замість мовчазного «екран порожній».
      select 'profiles_column_not_granted:' || r.rol || ':' || c.attname
        from pg_attribute c
        cross join (select g.rolname as rol
                      from pg_auth_members m
                      join pg_roles g on g.oid = m.roleid
                      join pg_roles a on a.oid = m.member
                     where a.rolname = 'authenticator'
                       and g.rolname <> 'service_role') r
       where c.attrelid = to_regclass('public.profiles')
         and c.attnum > 0 and not c.attisdropped
         and c.attname not in ('invite_token', 'invite_issued_at')
         and not has_column_privilege(r.rol, 'public.profiles', c.attname, 'SELECT')
      union all
      -- (f3) …і сама колонка на місці: її зникнення зробило б (f) вічно зеленою
      --      (той самий урок, що (c2) про incidents).
      select 'profiles_invite_token_missing'
       where to_regclass('public.profiles') is not null
         and not exists (select 1 from pg_attribute a
                          where a.attrelid = to_regclass('public.profiles')
                            and a.attname = 'invite_token'
                            and a.attnum > 0 and not a.attisdropped)
      union all
      -- (g) RF-09c (0179): у audit_log НЕМАЄ жодного рядка з НЕПОРОЖНІМ
      --     invite_token у before/after. ⚠️ Саме ЗНАЧЕННЯ, а не ключ: до 0179
      --     fn_audit писав рядок profiles цілком, тож ключ із null стоїть у
      --     ~70 старих записах і дірою не є. fn_audit тепер віднімає ключ
      --     (тіло пінить №19); чотири історичні значення зачищено 0179-ю.
      --     Червоніє і на новому запису з токеном (fn_audit підмінено, або
      --     хтось пише в audit_log повз тригер), і на поверненні старих.
      select 'audit_log_invite_token:' || l.id::text
        from public.audit_log l
       where to_regclass('public.audit_log') is not null
         and (coalesce(l.before->>'invite_token', '') <> ''
              or coalesce(l.after->>'invite_token', '') <> '')
      union all
      -- (g2) RF-09b (0179): жодна SECURITY DEFINER функція public, яку може
      --      викликати клієнтська роль, не ТОРКАЄТЬСЯ `invite_token` — ні в
      --      сигнатурі результату, ні в аргументах, ні в ТЕКСТІ тіла, і не
      --      повертає рядок `profiles` цілком (`returns [setof] profiles` —
      --      там імені колонки в сигнатурі немає; знахідка ревʼю А/Б с59) —
      --      КРІМ названого винятку ceo_list_for_clinic(p_clinic uuid), яка
      --      тримає колонку заради RPC-контракту і чиє ТІЛО (`null::text as
      --      invite_token`) пінить №19. Колонковий грант 0178 на
      --      definer-функцію не поширюється взагалі — тому ця гілка, а не (f).
      --      Згадка в тілі — теж порушник, навіть у коментарі: така функція
      --      мусить пройти ревʼю і потрапити в №19, а не пройти мовчки.
      --      ⚠️ Названа межа: `returns jsonb` з `to_jsonb(p)` / `select *`
      --      без слова invite_token у тілі — не ловиться. Це рішення ревʼю.
      select 'definer_returns_invite_token:' || r.rol || ':' || pr.proname
             || '(' || pg_get_function_identity_arguments(pr.oid) || ')'
        from pg_proc pr
        cross join (select g.rolname as rol
                      from pg_auth_members m
                      join pg_roles g on g.oid = m.roleid
                      join pg_roles a on a.oid = m.member
                     where a.rolname = 'authenticator'
                       and g.rolname <> 'service_role') r
       where pr.pronamespace = 'public'::regnamespace
         and pr.prokind = 'f'
         and pr.prosecdef
         and has_function_privilege(r.rol, pr.oid, 'EXECUTE')
         and (pg_get_function_result(pr.oid) ~ '\minvite_token\M'
              or pg_get_function_arguments(pr.oid) ~ '\minvite_token\M'
              or pr.prosrc ~ '\minvite_token\M'
              or pr.prorettype = to_regtype('public.profiles'))
         and not (pr.proname = 'ceo_list_for_clinic'
                  and pg_get_function_identity_arguments(pr.oid) = 'p_clinic uuid')
    ) x;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'priv_drift', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'priv_drift', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 16. ТІЛА RLS-ПОЛІТИК не змінились. Перевірка №3 стежить, що RLS УВІМКНЕНО,
  --     але не за тим, що політика КАЖЕ. `alter policy queue_ceo_read using
  --     (true)` лишав зеленими всі 15 інваріантів, увесь гейт і всі 24 стенди —
  --     а черга пацієнтів ставала видимою кожному залогіненому. Правку політики
  --     роблять в UI Supabase, мимо репозиторію і мимо db:gate, тому сторож
  --     мусить стояти ТУТ, у самій базі, а не в юніт-тесті.
  --
  --     Дайджест = md5(cmd|permissive|roles|qual|with_check) з нормалізованими
  --     пробілами (та сама нормалізація, що в 0143). Очікуваний список — 63
  --     рядки, зняті з прода 03.09.2026 (0183: мінус `sched_referrer_read` —
  --     RF-03 зняла її, графік дня направник тепер читає через
  --     `sched_override_read`). Політика поза списком, зникла політика
  --     і політика зі зміненим тілом дають offender із префіксом new:/missing:/
  --     changed:.
  --
  --     ⚠️ Список ХАРДКОДОМ, а не таблицею — свідомо. Таблиця отримала б
  --     дефолтні GRANT-и Supabase, зажадала б власної RLS і стала б ще однією
  --     поверхнею; до того ж правити її було б так само легко, як і політику.
  --     Це той самий канон, що в перевірці №8 (canonical_objects): єдиний
  --     хардкод у сторожі, і він FAIL-LOUD.
  --
  --     ⚠️ ПАСТКА, ЯКУ ТРЕБА ЗНАТИ ЗАЗДАЛЕГІДЬ: `pg_get_expr` рендерить вираз
  --     засобами САМОГО Postgres. Мажорний апгрейд може перерендерити вирази і
  --     змінити ВСІ 64 дайджести одразу. Якщо offenders — це весь список, це
  --     майже напевно апгрейд, а не дефект: перезніміть дайджести запитом і
  --     випустіть нову міграцію. Якщо змінилось кілька — читайте кожну.
  --
  --     ⚠️ 0204 (с80, Н-14, рішення власника 25.09: «відкликання гранту
  --        забирає читання») ПЕРЕЗНЯЛА ТРИ ДАЙДЖЕСТИ, список той самий (63):
  --        `queue_select`, `waitlist_select`, `cases_select_referrer` — гілка
  --        читання за `created_by` / `referrer_id` тепер вимагає `clinic_id in
  --        (select auth_referrer_clinics())`, тобто АКТИВНИЙ грант до центру
  --        запису. Дайджести — рецептом №16 від рендеру `pg_policies`;
  --        реплей PG16 рендерить ті самі вирази, що й прод.
  --        ⚠️ ПОБІЧНІ НАСЛІДКИ, названі вголос: радіолог більше не бачить
  --           записів, створених ним поза своїми кабінетами; персонал, що
  --           змінив центр, — створених ним записів старого центру (обидва
  --           читали їх лише за `created_by`). Політики запису
  --           `queue_write_referrer` (FOR ALL) і `waitlist_write_referrer`
  --           грант уже вимагали — 0204 їх не чіпала.
  v_n := v_n + 1;
  /* 0174 */ begin
  v_tmp := null;
  with cur as (
    select p.tablename as tbl, p.policyname as pol,
           substr(md5(coalesce(p.cmd, '') || '|' || coalesce(p.permissive, '') || '|'
                      || coalesce(array_to_string(array(select unnest(p.roles) order by 1), ','), '') || '|'
                      || coalesce(regexp_replace(p.qual, '\s+', ' ', 'g'), '') || '|'
                      || coalesce(regexp_replace(p.with_check, '\s+', ' ', 'g'), '')), 1, 12) as dig
      from pg_policies p
     where p.schemaname = 'public'
  ), expd(tbl, pol, dig) as (values
      ('audit_log','audit_read_admin','0bff14ae6a42'),
      ('audit_log','audit_read_ceo','3e5b95410350'),
      ('ceo_access','ceo_access_clinic_select','0bff14ae6a42'),
      ('ceo_access','ceo_access_self_select','cd9b75e0f07f'),
      ('cities','cities_read','ddb105886794'),
      ('clinics','clinics_ceo_read','d2a398521499'),
      ('clinics','clinics_referrer_read','bbce4bbb16af'),
      ('clinics','clinics_select','838540bec8ec'),
      ('clinics','clinics_update','0661d4aa1949'),
      ('doctors','doctors_admin_delete','795bae4ce05a'),
      ('doctors','doctors_desk_insert','7b209df671b9'),
      ('doctors','doctors_desk_update','e90972140a28'),
      ('doctors','doctors_staff_read','e0b8b286c2fa'),
      ('important_events','imp_events_read_admin','0bff14ae6a42'),
      ('important_events','imp_events_read_ceo','1303b9136217'),
      ('incidents','incidents_desk_insert','7b209df671b9'),
      ('incidents','incidents_desk_update','e90972140a28'),
      ('incidents','incidents_referrer_read','69ad711c837d'),
      ('incidents','incidents_staff_read','e0b8b286c2fa'),
      ('patient_cases','cases_insert_referrer','4be3aa74fc37'),
      ('patient_cases','cases_insert_staff','6c7f373d9ace'),
      ('patient_cases','cases_select_referrer','a406bc42d13d'),
      ('patient_cases','cases_select_staff','83b26dc176c3'),
      ('patient_cases','cases_update_referrer','638808297f08'),
      ('patient_cases','cases_update_staff','d5308fbd7471'),
      ('profiles','profiles_admin_update','44f438fe46d4'),
      ('profiles','profiles_ceo_linked_read','ac10375a7caa'),
      ('profiles','profiles_referrer_linked_read','a528c063f550'),
      ('profiles','profiles_select','1c2e905b3bb4'),
      ('profiles','profiles_select_self','ec081b3c84d1'),
      ('profiles','profiles_update_self','0c39acfee4d2'),
      ('queue_delay_events','queue_delay_events_read','5ebf41dbb122'),
      ('queue_entries','queue_ceo_read','1303b9136217'),
      ('queue_entries','queue_select','6061c08c210b'),
      ('queue_entries','queue_write_referrer','63f73cd306f8'),
      ('queue_entries','queue_write_staff','324459a5b1e0'),
      ('radiologist_rooms','radrooms_admin_write','c21bd5396ddc'),
      ('radiologist_rooms','radrooms_select','1c2e905b3bb4'),
      ('referral_access','ra_clinic_select','0bff14ae6a42'),
      ('referral_access','ra_referrer_select','f9962569e8f9'),
      ('referrer_private','rp_owner_insert','34475fbc1736'),
      ('referrer_private','rp_owner_select','f9962569e8f9'),
      ('referrer_private','rp_owner_update','da7bdffa3291'),
      ('rooms','rooms_admin_write','eee3dc73cfb6'),
      ('rooms','rooms_ceo_read','1303b9136217'),
      ('rooms','rooms_referrer_read','2a0c768ca852'),
      ('rooms','rooms_staff_read','e0b8b286c2fa'),
      ('schedule_exceptions','schedule_exceptions_read','5ebf41dbb122'),
      ('schedule_overrides','sched_desk_write','f87661ae82df'),
      ('schedule_overrides','sched_staff_read','e0b8b286c2fa'),
      ('service_room_overrides','sro_admin_write','b9d7dd442700'),
      ('service_room_overrides','sro_ceo_read','3d9c0b1b1d7e'),
      ('service_room_overrides','sro_referrer_read','eb6f3185b71a'),
      ('service_room_overrides','sro_staff_read','3280cf08e5e9'),
      ('services','services_admin_write','eee3dc73cfb6'),
      ('services','services_ceo_read','3d9c0b1b1d7e'),
      ('services','services_referrer_read','a3b79314201c'),
      ('services','services_staff_read','e0b8b286c2fa'),
      ('user_change_markers','ucm_read_own','466b41e483eb'),
      ('waitlist_entries','waitlist_ceo_read','1303b9136217'),
      ('waitlist_entries','waitlist_select','0cf225150efe'),
      ('waitlist_entries','waitlist_write_referrer','6cf1f4ffb36d'),
      ('waitlist_entries','waitlist_write_staff','6e7d1eaf04a1')
  )
  select array_agg(x.what order by x.what) into v_tmp
  from (
    select 'changed:' || c.tbl || '.' || c.pol as what
      from cur c join expd e on e.tbl = c.tbl and e.pol = c.pol
     where e.dig <> c.dig
    union all
    select 'new:' || c.tbl || '.' || c.pol
      from cur c
     where not exists (select 1 from expd e where e.tbl = c.tbl and e.pol = c.pol)
    union all
    select 'missing:' || e.tbl || '.' || e.pol
      from expd e
     where not exists (select 1 from cur c where c.tbl = e.tbl and c.pol = e.pol)
  ) x;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'policy_digest', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'policy_digest', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;
  -- 17. ГАРДИ-ТРИГЕРИ І АУДИТ: на місці, УВІМКНЕНІ і ДОСЛІВНО ті самі.
  --
  --     ⚠️ 0173 ДОДАВ ШІСТЬ АУДИТ-ТРИГЕРІВ (14 → 20), і це закриття НАЗВАНОЇ
  --        межі 0172, а не нова ідея. Замір, який її довів: у транзакції з
  --        відкотом знято `trg_audit_profiles` (тригерів 1 → 0) і викликано
  --        сторожа — `ok:true, checked:19, failed:[]`. Тобто аудит-слід на
  --        таблиці, де міняються РОЛІ, вимикався однією командою при всіх
  --        девʼятнадцяти зелених інваріантах. Тіло `fn_audit` пінить №19,
  --        але тіло не каже, що функція до чогось прицеплена.
  --        Усі шість — `AFTER INSERT OR DELETE OR UPDATE`, усі кличуть
  --        `fn_audit()`, і інших тригерів у цієї функції немає (звірено).
  --
  --     ЧОМУ. Правильність RLS на PII-таблицях тримається не на політиках, а
  --     на BEFORE-тригерах. `profiles_update_self` дозволяє власнику рядка
  --     UPDATE усіх колонок, разом із `role` (GRANT `authenticated` UPDATE —
  --     на всі); відмовляє ТРИГЕР `guard_profile_privileges`. Знятий або
  --     ВИКЛЮЧЕНИЙ тригер відкриває самоескалацію до `admin` — і до цієї
  --     міграції жоден сторож про вимкнення не питав: слова `tgenabled` у тілі
  --     не було ВЗАГАЛІ, при зелених 16 інваріантах.
  --
  --     ⚠️ КЛЮЧ — ПАРА (таблиця, тригер), а не імʼя (урок 0165). Імена тут
  --        повторюються: `a01_no_client_delete` на трьох таблицях,
  --        `a00_radiologist_no_write` на двох, `guard_room_in_clinic` під
  --        двома різними іменами. Пін по імені звіряв би ЧУЖІ пари.
  --
  --     ⚠️ ПІНИМО `pg_get_triggerdef` ЦІЛКОМ, а не «форму» з `tgtype`. Перша
  --        редакція цієї перевірки (та сама сесія) звіряла timing/level/події —
  --        і два раунди ревʼю знайшли ТРИ дірки, кожну підтверджено запитом:
  --         • СПИСОК КОЛОНОК у `tgtype` не кодується. ШІСТЬ із чотирнадцяти
  --           ГАРДІВ уже стоять як `UPDATE OF …` (room_id/clinic_id, case_id,
  --           status, doctor/referrer_id). Звузити список до однієї колонки —
  --           `tgtype` не міняється ні на біт, а гард не зветься зовсім.
  --         • `WHEN (…)` (`tgqual`) теж поза `tgtype`: `when (false)` лишав би
  --           перевірку зеленою назавжди (сьогодні `WHEN` немає в жодного —
  --           звірено).
  --         • функція звірялась голим `proname`, БЕЗ схеми: тригер, переведений
  --           на `z.guard_profile_privileges()`, задовольняв пін.
  --        `pg_get_triggerdef` несе всі три і рендерить схему функції, щойно
  --        вона поза `search_path`. Пробіли нормалізуємо: рендер їх розставляє
  --        по-своєму.
  --
  --     ⚠️ ДРУГА ГІЛКА — БЕЗ СПИСКУ. Вимкненню імена не потрібні: будь-який
  --        не-внутрішній тригер `public` із `tgenabled` не з ('O','A') —
  --        порушник. Так під наглядом усі 76, а не 20: `disable trigger` на
  --        емісії в outbox чи на аудиті мовчазний рівно так само.
  --        `'A'` (ENABLE ALWAYS) проходить НАВМИСНО — це посилення; інакше
  --        укріплення гарда зробило б інваріант вічно червоним, а вічно
  --        червоний = знятий (урок 0141).
  --
  --     ⚠️ СВІДОМЕ ПЕРЕКРИТТЯ з №15 (e) на ТРЬОХ рядках із двадцяти
  --        (`a01_no_client_delete`). Розтяжка вже пінить їхнє існування і біти
  --        `tgtype`; тут вони знову — щоб `tgenabled` та ІНВЕНТАР гардів мали
  --        одну домівку. Обидва очікування читають ОДИН живий каталог, тож
  --        розійтись мовчки не можуть; ціна — свідома правка `a01` червонить
  --        ДВІ перевірки, а не одну.
  --
  --     ⚠️ ЦІНА ПІНА: рядок довгий, і при СВІДОМІЙ правці тригера його треба
  --        перезняти — команда в хвості файла. Та сама ціна, що №16 платить за
  --        політики, і платиться свідомо.
  --
  --     ⚠️ НАЗВАНІ МЕЖІ — жодну не ховаємо:
  --        • ТІЛО функції гарда не пінимо: вихолощене тіло
  --          (`… return new;`) лишить перевірку зеленою. Дайджест тіл гардів —
  --          окрема міграція, як №16 зробив для політик.
  --        • `set session_replication_role = 'replica'` гасить УСІ тригери, не
  --          торкаючись каталогу. Каталожна перевірка цього не бачить
  --          В ПРИНЦИПІ — ні ця, ні будь-яка інша.
  --        • ЗАЙВИЙ НОВИЙ тригер (гілка `new:`) порушником НЕ вважається:
  --          інвентар усіх 76 перетворив би кожну правку на ритуал «допиши в
  --          список». Це рішення власника, а не пропуск.
  --
  --     ⚠️ 0203 (с79, рішення власника 24–25.09: Р2(б), Н-9, Р-1, Р-2) ДОДАЛА
  --        СІМ ПАР (23 → 30), `checked` той самий:
  --         • ЧОТИРИ аудит-тригери `trg_audit_*` — на `patient_cases`,
  --           `doctors`, `referrer_private` (ПІІ) і `services` (прайс:
  --           невідновна правка; привід — RF-03, 26.08 за одну мілісекунду
  --           змінились 37 позицій, відновити було нічим). Функція та сама —
  --           `fn_audit()`; її тіло пінить №19, і 0203 його НЕ змінювала.
  --         • ТРИ гарди `zz_guard_read_keys` — на `queue_entries`,
  --           `waitlist_entries`, `patient_cases`, `BEFORE INSERT OR UPDATE`
  --           БЕЗ списку колонок. `referrer_id` і `created_by` — КЛЮЧІ
  --           ЧИТАННЯ: політики читання пропускають їх без гранту і центру,
  --           тож ключ без законного доступу до центру запису гард ставить
  --           у NULL (не відмова; слід — warning READ_KEY_CLEARED у лозі
  --           сервера, без uuid і ПДн). Імʼя `zz_` — щоб гард ішов
  --           ОСТАННІМ серед BEFORE-тригерів рядка і бачив остаточні ключі.
  --        ⚠️ МЕЖІ 0203, названі вголос:
  --         • тут лише ВИЗНАЧЕННЯ тригерів; тіло `guard_record_read_keys()`
  --           тримає №19 (0203 внесла його туди ж, 59 → 60) — так само, як
  --           тіла одинадцяти гардів 0171–0172. Фальсифікація 0203 вихолощує
  --           тіло і вимагає `body:` саме від №19, а не від цієї перевірки;
  --         • ПОРЯДОК спрацювання з 0204 пінить гілка `order:` (Н-17, абзац
  --           0204 нижче): новий BEFORE-тригер з імʼям, що за абеткою після
  --           гарда, червонить ніч, навіть створений поза міграціями; статичний
  --           тест пакета (`tests/auditPiiReferrerGrant.test.ts`) лишається;
  --         • `referrer_private` не має ні `id`, ні `clinic_id`: `fn_audit`
  --           пише `row_id` і `clinic_id` NULL. Такий рядок бачить лише
  --           службова роль (читання `audit_log` — за `clinic_id`), тобто
  --           приватна пошта направника адміну центру не відкривається;
  --           звʼязок із направником — поле `referrer_id` у before/after;
  --         • список ІМЕННИЙ: нова таблиця з ПІБ без аудит-тригера цій
  --           перевірці невидима — гілки за властивістю 0203 не додає.
  --
  --     ⚠️ 0204 (с80, Н-14 і Н-17) ДОДАЛА ПАРУ І ГІЛКУ, `checked` той самий:
  --         • пара `referral_access` / `trg_zzz_ref_entry_markers_prune`
  --           (30 → 31) — мітла позначок ЗАПИСІВ, коли грант перестає бути
  --           активним (UPDATE з active, DELETE активного, зміна пари
  --           направник/центр). Без неї відкликаний направник лишався б із
  --           вічними крапками: з 0204 записів цього центру він не бачить.
  --           Тіло `tg_ref_entry_markers_prune_on_access()` №19 НЕ пінить (як
  --           і сусідньої мітли графіка) — вихолощене тіло ловить №14 гілкою
  --           `unreachable:`;
  --         • гілка `order:<таблиця>-><тригер>` (Н-17): на `patient_cases`,
  --           `queue_entries`, `waitlist_entries` ОСТАННІЙ за `tgname collate
  --           "C"` не-внутрішній BEFORE-тригер рядка на INSERT/UPDATE мусить
  --           бути `zz_guard_read_keys` — бічний підзапит дослівно з асерту
  --           накату 0203. Пізніший BEFORE-тригер (`zzz_…`), що правив би
  --           ключ, обійшов би гард мовчки — тепер його назве ніч, навіть якщо
  --           його створено поза міграціями. Вимкнені тригери теж рахуються:
  --           їх можуть увімкнути. Таблиці — через `to_regclass`: зникла
  --           таблиця дає `missing:` пари гарда, а не виняток на всю перевірку.
  --        ⚠️ МЕЖІ 0204: `session_replication_role = replica` гасить усі
  --           тригери, не торкаючись каталогу (межа вище); таблиця без жодного
  --           BEFORE-тригера рядка дає не `order:`, а `missing:` пари гарда.
  v_n := v_n + 1;
  /* 0174 */ begin
  v_tmp := null;
  select array_agg(x.txt order by x.txt) into v_tmp
    from (
      select case when a.def is null
                  then 'missing:' || e.tbl || '.' || e.tg
                  else 'wrong_def:' || e.tbl || '.' || e.tg || '->' || a.def
             end as txt
        from (values
      ('ceo_access','trg_audit_ceo_access','CREATE TRIGGER trg_audit_ceo_access AFTER INSERT OR DELETE OR UPDATE ON public.ceo_access FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('doctors','trg_audit_doctors','CREATE TRIGGER trg_audit_doctors AFTER INSERT OR DELETE OR UPDATE ON public.doctors FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('incidents','a01_no_client_delete','CREATE TRIGGER a01_no_client_delete BEFORE DELETE ON public.incidents FOR EACH ROW EXECUTE FUNCTION guard_no_client_delete_incident()'),
      ('incidents','trg_audit_incidents','CREATE TRIGGER trg_audit_incidents AFTER INSERT OR DELETE OR UPDATE ON public.incidents FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('incidents','trg_guard_incident_room','CREATE TRIGGER trg_guard_incident_room BEFORE INSERT OR UPDATE OF room_id, clinic_id ON public.incidents FOR EACH ROW EXECUTE FUNCTION guard_room_in_clinic()'),
      ('patient_cases','a00_radiologist_no_write','CREATE TRIGGER a00_radiologist_no_write BEFORE INSERT OR DELETE OR UPDATE ON public.patient_cases FOR EACH ROW EXECUTE FUNCTION guard_radiologist_no_write()'),
      ('patient_cases','trg_audit_patient_cases','CREATE TRIGGER trg_audit_patient_cases AFTER INSERT OR DELETE OR UPDATE ON public.patient_cases FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('patient_cases','zz_guard_read_keys','CREATE TRIGGER zz_guard_read_keys BEFORE INSERT OR UPDATE ON public.patient_cases FOR EACH ROW EXECUTE FUNCTION guard_record_read_keys()'),
      ('profiles','trg_audit_profiles','CREATE TRIGGER trg_audit_profiles AFTER INSERT OR DELETE OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('profiles','trg_cleanup_orphan_clinic','CREATE TRIGGER trg_cleanup_orphan_clinic AFTER DELETE ON public.profiles FOR EACH ROW EXECUTE FUNCTION cleanup_orphan_clinic()'),
      ('profiles','trg_guard_profile_privileges','CREATE TRIGGER trg_guard_profile_privileges BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION guard_profile_privileges()'),
      ('profiles','zz_invite_issued_at','CREATE TRIGGER zz_invite_issued_at BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION guard_invite_issued_at()'),
      ('queue_entries','a00_radiologist_scope','CREATE TRIGGER a00_radiologist_scope BEFORE INSERT OR DELETE OR UPDATE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_radiologist_scope()'),
      ('queue_entries','a01_no_client_delete','CREATE TRIGGER a01_no_client_delete BEFORE DELETE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_no_client_delete()'),
      ('queue_entries','check_case_clinic_match','CREATE TRIGGER check_case_clinic_match BEFORE INSERT OR UPDATE OF case_id ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION check_case_clinic_match()'),
      ('queue_entries','trg_audit_queue_entries','CREATE TRIGGER trg_audit_queue_entries AFTER INSERT OR DELETE OR UPDATE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('queue_entries','trg_guard_queue_room','CREATE TRIGGER trg_guard_queue_room BEFORE INSERT OR UPDATE OF room_id, clinic_id ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_room_in_clinic()'),
      ('queue_entries','trg_guard_referrer_doctor','CREATE TRIGGER trg_guard_referrer_doctor BEFORE UPDATE OF doctor, referrer_id ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_referrer_doctor()'),
      ('queue_entries','trg_guard_status_referrer','CREATE TRIGGER trg_guard_status_referrer BEFORE UPDATE OF status ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_status_change_referrer()'),
      ('queue_entries','zz_guard_read_keys','CREATE TRIGGER zz_guard_read_keys BEFORE INSERT OR UPDATE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_record_read_keys()'),
      ('referral_access','trg_audit_referral_access','CREATE TRIGGER trg_audit_referral_access AFTER INSERT OR DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('referral_access','trg_zzz_ref_entry_markers_prune','CREATE TRIGGER trg_zzz_ref_entry_markers_prune AFTER DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION tg_ref_entry_markers_prune_on_access()'),
      ('referral_access','trg_zzz_sched_markers_prune','CREATE TRIGGER trg_zzz_sched_markers_prune AFTER DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION tg_sched_markers_prune_on_access()'),
      ('referrer_private','trg_audit_referrer_private','CREATE TRIGGER trg_audit_referrer_private AFTER INSERT OR DELETE OR UPDATE ON public.referrer_private FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('schedule_overrides','trg_zz_change_markers','CREATE TRIGGER trg_zz_change_markers AFTER INSERT OR DELETE OR UPDATE ON public.schedule_overrides FOR EACH ROW EXECUTE FUNCTION tg_change_markers_sched_override()'),
      ('services','trg_audit_services','CREATE TRIGGER trg_audit_services AFTER INSERT OR DELETE OR UPDATE ON public.services FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('waitlist_entries','a00_radiologist_no_write','CREATE TRIGGER a00_radiologist_no_write BEFORE INSERT OR DELETE OR UPDATE ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_radiologist_no_write()'),
      ('waitlist_entries','a01_no_client_delete','CREATE TRIGGER a01_no_client_delete BEFORE DELETE ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_no_client_delete()'),
      ('waitlist_entries','trg_audit_waitlist_entries','CREATE TRIGGER trg_audit_waitlist_entries AFTER INSERT OR DELETE OR UPDATE ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('waitlist_entries','trg_guard_waitlist_room','CREATE TRIGGER trg_guard_waitlist_room BEFORE INSERT OR UPDATE OF room_id, clinic_id ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_waitlist_room()'),
      ('waitlist_entries','zz_guard_read_keys','CREATE TRIGGER zz_guard_read_keys BEFORE INSERT OR UPDATE ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_record_read_keys()')
        ) as e(tbl, tg, def)
        left join (
          select c.relname::text as tbl, t.tgname::text as tg,
                 regexp_replace(pg_get_triggerdef(t.oid), '\s+', ' ', 'g') as def
            from pg_trigger t
            join pg_class c on c.oid = t.tgrelid
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and not t.tgisinternal
        ) a on a.tbl = e.tbl and a.tg = e.tg
       where a.def is null or a.def <> e.def
      union all
      -- Вимкнений тригер — БЕЗ списку, по всій схемі.
      select 'trigger_off:' || c.relname || '.' || t.tgname
             || '=' || t.tgenabled::text
        from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and not t.tgisinternal
         and t.tgenabled not in ('O', 'A')
      union all
      -- 0204 (Н-17): ПОРЯДОК — `zz_guard_read_keys` мусить бути ОСТАННІМ
      -- BEFORE-тригером рядка на INSERT/UPDATE кожної з трьох таблиць гарда
      -- (бічний підзапит — дослівно асерт накату 0203; вимкнені теж рахуються)
      select 'order:' || c.relname || '->' || x.tgname
        from pg_class c
        cross join lateral (
          select t.tgname from pg_trigger t
           where t.tgrelid = c.oid and not t.tgisinternal
             and (t.tgtype & 3) = 3 and (t.tgtype & 20) <> 0
           order by t.tgname collate "C" desc limit 1) x
       where c.oid in (to_regclass('public.patient_cases'), to_regclass('public.queue_entries'),
                       to_regclass('public.waitlist_entries'))
         and x.tgname <> 'zz_guard_read_keys'
    ) x;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'guard_triggers', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'guard_triggers', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 18. server_now() — годинник СЕРВЕРА, на якому стоїть настінний канон (U-76).
  --
  --     ЧОМУ. `lib/serverClock.ts` міряє зсув проти цієї функції; якщо виклик
  --     падає, зсув лишається 0 і система тихо повертається на годинник ПК
  --     реєстратури — рівно та поломка, проти якої писався Ф4-8. Функція
  --     зʼявилась у 0169 і не була під жодним інваріантом.
  --
  --     ⚠️ ГІЛКА (e) — ЖИВИЙ ВИКЛИК, і без неї решта чотирьох каталожних гілок
  --        доводили б лише «обʼєкт схожий на правильний». Ревʼю показало
  --        мутацію, що проходила їх усі: `create or replace function
  --        public.server_now() … as $$ select now() + interval '2 hours' $$` —
  --        грант на місці, тип той, волатильність та, слово `now()` у тілі є,
  --        а настінний канон їде на дві години в УСІХ клієнтів разом.
  --        Виклик у власному блоці з `exception`: виняток тут не має вбивати
  --        ВЕСЬ сторож (урок `to_regclass` з №15) — мовчазний cron гірший за
  --        названого порушника. Тому три різні наслідки: `_drift`, `_null`,
  --        `_raises`.
  --
  --     ⚠️ ОБИДВІ ПОЛОВИНИ ACL, і ПОЗИТИВНА головна. `create or replace
  --        function` у public отримує ДЕФОЛТНИЙ ACL (пастка 0122): EXECUTE
  --        дістають PUBLIC і `anon`. Але деградацію на годинник ПК дає ВТРАТА
  --        гранту `authenticated`, а не поява `anon`.
  --     ⚠️ Негативна половина бере ролі з ЧЛЕНСТВА в `authenticator` (канон
  --        №15), а не літерал 'anon': `grant execute to X; grant X to anon`
  --        обходив би літерал в один хоп, і нова клієнтська роль (портал,
  --        кіоск) була б невидима сторожу з дня появи.
  --
  --     ⚠️ IMMUTABLE — не косметика: постійна функція від `now()` дає
  --        планувальнику право порахувати її ОДИН раз, і клієнт отримає
  --        застиглий момент. Наслідок той самий, що втрата гранту.
  --
  --     ⚠️ Тіло звіряємо БЕЗ коментарів (урок с39, як у №9). Це слабка гілка і
  --        так названа: `now()` у мертвій гілці її задовольняє — саме тому
  --        головна тут (e), а не (d).
  --
  --     ⚠️ search_path НЕ пінимо, і це рішення, а не пропуск: функція
  --        `security invoker`, `now()` резолвиться з pg_catalog, який неявно
  --        перший завжди — наслідку, який можна назвати, немає. Інваріант №2
  --        свідомо питає search_path лише в `security definer` (канон 0169).
  --     ⚠️ МЕЖА: `has_function_privilege` не питає `USAGE` на схемі. `revoke
  --        usage on schema public from authenticated` лишає (a) зеленою, хоч
  --        виклик і падає. Гілка (e) це ловить — але від імені ВЛАСНИКА
  --        сторожа, не від імені клієнта.
  v_n := v_n + 1;
  /* 0174 */ begin
  v_tmp := null;
  begin
    if to_regprocedure('public.server_now()') is null then
      v_drift := null;                       -- (a) вже скаже 'missing'
    elsif public.server_now() is null then
      v_drift := 'server_now_null';
    elsif abs(extract(epoch from (public.server_now() - now()))) > 2 then
      v_drift := 'server_now_drift';
    else
      v_drift := null;
    end if;
  exception when others then
    v_drift := 'server_now_raises';
  end;
  select array_agg(x.txt order by x.txt) into v_tmp
    from (
      -- (a) функції немає, або її вже не може викликати `authenticated`
      select 'server_now_missing' as txt
       where to_regprocedure('public.server_now()') is null
      union all
      select 'server_now_no_grant:authenticated'
       where to_regprocedure('public.server_now()') is not null
         and not has_function_privilege('authenticated', 'public.server_now()', 'EXECUTE')
      union all
      -- (b) …і жодна ІНША клієнтська роль EXECUTE не отримала
      select 'server_now_extra_grant:' || r.rol
        from (select g.rolname as rol
                from pg_auth_members m
                join pg_roles g on g.oid = m.roleid
                join pg_roles a on a.oid = m.member
               where a.rolname = 'authenticator'
                 and g.rolname not in ('service_role', 'authenticated')) r
       where to_regprocedure('public.server_now()') is not null
         and has_function_privilege(r.rol, 'public.server_now()', 'EXECUTE')
      union all
      -- …і гранту на PUBLIC немає: `revoke … from anon` його не знімає
      select 'server_now_extra_grant:PUBLIC'
        from pg_proc p
        cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) g
       where p.oid = to_regprocedure('public.server_now()')
         and g.privilege_type = 'EXECUTE' and g.grantee = 0
      union all
      -- (c) тип результату і волатильність: застиглий момент = годинник ПК
      select 'server_now_shape:' || pg_get_function_result(p.oid)
             || '/' || p.provolatile::text
        from pg_proc p
       where p.oid = to_regprocedure('public.server_now()')
         and (pg_get_function_result(p.oid) <> 'timestamp with time zone'
              or p.provolatile = 'i')
      union all
      -- (d) тіло згадує годинник БАЗИ (слабка гілка — головна нижче)
      select 'server_now_body'
        from pg_proc p
       where p.oid = to_regprocedure('public.server_now()')
         and regexp_replace(
               regexp_replace(p.prosrc, '/\*.*?\*/', ' ', 'gs'),
               '--[^' || chr(10) || ']*', ' ', 'g') !~* '(now|clock_timestamp)\s*\(\s*\)'
      union all
      -- (e) ЖИВИЙ ВИКЛИК: функція віддає момент цієї ж транзакції
      select v_drift where v_drift is not null
    ) x;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'server_now', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'server_now', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 19. ТІЛА ФУНКЦІЙ, ЩО ВИРІШУЮТЬ ДОСТУП: дослівно ті самі (межа №17 з 0171).
  --
  --     ЧОМУ. №17 пінить ВИЗНАЧЕННЯ тригера цілком, але `pg_get_triggerdef`
  --     містить лише ІМʼЯ функції. `create or replace function
  --     public.guard_profile_privileges() … as $$ begin return new; end $$`
  --     лишає №17 ДОСЛІВНО зеленою і при цьому вимикає сторожа: тригер на
  --     місці, увімкнений, визначення те саме — а перевірки всередині немає.
  --
  --     ⚠️ ЗАМІРЯНО ЗОНДОМ ІЗ ВІДКОТОМ (тимчасові таблиця й тригер у pg_temp,
  --        транзакція відкочена `raise`): після вихолощення тіла
  --        `pg_get_triggerdef` збігається побайтно (def_same = t), а дайджест
  --        тіла міняється d8d32d62498c → ab85485bcc84 (body_same = f). Тобто
  --        №17 сліпа до тіла ЗА ПОБУДОВОЮ, а не через недогляд.
  --
  --     ⚠️ ПЕРША РЕДАКЦІЯ ЦІЄЇ ПЕРЕВІРКИ БУЛА СЛАБША, і це знайшли два раунди
  --        ревʼю з різними лінзами; кожну дірку підтверджено власним запитом:
  --        (1) гарди не вирішують самі — вони делегують НЕ-тригерним хелперам
  --            (`guard_profile_privileges` → `auth_is_admin`, `auth_clinic_id`;
  --            `guard_radiologist_scope` → `auth_role`,
  --            `auth_radiologist_room_ok`; `guard_status_change_referrer` →
  --            `auth_is_referrer`). Замір: цих пʼяти імен у тілі сторожа не
  --            було ЖОДНОГО РАЗУ. Пін лише на тіла тригерних функцій лишав ту
  --            саму дірку поверхом нижче: `create or replace function
  --            public.auth_is_admin() … as $$ select true $$` і все зелене;
  --        (2) `proowner` не пінився. Для SECURITY DEFINER власник — це і є
  --            права виконання. `fn_audit` ковтає власні помилки, тож зміна
  --            власника на роль без INSERT в `audit_log` МОВЧКИ гасить аудит
  --            на шести таблицях;
  --        (3) `substr(md5(…), 1, 12)` — 48 біт: другий прообраз добирається
  --            перебором за години, і простір перебору є (коментарі входять у
  --            дайджест). Тепер md5 повний;
  --        (4) `handle_new_user` — SECURITY DEFINER на `auth.users`, вирішує
  --            роль нового профілю. №17 фільтрує `nspname = 'public'` і не
  --            бачить ані цю функцію, ані її тригер. Замір: у тілі сторожа
  --            `handle_new_user` і `on_auth_user_created` — 0 згадок.
  --
  --     ЩО ПІНИМО (сьогодні 60 підписів; ключ — імʼя РАЗОМ із типами
  --     аргументів, бо `auth_radiologist_room_ok(p_room uuid)` має аргумент
  --     і голого `proname` як ключа не досить).
  --
  --     ⚠️ ДЖЕРЕЛО ІСТИНИ ПРО СКЛАД — САМ СПИСОК, А НЕ ЦЯ ПРОЗА. До 0193
  --        тут стояло «22 підписи» з розбивкою рівно на 22 — склад часів
  --        0179. Список відтоді ріс (0185/0190/0191 → 33, 0192 → 38,
  --        0193 → 40, 0200 → 43, 0201 → 59; 0202 → 59, чотири md5 передруковано без
  --        зміни складу; 0203 → 60), а заголовок ніхто не перечитував: 0192 оновила
  --        сусідній рядок «Список став …» і проминула цей. Заміряно
  --        14.09.2026 двома незалежними підрахунками — проза помилялась
  --        на 16 підписів. Розбивка нижче лишена як СКЛАД ПЕРВІСНИХ 22:
  --        вона документує, ЧОМУ список саме такий, і не претендує на
  --        поточну кількість.
  --
  --     СКЛАД ПЕРВІСНИХ 22 (0179):
  --       • 11 функцій, які виконують 14 тригерів зі списку №17;
  --       • 6 хелперів, яким ці гарди делегують РІШЕННЯ про доступ;
  --       • `fn_audit` — аудит-слід на шести таблицях;
  --       • `handle_new_user` — роль нового профілю, плюс окрема гілка на його
  --         тригер `auth.users.on_auth_user_created`;
  --       • `validate_referral_rooms`, `prune_referral_rooms_on_room_delete` —
  --         кабінети, видані направнику, тобто ЙОГО обсяг читання PII;
  --       • `integration_outbox_enqueue` — що саме їде партнеру назовні.
  --
  --     ЯК. Дайджест = повний md5 тіла з нормалізованими пробілами (плюс
  --     `pg_get_function_sqlbody`: у SQL-функцій у формі BEGIN ATOMIC тіло
  --     лежить не в `prosrc`; замір — сьогодні таких у public 0, і дайджести
  --     від додавання не змінились), окремо рядок атрибутів із НАЗВАНИМИ
  --     полями `secdef|vol|owner|lang|cfg`. Діагнози: `missing:`, `body:`
  --     (несе НОВИЙ дайджест, щоб черговий міг написати міграцію з журналу),
  --     `attrs:`, `auth_trigger:`.
  --
  --     ⚠️ МЕЖА, і це РІШЕННЯ, а не пропуск: список ІМЕННИЙ, як у №17. Поза
  --        ним лишаються тригерні функції розкладу і консистентності
  --        (`check_no_overlap`, `check_room_schedule`, `guard_off_schedule`,
  --        `guard_status_transition`, …) і сімка `tg_change_markers_*`: вони
  --        бережуть ПРАВИЛЬНІСТЬ розкладу, а не ДОСТУП. Ціна безспискового
  --        варіанта заміряна по репозиторію: тіло тригерної функції міняють
  --        8 із останніх 30 міграцій проти 4 із 30 для цього списку — тобто
  --        вдвічі частіший передрук сторожа на 900+ рядків. Розширювати
  --        список — рішення власника, не агента.
  --
  --     ⚠️ 0191: ACL функцій ТЕПЕР входить — поле `;acl=` в `attrs`. Межа
  --        звузилась, але не зникла: `proacl` несе лише ПРЯМІ гранти, тож
  --        членство в ролях (`grant authenticated to <нова роль>`), `nspacl`
  --        схеми і `alter default privileges` сюди НЕ входять — і не входять
  --        нікуди більше. ⚠️ Так було до 0201: для КЛІЄНТСЬКИХ ролей їх тепер
  --        тримає №26 `role_surface` (членства, атрибути, налаштування, ACL
  --        схем і бази, default ACL) — сюди, у №19, вони як і раніше не входять.
  --        НАЯВНІСТЬ `search_path` у SECURITY DEFINER — предмет №2; тут пін на
  --        його ЗНАЧЕННЯ.
  --
  --     ⚠️ МЕЖА: перевірка каже «функція з таким тілом є в схемі», а не «саме
  --        її кличе тригер». Перевішування тригера на свіжу пустушку ловить
  --        №17 — і лише для своїх ДВАДЦЯТИ пар. Аудит-тригери у 0172 не були
  --        названі ніде, і `drop trigger trg_audit_profiles` проходив усі
  --        перевірки зеленим — 0173 це закрив, додавши шість пар у №17.
  --        Межа лишається для тригерів ПОЗА цими двадцятьма.
  --
  --     ⚠️ Пробіли нормалізуються: переформатування і CRLF із SQL Editor не
  --        червонять (замір: 10 із 12 перших тіл у проді вже несуть CR, і
  --        дайджест з ним та без нього однаковий). Коментарі НЕ знімаються
  --        СВІДОМО — закоментований `raise exception` це зміна поведінки.
  --        Заміряно на `guard_profile_privileges`: переформатування лишає
  --        дайджест тим самим, а зняття коментарів, `raise exception` →
  --        `raise notice` і вихолощене тіло — міняють.
  --
  --     ⚠️ КОМЕНТАР ВИПРАВЛЕНО в 0177. Він казав: «ця перевірка — ЄДИНА, що не
  --        падає мовчки; у всьому стороже рівно ОДИН обробник `exception when`».
  --        Це протухло разом з 0174, який обгорнув УСІ перевірки: замір на
  --        проді дає 21 обробник. Виняток у будь-якій перевірці тепер стає
  --        ЧЕРВОНИМ рядком у `failed`, а не тишею замість запису.
  --     ⚠️ 0183 (RF-03): додано `sched_override_read(p_clinic uuid, p_date date)`
  --        — definer-RPC, що ріже `schedule_overrides.rooms` по видимих
  --        кабінетах направника. Тіло під дайджестом НЕ для краси:
  --        вихолощена версія (`coalesce(so.rooms,'{}')` без гілки) повернула
  --        б витік МОВЧКИ — політики, яка б його спіймала, більше немає, її
  --        зняла ця сама міграція. 26 → 27.
  --     ⚠️ 0182 (RF-02): додано `guard_invite_issued_at()` — штамп часу видачі
  --        запрошення. Тіло під дайджестом навмисно: вихолощений штамп
  --        (`return new;`) зняв би TTL МОВЧКИ — токен жив би вічно при всіх
  --        зелених перевірках. 25 → 26.
  --     ⚠️ 0181 (RF-01): перезнято дайджест `guard_radiologist_scope()` — гард
  --        тепер стереже і ДЖЕРЕЛО (кейс), а не лише кабінет-приймач; і додано
  --        ДВІ case-RPC (23 → 25). Ревʼю показало зондом на проді, що RPC — не
  --        єдиний письменник: прямий INSERT привʼязував рядок до чужого кейса.
  --        Тому головний пін тут — саме ГАРД, а RPC — другий рубіж.
  --     ⚠️ 0179: до списку додано `ceo_list_for_clinic(p_clinic uuid)` — єдину
  --        definer-RPC, що легально віддавала токен запрошення (RF-09b). Її
  --        гейт `auth_is_admin()` і `null::text as invite_token` тепер під
  --        дайджестом; `fn_audit()` перезнято (тіло віднімає invite_token).
  --        Список став 30 функцій.
  --
  --     ⚠️ 0191 (с66): у `attrs` додано `;acl=` — ПРАВА ВИКОНАННЯ (прямі
  --        аклітеми, відсортовані `collate "C"`, з окремими гілками на
  --        `proacl IS NULL` і порожній масив). Плюс ТРИ вирішувачі
  --        направниківського доступу: `auth_can_refer`,
  --        `auth_referrer_visible_rooms`, `auth_referrer_clinics`.
  --        ⚠️ Їхні ТІЛА вже тримала №22 (усі три anon-досяжні, а вона
  --        пінить повний сирий md5) — заміряно зондом 13.09. НОВЕ тут:
  --        ЗНАЧЕННЯ `search_path`, волатильність, мова, власник і права.
  --        Заміряно там же: `alter function … set search_path = pg_temp,
  --        public` на definer-функції поза цим списком не бачила ЖОДНА
  --        з 23 перевірок. Список став 33 функції.
  --     ⚠️ 0192 ДОДАЛА ПʼЯТЬ: три RPC (`emergency_stop_rpc`,
  --        `queue_set_status_rpc`, `submit_incident_rpc`) і два тіла з
  --        рішення Р3 (`update_patient_details` — єдиний живий захист від
  --        U-66, і `tg_change_markers_queue` — definer над PII).
  --        Список став 38 функцій. Підстави — `DECISIONS-2026-09-13-s68.md`.
  --     ⚠️ 0193 ДОДАЛА ДВІ: `waitlist_candidates_for_slot` і
  --        `waitlist_counts` — DEFINER-читання вейтліста. Список став 40.
  --        ПРИЧИНА НАЗВАНА: 0136 закрила кімнатну межу радіолога записом
  --        (тригер `a00_*` минути не можна) і двома read-oracle вручну, а
  --        0137 звузила ЧИТАННЯ вейтліста політикою. DEFINER-ЧИТАННЯ не
  --        покривав ні тригер, ні політика: `waitlist_candidates_for_slot`
  --        (0104, написана ДО 0136) віддавала радіологу ПОВНІ рядки
  --        вейтліста повз кабінети. Замір 14.09 в обидва боки: через RLS
  --        він читав 0 рядків, через RPC отримував 1. Пін — саме те, що
  --        робить дубльований гейт безпечним: зняти його `create or
  --        replace`-ом тепер не можна тихо. Розширення списку —
  --        РІШЕННЯ ВЛАСНИКА 14.09 (межа прози №19 вимагає саме цього).
  --     ⚠️ 0200 ДОДАЛА ТРИ: `auth_is_desk()`, `schedule_from_waitlist_rpc`,
  --        `set_waitlist_status_rpc`. Список став 43. Розбір —
  --        `docs/audit/PHASE3-2026-09-15-definer-pin-gap.md` і
  --        `docs/audit/PR-0200-pin-desk-waitlist.md`.
  --        • `auth_is_desk` — не застосовувач, а РІШАЛЬНИК, і вирішує він у
  --          ДВОХ шарах. RLS: пʼять політик (`doctors_desk_insert`,
  --          `doctors_desk_update`, `incidents_desk_insert`,
  --          `incidents_desk_update`, `sched_desk_write`), усі у формі
  --          «свій центр І `auth_is_desk()`» — тіло на `true` відкривало б
  --          ЗАПИС у три таблиці будь-якій ролі СВОГО центру. І гейт усередині
  --          восьми definer-RPC, три з яких у цьому списку вже були
  --          (`emergency_stop_rpc`, `queue_set_status_rpc`,
  --          `submit_incident_rpc`): їхні піни тримали ВИКЛИК, а не рішення.
  --          Замір с74: це ЄДИНИЙ `auth_*`, якого не пінило НІЩО — девʼять
  --          інших у цьому списку, ще чотири досяжні з `anon` і їх тримає №22.
  --          Урок той самий, що з `auth_can_see_slot_details` у 0190;
  --        • дві waitlist-RPC — їхні тіла переписала 0199 (відсічка
  --          радіолога), і результат не тримало ніщо.
  --        ⚠️ ЦІНА: рядок пінує md5 тіла РАЗОМ з `attrs`, тобто і `;acl=`.
  --           Будь-яка правка цих трьох функцій — тіло (і якірна, як у 0199),
  --           `grant`, `revoke`, `alter function`, перейменування параметра —
  --           тепер іде в одній міграції з передруком сторожа. CI цього НЕ
  --           ловить: `PINNED` тримає підписи, а не md5, — червоніє прод.
  --        ⚠️ МЕЖА — і вона НЕ «гучна відмова», як назвав решту розбір с73
  --           (ревʼю с74 це спростувало замірами тіл). Решта 18 definer-
  --           функцій, доступних `authenticated` і поза списком, здебільшого
  --           САМІ несуть гейт: у 12 це `auth_is_admin()` чи `auth_is_desk()`,
  --           у 2 — хелпери направника й радіолога (`auth_can_refer`,
  --           `auth_referrer_can_book_room`, `auth_radiologist_room_ok`), у 2 —
  --           лише `auth.uid()`, дві пошукові гейта не мають.
  --           Вихолощення такого гейта МОВЧАЗНЕ. Обсяг «три» заданий
  --           власником; чи пінити решту — окреме рішення власника (вирішено:
  --           0201, шістнадцять), як і
  --           місце `integration_apply_status` (недоступна `authenticated`).
  --        РІШЕННЯ ВЛАСНИКА 15.09 (стартовий промпт с74).
  --     ⚠️ 0201 ДОДАЛА ШІСТНАДЦЯТЬ — решту definer-функцій, доступних
  --        `authenticated` і поза списком, що НЕСУТЬ ВЛАСНИЙ ГЕЙТ. Список став
  --        59. Рішення власника Р74-1(б), 15.09
  --        (`docs/audit/DECISIONS-2026-09-15-s74.md`); пакет —
  --        `docs/audit/PR-0201-gated-rpcs-role-surface.md`.
  --        • гейт `auth_is_admin()`/`auth_is_desk()` (12): `cancel_case_rpc`,
  --          `ceo_kpi_rooms`, `ceo_kpi_studies`, `ceo_kpi_totals`,
  --          `delete_clinic_member`, `incident_resolve_rpc`,
  --          `queue_apply_delay_plan_rpc`, `queue_confirm_calls_rpc`,
  --          `queue_set_call_rpc`, `save_schedule_override`,
  --          `search_referrers`, `services_import_rpc`;
  --        • хелпери направника й радіолога (2): `create_case_rpc`,
  --          `queue_reschedule_rpc`;
  --        • лише `auth.uid()` (2): `mark_changes_seen`,
  --          `referral_center_card` — остання ЄДИНА тримає видимість картки
  --          центру направнику, і її тіло міняла 0195. ⚠️ На проді воно лежало
  --          БЕЗ коментарів файла 0195 (чернетка через execute_sql, PR-0195 §5);
  --          0201 перестворює функцію дослівно текстом 0195 і пінить ЙОГО md5 —
  --          інакше база, зібрана міграціями, червоніла б `body:` з першого дня.
  --        Вихолощений гейт у будь-якій із них — ТИХА ескалація (у своєму
  --        центрі або по чужому кейсу), бо RLS усередині SECURITY DEFINER не діє.
  --        ⚠️ ПОЗА СПИСКОМ лишаються `search_cities` і `search_clinics` (гейта
  --           за роллю в тілі немає — лише фільтр видимості довідника) та
  --           `integration_apply_status` (недоступна `authenticated`). Це межа,
  --           названа рішенням.
  --        ⚠️ ЦІНА та сама, що в абзаці 0200, тепер ще на шістнадцять функцій
  --           (разом із 0200 — девʼятнадцять):
  --           будь-яка правка цих шістнадцяти — тіло, `grant`/`revoke`,
  --           `alter function`, імʼя параметра — лише разом із передруком.
  --        ⚠️ Замір рядків 15.09: перевантажень немає; у
  --           `save_schedule_override` поле `cfg=` несе ще й
  --           `DateStyle=ISO, MDY` — це частина піна, а не шум.
  --     ⚠️ 0202 ПЕРЕДРУКУВАЛА ЧОТИРИ md5 БЕЗ ЗМІНИ СКЛАДУ (список так само 59):
  --        `emergency_stop_rpc`, `queue_set_status_rpc`, `submit_incident_rpc`,
  --        `room_busy_slots` позбулися підзапиту до `pg_timezone_names` —
  --        назву зони з 0192 стереже CHECK на записі, а 0202 звузила його до
  --        ('Europe/Kyiv', 'UTC'). Рішення власника Р74-3(а), 15.09; пакет —
  --        `docs/audit/PR-0202-tz-kyiv-no-catalog-scan.md`. ⚠️ `emergency_stop_rpc`
  --        на проді лежала зі скороченими коментарями (клас 0195); 0202
  --        перестворює її повним текстом 0168 — код той самий.
  --        ⚠️ МЕЖА, показана у фальсифікації 0202: рядкові тригери
  --           `check_no_overlap` і `check_not_in_past` теж змінено, і їхніх тіл
  --           у цьому списку НЕМАЄ (прийнятий ризик 13.09, розвилка 2) —
  --           мутація тіла лишає сторожа зеленим. №17 тримає лише
  --           ВИЗНАЧЕННЯ тригерів.
  --     ⚠️ 0203 (с79, Н-9 і Р-1) ДОДАЛА ОДНУ: `guard_record_read_keys()` — тіло
  --        трьох тригерів `zz_guard_read_keys` (`queue_entries`,
  --        `waitlist_entries`, `patient_cases`). Список став 60. Підстава —
  --        постановка Н-9 («міграція + передрук №17/№19») і урок проєкту:
  --        пінити того, хто ВИРІШУЄ доступ, а не лише того, хто рішення
  --        застосовує. Ця функція вирішує, чиї `referrer_id` і `created_by`
  --        відкриють читання ПІБ і телефону пацієнта: вихолощене тіло
  --        (`return new;`) повернуло б обидва канали МОВЧКИ — №17 бачить
  --        лише визначення тригерів. Прецеденти тригерних функцій у цьому
  --        списку — `fn_audit()`, `guard_invite_issued_at()`. Рішення
  --        оркестратора 24.09 за постановкою Н-9; пакет —
  --        `docs/audit/PR-0203-audit-pii-referrer-grant.md`.
  --        ⚠️ ЦІНА та сама, що в абзацах 0200/0201: будь-яка правка функції —
  --           тіло, `grant`/`revoke`, `alter function` — лише разом із
  --           передруком сторожа. Фальсифікація 0203 доводить, що
  --           вихолощене тіло червонить саме цю перевірку (`body:`).
  --     ⚠️ 0204 (с80, Н-14) ПЕРЕДРУКУВАЛА ОДИН md5 БЕЗ ЗМІНИ СКЛАДУ (список так
  --        само 60): `change_marker_recipients(…)` — гілка `entry` у CTE
  --        `referrer` тепер вимагає АКТИВНИЙ грант направника до центру
  --        (дзеркало політик читання 0204), гілка `access` — як була.
  --        Фальсифікація 0204 ставить назад тіло 0184 і вимагає від цієї
  --        перевірки `body:` рівно з його дайджестом.
  --        ⚠️ МЕЖА, названа вголос: нова `tg_ref_entry_markers_prune_on_access()`
  --           у список НЕ внесена — як і `tg_sched_markers_prune_on_access()`
  --           (0184): мітли позначок бережуть досяжність крапок, а не доступ
  --           до ПДн. Її вихолощення ловить №14 (`unreachable:`), а не №19.
  v_n := v_n + 1;
  v_tmp := null;
  select regexp_replace(pg_get_triggerdef(t.oid), '\s+', ' ', 'g') || '/' || t.tgenabled::text
    into v_atg
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'auth' and c.relname = 'users'
     and not t.tgisinternal and t.tgname = 'on_auth_user_created';
  begin
    with expd(fn, body, attrs) as (values
      ('add_case_step_rpc(p_case_id uuid, p_step jsonb)','aa3cf7cd09b0e0d61d2cd5bfa4a173f8','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_clinic_id()','e7630130c3ef5aaa8186d6aa64640168','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_can_see_slot_details(c uuid)','19fe1040308640b29a5d8b1bb7506873','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_can_refer(c uuid)','0a178709faea2ab0bb55fbb098001bf4','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_is_admin()','b795042a9dd18520b7a80e466fd231a1','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_is_desk()','30c8b71fff4236d07de6dd01706795d2','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('schedule_from_waitlist_rpc(p_waitlist_id uuid, p_booking jsonb)','5e0a4b2cc069e604c5eb3634fbad04aa','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('set_waitlist_status_rpc(p_id uuid, p_status waitlist_status)','1e04ab4ebb01c08a23d1280b29465d55','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('cancel_case_rpc(p_case_id uuid)','ad0a4f2c7d1e475a806c10d575f7fede','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('ceo_kpi_rooms(p_from date, p_to date, p_clinics uuid[])','dcceffc8c656b8fd1b62c2b71350b14b','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('ceo_kpi_studies(p_from date, p_to date, p_clinics uuid[])','416da7521b1c99740f6a7646ff8d526e','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('ceo_kpi_totals(p_from date, p_to date, p_clinics uuid[])','123af77cd8f5fe2a9512c12c2ff3bb7b','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('delete_clinic_member(target uuid)','6d369ff76b71637902998e275a0b7c64','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('incident_resolve_rpc(p_id uuid)','11bf2e9447c4f7226bde73b577832ba9','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('queue_apply_delay_plan_rpc(p_room uuid, p_source uuid, p_delay_min integer, p_strategy text, p_plan jsonb, p_expected jsonb, p_reason text)','c1d43e9c53e291846c7b0456d4793060','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('queue_confirm_calls_rpc(p_ids uuid[])','fa043199612d4151bd447818036fa89c','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('queue_set_call_rpc(p_id uuid, p_call call_status, p_allowed queue_status[])','45f823a84cfb8d26e21e147071744008','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('save_schedule_override(p_override_date date, p_all_closed boolean, p_label text, p_rooms jsonb, p_expected_updated_at text)','b78fbf0e96d2589d6c8ba3b50fc3a3ad','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp,DateStyle=ISO, MDY;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('search_referrers(q text)','213e5b9809aa4da3ad82644e6244a78e','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('services_import_rpc(p_rows jsonb, p_room_id uuid)','f714153329d653601a913405872ac7ad','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('create_case_rpc(p_case jsonb, p_steps jsonb)','22387332147a71748de09d74ed1d9d1b','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('queue_reschedule_rpc(p_id uuid, p_room_id uuid, p_date date, p_time text, p_duration integer, p_buffer integer, p_call call_status, p_reason text, p_off_schedule boolean, p_studies jsonb)','3382aa484125730aad7c329ca7f99ac8','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('mark_changes_seen(p_ids uuid[])','ba45fd7da3e25f018b076ed4ba95f4e8','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('referral_center_card(p_access_id uuid)','a2be8c18cb183d5d4221b3af9a62671d','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_is_referrer()','3f4b527323ae5f1e55206d4e14b5185c','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_radiologist_room_ok(p_room uuid)','c10f4b82244cc076ed7cca76ea4debff','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_referrer_visible_rooms()','5f3226aad0599e94feb5b5e1ecfbbbf4','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_referrer_clinics()','ef77618a170ca3065c2d1673a3a13731','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_role()','512756052984a56357aaa17606904722','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('case_from_entry_rpc(p_entry_id uuid, p_step jsonb)','0f7f9aaa2497164ea3d5abeb0807a991','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('ceo_list_for_clinic(p_clinic uuid)','4f3ee1ff598634aa8993f04fbad0a77c','secdef=true;vol=s;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('change_marker_recipients(p_clinic uuid, p_actor uuid, p_scope_kind text, p_room uuid, p_referrer uuid, p_severity text, p_room_relevant boolean)','48ecffeeaba0b8e899fa34f37fdf2a2b','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('check_case_clinic_match()','b73f19a4f985b5f2919d236d4b322734','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('cleanup_orphan_clinic()','479ec6dc1da0f94a9e280c8962892354','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('emergency_stop_rpc(p_room_ids uuid[], p_date date, p_note text)','4fe9671d3841684f4577af3b8f89baaf','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('fn_audit()','b1cd54ecfb2796b00e7b4f6c427752b2','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('guard_invite_issued_at()','f5f04a4bf959614f4060d97c5220094d','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('guard_no_client_delete()','05b915311433622bb130f90411aadc3e','secdef=false;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('guard_no_client_delete_incident()','345989135a6367f8e8660bee03501f0f','secdef=false;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('guard_profile_privileges()','34234a0e69305bed25c7e6ca1ebf62fd','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('guard_radiologist_no_write()','645270a9564b456dc4705e2ace0524af','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('guard_radiologist_scope()','16fab10b6de82574e5f103fd0e40d8d5','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('guard_record_read_keys()','5da6c3e992832640ec654fe06028f9d6','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('guard_referrer_doctor()','4b60225a9b22453cad33b1190af31950','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('guard_room_in_clinic()','01ddc142b88c5cb05aaa64995eaa88ff','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('guard_status_change_referrer()','aea37ae48922b8d0c25e8431a694dffb','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('guard_waitlist_room()','2a76140e37be272276d7af879857847b','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('handle_new_user()','f894603059909d0ac8c4155202453b49','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('integration_outbox_enqueue()','e859d25943757fc4d6b848c6f87c880f','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('prune_referral_rooms_on_room_delete()','47f8859948ac34d08a347c5f57592612','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('queue_set_status_rpc(p_id uuid, p_status queue_status, p_expected queue_status, p_allowed queue_status[], p_note text, p_set_note boolean)','a49a4c2ebf333967e6323a42651fdd36','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('request_is_client_role()','9ab7fbaaf5d1e575a28727a94fe0a316','secdef=false;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('room_busy_slots(p_room uuid, p_date date, p_exclude uuid)','ad9e1dfd7779b496a28ae9bfd85fc50c','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('sched_override_read(p_clinic uuid, p_date date)','ad8632bd4fe14911d08095f579d2325e','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('submit_incident_rpc(p_room_id uuid, p_reason text, p_id uuid, p_reason_label text, p_note text, p_started_at timestamp with time zone, p_blocked_until timestamp with time zone, p_auto_unblock boolean)','02e0e9ebc9f8e48abb0cbdc3bf2da8ba','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('tg_change_markers_queue()','f17bd4292fc6046f5d9dc43f823a7154','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('update_patient_details(p_id uuid, p_data jsonb, p_referrer jsonb)','7e97213388e7d9e17c1080f8ed21e92a','secdef=false;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('validate_referral_rooms()','362abe030faef019a49b78007e1edb70','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('waitlist_candidates_for_slot(p_room uuid, p_date date, p_time_min integer)','236114e0ed2c52a4ddbecb939d6ee65e','secdef=true;vol=s;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('waitlist_counts(p_modality text)','6206620abcd6386ba00fa5f4091aaca1','secdef=true;vol=s;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres')
    ), cur as (
      select p.proname::text || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn,
             md5(btrim(regexp_replace(
                   p.prosrc || coalesce(pg_get_function_sqlbody(p.oid)::text, ''),
                   '\s+', ' ', 'g'))) as body,
             'secdef=' || p.prosecdef::text
               || ';vol='   || p.provolatile::text
               || ';owner=' || pg_get_userbyid(p.proowner)
               || ';lang='  || l.lanname::text
               || ';cfg='   || coalesce(array_to_string(p.proconfig, ','), '')
               || ';acl='   || case when p.proacl is null then '<default>'
                                    else coalesce((select string_agg(t, ',' order by t collate "C")
                                                     from unnest(p.proacl::text[]) t), '<empty>') end as attrs
        from pg_proc p
        join pg_language l on l.oid = p.prolang
       where p.pronamespace = 'public'::regnamespace
         and p.prokind = 'f'
         and p.proname = any (select split_part(e.fn, '(', 1) from expd e)
    )
    select array_agg(x.txt order by x.txt) into v_tmp
      from (
        -- функції з таким підписом більше немає
        select 'missing:' || e.fn as txt
          from expd e
         where not exists (select 1 from cur c where c.fn = e.fn)
        union all
        -- тіло змінилось: вихолощення, закоментований raise, нова логіка
        select 'body:' || e.fn || '->' || c.body
          from expd e join cur c on c.fn = e.fn
         where c.body <> e.body
        union all
        -- SECURITY DEFINER / волатильність / ВЛАСНИК / мова / search_path
        select 'attrs:' || e.fn || '->' || c.attrs
          from expd e join cur c on c.fn = e.fn
         where c.attrs <> e.attrs
        union all
        -- перевантаження пінованого імені: у списку його НЕМАЄ, а двері є.
        -- `cur` розширений по голому імені саме для цієї гілки.
        select 'extra:' || c.fn
          from cur c
         where not exists (select 1 from expd e where e.fn = c.fn)
        union all
        -- тригер на auth.users: №17 фільтрує nspname='public' і його не бачить
        select 'auth_trigger:' || coalesce(v_atg, 'MISSING')
         where coalesce(v_atg, 'MISSING') <> 'CREATE TRIGGER on_auth_user_created'
               || ' AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION'
               || ' handle_new_user()/O'
      ) x;
  exception when others then
    v_tmp := array['guard_fn_bodies_raised:' || sqlstate || ':' || left(sqlerrm, 120)];
  end;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'guard_fn_bodies', 'offenders', to_jsonb(v_tmp)));
  end if;

  -- 20. У `profiles` типове значення дозволене РІВНО двом колонкам. Ця таблиця
  --     вирішує, ХТО людина: при `default 'admin'` рядок, вставлений без ролі,
  --     мовчки ставав АДМІНОМ, а при `default true` на `approved` — одразу
  --     підтвердженим. Обидва дефолти знято цією ж міграцією; перевірка стежить,
  --     щоб вони — чи будь-який НОВИЙ дефолт на цій таблиці — не повернулись.
  --     ⚠️ Це ВЛАСТИВІСТЬ, а не список колонок: нова колонка з дефолтом стає
  --     порушником одразу, без правки сторожа. Виняток названий і мінімальний:
  --     `created_at` (`now()`) і `password_set` (`false` — fail-CLOSED: профіль
  --     без явного рішення вважається БЕЗ пароля, а не з паролем).
  --     ⚠️ Межа: перевірка бачить лише `public.profiles`. Дефолт, що роздає
  --     права на ІНШІй таблиці (напр. `referral_access.status`), сюди не
  --     потрапляє — правило «де саме дефолт небезпечний» продуктове, і його
  --     ніхто не формулював.
  v_n := v_n + 1;
  /* 0174 */ begin
  select array_agg('default:profiles.' || a.attname || '->'
                   || pg_get_expr(d.adbin, d.adrelid) order by a.attname)
    into v_tmp
    from pg_attribute a
    join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'public.profiles'::regclass
     and a.attnum > 0 and not a.attisdropped
     and a.attname <> all (array['created_at', 'password_set']);
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'profiles_defaults', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'profiles_defaults', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 21. ПРЕМІСА ФІЛЬТРАЦІЇ realtime. Стереже U-65 — і ЛИШЕ його.
  --     Фільтр підписки на DELETE рахується по ПОВНІЙ replica identity (до
  --     обрізання payload). Тому підписка з фільтром по не-PK колонці працює
  --     тільки поки таблиця має REPLICA IDENTITY FULL; без неї фільтр перестає
  --     збігатися МОВЧКИ — підписник просто не бачить видалень.
  --     ⚠️ ПЕРША РЕДАКЦІЯ ЦІЄЇ ПЕРЕВІРКИ ВИКИНУТА. Вона пінила ТІЛО
  --     `realtime.apply_rls` позиційними зондами (`when action = 'UPDATE'` <
  --     `when action = 'DELETE'` < рядок обрізання). Заміряно на копії
  --     `prosrc`: зонд лишається ЗЕЛЕНИМ і коли обрізання виносять із гілки
  --     DELETE, і коли предикат доставки прибирають ЦІЛКОМ. Пін `md5(prosrc)`
  --     апстриму теж відкинуто свідомо: апстрим переписує цю функцію в проді
  --     (заміряно: дві перегрузки `check_equality_op`, `selected_columns` та
  --     `action_filter` в `apply_rls`), а червоне, на яке черговий не може
  --     подіяти, — це знята перевірка (урок 0141).
  --     Тому пінимо ПОВЕДІНКУ хелпера + НАШУ конфігурацію.
  --     ⚠️ МЕЖА, і вона головна: оракул доводить властивість ХЕЛПЕРА, а не те,
  --     що `apply_rls` кличе його на `old_columns`. Цю дірку закриває рівно
  --     один зонд — на ВХОДЖЕННЯ (не позицію) предиката доставки; заміряно:
  --     видалення гілки `action='DELETE' and ...(old_columns, ...)` дає 0.
  --     ⚠️ МЕЖА: перевіряються `op='eq'` і `negate=false`. Заміряно: підміна
  --     типу uuid→text лишає всі чотири твердження незмінними. Підстава, чому
  --     цього досить СЬОГОДНІ: усі живі підписки проєкту вживають лише `eq`.
  --     ⚠️ МЕЖА: U-66 (гілка UPDATE не ріже old_record) ця перевірка НЕ
  --     стереже — `is_visible_through_filters` у складанні payload участі не
  --     бере. Живий захист від U-66 — порядок ЗВУЖЕННЯ→ДАНІ→РОЗШИРЕННЯ в
  --     `update_patient_details` (0176). ⚠️ 0192: ТІЛО ЦІЄЇ ФУНКЦІЇ ТЕПЕР
  --     ЗАПІНЕНЕ — вона ввійшла у список №19 рішенням власника (розвилка 5,
  --     `docs/audit/DECISIONS-2026-09-13-s68.md`). До 0192 тут стояло «він НЕ
  --     запінений нічим… це пропозиція власнику» — і це вже було б неправдою
  --     в тому самому файлі, який його запінив.
  --     ⚠️ МЕЖА лишається, і вона не косметична: пін стереже ТІЛО, а не те,
  --     що порядок УСЕРЕДИНІ тіла правильний. Переписати порядок і зберегти
  --     дайджест не можна; переписати тіло РАЗОМ із піном — можна, і це та
  --     сама ціна ратчета №19, що названа в AGENTS.md.
  --     ⚠️ МЕЖА: конфігурацію самого сервісу Realtime з SQL не видно взагалі.
  --     ЗАЛЕЖНІСТЬ ВІД №3: FULL безпечна лише поки RLS увімкнено — саме RLS
  --     вмикає обрізання `old_record` до PK на DELETE.
  --     Ціна піна складу: `alter publication` чіпають 10 міграцій зі 176 і
  --     ЖОДНА з останніх 43. Це найдешевший список у стороже.
  --     Аномалію, заради якої все це, породила 0132: вона додала
  --     `user_change_markers` у публікацію БЕЗ `replica identity full`.
  v_n := v_n + 1;
  /* 0174 */ begin
  v_tmp := array[]::text[];

  -- (а) ПОВЕДІНКОВИЙ оракул. Це СИНТЕТИКА: імена `probe_id`/`probe_scope_id`
  --     не збігаються з жодною колонкою схеми (звірено). До жодної таблиці
  --     проєкту вона відношення не має. Перевіряється ІМПЛІКАЦІЯ: набір,
  --     обрізаний до PK, не збігається з фільтром по не-PK колонці.
  --     Різницю дає ЧИСЛО колонок у наборі, а не прапорець `is_pkey`:
  --     хелпер джойнить лише за іменем колонки.
  --     ⚠️ `realtime.user_defined_filter` має ДРОПНУТИЙ атрибут (заміряно),
  --     тому конструктор — рівно 4 поля; пʼять дадуть 42846. Якщо тут упаде,
  --     це сигнал про зміну апстримного типу, і він приїде як `raised:`.
  --     Власна обгортка: падіння оракула не має ослiплювати частину (б).
  begin
    v_tmp := v_tmp || coalesce((
      select array_remove(array[
          case when q.a is not true  then 'oracle:набір з не-PK колонкою + свій фільтр -> мусить бути true'   end,
          case when q.b is not false then 'oracle:набір лише з PK + той самий фільтр -> мусить бути false'    end,
          case when q.c is not false then 'oracle:набір з не-PK колонкою + чужий фільтр -> мусить бути false' end,
          case when q.d is not true  then 'oracle:набір з не-PK колонкою + без фільтра -> мусить бути true'   end
        ], null)
      from (
        with c as (
          select array[
                   row('probe_id','uuid','uuid'::regtype::oid,
                       to_jsonb('11111111-1111-1111-1111-111111111111'::uuid), true, true),
                   row('probe_scope_id','uuid','uuid'::regtype::oid,
                       to_jsonb('22222222-2222-2222-2222-222222222222'::uuid), false, true)
                 ]::realtime.wal_column[] as full_ident,
                 array[
                   row('probe_id','uuid','uuid'::regtype::oid,
                       to_jsonb('11111111-1111-1111-1111-111111111111'::uuid), true, true)
                 ]::realtime.wal_column[] as pk_only,
                 array[row('probe_scope_id','eq',
                           '22222222-2222-2222-2222-222222222222', false)
                 ]::realtime.user_defined_filter[] as flt_own,
                 array[row('probe_scope_id','eq',
                           '33333333-3333-3333-3333-333333333333', false)
                 ]::realtime.user_defined_filter[] as flt_other
        )
        select realtime.is_visible_through_filters(full_ident, flt_own)   as a,
               realtime.is_visible_through_filters(pk_only,    flt_own)   as b,
               realtime.is_visible_through_filters(full_ident, flt_other) as c,
               realtime.is_visible_through_filters(full_ident,
                 '{}'::realtime.user_defined_filter[])                    as d
          from c
      ) q), array['oracle:нуль рядків — премісу НЕ перевірено']);
  exception when others then
    v_tmp := v_tmp || array['oracle:raised:' || sqlstate || ':' || left(sqlerrm, 80)];
  end;

  -- (б) НАША конфігурація: склад публікації, прапорці, replica identity.
  --     Імена КВАЛІФІКОВАНІ схемою. Заміряно, чому: при звірянні по голому
  --     імені підміна `public.doctors` на `shadow.doctors` дає НУЛЬ порушників.
  --     Виняток `user_change_markers` — УТВЕРДЖУВАЛЬНИЙ: від неї вимагаємо
  --     рівно `d`, від решти рівно `f`. Тому в день, коли власник вирішить
  --     розвилку і таблиця стане FULL, сторож почервоніє і сам вимагатиме
  --     прибрати виняток, а не лишиться мертвим кодом назавжди.
  v_tmp := v_tmp || coalesce((
    with expected as (
      select array['public.doctors','public.incidents','public.patient_cases',
                   'public.queue_entries','public.referral_access','public.rooms',
                   'public.schedule_overrides','public.service_room_overrides',
                   'public.services','public.user_change_markers',
                   'public.waitlist_entries']::text[] as names,
             array['public.user_change_markers']::text[]                 as pk_only_expected
    ),
    pub as (select * from pg_publication where pubname = 'supabase_realtime'),
    tabs as (
      select pt.schemaname || '.' || pt.tablename as fqn,
             pt.rowfilter,
             coalesce(c.relreplident::text, '?')  as ri
        from pg_publication_tables pt
        left join pg_namespace n on n.nspname = pt.schemaname
        left join pg_class     c on c.relnamespace = n.oid and c.relname = pt.tablename
       where pt.pubname = 'supabase_realtime'
    )
    select array_remove(array[
      case when not exists (select 1 from pub) then 'publication:supabase_realtime->немає' end,
      case when (select puballtables from pub)  then 'publication:puballtables->true' end,
      case when not (select pubdelete from pub) then 'publication:pubdelete->false' end,
      case when not (select pubupdate from pub) then 'publication:pubupdate->false' end,
      case when not (select pubinsert from pub) then 'publication:pubinsert->false' end,
      case when current_setting('wal_level') <> 'logical'
           then 'wal_level->' || current_setting('wal_level') end,
      case when (select count(*) from pg_publication_namespace pn join pub p on p.oid = pn.pnpubid) > 0
           then 'publication:схемна публікація->є' end,
      case when (select count(*) from pg_publication_rel pr join pub p on p.oid = pr.prpubid
                  where pr.prattrs is not null) > 0 then 'publication:column list->є' end,
      (select 'publication:row filter->' || string_agg(t.fqn, ',' order by t.fqn)
         from tabs t where t.rowfilter is not null),
      (select 'publication:зайві->' || string_agg(t.fqn, ',' order by t.fqn)
         from tabs t, expected e where t.fqn <> all (e.names)),
      (select 'publication:зникли->' || string_agg(x, ',' order by x)
         from expected e, unnest(e.names) x
        where not exists (select 1 from tabs t where t.fqn = x)),
      (select 'identity:' || string_agg(t.fqn || '->' || t.ri, ',' order by t.fqn)
         from tabs t, expected e
        where t.fqn <> all (e.pk_only_expected) and t.ri <> 'f'),
      (select 'identity:виняток більше не потрібен:' || string_agg(t.fqn || '->' || t.ri, ',' order by t.fqn)
         from tabs t, expected e
        where t.fqn = any (e.pk_only_expected) and t.ri <> 'd'),
      case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'realtime' and p.proname = 'apply_rls') <> 1
           then 'realtime.apply_rls->не рівно одна' end,
      case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'realtime' and p.proname = 'is_visible_through_filters') <> 1
           then 'realtime.is_visible_through_filters->не рівно одна' end,
      -- Єдиний текстовий зонд, і він НЕ позиційний: рахує ВХОДЖЕННЯ предиката
      -- доставки на old_columns. Заміряно: прибирання гілки
      -- `action='DELETE' and ...(old_columns, subs.filters)` дає 0, тоді як
      -- позиційні зонди першої редакції лишались зеленими.
      case when coalesce((select regexp_count(p.prosrc, 'is_visible_through_filters\s*\(\s*old_columns')
                            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                           where n.nspname = 'realtime' and p.proname = 'apply_rls'), 0) < 1
           then 'realtime.apply_rls->предикат доставки на old_columns зник' end
    ], null)
  ), array['config:нуль рядків — конфігурацію НЕ перевірено']);

  v_tmp := nullif(v_tmp, array[]::text[]);
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'realtime_filter_premise', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'realtime_filter_premise', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;
  -- 22. GRANT-И КЛІЄНТСЬКИХ РОЛЕЙ — УВЕСЬ НАБІР, а не окремі назви (RF-04).
  --
  --     Перевірка №15 (`priv_drift`) стежить за НАЗВАНИМИ привілеями на кількох
  --     обʼєктах: 0166 — TRUNCATE і DELETE на простоях, 0178 — колонковий ACL
  --     `profiles`. Поза цим списком один `grant` з UI Supabase лишався
  --     невидимим для ВСЬОГО репозиторію: ні `db:gate`, ні тести, ні жоден
  --     інваріант його не бачили. Це і є RF-04 серпневого аудиту.
  --
  --     ⚠️ ЧОМУ КАТАЛОГ, А НЕ information_schema — це не смак, це ЗАМІР
  --        07.09.2026: `information_schema.role_table_grants` дає 236 рядків,
  --        `pg_class.relacl` — 284. Різниця РІВНО в 48 рядках `MAINTAIN` на
  --        25 обʼєктах у `anon` і `authenticated`: цієї привілеї PG17 у вʼюсі
  --        стандарту НЕМАЄ ВЗАГАЛІ, тож аудит, побудований на
  --        information_schema, її не побачить ніколи. Саме так апгрейд на
  --        PostgreSQL 17 мовчки повернув частину поверхні, яку 0166 прибирала
  --        (TRUNCATE), — і жоден сторож цього не помітив. Тому джерело істини
  --        тут — КАТАЛОГ: `pg_class.relacl`, `pg_attribute.attacl`, `pg_proc`.
  --        (Сам `MAINTAIN` у клієнтських ролей знято секцією 1 цієї міграції.)
  --
  --     Чотири гілки, один список offenders, ключ несе тип:
  --       t: обʼєкт:роль            — таблиці/вʼюхи/foreign (48 ключів);
  --       s: секвенція:роль         — секвенції (6);
  --       c: обʼєкт:роль:привілей   — КОЛОНКОВІ гранти без табличного, дайджест
  --                                   «кількість:md5(список колонок)» (4);
  --       f: сигнатура              — SECURITY DEFINER функції, які може
  --                                   виконати `anon`, дайджест
  --                                   «хто|власник|md5(тіла)» (11).
  --     Префікси offender-ів: `new:` / `missing:` / `changed:` (з новим
  --     дайджестом у тексті, щоб читати причину без другого запиту).
  --
  --     ⚠️ РОЛІ НЕ ХАРДКОДОМ — той самий канон, що в №15 після 0167: беремо
  --        членів `authenticator` (усі ролі, досяжні через PostgREST) без
  --        `service_role`, плюс PUBLIC. Пара ('anon','authenticated') зробила б
  --        нову клієнтську роль (портал, кіоск) невидимою з дня появи. Сьогодні
  --        це рівно anon + authenticated; НОВА роль сама дасть `new:`.
  --     ⚠️ `WITH GRANT OPTION` — частина дайджесту (`SELECT*`): без цього
  --        `grant select … with grant option` лишав би дайджест той самий, а
  --        роль отримувала б право роздавати доступ далі.
  --     ⚠️ Гілка f: пінить ТІЛО (ПОВНИЙ md5) і ВЛАСНИКА, а не лише «хто може
  --        викликати»: 7 з цих 11 функцій НЕ входять у список №19, і без піна
  --        тіла `create or replace auth_ceo_clinics() … select id from clinics`
  --        лишав би всі 22 перевірки зеленими, відкриваючи 23 політики RLS.
  --        md5 тут ПОВНИЙ, не `substr(…, 1, 12)` — це дайджест ТІЛА, той самий
  --        клас, що в №19, де усічення до 48 біт знято ревʼю с56. У гілці c:
  --        усічення лишається свідомо: там дайджест СПИСКУ КОЛОНОК із префіксом
  --        кількості, як у №16, а не тіла коду.
  --
  --     ⚠️ НАЗВАНІ МЕЖІ, щоб наступний не думав, що тут більше, ніж є:
  --       • `service_role` НЕ пінимо — це ключ бекенда, він і мусить обходити
  --         RLS; його поверхня — ротація ключа, а не цей сторож;
  --       • EXECUTE у `authenticated` на definer-функціях НЕ пінимо: їх 44 і
  --         вони ростуть із кожною фічею, а постійно червоний сторож — це
  --         видалений сторож (урок 0141). Тіла критичних тримає №19;
  --       • ЛИШЕ схема `public`. У `anon` є USAGE на storage/graphql/auth
  --         тощо, і дефолтний ACL грантора postgres у схемі `storage` досі
  --         роздає arwdDxtm — це поза цим сторожем і поза 0166 (0201: USAGE
  --         схем і сам default ACL для клієнтських ролей пінить №26
  --         `role_surface`; ОБʼЄКТИ поза `public` — як і раніше, ніхто);
  --       • НОВА таблиця зʼявиться як `new:` лише тому, що дефолтний ACL
  --         Supabase роздає її клієнтським ролям одразу. Таблиця, створена з
  --         `revoke all`, ключа НЕ дасть — сторож бачить ГРАНТИ, не обʼєкти;
  --       • дефолтний ACL грантора `supabase_admin` (arwdDxtm) нам недоступний
  --         (немає членства в ролі) — компенсація саме в тому, що новий обʼєкт
  --         червонить цю перевірку.
  v_n := v_n + 1;
  /* 0174 */ begin
  v_tmp := null;
  with roles as (
    select g.rolname::text as role
      from pg_auth_members m
      join pg_roles g on g.oid = m.roleid
      join pg_roles a on a.oid = m.member
     where a.rolname = 'authenticator' and g.rolname <> 'service_role'
    union all
    select 'PUBLIC'
  ), tbl as (
    select c.relname::text as obj, coalesce(r.rolname::text, 'PUBLIC') as role,
           a.privilege_type::text as priv, a.is_grantable as grantable,
           case when c.relkind = 'S' then 's' else 't' end as kind
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      cross join lateral aclexplode(coalesce(c.relacl,
             acldefault((case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner))) a
      left join pg_roles r on r.oid = a.grantee
     where c.relkind in ('r','p','v','m','f','S')
  ), col as (
    select c.relname::text as obj, coalesce(r.rolname::text, 'PUBLIC') as role,
           a.privilege_type::text as priv, a.is_grantable as grantable,
           att.attname::text as col
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      join pg_attribute att on att.attrelid = c.oid and att.attnum > 0
                           and not att.attisdropped and att.attacl is not null
      cross join lateral aclexplode(att.attacl) a
      left join pg_roles r on r.oid = a.grantee
     where coalesce(r.rolname::text, 'PUBLIC') in (select role from roles)
  ), cur as (
    select t.kind || ':' || t.obj || ':' || t.role as key,
           string_agg(t.priv || case when t.grantable then '*' else '' end,
                      ',' order by t.priv, t.grantable) as dig
      from tbl t
     where t.role in (select role from roles)
     group by t.kind, t.obj, t.role
    union all
    select 'c:' || cc.obj || ':' || cc.role || ':' || cc.priv,
           count(*)::text || ':' || substr(md5(string_agg(cc.col
             || case when cc.grantable then '*' else '' end, ',' order by cc.col)), 1, 12)
      from col cc
     where not exists (select 1 from tbl t
                        where t.obj = cc.obj and t.role = cc.role and t.priv = cc.priv)
     group by cc.obj, cc.role, cc.priv
    union all
    select 'f:' || p.oid::regprocedure::text,
           (case when exists (select 1 from aclexplode(coalesce(p.proacl,
                                     acldefault('f'::"char", p.proowner))) a2
                               where a2.grantee = 0 and a2.privilege_type = 'EXECUTE')
                 then 'PUBLIC' else 'anon' end)
           || '|' || pg_get_userbyid(p.proowner)
           || '|' || md5(replace(p.prosrc, chr(13), ''))
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
     where p.prosecdef and has_function_privilege('anon', p.oid, 'EXECUTE')
  ), expd(key, dig) as (values
      ('c:profiles:anon:SELECT','14:bc15fff8570c'),
      ('c:profiles:authenticated:SELECT','14:bc15fff8570c'),
      ('c:queue_entries:authenticated:UPDATE','29:91f234c4eb3e'),
      ('c:waitlist_entries:authenticated:UPDATE','18:6d6ddc9a7c36'),
      ('f:auth_can_refer(uuid)','PUBLIC|postgres|8772121e1ed3410fcc1b08a60536135c'),
      ('f:auth_ceo_clinics()','PUBLIC|postgres|05c87b00121560f1f6fd77a9b37c9c8a'),
      ('f:auth_clinic_id()','PUBLIC|postgres|0a84eccb25c3f3c0a83931e187ab01e0'),
      ('f:auth_is_admin()','PUBLIC|postgres|49afb4265fd2dad448b14271b2dbb1ab'),
      ('f:auth_is_ceo_of(uuid)','PUBLIC|postgres|a26e861747f8bacddc533dc727d164e4'),
      ('f:auth_is_referrer()','PUBLIC|postgres|72220a8e23c4fa3affef4e1394647fc8'),
      ('f:auth_radiologist_case_ok(uuid)','PUBLIC|postgres|2f00bbfa5160d1523f3a5974087b196d'),
      ('f:auth_radiologist_room_ok(uuid)','PUBLIC|postgres|059e3de0ed0f4969081261fe9afbe11e'),
      ('f:auth_referrer_can_book_room(uuid)','PUBLIC|postgres|d0678a0a757f5193fe151fa1abb13b61'),
      ('f:auth_referrer_clinics()','PUBLIC|postgres|a0e3f591688c27ea2c570a6a14753a12'),
      ('f:auth_referrer_visible_rooms()','PUBLIC|postgres|8337555d162570f5ad3054c9de2ad0d3'),
      ('s:audit_log_id_seq:anon','SELECT,UPDATE,USAGE'),
      ('s:audit_log_id_seq:authenticated','SELECT,UPDATE,USAGE'),
      ('s:event_outbox_id_seq:anon','SELECT,UPDATE,USAGE'),
      ('s:event_outbox_id_seq:authenticated','SELECT,UPDATE,USAGE'),
      ('s:maintenance_runs_id_seq:anon','SELECT,UPDATE,USAGE'),
      ('s:maintenance_runs_id_seq:authenticated','SELECT,UPDATE,USAGE'),
      ('t:audit_log:anon','REFERENCES,SELECT,TRIGGER'),
      ('t:audit_log:authenticated','REFERENCES,SELECT,TRIGGER'),
      ('t:ceo_access:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:ceo_access:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:cities:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:cities:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:clinic_deletion_requests:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:clinic_deletion_requests:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:clinics:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:clinics:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:doctors:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:doctors:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:event_outbox:anon','REFERENCES,TRIGGER'),
      ('t:event_outbox:authenticated','REFERENCES,TRIGGER'),
      ('t:important_events:authenticated','REFERENCES,SELECT,TRIGGER'),
      ('t:incidents:anon','INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:incidents:authenticated','INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:patient_cases:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER'),
      ('t:patient_cases:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER'),
      ('t:profiles:anon','DELETE,INSERT,REFERENCES,TRIGGER,UPDATE'),
      ('t:profiles:authenticated','DELETE,INSERT,REFERENCES,TRIGGER,UPDATE'),
      ('t:queue_delay_events:anon','REFERENCES,SELECT,TRIGGER'),
      ('t:queue_delay_events:authenticated','REFERENCES,SELECT,TRIGGER'),
      ('t:queue_entries:anon','INSERT,REFERENCES,SELECT,TRIGGER'),
      ('t:queue_entries:authenticated','INSERT,REFERENCES,SELECT,TRIGGER'),
      ('t:radiologist_rooms:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:radiologist_rooms:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:rate_limits:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:rate_limits:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:referral_access:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:referral_access:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:referrer_private:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:referrer_private:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:rooms:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:rooms:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:schedule_exceptions:anon','REFERENCES,SELECT,TRIGGER'),
      ('t:schedule_exceptions:authenticated','REFERENCES,SELECT,TRIGGER'),
      ('t:schedule_overrides:anon','REFERENCES,SELECT,TRIGGER'),
      ('t:schedule_overrides:authenticated','REFERENCES,SELECT,TRIGGER'),
      ('t:service_room_overrides:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:service_room_overrides:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:services:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:services:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:user_change_markers:authenticated','REFERENCES,SELECT,TRIGGER'),
      ('t:v_clinic_people:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:v_clinic_people:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:waitlist_entries:anon','INSERT,REFERENCES,SELECT,TRIGGER'),
      ('t:waitlist_entries:authenticated','INSERT,REFERENCES,SELECT,TRIGGER')
  )
  select array_agg(x.what order by x.what) into v_tmp
  from (
    select 'changed:' || c.key || ':' || e.dig || '->' || c.dig as what
      from cur c join expd e on e.key = c.key
     where e.dig <> c.dig
    union all
    select 'new:' || c.key || '->' || c.dig
      from cur c
     where not exists (select 1 from expd e where e.key = c.key)
    union all
    select 'missing:' || e.key
      from expd e
     where not exists (select 1 from cur c where c.key = e.key)
  ) x;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'grant_digest', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'grant_digest', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 23. ФОРМА СХЕМИ — останній непокритий шматок schema-contract manifest,
  --     якого просив аудит (RF-05).
  --
  --     Що вже стереглось до 0185: №16 політики, №17 тригери, №19 тіла
  --     функцій, №22 гранти. Форма ТАБЛИЦІ — ні. Тобто `alter table
  --     queue_entries alter column note drop not null` не бачив НІХТО:
  --     ні `db:gate` (він звіряє md5 ФАЙЛІВ міграцій, а не стан БД),
  --     ні тести, ні жоден із 22 інваріантів.
  --
  --     ПʼЯТЬ ГІЛОК, один список offenders, ключ несе тип:
  --       t:/v:/m:/p:/f: обʼєкт — КОЛОНКИ (імʼя, тип, NOT NULL, DEFAULT,
  --                      identity/generated), у порядку `attnum`;
  --       k: таблиця     — CONSTRAINT-и (імʼя, тип, повний `constraintdef`);
  --                      ⚠️ 0202: `clinics_timezone_chk` звужено до
  --                      ('Europe/Kyiv', 'UTC') — дайджест `k:clinics` передруковано;
  --       e: тип         — МІТКИ ENUM у порядку `enumsortorder`;
  --       u: таблиця     — УНІКАЛЬНІ ІНДЕКСИ, які НЕ підпирають constraint.
  --     Префікси offender-ів: `new:` / `missing:` / `changed:` (з новим
  --     дайджестом у тексті, щоб читати причину без другого запиту).
  --
  --     ⚠️ ЧОМУ ДАЙДЖЕСТ НА ОБʼЄКТ, А НЕ РЯДОК НА КОЛОНКУ — це ЗАМІР,
  --        09.09.2026: у схемі 367 колонок і 161 constraint; плоский список
  --        нормалізованих рядків важить 32 531 байт, і тіло сторожа виросло б
  --        з 97 025 до ~134 000. Тут 84 ключі ≈ 5 КБ. Це НЕ економія заради
  --        економії: кожен передрук коштує повну ревізію стендів, а тіло, що
  --        подвоїлось, подорожчає і DO-збірку накату, і кожен наступний пакет.
  --        Форму взято не зі стелі — це ТОЙ САМИЙ канон, що вже стоїть у
  --        гілці `c:` перевірки №22 і в №16: «кількість:md5(список)».
  --     ⚠️ ЩО ЦЕ КОШТУЄ, названо вголос: червоний каже «таблиця X змінилась»,
  --        а не «колонка X.note стала nullable». Префікс КІЛЬКОСТІ рятує
  --        половину: змінилось число — колонку додали/прибрали; число те саме,
  --        дайджест інший — змінили тип, NOT NULL, DEFAULT або identity.
  --        Далі — один запит по одній таблиці, а не по всій схемі.
  --     ⚠️ КАТАЛОГ, А НЕ information_schema — той самий урок, що приніс №22:
  --        `information_schema` не показала PG17-привілей MAINTAIN. Джерело
  --        істини — `pg_attribute`, `pg_attrdef`, `pg_constraint`, `pg_enum`,
  --        `pg_index`.
  --     ⚠️ ПОРЯДОК КОЛОНОК (`order by attnum`, НЕ по тексту) — свідомо, і ось
  --        ціна помилки: із сортуванням по тексту `drop column note` +
  --        `add column note text` дає ТОЙ САМИЙ дайджест, хоча дані колонки
  --        знищено. Те саме з обміном імен двох колонок однакового типу.
  --        `attnum` ловить обидва випадки. Порядок детермінований, бо БД
  --        відтворюється програванням міграцій, а не з дампа.
  --     ⚠️ ENUM — НЕ ПРИКРАСА, А ЗАМІР: рядок `pg_enum` трапляється в тілі
  --        сторожа **0** разів, а в схемі 10 enum-типів, серед них
  --        `queue_status` (8 міток) і `user_role` (5). Для колонки
  --        `text + CHECK` набір значень пінить гілка `k:`; для enum не пінило
  --        НІЩО — `format_type` віддає лише імʼя типу. Асиметрія була рівно
  --        на тій колонці, заради якої писалась ця перевірка:
  --        `alter type queue_status add value 'archived'` проходив мовчки.
  --     ⚠️ УНІКАЛЬНІ ІНДЕКСИ — теж ЗАМІР, а не обережність: 11 унікальних
  --        індексів не підпирають жодного constraint, і серед них
  --        `queue_one_in_progress_per_room`, `incidents_one_active_per_room`,
  --        `profiles_login_uidx`. ЧАСТКОВИЙ унікальний індекс у принципі не
  --        може бути constraint-ом (`WHERE` в UNIQUE заборонено), тому гілка
  --        `k:` його не бачить і не побачить ніколи — а це САМ бізнес-
  --        інваріант (0017/0018). Індекси ПРОДУКТИВНОСТІ свідомо не пінимо:
  --        вони не міняють ні видимості, ні контракту даних. `indisunique`
  --        міняє. `pg_get_indexdef` несе і `WHERE`, і opclass, і collation.
  --        Індекси, що підпирають constraint, ВИКЛЮЧЕНО (`conindid`), щоб
  --        одна правка не червонила дві гілки.
  --     ⚠️ УСІЧЕННЯ md5 до 12 знаків СВІДОМЕ і відрізняється від №19, де
  --        ревʼю с56 усічення зняло. Там пінилось ТІЛО КОДУ, тут — СПИСОК
  --        імен, типів і міток. Загроза тут — випадковий дрейф, а не підібрана
  --        колізія; 48 біт плюс незалежний префікс кількості з запасом. Той,
  --        хто має право на DDL, має дешевші шляхи (переписати `expd`), а тіло
  --        сторожа окремо пінить ПОВНИЙ md5 у пост-асерті міграції.
  --
  --     ⚠️ НАЗВАНІ МЕЖІ, щоб наступний не думав, що тут більше, ніж є:
  --       • НОВА таблиця БЕЗ жодного constraint дасть лише `new:t:`, ключа
  --         `k:` у неї не буде взагалі — гілка constraint-ів рахує тільки те,
  --         що існує. Червоною перевірка все одно стане (заміряно зондом A4);
  --       • вʼюхи: пінимо лише СПИСОК КОЛОНОК, не тіло. Тіло вʼюхи — це №8
  --         canonical_objects і №1 security_invoker;
  --       • ДОМЕНИ НЕ ПОКРИТІ: гілка `k:` джойнить `co.conrelid`, а доменний
  --         constraint має `conrelid = 0` і мовчки випадає. Сьогодні доменів у
  --         схемі 0, але той, хто побачить імʼя домену в дайджесті колонки,
  --         не мусить вирішити, що сам домен запінено;
  --       • COLLATION колонки не входить у `format_type`, тобто
  --         `alter column ... type text collate "C"` лишиться зеленим у гілці
  --         `t:`. Індексований підклас накриває гілка `u:`;
  --       • індекси ПРОДУКТИВНОСТІ, comment, storage, compression, наслідування
  --         — свідомо поза межами: контракту даних і видимості не міняють;
  --       • RLS-прапорець таблиці — це №3, не тут. ⚠️ Але №3 фільтрує
  --         `relkind = 'r'`, тож СЕКЦІОНОВАНА таблиця без RLS не видна ні їй,
  --         ні (до цієї міграції) нам. Тут `relkind` розширено до
  --         `r,v,m,p,f`; №3 лишається вузькою — це окремий борг;
  --       • ЛИШЕ схема `public`. `alter table public.x set schema app` дасть
  --         `missing:t:` + `missing:k:`, тобто переїзд помітний;
  --       • апгрейд мажорної версії Postgres, який змінить вивід
  --         `format_type`, `pg_get_constraintdef` або `pg_get_indexdef`,
  --         ЗРОБИТЬ цю перевірку червоною. Це не дефект, це задум — рівно так
  --         PG17 мовчки повернув привілей MAINTAIN, і ніхто не помітив (№22).
  v_n := v_n + 1;
  -- ⚠️ МАРКЕР РИШТУВАНЬ НИЖЧЕ — 0174, А НЕ 0185, І ЦЕ НЕ ОПИСКА. Він називає
  --    КОНВЕНЦІЮ (обгортку fail-loud, введену 0174), а не міграцію, що
  --    написала рядок. `tests/invariantsFailLoud.test.ts` рахує рядки саме за
  --    ним і вимагає «обгорток = перевірок − 1»; перша редакція цієї гілки
  --    мала власний маркер — і чотири тести того файла почервоніли.
  /* 0174 */ begin
  v_tmp := null;
  with tabs as (
    select c.oid, c.relname::text as obj, c.relkind
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
     where c.relkind in ('r', 'v', 'm', 'p', 'f')
  ), col as (
    select t.obj, t.relkind, a.attnum,
           a.attname::text || ':' || format_type(a.atttypid, a.atttypmod)
             || case when a.attnotnull then '!' else '' end
             || coalesce('=' || pg_get_expr(d.adbin, d.adrelid), '')
             || case when a.attidentity::text = '' then ''
                     else '#' || a.attidentity::text end
             || case when a.attgenerated::text = '' then ''
                     else '@' || a.attgenerated::text end as line
      from tabs t
      join pg_attribute a
        on a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
      left join pg_attrdef d
        on d.adrelid = a.attrelid and d.adnum = a.attnum
  ), colagg as (
    select (case when relkind = 'r' then 't:'
                 when relkind = 'v' then 'v:'
                 else relkind::text || ':' end) || obj as key,
           count(*)::text || ':'
             || substr(md5(string_agg(line, ',' order by attnum)), 1, 12) as dig
      from col group by relkind, obj
  ), kon as (
    select 'k:' || rel.relname::text as key,
           co.conname::text || ':' || co.contype::text || ':'
             || pg_get_constraintdef(co.oid) as line
      from pg_constraint co
      join pg_namespace n on n.oid = co.connamespace and n.nspname = 'public'
      join pg_class rel on rel.oid = co.conrelid
      join pg_namespace rn
        on rn.oid = rel.relnamespace and rn.nspname = 'public'
     where rel.relkind in ('r', 'p')
  ), konagg as (
    select key,
           count(*)::text || ':'
             || substr(md5(string_agg(line, ',' order by line)), 1, 12) as dig
      from kon group by key
  ), enu as (
    select 'e:' || t.typname::text as key,
           count(*)::text || ':'
             || substr(md5(string_agg(e.enumlabel::text, ',' order by e.enumsortorder)), 1, 12) as dig
      from pg_type t
      join pg_namespace n on n.oid = t.typnamespace and n.nspname = 'public'
      join pg_enum e on e.enumtypid = t.oid
     group by t.typname
  ), idx as (
    select 'u:' || rel.relname::text as key,
           ic.relname::text || ':' || pg_get_indexdef(i.indexrelid) as line
      from pg_index i
      join pg_class ic on ic.oid = i.indexrelid
      join pg_class rel on rel.oid = i.indrelid
      join pg_namespace n on n.oid = ic.relnamespace and n.nspname = 'public'
     where i.indisunique and rel.relkind in ('r', 'p')
       and not exists (select 1 from pg_constraint c
                        where c.conindid = i.indexrelid)
  ), idxagg as (
    select key,
           count(*)::text || ':'
             || substr(md5(string_agg(line, ',' order by line)), 1, 12) as dig
      from idx group by key
  ), cur as (
    select key, dig from colagg
    union all select key, dig from konagg
    union all select key, dig from enu
    union all select key, dig from idxagg
  ), expd(key, dig) as (values
      ('e:call_status','5:3435f2ba4c42'),
      ('e:case_status','3:2b4224315c0f'),
      ('e:ceo_access_status','2:c48ec666f139'),
      ('e:modality','6:f2f92eb0d563'),
      ('e:patient_priority','3:7cd89947f2fa'),
      ('e:queue_status','8:687448b0d634'),
      ('e:referral_access_status','5:cdd794322bcf'),
      ('e:referral_policy','2:35ade64d5660'),
      ('e:user_role','5:fd42ed971bc6'),
      ('e:waitlist_status','4:da9acda38698'),
      ('k:audit_log','2:89d3cbb4a7f2'),
      ('k:ceo_access','5:f21a4f0c35ba'),
      ('k:change_marker_settings','2:42feccb77730'),
      ('k:cities','2:41b7baa82710'),
      ('k:clinic_deletion_requests','4:1c52aa29a80a'),
      ('k:clinics','5:2d77f97c5c03'),
      ('k:doctors','2:17a25dce0f17'),
      ('k:event_outbox','1:2d9335d323d9'),
      ('k:external_refs','6:c4e7a8000bca'),
      ('k:google_calendar_connections','13:5059791b44ef'),
      ('k:google_oauth_states','6:9e6e1d66dd28'),
      ('k:important_events','6:b05420aecbc3'),
      ('k:inbound_events','6:a6b07ee311c4'),
      ('k:incidents','6:011c15dc4144'),
      ('k:integration_keys','8:ce63bea44a92'),
      ('k:integration_webhooks','5:99174b1cc2ab'),
      ('k:maintenance_runs','1:0fdff0bc3e82'),
      ('k:migration_ledger','1:5c36215da16a'),
      ('k:patient_cases','4:882687b5af46'),
      ('k:profiles','5:badfe89d1681'),
      ('k:queue_delay_events','5:4491f3b0db39'),
      ('k:queue_entries','9:9d8b705b7da2'),
      ('k:radiologist_rooms','5:e09e054d60a6'),
      ('k:rate_limits','1:dce738e925d0'),
      ('k:referral_access','5:18a762e1100a'),
      ('k:referrer_private','2:33d0dec0cb95'),
      ('k:rooms','2:b01bdbfb172c'),
      ('k:schedule_exceptions','4:1416d00130de'),
      ('k:schedule_overrides','3:6d07bd7f0de7'),
      ('k:service_room_overrides','7:fddbdffbfc23'),
      ('k:services','9:3d06049d364c'),
      ('k:user_change_markers','9:b1a0b3e5cb5b'),
      ('k:waitlist_entries','11:0a97104cd02a'),
      ('t:audit_log','9:e7c935cc9603'),
      ('t:ceo_access','8:6c559b48942f'),
      ('t:change_marker_settings','2:cd318d227647'),
      ('t:cities','8:bb6bf36b11a4'),
      ('t:clinic_deletion_requests','11:29f8a2c0a0fe'),
      ('t:clinics','13:d05f5b7b7c2d'),
      ('t:doctors','7:4f137047cfe9'),
      ('t:event_outbox','12:e38f35ee1351'),
      ('t:external_refs','8:597b93f93182'),
      ('t:google_calendar_connections','17:36bdf007ed9c'),
      ('t:google_oauth_states','7:281ed3199d84'),
      ('t:important_events','12:3a7dc07a650f'),
      ('t:inbound_events','11:c492bf0af555'),
      ('t:incidents','12:798c3315c9bc'),
      ('t:integration_keys','11:9a72ee11fbb2'),
      ('t:integration_webhooks','8:642e395f3376'),
      ('t:maintenance_runs','4:6a2a444fcd61'),
      ('t:migration_ledger','4:4786eff032d2'),
      ('t:patient_cases','15:7cb038adcad8'),
      ('t:profiles','16:fdcb25b103d9'),
      ('t:queue_delay_events','12:efb2c55e0549'),
      ('t:queue_entries','40:968b94b95833'),
      ('t:radiologist_rooms','5:a1e0beab6ea3'),
      ('t:rate_limits','3:e56d35f7a3c2'),
      ('t:referral_access','12:d41461af40e5'),
      ('t:referrer_private','3:365ae409951f'),
      ('t:rooms','8:a83feb0308a3'),
      ('t:schedule_exceptions','10:d2df456c4757'),
      ('t:schedule_overrides','8:4524d9ad9c25'),
      ('t:service_room_overrides','9:9d7ce7f68824'),
      ('t:services','15:1902e495f3aa'),
      ('t:user_change_markers','19:3bc51f7bc42b'),
      ('t:waitlist_entries','28:d7f20a096a09'),
      ('u:clinic_deletion_requests','1:0ee4d51147b9'),
      ('u:incidents','1:08798e7ff88d'),
      ('u:profiles','2:7596631db09a'),
      ('u:queue_entries','2:fb4bf02fa23e'),
      ('u:services','3:efee9f060dfd'),
      ('u:user_change_markers','1:fe360b1335a6'),
      ('u:waitlist_entries','1:74a0ae5ec670'),
      ('v:v_clinic_people','11:06df06efdc81')
  )
  select array_agg(x.what order by x.what) into v_tmp
  from (
    select 'changed:' || c.key || ':' || e.dig || '->' || c.dig as what
      from cur c join expd e on e.key = c.key
     where e.dig <> c.dig
    union all
    select 'new:' || c.key || '->' || c.dig
      from cur c
     where not exists (select 1 from expd e where e.key = c.key)
    union all
    select 'missing:' || e.key
      from expd e
     where not exists (select 1 from cur c where c.key = e.key)
  ) x;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'schema_digest', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'schema_digest', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 24. Сироти в `auth`: акаунт, який МОЖЕ автентифікуватись, але профілю
  --     не має. Він проходить як `authenticated`, тобто всі 45 definer-функцій,
  --     виданих цій ролі, для нього відкриті; тримає його рівно те, що
  --     `auth_role()` і `auth_clinic_id()` повертають null.
  --     ЗАМІРЯНО 15.09 зондом під таким акаунтом (відкочена транзакція):
  --       profiles 0 · clinics 0 · queue_entries 0 · waitlist_entries 0
  --       rooms 0 · services 0 · audit_log 0 · incidents 0
  --       auth_role()=null · auth_clinic_id()=null · is_admin/desk/referrer=false
  --     Тобто діра не в тому, ЩО він бачить, а в тому, що він існує і про
  --     нього не знає НІХТО. Пʼять таких пролежали в проді з 22 і 26 червня.
  --
  --     ⚠️ ЧОМУ З ЧАСОВИМ ПОРОГОМ, А НЕ «жодної сироти». Штатне створення
  --        (staff / referrer / ceo) іде ДВОМА кроками: `auth.admin.createUser`,
  --        потім insert у `profiles`. Між ними акаунт — ЗАКОННО сирота, долі
  --        секунди. Без порогу сторож червонів би на кожному створенні
  --        персоналу, тобто був би шумом; а шум вимикають. 15 хв — на два
  --        порядки більше за реальне вікно і на порядок менше за добу між
  --        прогонами крона.
  --
  --     ⚠️ САМОРЕЄСТРАЦІЯ СЮДИ НЕ ПОТРАПЛЯЄ і потрапити не може:
  --        `on_auth_user_created` — AFTER INSERT тригер у ТІЙ САМІЙ
  --        транзакції, тож виняток у `handle_new_user` відкочує і сам
  --        auth-рядок. Сирота народжується лише на шляху `managed=true`, де
  --        профіль пише роут, а компенсуючий `deleteUser` ходить по мережі
  --        й може не дійти (0197, частина 1).
  --
  --     ⚠️ В offenders — id і ДАТА створення, без пошти. `maintenance_runs`
  --        має RLS без жодної політики (жоден клієнт її не читає), а сам
  --        `invariants_check` виданий лише `postgres` і `service_role` —
  --        але правило «секрети і ПІІ нікуди» не залежить від того, хто
  --        сьогодні має грант.
  v_n := v_n + 1;
  /* 0174 */ begin
  select array_agg(u.id::text || '@' || to_char(u.created_at at time zone 'UTC', 'YYYY-MM-DD')
                   order by u.id::text) into v_tmp
    from auth.users u
   where not exists (select 1 from public.profiles p where p.id = u.id)
     and u.created_at < now() - interval '15 minutes';
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'auth_orphan_accounts', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'auth_orphan_accounts', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 25. Тіло САМОГО сторожа звірене з піном, який ставить МІГРАЦІЯ.
  --     До 0198 це була єдина річ у схемі, яку не тримало НІЩО (0201: НЕ
  --     єдина — межі 1–2 аудиту 0191 теж не тримало ніщо, див. №26):
  --     `create or replace function public.invariants_check` повз міграцію
  --     не бачила жодна з 24 перевірок і жоден тест. Заміряно 15.09:
  --     власного підпису в списку №19 НЕМАЄ, тести читають ФАЙЛ міграції,
  --     а не прод-`prosrc`. Свойство «тіло те саме» трималось ритуалом
  --     накату (предстан + пост-асерт у кожному пакеті) і №7 `ledger_md5`,
  --     тобто ПРОЦЕДУРОЮ. Пункт М-4 / Н-1.
  --
  --     ⚠️ ДЕ ЛЕЖИТЬ ПІН І ЧОМУ САМЕ ТАМ — замір, а не смак. Пін у
  --        КОМЕНТАРІ до функції. Зонд на проді (відкочена транзакція):
  --          comment_before = (NULL) · oid_same = true
  --          comment_survives_replace = true
  --        `create or replace` не міняє oid і НЕ чіпає коментар — отже
  --        підміна тіла лишає пін старим, і ця перевірка червоніє.
  --        `drop function` + `create` коментар ГУБИТЬ — тоді червоніє
  --        гілка «пін ВІДСУТНІЙ». Обидва шляхи гучні.
  --
  --     ⚠️ ЧОМУ НЕ ПІН УСЕРЕДИНІ ТІЛА (самопосилання з маскуванням): він
  --        мандрував би РАЗОМ із тілом, тож ВІДКАТ на старе тіло лишався б
  --        зеленим. Зовнішній пін ловить і підміну, і відкат.
  --        ⚠️ ЧОМУ НЕ ОКРЕМА ТАБЛИЦЯ: вона тягне RLS (№3), ключ `t:` у №23
  --        і, можливо, №22 — три передруки заради одного рядка.
  --
  --     ⚠️ ЩО ЦЕ НЕ ЛОВИТЬ, і сказати це треба прямо: той, хто має право
  --        на `create or replace`, має право й на `comment on function`.
  --        Перевірка ловить ДРЕЙФ — правку повз міграцію, відкат, забутий
  --        крок у передруку, — а не зловмисника з правами postgres. Саме
  --        дрейф і був класом, що двічі вкусив у с69.
  --
  --     ⚠️ ЗВІРЯЄТЬСЯ І ДОВЖИНА, не лише md5. Інакше `len=` було б оздобою,
  --        яку не тримає ніхто, а напівоновлений пін (md5 новий, len старий)
  --        читався б як справний.
  --     ⚠️ ФОРМА ПІНА ПІННА САМА: рядок мусить збігтись із регуляркою
  --        цілком. Інакше «пін є, але нечитаний» мовчки означало б «пін є».
  --        І окремою гілкою — ВІДСУТНІЙ ПІДПИС: якби фільтр за
  --        `identity_arguments` колись розійшовся з дійсністю, підзапит дав
  --        би НУЛЬ рядків і перевірка зеленіла б ні на чому (клас I-8).
  v_n := v_n + 1;
  /* 0174 */ begin
  select array_agg(x.txt order by x.txt) into v_tmp
    from (
      select 'ПІДПИС invariants_check(p_write boolean) не знайдено' as txt
       where not exists (
         select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'invariants_check'
            and pg_get_function_identity_arguments(p.oid) = 'p_write boolean')
      union all
      select case
               when d.pin is null
                 then 'пін ВІДСУТНІЙ (коментар знято або функцію перестворено)'
               when d.pin !~ '^guard_body_md5=[0-9a-f]{32};len=[0-9]+$'
                 then 'пін НЕЧИТАНИЙ: ' || left(d.pin, 60)
               else 'тіло ' || d.body || '/' || d.blen || ' проти піна '
                    || substring(d.pin from 'guard_body_md5=([0-9a-f]{32})')
                    || '/' || coalesce(substring(d.pin from ';len=([0-9]+)$'), '?')
             end
        from (
          select obj_description(p.oid, 'pg_proc')            as pin,
                 md5(replace(p.prosrc, chr(13), ''))          as body,
                 length(replace(p.prosrc, chr(13), ''))       as blen
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'invariants_check'
             and pg_get_function_identity_arguments(p.oid) = 'p_write boolean'
        ) d
       where d.pin is null
          or d.pin !~ '^guard_body_md5=[0-9a-f]{32};len=[0-9]+$'
          or d.body is distinct from substring(d.pin from 'guard_body_md5=([0-9a-f]{32})')
          or d.blen::text is distinct from substring(d.pin from ';len=([0-9]+)$')
    ) x;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'guard_self_pin', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'guard_self_pin', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 26. ПОВЕРХНЯ КЛІЄНТСЬКИХ РОЛЕЙ ПОЗА ПРЯМИМИ ГРАНТАМИ (0201, Р74-2(б)).
  --     `;acl=` у №19 і дайджест №22 бачать лише ПРЯМІ гранти на обʼєкти
  --     `public`. Членства, ACL схем і бази, default ACL, атрибути й
  --     налаштування ролей до 0201 не ПІНИЛА жодна перевірка (№15/№18/№22
  --     читають членство лише щоб знайти клієнтські ролі; №15(b) — лише
  --     TRUNCATE у default ACL схеми public); успадковане право бачили
  --     тільки окремі has_*_privilege-гілки №15 і №18 на названих привілеях
  --     (і `f:` №22 — лише для `anon`). Кожен обхід заміряно 15.09 зондом у
  --     відкоченій транзакції від ролі `postgres`:
  --       ПРОХОДИТЬ:
  --       • `grant <роль> to authenticated` — клієнт успадковує чужі права;
  --       • новий LOGIN-член `authenticated` — прямий SQL під клієнтською
  --         роллю сам виставляє `request.jwt.claims`, тобто стає будь-ким;
  --       • `alter role authenticated set session_replication_role = replica`
  --         (supautils це дозволяє). ⚠️ Чи застосовує PostgREST цей параметр
  --         (контекст superuser) у клієнтських сесіях — НЕ заміряно; якщо так,
  --         це вимкнення звичайних тригерів, тобто гардів №17. Пінимо в будь-
  --         якому разі;
  --       • `alter role authenticator set pgrst.db_schemas = …` — інша
  --         поверхня PostgREST;
  --       • `grant create on schema public`, `grant create on database`,
  --         `alter default privileges …` у схемі і глобально;
  --       БЛОКУЄТЬСЯ (42501): `alter role authenticated bypassrls` (reserved
  --       role, supautils); `grant set on parameter`; `alter role … set
  --       "request.jwt.claim.sub"`; `alter database … set` для
  --       session_replication_role, request.jwt.*, safeupdate.enabled.
  --
  --     Ключі (одне множинне порівняння, як у №22; `new:` / `missing:` /
  --     `changed:` з очікуваним і фактичним):
  --       m: роль:член               — членства, де хоч один бік клієнтський;
  --                                    грантор і admin/inherit/set КОЖНОГО
  --                                    гранта (PG16+ їх буває кілька на пару);
  --       r: роль                    — super/createrole/createdb/bypassrls/
  --                                    inherit/login/replication;
  --       g: роль:база|*             — налаштування ролі, КРІМ таймаутів і
  --                                    спостережуваності;
  --       n: схема:грантей           — ACL усіх схем, крім toast і тимчасових;
  --       d: власник:схема|*:тип:грантей — default ACL; для глобального рядка
  --                                    f/T без PUBLIC — синтетичне `<none>`;
  --       b: грантей                 — ACL поточної бази.
  --     Грантей — клієнтська роль або PUBLIC (grantee = 0): грант на PUBLIC
  --     дістається і anon, і authenticated, а `revoke … from anon` його не знімає.
  --     Дайджест прав — DISTINCT і з `*` за grant option: другий грантор тієї ж
  --     привілеї не червонить, а порядок детермінований (`collate "C"`).
  --     Базис 15.09: 62 ключі (m 7, r 3, g 1, n 20, d 30, b 1).
  --
  --     ⚠️ РОЛІ НЕ ХАРДКОДОМ і ТРАНЗИТИВНО: `authenticator` і замикання ролей,
  --        членом яких він є, без `service_role`. Нова клієнтська роль сама
  --        дасть `new:m:<роль>:authenticator` і `new:r:`; роль, яку клієнт
  --        успадковує через іншу, — теж (ревʼю с74: без замикання дрейф
  --        уже запіненої проміжної ролі був невидимий).
  --     ⚠️ ОБИДВА НАПРЯМКИ членства: `member` клієнтський — що клієнт
  --        УСПАДКОВУЄ; `roleid` клієнтський — хто може СТАТИ клієнтом.
  --     ⚠️ ПОЗА `g:` СВІДОМО (регулярка нижче): таймаути і
  --        спостережуваність/тюнінг зі списку supautils (log_*, track_*,
  --        pgaudit.*, auto_explain.*, pg_stat_statements.*, plan_filter.*,
  --        pg_net.*, deadlock_timeout, wal_compression). Їх законно крутять —
  --        той самий pgaudit для медичного аудиту, — а вічно червоний сторож
  --        — знятий сторож (урок 0141). ⚠️ Виключення двобічне: і ВИМКНЕННЯ
  --        (`pgaudit.log = none` на ролі) пройде мовчки — це межа. Небезпечні
  --        з того ж списку (`pgrst.*`, `safeupdate.enabled`,
  --        `session_replication_role`) лишаються в `g:`.
  --
  --     ⚠️ НАЗВАНІ МЕЖІ:
  --       • `service_role` як ГРАНТЕЙ і як вершину замикання не пінимо (канон
  --         0163): його поверхня — ротація ключа. Членство
  --         `service_role ← authenticator` пінимо, бо член клієнтський;
  --       • ДРУГИЙ ХІД «хто може стати клієнтом»: `grant
  --         supabase_storage_admin to <роль>` не дає ключа (жоден бік не
  --         клієнтський), хоча та роль може `SET ROLE authenticator`. Від
  --         `postgres` недосяжно — ADMIN на `supabase_storage_admin` у нього
  --         немає (замір 15.09);
  --       • `grant set on parameter` (`pg_parameter_acl`) — поза: від
  --         `postgres` не можна ні видати, ні відкликати, тож і фальсифікувати
  --         гілку нічим. `r:` на відміну від неї фальсифікується: нова
  --         клієнтська роль дає `new:r:`;
  --       • налаштування БАЗИ для всіх ролей (`alter database … set`) — поза:
  --         небезпечні параметри там від `postgres` заблоковано (див. вище),
  --         а USERSET (`search_path`, навіть `role`) проходить, але PostgREST
  --         ставить роль і шлях ЛОКАЛЬНО в кожному запиті, а без CREATE на схемі
  --         (`n:`) тіньових обʼєктів клієнту не створити. Там же живе
  --         `app.settings.jwt_exp`;
  --       • мови, типи, FDW-сервери, великі обʼєкти — поза;
  --       • ОБʼЄКТИ в схемах поза `public` (таблиці storage, функції graphql)
  --         — як і раніше, ніхто: тут лише право на схему і дефолти для
  --         МАЙБУТНІХ обʼєктів;
  --       • `revoke` від НЕ-грантора — тиша в самому Postgres (замір 15.09:
  --         `revoke usage on schema graphql_public from anon` від postgres не
  --         знімає гранту supabase_admin), тож і ключ не змінюється — так і
  --         мусить бути;
  --       • платформа Supabase (грантор `supabase_admin`) може змінити свої
  --         дефолти чи членства при оновленні, а ввімкнене в дашборді
  --         розширення — додати схему з USAGE для `anon`. Перевірка
  --         ПОЧЕРВОНІЄ, і це не шум, а сигнал: поверхня клієнта змінилась без
  --         міграції. Порядок той самий, що для №22, — розібратись і
  --         передрукувати;
  --       • як і №25, ловить ДРЕЙФ, а не зловмисника з правами postgres.
  v_n := v_n + 1;
  /* 0174 */ begin
  v_tmp := null;
  with recursive cr(oid) as (
    -- клієнтські ролі: `authenticator` і ТРАНЗИТИВНО всі ролі, членом яких він
    -- є (ким може стати і що успадковує), крім `service_role`; хардкоду імен
    -- немає. Сьогодні це рівно anon, authenticated, authenticator.
    select r.oid
      from pg_roles r
     where r.rolname = 'authenticator'
    union
    select m.roleid
      from pg_auth_members m
      join cr on cr.oid = m.member
      join pg_roles g on g.oid = m.roleid
     where g.rolname <> 'service_role'
  ), cur as (
    -- m: членство, де ХОЧ ОДИН бік клієнтський; PG16+ дає кілька грантів на
    --    пару — тому агрегат, а не рядок
    select 'm:' || pg_get_userbyid(m.roleid) || ':' || pg_get_userbyid(m.member) as key,
           string_agg('grantor=' || pg_get_userbyid(m.grantor)
                      || ',admin=' || m.admin_option::text
                      || ',inherit=' || m.inherit_option::text
                      || ',set=' || m.set_option::text,
                      '|' order by pg_get_userbyid(m.grantor) collate "C") as dig
      from pg_auth_members m
     where m.roleid in (select oid from cr) or m.member in (select oid from cr)
     group by m.roleid, m.member
    union all
    -- r: атрибути самої ролі
    select 'r:' || r.rolname,
           'super=' || r.rolsuper::text || ',createrole=' || r.rolcreaterole::text
           || ',createdb=' || r.rolcreatedb::text || ',bypassrls=' || r.rolbypassrls::text
           || ',inherit=' || r.rolinherit::text || ',login=' || r.rolcanlogin::text
           || ',replication=' || r.rolreplication::text
      from pg_roles r
     where r.oid in (select oid from cr)
    union all
    -- g: налаштування ролі (у будь-якій базі), КРІМ таймаутів і спостережуваності
    select 'g:' || pg_get_userbyid(s.setrole) || ':'
           || coalesce((select quote_ident(d.datname) from pg_database d where d.oid = s.setdatabase), '*'),
           string_agg(c.cfg, '|' order by c.cfg collate "C")
      from pg_db_role_setting s
      cross join lateral unnest(s.setconfig) c(cfg)
     where s.setrole in (select oid from cr)
       and split_part(c.cfg, '=', 1) !~* '^(statement_timeout|lock_timeout|idle_in_transaction_session_timeout|idle_session_timeout|transaction_timeout|deadlock_timeout|wal_compression|log_[a-z_]+|track_[a-z_]+|(pgaudit|auto_explain|pg_stat_statements|plan_filter|pg_net)[.][a-z0-9_.]+)$'
     group by s.setrole, s.setdatabase
    union all
    -- n: ACL КОЖНОЇ схеми (крім тимчасових і toast) для клієнта або PUBLIC
    select 'n:' || n.nspname || ':' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
           string_agg(distinct v.pv collate "C", ',' order by v.pv collate "C")
      from pg_namespace n
      cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n'::"char", n.nspowner))) a
      cross join lateral (select a.privilege_type || case when a.is_grantable then '*' else '' end as pv) v
     where n.nspname !~ '^pg_(toast|temp_|toast_temp_)'
       and (a.grantee = 0 or a.grantee in (select oid from cr))
     group by n.nspname, a.grantee
    union all
    -- d: default ACL, і в схемі, і глобальний (`defaclnamespace = 0` → `*`);
    --    імʼя схеми — сире, як у n: (regnamespace::text залежить від
    --    quote_all_identifiers сесії)
    select 'd:' || pg_get_userbyid(d.defaclrole) || ':'
           || case when d.defaclnamespace = 0 then '*'
                   else coalesce((select dn.nspname::text from pg_namespace dn where dn.oid = d.defaclnamespace), '?') end
           || ':' || d.defaclobjtype::text || ':'
           || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
           string_agg(distinct v.pv collate "C", ',' order by v.pv collate "C")
      from pg_default_acl d
      cross join lateral aclexplode(d.defaclacl) a
      cross join lateral (select a.privilege_type || case when a.is_grantable then '*' else '' end as pv) v
     where a.grantee = 0 or a.grantee in (select oid from cr)
     group by d.defaclrole, d.defaclnamespace, d.defaclobjtype, a.grantee
    union all
    -- d: СИНТЕТИЧНИЙ ключ — глобальний default ACL для f/T БЕЗ PUBLIC. Вбудований
    --    дефолт цих типів дає PUBLIC право, тож такий рядок — ОБМЕЖЕННЯ. Його
    --    зняття видаляє рядок (ACL знову дорівнює вбудованому) і мусить дати
    --    `missing:`, а не тишу.
    select 'd:' || pg_get_userbyid(d.defaclrole) || ':*:' || d.defaclobjtype::text || ':PUBLIC', '<none>'
      from pg_default_acl d
     where d.defaclnamespace = 0
       and d.defaclobjtype in ('f', 'T')
       and not exists (select 1 from aclexplode(d.defaclacl) x where x.grantee = 0)
    union all
    -- b: ACL поточної бази (CREATE тут = право створювати схеми)
    select 'b:' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
           string_agg(distinct v.pv collate "C", ',' order by v.pv collate "C")
      from pg_database db
      cross join lateral aclexplode(coalesce(db.datacl, acldefault('d'::"char", db.datdba))) a
      cross join lateral (select a.privilege_type || case when a.is_grantable then '*' else '' end as pv) v
     where db.datname = current_database()
       and (a.grantee = 0 or a.grantee in (select oid from cr))
     group by a.grantee
  ), expd(key, dig) as (values
      ('b:PUBLIC','CONNECT,TEMPORARY'),
      ('d:postgres:public:S:anon','SELECT,UPDATE,USAGE'),
      ('d:postgres:public:S:authenticated','SELECT,UPDATE,USAGE'),
      ('d:postgres:public:f:anon','EXECUTE'),
      ('d:postgres:public:f:authenticated','EXECUTE'),
      ('d:postgres:public:r:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('d:postgres:public:r:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('d:postgres:storage:S:anon','SELECT,UPDATE,USAGE'),
      ('d:postgres:storage:S:authenticated','SELECT,UPDATE,USAGE'),
      ('d:postgres:storage:f:anon','EXECUTE'),
      ('d:postgres:storage:f:authenticated','EXECUTE'),
      ('d:postgres:storage:r:anon','DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('d:postgres:storage:r:authenticated','DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('d:supabase_admin:graphql:S:anon','SELECT,UPDATE,USAGE'),
      ('d:supabase_admin:graphql:S:authenticated','SELECT,UPDATE,USAGE'),
      ('d:supabase_admin:graphql:f:anon','EXECUTE'),
      ('d:supabase_admin:graphql:f:authenticated','EXECUTE'),
      ('d:supabase_admin:graphql:r:anon','DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('d:supabase_admin:graphql:r:authenticated','DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('d:supabase_admin:graphql_public:S:anon','SELECT,UPDATE,USAGE'),
      ('d:supabase_admin:graphql_public:S:authenticated','SELECT,UPDATE,USAGE'),
      ('d:supabase_admin:graphql_public:f:anon','EXECUTE'),
      ('d:supabase_admin:graphql_public:f:authenticated','EXECUTE'),
      ('d:supabase_admin:graphql_public:r:anon','DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('d:supabase_admin:graphql_public:r:authenticated','DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('d:supabase_admin:public:S:anon','SELECT,UPDATE,USAGE'),
      ('d:supabase_admin:public:S:authenticated','SELECT,UPDATE,USAGE'),
      ('d:supabase_admin:public:f:anon','EXECUTE'),
      ('d:supabase_admin:public:f:authenticated','EXECUTE'),
      ('d:supabase_admin:public:r:anon','DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('d:supabase_admin:public:r:authenticated','DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('g:authenticator:*','session_preload_libraries=supautils, safeupdate'),
      ('m:anon:authenticator','grantor=supabase_admin,admin=false,inherit=false,set=true'),
      ('m:anon:postgres','grantor=supabase_admin,admin=true,inherit=true,set=true'),
      ('m:authenticated:authenticator','grantor=supabase_admin,admin=false,inherit=false,set=true'),
      ('m:authenticated:postgres','grantor=supabase_admin,admin=true,inherit=true,set=true'),
      ('m:authenticator:postgres','grantor=supabase_admin,admin=true,inherit=true,set=true'),
      ('m:authenticator:supabase_storage_admin','grantor=supabase_admin,admin=false,inherit=false,set=true'),
      ('m:service_role:authenticator','grantor=supabase_admin,admin=false,inherit=false,set=true'),
      ('n:auth:anon','USAGE'),
      ('n:auth:authenticated','USAGE'),
      ('n:extensions:anon','USAGE'),
      ('n:extensions:authenticated','USAGE'),
      ('n:graphql:anon','USAGE'),
      ('n:graphql:authenticated','USAGE'),
      ('n:graphql_public:anon','USAGE'),
      ('n:graphql_public:authenticated','USAGE'),
      ('n:information_schema:PUBLIC','USAGE'),
      ('n:net:PUBLIC','USAGE'),
      ('n:net:anon','USAGE'),
      ('n:net:authenticated','USAGE'),
      ('n:pg_catalog:PUBLIC','USAGE'),
      ('n:public:PUBLIC','USAGE'),
      ('n:public:anon','USAGE'),
      ('n:public:authenticated','USAGE'),
      ('n:realtime:anon','USAGE'),
      ('n:realtime:authenticated','USAGE'),
      ('n:storage:anon','USAGE'),
      ('n:storage:authenticated','USAGE'),
      ('r:anon','super=false,createrole=false,createdb=false,bypassrls=false,inherit=true,login=false,replication=false'),
      ('r:authenticated','super=false,createrole=false,createdb=false,bypassrls=false,inherit=true,login=false,replication=false'),
      ('r:authenticator','super=false,createrole=false,createdb=false,bypassrls=false,inherit=false,login=true,replication=false')
  )
  select array_agg(x.what order by x.what) into v_tmp
  from (
    select 'changed:' || c.key || ':' || e.dig || '->' || c.dig as what
      from cur c join expd e on e.key = c.key
     where c.dig is distinct from e.dig
    union all
    select 'new:' || c.key || '->' || coalesce(c.dig, '<null>')
      from cur c
     where not exists (select 1 from expd e where e.key = c.key)
    union all
    select 'missing:' || e.key
      from expd e
     where not exists (select 1 from cur c where c.key = e.key)
  ) x;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'role_surface', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'role_surface', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  v_res := jsonb_build_object(
    'ok',      jsonb_array_length(v_fail) = 0,
    'checked', v_n,
    'failed',  v_fail,
    'at',      now());

  -- Слід пишемо ЗАВЖДИ, і при ok теж: порожній журнал має означати «сторож
  -- не крутиться», а не «все добре». p_write=false — для смоуку.
  if p_write then
    insert into public.maintenance_runs (job, result) values ('invariants', v_res);
  end if;

  return v_res;
end;
$function$;

comment on function public.invariants_check(boolean) is 'guard_body_md5=cf1a920d2052a6debaff8b46c450aeff;len=178426';

-- ── 4. ПОВНИЙ сторож ДО DDL на таблицях (≈9 с без замків на таблиці; урок 0196) ─
do $chk$
declare v_res jsonb; v_failed text[]; v_off16 text[]; v_off17 text[];
begin
  v_res := public.invariants_check(false);
  if (v_res->>'checked')::int <> 26 then
    raise exception '0204: сторож перевірив % замість 26', v_res->>'checked';
  end if;
  -- ідемпотентно: ledger_md5 допустима лише з offender-ом самої 0204 (повторний прогін до db:gate)
  select array_agg(e.value->>'check' order by e.value->>'check') into v_failed
    from jsonb_array_elements(v_res->'failed') e
   where e.value->>'check' not in ('gcal_sync_overdue', 'policy_digest', 'guard_triggers')
     and not (e.value->>'check' = 'ledger_md5'
              and e.value->'offenders' = jsonb_build_array('0204_referrer_grant_read.sql'));
  if v_failed is not null then
    raise exception '0204: до DDL сторож червоний не від пакета: % — %', v_failed, v_res->'failed';
  end if;
  select array_agg(o.value order by o.value collate "C") into v_off16
    from jsonb_array_elements(v_res->'failed') e,
         jsonb_array_elements_text(e.value->'offenders') o
   where e.value->>'check' = 'policy_digest';
  if v_off16 is not null and v_off16 is distinct from array['changed:patient_cases.cases_select_referrer', 'changed:queue_entries.queue_select', 'changed:waitlist_entries.waitlist_select']::text[] then
    raise exception '0204: №16 до DDL назвав не рівно три політики читання пакета: %', v_off16;
  end if;
  select array_agg(o.value order by o.value collate "C") into v_off17
    from jsonb_array_elements(v_res->'failed') e,
         jsonb_array_elements_text(e.value->'offenders') o
   where e.value->>'check' = 'guard_triggers';
  if v_off17 is not null and v_off17 is distinct from array['missing:referral_access.trg_zzz_ref_entry_markers_prune']::text[] then
    raise exception '0204: №17 до DDL назвав не рівно одну відсутню пару мітли: %', v_off17;
  end if;
end
$chk$;

-- ── 5. DDL на таблицях: три політики читання (Н-14) і тригер мітли ──────────
alter policy cases_select_referrer on public.patient_cases using (
  ((created_by = (select auth.uid())) or (referrer_id = (select auth.uid()))) and (clinic_id in (select auth_referrer_clinics()))
);
alter policy queue_select on public.queue_entries using (
  ((clinic_id = auth_clinic_id()) and (((select auth_role()) is distinct from 'radiologist'::user_role) or auth_radiologist_room_ok(room_id)))
  or (((created_by = (select auth.uid())) or (referrer_id = (select auth.uid()))) and (clinic_id in (select auth_referrer_clinics())))
);
alter policy waitlist_select on public.waitlist_entries using (
  ((clinic_id = (select auth_clinic_id())) and (((select auth_role()) is distinct from 'radiologist'::user_role) or auth_radiologist_room_ok(room_id)))
  or (((created_by = (select auth.uid())) or (referrer_id = (select auth.uid()))) and (clinic_id in (select auth_referrer_clinics())))
);

drop trigger if exists trg_zzz_ref_entry_markers_prune on public.referral_access;
create trigger trg_zzz_ref_entry_markers_prune
  after delete or update on public.referral_access
  for each row execute function public.tg_ref_entry_markers_prune_on_access();

-- ── 6. Пост-асерти: №16 і №17 запитами з живого тіла, функції, ACL, тригер ──
do $post$
declare v_tmp text[]; v_bad text[]; v_acl text; v_src text; v_a int; v_b int; v_q text;
begin
  perform set_config('search_path', 'public, pg_temp', true);
  select replace(p.prosrc, chr(13), '') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if md5(v_src) is distinct from 'cf1a920d2052a6debaff8b46c450aeff' or length(v_src) <> 178426
     or obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc')
        is distinct from 'guard_body_md5=' || md5(v_src) || ';len=' || length(v_src) then
    raise exception '0204: тіло сторожа або самопін не ті: % / %', md5(v_src), length(v_src);
  end if;
  -- ── №16 і №17 після DDL: запити САМОГО сторожа, вирізані з ЖИВОГО тіла і
  --    виконані як є. Копії тексту тут немає свідомо: стенди мутують файл
  --    останнього передруку і вимагають унікальності якорів ──
  v_a := strpos(v_src, '  with cur as (' || chr(10) || '    select p.tablename as tbl,');
  v_b := strpos(v_src, chr(10) || '  ) x;' || chr(10) || '  if v_tmp is not null then' || chr(10) || '    v_fail := v_fail || jsonb_build_array(jsonb_build_object(' || chr(10) || '      ''check'', ''policy_digest''');
  if v_a = 0 or v_b <= v_a then
    raise exception '0204: межі запиту №16 у живому тілі не знайдено (% / %)', v_a, v_b;
  end if;
  v_q := replace(substr(v_src, v_a, v_b - v_a) || chr(10) || '  ) x',
                 'select array_agg(x.what order by x.what) into v_tmp', 'select array_agg(x.what order by x.what)');
  if md5(v_q) is distinct from '8963f76c389b82d224f8e44f10aed6a3' then
    raise exception '0204: вирізаний запит №16 не той (md5 %) — межі зсунулись', md5(v_q);
  end if;
  execute v_q into v_tmp;
  if v_tmp is not null then
    raise exception '0204: №16 після DDL червоний: %', v_tmp;
  end if;
  v_a := strpos(v_src, '  select array_agg(x.txt order by x.txt) into v_tmp' || chr(10) || '    from (' || chr(10) || '      select case when a.def');
  v_b := strpos(v_src, chr(10) || '    ) x;' || chr(10) || '  if v_tmp is not null then' || chr(10) || '    v_fail := v_fail || jsonb_build_array(jsonb_build_object(' || chr(10) || '      ''check'', ''guard_triggers''');
  if v_a = 0 or v_b <= v_a then
    raise exception '0204: межі запиту №17 у живому тілі не знайдено (% / %)', v_a, v_b;
  end if;
  v_q := replace(substr(v_src, v_a, v_b - v_a) || chr(10) || '    ) x',
                 'select array_agg(x.txt order by x.txt) into v_tmp', 'select array_agg(x.txt order by x.txt)');
  if md5(v_q) is distinct from 'd7f869420308347c97dbaf35c45f75eb' then
    raise exception '0204: вирізаний запит №17 не той (md5 %) — межі зсунулись', md5(v_q);
  end if;
  execute v_q into v_tmp;
  if v_tmp is not null then
    raise exception '0204: №17 після DDL червоний: %', v_tmp;
  end if;
  -- ── Функції після заміни/створення: атрибути, сирий md5, ACL ──
  if not exists (
    select 1 from pg_proc p join pg_language l on l.oid = p.prolang
     where p.oid = to_regprocedure('public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean)')
       and p.prosecdef and p.provolatile = 's' and l.lanname = 'sql'
       and pg_get_userbyid(p.proowner) = 'postgres'
       and p.proconfig = array['search_path=public, pg_temp']
       and p.proretset and p.prorettype = 'uuid'::regtype and pg_get_function_result(p.oid) = 'TABLE(recipient_id uuid)'
       and md5(replace(p.prosrc, chr(13), '')) = 'c7a602edb861ecceb598e4d65534345d'
  ) then
    raise exception '0204: change_marker_recipients після заміни не та (атрибути або сирий md5 тіла c7a602edb861ecceb598e4d65534345d)';
  end if;
  -- ── ACL: пастка 0122 (дефолтний ACL схеми public роздає EXECUTE і anon,
  --    і PUBLIC) — асерт у ТІЙ САМІЙ транзакції ──
  if has_function_privilege('anon', 'public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean)', 'EXECUTE')
     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
                 where p.oid = to_regprocedure('public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean)') and a.grantee = 0) then
    raise exception '0204: public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean) виконують anon/authenticated/PUBLIC — ACL не звужено';
  end if;
  if not has_function_privilege('service_role', 'public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean)', 'EXECUTE') then
    raise exception '0204: service_role втратив EXECUTE на public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean)';
  end if;
  select array_to_string(array(select t from unnest(p.proacl::text[]) t order by t collate "C"), ',')
    into v_acl from pg_proc p
   where p.oid = to_regprocedure('public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean)');
  if v_acl is distinct from 'postgres=X/postgres,service_role=X/postgres' then
    raise exception '0204: ACL public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean) = % замість postgres=X/postgres,service_role=X/postgres', v_acl;
  end if;
  if not exists (
    select 1 from pg_proc p join pg_language l on l.oid = p.prolang
     where p.oid = to_regprocedure('public.tg_ref_entry_markers_prune_on_access()')
       and p.prosecdef and p.provolatile = 'v' and l.lanname = 'plpgsql'
       and pg_get_userbyid(p.proowner) = 'postgres'
       and p.proconfig = array['search_path=public, pg_temp']
       and p.prorettype = 'trigger'::regtype
       and md5(replace(p.prosrc, chr(13), '')) = 'a7d7f8876e46fc9a3b7a0efcf378bbfa'
  ) then
    raise exception '0204: tg_ref_entry_markers_prune_on_access() після створення не та (атрибути або сирий md5 тіла a7d7f8876e46fc9a3b7a0efcf378bbfa)';
  end if;
  -- ── ACL: пастка 0122 (дефолтний ACL схеми public роздає EXECUTE і anon,
  --    і PUBLIC) — асерт у ТІЙ САМІЙ транзакції ──
  if has_function_privilege('anon', 'public.tg_ref_entry_markers_prune_on_access()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.tg_ref_entry_markers_prune_on_access()', 'EXECUTE')
     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
                 where p.oid = to_regprocedure('public.tg_ref_entry_markers_prune_on_access()') and a.grantee = 0) then
    raise exception '0204: public.tg_ref_entry_markers_prune_on_access() виконують anon/authenticated/PUBLIC — ACL не звужено';
  end if;
  if not has_function_privilege('service_role', 'public.tg_ref_entry_markers_prune_on_access()', 'EXECUTE') then
    raise exception '0204: service_role втратив EXECUTE на public.tg_ref_entry_markers_prune_on_access()';
  end if;
  select array_to_string(array(select t from unnest(p.proacl::text[]) t order by t collate "C"), ',')
    into v_acl from pg_proc p
   where p.oid = to_regprocedure('public.tg_ref_entry_markers_prune_on_access()');
  if v_acl is distinct from 'postgres=X/postgres,service_role=X/postgres' then
    raise exception '0204: ACL public.tg_ref_entry_markers_prune_on_access() = % замість postgres=X/postgres,service_role=X/postgres', v_acl;
  end if;
  if not exists (select 1 from pg_trigger t
                  where t.tgrelid = 'public.referral_access'::regclass and t.tgname = 'trg_zzz_ref_entry_markers_prune'
                    and t.tgenabled = 'O') then
    raise exception '0204: тригер trg_zzz_ref_entry_markers_prune не стоїть або вимкнений';
  end if;
end
$post$;

insert into public.migration_ledger (name)
values ('0204_referrer_grant_read.sql')
on conflict (name) do nothing;

commit;

-- ============================================================================
-- === ВІДКАТ ===
--
--  1. База: `scripts/frag/0204_rollback.sql` — знімає тригер і функцію мітли,
--     `change_marker_recipients` — тіло 0184 (cef6f91b5dd1dcdc35e93fd732cf7162), три політики — форма 0203,
--     тіло сторожа 0203 (8c8e6403db7653949e03d026320c6099 / 170446), самопін 0203, рядок
--     леджера. Позначки, які мітла вже видалила, відкат не повертає.
--     Перевіряти ОКРЕМИМ запитом після commit.
--  2. Git — ОДНИМ кроком: видалити цей файл, `scripts/frag/0204_*.sql`,
--     `scripts/build-0204-reprint.mjs`, `tests/referrerGrantRead0204.test.ts`,
--     `supabase/smoke/0204_referrer_grant_read_smoke.sql`; повернути
--     `tests/guardTriggersInvariant.test.ts` (GUARDS 31 → 30, без гілки order:),
--     `supabase/smoke/rls_initplan_smoke.sql` (еталон `queue_select` форми 0203),
--     крок 3 `supabase/smoke/search_roles_smoke.sql` (правило «свій ключ І
--     активний грант»), фікстуру C1 `supabase/smoke/user_change_markers_smoke.sql`
--     (направник з активним грантом), блок №14 `unreachable:` у
--     `tests/unreadChanges.test.ts`, рядки 0204 у `docs/UNREAD_CHANGES.md` і абзаци
--     0204 в `AGENTS.md` («Роли и авторизация», «Контекстные красные точки»,
--     «Миграции и БД» — порядок гарда і ручний перевод сотрудника). Нового стенда
--     пакет НЕ заводить — фальсифікація разова, протокол у
--     `docs/audit/PR-0204-referrer-grant-read.md`.
-- ============================================================================
