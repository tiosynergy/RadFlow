# RadFlow — откат миграций 0031–0037 (MIN-15)

Миграции применяются вперёд (Supabase → SQL Editor). Ниже — ручные скрипты отката
для миграций, добавленных в ходе аудита 2026-06-25. Выполнять в **обратном** порядке
(0037 → 0031) и только при необходимости. Все скрипты идемпотентны.

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
