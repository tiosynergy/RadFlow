# RadFlow — откат миграций 0031–0037 (MIN-15)

Миграции применяются вперёд (Supabase → SQL Editor). Ниже — ручные скрипты отката
для миграций, добавленных в ходе аудита 2026-06-25. Выполнять в **обратном** порядке
(0037 → 0031) и только при необходимости. Все скрипты идемпотентны.

## Откат 0142 (migration ledger + деплой-гейт)

> Откат БД тривиален (дроп таблицы — данные леджера воспроизводимы бекфілом),
> но вместе с ним нужно снять и клиентскую обвязку, иначе `npm run build`
> станет падать на «не зміг прочитати migration_ledger»:
> в `package.json` вернуть `"build": "next build"` (и при желании убрать
> `db:gate`/`db:gate:check`), либо задать `RADFLOW_SKIP_MIGRATION_GATE=1`.
> Канон самореєстрації (self-insert последним statement-ом миграции) при
> откате перестаёт действовать — соответствующий пункт в AGENTS.md
> («Самореєстрація в леджері») нужно убрать/пометить, иначе следующая сессия
> продолжит писать футеры в никуда.
>
> ⚠️ Уже НАПИСАННЫЕ, но ещё не накатанные миграции 0143+ содержат футер
> `insert into public.migration_ledger …` — после дропа таблицы их накат
> упадёт на последнем statement-е и откатит ВЕСЬ DDL миграции. Перед их
> накатом либо вырежьте футер, либо не дропайте таблицу (откатите только
> обвязку в package.json).

```sql
begin;
drop table if exists public.migration_ledger;
commit;
```

## Откат 0141 (триггер чистки клиник-сирот)

> Откат снимает ЗАПОБІЖНИК, но НЕ восстанавливает уже удалённые клиники —
> удаление каскадно и необратимо (восстановление только из бэкапа). Триггер
> удаляет ТОЛЬКО полностью пустые клиники без единого профиля, так что терять
> при его работе нечего — откатывать есть смысл лишь если он мешает какому-то
> новому легитимному потоку «клиника без профилей» (на 2026-08-10 таких
> потоков нет: клиники создаёт только handle_new_user в паре с профилем).
>
> Строки audit_log с `table_name='clinics'` — журнал; при откате их не трогать
> (их приберёт cron-мітла prune-audit-log за 180 дней).

```sql
begin;
drop trigger if exists trg_cleanup_orphan_clinic on public.profiles;
drop function if exists public.cleanup_orphan_clinic();
commit;
```

## Откат 0140 (search_path 7 функций + allowlist 18 триггерных и 5 RPC + sro на каноне 0139)

> Три части независимы — откатывать можно любую отдельно.
>
> ⚠️ **Часть 3: восстанавливать РОВНО в снятой форме.** У 18 триггерных revoke
> снял ТРИ элемента ACL (грант на PUBLIC `=X/postgres`, явные `anon=X` и
> `authenticated=X`), у 5 RPC — ДВА (authenticated не отзывался).
> `grant … to anon` вернул бы только один:
> ACL разошёлся бы с исходным, и следующий `revoke … from anon` (без public)
> уже НЕ закрыл бы доступ — ровно ловушка, которую dry-run 0140 поймал на
> первой же функции. Явный грант service_role revoke не трогал.
>
> ⚠️ **Исключение — `fn_audit()`:** PUBLIC-грант у неё снят ещё 0053-й (строка
> 70); 0140 добил только anon/authenticated. Вернуть ей public = откатить 0053.
>
> ⚠️ **Часть 2:** `reset search_path`, а НЕ `set search_path = ''` — пустой
> путь это не «как было», а более строгий режим.
>
> ⚠️ **Часть 1:** возврат к редакции 0111 СУЖАЕТ видимость направителя (грант
> вместо «грант ∪ кабинеты своих строк») и снова рассинхронит sro с
> services/rooms/incidents из 0139. Делать только вместе с откатом 0139.

