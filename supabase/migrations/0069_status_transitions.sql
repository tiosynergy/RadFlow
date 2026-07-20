-- 0069 — легальність переходів статусу як ІНВАРІАНТ БД
--
-- Проблема: CAS (expectedFrom) живе лише в Server Actions, а RLS queue_write_staff
-- (0024:41-44) дозволяє персоналу ПРЯМИЙ update:
--     PATCH /rest/v1/queue_entries?id=eq.… {"status":"done"}
-- анон-ключем + власним JWT — повз actions, CAS, hasSlotClash і будь-яку логіку.
-- Server Actions ходять під ТИМ САМИМ JWT, тож БД не може відрізнити «легальний
-- шлях» від прямого запиту. Отже машину станів має тримати сама БД.
--
-- ВАЖЛИВО про межі: CAS (optimistic concurrency) інваріантом БД бути НЕ МОЖЕ —
-- він виражає «оператор бачив статус X», а БД не знає, що бачив оператор. Тут ми
-- закриваємо інше: НЕЛЕГАЛЬНІ переходи, незалежно від шляху.
--
-- Правило (свідомо мінімальне, щоб не зламати робочі сценарії):
--   • у 'done' можна потрапити ЛИШЕ з 'in_progress' (або лишитись у 'done');
--     тобто «Виконано» без проходження кабінету заборонено — саме так зараз можна
--     клікнути крок 4 степпера пацієнту, який не приходив, і це росте «Дохід» у CEO
--     (п.7 аудиту 2026-07-11);
--   • решта переходів лишається дозволеною: повернення в чергу (↩), перенос
--     (reschedule ставить 'scheduled' навіть зі скасованого — «Перезапис»),
--     «все ж прийшов» із not_held, аварійна зупинка (in_progress → not_held) тощо.
--   • INSERT не перевіряємо: сид і міграції даних створюють історичні 'done'.

create or replace function public.guard_status_transition()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status is not distinct from old.status then
    return new;   -- статус не змінюється
  end if;

  if new.status = 'done' and old.status not in ('in_progress', 'done') then
    raise exception
      'STATUS_TRANSITION: «Виконано» можна поставити лише пацієнту, який був у кабінеті (поточний статус: %)',
      old.status
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;
revoke execute on function public.guard_status_transition() from public, anon;

-- Ім'я з 'g' — у групі гардів (після trg_a_set_scheduled_at / trg_b_not_in_past,
-- до trg_h_not_during_break і trg_no_overlap).
drop trigger if exists trg_g_status_transition on public.queue_entries;
create trigger trg_g_status_transition
  before update of status on public.queue_entries
  for each row
  execute function public.guard_status_transition();

-- ============================================================================
-- ПІСЛЯ МІГРАЦІЇ
-- ============================================================================
-- Код (уже в dev): степпер на дошках блокує крок «Виконано», поки пацієнт не в
-- кабінеті — щоб користувач бачив підказку, а не помилку з БД.
--
-- Перевірити руками:
--   • клік по кроку «Виконано» для пацієнта «В черзі» / «Очікує» → підказка,
--     статус не змінюється;
--   • нормальний шлях (В черзі → Очікує → В кабінеті → Виконано) → працює;
--   • «↩ В чергу» зі скасованого / неявки / «не відбулося» → працює;
--   • «Перезапис» скасованого запису → працює;
--   • аварійна зупинка кабінету з пацієнтом усередині → not_held (працює).
--
-- Наступний крок (за потреби, окремим рішенням): REVOKE UPDATE(status, in_progress_at,
-- call_status) ON queue_entries FROM authenticated + переведення статусних мутацій
-- на SECURITY DEFINER RPC. Тоді прямий PATCH статусу стане фізично неможливим,
-- а CAS і матриця переходів — обов'язковими для всіх шляхів.
