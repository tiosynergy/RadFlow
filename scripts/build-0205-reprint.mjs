// build-0205-reprint.mjs — збирає supabase/migrations/0205_new_user_name_trim.sql
// і scripts/frag/0205_{apply,dryrun,rollback,falsify}.sql.
//
// ЩО РОБИТЬ ПАКЕТ (Н-22(а), с83; борг ревʼю с82, лінза A, Low):
//   1. `handle_new_user()` (тригер `on_auth_user_created` AFTER INSERT на
//      `auth.users`) обрізає `clinic_name` / `full_name` з metadata так само, як
//      форма реєстрації (`components/RegisterPage.tsx`: `trim()`,
//      `replace(/\s+/g, " ")`, NAME_MAX = 200): пробіли схлопуються, краї
//      зрізаються, довжина — до 200 символів; порожнє після обрізки — як і
//      раніше: логін / «Моя клініка». Власник anon-ключа кладе в metadata
//      будь-що через `signUp` напряму (інʼєкції немає — параметризовані insert,
//      лише сміття в назві); межа жила ЛИШЕ у формі.
//   2. Передрук сторожа: №19 — рядок `handle_new_user()` (новий дайджест,
//      `attrs` ті самі, склад 60) і абзац прози; №25 — самопін. `checked` 26.
//      №14 / №16 / №17 / №22 / №23 / №26 НЕ змінюються — генератор це ДОВОДИТЬ:
//      код тіла без коментарів відрізняється від 0204 рівно одним рядком.
//      Даних не змінює (діє лише на МАЙБУТНІ реєстрації).
//
// ⚠️ ФОРМА — ПОВНИЙ ПЕРЕДРУК з 0204 якірними вставками (канон build-0203/0204):
//    `latestReprint()` у тестах і стендах бере ОСТАННІЙ файл, де рядок
//    ПОЧИНАЄТЬСЯ з create-or-replace сторожа.
//
// ⚠️ ПОРЯДОК У НАКАТІ: функція → ACL → передрук → пін → ПОВНИЙ сторож (≈9 с;
//    мусить бути зеленим, крім названого червоного №13) → леджер. DDL на
//    таблицях немає, замків немає.
//
// ⚠️ ПІСЛЯ `npm run db:gate` ЦЕЙ ГЕНЕРАТОР НЕ ЗАПУСКАТИ: він перезаписує файл
//    міграції, чий md5 уже в леджері. Без `--force` відмовляється, якщо зміст інший.
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const count = (s, needle) => s.split(needle).length - 1;
const FORCE = process.argv.includes("--force");

const MIGDIR = "supabase/migrations";
const SRC_NAME = "0204_referrer_grant_read.sql";
const SRC_MIG = `${MIGDIR}/${SRC_NAME}`;
const DST_NAME = "0205_new_user_name_trim.sql";
const DST_MIG = `${MIGDIR}/${DST_NAME}`;
const PREV_LEDGER = SRC_NAME;
/** Прод 07.10 (замір с83 13:55 UTC): тіло сторожа = тіло у файлі 0204. */
const PRE_MD5 = "cf1a920d2052a6debaff8b46c450aeff";
const PRE_LEN = 178426;
const PRE_PIN = `guard_body_md5=${PRE_MD5};len=${PRE_LEN}`;
const CHECKED = 26;
/** Перевірки, червоні на проді ДО пакета не з його вини (замір 07.10: лише №13). */
const KNOWN_RED = ["gcal_sync_overdue"];

const OPEN = "\nas $function$";
const CLOSE = "\n$function$;";
const REPRINT_RE_G = /^create or replace function public\.invariants_check/gm;
const GUARD_PIN_RE =
  /comment on function public\.invariants_check\(boolean\) is '(guard_body_md5=[0-9a-f]{32};len=\d+)';/g;

function split(file) {
  const txt = readFileSync(file, "utf8").replace(/\r/g, "");
  const heads = txt.match(REPRINT_RE_G) || [];
  if (heads.length !== 1) throw new Error(`${file}: заголовків передруку ${heads.length}, а треба 1`);
  const ddl0 = txt.search(/^create or replace function public\.invariants_check/m);
  const a = txt.indexOf(OPEN, ddl0);
  const b = txt.indexOf(CLOSE, a);
  if (a < 0 || b < 0) throw new Error(`${file}: не знайдено межі тіла`);
  if (txt.indexOf(OPEN, a + 1) >= 0) throw new Error(`${file}: \`as $function$\` не один`);
  if (txt.indexOf(CLOSE, b + 1) >= 0) throw new Error(`${file}: \`$function$;\` не один`);
  return {
    raw: txt,
    head: txt.slice(0, ddl0),
    prologue: txt.slice(ddl0, a + OPEN.length),
    body: txt.slice(a + OPEN.length, b + 1),
    tail: txt.slice(b + CLOSE.length),
  };
}

/** Код без коментарів — той самий вирізувач, що в `tests/guardFnBodiesInvariant.test.ts`. */
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
const normWs = (s) => s.replace(/\s+/g, " ").trim();
/** Рецепт №19 (`md5(btrim(regexp_replace(prosrc, '\s+', ' ', 'g')))`) збігається з JS лише на ASCII-пробілах. */
const exoticWs = (s) => [...s].some((ch) => {
  const c = ch.codePointAt(0);
  return c === 0x09 || c === 0x0b || c === 0x0c || c === 0x0d || c === 0xa0 || c === 0x1680
    || (c >= 0x2000 && c <= 0x200b) || c === 0x2028 || c === 0x2029 || c === 0x202f
    || c === 0x205f || c === 0x3000 || c === 0xfeff;
});

// ---------------------------------------------------------------------------
// 1. БАЗИСИ ДЖЕРЕЛА. Кожен — числом.
// ---------------------------------------------------------------------------
const SRC = split(SRC_MIG);
if (md5(SRC.body) !== PRE_MD5 || SRC.body.length !== PRE_LEN) {
  throw new Error(`ВИТЯГ ЗЛАМАНИЙ: 0204 дав ${md5(SRC.body)} / ${SRC.body.length}, а в проді ${PRE_MD5} / ${PRE_LEN}`);
}
if (SRC.head + SRC.prologue + SRC.body + "$function$;" + SRC.tail !== SRC.raw) {
  throw new Error("СКЛЕЙКА ЗЛАМАНА: 0204 не збирається назад побайтово");
}
{
  const pins = [...SRC.raw.matchAll(GUARD_PIN_RE)].map((m) => m[1]);
  if (pins.length !== 1 || pins[0] !== PRE_PIN) {
    throw new Error(`ПІН 0204 у файлі ${JSON.stringify(pins)}, а в проді ${PRE_PIN}`);
  }
}
{
  const later = readdirSync(MIGDIR)
    .filter((f) => f.endsWith(".sql") && f > SRC_NAME && f !== DST_NAME).sort();
  if (later.length) throw new Error(`після 0204 на диску вже є ${later.join(", ")} — номер 0205 зайнятий чи черга зсунулась`);
}

// ---------------------------------------------------------------------------
// 2. `handle_new_user()` — тіло з ПРОДУ. Прод 07.10 (с83): prosrc = тіло у
//    файлі 0124 побайтово без CR (у проді CRLF: сирий md5 1f8ab9ae…/1283; без
//    CR — 0a3adc14…/1251; рецепт №19 f8946030…, як у рядку списку з 0197).
//    Пізніше функцію не перевизначала жодна міграція (перевіряємо; 0140 лише
//    відкликала EXECUTE, 0196 ставила search_path канонічно).
// ---------------------------------------------------------------------------
const HNU = "handle_new_user";
const HNU_SIG = "handle_new_user()";
const HNU_REGPROC = "public.handle_new_user()";
const HNU_SRC_NAME = "0124_login_required.sql";
const HNU_PRE_RAW = "0a3adc1445a761e384980ca2606e20e7";
const HNU_PRE_LEN = 1251;
const HNU_PRE_REC19 = "f894603059909d0ac8c4155202453b49";
const HNU_ATTRS = "secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres";
const FN_ACL = "postgres=X/postgres,service_role=X/postgres";
const HNU_TAG = "$hnu$";
const NAME_MAX = 200;
const HNU_TRIGGER_DEF = "CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user()";
const HNU_PRE = (() => {
  const txt = readFileSync(`${MIGDIR}/${HNU_SRC_NAME}`, "utf8").replace(/\r/g, "");
  const head = `create or replace function public.${HNU}()`;
  const a = txt.indexOf(head);
  if (a < 0 || count(txt, head) !== 1) throw new Error(`${HNU_SRC_NAME}: визначення ${HNU} не одне`);
  const o = txt.indexOf("\nas $$\n", a);
  const e = txt.indexOf("\n$$;", o);
  if (o < 0 || e < 0) throw new Error(`${HNU_SRC_NAME}: межі тіла ${HNU} не знайдено`);
  return { header: txt.slice(a, o), body: txt.slice(o + "\nas $$".length, e + 1) };
})();
if (md5(HNU_PRE.body) !== HNU_PRE_RAW || HNU_PRE.body.length !== HNU_PRE_LEN || md5(normWs(HNU_PRE.body)) !== HNU_PRE_REC19) {
  throw new Error(`${HNU}: тіло 0124 дало ${md5(HNU_PRE.body)} / ${HNU_PRE.body.length} / ${md5(normWs(HNU_PRE.body))}, а на проді ${HNU_PRE_RAW} / ${HNU_PRE_LEN} / ${HNU_PRE_REC19}`);
}
if (HNU_PRE.header !== [
  `create or replace function public.${HNU}()`,
  "returns trigger",
  "language plpgsql",
  "security definer",
  "set search_path = public, pg_temp",
].join("\n")) throw new Error(`${HNU}: шапка 0124 не та (мова/волатильність/definer/шлях)`);
{
  const later = readdirSync(MIGDIR).filter((f) => f.endsWith(".sql") && f > HNU_SRC_NAME && f !== DST_NAME)
    .filter((f) => new RegExp(`create\\s+(or\\s+replace\\s+)?function\\s+public\\.${HNU}\\s*\\(`)
      .test(codeOf(readFileSync(`${MIGDIR}/${f}`, "utf8"))));
  if (later.length) throw new Error(`${HNU} перевизначено пізніше за 0124: ${later.join(", ")}`);
}
/** Правка — три якорі: дві змінні в declare, обчислення перед insert у clinics,
 *  підстановка в insert у profiles. Решта тіла — побайтово 0124. */
