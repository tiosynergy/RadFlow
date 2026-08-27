-- ---------------------------------------------------------------------------
--  RadFlow — Міграція 0163
--  Клінічний запис НЕ ВИДАЛЯЮТЬ — його скасовують. Прибираємо табличний
--  DELETE у клієнтських ролей на `queue_entries` і `waitlist_entries`.
--
--  Номер: select max(name) from migration_ledger → 0162. Guard на 0162.
-- ---------------------------------------------------------------------------
--
--  === Що знайдено (аудит с45, жива проба з відкатом) ===
--
--  Тригер `guard_status_change_referrer` (0079) декларує правило ДОСЛІВНО:
--    «FORBIDDEN: направник може лише перенести або скасувати запис»
--  і стереже його на UPDATE. Але політика `queue_write_referrer` оголошена
--  на ALL, а роль `authenticated` мала табличний грант DELETE — тож
--  направник міг просто ВИДАЛИТИ рядок напряму через PostgREST, обійшовши
--  декларацію цілком.
--
--  Проба під JWT реального направника (в транзакції, відкочено):
--    PROBE_RESULT can_book=t DELETE_ROWS=1
--
--  Чому це гірше за скасування, а не «те саме іншими словами»:
--    • у клініки запис ЗНИКАЄ з дошки без сліду скасування;
--    • `tg_change_markers_queue` навішений AFTER INSERT/UPDATE — на DELETE
--      позначки «непрочитане» НЕ виникає взагалі;
--    • `important_events` емітить прикладний код (`emitImportantEvent`) —
--      прямий DELETE повз застосунок не пише в «Журнал дій» нічого;
--    • слот звільняється мовчки, і хто саме прибрав пацієнта, видно лише
--      в `audit_log` (fn_audit AFTER I/D/U — єдине, що це переживає).
--
--  Застосунок НІДЕ не видаляє ці рядки (пошук `.delete()` по репозиторію:
--  жодного входження для queue_entries/waitlist_entries поза скриптами
--  `seed-test-data.mjs` і `race-check.mjs`, які ходять СЛУЖБОВОЮ роллю).
--  Тобто грант не обслуговував жодного сценарію продукту.
-- ---------------------------------------------------------------------------
--
--  === Що робимо ===
--
--  ДВА рубежі, і саме в такому порядку:
--
--  1. REVOKE DELETE у `anon` і `authenticated` — основний контроль. Після
--     нього PostgREST відмовляє ще до RLS (42501 «permission denied»).
--     SECURITY DEFINER-функції та каскади від `clinics` не зачеплені: вони
--     виконуються від власника (`postgres`), у якого право лишається.
--
--  2. BEFORE DELETE тригер — розтяжка на випадок, якщо грант колись
--     повернуть (дефолтний `grant all` у Supabase роздає його автоматично
--     при перестворенні таблиці). Тригер SECURITY INVOKER СВІДОМО: лише в
--     invoker-режимі `current_user` дорівнює РОЛІ ВИКЛИКАЧА. У DEFINER він
--     дорівнював би ВЛАСНИКУ функції (`postgres`), умова стала б завжди
--     ХИБНОЮ — і розтяжка мовчки перетворилась би на пустушку (fail-open).
--     Перевірено живим зондом: invoker під `set local role authenticated`
--     дає `current_user = authenticated`.
--
--  ⚠️ Штатно після 0163 розтяжка НЕ спрацьовує взагалі: перевірка привілею
--  відсікає ще до RLS і до тригерів, і клієнт бачить `permission denied for
--  table queue_entries`, а не наш текст. Український текст адресований тому,
--  хто читатиме лог ПІСЛЯ повернення гранта, а не оператору.
--
--  ⚠️ ЄДИНИЙ обхід розтяжки — RI-каскад від `clinics`: він виконується від
--  власника таблиці, тож `current_user` там `postgres`. Сьогодні це безпечно
--  рівно тому, що в `clinics` НЕМАЄ жодної політики на DELETE. Зʼявиться
--  `clinics_admin_delete` — черга цілої клініки поїде повз обидва рубежі.
--
--  ⚠️ Дискримінатор — список ЗАБОРОНЕНИХ ролей (`anon`, `authenticated`), а
--  не список дозволених. Дозвільний список зламав би будь-який внутрішній
--  шлях під роллю, якої ми сьогодні не знаємо (каскад від `clinics` під
--  `clinic_deletion_execute`, платформні задачі Supabase). Роль клієнта
--  рівно дві, вони фіксовані, і саме їх треба не пустити. Обмежувальну
--  роль виконує REVOKE вище — він працює як дозвільний список.
--
--  ⚠️ Чому не політика RLS: політика `queue_write_referrer` покриває ALL, і
--  розбити її на INSERT/UPDATE окремо означало б переписати робочий шлях
--  бронювання направником. Привілей — точніший інструмент: він знімає рівно
--  одну команду, не торкаючись решти.
-- ---------------------------------------------------------------------------