```sql
-- Часть 1: sro_referrer_read → редакция 0111. Роль сохранить: to authenticated.
drop policy if exists sro_referrer_read on public.service_room_overrides;
create policy sro_referrer_read on public.service_room_overrides
  for select to authenticated using (
    public.auth_can_refer(clinic_id)
    and public.auth_referrer_can_book_room(room_id)
  );

-- Часть 2: снять прибитый search_path (вернуть наследование от сессии).
alter function public.greatest_severity(text, text)        reset search_path;
alter function public.merge_changed_fields(text[], text[]) reset search_path;
alter function public.touch_updated_at()                   reset search_path;
alter function public.set_scheduled_at()                   reset search_path;
alter function public.sync_cito_from_priority()            reset search_path;
alter function public.clear_clarify_flag()                 reset search_path;
alter function public.study_type_modality(text)            reset search_path;

-- Часть 3a: 17 триггерных — вернуть PUBLIC + явные anon, authenticated.
grant execute on function public.check_case_clinic_match()      to public, anon, authenticated;
grant execute on function public.check_case_distinct_room()     to public, anon, authenticated;
grant execute on function public.check_case_no_time_overlap()   to public, anon, authenticated;
grant execute on function public.check_no_overlap()             to public, anon, authenticated;
grant execute on function public.check_not_during_incident()    to public, anon, authenticated;
grant execute on function public.check_service_room()           to public, anon, authenticated;
grant execute on function public.check_service_room_override()  to public, anon, authenticated;
grant execute on function public.check_studies_active_catalog() to public, anon, authenticated;
grant execute on function public.check_studies_match_room()     to public, anon, authenticated;
grant execute on function public.check_waitlist_consistency()   to public, anon, authenticated;
grant execute on function public.guard_call_status_change()     to public, anon, authenticated;
grant execute on function public.guard_priority_change()        to public, anon, authenticated;
grant execute on function public.guard_referrer_doctor()        to public, anon, authenticated;
grant execute on function public.guard_status_change_referrer() to public, anon, authenticated;
grant execute on function public.guard_waitlist_room()          to public, anon, authenticated;
grant execute on function public.handle_new_user()              to public, anon, authenticated;
grant execute on function public.trg_case_status_recompute()    to public, anon, authenticated;

-- Часть 3b: fn_audit — БЕЗ public (см. врезку: public снят 0053-й).
grant execute on function public.fn_audit() to anon, authenticated;

-- Часть 3c: 5 RPC (authenticated у них 0140 не отзывал — вернуть public+anon).
grant execute on function public.referral_center_card(uuid)       to public, anon;
grant execute on function public.search_referrers(text)           to public, anon;
grant execute on function public.services_import_rpc(jsonb, uuid) to public, anon;
grant execute on function public.sink_overdue_scheduled()         to public, anon;
grant execute on function public.save_schedule_override(date, boolean, text, jsonb, text) to public, anon;
```

## Откат 0139 (room-скоуп направителя: rooms / services / incidents)

> Откат возвращает направителю чтение **всего** операционного каталога центра —
> то есть ровно ту утечку, которую нашёл внешний аудит (RF-03). Делать только
> вместе с откатом клиента.
>
> ⚠️ **Порядок обязателен: сперва политики, потом функция.** PL/pgSQL и RLS
> резолвят вызовы в рантайме — если сначала уронить
> `auth_referrer_visible_rooms()`, все три политики начнут падать с
> `42883 function does not exist`, и направитель получит ошибку вместо данных.
>
> ⚠️ Индекс `waitlist_referrer_idx` откатывать **не нужно**: он полезен сам по
> себе (`waitlist_select` из 0138 фильтрует по `referrer_id`).
>
> ⚠️ Клиентские правки (`ReferrerSidebar` — три причины пустого списка,
> `ReferralPortal.reschedRooms` — явный фильтр грантом) откатывать не следует:
> они корректны и на старой политике.

```sql
-- Шаг 1: вернуть политики к состоянию до 0139 (0024 для rooms/incidents,
-- 0107 для services). Роли сохранить: {public} у rooms/incidents,
-- to authenticated у services.
drop policy if exists rooms_referrer_read on public.rooms;
create policy rooms_referrer_read on public.rooms
  for select using (clinic_id in (select public.auth_referrer_clinics()));

drop policy if exists services_referrer_read on public.services;
create policy services_referrer_read on public.services
  for select to authenticated using (public.auth_can_refer(clinic_id));

drop policy if exists incidents_referrer_read on public.incidents;
create policy incidents_referrer_read on public.incidents
  for select using (clinic_id in (select public.auth_referrer_clinics()));

-- Шаг 2: только теперь убрать функцию.
drop function if exists public.auth_referrer_visible_rooms();
```

## Откат 0138 (lockdown schedule_overrides + аудитория пометок)

