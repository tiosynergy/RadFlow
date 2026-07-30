/* ============================================================================
   RadFlow — ОТКАТ тестового сева сессии 19 (2026-07-30)
   Удаляет 69 записей queue_entries и 3 кейса patient_cases, созданных сидом
   с маркером note = '[SEED s19] тестові дані' на 31.07–06.08.2026.

   Правила проекта соблюдены:
     • удаление ТОЛЬКО по явному списку ID из снимка 2026-07-30 (не по условию);
     • сверка снимка по md5 ДО удаления — если данные разошлись, скрипт падает;
     • dry-run по умолчанию (raise exception в конце откатывает всё);
     • проверка, что before-образы легли в audit_log (fn_audit глотает свои ошибки).

   Как запускать:
     1) как есть → DRY-RUN, покажет «CLEANUP_DRY_OK: ...» и НИЧЕГО не удалит;
     2) заменить v_dry := true на false → боевой прогон.
   Выполняет ВЛАДЕЛЕЦ через Supabase SQL Editor.
   ============================================================================ */
do $cleanup$
declare
  v_dry constant boolean := true;   -- боевой прогон: false

  -- Снимок 2026-07-30. md5 массива ниже обязан совпасть с md5 по базе.
  v_entry_ids uuid[] := array[
    '04a33cd7-8601-4079-95f0-337ecc296d12','071a4521-9061-48d5-9fd1-64f5a380f54c',
    '0e1fdf8f-a40f-4f0f-93d7-7c56a4735ba0','131ea246-4169-46a0-9e23-521df920c74b',
    '183c02ad-ac33-472a-8648-908aaec571cc','19cd5de6-4bd6-4c74-b2ff-94df4cf2a45a',
    '1c8ba5e6-8fc4-4ae3-acc0-e9350a2a6ef4','1ffef243-2d7d-454f-9e83-f5f26b5d1bac',
    '209d9513-d2b6-4334-9c33-1adb240464f6','2648fd6e-07a0-4fc0-aac8-a69c62e463eb',
    '2a50b1ff-4bc7-436b-b422-0329347a4da4','2cd7ec91-5cb9-4701-a13d-99b47ed85e26',
    '2d1b7304-bc1d-4316-8048-689c28b36a3d','2eed397d-b002-4541-98e1-c3ea929cfb80',
    '36f7ffd7-1f08-49bc-a0a6-ba00373c8726','394b5b5c-9b77-4e07-b423-dbbd860d36c1',
    '3a98e560-146a-4c70-872c-c1a9ce6cc00b','3abef306-2a9e-4d17-87fc-c92fe6d9bbfe',
    '3ef0ce4b-77e0-49af-8318-c252ae7cbce1','403590eb-6a20-457c-b8a7-baa227fd6d5c',
    '41efb0c6-9e6a-4ffe-9ea8-14ec5328a8bc','4378b8fa-b7c3-4671-9ce7-2ffe049a63db',
    '4c370cbe-6c70-48fd-b114-80d11c52291e','4dc8a0fe-eefa-492f-a0a6-eeb3ddf72404',
    '56779035-b641-43bb-ae4b-f8ebae323ef6','5bcb6c64-6f7b-4cfc-8edc-ae50eca4ce5f',
    '606acb96-be11-401c-b795-89b7afd75e56','64441ce4-269c-4933-87f3-723b65be7ba4',
    '6bba1dde-20ab-4977-a208-9727b7d58e55','6d78314d-e509-4205-a9ec-9c5a98146589',
    '6ff5ea39-ef9e-43d6-ab60-803241f387dd','7907219c-24c3-460a-8816-1dce7be16722',
    '7c3fc0de-08c7-4abb-b723-690dbddbba62','81bd44e9-25ca-403a-8fbe-0380d662c69a',
    '8d2d275d-ae5e-4df2-8724-87c6c1287b7f','9e6340aa-15f9-4036-a7dc-5df9a857adf1',
    '9e7b52b7-1bb7-46c1-97ea-9cc8cf385a17','9f005da4-5807-45f6-8425-680c739b1aa3',
    '9fbf6b53-3b47-47a1-aa73-452337556724','a6f3f03a-b4ff-4c38-a230-33c27ac7b241',
    'a712fac1-c6a7-44d7-bbea-9a40911976d5','b1699d79-be9d-4000-b17b-5b0b6b2f353d',
    'bcc5afb9-46e4-4228-8cb9-3ce274b7b0a4','bf3a97e5-10f9-44d1-81b6-df25a7eb9061',
    'c06f5443-a444-4af6-8ff5-2f19949a1f3b','c3e57529-ccd6-4f6e-b548-171e4b8008e3',
    'c400a554-e1ac-443b-996c-950d03d0f928','c58f0bbf-a4a0-45ce-bb2d-b1d90597bb8d',
    'c7be4943-01dc-4ca3-9dba-c26f28a20c4e','c9fe4011-3ceb-4926-8885-d18fa4a1efab',
    'cadbe570-681b-4b71-b05b-183b6d62ddc5','d0313532-26b4-4fa6-b426-4a94d8060fbb',
    'd2b6f233-a101-4947-84e3-22124004cde3','d5ebf660-86c6-4a54-a209-366b42a0bcc3',
    'dd8b1157-c39e-4af9-955b-919fdaf6f492','df4d39a3-d1b8-448d-8839-884b9dace889',
    'e0568046-664e-4713-847a-ef60571d21bb','e6b5d716-78f5-4684-89af-57eb966cca0e',
    'f13a80b6-8631-4b56-b9d2-a3b8530d489c','f15e8aa2-5454-4645-b4c9-33b31af24d5c',
    'f2b30a2a-850f-4266-bb77-e5ed91ea9507','f35733df-0086-43c9-b6ba-87433b903add',
    'f50d7f6a-f13b-4e33-9ab9-a833f81652f5','f69bd131-1305-4c62-8869-9fc7656a302b',
    'f750486a-5210-46d6-a237-a3c05965d5a8','f9f8a903-343c-4029-a324-12156b158381',
    'fc80239e-5aa7-4659-8107-f529a70988b7','fd9081e6-f71b-41d2-aa29-6651bbdca6fc',
    'fffc5add-a1af-4bea-836c-518f42754187'
  ]::uuid[];
  v_case_ids uuid[] := array[
    '63488b63-25c7-4097-aac3-785f87d6d4ef',
    '72863d75-2554-4f3e-a00c-d839d51f1f5b',
    'da024602-bae1-4bd9-8013-f9eb8a68a105'
  ]::uuid[];

  ENTRIES_MD5 constant text := '7451dd99fb4ec4fbe5d1faac6d41cd3b';
  CASES_MD5   constant text := '0121fd234588377261137deb9b11af59';

  v_md5_arr   text;
  v_md5_db    text;
  v_cnt       int;
  v_foreign   int;
  v_deleted   int;
  v_audited   int;
