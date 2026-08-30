/**
 * 0166/0167 — поверхня привілеїв: TRUNCATE у клієнтських ролей і DELETE на
 * простоях.
 *
 * ЧОМУ. TRUNCATE ІГНОРУЄ RLS і не будить тригери, тому його наявність не видно
 * в жодному міркуванні про політики: усі перевірки «а що бачить направник»
 * проходять повз нього. Заміряно на проді перед правкою: TRUNCATE у `anon` І
 * `authenticated` на 17 таблицях і одній вʼюсі. Досяжного шляху сьогодні НЕМАЄ
 * (у public немає жодної функції з TRUNCATE, а PostgREST такого дієслова не
 * має) — це глибина оборони, і саме так про неї треба говорити.
 *
 * Друга половина — `incidents`: грант DELETE у `authenticated` плюс політика
 * `incidents_desk_write` на ALL. Разом — будь-який адмін/реєстратор клініки міг
 * видалити простій прямим викликом PostgREST. Застосунок так не робить ніде:
 * заміряно тим самим методом, що й нижче — 18 входжень `.delete(` у app/,
 * components/, lib/, з них 10 із розпізнаною таблицею (external_refs,
 * radiologist_rooms, services ×2, service_room_overrides ×2, doctors, rooms,
 * google_oauth_states, user_change_markers), решта — Map/Set. Простоїв немає.
 *
 * ⚠️ ЩО СТЕРЕЖЕ ЦЕЙ ФАЙЛ, а що — ні. Vitest тут `environment: "node"` і до БД
 * не ходить: сам ІНВАРІАНТ («TRUNCATE знято») стереже
 * `supabase/smoke/privilege_surface_smoke.sql` і 15-та перевірка
 * `invariants_check`. Тут — те, чого з БД не видно: що міграція не схудла, везе
 * відкат, не чіпає службову роль і не бреше в коментарях; і що припущення, на
 * якому побудований revoke (застосунок не видаляє простої), досі правда.
 *
 * ⚠️ Ревʼю, раунд 2: перша версія читала ЛИШЕ заморожений файл 0166. Це робило
 *    її тавтологічною там, де важливо: 0166 накатано й незмінне, тож «у 0166 є
 *    priv_drift» доводить рівно нуль про СЬОГОДНІШНЬОГО сторожа — наступний
 *    передрук міг би тихо викинути перевірку, і файл лишився б зеленим. Тому
 *    інваріанти сторожа тепер читаються з ОСТАННЬОГО передруку (`latestReprint`),
 *    а з 0166 перевіряється тільки те, що в ньому й заморожено: DDL привілеїв.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { resolve, join } from "path";

const root = process.cwd();
const MIGDIR = resolve(root, "supabase/migrations");
const MIGRATION = "supabase/migrations/0166_privilege_surface.sql";
const HARDENING = "supabase/migrations/0167_privilege_surface_hardening.sql";
const SMOKE = "supabase/smoke/privilege_surface_smoke.sql";
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");

/** ОСТАННЯ міграція, що передруковує сторожа, і тіло цього передруку. */
function latestReprint(): { file: string; body: string } {
  const files = readdirSync(MIGDIR).filter((f) => f.endsWith(".sql")).sort();
  let best = { file: "", body: "" };
  for (const f of files) {
    const txt = readFileSync(resolve(MIGDIR, f), "utf8");
    const at = txt.indexOf("create or replace function public.invariants_check");
    if (at < 0) continue;
    const end = txt.indexOf("\n$function$;", at);
    expect(end, `${f}: не знайшли кінець тіла invariants_check`).toBeGreaterThan(at);
    best = { file: f, body: txt.slice(at, end) };
  }
  return best;
}

