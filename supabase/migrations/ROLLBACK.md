# RadFlow — откат миграций 0031–0037 (MIN-15)

Миграции применяются вперёд (Supabase → SQL Editor). Ниже — ручные скрипты отката
для миграций, добавленных в ходе аудита 2026-06-25. Выполнять в **обратном** порядке
(0037 → 0031) и только при необходимости. Все скрипты идемпотентны.

## Откат 0135 (CAS-RPC графіка дня + queue_active_requires_room_chk)

> ### ⚠️ ШАГ 0 — ПОРЯДОК ЗАВИСИТ ОТ ТОГО, ВЫКАЧЕН ЛИ КЛИЕНТСКИЙ ШАГ 2
>
> Пока клиент ходит старым слепым upsert-ом (шаг 2 НЕ выкачен), обе части
> можно откатывать в любой момент — RPC никто не зовёт, констрейнт клиента
> не касается. Если шаг 2 УЖЕ выкачен: сперва деплой предыдущего дерева
> (иначе сохранение графика получит PGRST202 «function not found» и
> редактор дня умрёт), и только затем SQL ниже.
>
> Две части независимы, откатывать можно по отдельности.
>
> **Часть А (RPC).** Прямые гранты на таблицу миграцией не отзывались,
> так что старый путь записи работоспособен всегда. Последствие отката:
> возвращается lost update H-5 (два админа затирают правки друг друга).
>
> **Часть Б (констрейнт).** Последствие отката: активная запись снова может
> остаться без кабинета. Перед ПОВТОРНЫМ накатом проверить
> `select count(*) from queue_entries where status in
> ('scheduled','waiting','in_progress') and room_id is null;` — должно быть 0.

```sql
-- Часть А
drop function if exists public.save_schedule_override(date, boolean, text, jsonb, text);
-- Часть Б
alter table public.queue_entries drop constraint if exists queue_active_requires_room_chk;
```

## Откат 0134 (актор событий доступов + аудитория CEO)

> ### ⚠️ ШАГ 0 — СНАЧАЛА ОТКАТИТЬ КОД, ПОТОМ БАЗУ
>
> Задеплоенный код шлёт `actor_hint` в девяти местах записи в
> `referral_access` (`app/api/referral/access/decide`, `.../request`,
> `app/api/referrers/invite`). Если снять колонку под работающим кодом,
> PostgREST ответит `PGRST204` («Could not find the 'actor_hint' column …»)
> и **каждое** приглашение направника, запрос доступа, approve / decline /
> revoke начнёт отдавать 400. То есть: сперва деплой предыдущего дерева
> (`main` до пакета №4), и только затем SQL ниже.
> Обратный порядок при НАКАТЕ такой же: сперва миграция, потом деплой кода.
> Промежуточное состояние «колонка есть, код старый» безопасно — колонка
> nullable, старый код её не упоминает.
>
> Две части независимы, откатывать можно по отдельности.
>
> **Часть А (актор).** Порядок внутри SQL: сначала вернуть
> `tg_change_markers_access` к чтению только `auth.uid()`, потом снять
> BEFORE-триггер вместе с его функцией (именно она читает `new.actor_hint`),
> и только затем колонку. Сам `tg_change_markers_access` на колонку НЕ
> ссылается — он читает транзакционную настройку, — но пока висит
> `trg_aa_actor_hint`, снятие колонки уронит любую запись в таблицу:
> триггеры пометок fail-CLOSED.
> Данные при снятии колонки не теряются: в покое она всегда NULL.
> Последствие отката: админ снова получает красную точку о собственном клике,
> а `actor_role` событий доступов снова `system`.
>
> **Часть Б (аудитория CEO).** Возврат CEO в матрицу СНОВА создаёт негасимые
> пометки. Точный критерий возврата — **«у CEO появился экран с
> `useAckWhenVisible`»**, а НЕ «появился `UnreadChangesMount`»: подписка у него
> есть и сейчас (его экраны рендерят `<Sidebar />`, а тот монтирует
> `<UnreadChangesMount />` безусловно), и точку на «Дошці черги» он даже видит.
> Гасить нечем: поверхность `incidents` рендерит только `QueueBoard` на
> `/queue`, куда CEO не пускает редирект.
> Уже погашенные пунктом 5 пометки при откате НЕ воскресают — и не должны:
> показать их всё равно негде.
>
> Ниже — **три отдельных шага**, каждый со своей транзакцией. Вставлять блоки
> из 0131/0132 внутрь одного `begin;` нельзя: у них есть собственные
> `begin;/commit;`, и получится «there is already a transaction in progress».