const TRIM_EXPR = (key) =>
  `nullif(btrim(left(btrim(regexp_replace(coalesce(new.raw_user_meta_data->>'${key}', ''), '\\s+', ' ', 'g')), ${NAME_MAX})), '')`;
const HNU_DECL_FROM = "declare\n  new_clinic_id uuid;\n  v_login       text;\nbegin\n";
const HNU_DECL_TO = "declare\n  new_clinic_id uuid;\n  v_login       text;\n  v_clinic_name text;\n  v_full_name   text;\nbegin\n";
const HNU_CLINIC_FROM = "  insert into public.clinics (name)\n  values (coalesce(nullif(new.raw_user_meta_data->>'clinic_name',''), v_login, 'Моя клініка'))\n";
const HNU_TRIM_LINES = [
  `  v_clinic_name := ${TRIM_EXPR("clinic_name")};`,
  `  v_full_name   := ${TRIM_EXPR("full_name")};`,
];
const HNU_CLINIC_TO = [
  "  -- 0205 (с83, Н-22(а)). Межі форми реєстрації (NAME_MAX = 200, пробіли",
  "  -- схлопуються, краї зрізаються) живуть і ТУТ: власник anon-ключа кладе в",
  "  -- metadata будь-що через signUp напряму (інʼєкції немає — параметризовані",
  "  -- insert, лише сміття в назві). Порожнє після обрізки — як і раніше:",
  "  -- логін / «Моя клініка». Форма ВІДМОВЛЯЄ довшому за 200; тригер РІЖЕ, бо",
  "  -- виняток тут відкотив би сам insert в auth.users («Database error saving",
  "  -- new user») — сміття в назві не варте зірваної реєстрації.",
  ...HNU_TRIM_LINES,
  "",
  "  insert into public.clinics (name)",
  "  values (coalesce(v_clinic_name, v_login, 'Моя клініка'))",
].join("\n") + "\n";
const HNU_FULL_FROM = "          coalesce(nullif(new.raw_user_meta_data->>'full_name',''), v_login),\n";
const HNU_FULL_TO = "          coalesce(v_full_name, v_login),\n";
const HNU_PAIRS = [
  [HNU_DECL_FROM, HNU_DECL_TO, "declare: дві змінні"],
  [HNU_CLINIC_FROM, HNU_CLINIC_TO, "clinics: обрізка і підстановка"],
  [HNU_FULL_FROM, HNU_FULL_TO, "profiles: підстановка full_name"],
];
const HNU_NEW_BODY = (() => {
  let b = HNU_PRE.body;
  for (const [f, t, lbl] of HNU_PAIRS) {
    if (count(b, f) !== 1) throw new Error(`${HNU}: якір «${lbl}» — ${count(b, f)} влучань, а треба 1`);
    b = b.split(f).join(t);
  }
  return b;
})();
const HNU_NEW_RAW = md5(HNU_NEW_BODY);
const HNU_NEW_LEN = HNU_NEW_BODY.length;
const HNU_NEW_REC19 = md5(normWs(HNU_NEW_BODY));
const HNU_STMT_OF = (body) => `${HNU_PRE.header}\nas ${HNU_TAG}${body}${HNU_TAG};`;
const HNU_PRE_STMT = HNU_STMT_OF(HNU_PRE.body);
const HNU_NEW_STMT = HNU_STMT_OF(HNU_NEW_BODY);
const HNU_ACL_DDL = [
  `revoke all on function ${HNU_REGPROC} from public, anon, authenticated;`,
  `grant execute on function ${HNU_REGPROC} to service_role;`,
].join("\n");
{
  if (exoticWs(HNU_NEW_STMT)) throw new Error(`${HNU}: у тексті є не-ASCII пробіл або табуляція`);
  if (HNU_NEW_STMT.includes("$function$") || HNU_NEW_STMT.includes("$fxa$") || HNU_NEW_STMT.includes("$back$")) throw new Error(`${HNU}: тіло містить тег фрагмента`);
  /* Код без коментарів: старий + дві змінні в declare + два рядки обрізки, а
     обидва coalesce беруть змінні. Нічого іншого в коді функції не змінено. */
  const oldCode = codeOf(HNU_PRE.body).split("\n");
  const newCode = codeOf(HNU_NEW_BODY).split("\n");
  const want = (() => {
    let c = oldCode.join("\n");
    const sub = (f, t, lbl) => { if (count(c, f) !== 1) throw new Error(`${HNU} КОД: якір «${lbl}» — ${count(c, f)} влучань`); c = c.split(f).join(t); };
    sub(HNU_DECL_FROM, HNU_DECL_TO, "declare");
    sub(HNU_CLINIC_FROM, HNU_TRIM_LINES.join("\n") + "\n\n  insert into public.clinics (name)\n  values (coalesce(v_clinic_name, v_login, 'Моя клініка'))\n", "clinics");
    sub(HNU_FULL_FROM, HNU_FULL_TO, "full_name");
    return c.split("\n");
  })();
  if (JSON.stringify(newCode) !== JSON.stringify(want)) throw new Error(`${HNU}: код без коментарів змінено не лише обрізкою`);
  if (count(codeOf(HNU_NEW_BODY), "raw_user_meta_data->>'clinic_name'") !== 1 || count(codeOf(HNU_NEW_BODY), "raw_user_meta_data->>'full_name'") !== 1) throw new Error(`${HNU}: metadata читається не рівно по разу`);
  if (count(HNU_NEW_BODY, `, ${NAME_MAX})`) !== 2) throw new Error(`${HNU}: стеля ${NAME_MAX} не рівно двічі`);
  if (!HNU_NEW_BODY.includes("if coalesce(new.raw_user_meta_data->>'managed','') = 'true' then\n    return new;")) throw new Error(`${HNU}: гілка managed зникла`);
  if (!HNU_NEW_BODY.includes("v_login := public.unique_login(v_login);") || !HNU_NEW_BODY.includes("public.unique_login_from_email(new.email)")) throw new Error(`${HNU}: логін рахується інакше`);
  if (HNU_NEW_REC19 === HNU_PRE_REC19 || HNU_NEW_RAW === HNU_PRE_RAW) throw new Error(`${HNU}: дайджест не змінився`);
}

// ---------------------------------------------------------------------------
// 3. ПРАВКИ ТІЛА СТОРОЖА: рядок №19 і абзац прози.
// ---------------------------------------------------------------------------
const row19 = (sig, dig, attrs) => `      ('${sig}','${dig}','${attrs}'),\n`;
const ROW19_OLD = row19(HNU_SIG, HNU_PRE_REC19, HNU_ATTRS);
const ROW19_NEW = row19(HNU_SIG, HNU_NEW_REC19, HNU_ATTRS);
/** Останній рядок абзацу 0204 у прозі №19 — наш абзац одразу після нього. */
const P19_PROSE_ANCHOR = "  --           до ПДн. Її вихолощення ловить №14 (`unreachable:`), а не №19.\n";
const PROSE19_0205 = [
  "  --     ⚠️ 0205 (с83, Н-22(а)) ПЕРЕДРУКУВАЛА ОДИН md5 БЕЗ ЗМІНИ СКЛАДУ (список так",
  "  --        само 60): `handle_new_user()` — `clinic_name` / `full_name` з metadata",
  "  --        обрізаються як у формі реєстрації (пробіли схлопуються, краї зрізаються,",
  `  --        до ${NAME_MAX} символів; порожнє → логін / «Моя клініка»). Це тригер на`,
  "  --        `auth.users` (гілка `auth_trigger:` нижче стереже сам тригер, рядок —",
  "  --        тіло): межа форми раніше жила ЛИШЕ у формі, а metadata кладе хто",
  "  --        завгодно з anon-ключем. Фальсифікація 0205 ставить назад тіло 0124 і",
  "  --        вимагає від цієї перевірки `body:` рівно з його дайджестом.",
].join("\n") + "\n";

const PAIRS = [
  [ROW19_OLD, ROW19_NEW, `№19: ${HNU} ${HNU_PRE_REC19} → ${HNU_NEW_REC19}`],
  [P19_PROSE_ANCHOR, P19_PROSE_ANCHOR + PROSE19_0205, "проза №19: абзац 0205"],
];

// ---------------------------------------------------------------------------
// 4. ХІД УПЕРЕД.
// ---------------------------------------------------------------------------
let NEW_BODY = SRC.body;
for (const [from, to, lbl] of PAIRS) {
  const hits = count(NEW_BODY, from);
  if (hits !== 1) throw new Error(`ЯКІР «${lbl}»: ${hits} влучань, а треба 1`);
  NEW_BODY = NEW_BODY.split(from).join(to);
}
const NEW_MD5 = md5(NEW_BODY);
const NEW_LEN = NEW_BODY.length;
const PIN = `guard_body_md5=${NEW_MD5};len=${NEW_LEN}`;
if (!/^guard_body_md5=[0-9a-f]{32};len=[0-9]+$/.test(PIN)) throw new Error(`ПІН не за регуляркою №25: ${PIN}`);
{
  const want = PRE_LEN + PAIRS.reduce((s, [f, t]) => s + t.length - f.length, 0);
  if (NEW_LEN !== want) throw new Error(`ДОВЖИНА ${NEW_LEN}, а з пар виходить ${want}`);
  if ([...NEW_BODY].length !== NEW_LEN) throw new Error("тіло має символи поза BMP — length у PG і JS розійдуться");
  if (exoticWs(PROSE19_0205) || exoticWs(ROW19_NEW)) throw new Error("вставка містить не-ASCII пробіл");
}

