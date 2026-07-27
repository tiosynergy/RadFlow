-- ============================================================================
-- 0124 — логін обовʼязковий для всіх ролей; радіолог входить ЛИШЕ за логіном
-- ============================================================================
-- Рішення власника:
--   * логін — обовʼязковий атрибут КОЖНОГО акаунта, глобально унікальний;
--   * усі ролі входять і логіном, і email — крім радіолога;
--   * радіолог має ВИПАДКОВУ службову адресу (rad.<hex>@radiologist.radflow.local),
--     якої не знає ні він, ні адмін, і вивести її з логіна не можна — тож
--     фактично для нього лишається тільки внутрішній вхід за логіном;
--   * наявного радіолога переводимо міграцією, справжню пошту зберігаємо як
--     контактну (щоб не втратити канал звʼязку).
--
-- Формат логіна: латиниця, цифри, крапка, дефіс, підкреслення; 3–64; без
-- крайових роздільників. Кирилиця заборонена свідомо: візуально однакові
-- латинська «a» і кирилична «а» дали б два різні акаунти, і людина не змогла б
-- пояснити по телефону, під яким саме вона входить.
--
-- Дзеркало на клієнті — lib/login.ts (той самий формат і той самий запасний
-- логін з email). Міняєш тут — міняй і там.
--
-- Порядок викатки: СПЕРШУ ця міграція, потім клієнт. Стара БД + новий клієнт
-- дали б 42703 на profiles.contact_email у картці персоналу.
-- ============================================================================

begin;

-- ── 1. Контактна пошта окремо від адреси входу ──────────────────────────────
-- profiles.email для радіолога стає СЛУЖБОВОЮ адресою. Справжню пошту треба
-- десь тримати: без неї адмін не має як написати радіологу. Для направника цю
-- роль виконує referrer_private.email (0041) — там пошта приватна й вводить її
-- сам лікар; тут пошту вводить адмін, тож тримаємо в profiles.
alter table public.profiles
  add column if not exists contact_email text;

comment on column public.profiles.contact_email is
  '0124: справжня пошта для звʼязку. НЕ для входу — вхід лише через email/логін в auth.users.';