**Шаг А1 (выполняется как есть, без обёртки).** Выполнить блок
«6) referral_access» файла `0132_change_marker_triggers.sql` целиком — от
`create or replace function public.tg_change_markers_access()` до
`create trigger trg_zz_change_markers … on public.referral_access`.
Он идемпотентен и вернёт `v_actor uuid := auth.uid();`.

**Шаг А2–А3 (одной транзакцией, строго ПОСЛЕ А1).**

```sql
begin;
-- Триггер, затем его функция: пока триггер висит, снятие колонки уронит
-- любую запись в referral_access (триггеры пометок fail-CLOSED).
drop trigger if exists trg_aa_actor_hint on public.referral_access;
drop function if exists public.tg_referral_access_actor();
alter table public.referral_access drop column if exists actor_hint;
commit;
```

**Шаг Б (без обёртки).** Выполнить блок «5) ЄДИНА матриця аудиторії» файла
`0131_user_change_markers.sql` целиком — он вернёт ветку `ceo` с
`p_scope_kind in ('incident','access')`.
⚠️ Вместе с ней вернётся и `referrer`-ветка БЕЗ проверки существования
профиля, добавленной в 0134: каскадное удаление профиля снова начнёт плодить
пометки, адресованные несуществующему получателю, — их не увидит и не погасит
никто.

## Откат 0133 (subject_date в позначках)

> ⚠️ ПОРЯДОК ВАЖЕН. Сначала вернуть функцию БЕЗ `subject_date`, и только потом
> снимать колонку. Наоборот нельзя: триггеры fail-CLOSED, и `emit_change_markers`,
> ссылающаяся на исчезнувшую колонку, уронит ЛЮБУЮ запись в queue_entries /
> services / waitlist / incidents — клиника перестанет работать.
> Если нужен откат только календаря — колонку не трогайте вовсе, достаточно
> убрать точки из `MiniCalendar.tsx` (и локальной копии в `RadiologistBoard.tsx`).

```sql
begin;
-- 1. вернуть 15-аргументную версию (тело 0131, без subject_date)
drop function if exists public.emit_change_markers(
  uuid, uuid, text, text, text, uuid, text, text, text, uuid, uuid, text[], jsonb, boolean, uuid, date);
-- затем выполнить блок «4) Єдина точка запису» из 0131_user_change_markers.sql
-- и следом блок «1) queue_entries» из 0132_change_marker_triggers.sql
-- (тело tg_change_markers_queue без p_subject_date).

-- 2. и только теперь колонка:
alter table public.user_change_markers drop column if exists subject_date;
commit;
```

## Откат 0132 (триггеры фан-аута позначок)

> Это «стоп-кран» фичи красных точек. Быстрое выключение БЕЗ отката —
> `update public.change_marker_settings set enabled = false;` (мгновенно,
> триггеры остаются, но превращаются в no-op). Полный откат — ниже.

```sql
begin;
drop trigger if exists trg_zz_change_markers on public.queue_entries;
drop trigger if exists trg_zz_change_markers on public.waitlist_entries;
drop trigger if exists trg_zz_change_markers on public.patient_cases;
drop trigger if exists trg_zz_change_markers on public.services;
drop trigger if exists trg_zz_change_markers on public.service_room_overrides;
drop trigger if exists trg_zz_change_markers on public.referral_access;
drop trigger if exists trg_zz_change_markers on public.incidents;
drop function if exists public.tg_change_markers_queue();
drop function if exists public.tg_change_markers_waitlist();
drop function if exists public.tg_change_markers_cases();
drop function if exists public.tg_change_markers_services();
drop function if exists public.tg_change_markers_sro();
drop function if exists public.tg_change_markers_access();
drop function if exists public.tg_change_markers_incidents();
do $$ begin
  if exists (select 1 from pg_publication_tables
              where pubname='supabase_realtime' and tablename='user_change_markers') then
    alter publication supabase_realtime drop table public.user_change_markers;
  end if;
end $$;
do $$ begin
  if exists (select 1 from cron.job where jobname='prune-change-markers') then
    perform cron.unschedule('prune-change-markers');
  end if;
end $$;
commit;
```

## Откат 0131 (таблица позначок + RPC)

> Откатывать ПОСЛЕ 0132. Уничтожает все накопленные непрочитанные позначки —
> они нигде больше не хранятся.