> Две части независимы.
>
> **Часть А (RF-04).** ⚠️ ПОРЯДОК ВНУТРИ ЧАСТИ А ОБЯЗАТЕЛЕН: сперва вернуть
> гранты, только потом переводить функцию обратно в SECURITY INVOKER. В зазоре
> между `revoke` и `invoker` у редактора графика дня НЕТ ни одного рабочего пути
> записи. Последствие отката: возвращается обход CAS прямым PATCH-ом (lost
> update H-5, от которого спасала 0135).
>
> **Часть Б (F-3).** Возвращает пометки `catalog` регистратору и
> `catalog`/`waitlist` радиологу — то есть негасимые пометки. Погашенные
> пометки (`seen_at`) НЕ восстанавливаются и не должны: «прочитано» — штатное
> состояние. Клиентские точки ack (радиолог → «простои», направитель → лист
> ожидания) откатывать не нужно и не следует: они полезны сами по себе.

```sql
-- Часть А, шаг 1: вернуть прямой DML.
grant insert, update, delete, truncate on public.schedule_overrides to authenticated, anon;
-- Часть А, шаг 2: вернуть SECURITY INVOKER — выполнить блок «1. CAS-RPC для
-- schedule_overrides» файла 0135 целиком (тело идентично, отличается ровно
-- словом invoker; ACL при create or replace сохраняется).

-- Часть Б: вернуть тела из 0134 (change_marker_recipients — без 'catalog' в
-- правиле «только админ») и из 0132 (tg_change_markers_services / _sro /
-- _waitlist — там нет p_room_relevant => false).
```

## Откат 0137 (хвост RF-01 + fail-closed room_ids + бэкфилл doctor)

> **Бэкфилл `doctor` откату НЕ подлежит и не требует его**: нормализация пробелов
> не меняет смысл строки, а сравнения имён в коде и так нормализуются на чтении.
> Если исходные значения всё же понадобятся — они есть в `audit_log` (триггер
> `fn_audit` при бэкфилле оставался ВКЛЮЧЁННЫМ именно ради этого).
>
> Части независимы. Откат ролевой части возвращает радиологу clinic-wide чтение
> вейтлиста и кейсов (PII чужих кабинетов) — делать только вместе с откатом 0136.
> Откат F-2 возвращает fail-open: пустой `room_ids` снова = «все кабинеты», и
> тогда ОБЯЗАТЕЛЬНО откатывать и клиентский шаг (`lib/rooms.ts`), иначе код
> станет строже БД — та самая инверсия, из-за которой M-7 однажды откатили.

```sql
-- Часть А: радиолог (вейтлист + кейсы)
drop trigger if exists a00_radiologist_no_write on public.waitlist_entries;
drop trigger if exists a00_radiologist_no_write on public.patient_cases;
drop function if exists public.guard_radiologist_no_write();

drop policy if exists waitlist_select on public.waitlist_entries;
create policy waitlist_select on public.waitlist_entries
  for select using (clinic_id = public.auth_clinic_id() or created_by = auth.uid());
drop policy if exists waitlist_write_staff on public.waitlist_entries;
create policy waitlist_write_staff on public.waitlist_entries
  for all using (clinic_id = public.auth_clinic_id() and not public.auth_is_referrer())
  with check (clinic_id = public.auth_clinic_id() and not public.auth_is_referrer());

drop policy if exists cases_select_staff on public.patient_cases;
create policy cases_select_staff on public.patient_cases
  for select to authenticated using (clinic_id = (select public.auth_clinic_id()));
drop policy if exists cases_insert_staff on public.patient_cases;
create policy cases_insert_staff on public.patient_cases
  for insert to authenticated
  with check (clinic_id = (select public.auth_clinic_id()) and not (select public.auth_is_referrer()));
drop policy if exists cases_update_staff on public.patient_cases;
create policy cases_update_staff on public.patient_cases
  for update to authenticated
  using (clinic_id = (select public.auth_clinic_id()) and not (select public.auth_is_referrer()))
  with check (clinic_id = (select public.auth_clinic_id()) and not (select public.auth_is_referrer()));

drop function if exists public.auth_radiologist_case_ok(uuid);

-- Часть Б: F-2 (вернуть «пустой массив = все кабинеты»)
-- ⚠️ Только вместе с откатом клиента (lib/rooms.ts → старая формула с .length).
create or replace function public.auth_referrer_can_book_room(p_room uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(
    select 1 from public.rooms r
      join public.referral_access ra on ra.clinic_id = r.clinic_id
     where r.id = p_room and ra.referrer_id = auth.uid() and ra.status = 'active'
       and (ra.room_ids is null or array_length(ra.room_ids, 1) is null or r.id = any(ra.room_ids)))
$$;
-- referral_center_card — полное тело (иначе получим инверсию: бронь проходит,
-- а кабинета в карточке центра нет).
create or replace function public.referral_center_card(p_access_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'clinic_id', c.id, 'name', c.name, 'city', c.city,
    'status', ra.status, 'policy', ra.policy, 'note', ra.note,
    'admins', coalesce((
      select jsonb_agg(jsonb_build_object('full_name', p.full_name, 'phone', p.phone, 'email', p.email)
             order by p.created_at)
        from public.profiles p where p.clinic_id = c.id and p.role = 'admin'), '[]'::jsonb),
    'rooms', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name,
               'modality', r.modality, 'apparatus_model', r.apparatus_model) order by r.name)
        from public.rooms r
       where r.clinic_id = c.id
         and (ra.room_ids is null or array_length(ra.room_ids, 1) is null or r.id = any(ra.room_ids))
    ), '[]'::jsonb))
  from public.referral_access ra
  join public.clinics c on c.id = ra.clinic_id
  where ra.id = p_access_id and ra.referrer_id = auth.uid();
$$;
```