// ---------------------------------------------------------------------------
// 5. ЗМІСТОВІ ПЕРЕВІРКИ.
// ---------------------------------------------------------------------------
const SIG19_RE = /^ {6}\('[A-Za-z0-9_]+\([^)]*\)','[0-9a-f]{32}','[^']*'\),?$/gm;
const list19 = (body) => {
  const open = "with expd(fn, body, attrs) as (values";
  const a = body.indexOf(open);
  const b = body.indexOf("    ), cur as (", a);
  if (a < 0 || b < 0) throw new Error("список №19 не знайдено");
  return body.slice(a, b);
};
const OLD_CODE = codeOf(SRC.body);
const NEW_CODE = codeOf(NEW_BODY);
const EXPECTED_CODE = (() => {
  let c = OLD_CODE;
  if (count(c, ROW19_OLD) !== 1) throw new Error("КОД: рядок №19 handle_new_user не один");
  c = c.split(ROW19_OLD).join(ROW19_NEW);
  return c;
})();
const CHECKS = [
  ["№19: 60 → 60 — змінено лише рядок handle_new_user (md5), attrs і позиція ті самі", () => {
    const o = list19(SRC.body).match(SIG19_RE) || [];
    const n = list19(NEW_BODY).match(SIG19_RE) || [];
    if (o.length !== 60 || n.length !== 60) return false;
    const diff = n.map((r, i) => [r, o[i]]).filter(([a, b]) => a !== b);
    return diff.length === 1 && diff[0][0] === ROW19_NEW.replace(/\n$/, "") && diff[0][1] === ROW19_OLD.replace(/\n$/, "");
  }],
  ["проза №19: «сьогодні 60 підписів» = фактичний склад списку", () =>
    /сьогодні 60 підписів/.test(NEW_BODY) && (list19(NEW_BODY).match(SIG19_RE) || []).length === 60],
  ["код без коментарів: рівно один змінений рядок (№19 handle_new_user)", () => NEW_CODE === EXPECTED_CODE],
  ["абзац 0205 — рівно один, після абзацу 0204 у прозі №19, перед кроком лічильника №19", () => {
    if (count(NEW_BODY, PROSE19_0205) !== 1) return false;
    const a = NEW_BODY.indexOf(PROSE19_0205);
    const step = NEW_BODY.indexOf("  v_n := v_n + 1;\n  v_tmp := null;\n  select regexp_replace(pg_get_triggerdef(t.oid)", a);
    return step > 0 && step - (a + PROSE19_0205.length) === 0;
  }],
  ["гілка auth_trigger: тригер на auth.users — без змін", () =>
    count(NEW_BODY, "               || ' handle_new_user()/O'\n") === 1 && count(NEW_CODE, "n.nspname = 'auth' and c.relname = 'users'") === 1],
  ["теги фрагментів і долари в тілі — лише $function$ у прологах інших функцій немає", () =>
    !/\$(hnu|fxa|back|apply|dryrun|falsify|pre|chk|post|p)\$/.test(NEW_BODY)],
  ["самопін №25 у тілі — регулярка та сама", () =>
    NEW_BODY.includes("guard_body_md5=") && count(NEW_BODY, "guard_body_md5=") === count(SRC.body, "guard_body_md5=")],
];
for (const [lbl, fn] of CHECKS) {
  if (!fn()) throw new Error(`ПЕРЕВІРКА НЕ ПРОЙШЛА: ${lbl}`);
}

// ---------------------------------------------------------------------------
// 6. ВИРАЗИ, ВИРІЗАНІ з тіла сторожа ДОСЛІВНО: `cur` №19 і весь запит №19.
// ---------------------------------------------------------------------------
const CUR_EXPR = (() => {
  const open = "    ), cur as (";
  const close = "\n    )\n    select";
  if (count(NEW_BODY, open) !== 1) throw new Error("якір `    ), cur as (` у тілі не 1");
  const a = NEW_BODY.indexOf(open);
  const b = NEW_BODY.indexOf(close, a);
  const label = NEW_BODY.indexOf("'check', 'guard_fn_bodies'", a);
  if (b < 0 || label < 0 || b > label) throw new Error("термінатор виразу cur не знайдено до мітки №19");
  return NEW_BODY.slice(a + open.length, b);
})();
if (/--|\/\*|\$/.test(CUR_EXPR)) throw new Error("ВИРАЗ cur містить коментар або долар");
const Q19_START = "  v_tmp := null;\n  select regexp_replace(pg_get_triggerdef(t.oid), '\\s+', ' ', 'g') || '/' || t.tgenabled::text\n    into v_atg\n";
const Q19_END = "  exception when others then\n    v_tmp := array['guard_fn_bodies_raised:' || sqlstate || ':' || left(sqlerrm, 120)];\n  end;\n";
const q19Of = (body, lbl) => {
  if (count(body, Q19_START) !== 1 || count(body, Q19_END) !== 1) throw new Error(`запит №19 (${lbl}): якорі не по одному`);
  const a = body.indexOf(Q19_START);
  const b = body.indexOf(Q19_END, a);
  if (b < 0) throw new Error(`запит №19 (${lbl}): кінець не після початку`);
  return body.slice(a, b + Q19_END.length);
};
const Q19_NEW = q19Of(NEW_BODY, "нове");
const Q19_OLD = q19Of(SRC.body, "старе");
if ((Q19_NEW.match(SIG19_RE) || []).length !== 60 || !Q19_NEW.includes(ROW19_NEW)) throw new Error("запит №19: не 60 рядків або немає нового рядка handle_new_user");
if (!Q19_OLD.includes(ROW19_OLD) || Q19_OLD.includes(ROW19_NEW)) throw new Error("запит №19 (старе): рядок handle_new_user не старий");
if (!Q19_NEW.includes("), cur as (" + CUR_EXPR)) throw new Error("запит №19: вираз cur не той");
if (/\$/.test(Q19_NEW) || /v_n := v_n/.test(Q19_NEW)) throw new Error("запит №19 містить долар або крок лічильника");

// ---------------------------------------------------------------------------
// 7. ЗВІРКА СТЕНДОВИХ ЯКОРІВ ЗА ЛІТЕРАЛАМИ (лексер із 0201/0202/0203/0204).
// ---------------------------------------------------------------------------
function literalsOf(src, spans = null) {
  const out = [];
  const n = src.length;
  let i = 0;
  let prev = "";
  const decode = (raw) => raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, e) => {
    if (e[0] === "u" && e[1] === "{") return String.fromCodePoint(parseInt(e.slice(2, -1), 16));
    if (e[0] === "u" && e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e[0] === "x" && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
    return { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0", "\n": "" }[e] ?? e;
  });
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1, raw = "";
      while (j < n && src[j] !== c && src[j] !== "\n") { if (src[j] === "\\") { raw += src[j] + src[j + 1]; j += 2; } else raw += src[j++]; }
      const v = decode(raw);
      if (v.length >= 12) out.push(v);
      if (spans) spans.push({ v, a: i, b: j + 1 });
      i = j + 1; prev = c; continue;
    }
    if (c === "`") {
      let j = i + 1, raw = "", plain = true;
      while (j < n && src[j] !== "`") {
        if (src[j] === "\\") { raw += src[j] + src[j + 1]; j += 2; continue; }
        if (src[j] === "$" && src[j + 1] === "{") {
          plain = false; let depth = 1; j += 2;
          while (j < n && depth > 0) { if (src[j] === "{") depth++; else if (src[j] === "}") depth--; j++; }
          continue;
        }
        raw += src[j++];
      }
      if (plain) { const v = decode(raw); if (v.length >= 12) out.push(v); if (spans) spans.push({ v, a: i, b: j + 1 }); }
      i = j + 1; prev = "`"; continue;
    }
    if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^\n".includes(prev))) {
      let j = i + 1, cls = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "[") cls = true; else if (src[j] === "]") cls = false;
        else if (src[j] === "/" && !cls) break;
        j++;
      }
      i = j + 1; prev = "/"; continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}
function compositesOf(src) {
  const spans = [];
  literalsOf(src, spans);
  const out = [];
  for (let k = 0; k < spans.length; k++) {
    let v = spans[k].v, b = spans[k].b;
    while (k + 1 < spans.length && /^\s*\+\s*$/.test(src.slice(b, spans[k + 1].a))) {
      k++; v += spans[k].v; b = spans[k].b;
    }
    if (v.length >= 12) out.push(v);
  }
  return out;
}
const STAND_LITERALS = new Set();
let STANDS_N = 0;
let STAND_LITS_CHECKED = 0;
{
  const stands = readdirSync("scripts").filter((f) => /^falsify-.*\.mjs$/.test(f));
  STANDS_N = stands.length;
  if (stands.length < 30) throw new Error(`ЯКОРІ: лише ${stands.length} стендів — очікувалось ≥30`);
  const migs = readdirSync(MIGDIR).filter((f) => f.endsWith(".sql") && f !== DST_NAME);
  const stale = [];
  const ambiguous = [];
  for (const f of stands) {
    const txt = readFileSync(`scripts/${f}`, "utf8").replace(/\r/g, "");
    const named = migs.filter((m) => txt.includes(`${MIGDIR}/${m}`) && m !== SRC_NAME);
    for (const x of compositesOf(txt)) STAND_LITERALS.add(x);
    for (const lit of new Set(literalsOf(txt))) {
      const before = count(SRC.body, lit);
      if (before === 0) continue;
      STAND_LITS_CHECKED++;
      const after = count(NEW_BODY, lit);
      const broken = (before === 1 && after !== 1) || after === 0;
      if (!broken) continue;
      const livesInNamed = named.some((m) =>
        readFileSync(`${MIGDIR}/${m}`, "utf8").replace(/\r/g, "").includes(lit));
      const line = `${f} ← ${JSON.stringify(lit.slice(0, 70))} (${before} → ${after})`;
      if (livesInNamed) ambiguous.push(line); else stale.push(line);
    }
  }
  if (ambiguous.length) console.log(`  ⚠️ якорі, що живуть і в поіменній старій міграції (розібрати руками):\n    ${ambiguous.join("\n    ")}`);
  if (STAND_LITS_CHECKED < 100) throw new Error(`ЯКОРІ: звірено лише ${STAND_LITS_CHECKED} літералів — розбір стендів зламався`);
  if (stale.length) throw new Error(`ЯКОРІ ПРОТУХЛИ:\n  ${stale.join("\n  ")}`);
  console.log(`  якорі стендів: ${stands.length} файлів, ${STAND_LITS_CHECKED} літералів у тілі сторожа, 0 протухлих`);
}

