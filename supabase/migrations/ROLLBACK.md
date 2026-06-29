# RadFlow — откат миграций 0031–0037 (MIN-15)

Миграции применяются вперёд (Supabase → SQL Editor). Ниже — ручные скрипты отката
для миграций, добавленных в ходе аудита 2026-06-25. Выполнять в **обратном** порядке
(0037 → 0031) и только при необходимости. Все скрипты идемпотентны.

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