describe("міграція 0166 — DDL привілеїв", () => {
  const sql = read(MIGRATION);

  /* Список таблиць у міграції ЯВНИЙ (щоб відкат був поштучним), і саме тому
     його треба стерегти: забути рядок тут — тихо лишити привілей. */
  const TABLES = [
    "audit_log", "ceo_access", "cities", "clinic_deletion_requests", "clinics",
    "doctors", "event_outbox", "incidents", "patient_cases", "profiles",
    "radiologist_rooms", "rate_limits", "referral_access", "referrer_private",
    "rooms", "service_room_overrides", "services", "v_clinic_people",
  ];

  it.each(TABLES)("знімає TRUNCATE на %s у ОБОХ клієнтських ролей", (t) => {
    expect(sql).toMatch(new RegExp(`revoke\\s+truncate\\s+on\\s+public\\.${t}\\s+from\\s+anon,\\s*authenticated`, "i"));
  });

  it("міняє DEFAULT-привілеї — без цього revoke живе до першої нової таблиці", () => {
    expect(sql).toMatch(/alter\s+default\s+privileges\s+for\s+role\s+postgres\s+in\s+schema\s+public\s+revoke\s+truncate\s+on\s+tables\s+from\s+anon,\s*authenticated/i);
  });

  it("знімає DELETE на incidents і розбиває політику ALL на INSERT+UPDATE", () => {
    expect(sql).toMatch(/revoke\s+delete\s+on\s+public\.incidents\s+from\s+anon,\s*authenticated/i);
    expect(sql).toMatch(/drop\s+policy\s+if\s+exists\s+incidents_desk_write\s+on\s+public\.incidents/i);
    expect(sql).toMatch(/create\s+policy\s+incidents_desk_insert\s+on\s+public\.incidents\s+for\s+insert/i);
    expect(sql).toMatch(/create\s+policy\s+incidents_desk_update\s+on\s+public\.incidents\s+for\s+update/i);
    /* Вирази політик мусять лишитись ТИМИ САМИМИ: звуження команд не сміє
       заразом звузити або розширити коло тих, хто пише. */
    const inserts = sql.match(/auth_clinic_id\(\)\) and \(select public\.auth_is_desk\(\)\)/g) || [];
    expect(inserts.length, "вирази політик розійшлись із оригіналом").toBeGreaterThanOrEqual(3);
  });

  it("НЕ чіпає службову роль — на ній інтеграції і скрипти (канон 0163, зона c)", () => {
    const body = sql.slice(sql.indexOf("begin;"), sql.indexOf("=== ВІДКАТ ==="));
    expect(body).not.toMatch(/revoke[^;]*from[^;]*service_role/i);
  });

  it("гілка default_acl звужена до грантора postgres — і це пояснено", () => {
    /* Якби вона перевіряла й `supabase_admin`, сторож був би вічно червоним:
       змінити його default-ACL ми не можемо (немає членства в ролі). Вічно
       червона перевірка — це вимкнена перевірка (урок 0141). */
    expect(sql).toMatch(/d\.defaclrole = 'postgres'::regrole/);
    expect(sql).toMatch(/supabase_admin/);
  });

  it("має секцію відкату в КІНЦІ і повертає рівно те, що зняла", () => {
    const at = sql.indexOf("=== ВІДКАТ ===");
    expect(at, "секції відкату немає").toBeGreaterThan(-1);
    const tail = sql.slice(at);
    expect(tail).toMatch(/grant\s+truncate\s+on/i);
    expect(tail).toMatch(/alter\s+default\s+privileges[\s\S]{0,120}grant\s+truncate/i);
    expect(tail).toMatch(/grant\s+delete\s+on\s+public\.incidents/i);
    expect(tail).toMatch(/create\s+policy\s+incidents_desk_write/i);
    expect(tail).toMatch(/drop\s+trigger\s+if\s+exists\s+a01_no_client_delete/i);
    expect(tail).toMatch(/delete\s+from\s+public\.migration_ledger/i);
    // Відкат мусить повертати ВСІ таблиці, а не перші-ліпші.
    for (const t of TABLES) expect(tail, `відкат не повертає ${t}`).toContain(t);
  });

  it("самореєструється в леджері під власним іменем файлу", () => {
    expect(sql).toMatch(/values \('0166_privilege_surface\.sql'\)/);
  });
});