// ---------------------------------------------------------------------------
// 8. ФРАГМЕНТИ. Спільні будівельні блоки (канон 0204).
// ---------------------------------------------------------------------------
const q = (s) => `$q$${s}$q$`;
const lit = (s) => `'${s.replace(/'/g, "''")}'`;
const arr = (xs) => "array[\n" + xs.map((x) => `    ${q(x)}`).join(",\n") + "\n  ]";
const sqlArr = (xs) => `array[${xs.map(lit).join(", ")}]::text[]`;
const indent = (s, pad = "  ") => s.split("\n").map((l) => (l ? pad + l : l)).join("\n");
const FRAG_TAGS = ["$q$", "$apply$", "$dryrun$", "$back$", "$falsify$", "$fxa$", "$pre$", "$chk$", "$post$", HNU_TAG];
for (const [lbl, x] of [["cur", CUR_EXPR], ["№19", Q19_NEW], ["№19 ст", Q19_OLD], ["тіло hnu", HNU_NEW_BODY], ["тіло hnu ст", HNU_PRE.body], ...PAIRS.map((p) => [p[2], p[0] + p[1]])]) {
  for (const t of FRAG_TAGS) if (x.includes(t)) throw new Error(`«${lbl}» містить тег ${t}`);
}

const PRE = (tag) => [
  "  perform set_config('lock_timeout', '5s', true);",
  "  -- Шлях фіксуємо явно: інакше читання pg_proc залежало б від налаштування",
  "  -- ролі оператора (урок 0196).",
  "  perform set_config('search_path', 'public, pg_temp', true);",
  "  if current_user <> 'postgres' then",
  `    raise exception '${tag}: мусить іти від ролі postgres, а йде від %', current_user;`,
  "  end if;",
].join("\n");

const LEDGER_GUARDS = (tag) => [
  `  if exists (select 1 from public.migration_ledger where name = '${DST_NAME}') then`,
  `    raise exception '${tag}: рядок уже в леджері — повторний накат заборонено';`,
  "  end if;",
  `  if not exists (select 1 from public.migration_ledger where name = '${PREV_LEDGER}') then`,
  `    raise exception '${tag}: у леджері немає 0204 — накат не в свою чергу';`,
  "  end if;",
  "  if (select max(name) from public.migration_ledger) is distinct from",
  `     '${PREV_LEDGER}' then`,
  `    raise exception '${tag}: останній рядок леджера % — не 0204, черга зсунулась',`,
  "      (select max(name) from public.migration_ledger);",
  "  end if;",
].join("\n");

const readGuard = (tag, wantMd5, wantLen, wantPin, what) => [
  "  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body",
  "    from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  "   where n.nspname = 'public' and p.proname = 'invariants_check'",
  "     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';",
  "  if v_body is null then",
  `    raise exception '${tag}: invariants_check не знайдено';`,
  "  end if;",
  "  v_src := replace(v_body, chr(13), '');",
  `  if md5(v_src) is distinct from '${wantMd5}' or length(v_src) <> ${wantLen} then`,
  `    raise exception '${tag}: у проді не ${what} (% / %) — правка наосліп заборонена', md5(v_src), length(v_src);`,
  "  end if;",
  "  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);",
  "  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc')",
  `     is distinct from '${wantPin}' then`,
  `    raise exception '${tag}: самопін % не збігається з тілом ${what} — спершу розібратись',`,
  "      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');",
  "  end if;",
].join("\n");

const fnAttrsAssert = (tag, regproc, what, rawMd5) => [
  "  if not exists (",
  "    select 1 from pg_proc p join pg_language l on l.oid = p.prolang",
  `     where p.oid = to_regprocedure('${regproc}')`,
  "       and p.prosecdef and p.provolatile = 'v' and l.lanname = 'plpgsql'",
  "       and pg_get_userbyid(p.proowner) = 'postgres'",
  "       and p.proconfig = array['search_path=public, pg_temp']",
  "       and p.prorettype = 'trigger'::regtype",
  `       and md5(replace(p.prosrc, chr(13), '')) = '${rawMd5}'`,
  "  ) then",
  `    raise exception '${tag}: ${what} не та (атрибути або сирий md5 тіла ${rawMd5})';`,
  "  end if;",
  "  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace",
  `        and p.proname = '${HNU}') <> 1 then`,
  `    raise exception '${tag}: ${HNU} має перевантаження — create or replace не про ту функцію';`,
  "  end if;",
].join("\n");
const fnAclAssert = (tag, regproc) => [
  "  -- ── ACL: пастка 0122 (дефолтний ACL схеми public роздає EXECUTE і anon,",
  "  --    і PUBLIC) — асерт у ТІЙ САМІЙ транзакції ──",
  `  if has_function_privilege('anon', '${regproc}', 'EXECUTE')`,
  `     or has_function_privilege('authenticated', '${regproc}', 'EXECUTE')`,
  "     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f'::\"char\", p.proowner))) a",
  `                 where p.oid = to_regprocedure('${regproc}') and a.grantee = 0) then`,
  `    raise exception '${tag}: ${regproc} виконують anon/authenticated/PUBLIC — ACL не звужено';`,
  "  end if;",
  `  if not has_function_privilege('service_role', '${regproc}', 'EXECUTE') then`,
  `    raise exception '${tag}: service_role втратив EXECUTE на ${regproc}';`,
  "  end if;",
  "  select array_to_string(array(select t from unnest(p.proacl::text[]) t order by t collate \"C\"), ',')",
  "    into v_acl from pg_proc p",
  `   where p.oid = to_regprocedure('${regproc}');`,
  `  if v_acl is distinct from '${FN_ACL}' then`,
  `    raise exception '${tag}: ACL ${regproc} = % замість ${FN_ACL}', v_acl;`,
  "  end if;",
].join("\n");
const trigAssert = (tag) => [
  /* Форма НЕ збігається з рядками тіла №19 (стенди мутують файл цілком: копія рядка тіла
     поза тілом = «ЯКІР НЕ УНІКАЛЬНИЙ») — тому розбивка і порядок умов інші. */
  "  select regexp_replace(pg_get_triggerdef(t.oid), '\\s+', ' ', 'g')",
  "         || '/' || t.tgenabled::text into v_atg",
  "    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace",
  "   where c.relname = 'users' and n.nspname = 'auth' and not t.tgisinternal and t.tgname = 'on_auth_user_created';",
  `  if v_atg is distinct from '${HNU_TRIGGER_DEF}/O' then`,
  `    raise exception '${tag}: тригер on_auth_user_created не той або вимкнений: %', coalesce(v_atg, '(NULL)');`,
  "  end if;",
].join("\n");

/** Рядок №19 `handle_new_user` — рецептом `cur` (вирізаний із тіла). */
const hnuRow19 = (tag, rec19, what) => [
  `  -- ── ${HNU} ${what}: рецепт №19 (\`cur\`, вирізаний із тіла) ──`,
  "  with expd(fn, body, attrs) as (values",
  `      ('${HNU_SIG}','${rec19}','${HNU_ATTRS}')`,
  "    ), cur as (" + CUR_EXPR,
  "    )",
  "  select array_agg(x.txt order by x.txt) into v_bad",
  "    from (",
  "      select 'missing:' || e.fn as txt from expd e",
  "       where not exists (select 1 from cur c where c.fn = e.fn)",
  "      union all",
  "      select 'body:' || e.fn || '->' || c.body from expd e join cur c on c.fn = e.fn",
  "       where c.body <> e.body",
  "      union all",
  "      select 'attrs:' || e.fn || '->' || c.attrs from expd e join cur c on c.fn = e.fn",
  "       where c.attrs <> e.attrs",
  "      union all",
  "      select 'extra:' || c.fn from cur c",
  "       where not exists (select 1 from expd e where e.fn = c.fn)",
  "    ) x;",
  "  if v_bad is not null then",
  `    raise exception '${tag}: ${HNU} ${what} не та: %', v_bad;`,
  "  end if;",
].join("\n");

const PREMISES = (tag) => [
  "  -- ── Передумови: прод-тіло handle_new_user = 0124 (без CR), атрибути, одна",
  "  --    функція без перевантажень, тригер на auth.users стоїть і ввімкнений ──",
  fnAttrsAssert(tag, HNU_REGPROC, `${HNU} до заміни`, HNU_PRE_RAW),
  hnuRow19(tag, HNU_PRE_REC19, "до заміни"),
  fnAclAssert(tag, HNU_REGPROC),
  trigAssert(tag),
  "  if to_regprocedure('public.unique_login(text)') is null or to_regprocedure('public.unique_login_from_email(text)') is null then",
  `    raise exception '${tag}: помічників unique_login / unique_login_from_email немає';`,
  "  end if;",
].join("\n");

const fnExec = (tag, stmt) => `  execute ${tag}\n${stmt.replace(/;\s*$/, "")}\n${tag};`;

const substitute = (tag, fromVar, toVar, lblVar, wantMd5, wantLen, what) => [
  "  v_new := v_src;",
  `  for i in 1 .. array_length(${fromVar}, 1) loop`,
  `    v_hits := (length(v_new) - length(replace(v_new, ${fromVar}[i], ''))) / length(${fromVar}[i]);`,
  "    if v_hits <> 1 then",
  `      raise exception '${tag}: якір «%» трапляється % раз(ів), а треба 1', ${lblVar}[i], v_hits;`,
  "    end if;",
  `    v_new := replace(v_new, ${fromVar}[i], ${toVar}[i]);`,
  "  end loop;",
  `  if md5(v_new) is distinct from '${wantMd5}' or length(v_new) <> ${wantLen} then`,
  `    raise exception '${tag}: підстановка дала % / %, а ${what} це ${wantMd5} / ${wantLen}',`,
  "      md5(v_new), length(v_new);",
  "  end if;",
  "  execute v_head || v_new || '$function$';",
  "",
  "  select replace(p.prosrc, chr(13), '') into v_src",
  "    from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  "   where n.nspname = 'public' and p.proname = 'invariants_check'",
  "     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';",
  `  if md5(v_src) is distinct from '${wantMd5}' or length(v_src) <> ${wantLen} then`,
  `    raise exception '${tag}: у БД лягло % / % замість ${wantMd5} / ${wantLen}', md5(v_src), length(v_src);`,
  "  end if;",
].join("\n");

const pinBlock = (tag, wantPin) => [
  "  -- ── Самопін №25 — у ТІЙ САМІЙ транзакції ─────────────────────────────────",
  "  v_pin_db := 'guard_body_md5=' || md5(v_src) || ';len=' || length(v_src);",
  `  if v_pin_db is distinct from '${wantPin}' then`,
  `    raise exception '${tag}: пін із БД (%) розійшовся з піном із файлу (${wantPin})', v_pin_db;`,
  "  end if;",
  "  execute format('comment on function public.invariants_check(boolean) is %L', v_pin_db);",
  "  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc') is distinct from v_pin_db then",
  `    raise exception '${tag}: пін не ліг — у коментарі %',`,
  "      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');",
  "  end if;",
].join("\n");

