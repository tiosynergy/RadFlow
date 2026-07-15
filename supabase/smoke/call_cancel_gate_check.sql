-- ============================================================================
--  RadFlow — CHECK: обдзвін і скасування лише desk (0085). SQL Editor, ОДИН прогін.
--
--  ⚠️ НІЧОГО НЕ КОМІТИТЬ (усі гейти raise ДО запису; DO-блок кидає 'SMOKE_OK' і
--  відкочується). Імперсонація ролі — через request.jwt.claims (гейти на auth.uid()).
--  Це визначальна перевірка 0085: браузером її зробити не можна (у радіолога немає
--  UI обзвону/скасування, сесія в httpOnly-cookie).
--
--  Успіх = усі «PASS» + «CHECK OK», без ERROR. ПЕРЕДУМОВА: 0085 накочено.
-- ============================================================================
do $$
declare
  v_rad    uuid;   -- радіолог
  v_desk   uuid;   -- адмін або реєстратор
  v_clinic uuid;
  v_entry  uuid;   -- реальний запис у клініці радіолога (для тесту cancelled)
  v_fake   uuid := '00000000-0000-0000-0000-000000000000';
  rec      record;
begin
  select p.id, p.clinic_id into v_rad, v_clinic
    from public.profiles p where p.role = 'radiologist' and p.clinic_id is not null
    order by p.created_at limit 1;
  if v_rad is null then raise exception 'CHECK-SETUP: немає радіолога'; end if;

  select p.id into v_desk from public.profiles p
   where p.clinic_id = v_clinic and p.role in ('admin','registrar') order by p.created_at limit 1;
  if v_desk is null then raise exception 'CHECK-SETUP: немає desk у клініці радіолога'; end if;

  select q.id into v_entry from public.queue_entries q
   where q.clinic_id = v_clinic and q.status in ('scheduled','waiting','in_progress')
   order by q.created_at limit 1;

  raise notice 'FIXTURES: rad=% desk=% clinic=% entry=%', v_rad, v_desk, v_clinic, coalesce(v_entry::text,'(немає)');

  -- ══ РАДІОЛОГ → 42501 на обзвон/скасування ══
  perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_rad), true);

  -- 1) queue_set_call_rpc → 42501 (гейт ДО пошуку запису, тому fake id підходить)
  begin
    perform public.queue_set_call_rpc(v_fake, 'confirmed');
    raise exception '1 FAIL: радіолог провів queue_set_call_rpc';
  exception when insufficient_privilege then
    if sqlerrm like '%адміністратор або реєстратор%' then raise notice '1 PASS: радіолог call → 42501';
    else raise exception '1 FAIL: інший 42501: %', sqlerrm; end if;
  end;

  -- 2) queue_confirm_calls_rpc → 42501
  begin
    perform public.queue_confirm_calls_rpc(array[v_fake]);
    raise exception '2 FAIL: радіолог провів queue_confirm_calls_rpc';
  exception when insufficient_privilege then
    raise notice '2 PASS: радіолог confirm-all → 42501';
  end;

  -- 3) queue_set_status_rpc(..., 'cancelled') → 42501 (гейт ПІСЛЯ пошуку → потрібен РЕАЛЬНИЙ id)
  if v_entry is null then
    raise notice '3 SKIP: немає живого запису для тесту cancelled';
  else
    begin
      perform public.queue_set_status_rpc(v_entry, 'cancelled');
      raise exception '3 FAIL: радіолог скасував запис';
    exception when insufficient_privilege then
      if sqlerrm like '%скасувати запис може лише%' then raise notice '3 PASS: радіолог cancel → 42501';
      else raise exception '3 FAIL: інший 42501: %', sqlerrm; end if;
    end;

    -- 4) 'done' радіологу ДОЗВОЛЕНО (не скасування): гейт не спрацьовує; CAS з
    --    неможливим p_allowed блокує апдейт → updated=false, НЕ 42501, без мутації.
    select * into rec from public.queue_set_status_rpc(v_entry, 'done', null, array['no_show']::queue_status[]);
    if rec.updated then raise exception '4 FAIL: несподівано updated=true (мутація?)'; end if;
    raise notice '4 PASS: радіолог done не заблоковано роллю (updated=false за CAS)';
  end if;

  -- ══ DESK → проходить гейт (на fake id — «не знайдено», не роль) ══
  perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_desk), true);
  begin
    perform public.queue_set_call_rpc(v_fake, 'confirmed');
    raise exception '5 FAIL: desk на fake id не отримав "не знайдено"';
  exception when insufficient_privilege then
    if sqlerrm like '%не знайдено%' then raise notice '5 PASS: desk пройшов гейт call (fake → не знайдено)';
    else raise exception '5 FAIL: desk отримав роль-помилку (гейт хибно спрацював): %', sqlerrm; end if;
  end;
  -- confirm-all: desk проходить гейт → 0 рядків на fake id (не помилка)
  if public.queue_confirm_calls_rpc(array[v_fake]) = 0 then
    raise notice '6 PASS: desk пройшов гейт confirm-all (0 рядків на fake id)';
  else
    raise exception '6 FAIL: несподівано >0 оновлень на fake id';
  end if;

  raise exception 'SMOKE_OK';
exception
  when others then
    if sqlerrm = 'SMOKE_OK' then raise notice '───── CHECK OK: усі PASS. Нічого не змінено. ─────';
    else raise;
    end if;
end $$;
