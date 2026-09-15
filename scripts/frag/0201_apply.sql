-- 0201 APPLY — ЗГЕНЕРОВАНО `node scripts/build-0201-reprint.mjs`. Одним запитом,
-- ОДНА транзакція.
-- ⚠️ Канонічний файл міграції накатувати НЕ можна: передрук і пін там — два
--    верхньорівневі стейтменти, тобто дві транзакції; обрив між ними лишає
--    нове тіло зі СТАРИМ піном, і №25 червоніє одразу (урок 0198).
do $apply$
declare
  v_def text; v_body text; v_src text; v_head text; v_new text;
  v_hits int; v_rows int; v_res jsonb; v_pin_db text; v_bad text[]; v_rcc text;
  v_from constant text[] := array[
    $p$      ('set_waitlist_status_rpc(p_id uuid, p_status waitlist_status)','1e04ab4ebb01c08a23d1280b29465d55','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
$p$,
    $p$ЩО ПІНИМО (сьогодні 43 підписи; ключ$p$,
    $p$0193 → 40, 0200 → 43), а заголовок$p$,
    $p$  --        нікуди більше.
$p$,
    $p$  --        РІШЕННЯ ВЛАСНИКА 15.09 (стартовий промпт с74).
  v_n := v_n + 1;
$p$,
    $p$  --         роздає arwdDxtm — це поза цим сторожем і поза 0166;
$p$,
    $p$  --         service_role — false), і жодна з 23 перевірок цю привілею НЕ
  --         пасе. Для ВІДНОШЕНЬ і ТИПІВ перехід навпаки звужує: `pg_temp`
$p$,
    $p$  --           власником; чи пінити решту — окреме рішення власника, як і
$p$,
    $p$  --     До 0198 це була єдина річ у схемі, яку не тримало НІЩО:
$p$,
    $p$
  v_res := jsonb_build_object(
    'ok',      jsonb_array_length(v_fail) = 0,
$p$
  ];
  v_to   constant text[] := array[
    $p$      ('set_waitlist_status_rpc(p_id uuid, p_status waitlist_status)','1e04ab4ebb01c08a23d1280b29465d55','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('cancel_case_rpc(p_case_id uuid)','ad0a4f2c7d1e475a806c10d575f7fede','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('ceo_kpi_rooms(p_from date, p_to date, p_clinics uuid[])','dcceffc8c656b8fd1b62c2b71350b14b','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('ceo_kpi_studies(p_from date, p_to date, p_clinics uuid[])','416da7521b1c99740f6a7646ff8d526e','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('ceo_kpi_totals(p_from date, p_to date, p_clinics uuid[])','123af77cd8f5fe2a9512c12c2ff3bb7b','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('delete_clinic_member(target uuid)','6d369ff76b71637902998e275a0b7c64','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('incident_resolve_rpc(p_id uuid)','11bf2e9447c4f7226bde73b577832ba9','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('queue_apply_delay_plan_rpc(p_room uuid, p_source uuid, p_delay_min integer, p_strategy text, p_plan jsonb, p_expected jsonb, p_reason text)','c1d43e9c53e291846c7b0456d4793060','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('queue_confirm_calls_rpc(p_ids uuid[])','fa043199612d4151bd447818036fa89c','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('queue_set_call_rpc(p_id uuid, p_call call_status, p_allowed queue_status[])','45f823a84cfb8d26e21e147071744008','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('save_schedule_override(p_override_date date, p_all_closed boolean, p_label text, p_rooms jsonb, p_expected_updated_at text)','b78fbf0e96d2589d6c8ba3b50fc3a3ad','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp,DateStyle=ISO, MDY;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('search_referrers(q text)','213e5b9809aa4da3ad82644e6244a78e','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('services_import_rpc(p_rows jsonb, p_room_id uuid)','f714153329d653601a913405872ac7ad','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('create_case_rpc(p_case jsonb, p_steps jsonb)','22387332147a71748de09d74ed1d9d1b','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('queue_reschedule_rpc(p_id uuid, p_room_id uuid, p_date date, p_time text, p_duration integer, p_buffer integer, p_call call_status, p_reason text, p_off_schedule boolean, p_studies jsonb)','3382aa484125730aad7c329ca7f99ac8','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('mark_changes_seen(p_ids uuid[])','ba45fd7da3e25f018b076ed4ba95f4e8','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('referral_center_card(p_access_id uuid)','a2be8c18cb183d5d4221b3af9a62671d','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
$p$,
    $p$ЩО ПІНИМО (сьогодні 59 підписів; ключ$p$,
    $p$0193 → 40, 0200 → 43, 0201 → 59), а заголовок$p$,
    $p$  --        нікуди більше. ⚠️ Так було до 0201: для КЛІЄНТСЬКИХ ролей їх тепер
  --        тримає №26 `role_surface` (членства, атрибути, налаштування, ACL
  --        схем і бази, default ACL) — сюди, у №19, вони як і раніше не входять.
$p$,
    $p$  --        РІШЕННЯ ВЛАСНИКА 15.09 (стартовий промпт с74).
  --     ⚠️ 0201 ДОДАЛА ШІСТНАДЦЯТЬ — решту definer-функцій, доступних
  --        `authenticated` і поза списком, що НЕСУТЬ ВЛАСНИЙ ГЕЙТ. Список став
  --        59. Рішення власника Р74-1(б), 15.09
  --        (`docs/audit/DECISIONS-2026-09-15-s74.md`); пакет —
  --        `docs/audit/PR-0201-gated-rpcs-role-surface.md`.
  --        • гейт `auth_is_admin()`/`auth_is_desk()` (12): `cancel_case_rpc`,
  --          `ceo_kpi_rooms`, `ceo_kpi_studies`, `ceo_kpi_totals`,
  --          `delete_clinic_member`, `incident_resolve_rpc`,
  --          `queue_apply_delay_plan_rpc`, `queue_confirm_calls_rpc`,
  --          `queue_set_call_rpc`, `save_schedule_override`,
  --          `search_referrers`, `services_import_rpc`;
  --        • хелпери направника й радіолога (2): `create_case_rpc`,
  --          `queue_reschedule_rpc`;
  --        • лише `auth.uid()` (2): `mark_changes_seen`,
  --          `referral_center_card` — остання ЄДИНА тримає видимість картки
  --          центру направнику, і її тіло міняла 0195. ⚠️ На проді воно лежало
  --          БЕЗ коментарів файла 0195 (чернетка через execute_sql, PR-0195 §5);
  --          0201 перестворює функцію дослівно текстом 0195 і пінить ЙОГО md5 —
  --          інакше база, зібрана міграціями, червоніла б `body:` з першого дня.
  --        Вихолощений гейт у будь-якій із них — ТИХА ескалація (у своєму
  --        центрі або по чужому кейсу), бо RLS усередині SECURITY DEFINER не діє.
  --        ⚠️ ПОЗА СПИСКОМ лишаються `search_cities` і `search_clinics` (гейта
  --           за роллю в тілі немає — лише фільтр видимості довідника) та
  --           `integration_apply_status` (недоступна `authenticated`). Це межа,
  --           названа рішенням.
  --        ⚠️ ЦІНА та сама, що в абзаці 0200, тепер ще на шістнадцять функцій
  --           (разом із 0200 — девʼятнадцять):
  --           будь-яка правка цих шістнадцяти — тіло, `grant`/`revoke`,
  --           `alter function`, імʼя параметра — лише разом із передруком.
  --        ⚠️ Замір рядків 15.09: перевантажень немає; у
  --           `save_schedule_override` поле `cfg=` несе ще й
  --           `DateStyle=ISO, MDY` — це частина піна, а не шум.
  v_n := v_n + 1;
$p$,
    $p$  --         роздає arwdDxtm — це поза цим сторожем і поза 0166 (0201: USAGE
  --         схем і сам default ACL для клієнтських ролей пінить №26
  --         `role_surface`; ОБʼЄКТИ поза `public` — як і раніше, ніхто);
$p$,
    $p$  --         service_role — false), і жодна з 23 перевірок цю привілею НЕ
  --         пасе (так було до 0201: для anon, authenticated і PUBLIC її тепер
  --         пасе №26, ключ `n:public:*`; для service_role — як і раніше, ніхто).
  --         Для ВІДНОШЕНЬ і ТИПІВ перехід навпаки звужує: `pg_temp`
$p$,
    $p$  --           власником; чи пінити решту — окреме рішення власника (вирішено:
  --           0201, шістнадцять), як і
$p$,
    $p$  --     До 0198 це була єдина річ у схемі, яку не тримало НІЩО (0201: НЕ
  --     єдина — межі 1–2 аудиту 0191 теж не тримало ніщо, див. №26):
$p$,
    $p$
  -- 26. ПОВЕРХНЯ КЛІЄНТСЬКИХ РОЛЕЙ ПОЗА ПРЯМИМИ ГРАНТАМИ (0201, Р74-2(б)).
  --     `;acl=` у №19 і дайджест №22 бачать лише ПРЯМІ гранти на обʼєкти
  --     `public`. Членства, ACL схем і бази, default ACL, атрибути й
  --     налаштування ролей до 0201 не ПІНИЛА жодна перевірка (№15/№18/№22
  --     читають членство лише щоб знайти клієнтські ролі; №15(b) — лише
  --     TRUNCATE у default ACL схеми public); успадковане право бачили
  --     тільки окремі has_*_privilege-гілки №15 і №18 на названих привілеях
  --     (і `f:` №22 — лише для `anon`). Кожен обхід заміряно 15.09 зондом у
  --     відкоченій транзакції від ролі `postgres`:
  --       ПРОХОДИТЬ:
  --       • `grant <роль> to authenticated` — клієнт успадковує чужі права;
  --       • новий LOGIN-член `authenticated` — прямий SQL під клієнтською
  --         роллю сам виставляє `request.jwt.claims`, тобто стає будь-ким;
  --       • `alter role authenticated set session_replication_role = replica`
  --         (supautils це дозволяє). ⚠️ Чи застосовує PostgREST цей параметр
  --         (контекст superuser) у клієнтських сесіях — НЕ заміряно; якщо так,
  --         це вимкнення звичайних тригерів, тобто гардів №17. Пінимо в будь-
  --         якому разі;
  --       • `alter role authenticator set pgrst.db_schemas = …` — інша
  --         поверхня PostgREST;
  --       • `grant create on schema public`, `grant create on database`,
  --         `alter default privileges …` у схемі і глобально;
  --       БЛОКУЄТЬСЯ (42501): `alter role authenticated bypassrls` (reserved
  --       role, supautils); `grant set on parameter`; `alter role … set
  --       "request.jwt.claim.sub"`; `alter database … set` для
  --       session_replication_role, request.jwt.*, safeupdate.enabled.
  --
  --     Ключі (одне множинне порівняння, як у №22; `new:` / `missing:` /
  --     `changed:` з очікуваним і фактичним):
  --       m: роль:член               — членства, де хоч один бік клієнтський;
  --                                    грантор і admin/inherit/set КОЖНОГО
  --                                    гранта (PG16+ їх буває кілька на пару);
  --       r: роль                    — super/createrole/createdb/bypassrls/
  --                                    inherit/login/replication;
  --       g: роль:база|*             — налаштування ролі, КРІМ таймаутів і
  --                                    спостережуваності;
  --       n: схема:грантей           — ACL усіх схем, крім toast і тимчасових;
  --       d: власник:схема|*:тип:грантей — default ACL; для глобального рядка
  --                                    f/T без PUBLIC — синтетичне `<none>`;
  --       b: грантей                 — ACL поточної бази.
  --     Грантей — клієнтська роль або PUBLIC (grantee = 0): грант на PUBLIC
  --     дістається і anon, і authenticated, а `revoke … from anon` його не знімає.
  --     Дайджест прав — DISTINCT і з `*` за grant option: другий грантор тієї ж
  --     привілеї не червонить, а порядок детермінований (`collate "C"`).
  --     Базис 15.09: 62 ключі (m 7, r 3, g 1, n 20, d 30, b 1).
  --
  --     ⚠️ РОЛІ НЕ ХАРДКОДОМ і ТРАНЗИТИВНО: `authenticator` і замикання ролей,
  --        членом яких він є, без `service_role`. Нова клієнтська роль сама
  --        дасть `new:m:<роль>:authenticator` і `new:r:`; роль, яку клієнт
  --        успадковує через іншу, — теж (ревʼю с74: без замикання дрейф
  --        уже запіненої проміжної ролі був невидимий).
  --     ⚠️ ОБИДВА НАПРЯМКИ членства: `member` клієнтський — що клієнт
  --        УСПАДКОВУЄ; `roleid` клієнтський — хто може СТАТИ клієнтом.
  --     ⚠️ ПОЗА `g:` СВІДОМО (регулярка нижче): таймаути і
  --        спостережуваність/тюнінг зі списку supautils (log_*, track_*,
  --        pgaudit.*, auto_explain.*, pg_stat_statements.*, plan_filter.*,
  --        pg_net.*, deadlock_timeout, wal_compression). Їх законно крутять —
  --        той самий pgaudit для медичного аудиту, — а вічно червоний сторож
  --        — знятий сторож (урок 0141). ⚠️ Виключення двобічне: і ВИМКНЕННЯ
  --        (`pgaudit.log = none` на ролі) пройде мовчки — це межа. Небезпечні
  --        з того ж списку (`pgrst.*`, `safeupdate.enabled`,
  --        `session_replication_role`) лишаються в `g:`.
  --
  --     ⚠️ НАЗВАНІ МЕЖІ:
  --       • `service_role` як ГРАНТЕЙ і як вершину замикання не пінимо (канон
  --         0163): його поверхня — ротація ключа. Членство
  --         `service_role ← authenticator` пінимо, бо член клієнтський;
  --       • ДРУГИЙ ХІД «хто може стати клієнтом»: `grant
  --         supabase_storage_admin to <роль>` не дає ключа (жоден бік не
  --         клієнтський), хоча та роль може `SET ROLE authenticator`. Від
  --         `postgres` недосяжно — ADMIN на `supabase_storage_admin` у нього
  --         немає (замір 15.09);
  --       • `grant set on parameter` (`pg_parameter_acl`) — поза: від
  --         `postgres` не можна ні видати, ні відкликати, тож і фальсифікувати
  --         гілку нічим. `r:` на відміну від неї фальсифікується: нова
  --         клієнтська роль дає `new:r:`;
  --       • налаштування БАЗИ для всіх ролей (`alter database … set`) — поза:
  --         небезпечні параметри там від `postgres` заблоковано (див. вище),
  --         а USERSET (`search_path`, навіть `role`) проходить, але PostgREST
  --         ставить роль і шлях ЛОКАЛЬНО в кожному запиті, а без CREATE на схемі
  --         (`n:`) тіньових обʼєктів клієнту не створити. Там же живе
  --         `app.settings.jwt_exp`;
  --       • мови, типи, FDW-сервери, великі обʼєкти — поза;
  --       • ОБʼЄКТИ в схемах поза `public` (таблиці storage, функції graphql)
  --         — як і раніше, ніхто: тут лише право на схему і дефолти для
  --         МАЙБУТНІХ обʼєктів;
  --       • `revoke` від НЕ-грантора — тиша в самому Postgres (замір 15.09:
  --         `revoke usage on schema graphql_public from anon` від postgres не
  --         знімає гранту supabase_admin), тож і ключ не змінюється — так і
  --         мусить бути;
  --       • платформа Supabase (грантор `supabase_admin`) може змінити свої
  --         дефолти чи членства при оновленні, а ввімкнене в дашборді
  --         розширення — додати схему з USAGE для `anon`. Перевірка
  --         ПОЧЕРВОНІЄ, і це не шум, а сигнал: поверхня клієнта змінилась без
  --         міграції. Порядок той самий, що для №22, — розібратись і
  --         передрукувати;
  --       • як і №25, ловить ДРЕЙФ, а не зловмисника з правами postgres.
  v_n := v_n + 1;
  /* 0174 */ begin
  v_tmp := null;
  with recursive cr(oid) as (
    -- клієнтські ролі: `authenticator` і ТРАНЗИТИВНО всі ролі, членом яких він
    -- є (ким може стати і що успадковує), крім `service_role`; хардкоду імен
    -- немає. Сьогодні це рівно anon, authenticated, authenticator.
    select r.oid
      from pg_roles r
     where r.rolname = 'authenticator'
    union
    select m.roleid
      from pg_auth_members m
      join cr on cr.oid = m.member
      join pg_roles g on g.oid = m.roleid
     where g.rolname <> 'service_role'
  ), cur as (
    -- m: членство, де ХОЧ ОДИН бік клієнтський; PG16+ дає кілька грантів на
    --    пару — тому агрегат, а не рядок
    select 'm:' || pg_get_userbyid(m.roleid) || ':' || pg_get_userbyid(m.member) as key,
           string_agg('grantor=' || pg_get_userbyid(m.grantor)
                      || ',admin=' || m.admin_option::text
                      || ',inherit=' || m.inherit_option::text
                      || ',set=' || m.set_option::text,
                      '|' order by pg_get_userbyid(m.grantor) collate "C") as dig
      from pg_auth_members m
     where m.roleid in (select oid from cr) or m.member in (select oid from cr)
     group by m.roleid, m.member
    union all
    -- r: атрибути самої ролі
    select 'r:' || r.rolname,
           'super=' || r.rolsuper::text || ',createrole=' || r.rolcreaterole::text
           || ',createdb=' || r.rolcreatedb::text || ',bypassrls=' || r.rolbypassrls::text
           || ',inherit=' || r.rolinherit::text || ',login=' || r.rolcanlogin::text
           || ',replication=' || r.rolreplication::text
      from pg_roles r
     where r.oid in (select oid from cr)
    union all
    -- g: налаштування ролі (у будь-якій базі), КРІМ таймаутів і спостережуваності
    select 'g:' || pg_get_userbyid(s.setrole) || ':'
           || coalesce((select quote_ident(d.datname) from pg_database d where d.oid = s.setdatabase), '*'),
           string_agg(c.cfg, '|' order by c.cfg collate "C")
      from pg_db_role_setting s
      cross join lateral unnest(s.setconfig) c(cfg)
     where s.setrole in (select oid from cr)
       and split_part(c.cfg, '=', 1) !~* '^(statement_timeout|lock_timeout|idle_in_transaction_session_timeout|idle_session_timeout|transaction_timeout|deadlock_timeout|wal_compression|log_[a-z_]+|track_[a-z_]+|(pgaudit|auto_explain|pg_stat_statements|plan_filter|pg_net)[.][a-z0-9_.]+)$'
     group by s.setrole, s.setdatabase
    union all
    -- n: ACL КОЖНОЇ схеми (крім тимчасових і toast) для клієнта або PUBLIC
    select 'n:' || n.nspname || ':' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
           string_agg(distinct v.pv collate "C", ',' order by v.pv collate "C")
      from pg_namespace n
      cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n'::"char", n.nspowner))) a
      cross join lateral (select a.privilege_type || case when a.is_grantable then '*' else '' end as pv) v
     where n.nspname !~ '^pg_(toast|temp_|toast_temp_)'
       and (a.grantee = 0 or a.grantee in (select oid from cr))
     group by n.nspname, a.grantee
    union all
    -- d: default ACL, і в схемі, і глобальний (`defaclnamespace = 0` → `*`);
    --    імʼя схеми — сире, як у n: (regnamespace::text залежить від
    --    quote_all_identifiers сесії)
    select 'd:' || pg_get_userbyid(d.defaclrole) || ':'
           || case when d.defaclnamespace = 0 then '*'
                   else coalesce((select dn.nspname::text from pg_namespace dn where dn.oid = d.defaclnamespace), '?') end
           || ':' || d.defaclobjtype::text || ':'
           || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
           string_agg(distinct v.pv collate "C", ',' order by v.pv collate "C")
      from pg_default_acl d
      cross join lateral aclexplode(d.defaclacl) a
      cross join lateral (select a.privilege_type || case when a.is_grantable then '*' else '' end as pv) v
     where a.grantee = 0 or a.grantee in (select oid from cr)
     group by d.defaclrole, d.defaclnamespace, d.defaclobjtype, a.grantee
    union all
    -- d: СИНТЕТИЧНИЙ ключ — глобальний default ACL для f/T БЕЗ PUBLIC. Вбудований
    --    дефолт цих типів дає PUBLIC право, тож такий рядок — ОБМЕЖЕННЯ. Його
    --    зняття видаляє рядок (ACL знову дорівнює вбудованому) і мусить дати
    --    `missing:`, а не тишу.
    select 'd:' || pg_get_userbyid(d.defaclrole) || ':*:' || d.defaclobjtype::text || ':PUBLIC', '<none>'
      from pg_default_acl d
     where d.defaclnamespace = 0
       and d.defaclobjtype in ('f', 'T')
       and not exists (select 1 from aclexplode(d.defaclacl) x where x.grantee = 0)
    union all
    -- b: ACL поточної бази (CREATE тут = право створювати схеми)
    select 'b:' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
           string_agg(distinct v.pv collate "C", ',' order by v.pv collate "C")
      from pg_database db
      cross join lateral aclexplode(coalesce(db.datacl, acldefault('d'::"char", db.datdba))) a
      cross join lateral (select a.privilege_type || case when a.is_grantable then '*' else '' end as pv) v
     where db.datname = current_database()
       and (a.grantee = 0 or a.grantee in (select oid from cr))
     group by a.grantee
  ), expd(key, dig) as (values
      ('b:PUBLIC','CONNECT,TEMPORARY'),
      ('d:postgres:public:S:anon','SELECT,UPDATE,USAGE'),
      ('d:postgres:public:S:authenticated','SELECT,UPDATE,USAGE'),
      ('d:postgres:public:f:anon','EXECUTE'),
      ('d:postgres:public:f:authenticated','EXECUTE'),
      ('d:postgres:public:r:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('d:postgres:public:r:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('d:postgres:storage:S:anon','SELECT,UPDATE,USAGE'),
      ('d:postgres:storage:S:authenticated','SELECT,UPDATE,USAGE'),
      ('d:postgres:storage:f:anon','EXECUTE'),
      ('d:postgres:storage:f:authenticated','EXECUTE'),
      ('d:postgres:storage:r:anon','DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('d:postgres:storage:r:authenticated','DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('d:supabase_admin:graphql:S:anon','SELECT,UPDATE,USAGE'),
      ('d:supabase_admin:graphql:S:authenticated','SELECT,UPDATE,USAGE'),
      ('d:supabase_admin:graphql:f:anon','EXECUTE'),
      ('d:supabase_admin:graphql:f:authenticated','EXECUTE'),
      ('d:supabase_admin:graphql:r:anon','DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('d:supabase_admin:graphql:r:authenticated','DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('d:supabase_admin:graphql_public:S:anon','SELECT,UPDATE,USAGE'),
      ('d:supabase_admin:graphql_public:S:authenticated','SELECT,UPDATE,USAGE'),
      ('d:supabase_admin:graphql_public:f:anon','EXECUTE'),
      ('d:supabase_admin:graphql_public:f:authenticated','EXECUTE'),
      ('d:supabase_admin:graphql_public:r:anon','DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('d:supabase_admin:graphql_public:r:authenticated','DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('d:supabase_admin:public:S:anon','SELECT,UPDATE,USAGE'),
      ('d:supabase_admin:public:S:authenticated','SELECT,UPDATE,USAGE'),
      ('d:supabase_admin:public:f:anon','EXECUTE'),
      ('d:supabase_admin:public:f:authenticated','EXECUTE'),
      ('d:supabase_admin:public:r:anon','DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('d:supabase_admin:public:r:authenticated','DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('g:authenticator:*','session_preload_libraries=supautils, safeupdate'),
      ('m:anon:authenticator','grantor=supabase_admin,admin=false,inherit=false,set=true'),
      ('m:anon:postgres','grantor=supabase_admin,admin=true,inherit=true,set=true'),
      ('m:authenticated:authenticator','grantor=supabase_admin,admin=false,inherit=false,set=true'),
      ('m:authenticated:postgres','grantor=supabase_admin,admin=true,inherit=true,set=true'),
      ('m:authenticator:postgres','grantor=supabase_admin,admin=true,inherit=true,set=true'),
      ('m:authenticator:supabase_storage_admin','grantor=supabase_admin,admin=false,inherit=false,set=true'),
      ('m:service_role:authenticator','grantor=supabase_admin,admin=false,inherit=false,set=true'),
      ('n:auth:anon','USAGE'),
      ('n:auth:authenticated','USAGE'),
      ('n:extensions:anon','USAGE'),
      ('n:extensions:authenticated','USAGE'),
      ('n:graphql:anon','USAGE'),
      ('n:graphql:authenticated','USAGE'),
      ('n:graphql_public:anon','USAGE'),
      ('n:graphql_public:authenticated','USAGE'),
      ('n:information_schema:PUBLIC','USAGE'),
      ('n:net:PUBLIC','USAGE'),
      ('n:net:anon','USAGE'),
      ('n:net:authenticated','USAGE'),
      ('n:pg_catalog:PUBLIC','USAGE'),
      ('n:public:PUBLIC','USAGE'),
      ('n:public:anon','USAGE'),
      ('n:public:authenticated','USAGE'),
      ('n:realtime:anon','USAGE'),
      ('n:realtime:authenticated','USAGE'),
      ('n:storage:anon','USAGE'),
      ('n:storage:authenticated','USAGE'),
      ('r:anon','super=false,createrole=false,createdb=false,bypassrls=false,inherit=true,login=false,replication=false'),
      ('r:authenticated','super=false,createrole=false,createdb=false,bypassrls=false,inherit=true,login=false,replication=false'),
      ('r:authenticator','super=false,createrole=false,createdb=false,bypassrls=false,inherit=false,login=true,replication=false')
  )
  select array_agg(x.what order by x.what) into v_tmp
  from (
    select 'changed:' || c.key || ':' || e.dig || '->' || c.dig as what
      from cur c join expd e on e.key = c.key
     where c.dig is distinct from e.dig
    union all
    select 'new:' || c.key || '->' || coalesce(c.dig, '<null>')
      from cur c
     where not exists (select 1 from expd e where e.key = c.key)
    union all
    select 'missing:' || e.key
      from expd e
     where not exists (select 1 from cur c where c.key = e.key)
  ) x;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'role_surface', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'role_surface', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  v_res := jsonb_build_object(
    'ok',      jsonb_array_length(v_fail) = 0,
$p$
  ];
  v_lbl  constant text[] := array[
    $p$16 рядків у список №19 після set_waitlist_status_rpc$p$,
    $p$лічильник у заголовку прози №19: 43 -> 59$p$,
    $p$історія росту списку в прозі №19: + 0201 → 59$p$,
    $p$межа 0191 «не входять нікуди більше» — тепер №26$p$,
    $p$абзац 0201 у прозі №19 перед кроком лічильника$p$,
    $p$межа №22 «лише public» — дефолти й USAGE тепер у №26$p$,
    $p$проза №2: CREATE на public тепер пасе №26$p$,
    $p$абзац 0200: «окреме рішення» — вирішено в 0201$p$,
    $p$проза №25: «єдина річ» — не єдина$p$,
    $p$вставка перевірки №26 перед збіркою v_res$p$
  ];
begin
  perform set_config('lock_timeout', '5s', true);
  -- Шлях фіксуємо явно: інакше читання pg_proc залежало б від налаштування
  -- ролі оператора (урок 0196).
  perform set_config('search_path', 'public, pg_temp', true);
  if current_user <> 'postgres' then
    raise exception '0201: мусить іти від ролі postgres, а йде від %', current_user;
  end if;
  if exists (select 1 from public.migration_ledger where name = '0201_pin_gated_rpcs_role_surface.sql') then
    raise exception '0201: рядок уже в леджері — повторний накат заборонено';
  end if;
  if not exists (select 1 from public.migration_ledger where name = '0200_pin_desk_and_waitlist_rpcs.sql') then
    raise exception '0201: у леджері немає 0200 — накат не в свою чергу';
  end if;
  if (select max(name) from public.migration_ledger) is distinct from
     '0200_pin_desk_and_waitlist_rpcs.sql' then
    raise exception '0201: останній рядок леджера % — не 0200, черга зсунулась',
      (select max(name) from public.migration_ledger);
  end if;
  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_body is null then
    raise exception '0201: invariants_check не знайдено';
  end if;
  v_src := replace(v_body, chr(13), '');
  if md5(v_src) is distinct from '00146b182c9a366094678ccdb10f35aa' or length(v_src) <> 140268 then
    raise exception '0201: у проді не 0200 (% / %) — правка наосліп заборонена', md5(v_src), length(v_src);
  end if;
  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);
  -- ⚠️ САМОПІН №25 мусить збігатися з тілом ДО правки. Якщо ні — на проді
  --    вже дрейф, і чинити його цим пакетом не можна.
  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc')
     is distinct from 'guard_body_md5=00146b182c9a366094678ccdb10f35aa;len=140268' then
    raise exception '0201: самопін % не збігається з тілом 0200 — спершу розібратись',
      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');
  end if;

  -- ── Паритет referral_center_card з файлом 0195 (розділ 2-біс генератора) ──
  --    На проді тіло лежить без коментарів (0fcc…); перестворюємо ДОСЛІВНО
  --    текстом 0195 і читаємо назад. Будь-яке інше тіло на проді — стоп.
  select md5(btrim(regexp_replace(
           p.prosrc || coalesce(pg_get_function_sqlbody(p.oid)::text, ''),
           '\s+', ' ', 'g'))) into v_rcc
    from pg_proc p
   where p.oid = to_regprocedure('public.referral_center_card(uuid)');
  if v_rcc is distinct from '0fcc204d27444abb26f7d3a90cffc91f' then
    raise exception '0201: тіло referral_center_card на проді % — не заміряне 15.09 (0fcc204d27444abb26f7d3a90cffc91f), паритет наосліп заборонено', coalesce(v_rcc, '(немає функції)');
  end if;
  execute $rcc$create or replace function public.referral_center_card(p_access_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'clinic_id', c.id,
    'name',      c.name,
    'city',      c.city,
    'status',    ra.status,
    'policy',    ra.policy,
    'note',      ra.note,
    -- 0195: ОДИН контакт, ПІБ і телефон. Email — логін у продукті, назовні
    -- не віддаємо (рішення власника 14.09).
    'admins', case when ra.status in ('active', 'pending_referrer') then coalesce((
      select jsonb_agg(jsonb_build_object(
               'full_name', a.full_name,
               'phone',     a.phone
             ))
        from (select p.full_name, p.phone
                from public.profiles p
               where p.clinic_id = c.id and p.role = 'admin'
               order by p.created_at
               limit 1) a
    ), '[]'::jsonb) else '[]'::jsonb end,
    -- Авторизоване обладнання: room_ids IS NULL ⇔ усі кабінети центру.
    -- 0137: порожній масив = жодного кабінету (fail-closed).
    'rooms', case when ra.status in ('active', 'pending_referrer') then coalesce((
      select jsonb_agg(jsonb_build_object(
               'id',              r.id,
               'name',            r.name,
               'modality',        r.modality,
               'apparatus_model', r.apparatus_model
             ) order by r.name)
        from public.rooms r
       where r.clinic_id = c.id
         and (ra.room_ids is null or r.id = any(ra.room_ids))
    ), '[]'::jsonb) else '[]'::jsonb end
  )
  from public.referral_access ra
  join public.clinics c on c.id = ra.clinic_id
  where ra.id = p_access_id
    and ra.referrer_id = auth.uid();   -- лише власний звʼязок
$$
$rcc$;
  select md5(btrim(regexp_replace(
           p.prosrc || coalesce(pg_get_function_sqlbody(p.oid)::text, ''),
           '\s+', ' ', 'g'))) into v_rcc
    from pg_proc p
   where p.oid = to_regprocedure('public.referral_center_card(uuid)');
  if v_rcc is distinct from 'a2be8c18cb183d5d4221b3af9a62671d' then
    raise exception '0201: після перестворення тіло referral_center_card % замість a2be8c18cb183d5d4221b3af9a62671d', v_rcc;
  end if;

  -- ── Живі рядки шістнадцяти функцій — ТИМ САМИМ виразом `cur`, вирізаним ──
  --    генератором із тіла сторожа. Генератор БД не бачить, рядки зняті
  --    заміром 15.09; `grant` чи правка тіла між заміром і накатом зупиняють
  --    накат ТУТ, а не кладуть червоного сторожа.
  select count(*) into v_hits
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('cancel_case_rpc', 'ceo_kpi_rooms', 'ceo_kpi_studies', 'ceo_kpi_totals', 'delete_clinic_member', 'incident_resolve_rpc', 'queue_apply_delay_plan_rpc', 'queue_confirm_calls_rpc', 'queue_set_call_rpc', 'save_schedule_override', 'search_referrers', 'services_import_rpc', 'create_case_rpc', 'queue_reschedule_rpc', 'mark_changes_seen', 'referral_center_card');
  if v_hits <> 16 then
    raise exception '0201: обʼєктів із шістнадцятьма іменами % замість 16 — перевантаження дало б extra: одразу після накату', v_hits;
  end if;
  with expd(fn, body, attrs) as (values
      ('cancel_case_rpc(p_case_id uuid)','ad0a4f2c7d1e475a806c10d575f7fede','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('ceo_kpi_rooms(p_from date, p_to date, p_clinics uuid[])','dcceffc8c656b8fd1b62c2b71350b14b','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('ceo_kpi_studies(p_from date, p_to date, p_clinics uuid[])','416da7521b1c99740f6a7646ff8d526e','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('ceo_kpi_totals(p_from date, p_to date, p_clinics uuid[])','123af77cd8f5fe2a9512c12c2ff3bb7b','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('delete_clinic_member(target uuid)','6d369ff76b71637902998e275a0b7c64','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('incident_resolve_rpc(p_id uuid)','11bf2e9447c4f7226bde73b577832ba9','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('queue_apply_delay_plan_rpc(p_room uuid, p_source uuid, p_delay_min integer, p_strategy text, p_plan jsonb, p_expected jsonb, p_reason text)','c1d43e9c53e291846c7b0456d4793060','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('queue_confirm_calls_rpc(p_ids uuid[])','fa043199612d4151bd447818036fa89c','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('queue_set_call_rpc(p_id uuid, p_call call_status, p_allowed queue_status[])','45f823a84cfb8d26e21e147071744008','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('save_schedule_override(p_override_date date, p_all_closed boolean, p_label text, p_rooms jsonb, p_expected_updated_at text)','b78fbf0e96d2589d6c8ba3b50fc3a3ad','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp,DateStyle=ISO, MDY;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('search_referrers(q text)','213e5b9809aa4da3ad82644e6244a78e','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('services_import_rpc(p_rows jsonb, p_room_id uuid)','f714153329d653601a913405872ac7ad','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('create_case_rpc(p_case jsonb, p_steps jsonb)','22387332147a71748de09d74ed1d9d1b','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('queue_reschedule_rpc(p_id uuid, p_room_id uuid, p_date date, p_time text, p_duration integer, p_buffer integer, p_call call_status, p_reason text, p_off_schedule boolean, p_studies jsonb)','3382aa484125730aad7c329ca7f99ac8','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('mark_changes_seen(p_ids uuid[])','ba45fd7da3e25f018b076ed4ba95f4e8','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('referral_center_card(p_access_id uuid)','a2be8c18cb183d5d4221b3af9a62671d','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres')
    ), cur as (
      select p.proname::text || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn,
             md5(btrim(regexp_replace(
                   p.prosrc || coalesce(pg_get_function_sqlbody(p.oid)::text, ''),
                   '\s+', ' ', 'g'))) as body,
             'secdef=' || p.prosecdef::text
               || ';vol='   || p.provolatile::text
               || ';owner=' || pg_get_userbyid(p.proowner)
               || ';lang='  || l.lanname::text
               || ';cfg='   || coalesce(array_to_string(p.proconfig, ','), '')
               || ';acl='   || case when p.proacl is null then '<default>'
                                    else coalesce((select string_agg(t, ',' order by t collate "C")
                                                     from unnest(p.proacl::text[]) t), '<empty>') end as attrs
        from pg_proc p
        join pg_language l on l.oid = p.prolang
       where p.pronamespace = 'public'::regnamespace
         and p.prokind = 'f'
         and p.proname = any (select split_part(e.fn, '(', 1) from expd e)
    )
  select array_agg(x.txt order by x.txt) into v_bad
    from (
      select 'missing:' || e.fn as txt from expd e
       where not exists (select 1 from cur c where c.fn = e.fn)
      union all
      select 'body:' || e.fn || '->' || c.body from expd e join cur c on c.fn = e.fn
       where c.body <> e.body
      union all
      select 'attrs:' || e.fn || '->' || c.attrs from expd e join cur c on c.fn = e.fn
       where c.attrs <> e.attrs
      union all
      select 'extra:' || c.fn from cur c
       where not exists (select 1 from expd e where e.fn = c.fn)
    ) x;
  if v_bad is not null then
    raise exception '0201: живі рядки №19 не збіглися з піном — перезняти замір, а не накатувати: %', v_bad;
  end if;

  -- ⚠️ Живої звірки №26 тут НЕМАЄ свідомо: текст Q26 (≈8 КБ) подвоїв би вагу
  --    фрагмента, який оператор несе в SQL-клієнт руками. Її роль виконують
  --    сухий прогін (кличе САМ сторож і вимагає зелену `role_surface` на
  --    новому тілі — хвилини до накату) і окремий `invariants_check` після
  --    накату (крок 3). Передумова фальсифікації звіряє Q26 явно.

  -- ── Передрук сторожа: + 16 рядків №19, + перевірка №26, + проза ─────────
  v_new := v_src;
  for i in 1 .. array_length(v_from, 1) loop
    v_hits := (length(v_new) - length(replace(v_new, v_from[i], ''))) / length(v_from[i]);
    if v_hits <> 1 then
      raise exception '0201: якір «%» трапляється % раз(ів), а треба 1', v_lbl[i], v_hits;
    end if;
    v_new := replace(v_new, v_from[i], v_to[i]);
  end loop;
  if md5(v_new) is distinct from 'f0134c6203dacab659fd85648c5e9aa9' or length(v_new) <> 164374 then
    raise exception '0201: підстановка дала % / %, а файл 0201 це f0134c6203dacab659fd85648c5e9aa9 / 164374',
      md5(v_new), length(v_new);
  end if;
  execute v_head || v_new || '$function$';

  select replace(p.prosrc, chr(13), '') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if md5(v_src) is distinct from 'f0134c6203dacab659fd85648c5e9aa9' or length(v_src) <> 164374 then
    raise exception '0201: у БД лягло % / % замість f0134c6203dacab659fd85648c5e9aa9 / 164374', md5(v_src), length(v_src);
  end if;

  -- ── Самопін №25 — у ТІЙ САМІЙ транзакції, інакше сторож червоніє ────────
  -- ⚠️ Пін БЕРЕТЬСЯ З БД і лише потім звіряється з тим, що порахував
  --    генератор: `length()` у Postgres рахує СИМВОЛИ, `.length` у JS —
  --    одиниці UTF-16. Розбіжність ЗУПИНЯЄ накат (урок 0198).
  v_pin_db := 'guard_body_md5=' || md5(v_src) || ';len=' || length(v_src);
  if v_pin_db is distinct from 'guard_body_md5=f0134c6203dacab659fd85648c5e9aa9;len=164374' then
    raise exception '0201: пін із БД (%) розійшовся з піном із файлу (guard_body_md5=f0134c6203dacab659fd85648c5e9aa9;len=164374)', v_pin_db;
  end if;
  execute format('comment on function public.invariants_check(boolean) is %L', v_pin_db);
  -- Читання НАЗАД: `comment on` мовчазний, «виконалось» — не доказ.
  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc') is distinct from v_pin_db then
    raise exception '0201: пін не ліг — у коментарі %',
      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');
  end if;

  -- ⚠️ БЕЗ `on conflict do nothing` (ревʼю с74, лінза А): рядок, вставлений
  --    паралельною сесією між перевіркою і вставкою, мусить ВАЛИТИ накат.
  insert into public.migration_ledger (name)
  values ('0201_pin_gated_rpcs_role_surface.sql');
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception '0201: рядок леджера не ліг (% рядків)', v_rows;
  end if;

  raise notice 'APPLY_0201_OK guard=% len=% pin=% ledger=%',
    md5(v_src), length(v_src), v_pin_db, (select count(*) from public.migration_ledger);
end;
$apply$;

-- Читання назад: очікування
--   guard_md5 = f0134c6203dacab659fd85648c5e9aa9, guard_len = 164374,
--   guard_pin = guard_body_md5=f0134c6203dacab659fd85648c5e9aa9;len=164374, ledger_rows = 201, ledger_last = 0201_pin_gated_rpcs_role_surface.sql
select md5(replace(p.prosrc, chr(13), '')) as guard_md5,
       length(replace(p.prosrc, chr(13), '')) as guard_len,
       obj_description(p.oid, 'pg_proc') as guard_pin,
       (select count(*) from public.migration_ledger) as ledger_rows,
       (select max(name) from public.migration_ledger) as ledger_last
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'invariants_check'
   and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';

-- ⚠️ `invariants_check` — ОКРЕМИМ запитом ПІСЛЯ commit (≈9–15 с). Не поруч з
--    іншим деплоєм чи DDL. І не в 03:45–04:05 UTC: там крон `invariants` пише
--    результат із `ledger_md5` червоною, доки `npm run db:gate` не проштампував рядок.
--      select public.invariants_check(false);
--      -- очікування: checked 26; до `npm run db:gate` єдиний ОЧІКУВАНИЙ
--      -- порушник — `ledger_md5` (md5 файла ще не проштамповано).