describe("міграція 0167 — гарт після ревʼю", () => {
  const sql = read(HARDENING);

  it("не накотиться поперед свого попередника", () => {
    /* 0166 такої сторожі не має і вже накатана — виправити її не можна
       (борг U-52). 0167 хоча б не дає повторити помилку далі. */
    const at = sql.indexOf("do $ledger$");
    expect(at, "немає сторожі попередника").toBeGreaterThan(-1);
    const guard = sql.slice(at, sql.indexOf("$ledger$;", at + 10));
    expect(guard).toMatch(/where name = '0166_privilege_surface\.sql'/);
    expect(guard).toMatch(/raise exception/);
  });

  it("спільна відповідь «це клієнт?» — одна на дві розтяжки і НЕ definer", () => {
    const at = sql.indexOf("create or replace function public.request_is_client_role");
    expect(at, "функції немає — тест застарів").toBeGreaterThan(-1);
    const fn = sql.slice(at, sql.indexOf("comment on function", at));
    // У DEFINER `current_user` став би власником, умова — тотожно хибною,
    // і розтяжка мовчки перетворилась би на пустушку (урок 0163).
    expect(fn).not.toMatch(/security\s+definer/i);
    expect(fn).toMatch(/current_user\s+in\s*\(\s*'anon'\s*,\s*'authenticated'\s*\)/i);
    // Головне, що додав 0167: роль із JWT переживає SECURITY DEFINER.
    expect(fn).toMatch(/request\.jwt\.claims/);
    expect(fn).toMatch(/->>\s*'role'/);
  });

  it.each([
    ["guard_no_client_delete", "запис не видаляють"],
    ["guard_no_client_delete_incident", "простій не видаляють"],
  ])("розтяжка %s питає спільну функцію і пропускає каскад", (fnName, msg) => {
    const at = sql.indexOf(`create or replace function public.${fnName}()`);
    expect(at, `тіла ${fnName} немає — тест застарів`).toBeGreaterThan(-1);
    const fn = sql.slice(at, sql.indexOf("$fn$;", at) + 5);
    expect(fn).not.toMatch(/security\s+definer/i);
    expect(fn).toMatch(/public\.request_is_client_role\(\)/);
    /* Без цієї гілки правка мовчки заборонила б видалення клініки й кабінету:
       у RI-каскаді JWT-роль ще жива (канон 0126). */
    expect(fn).toMatch(/pg_trigger_depth\(\)\s*>\s*1/);
    // Повідомлення СВОЄ: у 0163 воно про «запис… скасовують», і для простою
    // це була б неправда.
    expect(fn).toContain(msg);
    expect(fn).toMatch(/errcode = '42501'/);
  });

  it("ставить розтяжку на incidents як BEFORE DELETE", () => {
    expect(sql + read(MIGRATION)).toMatch(
      /create\s+trigger\s+a01_no_client_delete\s+before\s+delete\s+on\s+public\.incidents/i,
    );
  });

  it("канон 8 знає і таблицю, і всі три функції — інакше їх зняли б мовчки", () => {
    const at = sql.indexOf("('table:incidents')");
    expect(at, "перевірка 8 не згадує incidents").toBeGreaterThan(-1);
    for (const f of ["request_is_client_role()", "guard_no_client_delete()",
                     "guard_no_client_delete_incident()"]) {
      expect(sql, `перевірка 8 не стереже ${f}`).toContain(`('function:${f}')`);
    }
  });
});

