# Фонові задачі RadFlow (pg_cron) — реєстр

Єдиний перелік того, що крутиться в БД за розкладом. Заведено в с37 після
того, як знайшовся конфлікт: джоб `prune-audit-log` (delete усього старше 180
днів) мовчки скорочував горизонт ретенції 0149 з 365 днів до 180. Знайти це
можна було тільки випадково — реєстру не існувало, а джоби народжуються з
**трьох різних місць**.

## Звідки беруться задачі

| Джерело | Що там | Коли виконується |
|---|---|---|
| `supabase/cron_jobs.sql` | базові задачі: sink-overdue, outbox-deliver, resolve-expired-incidents, ретенції | руками у SQL Editor, ідемпотентно (unschedule + schedule) |
| Міграції `00xx` | задачі, невіддільні від фічі (`perform cron.schedule(...)` під `if exists pg_extension`) | разом із накатом міграції |
| Руками у SQL Editor | разові правки прода | ніколи не «саме собою» — обовʼязково відобразити в файлі-джерелі |

⚠️ **Головне правило:** прибрати задачу — це НЕ видалити блок із файлу.
Видалення блоку прибирає задачу лише з репозиторію, на проді вона крутиться
далі. Знімати треба явним `cron.unschedule('імʼя')`, який ЛИШАЄТЬСЯ у файлі.

## Чинні задачі (звірено з продом 2026-08-24)

⚠️ Розклади pg_cron — **у UTC**, не в часі клініки. `40 3 * * *` = 03:40 UTC
(06:40 за Києвом улітку, 05:40 взимку). Нічні ретенції свідомо стоять у
UTC-ніч, і зі зміною літнього/зимового часу вони «їдуть» відносно Києва на
годину — для прибирання це байдуже, для будь-чого користувацького — ні.

| Задача | Розклад | Що робить | Джерело |
|---|---|---|---|
| `sink-overdue` | `*/5 * * * *` | ставить «⚠ Уточнити» простроченим записам (`sink_overdue_scheduled_all`) | `cron_jobs.sql` §1 |
| `outbox-deliver` | `* * * * *` | `POST /api/outbox/deliver`, Bearer із Vault | `cron_jobs.sql` §2 |
| `resolve-expired-incidents` | `*/5 * * * *` | знімає простої з `auto_unblock` після закінчення вікна | `cron_jobs.sql` §2b |
| `audit-retention` | `40 3 * * *` | `select public.audit_log_retention_daily()` — прямий виклик RPC, слід у `maintenance_runs` (90 днів знеособлення / 365 видалення) | міграція `0152` |
| `prune-outbox` | `30 3 * * *` | видаляє доставлені події старше 30 днів | `cron_jobs.sql` §4 |
| `prune-rate-limits` | `7 * * * *` | чистить `rate_limits` старші за добу | `cron_jobs.sql` §5 |
| `prune-important-events` | `20 3 * * *` | видаляє журнал подій старший за 180 днів | міграція `0128` |
| `prune-change-markers` | `25 3 * * *` | видаляє ПРОЧИТАНІ мітки старші за 180 днів | міграція `0132` |
| `invariants` | `50 3 * * *` | `select public.invariants_check()` — сторож інваріантів (11 перевірок з `0157`), слід у `maintenance_runs` | міграція `0154`–`0157` |

**Знято в с37:** `prune-audit-log` (`15 3 * * *`, delete старше 180 днів) —
замінено на `audit-retention`. Причина в §3 `cron_jobs.sql`.

## Горизонти зберігання — одна точка істини

Дві задачі, що чистять ОДНУ таблицю, — це прихована зміна політики: виграє та,
що з коротшим горизонтом, і ніде про це не сказано. Тому:

- `audit_log` — **тільки** `audit-retention` (політика 0149: PII знеособлюється
  на 90 днях, знеособлені метадані видаляються на 365). Горизонти з с39 живуть
  в обгортці `audit_log_retention_daily` (0152) — `audit_log_retention(90, 365,
  5000)`. Роут `/api/maintenance/retention` лишається ручним входом і кличе ТУ
  САМУ обгортку, тож дублювання параметрів більше немає.
- `important_events`, `user_change_markers` — 180 днів, задачі з міграцій.
  Журнали переживають видалення клініки, ретенція — ні: це різні механізми,
  не плутати.
- `event_outbox` — 30 днів ПІСЛЯ доставки; недоставлені й `dead` не чіпаються,
  вони потрібні для розбору.

Змінюєш горизонт — перевір, що іншої задачі на цю ж таблицю немає.

## Перевірки

Список задач і чи збігається він із цим реєстром:

```sql
select jobid, jobname, schedule, active from cron.job order by jobname;
```

Останні запуски (шукати `status <> 'succeeded'`):

```sql
select jobid, status, return_message, start_time
  from cron.job_run_details
 where start_time > now() - interval '2 days'
 order by start_time desc limit 50;
```

Що саме зробили нічні задачі (`audit-retention` з 0152 і `invariants` з 0154
лишають слід; `cron.job_run_details` покаже лише «SQL виконався»):

```sql
select job, ran_at, result from public.maintenance_runs
 order by ran_at desc limit 10;
```

⚠️ ПОРОЖНЬО за добу — найгірший стан: механізм не крутиться, а тиша схожа на
норму. Саме так помер запобіжник 0141.

Що ВІДПОВІВ роут (для задач через `net.http_post` — `cron.job_run_details`
покаже лише «запит поставлено в чергу», а не результат HTTP):

```sql
select id, status_code, left(content, 300) as body, created
  from net._http_response
 order by created desc limit 10;
```

`401` = секрет у Vault розійшовся з `CRON_SECRET` у Vercel; `500` з тілом
`CRON_SECRET не налаштовано` = змінна не задана в оточенні.

⚠️ Секрет у тілі задачі не тримаємо — лише `select ... from
vault.decrypted_secrets`. Інакше `select command from cron.job` світить його
кожному, хто має доступ до SQL Editor.
