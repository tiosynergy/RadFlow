-- ---------------------------------------------------------------------------
--  RadFlow — Міграція 0140
--  RF-08 (хвости зовнішнього аудиту) + вирівнювання 0111 під канон 0139.
--
--  Максимальний ЗАСТОСОВАНИЙ на момент написання — 0139.
-- ---------------------------------------------------------------------------
--
--  Три незалежні частини:
--
--  === 1. `sro_referrer_read` → канон 0139 (борг із ревʼю 0139) ===
--
--  0139 ввела ОДНЕ правило видимості направника (грант ∪ кабінети власних
--  рядків, `auth_referrer_visible_rooms()`) і застосувала його до rooms/
--  services/incidents — а `sro_referrer_read` (0111) лишилась на самому гранті.
--  Наслідок: для кабінета власного рядка ПОЗА грантом направник бачив послуги,
--  але НЕ бачив їх переозначень (0108) — каталог збирався з базовими цінами
--  замість переозначених, розходячись із DEFINER-тригером
--  `check_studies_active_catalog` (який бачить усе). Писати в такий кабінет
--  направник усе одно не може, тож це було лише розходження відображення —
--  але правило «резолвер = тригер біт-у-біт» вимагає однакових множин.
--  Ролі політики зберігаються: to authenticated, як у 0111.
--
--  === 2. `search_path` для 7 INVOKER-функцій (security advisor) ===
--
--  У 7 функцій search_path був мутабельний (успадковувався від сесії): USAGE
--  на схему public у ролей є, тож пряма підміна обʼєктів малоймовірна, але
--  advisor правий — функція, яку кличуть DEFINER-тригери, зобовʼязана мати
--  прибитий search_path. `alter function … set search_path` НЕ чіпає ні тіло,
--  ні ACL (на відміну від drop+create — пастка 0122 не відкривається).
--
--  === 3. anon-EXECUTE allowlist (RF-08) ===
--
--  Supabase-дефолт гранить EXECUTE для anon КОЖНІЙ новій функції (пастка 0122).
--  Ревізія всіх SECURITY DEFINER функцій, виконуваних anon (33 шт. за
--  advisor-ом), дала три групи:
--
--  • ЛИШАЄМО (11 auth-хелперів: auth_clinic_id, auth_can_refer,
--    auth_referrer_clinics, auth_referrer_visible_rooms, auth_is_admin,
--    auth_is_ceo_of, auth_is_referrer, auth_ceo_clinics,
--    auth_radiologist_room_ok, auth_radiologist_case_ok,
--    auth_referrer_can_book_room): УСІ стоять у RLS-політиках, частина — у
--    політиках `{public}`. Відкликати EXECUTE у anon тут — відкрити пастку
--    0073: протухла сесія діставала б 42501 замість порожньої відповіді.
--
--  ⚠️ ФОРМА ВІДКЛИКАННЯ — ДВІ РІЗНІ. Дефолтний ACL містить грант на PUBLIC
--  (`=X/postgres`) ПЛЮС явні anon/authenticated/service_role, тож
--  `revoke … from anon` зняв би лише явний грант, а PUBLIC лишив би доступ
--  (спіймано dry-run-ом: зонд (c) почервонів на першій же функції). Тому:
--    • тригерні → `from public, anon, authenticated` (виконати їх не можна
--      нікому — канон 0132);
--    • RPC → `from public, anon` (authenticated ЛИШАЄТЬСЯ — ними користується
--      клієнт; підсумковий ACL = еталон 0122, queue_set_status_rpc).
--  НЕ копіюйте форму навмання: для тригерної функції друга форма — це
--  залишковий authenticated-warning advisor-а, для RPC перша — мертвий клієнт.
--
--  • ВІДКЛИКАЄМО у 18 тригерних функцій (returns trigger) — `from public, anon,
--    authenticated`, як 0132 зробила з tg_change_markers_* (той самий прийом
--    уже живе в проді з 0053/0061/0063/0064/0067/0069/0124/0132/0137):
--    PostgREST returns-trigger функції не публікує, викликати їх напряму
--    неможливо взагалі («trigger functions can only be called as triggers»),
--    а при спрацюванні тригера Postgres перевіряє EXECUTE у ТВОРЦЯ тригера на
--    момент create trigger, НЕ у того, чия мутація тригер запустила. Смоук
--    перевіряє це реальними мутаціями під authenticated (зонд d) І під anon
--    (зонд d2: відмова має прийти від RLS, а не «permission denied for
--    function» — обидва 42501, розрізняє ТЕКСТ).
--    ⚠️ handle_new_user — окремий випадок: її тригер стоїть на auth.users
--    (0001, on_auth_user_created) і запускається роллю supabase_auth_admin.
--    Перевірено, що це САМЕ тригер, а не Auth Hook (hook викликається як
--    звичайна функція і revoke його вбив би). SQL-смоук до GoTrue не дістає —
--    тому в кроках власника після накату стоїть тестова реєстрація.
--    ⚠️ fn_audit — PUBLIC-грант у неї знято ще 0053-ю; тут добираємо anon і
--    authenticated (для відкату це виняток — див. ROLLBACK.md).
--    4 тригерні функції з частини 2 (touch_updated_at, set_scheduled_at,
--    sync_cito_from_priority, clear_clarify_flag) у списку відкликань НЕМАЄ
--    свідомо: вони SECURITY INVOKER, advisor-пункт лише про DEFINER.
--
--  • ВІДКЛИКАЄМО (лише anon) у 5 RPC, яким anon не потрібен за призначенням:
--    - referral_center_card — картка центру направника (лише authenticated);
--    - search_referrers — пошук направників адміном;
--    - services_import_rpc — імпорт прайсу адміном;
--    - sink_overdue_scheduled — МЕРТВИЙ RPC: викликів у коді нуль (роботу
--      забрав pg_cron через sink_overdue_scheduled_all від service_role, а
--      згадки в QueueBoard/RadiologistBoard — коментарі). Найдешевший крок —
--      закрити anon зараз; drop або відкликання в authenticated — окремою
--      задачею;
--    - save_schedule_override — 0138 перевела її в SECURITY DEFINER, але
--      anon-EXECUTE лишився supabase-дефолтом (спіймано раундом по фіксах,
--      M-3): тіло і так фейлиться закрито (auth_clinic_id() null → 42501),
--      але advisor-пункт і зайва DEFINER-поверхня для anon нікому не потрібні.
--    Жодна не згадується в політиках (перевірено по pg_policy) — пастка 0073
--    не відкривається. Протухла сесія при виклику дістане 42501 — і це
--    правильно: це ЯВНИЙ виклик RPC, а не читання таблиці.
--
--  === Свідомо НЕ в цьому пакеті ===
--
--  • HIBP (auth_leaked_password_protection) — перемикач у Dashboard → Auth →
--    Passwords, міграцією не вмикається. Крок власника.
--  • rls_enabled_no_policy (change_marker_settings, event_outbox, rate_limits)
--    — це НАВМИСНИЙ deny-all: доступ лише зсередини DEFINER-функцій.
--  • extension_in_public (pg_trgm, pg_net) — перенос розширень зачіпає
--    індекси/оператори; окрема задача, якщо взагалі варта.
--  • 76 authenticated_security_definer_function_executable — за задумом:
--    RPC і викликаються authenticated-клієнтом; гарди ролей — у тілах.
--  • ~50 старих функцій із `set search_path = public` БЕЗ pg_temp: формально
--    pg_temp тоді шукається ПЕРШИМ для відношень, але жодне тіло в міграціях
--    не звертається до таблиць некваліфіковано (перевірено), а створити temp-
--    таблицю через PostgREST неможливо. Вирівнювання — окремим пакетом.
--
--  ⚠️ ЦІНА частини 2, визнана свідомо: функція з непорожнім proconfig НЕ
--  інлайниться планувальником. Для трьох IMMUTABLE-однорядкових
--  (greatest_severity, merge_changed_fields, study_type_modality) це означає
--  виклик через fmgr-обгортку із save/restore GUC замість інлайну — помітно
--  хіба що в ceo_kpi_studies на широкому діапазоні дат. Безпеки вони не
--  додають (тіла без звернень до таблиць), лишаємо заради зеленого advisor
--  і єдиного канону; якщо KPI колись просяде — саме ці три можна відкотити
--  reset-ом без наслідків.

