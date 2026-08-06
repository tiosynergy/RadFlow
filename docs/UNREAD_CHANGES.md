# Контекстні позначки непрочитаних змін («червоні крапки»)

> Сесія 27 (2026-08-06). БД: міграції `0131` (таблиця + маршрутизація + ack) і
> `0132` (тригери фан-ауту). Клієнт: `lib/unreadChanges.ts` (чиста логіка),
> `lib/useUnreadChanges.tsx` (store + хуки), `components/UnreadDot.tsx`.
> ТЗ-джерело: `CLAUDE_CONTEXTUAL_UNREAD_CHANGES_PROMPT.md` (у власника).

## Що це і що це НЕ є

Користувач бачить червону крапку **саме там, де інша роль змінила
інформацію**: поле → картка → секція → пункт навігації. Глобального
дзвіночка, центру сповіщень, нижнього індикатора — **немає і не буде**
(пряма заборона ТЗ). Крапка гасне, лише коли користувач **реально побачив
актуальні дані** (блок розгорнуто + завантаження успішне + позначка була у
відрендереному знімку) — не від кліку по навігації.

## Архітектура за 60 секунд

```
UPDATE queue_entries (та сама транзакція!)
  └─ trg_zz_change_markers  → emit_change_markers()
       └─ change_marker_recipients()   — ЄДИНА матриця «кому»
            └─ INSERT … ON CONFLICT (recipient, entity, field_scope)
               WHERE seen_at IS NULL   — згортання в одну крапку
Клієнт: realtime(user_change_markers, recipient_id=eq.uid) → reload →
  indexMarkers() → крапки; ack → RPC mark_changes_seen(ids зі знімка)
```

- **Транзакційність** — вимога власника (с27): позначка народжується в тій
  самій транзакції, що й мутація. Тригери **fail-CLOSED**: помилка фан-ауту
  відкочує бізнес-операцію. Стоп-кран: `update change_marker_settings set
  enabled=false` — миттєво і без міграції.
- **Чому тригери, коли журнал 0128 — прикладна емісія**: журналу потрібен
  інваріант «одна дія — одна подія»; крапкам потрібна протилежність —
  адресність по кожній зачепленій сутності. Це ДВА РІЗНІ шари. Повне
  обґрунтування — шапка 0131.
- **Журнал і крапки незалежні**: `important_events` не чіпався, його
  fail-OPEN емісія з TS живе як жила. `source_event_id` у позначках
  зарезервовано для звʼязку, зараз NULL.

## Мапінг: подія → хто → де сідає крапка

| Джерело (тригер) | event_type | Отримувачі (мінус актор) | surface | entity | field_scope | Гасить |
|---|---|---|---|---|---|---|
| queue_entries INSERT | queue/referral.created | admin+registrar; радіологи кабінету; направник запису | queue | queue_entry | record | розгорнутий рядок дошки |
| queue UPDATE дата/час/кабінет/тривалість | queue/referral.rescheduled | ті самі + радіологи СТАРОГО кабінету | queue | queue_entry | schedule | розгорнутий рядок |
| queue UPDATE studies/has_contrast | queue/referral.studies_changed | ті самі | queue | queue_entry | studies | розгорнутий рядок (крапка біля блоку послуг) |
| queue UPDATE patient_* / contra / doctor / indication | queue/referral.patient_data_changed | ті самі | queue | queue_entry | patient_data | розгорнутий рядок |
| queue UPDATE priority_level | queue.priority_changed | ті самі (cito → critical) | queue | queue_entry | priority | розгорнутий рядок |
| queue UPDATE status → cancelled / needs_reschedule / no_show / not_held | queue/referral.cancelled, queue.status_changed | ті самі (critical для cancelled/needs_reschedule) | queue | queue_entry | status | розгорнутий рядок |
| waitlist INSERT/UPDATE | waitlist.added/scheduled/removed/updated, referral.waitlist_* | admin+registrar; направник рядка | waitlist | waitlist_entry | record | розгорнутий рядок листа |
| patient_cases INSERT | case.created / referral.case_created | admin+registrar; направник | cases | patient_case | record | (іт.2 — екран кейса) |
| patient_cases → cancelled (recompute) | case.cancelled / referral.case_cancelled | admin+registrar; направник | cases | patient_case | case_step | (іт.2) |
| services / sro будь-яка змістовна зміна | service.* | admin+registrar; радіологи кабінету | services | **room** (агрегат!) | catalog / room_override | відкриття /services |
| referral_access INSERT/UPDATE/DELETE | referral.access_* | admin; **направник гранта** (навіть відкликаний) | centers | referral_access | access | розгорнута картка центру |
| incidents INSERT / → active | incident.started | admin+registrar; радіологи кабінету; CEO (critical) | incidents | incident | incident | дошка черги (простої видно одразу) |

**Свідомо БЕЗ крапки:** рутинні переходи scheduled→waiting→in_progress→**done**
(рішення власника: done без крапки; видно на дошках realtime); перехід кейса в
`completed`/`open` (похідне дзеркало done-кроків — перевірено пробою №3 на
проді: cancelled дає позначку, completed — ні); автозняття інциденту cron-ом;
`clarify_at` (cron sink-overdue); нотатки; `schedule_overrides` (чекає CAS з
M-2 аудиту); каскадні DELETE послуг при видаленні кабінету.

## Ключові інженерні рішення (не переоткривати без причини)