const KNOWN_RED_SQL = `(${KNOWN_RED.map(lit).join(", ")})`;
const SENTINEL_CALL = "  v_res := public.invariants_check(false);";
/** ПОВНИЙ сторож: після передруку мусить бути зеленим, крім названого №13. */
const SENTINEL = (tag, what) => [
  `  -- ── ПОВНИЙ сторож ${what} (≈9 с; DDL на таблицях у пакеті немає) ──`,
  SENTINEL_CALL,
  `  if (v_res->>'checked')::int <> ${CHECKED} then`,
  `    raise exception '${tag}: сторож перевірив % замість ${CHECKED}', v_res->>'checked';`,
  "  end if;",
  "  select array_agg(e.value->>'check' order by e.value->>'check') into v_failed",
  "    from jsonb_array_elements(v_res->'failed') e",
  `   where e.value->>'check' not in ${KNOWN_RED_SQL};`,
  "  if v_failed is not null then",
  `    raise exception '${tag}: сторож ${what} червоний: % — %', v_failed, v_res->'failed';`,
  "  end if;",
].join("\n");
/** ПОВНИЙ сторож ПІСЛЯ накату, але ДО db:gate (фальсифікація): №7 `ledger_md5`
 *  законно червоний з offender-ом РІВНО самої 0205 (md5 ще не проштамповано). */
const SENTINEL_PRE_GATE = (tag, what) => [
  `  -- ── ПОВНИЙ сторож ${what} (≈9 с): зелена базова лінія ДО мутацій; ledger_md5 —`,
  "  --    лише з offender-ом самої 0205 (db:gate ще не штампував) ──",
  SENTINEL_CALL,
  `  if (v_res->>'checked')::int <> ${CHECKED} then`,
  `    raise exception '${tag}: сторож перевірив % замість ${CHECKED}', v_res->>'checked';`,
  "  end if;",
  "  select array_agg(e.value->>'check' order by e.value->>'check') into v_failed",
  "    from jsonb_array_elements(v_res->'failed') e",
  `   where e.value->>'check' not in ${KNOWN_RED_SQL}`,
  "     and not (e.value->>'check' = 'ledger_md5'",
  `              and e.value->'offenders' = jsonb_build_array('${DST_NAME}'));`,
  "  if v_failed is not null then",
  `    raise exception '${tag}: сторож ${what} червоний: % — %', v_failed, v_res->'failed';`,
  "  end if;",
].join("\n");

/** Запит перевірки ДОСЛІВНО з тіла (мілісекунди). */
const Q_ASSERT = (tag, lbl, qtext, what) => [
  `  -- ── ${lbl} ${what}: запит вирізано ДОСЛІВНО з тіла (починається з v_tmp := null) ──`,
  qtext,
  "  if v_tmp is not null then",
  `    raise exception '${tag}: ${lbl} ${what} червоний: %', v_tmp;`,
  "  end if;",
].join("\n");
const Q_EXPECT_RED = (tag, lbl, qtext, wantArr, what) => [
  `  -- ── ${lbl} ${what}: запит вирізано ДОСЛІВНО з тіла; мусить назвати РІВНО % ──`.replace("%", wantArr),
  qtext,
  `  if v_tmp is distinct from ${wantArr} then`,
  `    raise exception '${tag}: ${lbl} ${what} мусив назвати ${wantArr.replace(/'/g, "''")}, а назвав %', coalesce(v_tmp::text, '(NULL — зелений)');`,
  "  end if;",
].join("\n");

const DECL = (tag, fromXs, toXs, lblXs, extra = []) => [
  "-- ⚠️ Бюджет часу — ЗОВНІ блоку: `set statement_timeout` усередині `do` інертний",
  "--    (канон 0192). MCP жене батч однією транзакцією, після `raise` set відкочується.",
  "set statement_timeout = '5min';",
  `do $${tag}$`,
  "declare",
  "  v_def text; v_body text; v_src text; v_head text; v_new text; v_atg text;",
  "  v_hits int; v_rows int; v_res jsonb; v_pin_db text; v_bad text[]; v_tmp text[];",
  "  v_failed text[]; v_acl text;",
  ...extra,
  `  v_from constant text[] := ${arr(fromXs)};`,
  `  v_to   constant text[] := ${arr(toXs)};`,
  `  v_lbl  constant text[] := ${arr(lblXs)};`,
  "begin",
].join("\n");

const FWD = [PAIRS.map((p) => p[0]), PAIRS.map((p) => p[1]), PAIRS.map((p) => p[2])];
const BWD = [[...PAIRS].reverse().map((p) => p[1]), [...PAIRS].reverse().map((p) => p[0]),
  [...PAIRS].reverse().map((p) => `назад: ${p[2]}`)];

const LEDGER_INSERT = (tag) => [
  "  insert into public.migration_ledger (name)",
  `  values ('${DST_NAME}');`,
  "  get diagnostics v_rows = row_count;",
  "  if v_rows <> 1 then",
  `    raise exception '${tag}: рядок леджера не ліг (% рядків)', v_rows;`,
  "  end if;",
].join("\n");

/** Поведінковий зонд: три реєстрації через тригер у ТІЙ САМІЙ транзакції (відкат ззовні). */
const BEHAVIOR_PROBE = (tag) => [
  "  -- ── Поведінка тригера: три рядки auth.users без `managed` — тригер сам створює",
  "  --    центр і профіль; читаємо, що лягло. Усе відкочується (raise/rollback ззовні) ──",
  "  v_u1 := gen_random_uuid(); v_u2 := gen_random_uuid(); v_u3 := gen_random_uuid();",
  "  v_sfx := replace(gen_random_uuid()::text, '-', '');",
  "  insert into auth.users (id, email, encrypted_password, email_confirmed_at, aud, role, raw_user_meta_data) values",
  "    (v_u1, 'probe1.' || v_sfx || '@radflow.test', 'x', now(), 'authenticated', 'authenticated',",
  "     jsonb_build_object('login', 'probe1' || left(v_sfx, 8),",
  "       'clinic_name', E'   Центр \\t  «Проба»  \\n  ' || repeat('щ', 250),",
  "       'full_name', E'  Іван  \\n\\t Петренко   ', 'phone', '+380501234567')),",
  "    (v_u2, 'probe2.' || v_sfx || '@radflow.test', 'x', now(), 'authenticated', 'authenticated',",
  "     jsonb_build_object('login', 'probe2' || left(v_sfx, 8), 'clinic_name', '   ', 'full_name', E'\\t \\n')),",
  "    (v_u3, 'probe3.' || v_sfx || '@radflow.test', 'x', now(), 'authenticated', 'authenticated',",
  "     jsonb_build_object('managed', 'true', 'clinic_name', 'НЕ МАЄ З''ЯВИТИСЬ', 'full_name', 'НЕ МАЄ'));",
  "  select c.name, p.full_name, p.login into v_cn, v_fn, v_lg",
  "    from public.profiles p join public.clinics c on c.id = p.clinic_id where p.id = v_u1;",
  "  if v_cn is null or v_fn is null then",
  `    raise exception '${tag}: проба 1 — профіль/центр не створено';`,
  "  end if;",
  "  if length(v_cn) <> " + NAME_MAX + " or v_cn not like 'Центр «Проба» щщщ%' or v_cn ~ '\\s\\s' or v_cn ~ '^\\s|\\s$' then",
  `    raise exception '${tag}: проба 1 — назва центру не обрізана: довжина %, «%»', length(v_cn), left(v_cn, 40);`,
  "  end if;",
  "  if v_fn is distinct from 'Іван Петренко' then",
  `    raise exception '${tag}: проба 1 — ПІБ не схлопнуто: «%»', v_fn;`,
  "  end if;",
  "  select c.name, p.full_name, p.login into v_cn, v_fn, v_lg",
  "    from public.profiles p join public.clinics c on c.id = p.clinic_id where p.id = v_u2;",
  "  if v_cn is distinct from v_lg or v_fn is distinct from v_lg then",
  `    raise exception '${tag}: проба 2 — порожнє після обрізки мало дати логін (%), а дало «%» / «%»', v_lg, v_cn, v_fn;`,
  "  end if;",
  "  if exists (select 1 from public.profiles where id = v_u3) or exists (select 1 from public.clinics where name = 'НЕ МАЄ З''ЯВИТИСЬ') then",
  `    raise exception '${tag}: проба 3 — managed-акаунт отримав профіль/центр від тригера';`,
  "  end if;",
].join("\n");
const PROBE_DECL = ["  v_u1 uuid; v_u2 uuid; v_u3 uuid; v_sfx text; v_cn text; v_fn text; v_lg text;"];

/** Тіло накату — спільне для apply і dryrun. */
const FORWARD = (tag) => [
  PRE(tag),
  LEDGER_GUARDS(tag),
  readGuard(tag, PRE_MD5, PRE_LEN, PRE_PIN, "0204"),
  PREMISES(tag),
  "",
  `  -- ── 1. ${HNU}: обрізка clinic_name / full_name (Н-22(а)) ──`,
  fnExec("$fxa$", HNU_NEW_STMT),
  indent(HNU_ACL_DDL),
  hnuRow19(tag, HNU_NEW_REC19, "після заміни"),
  fnAttrsAssert(tag, HNU_REGPROC, `${HNU} після заміни`, HNU_NEW_RAW),
  fnAclAssert(tag, HNU_REGPROC),
  trigAssert(tag),
  "",
  "  -- ── 2. Передрук сторожа: рядок №19 і абзац ─────────────────────────────",
  substitute(tag, "v_from", "v_to", "v_lbl", NEW_MD5, NEW_LEN, "файл 0205"),
  "",
  pinBlock(tag, PIN),
  "",
  Q_ASSERT(tag, "№19", Q19_NEW, "після передруку"),
  "",
  SENTINEL(tag, "після передруку"),
  "",
  BEHAVIOR_PROBE(tag),
  "",
  LEDGER_INSERT(tag),
].join("\n");

