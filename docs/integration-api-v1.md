# RadFlow Integration API v1 (фаза 1: read-only + вебхуки)

Контракт для інтеграторів RIS/PACS. Джерело рішень —
`docs/pacs-fhir-integration-plan.md` (§3 межі полів, §6 дизайн API).
**Режим A (за замовчуванням): жодних персональних даних пацієнта** — назовні
йдуть лише операційні поля (час, кабінет, послуга, статуси). Матчинг
пацієнта — на боці RIS за `entry_id` (opaque) / accession.

## Автентифікація

`Authorization: Bearer rfk_<48hex>` — ключ видає власник RadFlow
(`node scripts/integration-admin.mjs key:create …`), показується один раз,
у БД лише sha256. Ключ прив'язаний до однієї клініки і скоупів:
`slots:read`, `appointments:read`, `events:write` (фаза 2). Ліміт: 240
запитів/хв на ключ (`429` при перевищенні). Відкликання — миттєве.

## GET /api/integrations/v1/appointments

Скоуп `appointments:read`. Параметри (усі опційні):

| параметр | формат | опис |
|---|---|---|
| `updated_since` + `after_id` | ISO-8601 + uuid | keyset-курсор інкрементального синку: `(updated_at, id) > (…)`. Перший запит — лише `updated_since`; далі передавайте `paging.next` ЯК Є. Offset-піджингу немає навмисно (рухливий `updated_at` губив би рядки) |
| `date_from`, `date_to` | YYYY-MM-DD | за датою запису (`scheduled_date`) |
| `status` | CSV | значення `queue_status` (scheduled, waiting, in_progress, done, no_show, cancelled, not_held, needs_reschedule) |
| `room_id` | uuid | один кабінет |
| `limit` | 1..500 (дефолт 100) | порядок `updated_at ASC, id ASC` |

Відповідь:

```json
{
  "appointments": [{
    "entry_id": "uuid", "clinic_id": "uuid", "room_id": "uuid|null",
    "status": "scheduled", "call_status": "confirmed",
    "scheduled_at": "2026-08-12T07:30:00+00:00",
    "scheduled_date": "2026-08-12", "scheduled_time": "10:30",
    "duration_min": 30, "buffer_time_min": 5,
    "priority_level": "planned", "cito": false, "has_contrast": true,
    "off_schedule": false, "case_id": null, "case_step": null,
    "created_at": "…", "updated_at": "…",
    "studies": [{ "type": "МРТ", "region": "Колінний суглоб", "contrast": true }]
  }],
  "paging": { "limit": 100, "returned": 42, "has_more": false, "next": null }
}
```

Рекомендований синк: цикл, поки `has_more` — наступний запит з
`paging.next` (`updated_since` + `after_id`). Обробка ідемпотентна: подія/
рядок застосовується, лише якщо його `(updated_at, seq)` новіший за
збережений для `entry_id` (`seq` є лише у вебхуках; для REST достатньо
`updated_at` — сторінка завжди віддає повний поточний стан).

## GET /api/integrations/v1/slots

Скоуп `slots:read`. Параметри: `room_id` (обов'язковий uuid), `date_from`,
`date_to` (YYYY-MM-DD; діапазон ≤ 31 день; дефолт — сьогодні у TZ клініки
+13 днів).

Відповідь по днях: робоче вікно кабінету, перерви, зайнятість і **вільні
інтервали** (вікно − перерви − зайнятість). Часи — «стінні» `HH:MM` у
`timezone` клініки (IANA), конверсію в абсолютний час робить консюмер.
Причини недоступності не розкриваються.

```json
{
  "room_id": "uuid", "modality": "MRI", "timezone": "Europe/Kyiv",
  "date_from": "2026-08-12", "date_to": "2026-08-12",
  "days": [{
    "date": "2026-08-12", "open": true,
    "window": { "start": "08:00", "end": "18:00" },
    "breaks": [{ "start": "13:00", "end": "14:00" }],
    "busy":   [{ "start": "10:30", "end": "11:05" }],
    "free":   [{ "start": "08:00", "end": "10:30" },
               { "start": "11:05", "end": "13:00" },
               { "start": "14:00", "end": "18:00" }]
  }]
}
```

`open:false` — кабінет цього дня не працює (`window/breaks/busy/free` порожні).

## Вебхуки (RadFlow → RIS)

Налаштовує власник (`webhook:set --clinic … --url https://…`); один ендпоінт
на клініку, тільки `https`. Кожна зміна запису породжує POST:

| подія | коли |
|---|---|
| `integration.appointment.created` | запис створено |
| `integration.appointment.rescheduled` | змінено час або кабінет |
| `integration.appointment.cancelled` | статус → cancelled / not_held |
| `integration.appointment.noshow` | статус → no_show |
| `integration.appointment.updated` | інші зміни експортованих полів |
| `integration.appointment.deleted` | запис видалено (payload: `entry_id`, `clinic_id`, `deleted:true`, `occurred_at`) |

Видалення КЛІНІКИ подій не породжує — канал вмирає разом з нею.
Події «тонкі» щодо послуг: `studies` несе type/region/contrast; стабільні
коди послуг (`services.code`, 0144) — через REST-довідник наступних фаз
(рішення зафіксовано, події не роздуваємо).

Тіло: `{…поля як в appointments, "event": "...", "idempotencyKey": "uuid",
"seq": N}` — завжди **повний поточний стан** запису (state-based, не diff).
`seq` — монотонний номер події: два UPDATE в одній транзакції БД мають
однаковий `updated_at`, тож порядок відновлюється парою `(updated_at, seq)`.

Вимоги до приймача (частина контракту):

1. **Дедуплікація за `Idempotency-Key`** (заголовок і поле) — доставка
   at-least-once, повтори законні.
2. **Порядок не гарантований** (ретраї з backoff: 30s→…→1h, до 10 спроб,
   далі dead-letter): застосовувати подію, лише якщо її `(updated_at, seq)`
   новіший за збережений для цього `entry_id`.
   Вимкнення вебхука (`webhook:disable`) НЕ буферизує назавжди: події
   ретраяться за тим самим backoff і при довгому вікні йдуть у dead-letter —
   після повторного ввімкнення зробіть повний ресинк через GET.
3. **Перевірка підпису** `X-RadFlow-Signature: sha256=<hex>` —
   HMAC-SHA256 від сирого тіла секретом вебхука (порівняння —
   константний час). Запити без валідного підпису відкидати.
4. Відповідь 2xx = прийнято (до 3 с); інакше — ретрай.

## Помилки

`400` невалідний параметр (текст у `{"error": "..."}`); `401` ключ
невалідний/відкликаний; `403` бракує скоупа; `404` чужий/неіснуючий кабінет;
`429` ліміт; `5xx` тимчасово, повторіть із backoff.

## Межі (важливо)

- Персональні дані пацієнтів НЕ передаються (режим A). Режим B
  (демографічний pass-through) — окрема письмова угода, поза цим документом.
- Клінічний контент (показання, протипоказання, нотатки лікаря, висновки,
  зображення) НЕ передається і НЕ приймається — такі запити відхиляються.
- API read-only: створення/зміна записів ззовні у фазі 1 неможливі
  (статуси виконання — фаза 2, `events:write`).