1. **Згортання**: unique index `(recipient, entity_type, entity_id,
   field_scope) WHERE seen_at IS NULL` + `ON CONFLICT DO UPDATE`. Пʼять правок
   блоку = одна крапка; прочитана позначка НЕ перевикористовується (нова
   зміна = нова крапка). При згортанні оновлюються `room_id`/`surface_key`/
   `subject_referrer_id` (ревʼю р1 M-5), тому **порядок емісій у тригері
   значущий**: канонічна (з новим кабінетом) — остання (р2 M-4new).
2. **Каталог = агрегат по кабінету** (`entity_type='room'`, entity_id =
   room_id | clinic_id): 500 послуг × 6 отримувачів інакше дали б 3000
   рядків в одній транзакції під fail-CLOSED тригером (р1 H-2). Проба:
   239 послуг → 8 позначок.
3. **Кейси: фільтр по ЗМІСТУ переходу, не по глибині тригера** (р1 H-1 +
   р2 H-1new): `patient_cases.status` пише лише `case_recompute_status` із
   тригера queue_entries (глибина 2), тож depth-гард робив скасування кейса
   невидимим. Правило: тільки `→cancelled` і зміна `sequential` дають крапку.
4. **ack — SECURITY DEFINER RPC `mark_changes_seen`**, а не UPDATE-грант:
   інакше браузер міг би писати довільний `seen_at` і скидати його в NULL.
   Ідемпотентна (`seen_at is null` у WHERE), повертає РЕАЛЬНО оновлені id.
5. **CEO** отримує лише `incident`/`access` (р1 M-9): у нього немає екранів
   під операційні сутності — усе інше було б вічним непрочитаним.
6. **Клієнт — модульний store** (`useSyncExternalStore`), НЕ React-контекст
   (р1 H-4): Sidebar рендерять 9+ екранів, і контекст із провайдером в
   одному з них лишав решту без крапок. Маунт підписки — `<UnreadChangesMount />`
   у Sidebar / ReferrerSidebar / RadSidebar. Індекс перераховується в store
   один раз на оновлення (р2 M-8new), відбиток id+created_at гасить порожні
   ререндери кожного тику звірки.
7. **Помилка завантаження ≠ нуль непрочитаного**: статус
   `error-with-previous-data`, попередні крапки лишаються (той самий клас
   правил, що fail-CLOSED прапорці с24).
8. **Ack лише зі знімка**: `ackIdsForScope(index, scope, snapshotIds)` —
   позначка, що приїхала ПІСЛЯ рендеру, лишається непрочитаною (сценарій 1
   ТЗ). Перевзвід ефекту — по відбитку пулу і по лічильнику невдач ack
   (р1 M-10, р2 L-10new).

## Точки ack у UI (ітерація 1)

- `QueueBoard` → розгорнутий рядок: entity-ack; `incidents` — surface-ack
  після успішного показу простоїв (вони видимі прямо на дошці).
- `RadiologistBoard` → розгорнутий рядок: entity-ack (+ маунт у RadSidebar).
- `ReferrerBoard` («Мої направлення») → розгорнутий рядок: entity-ack.
- `WaitlistBoard` → розгорнутий рядок: entity-ack.
- `MyCenters` (портал направника) → розгорнута картка центру ПІСЛЯ
  завантаження її даних: entity-ack referral_access.
- `ServicesManager` → відкриття сторінки (каталог SSR, рендериться цілим,
  пагінації немає — surface-ack чесний).

## Відомі обмеження ітерації 1 (з ревʼю; НЕ баги, а борг)

- **Кейси**: крапка на пункті навігації відсутня (у сайдбарі немає пункту
  «Кейси»), ack кейс-позначок немає — вони гаснуть лише разом із записами
  (entity queue_entry). Позначки patient_case поки що накопичуються:
  ретенція непрочитаних НЕ чистить (вимога ТЗ). Ітерація 2: ack в CaseModal.
- **`truncated`** (limit 500 вибірки) — прапорець у store є, UI-індикатора
  «список обрізано» немає.
- PII-захист позначок — 2 лінії (контрольовані details у тригерах + CHECK
  БД верхнього рівня) проти 4 у журналу. Рекурсивного гарда в БД і білої
  проекції на читанні немає — додати, якщо в details зʼявляться довільні
  ключі (зараз усі jsonb_build_object перевірені ревʼю р1 поіменно).
- `changed_fields` каталожних позначок несе НАЗВИ послуг (не PII) — до 40,
  далі обрізається merge_changed_fields.
- Тумбстоуни видалених сутностей: часткові (service.deleted /
  waitlist.removed / access_revoked дають позначку зі знімком у details),
  повного UI-тумбстоуна в списках немає.
- Живої перевірки двома акаунтами в двох браузерах ще не було (див.
  NEXT_SESSION_PROMPT).

## Що лишилось fail-open (чесний перелік, вимога ТЗ п.9)

Сам ЖУРНАЛ (`important_events`) — як і був: емісія з TS після успіху.
Але для КРАПОК fail-open шляхів немає: усі позначки народжуються тригерами
в транзакції мутації. Єдиний спосіб «зміна без крапки» — вимкнений
рубильник `change_marker_settings.enabled=false` (і це видно одним SELECT).

## Операційне

- Рубильник: `update public.change_marker_settings set enabled = false;`
- Відкат: `supabase/migrations/ROLLBACK.md`, розділи 0132 → 0131.
- Ретенція: cron `prune-change-markers` 03:25, видаляє ЛИШЕ прочитані
  старші 180 днів. Вік/кількість непрочитаних — метрика зламаного ack:
  `select recipient_id, count(*), min(created_at) from user_change_markers
   where seen_at is null group by 1 order by 2 desc;`
- Смоук: `supabase/smoke/user_change_markers_smoke.sql` (A–N, самовідкатний;
  ПІСЛЯ накату прогнати ще раз проти застосованої схеми).
