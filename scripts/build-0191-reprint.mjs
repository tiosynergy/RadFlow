/* Механічна збірка 0191 з 0190: блок передруку + підстановки.
   Той самий канон, що в 0190 (він збирався з 0187): жодного рядка руками. */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const MIG = ROOT + "supabase/migrations/";
const FRAG = ROOT + "scripts/frag/";

/* ⚠️ ДЖЕРЕЛО НАЗВАНЕ ЯВНО і звіряється з фактичним останнім передруком:
   ассерт на md5 стереже ФАЙЛ, але не ВИБІР файла (урок ревʼю В у 0190). */
const SOURCE = "0190_room_busy_slots_pinned.sql";
{
  const reprints = readdirSync(MIG).filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .filter((f) => /^create or replace function public\.invariants_check/m.test(readFileSync(MIG + f, "utf8")))
    .filter((f) => !f.startsWith("0191_"))
    .sort((a, b) => Number(a.slice(0, 4)) - Number(b.slice(0, 4)));
  const latest = reprints[reprints.length - 1];
  if (latest !== SOURCE) {
    throw new Error(`ЗБІРКА: останній передрук — ${latest}, а збирач читає ${SOURCE}. Оновіть SOURCE свідомо.`);
  }
}

const src = readFileSync(MIG + SOURCE, "utf8");
const nl = src.includes("\r\n") ? "\r\n" : "\n";

const START = "create or replace function public.invariants_check";
const at = src.indexOf(START);
if (at < 0) throw new Error("ЗБІРКА: передруку invariants_check у 0190 немає");
if (src.indexOf(START, at + 1) >= 0) throw new Error("ЗБІРКА: передрук двічі — якір не унікальний");
const CLOSE = nl + "$function$;";
const end = src.indexOf(CLOSE, at);
if (end < 0) throw new Error("ЗБІРКА: передрук не закритий $function$;");
let block = src.slice(at, end + CLOSE.length);

const bodyOf = (b) => {
  const open = b.indexOf("as $function$") + "as $function$".length;
  const close = b.lastIndexOf(nl + "$function$;");
  return b.slice(open, close + nl.length).replace(/\r/g, "");
};

/* ЗЕЛЕНИЙ БАЗИС: тіло з файла мусить збігтися з тим, що стоїть у проді. */
const base = bodyOf(block);
const BASE_MD5 = "9680c291c01469e19cc8f6f99fd0093f";
const BASE_LEN = 112207;
if (md5(base) !== BASE_MD5 || base.length !== BASE_LEN) {
  throw new Error(`ЗБІРКА: блок 0190 НЕ дорівнює проду — ${md5(base)} / ${base.length}, `
    + `очікували ${BASE_MD5} / ${BASE_LEN}. Міграцію не зібрано.`);
}
const count = (hay, needle) => hay.split(needle).length - 1;

/* Кожна підстановка записується в PAIRS — з них збирається накатний фрагмент
   `scripts/frag/0191_apply.sql`. Одне джерело правди: якщо файл міграції і
   накат розійдуться, розійдуться й md5, а їх звіряє сам накат. */
const PAIRS = [];
function sub(from, to, label) {
  const n = count(block, from);
  if (n !== 1) throw new Error(`ЗБІРКА: якір «${label}» трапляється ${n} раз(ів)`);
  PAIRS.push({ from, to, label });
  block = block.replace(from, to);
}

/* ===========================================================================
   ACL: три форми на всі 32 функції. Заміряно 13.09.2026 рецептом, який
   рівно збігається з виразом, що додається в `cur` нижче:
     coalesce((select string_agg(t, ',' order by t)
                 from unnest(p.proacl::text[]) t), '<default>')
   ⚠️ Провідний `=` — це PUBLIC (аклітем без грантованої ролі). Навмисно НЕ
      перейменовуємо його в `PUBLIC=`: `attrs` — механічна конкатенація
      каталогу, будь-яке причісування довелось би окремо ревʼювати.
   ⚠️ `<default>` (proacl IS NULL) означає «прав ніхто не чіпав», а для
      ФУНКЦІЇ дефолт — EXECUTE у PUBLIC. Тобто `<default>` ширший за форму C,
      і перехід C → <default> мусить червоніти. Заміряно: серед 32 функцій
      NULL-proacl зараз НЕМАЄ, тож гілка існує на майбутнє.
   =========================================================================== */