```sql
begin;
drop function if exists public.mark_changes_seen(uuid[]);
drop function if exists public.emit_change_markers(
  uuid, uuid, text, text, text, uuid, text, text, text, uuid, uuid, text[], jsonb, boolean, uuid);
drop function if exists public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean);
drop function if exists public.merge_changed_fields(text[], text[]);
drop function if exists public.greatest_severity(text, text);
drop function if exists public.change_markers_enabled();
drop table if exists public.user_change_markers;
drop table if exists public.change_marker_settings;
commit;
```

## Откат 0126 (запрет удаления кабинета с историей)

> Единственная миграция, которая **дропает** объект предыдущей: `guard_delete_active_room()`
> из 0123. Поэтому откат в два шага — иначе между `drop trigger` и восстановлением
> кабинеты останутся вообще без гарда, и `ON DELETE SET NULL` снова начнёт молча
> обезличивать историю.

```sql
begin;
-- 1. вернуть функцию 0123 (правило «удалять можно только выключенный»)
create or replace function public.guard_delete_active_room()
returns trigger language plpgsql security definer set search_path to 'public', 'pg_temp'
as $fn$
begin
  if old.active and pg_trigger_depth() = 1 then
    raise exception 'ROOM_ACTIVE_DELETE: спершу вимкніть кабінет «%», потім видаляйте', old.name
      using errcode = 'check_violation';
  end if;
  return old;
end;
$fn$;
revoke all on function public.guard_delete_active_room() from public;
revoke execute on function public.guard_delete_active_room() from anon;

-- 2. и только теперь снять новый гард
drop trigger if exists trg_guard_delete_room on public.rooms;
drop trigger if exists trg_guard_delete_active_room on public.rooms;
create trigger trg_guard_delete_active_room
  before delete on public.rooms
  for each row execute function public.guard_delete_active_room();
drop function if exists public.guard_delete_room();

comment on column public.rooms.active is
  'false = кабінет вимкнено: нові записи/переноси сюди заборонені (тригер '
  'check_room_active), наявні записи лишаються робочими. Видалити рядок можна '
  'лише при active=false (тригер guard_delete_active_room). 0123.';
commit;
```

> ⚠️ Клиент после отката тоже надо откатить: он показывает диалог «кабинет с историей
> удалить нельзя» и блокирует сохранение по тому же критерию.

## Откат 0037 (drop queue_entry_services, MAJ-12)

```sql
-- Воссоздать пустую нормализованную таблицу из 0001 (данные не восстанавливаются —
-- их и не было; таблица не использовалась приложением).
create table if not exists public.queue_entry_services (
  id            uuid primary key default gen_random_uuid(),
  entry_id      uuid not null references public.queue_entries(id) on delete cascade,
  service_id    uuid references public.services(id) on delete set null,
  clinic_id     uuid not null references public.clinics(id) on delete cascade,
  with_contrast boolean not null default false,
  created_at    timestamptz not null default now()
);
create index if not exists qes_entry_idx on public.queue_entry_services(entry_id);
alter table public.queue_entry_services enable row level security;
drop policy if exists qes_all on public.queue_entry_services;
create policy qes_all on public.queue_entry_services
  for all using (clinic_id = public.auth_clinic_id())
  with check (clinic_id = public.auth_clinic_id());
```

> ⚠️ Откат `0032` (invite_token / email_for_login) и `0033` (rate-limiting) вернёт
> уязвимости безопасности — откатывать только если соответствующий код приложения
> тоже откатывается.

## Откат 0034 (status check + scheduled_at)

```sql
drop trigger if exists trg_a_set_scheduled_at on public.queue_entries;
drop function if exists public.set_scheduled_at();
alter table public.incidents drop constraint if exists incidents_status_chk;
```

## Откат 0033 (rate-limiting)

```sql
drop function if exists public.rl_check(text, int, int);
drop table if exists public.rate_limits;
```

## Откат 0032 (invite-токены + email_for_login)

```sql
-- вернуть доступ к email_for_login (НЕ рекомендуется — открывает энумерацию):
grant execute on function public.email_for_login(text) to anon, authenticated;
-- убрать invite_token:
drop index if exists public.profiles_invite_token_uidx;
alter table public.profiles drop column if exists invite_token;
```

## Откат 0031 (realtime doctors + индекс)

```sql
drop index if exists public.queue_room_date_idx;
-- replica identity вернуть к default (откат не обязателен, безвреден):
alter table public.doctors replica identity default;
```
