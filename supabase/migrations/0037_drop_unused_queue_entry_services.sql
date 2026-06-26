-- ============================================================
--  RadFlow — Міграція 0037: усунення подвійного джерела істини про дослідження (MAJ-12)
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0036.
--
--  Нормалізована таблиця queue_entry_services (0001) фактично НЕ використовується:
--  застосунок читає/пише лише queue_entries.studies та studies_original (JSONB),
--  уся логіка — в lib/studies.js. Таблиця залишалася порожнім «другим джерелом»,
--  що створювало ризик рассинхрону/плутанини.
--
--  Рішення: ЄДИНЕ джерело істини про склад досліджень — queue_entries.studies
--  (поточний) + studies_original (первісний). Невикористовувану таблицю видаляємо.
--
--  Безпека: видалення блокується, якщо таблиця раптом містить рядки (на випадок
--  непередбаченого використання) — тоді міграція впаде з помилкою, а не втратить дані.
--  Ідемпотентна: якщо таблиці вже немає — нічого не робить.
-- ============================================================

do $$
declare
  n bigint;
begin
  if to_regclass('public.queue_entry_services') is null then
    raise notice 'queue_entry_services вже відсутня — нічого робити.';
    return;
  end if;

  select count(*) into n from public.queue_entry_services;
  if n > 0 then
    raise exception
      'queue_entry_services містить % рядк(ів) — видалення скасовано. Дослідіть дані перед депрекейтом.', n;
  end if;

  -- CASCADE прибере й політику qes_all, та індекс qes_entry_idx.
  drop table public.queue_entry_services cascade;
  raise notice 'queue_entry_services видалено (була порожня). Єдине джерело істини — queue_entries.studies (JSONB).';
end $$;

-- Зафіксувати домовленість у коментарях до полів-джерел.
comment on column public.queue_entries.studies is
  'ЄДИНЕ джерело істини про поточний склад досліджень запису (масив JSONB). Логіка — lib/studies.js.';
comment on column public.queue_entries.studies_original is
  'Первісний (замовлений) склад досліджень для діфу змін. Парна до studies; інших джерел немає.';