const ACL_STAFF  = "authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres";
const ACL_PUBLIC = "=X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres";
const ACL_TRIG   = "postgres=X/postgres,service_role=X/postgres";

const ACL = {
  "add_case_step_rpc(p_case_id uuid, p_step jsonb)": ACL_STAFF,
  "auth_can_see_slot_details(c uuid)": ACL_STAFF,
  "auth_clinic_id()": ACL_PUBLIC,
  "auth_is_admin()": ACL_PUBLIC,
  "auth_is_referrer()": ACL_PUBLIC,
  "auth_radiologist_room_ok(p_room uuid)": ACL_PUBLIC,
  "auth_role()": ACL_STAFF,
  "case_from_entry_rpc(p_entry_id uuid, p_step jsonb)": ACL_STAFF,
  "ceo_list_for_clinic(p_clinic uuid)": ACL_STAFF,
  "change_marker_recipients(p_clinic uuid, p_actor uuid, p_scope_kind text, p_room uuid, p_referrer uuid, p_severity text, p_room_relevant boolean)": ACL_TRIG,
  "check_case_clinic_match()": ACL_TRIG,
  "cleanup_orphan_clinic()": ACL_TRIG,
  "fn_audit()": ACL_TRIG,
  "guard_invite_issued_at()": ACL_TRIG,
  "guard_no_client_delete()": ACL_PUBLIC,
  "guard_no_client_delete_incident()": ACL_PUBLIC,
  "guard_profile_privileges()": ACL_TRIG,
  "guard_radiologist_no_write()": ACL_TRIG,
  "guard_radiologist_scope()": ACL_TRIG,
  "guard_referrer_doctor()": ACL_TRIG,
  "guard_room_in_clinic()": ACL_TRIG,
  "guard_status_change_referrer()": ACL_TRIG,
  "guard_waitlist_room()": ACL_TRIG,
  "handle_new_user()": ACL_TRIG,
  "integration_outbox_enqueue()": ACL_TRIG,
  "prune_referral_rooms_on_room_delete()": ACL_TRIG,
  "request_is_client_role()": ACL_PUBLIC,
  "room_busy_slots(p_room uuid, p_date date, p_exclude uuid)": ACL_STAFF,
  "sched_override_read(p_clinic uuid, p_date date)": ACL_STAFF,
  "validate_referral_rooms()": ACL_TRIG,
  /* ТРИ НОВИХ піни — вирішувачі направниківського доступу. */
  "auth_can_refer(c uuid)": ACL_PUBLIC,
  "auth_referrer_visible_rooms()": ACL_PUBLIC,
  "auth_referrer_clinics()": ACL_PUBLIC,
};

/* --- Підстановка 1: `cur` починає рахувати ACL ----------------------------
   Якір включає `coalesce(array_to_string(p.proconfig` — саме він робить його
   унікальним: підрядок `;cfg=` живе ще й у тридцяти літералах списку. */
const CUR_ANCHOR = "               || ';cfg='   || coalesce(array_to_string(p.proconfig, ','), '') as attrs";
/* ⚠️ `collate "C"`: без нього порядок аклітемів залежить від колації БД
      (тут en_US.UTF-8, де пунктуація на первинному рівні може ігноруватись),
      і оновлення колації інстансу переставило б елементи у девʼяти рядках
      форми PUBLIC — девʼять `attrs:` без жодної зміни прав. Заміряно 13.09:
      сьогодні `order by t` і `order by t collate "C"` дають ОДНЕ І ТЕ САМЕ
      для всіх функцій схеми (0 розбіжностей), тож це зміна з нульовою
      різницею сьогодні і детермінізмом назавжди.
   ⚠️ `proacl IS NULL` і `proacl = '{}'` — ПРОТИЛЕЖНІ стани: перший означає
      «прав ніхто не чіпав», а для функції дефолт це EXECUTE у PUBLIC; другий
      означає «не може НІХТО». `coalesce` над `string_agg` склеїв би їх в один
      літерал, і перехід `{}` → NULL (тобто «ніхто» → «всі») пройшов би повз
      сторожа. Заміряно: сьогодні серед функцій схеми немає ані NULL, ані
      порожніх — обидві гілки на майбутнє. */
const CUR_NEW = "               || ';cfg='   || coalesce(array_to_string(p.proconfig, ','), '')" + nl
  + "               || ';acl='   || case when p.proacl is null then '<default>'" + nl
  + "                                    else coalesce((select string_agg(t, ',' order by t collate \"C\")" + nl
  + "                                                     from unnest(p.proacl::text[]) t), '<empty>') end as attrs";
