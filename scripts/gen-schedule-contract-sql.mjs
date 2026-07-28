#!/usr/bin/env node
/* ===== Генератор SQL-сторони контракту розкладу =====

   Читає tests/fixtures/scheduleContract.json і пише
   supabase/smoke/schedule_contract_smoke.sql.

   Навіщо генератор, а не два списки руками: сенс контракту саме в тому, що набір
   сценаріїв ОДИН. Два синхронізованих вручну списки розходяться на третьому
   комміті, і тест починає доводити те, чого не перевіряє.

   Запуск:  npm run gen:schedule-contract
   Перевірка «не забули перегенерувати»: прогнати генератор і `git diff --exit-code
   supabase/smoke/schedule_contract_smoke.sql`.

   Смоук самодостатній і НІЧОГО не лишає по собі: усе в одній транзакції, яку
   фінальний `raise exception 'SMOKE_OK'` відкочує (штатний патерн проєкту).      */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(readFileSync(resolve(root, "tests/fixtures/scheduleContract.json"), "utf8"));

/** Літерал для SQL: одинарні лапки подвоюємо, більше нічого з фікстури не приходить. */
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
/** JSONB-літерал; `$ROOM` підставляє вже сам смоук через replace() по тексту. */
const j = (o) => (o === null || o === undefined ? "null" : q(JSON.stringify(o)) + "::jsonb");

const rows = fixture.cases.map((c) => ({
  id: c.id,
  weekday: c.weekday,
  roomSchedule: c.roomSchedule ?? null,
  override: c.override ?? null,
  time: c.time,
  durationMin: c.durationMin,
  offSchedule: !!c.offSchedule,
  expect: c.expectSql ?? c.expect,
  note: String(c.note).replace(/\s+/g, " ").slice(0, 160),
}));

/* Сценарії їдуть у смоук ОДНИМ jsonb-літералом, а тіло циклу написане один раз.
   Розгортати 38 копій insert-блоку було б 47 КБ нечитабельного SQL, який ще й не
   влазить у вікно SQL-редактора без прокрутки на кілометр. */
const casesJson = q(JSON.stringify(rows, null, 0));