const READBACK = [
  "select md5(replace(p.prosrc, chr(13), '')) as guard_md5,",
  "       length(replace(p.prosrc, chr(13), '')) as guard_len,",
  "       obj_description(p.oid, 'pg_proc') as guard_pin,",
  "       (select count(*) from public.migration_ledger) as ledger_rows,",
  "       (select max(name) from public.migration_ledger) as ledger_last,",
  `       (select md5(replace(f.prosrc, chr(13), '')) from pg_proc f where f.oid = to_regprocedure('${HNU_REGPROC}')) as hnu_raw_md5,`,
  `       (select length(replace(f.prosrc, chr(13), '')) from pg_proc f where f.oid = to_regprocedure('${HNU_REGPROC}')) as hnu_len,`,
  "       (select array_to_string(array(select t from unnest(f.proacl::text[]) t order by t collate \"C\"), ',')",
  `          from pg_proc f where f.oid = to_regprocedure('${HNU_REGPROC}')) as hnu_acl,`,
  "       (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace",
  "         where c.relname = 'users' and n.nspname = 'auth' and t.tgname = 'on_auth_user_created' and t.tgenabled = 'O') as hnu_trigger",
  "  from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  " where n.nspname = 'public' and p.proname = 'invariants_check'",
  "   and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';",
].join("\n");

const RED_WINDOW = [
  "-- ⚠️ ЧЕРВОНЕ ВІКНО (AGENTS.md, «Миграции и БД»): з commit цього блоку і до пушу",
  "--    `main` з файлом 0205 падає КОЖНА прод-збірка (гейт: рядок леджера без файла",
  "--    на диску). У вікні: жодного Redeploy, нічого іншого в `main`. Закрити ОДНИМ",
  "--    заходом: `npm run db:gate` → `npm test` → гілка → dev → main → push → деплой;",
  "--    перевірка — `npm run db:gate:check` на `main` І на `dev`. Не закрили в цей",
  "--    захід — `scripts/frag/0205_rollback.sql`, а не «доробимо завтра». Ліміт",
  "--    03:50 UTC (06:50 Київ) — на ВЕСЬ відрізок «накат → db:gate».",
].join("\n");

const APPLY = [
  "-- 0205 APPLY — ЗГЕНЕРОВАНО `node scripts/build-0205-reprint.mjs`. Одним запитом,",
  "-- ОДНА транзакція: handle_new_user + ACL → передрук сторожа (рядок №19 + абзац) →",
  "-- пін → запит №19 дослівно → ПОВНИЙ сторож → поведінкова проба (відкочується",
  "-- raise-ом? НІ — у apply проба лишає три рядки! див. нижче) → леджер.",
  "-- ⚠️ ПОВЕДІНКОВА ПРОБА В APPLY ВИМКНЕНА: у транзакції, що КОМІТИТЬСЯ, три тестові",
  "--    auth.users лишились би в проді. Поведінку доводять dryrun (відкат) і falsify.",
  "-- ⚠️ Канонічний файл міграції накатувати НЕ можна (кілька верхньорівневих",
  "--    стейтментів; тут — суворий предстан, у файлі — ідемпотентний).",
  "-- ⚠️ ТЕКСТ СЛАТИ ДОСЛІВНО (краще — базою через net.http_get, AGENTS.md с79):",
  "--    тіло функції всередині $fxa$ і якорі всередині $q$ входять у md5 —",
  "--    «прибрати рядки-коментарі» зламає пост-перевірки, і накат зупиниться.",
  RED_WINDOW,
  DECL("apply", ...FWD),
  FORWARD("apply").replace(BEHAVIOR_PROBE("apply"), "  -- (поведінкова проба — лише у dryrun і falsify: тут транзакція комітиться)"),
  "end",
  "$apply$;",
  "",
  "-- Контрольне читання ПІСЛЯ commit (окремим запитом):",
  "-- " + READBACK.split("\n").join("\n-- "),
  `-- Очікувано: guard_md5 = ${NEW_MD5}, guard_len = ${NEW_LEN}, guard_pin = ${PIN},`,
  `--            ledger_last = ${DST_NAME}, hnu_raw_md5 = ${HNU_NEW_RAW}, hnu_len = ${HNU_NEW_LEN},`,
  `--            hnu_acl = ${FN_ACL}, hnu_trigger = 1.`,
].join("\n");

const DRYRUN = [
  "-- 0205 DRYRUN — ЗГЕНЕРОВАНО `node scripts/build-0205-reprint.mjs`. Те саме, що apply,",
  "-- плюс поведінкова проба (три реєстрації через тригер) і `raise` у кінці — усе",
  "-- відкочується. Очікуваний текст винятку починається з `DRYRUN_0205_ROLLBACK`.",
  "-- Будь-який інший текст — справжня відмова (передумова, якір, md5, сторож).",
  DECL("dryrun", ...FWD, PROBE_DECL),
  FORWARD("dryrun"),
  "",
  "  raise exception 'DRYRUN_0205_ROLLBACK guard=% len=% pin=% hnu_raw=% hnu_rec19_ok=true probes=3/3 ledger_last=%',",
  "    md5(v_src), length(v_src), v_pin_db,",
  `    (select md5(replace(f.prosrc, chr(13), '')) from pg_proc f where f.oid = to_regprocedure('${HNU_REGPROC}')),`,
  "    (select max(name) from public.migration_ledger);",
  "end",
  "$dryrun$;",
].join("\n");

const ROLLBACK = [
  "-- 0205 ROLLBACK — ЗГЕНЕРОВАНО `node scripts/build-0205-reprint.mjs`. Повертає",
  "-- handle_new_user до тіла 0124, тіло сторожа до 0204 (ті самі якорі назад),",
  "-- самопін 0204, знімає рядок леджера. Реєстрації, що пройшли через 0205, не чіпає",
  "-- (назви вже обрізані — це не шкода). ОДНА транзакція.",
  DECL("back", ...BWD),
  PRE("back"),
  `  if not exists (select 1 from public.migration_ledger where name = '${DST_NAME}') then`,
  "    raise exception 'back: рядка 0205 у леджері немає — відкочувати нічого';",
  "  end if;",
  "  if (select max(name) from public.migration_ledger) is distinct from",
  `     '${DST_NAME}' then`,
  "    raise exception 'back: останній рядок леджера % — не 0205, черга зсунулась',",
  "      (select max(name) from public.migration_ledger);",
  "  end if;",
  readGuard("back", NEW_MD5, NEW_LEN, PIN, "0205"),
  fnAttrsAssert("back", HNU_REGPROC, `${HNU} 0205`, HNU_NEW_RAW),
  "",
  `  -- ── 1. ${HNU}: тіло 0124 назад ──`,
  fnExec("$fxa$", HNU_PRE_STMT),
  indent(HNU_ACL_DDL),
  hnuRow19("back", HNU_PRE_REC19, "після відкату"),
  fnAttrsAssert("back", HNU_REGPROC, `${HNU} після відкату`, HNU_PRE_RAW),
  fnAclAssert("back", HNU_REGPROC),
  trigAssert("back"),
  "",
  "  -- ── 2. Тіло сторожа 0204 назад (якорі у зворотному порядку) ──",
  substitute("back", "v_from", "v_to", "v_lbl", PRE_MD5, PRE_LEN, "файл 0204"),
  "",
  pinBlock("back", PRE_PIN),
  "",
  Q_ASSERT("back", "№19", Q19_OLD, "після відкату"),
  "",
  "  -- ── Рядок леджера — ДО повного сторожа (ревʼю с83, лінза A, High): відкат",
  "  --    передбачено для вікна «накат → db:gate», коли md5 рядка 0205 ще NULL, і №7",
  "  --    `ledger_md5` з ним у леджері був би червоним. Після зняття рядка сторож",
  "  --    перевіряє вже КІНЦЕВИЙ стан — той, що лишиться після commit. ──",
  `  delete from public.migration_ledger where name = '${DST_NAME}';`,
  "  get diagnostics v_rows = row_count;",
  "  if v_rows <> 1 then",
  "    raise exception 'back: рядок леджера не знято (% рядків)', v_rows;",
  "  end if;",
  "",
  SENTINEL("back", "після відкату"),
  "end",
  "$back$;",
  "",
  "-- Контрольне читання ПІСЛЯ commit (окремим запитом):",
  "-- " + READBACK.split("\n").join("\n-- "),
  `-- Очікувано: guard_md5 = ${PRE_MD5}, guard_len = ${PRE_LEN}, guard_pin = ${PRE_PIN},`,
  `--            ledger_last = ${PREV_LEDGER}, hnu_raw_md5 = ${HNU_PRE_RAW}, hnu_len = ${HNU_PRE_LEN}.`,
].join("\n");