sub(CUR_ANCHOR, CUR_NEW, "вираз cur");

/* --- Підстановка 2: два НОВИХ рядки списку --------------------------------
   ⚠️ Порядок у списку 0190 НЕ алфавітний (`auth_can_see_slot_details` стоїть
      після `auth_clinic_id` — 0190 вставляв ПІСЛЯ якоря). Тест звіряє
      МНОЖИНИ, не послідовність, тож ставимо поруч зі спорідненими рядками. */
const ROWS_ADD = [
  { after: "      ('auth_can_see_slot_details(c uuid)','19fe1040308640b29a5d8b1bb7506873','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp')," + nl,
    add: "      ('auth_can_refer(c uuid)','0a178709faea2ab0bb55fbb098001bf4','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public')," + nl },
  { after: "      ('auth_radiologist_room_ok(p_room uuid)','c10f4b82244cc076ed7cca76ea4debff','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp')," + nl,
    add: "      ('auth_referrer_visible_rooms()','5f3226aad0599e94feb5b5e1ecfbbbf4','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp')," + nl },
  /* Третій вирішувач того ж доступу: політика `rooms_referrer_read` (0139)
     стоїть на парі `auth_referrer_clinics()` × `auth_referrer_visible_rooms()`,
     і обидві читають ту саму `referral_access` з тим самим предикатом. Пінити
     одну й лишити другу — той самий шаблон, заради припинення якого й пишеться
     ця міграція. Якір — рядок, доданий попереднім кроком. */
  { after: "      ('auth_referrer_visible_rooms()','5f3226aad0599e94feb5b5e1ecfbbbf4','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp')," + nl,
    add: "      ('auth_referrer_clinics()','ef77618a170ca3065c2d1673a3a13731','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public')," + nl },
];
for (const r of ROWS_ADD) {
  /* `sig` з лапкою — для перевірки «чи вже є в списку» (шукаємо `('ім'я`,`).
     Для ЛЕЙБЛА лапку знімаємо: мітка в тексті помилки мусить читатись. */
  const sig = r.add.slice(r.add.indexOf("('") + 1, r.add.indexOf("',"));
  if (count(block, "(" + sig + ",") !== 0) throw new Error(`ЗБІРКА: пін ${sig} уже в списку`);
  sub(r.after, r.after + r.add, `новий рядок ${sig.replace(/^'/, "")}`);
}

/* --- Підстановка 3: `;acl=` в attrs КОЖНОГО рядка -------------------------
   ⚠️ Ріжемо САМ СПИСОК (якір + термінатор) і правимо лише його рядки: заміна
      по всьому блоку зачепила б приклади в коментарях. Той самий прийом, що
      в тесті `guardFnBodiesInvariant` (знахідка ревʼю В у с65). */
const LIST_OPEN = "with expd(fn, body, attrs) as (values";
const LIST_CLOSE = "    ), cur as (";
if (count(block, LIST_OPEN) !== 1) throw new Error("ЗБІРКА: якір списку не унікальний");
const la = block.indexOf(LIST_OPEN) + LIST_OPEN.length;
const lb = block.indexOf(LIST_CLOSE, la);
if (lb < 0) throw new Error("ЗБІРКА: список не закритий `), cur as (`");

const used = new Set();
/* Знімаємо рядки ОДИН раз, до підстановок: кожна з них зсуває зміщення, а
   `sub()` працює по унікальному підрядку, не по позиції. */
const listLines = block.slice(la, lb).split(/\r?\n/);
for (const line of listLines) {
  const m = line.match(/^ {6}\('([^']+)','([0-9a-f]{32})','([^']*)'\)(,?)$/);
  if (!m) continue;
  const [, fn, body, attrs, comma] = m;
  if (/;acl=/.test(attrs)) throw new Error(`ЗБІРКА: у ${fn} вже є ;acl= — збірку вже проганяли?`);
  const acl = ACL[fn];
  if (!acl) throw new Error(`ЗБІРКА: для ${fn} ACL не заміряно. Заміряйте і впишіть, не вигадуйте.`);
  used.add(fn);
  sub(line, `      ('${fn}','${body}','${attrs};acl=${acl}')${comma}`, `acl ${fn}`);
}