> **Порядок выката пакета (важно для обоих откатов):** сначала миграция 0137,
> потом клиентский бандл. Обратный порядок воспроизводит ровно ту инверсию,
> ради которой M-7 однажды откатывали: код строже БД → «кабинет видно в
> карточке, а бронирование отказывает».

## Откат 0136 (кабинетный скоуп радиолога, RF-01)

> Откат ВОЗВРАЩАЕТ дефект: радиолог снова читает и правит записи неназначенных
> кабинетов прямым PostgREST (утечка PII пациентов). Делать только как аварийную
> меру, если политика ломает работу центра.
>
> Тела `queue_set_status_rpc` / `queue_reschedule_rpc` откатывать НЕ обязательно:
> добавленный в них room-гард для не-радиологов прозрачен (хелпер вернёт true).
> Если откатывать — брать тела из 0129 и 0122 соответственно.
>
> ⚠️ **Поэтому хелпер `auth_radiologist_room_ok` НЕ ДРОПАТЬ.** PL/pgSQL резолвит
> вызовы в рантайме: если оставить тела RPC (как разрешено выше) и дропнуть
> хелпер, ЛЮБОЙ переход статуса и ЛЮБОЙ перенос записи любой ролью упадёт с
> `42883 function does not exist` — аварийный откат положил бы основной поток
> продукта целиком. Хелпер безвреден сам по себе (для не-радиолога всегда
> `true`), пусть остаётся. Дропать его можно ТОЛЬКО вместе с откатом обоих тел
> RPC и после отката 0137 (она его тоже использует).

```sql
drop trigger if exists a00_radiologist_scope on public.queue_entries;
drop function if exists public.guard_radiologist_scope();

drop policy if exists queue_select on public.queue_entries;
create policy queue_select on public.queue_entries
  for select using (clinic_id = auth_clinic_id() or created_by = auth.uid() or referrer_id = auth.uid());
drop policy if exists queue_write_staff on public.queue_entries;
create policy queue_write_staff on public.queue_entries
  for all using (clinic_id = auth_clinic_id() and not auth_is_referrer())
  with check (clinic_id = auth_clinic_id() and not auth_is_referrer());

-- ⚠️ auth_radiologist_room_ok(uuid) НЕ дропаем — см. предупреждение выше
-- (её зовут тела queue_set_status_rpc / queue_reschedule_rpc в рантайме).
```

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
> **Часть А (RPC).** ⚠️ **Если 0138 УЖЕ накатана — прямые гранты отозваны, и
> откат 0135 в одиночку убивает редактор графика дня целиком** (ни RPC, ни
> таблицы). Сперва откатить часть А из 0138 (гранты назад + `security invoker`),
> и только затем эту. Абзац ниже — исторический, он верен только ДО 0138:
> «прямые гранты на таблицу миграцией не отзывались, так что старый путь записи
> работоспособен всегда». Последствие отката: возвращается lost update H-5
> (два админа затирают правки друг друга).
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
