# RadFlow — откат миграций 0031–0034 (MIN-15)

Миграции применяются вперёд (Supabase → SQL Editor). Ниже — ручные скрипты отката
для миграций, добавленных в ходе аудита 2026-06-25. Выполнять в **обратном** порядке
(0034 → 0031) и только при необходимости. Все скрипты идемпотентны.

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