/* Обидва боки: жодного рядка без ACL і жодного ACL без рядка. */
const orphan = Object.keys(ACL).filter((k) => !used.has(k));
if (orphan.length) throw new Error(`ЗБІРКА: ACL заміряно для функцій поза списком: ${orphan.join(", ")}`);
if (used.size !== 33) throw new Error(`ЗБІРКА: рядків з ACL ${used.size}, очікували 33`);

/* Скільки рядків у СПИСКУ — рахуємо ТИМ САМИМ регексом, що й тест, і саме по
   вирізаному списку, а не по всьому блоку (інакше сюди потрапили б рядки
   сусідніх перевірок; у тесті цю слабкість уже виправило ревʼю В). */
const ROW_RE = /^ {6}\('[A-Za-z0-9_]+\([^)]*\)','[0-9a-f]{32}','[^']*'\),?$/gm;
const la2 = block.indexOf(LIST_OPEN) + LIST_OPEN.length;
const lb2 = block.indexOf(LIST_CLOSE, la2);
const rows = block.slice(la2, lb2).replace(/\r/g, "").match(ROW_RE) || [];
if (rows.length !== 33) throw new Error(`ЗБІРКА: розпізнано ${rows.length} рядків списку, очікували 33`);

/* --- Підстановка 4: журнал ВСЕРЕДИНІ сторожа ------------------------------
   ⚠️ 0190 переписала цифру ПО МІСЦЮ — а місце це остання фраза абзацу про
      0179, і тіло сторожа почало стверджувати, що до 30 список довела 0179.
      Не повторюємо: лишаємо фразу 0179 як є і додаємо ВЛАСНИЙ буллет. */
const OLD_N = "Список став 30 функцій.";
const NEW_N = "Список став 30 функцій." + nl
  + "  --" + nl
  + "  --     ⚠️ 0191 (с66): у `attrs` додано `;acl=` — ПРАВА ВИКОНАННЯ (прямі" + nl
  + "  --        аклітеми, відсортовані `collate \"C\"`, з окремими гілками на" + nl
  + "  --        `proacl IS NULL` і порожній масив). Плюс ТРИ вирішувачі" + nl
  + "  --        направниківського доступу: `auth_can_refer`," + nl
  + "  --        `auth_referrer_visible_rooms`, `auth_referrer_clinics`." + nl
  + "  --        ⚠️ Їхні ТІЛА вже тримала №22 (усі три anon-досяжні, а вона" + nl
  + "  --        пінить повний сирий md5) — заміряно зондом 13.09. НОВЕ тут:" + nl
  + "  --        ЗНАЧЕННЯ `search_path`, волатильність, мова, власник і права." + nl
  + "  --        Заміряно там же: `alter function … set search_path = pg_temp," + nl
  + "  --        public` на definer-функції поза цим списком не бачила ЖОДНА" + nl
  + "  --        з 23 перевірок. Список став " + rows.length + " функції.";
sub(OLD_N, NEW_N, "журнал 0191");

/* --- Підстановка 5: МЕЖА, яка щойно перестала бути межею ------------------ */
const OLD_LIMIT = "  --     ⚠️ МЕЖА: ACL функцій сюди НЕ входить — це предмет №15 `priv_drift`.";
const NEW_LIMIT = "  --     ⚠️ 0191: ACL функцій ТЕПЕР входить — поле `;acl=` в `attrs`. Межа"
  + nl + "  --        звузилась, але не зникла: `proacl` несе лише ПРЯМІ гранти, тож"
  + nl + "  --        членство в ролях (`grant authenticated to <нова роль>`), `nspacl`"
  + nl + "  --        схеми і `alter default privileges` сюди НЕ входять — і не входять"
  + nl + "  --        нікуди більше.";
sub(OLD_LIMIT, NEW_LIMIT, "межа про ACL");

const body = bodyOf(block);
const LEDGER = [
  "", "do $ledger$", "begin",
  "  if not exists (select 1 from public.migration_ledger",
  "                  where name = '0190_room_busy_slots_pinned.sql') then",
  "    raise exception '0191 потребує 0190 (накатуйте по порядку)';",
  "  end if;",
  "  if exists (select 1 from public.migration_ledger",
  "              where name = '0191_fn_bodies_acl.sql') then",
  "    raise exception '0191 вже накатана';",
  "  end if;",
  "end", "$ledger$;", "",
  "-- ============================================================================",
  "-- 1. invariants_check: передрук 0190 + ACL в attrs + два вирішувачі в списку.",
  "-- ============================================================================",
].join(nl);
const REG = [
  "", "-- ============================================================================",
  "-- Самореєстрація (канон 0142) — ОСТАННІЙ statement перед commit",
  "-- ============================================================================",
  "insert into public.migration_ledger (name)",
  "values ('0191_fn_bodies_acl.sql')",
  "on conflict (name) do nothing;", "", "commit;",
].join(nl);