begin;

set local lock_timeout = '3s';

-- ============================================================================
-- 1. sro_referrer_read → auth_referrer_visible_rooms (канон 0139)
-- ============================================================================
drop policy if exists sro_referrer_read on public.service_room_overrides;
create policy sro_referrer_read on public.service_room_overrides
  for select to authenticated using (
    public.auth_can_refer(clinic_id)
    and room_id in (select public.auth_referrer_visible_rooms())
  );

-- ============================================================================
-- 2. search_path (advisor: function_search_path_mutable, 7 шт.)
-- ============================================================================
alter function public.greatest_severity(a text, b text)      set search_path = public, pg_temp;
alter function public.merge_changed_fields(a text[], b text[]) set search_path = public, pg_temp;
alter function public.touch_updated_at()                     set search_path = public, pg_temp;
alter function public.set_scheduled_at()                     set search_path = public, pg_temp;
alter function public.sync_cito_from_priority()              set search_path = public, pg_temp;
alter function public.clear_clarify_flag()                   set search_path = public, pg_temp;
alter function public.study_type_modality(p_type text)       set search_path = public, pg_temp;

-- ============================================================================
-- 3. anon-EXECUTE: тригерні функції (18)
-- ============================================================================
revoke execute on function public.check_case_clinic_match()      from public, anon, authenticated;
revoke execute on function public.check_case_distinct_room()     from public, anon, authenticated;
revoke execute on function public.check_case_no_time_overlap()   from public, anon, authenticated;
revoke execute on function public.check_no_overlap()             from public, anon, authenticated;
revoke execute on function public.check_not_during_incident()    from public, anon, authenticated;
revoke execute on function public.check_service_room()           from public, anon, authenticated;
revoke execute on function public.check_service_room_override()  from public, anon, authenticated;
revoke execute on function public.check_studies_active_catalog() from public, anon, authenticated;
revoke execute on function public.check_studies_match_room()     from public, anon, authenticated;
revoke execute on function public.check_waitlist_consistency()   from public, anon, authenticated;
revoke execute on function public.fn_audit()                     from public, anon, authenticated;
revoke execute on function public.guard_call_status_change()     from public, anon, authenticated;
revoke execute on function public.guard_priority_change()        from public, anon, authenticated;
revoke execute on function public.guard_referrer_doctor()        from public, anon, authenticated;
revoke execute on function public.guard_status_change_referrer() from public, anon, authenticated;
revoke execute on function public.guard_waitlist_room()          from public, anon, authenticated;
revoke execute on function public.handle_new_user()              from public, anon, authenticated;
revoke execute on function public.trg_case_status_recompute()    from public, anon, authenticated;

-- ============================================================================
-- 4. anon-EXECUTE: RPC, яким anon не потрібен (5) — authenticated лишається
-- ============================================================================
revoke execute on function public.referral_center_card(p_access_id uuid)          from public, anon;
revoke execute on function public.search_referrers(q text)                        from public, anon;
revoke execute on function public.services_import_rpc(p_rows jsonb, p_room_id uuid) from public, anon;
revoke execute on function public.sink_overdue_scheduled()                        from public, anon;
revoke execute on function public.save_schedule_override(p_override_date date, p_all_closed boolean, p_label text, p_rooms jsonb, p_expected_updated_at text) from public, anon;

commit;