const sql = `-- ============================================================================
-- schedule_contract_smoke.sql — SQL-сторона КОНТРАКТУ РОЗКЛАДУ.
--
-- ⚠️ ФАЙЛ ЗГЕНЕРОВАНО. Не правити руками: джерело — tests/fixtures/scheduleContract.json,
--    генератор — scripts/gen-schedule-contract-sql.mjs (\`npm run gen:schedule-contract\`).
--    Той самий файл фікстури проганяє TS-сторону (tests/scheduleContract.test.ts),
--    тож набір сценаріїв фізично один і розійтися не може.
--
-- ЩО ПЕРЕВІРЯЄ: що тригери \`check_not_during_break\` (0067/0077) і
-- \`check_room_schedule\` (0084) виносять ТОЙ САМИЙ вердикт, що й lib/schedule.ts,
-- на ${rows.length} сценаріях: дні тижня (days[] і дефолт), власні години, perDay/dayHours,
-- перерви нового й легасі формату, override дати й окремого кабінету, межі
-- графіка та стеля off-schedule grace (+120 хв).
--
-- ЯК ЧИТАТИ РЕЗУЛЬТАТ:
--   \`SMOKE_OK (N сценаріїв, розходжень немає)\` — сторони збігаються;
--   \`SMOKE_FAIL: TS і БД розійшлись → <id>: очікували X, БД дала Y; …\` — перелік УСІХ розходжень.
--
-- ⚠️ ЛОК: \`disable trigger user\` бере ACCESS EXCLUSIVE на queue_entries до кінця
-- транзакції — черга на цей час заморожена для всіх. Ганяти ПОЗА пік.
-- Смоук тимчасово переписує \`rooms.schedule\` одного живого кабінету і рядки
-- \`schedule_overrides\` на майбутні дати — усе в ОДНІЙ транзакції, яку фінальний
-- \`raise exception\` відкочує повністю. Після прогону в БД не лишається нічого.
--
-- Data-independent: працює від будь-якого наявного кабінету.
-- ============================================================================
do $smoke$
declare
  v_cases  constant jsonb := ${casesJson}::jsonb;
  c        jsonb;
  v_room   public.rooms%rowtype;
  v_mon    date;
  v_date   date;
  v_id     uuid;
  v_ovr    jsonb;
  v_exp    text;
  v_got    text;
  v_fails  text := '';
  v_n      int := 0;
begin
  set local lock_timeout = '5s';

  select r.* into v_room from public.rooms r order by r.created_at limit 1;
  if v_room.id is null then
    raise exception 'SMOKE_FAIL setup: у БД немає жодного кабінету';
  end if;

  -- Сценарії задані ДНЕМ ТИЖНЯ, а не датою: обидві сторони рахують день тижня
  -- (TS \`(getDay()+6)%7\`, SQL \`isodow-1\`), і прив'язка до числа зробила б тест
  -- таким, що тухне. Беремо понеділок у майбутньому — щоб не залежати від
  -- \`check_not_in_past\` навіть у вимкненому стані.
  v_mon := (date_trunc('week', current_date + interval '30 days'))::date;
  if extract(isodow from v_mon)::int <> 1 then
    raise exception 'SMOKE_FAIL setup: базова дата % не понеділок', v_mon;
  end if;

  -- Перевіряємо РІВНО два тригери контракту; решту глушимо, щоб чужа відмова
  -- (перекриття, каталог, статус-степпер) не читалась як розходження.
  alter table public.queue_entries disable trigger user;
  alter table public.queue_entries enable trigger trg_h_not_during_break;
  alter table public.queue_entries enable trigger trg_i_room_schedule;

  for c in select value from jsonb_array_elements(v_cases) loop
    v_date := v_mon + (c ->> 'weekday')::int;
    v_exp  := c ->> 'expect';
    v_id   := gen_random_uuid();

    -- \`rooms.schedule\` — NOT NULL з дефолтом '{}', тож «графіка немає» в БД
    -- виражається JSON-null'ом, а не SQL-NULL'ом. Обидві сторони обробляють це
    -- однією гілкою: SQL — \`jsonb_typeof(v_sched) <> 'object'\`, TS — \`roomSchedule\`
    -- прилітає з PostgREST як JS null і \`roomSchedule != null\` не спрацьовує.
    update public.rooms
       set schedule = case when jsonb_typeof(c -> 'roomSchedule') = 'null' then 'null'::jsonb else c -> 'roomSchedule' end
     where id = v_room.id;

    delete from public.schedule_overrides
     where clinic_id = v_room.clinic_id and override_date = v_date;

    if jsonb_typeof(c -> 'override') = 'object' then
      v_ovr := c -> 'override';
      insert into public.schedule_overrides (clinic_id, override_date, all_closed, label, rooms)
      values (
        v_room.clinic_id, v_date,
        coalesce((v_ovr -> 'all_closed')::boolean, false),
        v_ovr ->> 'label',
        -- \$ROOM у фікстурі — плейсхолдер id кабінету (TS-сторона робить те саме).
        -- \`schedule_overrides.rooms\` теж NOT NULL → «без покабінетних правил»
        -- це порожній об'єкт. TS бачить те саме: \`override.rooms[roomId]\` дає
        -- undefined і гілка override кабінету не спрацьовує.
        case when jsonb_typeof(v_ovr -> 'rooms') = 'object'
             then replace((v_ovr -> 'rooms')::text, '$ROOM', v_room.id::text)::jsonb
             else '{}'::jsonb end);
    end if;

    v_got := 'ok';
    begin
      insert into public.queue_entries
        (id, clinic_id, room_id, patient_name, scheduled_date, scheduled_time, duration_min, status, off_schedule)
      values (v_id, v_room.clinic_id, v_room.id, 'CONTRACT ' || (c ->> 'id'), v_date,
              c ->> 'time', (c ->> 'durationMin')::int, 'scheduled', (c -> 'offSchedule')::boolean);
      delete from public.queue_entries where id = v_id;
    exception when others then
      -- Тригери контракту кидають 'ВЕРДИКТ: текст' → префікс до двокрапки і є вердиктом.
      v_got := split_part(sqlerrm, ':', 1);
    end;

    if v_got <> v_exp then
      v_fails := v_fails || format('%s: очікували %s, БД дала %s; ', c ->> 'id', v_exp, v_got);
    end if;
    v_n := v_n + 1;
  end loop;

  alter table public.queue_entries enable trigger user;

  if v_fails <> '' then
    raise exception 'SMOKE_FAIL: TS і БД розійшлись → %', v_fails;
  end if;

  raise exception 'SMOKE_OK (% сценаріїв, розходжень немає)', v_n;
end
$smoke$;
`;

const out = resolve(root, "supabase/smoke/schedule_contract_smoke.sql");
writeFileSync(out, sql, "utf8");
console.log(`schedule_contract_smoke.sql: ${rows.length} сценаріїв → ${out}`);
