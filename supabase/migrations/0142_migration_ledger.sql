-- ---------------------------------------------------------------------------
--  RadFlow — Міграція 0142
--  RF-05: журнал накатаних міграцій (migration ledger) + основа деплой-гейту.
--
--  Максимальний ЗАСТОСОВАНИЙ на момент написання — 0141.
--  ⚠️ Накатувати ЛИШЕ ПІСЛЯ 0141 (бекфіл нижче включає її імʼя).
-- ---------------------------------------------------------------------------
--
--  === Навіщо ===
--
--  Міграції накатуються ВРУЧНУ в SQL Editor, dev і prod — одна БД. До 0142
--  жодного механічного звʼязку «файл на диску ↔ накатано в БД» не існувало:
--  правило «номер = max ЗАСТОСОВАНИЙ + 1» трималось на памʼяті людей і
--  хендофф-нотатках. Ризики: файл є, а накату не було (клієнт новіший за
--  схему); файл перейменували/відредагували після накату; деплой клієнта,
--  що потребує ще не накатаної міграції.
--
--  === Що зʼявляється ===
--
--  1. Таблиця public.migration_ledger: name (PK), applied_at, md5, notes.
--     RLS увімкнено БЕЗ політик (deny-all, як rate_limits/event_outbox) +
--     revoke прав у anon/authenticated: читає/пише лише service_role
--     (гейт-скрипт) і роль postgres (SQL Editor).
--  2. Бекфіл: імена всіх 142 накатаних міграцій (0001–0142; *_PRECHECK.sql —
--     не міграції, в леджер не входять). md5 навмисно NULL: його проставить
--     перший прогін гейта З РЕАЛЬНОГО ДИСКА власника (container-копія могла б
--     збрехати). applied_at = момент бекфілу з поміткою в notes — історичні
--     дати накатів не відновлюються, і це чесніше за вигадані.
--  3. КАНОН з 0143: КОЖНА нова міграція реєструє сама себе ОСТАННІМ
--     statement-ом перед commit:
--         insert into public.migration_ledger (name)
--         values ('0143_назва.sql') on conflict (name) do nothing;
--     (md5 знову проставить гейт). Забутий футер зловить гейт — файл на
--     диску без рядка в леджері валить збірку.
--
--  Гейт-скрипт (scripts/migration-gate.mjs, іде в цьому ж пакеті) звіряє
--  диск ↔ леджер: файл без запису = НЕ НАКАТАНО (fail), запис без файла =
--  перейменування/втрата (fail), md5 розійшовся = файл правили після накату
--  (fail), md5 null = перший прогін (проштампувати). Вбудований у npm run
--  build із мʼяким пропуском без env-ключів (локальна збірка без секретів).
--
--  Права: ніяких DEFINER-функцій і тригерів — панель 0122/0140 не
--  відкривається; таблиця не в realtime-публікації; PII немає (імена файлів).

begin;

set local lock_timeout = '3s';

-- ============================================================================
-- 0. Передумова: 0141 ВЖЕ накатано (механічно, не «за памʼяттю» — інакше
--    перший же рядок журналу «файл ↔ накатано» ручався б за неправду)
-- ============================================================================
do $$
begin
  if to_regprocedure('public.cleanup_orphan_clinic()') is null then
    raise exception '0142: спершу накатайте 0141_orphan_clinic_cleanup.sql (бекфіл нижче включає її імʼя)';
  end if;
end $$;

-- ============================================================================
-- 1. Таблиця
-- ============================================================================
create table if not exists public.migration_ledger (
  name       text primary key,
  applied_at timestamptz not null default now(),
  md5        text,
  notes      text
);

comment on table public.migration_ledger is
  'RF-05: журнал накатаних міграцій. Пише міграція (self-insert) і гейт-скрипт (md5). Deny-all RLS.';

