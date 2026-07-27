-- ============================================================================
-- ЧИСТКА ТЕСТОВЫХ ДАННЫХ ПРОДА — сессия 14 (2026-07-28)
--
-- НЕ миграция: разовый maintenance-скрипт. Номер 0125 НЕ занимает.
-- Выполняет ВЛАДЕЛЕЦ через Supabase SQL Editor.
--
-- Что удаляем: 27 тестовых записей `queue_entries`, созданных при отладке
-- сессий 9–13 («ТЕСТ Таймер Перевірка», «тест кейс от Марии», «test»,
-- «tetsttest», «Кейс Фінал Тест» и т.п.), связанный вейтлист и осиротевшие
-- кейсы. Они портят KPI CeoDashboard: из 28 завершённых исследований 7 —
-- тестовые (25%), а две записи с датой 2026-07-28 висят на живых досках.
--
-- Список ID зафиксирован СНИМКОМ прод-БД от 2026-07-27 19:30 UTC, а не
-- регуляркой по имени: между написанием и запуском в базе может появиться
-- настоящий пациент с «тест» в фамилии, и регулярка снесла бы его молча.
--
-- Порядок удаления обязателен: FK `waitlist_entries.scheduled_entry_id` /
-- `.source_entry_id` → `queue_entries` и `queue_entries.case_id` →
-- `patient_cases` объявлены NO ACTION (не каскадные), поэтому
--   вейтлист → очередь → кейсы.
-- Кейс удаляем только если на него не осталось НИ ОДНОЙ живой записи —
-- в тестовых кейсах могли остаться реальные шаги.
--
-- Dry-run на проде выполнен: deleted_queue=27, deleted_waitlist=1,
-- deleted_cases=8, done 28 → 21, queue_left=113, waitlist_left=11.
-- ============================================================================

begin;

create temp table _cleanup_ids (id uuid primary key) on commit drop;

insert into _cleanup_ids (id) values
  ('7c974252-fd6f-4007-a77f-acf0137d4369'),  -- ТЕСТ Таймер Перевірка   2026-07-28
  ('3dfe1884-313e-4110-9a77-682ac510032e'),  -- тест кейс от Марии      2026-07-22
  ('7f3a71af-17f6-4a54-a60c-748ba9cabadc'),  -- тест кейс от Марии      2026-07-22
  ('1dab7ce7-b8d1-4856-8cc5-15a199e93036'),  -- тест новые услуги       2026-07-21
  ('71ff4420-9020-497c-b31b-9006856496bb'),  -- test                    2026-07-28
  ('d02be84a-e563-4851-acbe-dfeaa50999a5'),  -- TEST Рентген Пацієнт    2026-07-16
  ('afe44c91-0cac-4271-b7a4-09e643dd94d6'),  -- тесте                   2026-07-22
  ('e6c51ee5-921c-4e99-b92c-0c89ceea64c6'),  -- TEST Мамографія Пацієнт 2026-07-16
  ('e96156e6-c59b-4a53-b3ef-943448b6579e'),  -- Тест 1 МРТ Одесса       2026-07-22
  ('32638d26-ddb1-4710-a483-12b2109bb08a'),  -- тесте                   2026-07-22
  ('511d067f-e78e-464e-9192-40da4ea700bd'),  -- test                    2026-07-27
  ('fde42425-cfbd-4a59-b8e8-6a3b8e5bac84'),  -- тест тест               2026-07-24
  ('3f3880b2-f978-46a1-b893-d4912d1d4a51'),  -- тест узи                2026-07-23
  ('54d5068d-0960-4996-b480-91fc0203ab43'),  -- ТЕСТ ММГ                2026-07-16
  ('57cd3f8f-a54b-465d-b2bc-34ca7a23177e'),  -- кейс тест 6             2026-07-22
  ('dff4d053-5568-43ab-8d5b-655f95f61031'),  -- ТЕСТ Пацієнт с12        2026-07-27
  ('74b9fa3e-dcd7-415b-9a53-f4333e347e97'),  -- keys test               2026-07-21
  ('2714f405-d5ee-42ee-8a16-c4d747e60cc3'),  -- tetsttest               2026-07-22
  ('467ac02b-897f-4d30-843f-f3618b0f92f0'),  -- tetsttest               2026-07-22
  ('70541fa1-0e6e-4303-829f-bf0c8c977b20'),  -- keys2 test              2026-07-17
  ('509310c4-e588-4398-b8f4-cbf766b18ef7'),  -- Кейс Фінал Тест         2026-07-17
  ('4d10b0e6-c5e5-4dec-95c2-e6a94921a097'),  -- Кейс Фінал Тест         2026-07-17
  ('d815e362-6953-4cd1-858b-f8d892730285'),  -- тест кейс 5             2026-07-17
  ('24157728-4db3-4f80-b1a0-9dc4b5090b49'),  -- тест кейс 5             2026-07-20
  ('4d94667a-ccaf-4bd6-b1de-d027376b3080'),  -- кейс тест 6             2026-07-22
  ('95dea758-688f-4ab0-b2ee-bd0b9a04791e'),  -- ТЕСТ Таймер Перевірка   2026-07-24
  ('f55f05da-cae6-4855-b541-33eb3f218f02');  -- тест МРТ 1,5 от Мария   2026-07-27

-- Страховка от протухшего снимка: если хоть одна строка успела исчезнуть или
-- сменить имя — скрипт падает, а не удаляет «что нашлось».
do $$
declare v_found int; v_named int;
begin
  select count(*) into v_found
    from public.queue_entries q join _cleanup_ids c on c.id = q.id;
  select count(*) into v_named
    from public.queue_entries q join _cleanup_ids c on c.id = q.id
   where q.patient_name ~* '(тест|test|keys)';
  if v_found <> 27 then
    raise exception 'СТОП: в базе % из 27 записей снимка — список протух, пересоберите', v_found;
  end if;
  if v_named <> 27 then
    raise exception 'СТОП: % из 27 записей уже не выглядят тестовыми — проверьте вручную', v_named;
  end if;
end $$;

-- 1. Вейтлист: собственные тестовые брони + всё, что ссылается на удаляемые.
delete from public.waitlist_entries w
 where w.patient_name ~* '(тест|test)'
    or w.scheduled_entry_id in (select id from _cleanup_ids)
    or w.source_entry_id    in (select id from _cleanup_ids);

-- 2. Сами записи очереди.
delete from public.queue_entries q
 where q.id in (select id from _cleanup_ids);

-- 3. Кейсы, у которых не осталось ни одной записи.
delete from public.patient_cases pc
 where not exists (select 1 from public.queue_entries q where q.case_id = pc.id);

-- 4. Отчёт (посмотреть ПЕРЕД commit).
select (select count(*) from public.queue_entries)                          as queue_left,
       (select count(*) from public.queue_entries where status = 'done')    as done_left,
       (select count(*) from public.waitlist_entries)                       as waitlist_left,
       (select count(*) from public.patient_cases)                          as cases_left,
       (select count(*) from public.queue_entries
         where patient_name ~* '(тест|test)')                               as test_left;

-- Ожидаемо: queue_left=113, done_left=21, waitlist_left=11, test_left=0.
-- Если сходится — commit; иначе rollback.
commit;