describe("сторож СЬОГОДНІ (останній передрук, а не заморожений 0166)", () => {
  const latest = latestReprint();

  it("останній передрук знайдено", () => {
    expect(latest.file, "жодна міграція не передруковує invariants_check").not.toBe("");
    expect((latest.body.match(/v_n := v_n \+ 1;/g) || []).length,
      `${latest.file}: перевірок не знайдено — зламався розбір`).toBeGreaterThanOrEqual(15);
  });

  it("priv_drift не зникла з живого сторожа", () => {
    expect(latest.body, `${latest.file}: перевірка priv_drift зникла з передруку`)
      .toMatch(/'check',\s*'priv_drift'/);
  });

  it("не загублено жодної попередньої перевірки", () => {
    for (const name of ["security_invoker", "search_path", "ledger_md5",
                        "room_busy_service_role", "outbox_emit_failed_26h",
                        "ucm_orphan_markers"]) {
      expect(latest.body, `${latest.file}: у передруку зникла перевірка ${name}`)
        .toContain(name);
    }
  });

  it("ролі в priv_drift беруться з членства authenticator, а не хардкодом", () => {
    /* Пара ('anon','authenticated') зробила б нову клієнтську роль (портал,
       кіоск) невидимою сторожу з дня появи.
       ⚠️ Фальсифікація (N17): перша редакція вимагала лише НАЯВНОСТІ рядка
          `authenticator`. Мутація повертала хардкод у гілку (a), лишаючи
          підзапит у гілці (c) — і тест був зелений. Тому рахуємо: підзапит
          мусить стояти в ОБОХ гілках, і хардкоду в тілі бути не сміє. */
    const subq = (latest.body.match(/where a\.rolname = 'authenticator'/g) || []).length;
    expect(subq, "підзапит по членству authenticator не в обох гілках ((a) і (c))")
      .toBeGreaterThanOrEqual(2);
    expect((latest.body.match(/g\.rolname <> 'service_role'/g) || []).length,
      "service_role виключено не в обох гілках").toBeGreaterThanOrEqual(2);
    expect(latest.body, "у priv_drift повернувся хардкод клієнтських ролей")
      .not.toMatch(/\(values \('anon'\), \('authenticated'\)\)/);
  });

  it("гілка (a) бачить і foreign table — грантора supabase_admin ми не контролюємо", () => {
    expect(latest.body).toMatch(/c\.relkind in \('r', 'p', 'v', 'm', 'f'\)/);
  });

  it("гілка (b) ловить default-ACL без `in schema` і грант на PUBLIC", () => {
    /* `alter default privileges` без `in schema` лягає з defaclnamespace = 0:
       inner join її губив, і «головна» гілка обходилась пропуском двох слів.
       Грант на PUBLIC `revoke … from anon` не знімає взагалі. */
    expect(latest.body).toMatch(/left join pg_namespace n on n\.oid = d\.defaclnamespace/);
    expect(latest.body).toMatch(/d\.defaclnamespace = 0 or n\.nspname = 'public'/);
    expect(latest.body).toMatch(/a\.grantee = 0/);
  });

  it("зникла таблиця дає offender, а не вбиває всю функцію", () => {
    /* Виняток усередині сторожа = порожній maintenance_runs = «сторож не
       крутиться». Тому to_regclass, і окремий offender incidents_missing. */
    /* ⚠️ Фальсифікація (N21): перша редакція вимагала лише НАЯВНОСТІ
       `to_regclass`. Мутація знімала сторожу з гілки (c), лишаючи її в (c2) і
       (d) — і тест був зелений. Рахуємо: `is not null` мусить стояти і в (c),
       і в (d), інакше зникла таблиця вбʼє функцію винятком саме там. */
    expect((latest.body.match(/to_regclass\('public\.incidents'\) is not null/g) || []).length,
      "гілки (c)/(d) не захищені to_regclass — зникла таблиця вбʼє сторожа")
      .toBeGreaterThanOrEqual(2);
    expect(latest.body).toMatch(/'incidents_missing'/);
    expect(latest.body).not.toMatch(/'public\.incidents'::regclass/);
  });

  it("гілка (d) звужена до PERMISSIVE і клієнтських ролей", () => {
    /* Інакше звичайний `for all to service_role` або restrictive deny-all
       робив би перевірку вічно червоною, а вічно червона = знята (урок 0141). */
    expect(latest.body).toMatch(/p\.polpermissive/);
    expect(latest.body).toMatch(/q\.rolname in \('anon', 'authenticated'\)/);
  });

  it("гілка (e) стереже САМУ розтяжку — ім'я, тип і невизначеність definer", () => {
    /* Без неї `drop trigger` знімав би сторожу мовчки: її імені не знав жоден
       живий сторож. */
    expect(latest.body).toMatch(/'tripwire:'/);
    expect(latest.body).toMatch(/g\.tgname = 'a01_no_client_delete'/);
    expect(latest.body).toMatch(/\(g\.tgtype & 1\) > 0 and \(g\.tgtype & 2\) > 0 and \(g\.tgtype & 8\) > 0/);
    expect(latest.body).toMatch(/'tripwire_definer:'/);
    expect(latest.body).toMatch(/pr\.prosecdef/);
    for (const t of ["queue_entries", "waitlist_entries", "incidents"]) {
      expect(latest.body, `гілка (e) не стереже розтяжку на ${t}`).toContain(`('${t}')`);
    }
  });
});