const FALSIFY = [
  "-- 0205 FALSIFY — ЗГЕНЕРОВАНО `node scripts/build-0205-reprint.mjs`. Запускати ПІСЛЯ",
  "-- накату (леджер на 0205). ОДНА транзакція, у кінці `raise` — усе відкочується.",
  "-- Спершу — ПОВНИЙ сторож (зелена базова лінія; ledger_md5 лише з offender-ом 0205,",
  "-- бо db:gate ще попереду), потім проби:",
  "--   A. тіло 0124 назад → запит №19 дослівно мусить назвати РІВНО",
  `--      body:${HNU_SIG}->${HNU_PRE_REC19} (а не мовчати і не «raised:»);`,
  "--   B. тіло 0205 назад → №19 зелений;",
  "--   C. вихолощене тіло (return new без insert) → №19 червоний `body:` і ТОЙ САМИЙ",
  "--      тригер стоїть (гілка auth_trigger не бреше про функцію);",
  "--   D. поведінка: три реєстрації через тригер — обрізка, фолбек на логін, managed.",
  "-- Очікуваний текст винятку починається з `FALSIFY_0205 verdict=PASS`.",
  "set statement_timeout = '5min';",
  "do $falsify$",
  "declare",
  "  v_tmp text[]; v_atg text; v_bad text[]; v_acl text; v_res jsonb; v_failed text[]; v_src text; v_def text; v_body text; v_head text;",
  ...PROBE_DECL,
  "begin",
  PRE("falsify"),
  `  if (select max(name) from public.migration_ledger) is distinct from '${DST_NAME}' then`,
  "    raise exception 'falsify: леджер не на 0205 — фальсифікувати нічого';",
  "  end if;",
  readGuard("falsify", NEW_MD5, NEW_LEN, PIN, "0205"),
  fnAttrsAssert("falsify", HNU_REGPROC, `${HNU} 0205`, HNU_NEW_RAW),
  SENTINEL_PRE_GATE("falsify", "до проб"),
  "",
  "  -- ── A. тіло 0124 назад → №19 мусить назвати body: з дайджестом 0124 ──",
  fnExec("$fxa$", HNU_PRE_STMT),
  Q_EXPECT_RED("falsify", "№19", Q19_NEW, sqlArr([`body:${HNU_SIG}->${HNU_PRE_REC19}`]), "на тілі 0124"),
  "",
  "  -- ── B. тіло 0205 назад → №19 зелений ──",
  fnExec("$fxa$", HNU_NEW_STMT),
  Q_ASSERT("falsify", "№19", Q19_NEW, "на тілі 0205"),
  "",
  "  -- ── C. вихолощене тіло: тригер той самий, тіло інше → body: (дайджест вихолощеного) ──",
  fnExec("$fxa$", HNU_STMT_OF("\nbegin\n  return new;\nend;\n")),
  Q19_NEW,
  "  if v_tmp is null or array_length(v_tmp, 1) <> 1 or v_tmp[1] not like 'body:" + HNU_SIG + "->%' then",
  "    raise exception 'falsify: C — вихолощене тіло мусило дати рівно один body:, а дало %', coalesce(v_tmp::text, '(NULL — зелений)');",
  "  end if;",
  "  if v_atg is distinct from '" + HNU_TRIGGER_DEF + "/O' then",
  "    raise exception 'falsify: C — тригер змінився, а не мав: %', coalesce(v_atg, '(NULL)');",
  "  end if;",
  fnExec("$fxa$", HNU_NEW_STMT),
  Q_ASSERT("falsify", "№19", Q19_NEW, "після відновлення 0205"),
  "",
  "  -- ── D. поведінка ──",
  BEHAVIOR_PROBE("falsify"),
  "",
  "  raise exception 'FALSIFY_0205 verdict=PASS probes=A,B,C,D guard=% hnu_raw=%', md5(v_src),",
  `    (select md5(replace(f.prosrc, chr(13), '')) from pg_proc f where f.oid = to_regprocedure('${HNU_REGPROC}'));`,
  "end",
  "$falsify$;",
].join("\n");

// ---------------------------------------------------------------------------
// 9. КАНОНІЧНИЙ ФАЙЛ МІГРАЦІЇ (ідемпотентний предстан, без тегів фрагментів).
// ---------------------------------------------------------------------------
const MIG_PRE = [
  "do $pre$",
  "declare v_src text; v_hnu text; v_atg text;",
  "begin",
  "  perform set_config('search_path', 'public, pg_temp', true);",
  "  if current_user <> 'postgres' then",
  "    raise exception '0205: мусить іти від ролі postgres, а йде від %', current_user;",
  "  end if;",
  `  if not exists (select 1 from public.migration_ledger where name = '${PREV_LEDGER}') then`,
  "    raise exception '0205: у леджері немає 0204 — накат не в свою чергу';",
  "  end if;",
  "  if (select max(name) from public.migration_ledger) not in",
  `     ('${PREV_LEDGER}', '${DST_NAME}') then`,
  "    raise exception '0205: останній рядок леджера % — не 0204/0205, черга зсунулась',",
  "      (select max(name) from public.migration_ledger);",
  "  end if;",
  "  select replace(p.prosrc, chr(13), '') into v_src",
  "    from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  "   where n.nspname = 'public' and p.proname = 'invariants_check'",
  "     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';",
  `  if md5(v_src) not in ('${PRE_MD5}', '${NEW_MD5}') then`,
  "    raise exception '0205: тіло сторожа % — ні 0204, ні 0205; правка наосліп заборонена', md5(v_src);",
  "  end if;",
  `  select md5(replace(p.prosrc, chr(13), '')) into v_hnu from pg_proc p where p.oid = to_regprocedure('${HNU_REGPROC}');`,
  `  if v_hnu is null or v_hnu not in ('${HNU_PRE_RAW}', '${HNU_NEW_RAW}') then`,
  `    raise exception '0205: ${HNU} — ні тіло 0124, ні 0205 (%); правка наосліп заборонена', coalesce(v_hnu, '(NULL)');`,
  "  end if;",
  "  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace",
  `        and p.proname = '${HNU}') <> 1 then`,
  `    raise exception '0205: ${HNU} має перевантаження — create or replace не про ту функцію';`,
  "  end if;",
  trigAssert("0205"),
  "end",
  "$pre$;",
].join("\n");

const MIG_CHK = [
  "do $chk$",
  "declare v_res jsonb; v_failed text[];",
  "begin",
  SENTINEL_CALL,
  `  if (v_res->>'checked')::int <> ${CHECKED} then`,
  `    raise exception '0205: сторож перевірив % замість ${CHECKED}', v_res->>'checked';`,
  "  end if;",
  "  -- ідемпотентно: ledger_md5 допустима лише з offender-ом самої 0205 (повторний прогін до db:gate)",
  "  select array_agg(e.value->>'check' order by e.value->>'check') into v_failed",
  "    from jsonb_array_elements(v_res->'failed') e",
  `   where e.value->>'check' not in ${KNOWN_RED_SQL}`,
  "     and not (e.value->>'check' = 'ledger_md5'",
  `              and e.value->'offenders' = jsonb_build_array('${DST_NAME}'));`,
  "  if v_failed is not null then",
  "    raise exception '0205: після передруку сторож червоний: % — %', v_failed, v_res->'failed';",
  "  end if;",
  "end",
  "$chk$;",
].join("\n");

const MIG_POST = [
  "do $post$",
  "declare v_acl text; v_src text; v_atg text;",
  "begin",
  "  perform set_config('search_path', 'public, pg_temp', true);",
  "  select replace(p.prosrc, chr(13), '') into v_src",
  "    from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  "   where n.nspname = 'public' and p.proname = 'invariants_check'",
  "     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';",
  `  if md5(v_src) is distinct from '${NEW_MD5}' or length(v_src) <> ${NEW_LEN}`,
  "     or obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc')",
  "        is distinct from 'guard_body_md5=' || md5(v_src) || ';len=' || length(v_src) then",
  "    raise exception '0205: тіло сторожа або самопін не ті: % / %', md5(v_src), length(v_src);",
  "  end if;",
  "  -- ── Функція після заміни: атрибути, сирий md5, ACL, тригер ──",
  fnAttrsAssert("0205", HNU_REGPROC, `${HNU} після заміни`, HNU_NEW_RAW),
  fnAclAssert("0205", HNU_REGPROC),
  trigAssert("0205"),
  "end",
  "$post$;",
].join("\n");

const MIG_HEAD = [
  "-- ============================================================================",
  "--  RadFlow — Міграція 0205: `handle_new_user` обрізає `clinic_name` / `full_name`",
  "--  як форма реєстрації (Н-22(а)); передрук сторожа (рядок №19, самопін №25).",
  "--",
  "--  Максимальна ЗАСТОСОВАНА на момент написання — 0204.",
  `--  \`checked\` ${CHECKED} -> ${CHECKED}. №19 — рядок \`${HNU_SIG}\` (склад 60), абзац прози; №25 — самопін.`,
  "--  №14 / №16 / №17 / №22 / №23 / №26 — без змін (генератор доводить: код тіла",
  "--  без коментарів відрізняється від 0204 рівно одним рядком). Даних не змінює",
  "--  (діє лише на МАЙБУТНІ реєстрації). DDL на таблицях немає, замків немає.",
  "--",
  "--  ЗВІДКИ ПАКЕТ — борг Н-22(а) (ревʼю с82, лінза A, Low; ToDo §3):",
  "--   форма реєстрації (`components/RegisterPage.tsx`) тримає межі назви центру і",
  "--   ПІБ — `trim()`, `replace(/\\s+/g, \" \")`, NAME_MAX = 200 — а тригер брав metadata",
  "--   як є. Власник anon-ключа кладе в `signUp` будь-що (інʼєкції немає —",
  "--   параметризовані insert, лише сміття в назві); межа жила лише у формі.",
  "--",
  "--  ЩО ЗМІНЮЄТЬСЯ:",
  `--   1. \`${HNU_SIG}\`: дві змінні; \`clinic_name\` / \`full_name\` → пробіли`,
  `--      схлопуються, краї зрізаються, до ${NAME_MAX} символів; порожнє після обрізки —`,
  "--      як і раніше: логін / «Моя клініка». Тригер РІЖЕ, а не відмовляє: виняток",
  "--      відкотив би сам insert в auth.users («Database error saving new user»).",
  "--      Гілка `managed`, обчислення логіна, телефон — побайтово 0124.",
  "--   2. Передрук сторожа: №19 — новий дайджест рядка (attrs ті самі), абзац; №25.",
  "--",
  "--  ⚠️ ЦІНА І НАСЛІДКИ, названі заздалегідь:",
  "--     • реєстрація з назвою довшою за 200 символів не відмовляє, а ріже — у",
  "--       форму це не потрапляє (там відмова), лише в прямий `signUp`;",
  "--     • `\\s` у regexp Postgres — `[[:space:]]`; JS `\\s` ширший на кілька",
  "--       Unicode-пробілів (NBSP тощо) — таке не схлопнеться, але й не зламає нічого;",
  "--     • тіло функції у проді з 0124 мало CRLF (сирий md5 1f8ab9ae…/1283); після",
  "--       накату з GitHub (LF) — " + HNU_NEW_RAW + "/" + HNU_NEW_LEN + ". Рецепт №19 CR не бачить.",
  "--",
  "--  ЯК НАКОЧУВАТИ (канон 0203/0204):",
  "--   1. `node scripts/build-0205-reprint.mjs` → цей файл + `scripts/frag/0205_*.sql`.",
  "--   2. Тимчасова гілка на GitHub ЛИШЕ з фрагами → `net.http_get` → sha256 =",
  "--      контейнер → `scripts/frag/0205_dryrun.sql` (виняток `DRYRUN_0205_ROLLBACK …`).",
  "--   3. `scripts/frag/0205_apply.sql` (commit) → контрольне читання.",
  "--   4. `scripts/frag/0205_falsify.sql` (виняток `FALSIFY_0205 verdict=PASS …`).",
  "--   5. `supabase/smoke/0205_new_user_name_trim_smoke.sql` → `SMOKE_OK`.",
  "--   6. `npm run db:gate` (ЛИШЕ з машини власника) → `invariants_check`: failed лише",
  `--      ${KNOWN_RED.join(", ")} (або порожньо).`,
  "--   7. git ОДНИМ заходом: гілка → dev → main → push → штамп деплою; вікно",
  "--      закрите, коли `npm run db:gate:check` зелений на `main` І на `dev`. Не",
  "--      закрили 6–7 у цей захід — `scripts/frag/0205_rollback.sql`, а не",
  "--      «доробимо завтра».",
  "--   8. ⚠️ ПІСЛЯ КРОКУ 6 генератор НЕ ЗАПУСКАТИ (перезаписує файл із md5 у леджері).",
  "-- ============================================================================",
  "",
  "begin;",
  "",
  "-- ── 0. Предстан (ідемпотентний: 0204 або вже 0205) ─────────────────────────",
  MIG_PRE,
  "",
  `-- ── 1. ${HNU}: обрізка clinic_name / full_name (Н-22(а)) ──────────────────`,
  HNU_NEW_STMT,
  "",
  HNU_ACL_DDL,
  "",
  "-- ── 2. Передрук сторожа: рядок №19 і абзац ──────────────────────────────────",
  "",
].join("\n");

