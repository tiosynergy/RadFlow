-- ============================================================
--  RadFlow — Міграція 0038: картка центру для направника (RPC)
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0037.
--
--  Навіщо: у порталі направника картку центру (запрошення/активний) можна
--  розгорнути й показати: дані центру + КОНТАКТИ АДМІНІСТРАТОРА + перелік
--  АВТОРИЗОВАНОГО ОБЛАДНАННЯ (кабінетів) для цього направника.
--
--  Чому RPC, а не пряме читання: чинні RLS НЕ дають направнику прочитати
--    • профіль адміна чужого центру (контакти), і
--    • кабінети центру, поки доступ ще не active (запрошення pending_referrer —
--      auth_referrer_clinics() повертає лише active).
--  Security-definer RPC віддає рівно ці дані й лише для звʼязку, що належить
--  самому виклику (ra.referrer_id = auth.uid()). Жодного витоку PII пацієнтів.
--
--  Безпечна для повторного запуску (idempotent).
-- ============================================================

create or replace function public.referral_center_card(p_access_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'clinic_id', c.id,
    'name',      c.name,
    'city',      c.city,
    'status',    ra.status,
    'policy',    ra.policy,
    'note',      ra.note,
    -- Контакти адміністратора(ів) центру.
    'admins', coalesce((
      select jsonb_agg(jsonb_build_object(
               'full_name', p.full_name,
               'phone',     p.phone,
               'email',     p.email
             ) order by p.created_at)
        from public.profiles p
       where p.clinic_id = c.id and p.role = 'admin'
    ), '[]'::jsonb),
    -- Авторизоване обладнання: room_ids IS NULL/порожній ⇔ усі кабінети центру.
    'rooms', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id',              r.id,
               'name',            r.name,
               'modality',        r.modality,
               'apparatus_model', r.apparatus_model
             ) order by r.name)
        from public.rooms r
       where r.clinic_id = c.id
         and (
           ra.room_ids is null
           or array_length(ra.room_ids, 1) is null
           or r.id = any(ra.room_ids)
         )
    ), '[]'::jsonb)
  )
  from public.referral_access ra
  join public.clinics c on c.id = ra.clinic_id
  where ra.id = p_access_id
    and ra.referrer_id = auth.uid();   -- лише власний звʼязок
$$;

grant execute on function public.referral_center_card(uuid) to authenticated;