describe("смоук 0166 — саме він є регресом", () => {
  const sql = read(SMOKE);
  /* Той самий файл без коментарів: заборони мусять діяти на КОД, інакше
     сторож червоніє на власному поясненні (урок U-33). */
  const code = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

  it("перевіряє TRUNCATE по КАТАЛОГУ, а не за списком", () => {
    /* Список у смоуку означав би, що нова таблиця з привілеєм проїде мовчки —
       рівно те, від чого пакет захищає. */
    expect(sql).toMatch(/from pg_class c join pg_namespace n[\s\S]{0,200}has_table_privilege/);
    expect(sql).not.toMatch(/has_table_privilege\('anon', 'public\.audit_log'/);
  });

  it("має ЧОТИРИ негативні контролі — по одному на кожну гілку priv_drift", () => {
    /* Перша редакція підсаджувала лише TRUNCATE: тоді будь-яку з трьох інших
       гілок можна було зробити тотожно порожньою одним токеном, і зона
       лишалась зеленою — сторож «названий», отже нібито живий (ревʼю 0166). */
    const probes: Array<[string, RegExp, string]> = [
      ["a", /grant truncate on public\.cities to authenticated/, "truncate:authenticated:cities"],
      /* Повний рядок, а не префікс: формат задав 0167
         (`default_acl:<грантор>:<схема>:<грантополучач>`), і саме на
         обрізаному префіксі смоук упав на проді. */
      ["b", /alter default privileges for role postgres in schema public\s*\n?\s*grant truncate on tables to anon/, "default_acl:postgres:public:anon"],
      ["c", /grant delete on public\.incidents to authenticated/, "incidents_delete:authenticated"],
      ["d", /create policy zz_probe_delete on public\.incidents for delete/, "incidents_policy:zz_probe_delete"],
    ];
    for (const [zone, probe, offender] of probes) {
      expect(sql, `зона h(${zone}): немає підсадки`).toMatch(probe);
      /* Головне: звіряється ЗМІСТ offenders, а не факт «priv_drift зʼявилась».
         Інакше одна зламана гілка ховалась би за трьома робочими. */
      expect(sql, `зона h(${zone}): не звіряє власного offender «${offender}»`)
        .toContain(offender);
      expect(sql, `зона h(${zone}): немає власного повідомлення про провал`)
        .toMatch(new RegExp(`SMOKE FAIL h\\(${zone}\\)`));
    }
    // І доводить, що ДО підсадки було зелено — інакше зона нічого не доводить.
    expect(sql).toMatch(/priv_drift червона ще ДО підсадки/);
    // Кожна підсадка знімається одразу після заміру, у тій самій зоні.
    expect(sql).toMatch(/revoke truncate on public\.cities from authenticated/);
    expect(sql).toMatch(/revoke truncate on tables from anon/);
    expect(sql).toMatch(/revoke delete on public\.incidents from authenticated/);
    expect(sql).toMatch(/drop policy if exists zz_probe_delete on public\.incidents/);
  });

  it("немає skip: без фікстури смоук ПАДАЄ, а не друкує зелене", () => {
    /* Перша редакція дописувала ` f:skip g:skip` і все одно друкувала
       SMOKE_OK: оператор бачив зелене там, де не перевірено нічого.
       ⚠️ Заборона — на КОД, не на текст: сам файл пояснює цю історію словами
          «f:skip», і сторож, що читає файл цілком, почервонів би на власному
          коментарі (той самий урок, що body-scoped сторож у U-33). */
    expect(code, "у коді лишився skip — смоук може надрукувати зелене без зон f/g")
      .not.toMatch(/:\s*skip/);
    expect(sql).toMatch(/SMOKE FAIL: немає фікстури/);
  });

  it("розтяжку перевіряє з ПОВЕРНЕНИМИ грантом І політикою", () => {
    /* Без політики RLS відсікла б рядок раніше за тригер (0 рядків, без
       помилки), і зона доводила б лише те саме, що зони (d)/(e) — той самий
       урок, що зона (g) у смоуку 0163. */
    expect(sql).toMatch(/grant delete on public\.incidents to authenticated/);
    expect(sql).toMatch(/create policy zz_smoke_delete on public\.incidents for delete/);
    expect(sql).toMatch(/v_msg not like '%простій не видаляють%'/);
  });

  it("окремо перевіряє, що робочий важіль не зламано", () => {
    expect(sql).toMatch(/desk більше не може створити\/змінити простій/);
  });

  it("фіксує межу платформи видимо, а не мовчки", () => {
    expect(sql).toMatch(/b2:supabase_admin_still_grants/);
    expect(sql).toMatch(/b2:gone/);
  });

  it("завершується SMOKE_OK через exception — інакше сліди лишились би в проді", () => {
    expect(sql).toMatch(/raise exception 'SMOKE_OK/);
  });
});

/* Сторож ПРИПУЩЕННЯ, на якому побудований revoke DELETE: застосунок простої не
   видаляє. Метод — той самий, що в clinicalDeleteGuard (найближчий зліва
   `.from("…")` до кожного `.delete(`), і межа та сама: лексика, не типи.
   Другий канал — вікно ВПЕРЕД від кожного `.from("incidents")` — це
   РЕЗЕРВУВАННЯ на випадок, коли зламається перша регулярка, а не додаткове
   покриття від зловмисника.
   ⚠️ ЗАМІРЯНА МЕЖА (фальсифікація N39): видалення через збережене посилання,
      між оголошенням і викликом якого стоїть чужий `.from(`, вислизає від
      ОБОХ каналів:
          const q = sb.from("incidents"); const r = sb.from("rooms");
          q.delete().eq("id", id);
      Це відомо і залишено свідомо. Цей файл стереже ПРИПУЩЕННЯ, а не барʼєр.
      Барʼєр — у БД: `revoke delete on incidents`, розтяжка
      `a01_no_client_delete` і гілки (c)/(d) перевірки `priv_drift`. Усі три
      заміряні живим смоуком `privilege_surface_smoke.sql`, який жодного
      вихідника не читає, — тобто лексичний обхід нічого не відкриває. */
describe("застосунок не видаляє простої клієнтським ключем", () => {
  const DIRS = ["app", "components", "lib"];

  function walk(dir: string, out: string[] = []): string[] {
    let names: string[];
    try { names = readdirSync(dir); } catch { return out; }
    for (const n of names) {
      const p = join(dir, n);
      let isDir: boolean;
      try { isDir = statSync(p).isDirectory(); } catch { continue; }
      if (isDir) walk(p, out); else if (/\.tsx?$/.test(n)) out.push(p);
    }
    return out;
  }

  function deletedTables(src: string): string[] {
    const out: string[] = [];
    const re = /\.delete\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const before = src.slice(0, m.index);
      const at = before.lastIndexOf(".from(");
      if (at < 0) continue;
      const t = before.slice(at).match(/^\.from\(\s*["'`]([A-Za-z0-9_]+)["'`]\s*\)/);
      if (t) out.push(t[1]);
    }
    return out;
  }

  /** Другий канал (резервування): `.delete(` у ланцюжку одразу після
      `.from("incidents")`. Ловить те саме, що й перший, іншим способом — щоб
      поломка однієї регулярки не лишила припущення без нагляду. */
  function incidentsDeleteWindows(src: string): number {
    let hits = 0;
    const re = /\.from\(\s*["'`]incidents["'`]\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const win = src.slice(m.index, m.index + 300);
      // до кінця виразу: наступний `.from(` починає інший ланцюжок
      const nextFrom = win.slice(1).indexOf(".from(");
      const chain = nextFrom < 0 ? win : win.slice(0, nextFrom + 1);
      if (/\.delete\s*\(/.test(chain)) hits++;
    }
    return hits;
  }

  const files = DIRS.flatMap((d) => walk(resolve(root, d)));

  it("метод не сліпий: інші .delete() у репозиторії видно", () => {
    const all = files.flatMap((f) => deletedTables(readFileSync(f, "utf8")));
    expect(all.length, "жодного .delete() не знайдено — регексп зламався").toBeGreaterThan(0);
  });

  it("другий канал не сліпий: `.from(\"incidents\")` у репозиторії є", () => {
    /* Інакше нульовий результат нижче означав би «регексп зламався», а не
       «простої не видаляють» — тавтологія, від якої цей крок і захищає. */
    const n = files.reduce((acc, f) =>
      acc + (readFileSync(f, "utf8").match(/\.from\(\s*["'`]incidents["'`]\s*\)/g) || []).length, 0);
    expect(n, "жодного .from(\"incidents\") — регексп зламався").toBeGreaterThan(0);
  });

  it("жодного .delete() по incidents (канал 1: найближчий .from зліва)", () => {
    const hits = files.filter((f) => deletedTables(readFileSync(f, "utf8")).includes("incidents"));
    expect(hits.map((f) => f.replace(root, "")),
      "після 0166 клієнтський DELETE простою падає 42501 — завершуйте простій статусом resolved").toEqual([]);
  });

  it("жодного .delete() по incidents (канал 2: вікно вперед від .from)", () => {
    const hits = files.filter((f) => incidentsDeleteWindows(readFileSync(f, "utf8")) > 0);
    expect(hits.map((f) => f.replace(root, "")),
      "після 0166 клієнтський DELETE простою падає 42501 — завершуйте простій статусом resolved").toEqual([]);
  });
});