-- ── 2. Запасний логін з email (для акаунтів повз наші форми) ────────────────
-- Дзеркалить loginFromEmail() з lib/login.ts.
create or replace function public.login_from_email(p_email text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  -- Порядок важливий: ріжемо до 64 і ЛИШЕ ПОТІМ знімаємо крайові роздільники.
  -- Навпаки — зріз лишав би «.» в кінці, і запасний логін не проходив би
  -- profiles_login_format_chk, тобто весь signUp падав би на «Database error».
  select case
           when length(cleaned) >= 3 then cleaned
           else rtrim(left('user' || cleaned, 64), '._-')
         end
  from (
    select trim(both '._-' from
             left(regexp_replace(split_part(lower(btrim(coalesce(p_email, ''))), '@', 1),
                                 '[^a-z0-9._-]+', '', 'g'), 64)) as cleaned
  ) s;
$$;

-- Вільний логін: базовий, а якщо зайнятий — з числовим суфіксом. Окремо від
-- login_from_email, бо та має лишатись immutable (читання таблиці — ні).
create or replace function public.unique_login(p_base text)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  base text := p_base;
  cand text := base;
  n    int  := 1;
begin
  while exists (select 1 from public.profiles where lower(login) = cand) loop
    n := n + 1;
    -- Суфікс може виштовхнути за 64 символи — тому підрізаємо базу, а не хвіст.
    cand := left(base, 64 - length(n::text)) || n::text;
    if n > 10000 then
      raise exception 'LOGIN_EXHAUSTED: не вдалося підібрати вільний логін від «%»', p_base;
    end if;
  end loop;
  return cand;
end;
$$;

create or replace function public.unique_login_from_email(p_email text)
returns text
language sql
volatile
security definer
set search_path = public, pg_temp
as $$ select public.unique_login(public.login_from_email(p_email)); $$;

revoke execute on function public.login_from_email(text) from public, anon, authenticated;
revoke execute on function public.unique_login(text) from public, anon, authenticated;
revoke execute on function public.unique_login_from_email(text) from public, anon, authenticated;

-- ── 3. Нормалізація наявних логінів ─────────────────────────────────────────
-- Зберігаємо в нижньому регістрі: унікальність і резолв і так по lower(), а
-- «Zast» проти «zast» у списках персоналу читається як два різні акаунти.
-- Тригер guard_profile_privileges (0064) блокує зміну login з клієнта, але не
-- від власника міграції — тут ми під owner-роллю.
update public.profiles
   set login = lower(btrim(login))
 where login is not null and login <> lower(btrim(login));

/* Бекфіл тим, у кого логіна немає (створені через Dashboard / до 0013).
   Рядок за рядком, а НЕ одним UPDATE: unique_login читає profiles і не бачить
   рядків, які цей самий оператор змінює просто зараз. Два профілі без логіна,
   чиї адреси схлопуються в одну базу (a.b@x.ua і a+b@y.ua → «ab»), отримали б
   однаковий логін, і вся міграція впала б на profiles_login_uidx. */
do $backfill$
declare r record;
begin
  for r in select id, email from public.profiles
            where login is null or btrim(login) = '' order by created_at
  loop
    update public.profiles
       set login = public.unique_login_from_email(coalesce(r.email, r.id::text || '@local'))
     where id = r.id;
  end loop;
end $backfill$;

-- ── 4. Формат і обовʼязковість ──────────────────────────────────────────────
do $$
declare bad int;
begin
  select count(*) into bad from public.profiles
   where login !~ '^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$';
  if bad > 0 then
    -- Краще впасти тут, ніж лишити CHECK not valid і дізнатись про це через
    -- місяць на першому ж UPDATE чужого рядка.
    raise exception 'LOGIN_FORMAT: % профіл(ів) не відповідають формату логіна', bad;
  end if;
end $$;

alter table public.profiles drop constraint if exists profiles_login_format_chk;
alter table public.profiles
  add constraint profiles_login_format_chk
  check (login ~ '^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$');

alter table public.profiles alter column login set not null;

-- ── 5. Радіолог: службова адреса замість справжньої ─────────────────────────
-- Спершу ховаємо справжню пошту в contact_email, і лише потім підміняємо
-- адресу входу — інакше при збої посередині втратили б канал звʼязку.
-- Контактну пошту беремо з auth.users, а не з profiles.email: саме auth —
-- джерело істини, а копія в profiles може бути NULL або протухлою.
update public.profiles p
   set contact_email = u.email
  from auth.users u
 where u.id = p.id
   and p.role = 'radiologist'
   and u.email is not null
   and u.email !~* '\.radflow\.local$'
   and p.contact_email is null;

-- auth.users — джерело істини для signInWithPassword. Міняємо і identity_data:
-- GoTrue тримає там копію адреси, і розсинхрон дає «привида», за яким лишається
-- можливість входу по старій пошті.
-- Адреса ВИПАДКОВА, а не <login>@radiologist.radflow.local. Похідна адреса
-- вгадується з логіна (а логін бачить кожен адмін у списку персоналу), тож
-- «вхід лише за логіном» тримався б на тому, що ніхто не здогадається піти з
-- нею повз наш роут прямо в GoTrue. І зміна логіна тоді вимагала б синхронно
-- правити auth.users.email — атомарності між Auth API і базою немає.
-- Фільтр теж по auth.users і з урахуванням NULL. Якби брали profiles.email,
-- радіолог із порожньою копією не потрапив би в вибірку: у auth лишилась би
-- справжня пошта (тобто вхід по email — ціль пакета не досягнута), а після
-- створення гарда БУДЬ-ЯКИЙ UPDATE його рядка падав би на RADIOLOGIST_EMAIL —
-- зокрема скидання пароля.
with tgt as (
  select p.id, 'rad.' || replace(gen_random_uuid()::text, '-', '') || '@radiologist.radflow.local' as new_email
    from public.profiles p
    join auth.users u on u.id = p.id
   where p.role = 'radiologist'
     and (u.email is null or u.email !~* '\.radflow\.local$')
)
update auth.users u
   set email = t.new_email,
       raw_user_meta_data = coalesce(u.raw_user_meta_data, '{}'::jsonb)
                            || jsonb_build_object('managed', 'true')
  from tgt t
 where u.id = t.id;

update auth.identities i
   set identity_data = coalesce(i.identity_data, '{}'::jsonb)
                       || jsonb_build_object('email', u.email)
  from auth.users u
  join public.profiles p on p.id = u.id
 where i.user_id = u.id
   and i.provider = 'email'
   and p.role = 'radiologist';

update public.profiles p
   set email = u.email
  from auth.users u
 where u.id = p.id
   and p.role = 'radiologist'
   and p.email is distinct from u.email;

-- Гард: у радіолога адреса входу завжди службова. Без нього наступний
-- createUser із справжньою поштою тихо поверне роль до входу по email, і
-- правило «радіолог входить лише логіном» трималося б на чесному слові коду.
create or replace function public.check_radiologist_email()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Домен саме радіологічний, а не будь-який службовий: інакше акаунт із
  -- @ceo.radflow.local проходив би гард, і «радіолог» жив би з чужою адресою.
  -- coalesce ОБОВʼЯЗКОВИЙ: при email IS NULL вираз давав би NULL, умова не була
  -- б істинною, і радіолог без адреси проходив би гард наскрізь.
  if new.role = 'radiologist' and coalesce(new.email, '') !~* '@radiologist\.radflow\.local$' then
    raise exception 'RADIOLOGIST_EMAIL: радіолог входить лише за логіном — адреса має бути службовою (@radiologist.radflow.local)';
  end if;
  return new;
end;
$$;
revoke execute on function public.check_radiologist_email() from public, anon, authenticated;

drop trigger if exists trg_radiologist_email on public.profiles;
create trigger trg_radiologist_email
  before insert or update on public.profiles
  for each row execute function public.check_radiologist_email();

-- ── 6. handle_new_user: логін тепер not null ────────────────────────────────
-- Реєстрація через Dashboard/OAuth не має metadata.login — до 0124 туди писався
-- NULL, тепер це впало б на not null і взагалі не дало створити користувача.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_clinic_id uuid;
  v_login       text;
begin
  -- Акаунти, які створює наш сервер (staff/referrer/ceo), профіль пишуть самі.
  if coalesce(new.raw_user_meta_data->>'managed','') = 'true' then
    return new;
  end if;

  -- Логін із форми реєстрації. Якщо його немає (Dashboard/OAuth) або він не
  -- проходить формат — беремо з email. Якщо зайнятий — додаємо суфікс ДО НЬОГО,
  -- а не підставляємо чужий рядок з пошти: людина шукатиме те, що вводила.
  v_login := lower(btrim(coalesce(new.raw_user_meta_data->>'login', '')));
  if v_login = '' or v_login !~ '^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$' then
    v_login := public.unique_login_from_email(new.email);
  else
    v_login := public.unique_login(v_login);
  end if;

  insert into public.clinics (name)
  values (coalesce(nullif(new.raw_user_meta_data->>'clinic_name',''), v_login, 'Моя клініка'))
  returning id into new_clinic_id;

  insert into public.profiles (id, clinic_id, login, full_name, email, phone, role, approved, password_set)
  values (new.id, new_clinic_id, v_login,
          coalesce(nullif(new.raw_user_meta_data->>'full_name',''), v_login),
          new.email, nullif(new.raw_user_meta_data->>'phone',''),
          'admin', true, true);

  return new;
end;
$$;

-- ── 7. Прибирання мертвого дубля ────────────────────────────────────────────
-- email_for_login (0013) — попередниця resolve_login_email. Права відкликано ще
-- в 0032 (енумерація email), але сама функція лишилась: security definer із
-- search_path без pg_temp. Мертвий код із правами definer — зайва поверхня.
drop function if exists public.email_for_login(text);

/* Резолв логін→email тепер читає auth.users, а не profiles.email.

   До 0124 обидва поля писалися одним і тим самим кодом і не могли розійтись.
   Тепер шляхів, що торкаються адреси, більше (створення радіолога, ця
   міграція), і будь-який розсинхрон означав би, що вхід за логіном веде на
   адресу, якої в Auth уже немає, — людина не увійде, і з інтерфейсу цього не
   видно. auth.users — єдине джерело істини для signInWithPassword, тож беремо
   адресу саме звідти, а profiles.email лишається копією для показу.
   Права ті самі: лише service_role (для клієнта це інструмент енумерації). */
create or replace function public.resolve_login_email(p_login text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.email
    from public.profiles p
    join auth.users u on u.id = p.id
   where lower(p.login) = lower(btrim(p_login))   -- бере profiles_login_uidx (0013)
   limit 1;
$$;
revoke execute on function public.resolve_login_email(text) from public, anon, authenticated;
grant  execute on function public.resolve_login_email(text) to service_role;

commit;

-- ── Нотатка про індекс ──────────────────────────────────────────────────────
-- Коментарі 0072 посилаються на profiles_login_lower_idx, але фактична назва —
-- profiles_login_uidx (0013:19). Вираз той самий, план коректний; окремо не
-- перейменовуємо, щоб не чіпати робочий унікальний індекс.