const MIG_TAIL = [
  "",
  `comment on function public.invariants_check(boolean) is '${PIN}';`,
  "",
  "-- ── 3. ПОВНИЙ сторож після передруку (≈9 с; має бути зеленим, крім названого №13) ─",
  MIG_CHK,
  "",
  "-- ── 4. Пост-асерти: тіло сторожа, самопін, функція, ACL, тригер ─────────────",
  MIG_POST,
  "",
  "insert into public.migration_ledger (name)",
  `values ('${DST_NAME}')`,
  "on conflict (name) do nothing;",
  "",
  "commit;",
  "",
  "-- ============================================================================",
  "-- === ВІДКАТ ===",
  "--",
  "--  1. База: `scripts/frag/0205_rollback.sql` — `handle_new_user` → тіло 0124",
  `--     (${HNU_PRE_RAW}), тіло сторожа 0204 (${PRE_MD5} / ${PRE_LEN}), самопін 0204,`,
  "--     рядок леджера. Реєстрації, що пройшли через 0205 (назви вже обрізані),",
  "--     відкат не чіпає. Перевіряти ОКРЕМИМ запитом після commit.",
  "--  2. Git — ОДНИМ кроком: видалити цей файл, `scripts/frag/0205_*.sql`,",
  "--     `scripts/build-0205-reprint.mjs`, `supabase/smoke/0205_new_user_name_trim_smoke.sql`,",
  "--     `tests/newUserNameTrim0205.test.ts`; абзац 0205 в `AGENTS.md`",
  "--     («Создание аккаунтов и пароли») і рядок Н-22(а) у ToDo.",
  "-- ============================================================================",
].join("\n");

const MIG = MIG_HEAD + "\n" + SRC.prologue + NEW_BODY + "$function$;\n" + MIG_TAIL + "\n";

{
  const heads = MIG.match(REPRINT_RE_G) || [];
  if (heads.length !== 1) throw new Error(`ФАЙЛ: заголовків передруку ${heads.length}, а треба 1`);
  const loose = MIG.indexOf("create or replace function public.invariants_check");
  const anchored = MIG.search(/^create or replace function public\.invariants_check/m);
  if (loose !== anchored) throw new Error(`ФАЙЛ: фраза create-or-replace сторожа вперше на ${loose}, а заголовок на ${anchored}`);
  const pins = [...MIG.matchAll(GUARD_PIN_RE)].map((m) => m[1]);
  if (pins.length !== 1 || pins[0] !== PIN) throw new Error(`ФАЙЛ: піни ${JSON.stringify(pins)}, а треба рівно ${PIN}`);
  if (count(MIG, OPEN) !== 1 || count(MIG, CLOSE) !== 1) throw new Error("ФАЙЛ: межі тіла не унікальні");
  for (const t of ["$apply$", "$dryrun$", "$back$", "$falsify$", "$fxa$", "$q$"]) {
    if (MIG.includes(t)) throw new Error(`ФАЙЛ містить тег фрагмента ${t}`);
  }
  const tail = MIG.slice(MIG.lastIndexOf("insert into public.migration_ledger (name)"));
  if (!tail.startsWith(`insert into public.migration_ledger (name)\nvalues ('${DST_NAME}')\non conflict (name) do nothing;\n\ncommit;\n`)) {
    throw new Error("ФАЙЛ: рядок леджера не останній перед commit");
  }
  if (count(MIG, "\nbegin;\n") !== 1 || count(MIG, "\ncommit;\n") !== 1) throw new Error("ФАЙЛ: begin/commit не по одному");
  if (MIG.indexOf("=== ВІДКАТ ===") < 0 || MIG.indexOf("=== ВІДКАТ ===") < MIG.indexOf("\ncommit;\n")) throw new Error("ФАЙЛ: секція ВІДКАТ не в кінці");
  if (split === null) throw new Error("unreachable");
  /* Файл має зібратись назад тими самими межами, що й 0204 (витяг split). */
  const chk = (() => {
    const txt = MIG;
    const ddl0 = txt.search(/^create or replace function public\.invariants_check/m);
    const a = txt.indexOf(OPEN, ddl0);
    const b = txt.indexOf(CLOSE, a);
    return txt.slice(a + OPEN.length, b + 1);
  })();
  if (md5(chk) !== NEW_MD5 || chk.length !== NEW_LEN) throw new Error("ФАЙЛ: тіло у файлі ≠ NEW_BODY");
  /* ⚠️ ЯКОРІ СТЕНДІВ У ФАЙЛІ (канон 0203/0204): кожен літерал стенда, що живе в тілі,
     трапляється у файлі рівно стільки разів, скільки в тілі; і жоден
     УНІКАЛЬНИЙ у тілі рядок (≥ 24 знаки) не має копії поза тілом — стенди
     мутують файл останнього передруку ЦІЛКОМ і вимагають унікальності якоря. */
  {
    const dup = [];
    let n = 0;
    for (const x of STAND_LITERALS) {
      const inBody = count(NEW_BODY, x);
      if (!inBody) continue;
      n++;
      const inFile = count(MIG, x);
      if (inFile !== inBody) dup.push(`стенд ${JSON.stringify(x.slice(0, 70))}: тіло ${inBody}, файл ${inFile}`);
    }
    let lines = 0;
    for (const line of new Set(NEW_BODY.split("\n"))) {
      if (line.trim().length < 24 || count(NEW_BODY, line) !== 1) continue;
      lines++;
      if (count(MIG, line) !== 1) dup.push(`рядок ${JSON.stringify(line.trim().slice(0, 70))}: у файлі ${count(MIG, line)}`);
    }
    if (dup.length) throw new Error(`ФАЙЛ: текст тіла скопійовано поза тіло (стенди отримають «ЯКІР НЕ УНІКАЛЬНИЙ»):\n  ${dup.join("\n  ")}`);
    console.log(`  файл: ${n} якорів стендів і ${lines} унікальних рядків тіла — жодної копії поза тілом`);
  }
  // Урок с25: зірочка+слеш у рядковому коментарі шапки закриває блочний коментар достроково
  // (тут сам цей рядок — рядковий, щоб не повторити урок у генераторі).
  const STAR_SLASH = "*" + "/";
  if (MIG.split("\n").filter((l) => /^\s*--/.test(l)).some((l) => l.includes(STAR_SLASH))) throw new Error(`ФАЙЛ: ${STAR_SLASH} у рядковому коментарі`);
  if (exoticWs(MIG_HEAD) || exoticWs(MIG_TAIL)) throw new Error("ФАЙЛ: не-ASCII пробіл у шапці/хвості");
}

for (const [lbl, txt] of [["APPLY", APPLY], ["DRYRUN", DRYRUN], ["ROLLBACK", ROLLBACK], ["FALSIFY", FALSIFY]]) {
  for (const t of ["$pre$", "$chk$", "$post$"]) if (txt.includes(t)) throw new Error(`${lbl} містить тег файлу ${t}`);
  if (lbl !== "FALSIFY" && count(txt, "do $") !== 1) throw new Error(`${lbl}: do-блоків не один`);
}
if (!APPLY.includes("$fxa$") || APPLY.includes(BEHAVIOR_PROBE("apply"))) throw new Error("APPLY: проба не вимкнена або функція не виконується");
if (!DRYRUN.includes("DRYRUN_0205_ROLLBACK") || !FALSIFY.includes("FALSIFY_0205 verdict=PASS")) throw new Error("фрагменти без маркерів відкату");

// ---------------------------------------------------------------------------
// 10. ЗАПИС.
// ---------------------------------------------------------------------------
if (existsSync(DST_MIG) && !FORCE && readFileSync(DST_MIG, "utf8") !== MIG) {
  throw new Error(`${DST_MIG} уже є і відрізняється — після db:gate перезапис заборонено (--force лише свідомо)`);
}
writeFileSync(DST_MIG, MIG);
writeFileSync("scripts/frag/0205_apply.sql", APPLY + "\n");
writeFileSync("scripts/frag/0205_dryrun.sql", DRYRUN + "\n");
writeFileSync("scripts/frag/0205_rollback.sql", ROLLBACK + "\n");
writeFileSync("scripts/frag/0205_falsify.sql", FALSIFY + "\n");
console.log([
  `0205: ${DST_MIG} — ${MIG.length} символів`,
  `  сторож: ${PRE_MD5}/${PRE_LEN} → ${NEW_MD5}/${NEW_LEN}; пін ${PIN}`,
  `  ${HNU}: сирий ${HNU_PRE_RAW}/${HNU_PRE_LEN} → ${HNU_NEW_RAW}/${HNU_NEW_LEN}; рецепт №19 ${HNU_PRE_REC19} → ${HNU_NEW_REC19}`,
  `  список №19: 60 → 60 (змінено 1 рядок); стендів ${STANDS_N}, літералів звірено ${STAND_LITS_CHECKED}`,
  `  фраги: apply ${APPLY.length}, dryrun ${DRYRUN.length}, rollback ${ROLLBACK.length}, falsify ${FALSIFY.length}`,
].join("\n"));
