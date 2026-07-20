-- ============================================================================
--  RadFlow — Міграція 0089: waitlist_entries.claim_token (застовплення кандидата)
--  Запускати ПІСЛЯ 0088. Даних не змінює (додає nullable-колонку).
-- ============================================================================
--
--  НАВІЩО. scheduleFromWaitlist (app/queue/actions.ts) переносить кандидата у слот
--  атомарно: CAS waiting→scheduled ПЕРЕД createBooking (тільки переможець бронює,
--  дубля пацієнта немає). Але «відкат застовплення» при невдалому бронюванні
--  (`UPDATE … status='waiting' WHERE status='scheduled'`) не розрізняв, ЧИЙ це claim.
--  Вузька гонка: A застовпив → хтось зробив restore (setWaitlistStatus→waiting, без
--  CAS) → A2 застовпив і забронював → повільний booking A падає → відкат A затирав
--  живий запис A2. Degradation був safe (не задвоєння), але бухгалтерія листа плила.
--
--  РІШЕННЯ. Транзієнтний токен застовплення: scheduleFromWaitlist генерує uuid,
--  ставить його в claim_token на CAS-застовпленні, і ГЕЙТИТЬ link/rollback по
--  `claim_token = <свій токен>`. Тож відкат/лінк чіпають ЛИШЕ власний claim; чужий
--  повторний claim (інший токен) недоторканий. Токен скидається в null при лінку,
--  відкаті та при restore (setWaitlistStatus→waiting).
--
--  Колонка nullable, без дефолта; це НЕ посилання на користувача, а разова мітка
--  операції. Клієнт її не задає (немає в allowlist sWaitlistPatch). Індекс не
--  потрібен: усі UPDATE фільтрують за PK `id` (+ status + claim_token як AND).
--  waitlist_entries має ТАБЛИЧНИЙ grant update (не поколоночний, як queue_entries),
--  тож нова колонка оновлювана під RLS без окремого grant.
-- ============================================================================

alter table public.waitlist_entries add column if not exists claim_token uuid;

comment on column public.waitlist_entries.claim_token is
  'Транзієнтний токен застовплення (scheduleFromWaitlist): щоб rollback/link чіпали лише власний claim. null у стані спокою.';

-- ============================================================================
--  ПЕРЕВІРКА ПІСЛЯ НАКАТКИ
-- ============================================================================
--  select column_name, data_type, is_nullable from information_schema.columns
--   where table_schema='public' and table_name='waitlist_entries' and column_name='claim_token';
--   -- очікуємо: claim_token | uuid | YES
-- ============================================================================