-- deny-all: RLS без політик + зняти табличні привілеї (обидва шари, канон).
-- service_role лишається з доступом (дефолтний грант Supabase + BYPASSRLS);
-- грант нижче — явний, щоб не триматись на неявному дефолті.
alter table public.migration_ledger enable row level security;
revoke all on table public.migration_ledger from public, anon, authenticated;
grant select, insert, update on table public.migration_ledger to service_role;

-- ============================================================================
-- 2. Бекфіл: усе, що застосовано станом на 0142 (md5 проставить гейт)
-- ============================================================================
insert into public.migration_ledger (name, notes) 
select v.name, 'бекфіл 0142 (applied_at = момент бекфілу, не історична дата накату)'
from (values
  ('0001_init.sql'),
  ('0002_setup.sql'),
  ('0003_queue.sql'),
  ('0004_incidents.sql'),
  ('0005_schedule.sql'),
  ('0006_doctors_cito.sql'),
  ('0007_call_note.sql'),
  ('0008_radiologist.sql'),
  ('0009_radiologists.sql'),
  ('0010_delete_radiologist.sql'),
  ('0011_referrers.sql'),
  ('0012_created_by.sql'),
  ('0013_staff_accounts.sql'),
  ('0014_no_double_booking.sql'),
  ('0015_not_held_status.sql'),
  ('0016_overlap_not_held.sql'),
  ('0017_one_active_incident.sql'),
  ('0018_one_in_progress_per_room.sql'),
  ('0019_in_progress_at.sql'),
  ('0020_no_booking_during_incident.sql'),
  ('0021_incident_auto_unblock.sql'),
  ('0022_realtime_replica_identity.sql'),
  ('0023_referrer_global.sql'),
  ('0024_referrer_rls.sql'),
  ('0025_referrer_rpc.sql'),
  ('0026_migrate_existing_referrers.sql'),
  ('0027_referral_modalities.sql'),
  ('0028_referral_access_realtime.sql'),
  ('0029_referral_rooms.sql'),
  ('0030_studies_original.sql'),
  ('0031_realtime_doctors_and_indexes.sql'),
  ('0032_invite_tokens_and_login_security.sql'),
  ('0033_rate_limits.sql'),
  ('0034_status_check_and_scheduled_at.sql'),
  ('0035_walltime.sql'),
  ('0036_referrer_link_and_guard.sql'),
  ('0037_drop_unused_queue_entry_services.sql'),
  ('0038_referral_center_card.sql'),
  ('0039_search_referrers.sql'),
  ('0040_ceo_global.sql'),
  ('0041_referrer_private_email.sql'),
  ('0042_cities.sql'),
  ('0043_referrer_city.sql'),
  ('0044_ceo_list_rpc.sql'),
  ('0045_buffer_time.sql'),
  ('0046_patient_priority.sql'),
  ('0047_waitlist.sql'),
  ('0048_referrer_status_guards.sql'),
  ('0049_reschedule_origin.sql'),
  ('0050_room_busy_slots_exclude.sql'),
  ('0051_waitlist_room.sql'),
  ('0052_studies_changed_by.sql'),
  ('0053_audit_log.sql'),
  ('0054_emergency_stop_rpc.sql'),
  ('0055_event_outbox.sql'),
  ('0056_incidents_integrity.sql'),
  ('0057_referrer_write_assigned.sql'),
  ('0058_clarify_overdue.sql'),
  ('0059_clinic_timezone.sql'),
  ('0060_in_progress_actual_occupancy.sql'),
  ('0061_referral_rooms_guard.sql'),
  ('0062_room_busy_slots_detail.sql'),
  ('0063_no_past_slots.sql'),
  ('0064_integrity_hardening.sql'),
  ('0065_incident_wall_time.sql'),
  ('0066_incident_rpc_and_duration_check.sql'),
  ('0067_no_booking_during_break.sql'),
  ('0068_in_progress_extend_overlap.sql'),
  ('0069_status_transitions.sql'),
  ('0070_status_rpc_and_column_revoke.sql'),
  ('0071_ceo_kpi_rpc.sql'),
  ('0072_search_indexes_and_login_resolve.sql'),
  ('0073_role_separation_rls.sql'),
  ('0074_room_busy_cross_midnight.sql'),
  ('0075_atomic_cas_status_rpc.sql'),
  ('0076_emergency_stop_race.sql'),
  ('0077_off_schedule_override.sql'),
  ('0078_queue_delay_policy.sql'),
  ('0079_needs_reschedule_status.sql'),
  ('0080_apply_delay_plan_rpc.sql'),
  ('0081_apply_delay_plan_hardening.sql'),
  ('0082_submit_incident_race.sql'),
  ('0083_submit_incident_serialize.sql'),
  ('0084_check_room_schedule.sql'),
  ('0085_call_rpc_desk_only.sql'),
  ('0086_rooms_realtime.sql'),
  ('0087_modality_new_values.sql'),
  ('0088_studies_match_room_modality.sql'),
  ('0089_waitlist_claim_token.sql'),
  ('0090_waitlist_consistency.sql'),
  ('0091_patient_cases.sql'),
  ('0092_cancel_case_rpc.sql'),
  ('0093_create_case_rpc.sql'),
  ('0094_fix_create_case_rpc.sql'),
  ('0095_case_distinct_room.sql'),
  ('0096_case_time_overlap_trigger.sql'),
  ('0097_add_case_step_rpc.sql'),
  ('0098_case_from_entry_rpc.sql'),
  ('0099_fix_case_time_overlap_cast.sql'),
  ('0100_schedule_from_waitlist_rpc.sql'),
  ('0101_waitlist_referrer_room_guard.sql'),
  ('0102_waitlist_service_columns_lockdown.sql'),
  ('0103_room_modality_check_clinic_scope.sql'),
  ('0104_waitlist_candidates_rpc.sql'),
  ('0105_waitlist_counts_rpc.sql'),
  ('0106_case_integrity_hardening.sql'),
  ('0107_services_catalog.sql'),
  ('0108_service_room_overrides.sql'),
  ('0109_case_status_serialization.sql'),
  ('0110_fix_submit_incident_variable_conflict.sql'),
  ('0111_services_realtime_and_referrer_scope.sql'),
  ('0112_studies_active_catalog_trigger.sql'),
  ('0113_grandfather_room_guard.sql'),
  ('0114_ceo_kpi_studies_catalog_estimate.sql'),
  ('0115_services_import_rpc.sql'),
  ('0116_services_import_nullable_price.sql'),
  ('0117_services_nullable_duration.sql'),
  ('0118_referrer_cases.sql'),
  ('0119_services_import_optimistic_lock.sql'),
  ('0120_services_import_room_overrides.sql'),
  ('0121_services_room_owned.sql'),
  ('0122_reschedule_with_studies.sql'),
  ('0123_rooms_active.sql'),
  ('0124_login_required.sql'),
  ('0125_slot_grid_guard.sql'),
  ('0126_rooms_delete_history_guard.sql'),
  ('0127_ceo_kpi_studies_contrast_no_surcharge.sql'),
  ('0128_important_events.sql'),
  ('0129_actual_start_guard_and_journal_snapshot.sql'),
  ('0130_outbox_claim_lease.sql'),
  ('0131_user_change_markers.sql'),
  ('0132_change_marker_triggers.sql'),
  ('0133_change_markers_subject_date.sql'),
  ('0134_access_actor_and_ceo_audience.sql'),
  ('0135_schedule_override_cas_and_queue_room_chk.sql'),
  ('0136_radiologist_room_scope.sql'),
  ('0137_radiologist_scope_tail_and_room_ids_fail_closed.sql'),
  ('0138_schedule_override_lockdown_and_marker_audience.sql'),
  ('0139_referrer_room_scope.sql'),
  ('0140_search_path_and_anon_allowlist.sql'),
  ('0141_orphan_clinic_cleanup.sql'),
  ('0142_migration_ledger.sql')
) as v(name)
on conflict (name) do nothing;

commit;