const head = readFileSync(FRAG + "0191-head.txt", "utf8").replace(/\r?\n/g, nl).trimEnd();
const tail = readFileSync(FRAG + "0191-tail.txt", "utf8").replace(/\r?\n/g, nl).trimEnd();
const out = [head, "", "begin;", LEDGER, block, REG, tail, ""].join(nl);
writeFileSync(MIG + "0191_fn_bodies_acl.sql", out, "utf8");

/* ===========================================================================
   НАКАТНИЙ ФРАГМЕНТ — з тих самих PAIRS, що зібрали файл міграції.
   Канон 0190: тіло редагує сама БАЗА, а результат звіряється з md5, який
   порахував збирач ІЗ ФАЙЛА. Різниця з 0190 лише в кількості підстановок:
   там їх чотири руками, тут їх стільки, скільки набралось у PAIRS, і всі
   згенеровані. ⚠️ Число НЕ вписуємо в коментар: у 0190 рукописна цифра в
   шапці розійшлась із фактом, і це вже коштувало ревʼю. Друкує його
   `console.log` нижче.
   =========================================================================== */
const NEW_MD5 = md5(body);
const NEW_LEN = body.length;
for (const p of PAIRS) {
  if (p.from.includes("$p$") || p.to.includes("$p$")) {
    throw new Error(`ЗБІРКА: підстановка «${p.label}» містить $p$ — доларове лапкування зламається`);
  }
}
const q = (s) => "$p$" + s.replace(/\r/g, "") + "$p$";
const applySql = readFileSync(FRAG + "0191_apply.head.txt", "utf8")
  .replace(/\r?\n/g, "\n")
  .replace("__FROM__", PAIRS.map((p) => "    " + q(p.from)).join(",\n"))
  .replace("__TO__", PAIRS.map((p) => "    " + q(p.to)).join(",\n"))
  .replace("__LABELS__", PAIRS.map((p) => "    " + q(p.label)).join(",\n"))
  .replace(/__NEW_MD5__/g, NEW_MD5)
  .replace(/__NEW_LEN__/g, String(NEW_LEN))
  .replace(/__BASE_MD5__/g, BASE_MD5)
  .replace(/__BASE_LEN__/g, String(BASE_LEN));
writeFileSync(FRAG + "0191_apply.sql", applySql, "utf8");

/* --- СУХИЙ ПРОГІН: той самий файл, але крок 8 не реєструє, а падає ---------
   ⚠️ Канон: «сухий» прогін БЕЗ маркера відкату — це НАКАТ. Тут маркер —
      `raise exception 'SMOKE_OK …'`: вся транзакція відкочується, а числа
      доходять у тексті помилки. Файл генерується, щоб не відрізнявся від
      накату нічим, крім останнього кроку. */
{
  const mark = "  -- 8. Самореєстрація";
  const at8 = applySql.indexOf(mark);
  if (at8 < 0) throw new Error("ЗБІРКА: у накаті немає кроку 8 — сухий прогін не зібрано");
  const dry = applySql.slice(0, at8)
    + "  -- 8. СУХИЙ ПРОГІН: не реєструємо, а падаємо — транзакція відкотиться\n"
    + "  raise exception 'SMOKE_OK 0191: md5 % len % checked 23; чотири червоні базиси спрацювали', v_md5, v_len;\n"
    + "end\n$apply$;\n";
  writeFileSync(FRAG + "0191_dryrun.sql", dry, "utf8");
}

/* --- ВІДКАТ: ті самі пари, у зворотному порядку і зворотному напрямку ------
   ⚠️ Ревʼю Н7: у 0190 відкат був прозою там, де накат — фрагмент із асертами,
      і це назвали «другим інцидентом поверх першого». Тут підстановок 37, і
      написати їх руками під інцидент неможливо — тому генеруємо. */