begin
  -- 1. Массив ID против самого себя (защита от правки файла).
  select md5(string_agg(x::text, ',' order by x)) into v_md5_arr from unnest(v_entry_ids) x;
  if v_md5_arr <> ENTRIES_MD5 then
    raise exception 'MD5_ARRAY_MISMATCH (записи): масив ID у файлі змінено (% <> %)', v_md5_arr, ENTRIES_MD5;
  end if;
  select md5(string_agg(x::text, ',' order by x)) into v_md5_arr from unnest(v_case_ids) x;
  if v_md5_arr <> CASES_MD5 then
    raise exception 'MD5_ARRAY_MISMATCH (кейси): масив ID у файлі змінено';
  end if;

  -- 2. Снимок против базы: набор строк с маркером обязан совпасть с массивом.
  select md5(string_agg(id::text, ',' order by id)) into v_md5_db
    from queue_entries where note like '[SEED s19]%';
  if v_md5_db is distinct from ENTRIES_MD5 then
    raise exception 'MD5_DB_MISMATCH (записи): у базі вже НЕ той набір рядків (%). Зроби свіжий знімок.', coalesce(v_md5_db, 'порожньо');
  end if;
  select md5(string_agg(id::text, ',' order by id)) into v_md5_db
    from patient_cases where note like '[SEED s19]%';
  if v_md5_db is distinct from CASES_MD5 then
    raise exception 'MD5_DB_MISMATCH (кейси): у базі вже НЕ той набір рядків';
  end if;

  -- 3. Поштучная проверка: удаляем ТОЛЬКО помеченные сидом строки.
  select count(*) into v_foreign from queue_entries
   where id = any(v_entry_ids) and note not like '[SEED s19]%';
  if v_foreign > 0 then
    raise exception 'FOREIGN_ROW: % рядків зі списку вже НЕ сидові — зупиняюсь', v_foreign;
  end if;

  -- 4. Кейс не должен держать чужие (не-сидовые) шаги.
  select count(*) into v_foreign from queue_entries
   where case_id = any(v_case_ids) and not (id = any(v_entry_ids));
  if v_foreign > 0 then
    raise exception 'CASE_HAS_FOREIGN_STEPS: % чужих кроків у сидових кейсах', v_foreign;
  end if;

  -- 5. Удаление: сперва записи (в т.ч. шаги кейсов), потом сами кейсы.
  delete from queue_entries where id = any(v_entry_ids);
  get diagnostics v_deleted = row_count;
  if v_deleted <> array_length(v_entry_ids, 1) then
    raise exception 'DELETE_COUNT: видалено %, очікували %', v_deleted, array_length(v_entry_ids, 1);
  end if;

  delete from patient_cases where id = any(v_case_ids);
  get diagnostics v_cnt = row_count;
  if v_cnt <> array_length(v_case_ids, 1) then
    raise exception 'DELETE_COUNT (кейси): видалено %, очікували %', v_cnt, array_length(v_case_ids, 1);
  end if;

  -- 6. before-образы обязаны лечь в audit_log (fn_audit глотает свои ошибки).
  select count(*) into v_audited from audit_log
   where table_name = 'queue_entries' and action = 'delete'
     and row_id = any(v_entry_ids);
  if v_audited <> v_deleted then
    raise exception 'AUDIT_GAP: у audit_log % записів проти % видалених — відкат', v_audited, v_deleted;
  end if;

  if v_dry then
    raise exception 'CLEANUP_DRY_OK: видалилось би % записів і % кейсів, аудит %',
      v_deleted, v_cnt, v_audited;
  end if;

  raise notice 'CLEANUP_DONE: % записів, % кейсів', v_deleted, v_cnt;
end
$cleanup$;