begin;

do $$
begin
  if not exists (select 1 from public.migration_ledger
                 where name = '0162_doctors_desk_update.sql') then
    raise exception '0163 потребує 0162 (накатуйте по порядку)';
  end if;
end $$;

-- ============================================================================
-- 1. Розтяжка: тригерна функція (SECURITY INVOKER — див. шапку)
-- ============================================================================

create or replace function public.guard_no_client_delete()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if current_user in ('anon', 'authenticated') then
    raise exception 'FORBIDDEN: запис не видаляють — його скасовують'
      using errcode = '42501';
  end if;
  return old;
end;
$fn$;

comment on function public.guard_no_client_delete() is
  'Розтяжка 0163: клієнтські ролі не видаляють клінічні рядки. Основний '
  'контроль — REVOKE DELETE; тригер ловить повернення гранта.';

-- ============================================================================
-- 2. Тригери. Імʼя `a01_` — одразу після `a00_` радіологічних гардів, щоб
--    для радіолога першим спрацьовував саме його гард (він не підтверджує
--    існування рядка, якого роль не має бачити).
-- ============================================================================

drop trigger if exists a01_no_client_delete on public.queue_entries;
create trigger a01_no_client_delete
  before delete on public.queue_entries
  for each row execute function public.guard_no_client_delete();

drop trigger if exists a01_no_client_delete on public.waitlist_entries;
create trigger a01_no_client_delete
  before delete on public.waitlist_entries
  for each row execute function public.guard_no_client_delete();

-- ============================================================================
-- 3. Основний контроль: знімаємо табличний DELETE у клієнтських ролей
-- ============================================================================

revoke delete on public.queue_entries    from anon, authenticated;
revoke delete on public.waitlist_entries from anon, authenticated;

/* TRUNCATE — та сама історія і той самий дефолтний `grant all`, але наслідок
   гірший: RLS на нього не діє взагалі, BEFORE DELETE тригер не спрацьовує
   (TRUNCATE піднімає ОКРЕМИЙ клас тригерів), і зносить він одразу всі
   клініки. Через PostgREST сьогодні недосяжний — команди такої немає, — тож
   це ешелонування, а не закриття живої дірки. Ціна: один рядок. */
revoke truncate on public.queue_entries    from anon, authenticated;
revoke truncate on public.waitlist_entries from anon, authenticated;

-- ============================================================================
-- 4. Самореєстрація (канон 0142) — ОСТАННІЙ statement перед commit
-- ============================================================================
insert into public.migration_ledger (name)
values ('0163_no_client_hard_delete.sql')
on conflict (name) do nothing;

commit;

-- ---------------------------------------------------------------------------
-- === ВІДКАТ ===
--
-- Повертає стан рівно до 0163. Грант DELETE віддається назад ОБОМ ролям —
-- саме так було до міграції (дефолт Supabase `grant all`), тож відкат має
-- відтворювати дефект, а не «трохи кращий» стан: інакше наступна перевірка
-- відкату побреше.
--
-- begin;
--
-- drop trigger if exists a01_no_client_delete on public.queue_entries;
-- drop trigger if exists a01_no_client_delete on public.waitlist_entries;
-- drop function if exists public.guard_no_client_delete();
--
-- grant delete   on public.queue_entries    to anon, authenticated;
-- grant delete   on public.waitlist_entries to anon, authenticated;
-- grant truncate on public.queue_entries    to anon, authenticated;
-- grant truncate on public.waitlist_entries to anon, authenticated;
--
-- delete from public.migration_ledger where name = '0163_no_client_hard_delete.sql';
--
-- commit;
-- ---------------------------------------------------------------------------