const rb = [...PAIRS].reverse();
const rollbackSql = [
  "-- 0191_rollback.sql — ЗГЕНЕРОВАНО `node scripts/build-0191-reprint.mjs`.",
  "-- ⚠️ РУКАМИ НЕ ПРАВИТИ. Дзеркало накату: ті самі підстановки у зворотному",
  "--    порядку і зворотному напрямку, з тими самими асертами.",
  "-- Відкат ПОВЕРТАЄ стан, у якому права виконання 33 функцій не стереже ніщо,",
  "-- а три вирішувачі направниківського доступу мають лише пін ТІЛА в №22.",
  "do $rollback$",
  "declare",
  "  v_def text; v_head text; v_body text; v_new text;",
  "  v_md5 text; v_len int; v_hits int; v_res jsonb; v_i int;",
  "  v_from constant text[] := array[",
  rb.map((p) => "    " + q(p.to)).join(",\n"),
  "  ];",
  "  v_to constant text[] := array[",
  rb.map((p) => "    " + q(p.from)).join(",\n"),
  "  ];",
  "  v_lbl constant text[] := array[",
  rb.map((p) => "    " + q(p.label)).join(",\n"),
  "  ];",
  "begin",
  "  perform set_config('lock_timeout', '5s', true);",
  "  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace",
  "        and p.proname = 'invariants_check' and p.prokind = 'f') <> 1 then",
  "    raise exception '0191 rollback: invariants_check не одна';",
  "  end if;",
  "  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body",
  "    from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  "   where n.nspname = 'public' and p.proname = 'invariants_check'",
  "     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';",
  "  -- ⚠️ Алфавіт один: асерти зняті без CR, тож і підстановки йдуть без CR.",
  "  v_body := replace(v_body, chr(13), '');",
  "  if md5(v_body) is distinct from '" + NEW_MD5 + "' then",
  "    raise exception '0191 rollback: у проді не 0191 (%) — відкочувати нічого', md5(v_body);",
  "  end if;",
  "  v_new := v_body;",
  "  for v_i in 1 .. array_length(v_from, 1) loop",
  "    v_hits := (length(v_new) - length(replace(v_new, v_from[v_i], ''))) / length(v_from[v_i]);",
  "    if v_hits <> 1 then",
  "      raise exception '0191 rollback: якір «%» трапляється % раз(ів)', v_lbl[v_i], v_hits;",
  "    end if;",
  "    v_new := replace(v_new, v_from[v_i], v_to[v_i]);",
  "  end loop;",
  "  v_md5 := md5(v_new); v_len := length(v_new);",
  "  if v_md5 <> '" + BASE_MD5 + "' or v_len <> " + BASE_LEN + " then",
  "    raise exception '0191 rollback: зібране тіло % / % — очікували " + BASE_MD5 + " / " + BASE_LEN + "', v_md5, v_len;",
  "  end if;",
  "  v_head := left(v_def, position('$function$' in v_def) + 9);",
  "  execute v_head || v_new || '$function$';",
  "  v_res := public.invariants_check(false);",
  "  if coalesce((v_res ->> 'ok')::boolean, false) is not true then",
  "    raise exception '0191 rollback: сторож червоний після відкату: %', v_res ->> 'failed';",
  "  end if;",
  "  -- ДРУГИЙ ЗАМІР — із КАТАЛОГУ, а не зі змінної",
  "  select md5(replace(p.prosrc, chr(13), '')), length(replace(p.prosrc, chr(13), ''))",
  "    into v_md5, v_len from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  "   where n.nspname = 'public' and p.proname = 'invariants_check'",
  "     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';",
  "  if v_md5 <> '" + BASE_MD5 + "' or v_len <> " + BASE_LEN + " then",
  "    raise exception '0191 rollback: у каталозі % / %', v_md5, v_len;",
  "  end if;",
  "  delete from public.migration_ledger where name = '0191_fn_bodies_acl.sql';",
  "  raise notice '0191 ВІДКОЧЕНО: md5 % len %, рядок леджера знято', v_md5, v_len;",
  "end",
  "$rollback$;",
  "",
].join("\n");
writeFileSync(FRAG + "0191_rollback.sql", rollbackSql, "utf8");

console.log(JSON.stringify({
  pairs: PAIRS.length,
  base_md5: md5(base), base_len: base.length,
  new_md5: md5(body), new_len: body.length,
  delta_len: body.length - base.length,
  rows_in_list: rows.length,
  acl_shapes: { staff: Object.values(ACL).filter((v) => v === ACL_STAFF).length,
                public: Object.values(ACL).filter((v) => v === ACL_PUBLIC).length,
                trigger: Object.values(ACL).filter((v) => v === ACL_TRIG).length },
  file_bytes: Buffer.byteLength(out, "utf8"),
}, null, 1));
