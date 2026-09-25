/**
 * Піни пакета 0203 (с79, рішення власника 24.09 і 25.09.2026):
 *   • Р2(б) — аудит-слід `fn_audit()` на `doctors`, `patient_cases`,
 *     `referrer_private` (ПІІ) і `services` (прайс: правку не відновити нічим);
 *   • Н-9 + Р-1 + Р-2 — гард `guard_record_read_keys()` (тригер
 *     `zz_guard_read_keys`): у запису ДВА ключі читання, `referrer_id` і
 *     `created_by` (політики читання пропускають `created_by = auth.uid() or
 *     referrer_id = auth.uid()` без гранту і центру), і ключ без законного
 *     доступу до центру запису гард МОВЧКИ ставить у NULL — не відмовляє.
 *
 * ЩО ТРИМАЄ ЦЕЙ ТЕСТ (і чому саме тут):
 *  • ТІЛО гарда. №19 пінить його md5 (0203 внесла функцію в список, 59 → 60)
 *    — тобто «тіло не змінилось», але не «правило правильне». Властивості
 *    правила стереже цей файл, статично: порожні й незмінні ключі виходять до
 *    будь-якого читання; UPDATE — кожен ключ окремо, зміна центру — обидва;
 *    `referrer_id` — роль `referrer` + грант `active` саме до центру запису,
 *    актор-направник — лише сам; `created_by` — сам актор, адмін/реєстратор
 *    ЦЬОГО центру, направник з активним грантом, актор-направник — лише сам;
 *    реакція — NULL і серверний слід `raise warning` READ_KEY_CLEARED без uuid
 *    і ПДн (ні відмови, ні `return null`, ні `exception when`); `doctor` не
 *    чіпає; `auth.uid()` — лише як актор;
 *  • ПОРЯДОК: гард — ОСТАННІЙ BEFORE-тригер рядка на трьох таблицях. №17 його
 *    не пінить, тому тут — статична симуляція всіх міграцій: жоден BEFORE-
 *    тригер цих таблиць не стоїть за абеткою після `zz_guard_read_keys`;
 *  • md5 тіла гарда, які асертять файл і фрагменти (сирий і рецептом №19),
 *    рахуються тут НЕЗАЛЕЖНО від генератора — з тексту функції у файлі;
 *  • ACL (пастка 0122) і DDL тригерів — у файлі, накаті й сухому прогоні
 *    ДОСЛІВНО однакові (Low-3 ревʼю: правка лише фрагмента мовчала);
 *  • передрук: код без коментарів відрізняється від 0202 РІВНО вісьмома
 *    новими рядками і комою в колишньому останньому рядку №17; `checked` той
 *    самий; пін №25 рахується з тіла; підстановки накату/відкату, виконані тут
 *    у JS, дають рівно тіла 0203/0202;
 *  • порядок накату: повний сторож ДО DDL на таблицях (урок 0196), шукаємо в
 *    КОДІ (Low-2); замір сухого прогону — ДО DDL (Low-4); фальсифікація —
 *    повний сторож ДО мутацій, під мутаціями лише дослівні №17 і №19 (Low-1);
 *  • смоук: кожна проба з міткою, будь-яка помилка — SMOKE_FAIL, ключі
 *    читаються після дії (L2); статуси гранту (L1); H1; успадкування.
 *  НЕ тримає: поведінки в живій базі — її доводять сухий прогін, смоук і
 *  фальсифікація на проді (протокол — `docs/audit/PR-0203-audit-pii-referrer-grant.md`).
 *
 * ⚠️ Читає 0203 ПРИБИТИМ шляхом: накатану міграцію не редагують, тож ці піни
 *    не протухнуть тихо. Наявність семи пар в ОСТАННЬОМУ передруку стереже
 *    `tests/guardTriggersInvariant.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { guardBodyOf, pinFor } from "../scripts/migration-gate-lib.mjs";

const MIGDIR = "supabase/migrations";
const MIG_FILE = "0203_audit_pii_referrer_grant.sql";
const PREV_FILE = "0202_tz_kyiv_no_catalog_scan.sql";
const read = (p: string) => readFileSync(p, "utf8").replace(/\r/g, "");
const MIG = read(resolve(MIGDIR, MIG_FILE));
const PREV = read(resolve(MIGDIR, PREV_FILE));
const APPLY = read("scripts/frag/0203_apply.sql");
const DRYRUN = read("scripts/frag/0203_dryrun.sql");
const ROLLBACK = read("scripts/frag/0203_rollback.sql");
const FALSIFY = read("scripts/frag/0203_falsify.sql");
const SMOKE = read("supabase/smoke/audit_pii_referrer_grant_smoke.sql");

const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
/** Код без коментарів — обидві форми (урок с66): проза гарда свідомо цитує
 *  `auth.uid()` і політики, і наївний пошук зеленів би або червонів на ній. */
const codeOf = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
/** Порядок C (кодові точки) — той, у якому Postgres запускає тригери і №17 віддає offender-и. */
const byC = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const PRE_MD5 = "e1f1fdcfcea99906f02b0af193b814fa";
const PRE_PIN = `guard_body_md5=${PRE_MD5};len=165537`;
const NEW_MD5 = "8c8e6403db7653949e03d026320c6099";
const NEW_LEN = 170446;
const NEW_PIN = `guard_body_md5=${NEW_MD5};len=${NEW_LEN}`;
/** md5 тіла гарда: сирий prosrc і рецепт №19 — з ФІНАЛЬНОГО тексту функції. */
const FN_RAW_MD5 = "55f111f5d83e52b1c7970f06746d7ff6";
const FN_REC19_MD5 = "5da6c3e992832640ec654fe06028f9d6";
const ACL = "postgres=X/postgres,service_role=X/postgres";
const ATTRS = `secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=${ACL}`;
const LEDGER_NAME = "0203_audit_pii_referrer_grant.sql";
const FN = "guard_record_read_keys";
const TG = "zz_guard_read_keys";

const AUDIT = ["doctors", "patient_cases", "referrer_private", "services"] as const;
const GUARDED = ["patient_cases", "queue_entries", "waitlist_entries"] as const;
/** Сім пар пакета (таблиця, тригер). */
const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ...AUDIT.map((t) => [t, `trg_audit_${t}`] as const),
  ...GUARDED.map((t) => [t, TG] as const),
];
const MISSING_SEVEN = PAIRS.map(([t, n]) => `missing:${t}.${n}`).sort(byC);
const MISSING_SQL = `array[${MISSING_SEVEN.map((x) => `'${x}'`).join(", ")}]::text[]`;
const SENTINEL_CALL = "  v_res := public.invariants_check(false);";
/** Серверний слід обнулення (L-a ревʼю р3): таблиця, ключ, роль актора — і
 *  НІЧОГО більше (жодного uuid, жодного поля рядка). */
const WARN_CLEARED = (key: string) =>
  `raise warning 'READ_KEY_CLEARED table=% key=% actor_role=%', tg_table_name, '${key}', coalesce(v_actor_role, 'service');`;
const SENTINEL_ANY_CALL = /invariants_check\s*\((true|false)?\)/;

// ── Гард: стейтмент, тіло (prosrc), код ──────────────────────────────────────
const FN_HEAD = `create or replace function public.${FN}()`;
const FN_STMT = (() => {
  const a = MIG.indexOf(FN_HEAD);
  const b = MIG.indexOf("\n$fnbody$;", a);
  if (a < 0 || b < 0) throw new Error(`${MIG_FILE}: стейтмент гарда не знайдено`);
  return MIG.slice(a, b + "\n$fnbody$;".length);
})();
/** prosrc — від `\n` після `as $fnbody$` до `\n` перед закриттям (як його збереже Postgres). */
const FN_BODY = FN_STMT.slice(FN_STMT.indexOf("as $fnbody$") + "as $fnbody$".length,
  FN_STMT.lastIndexOf("\n$fnbody$;") + 1);
const FN_CODE = codeOf(FN_BODY);
const FN_N = norm(FN_CODE);
const FN_ACL_DDL = `revoke all on function public.${FN}() from public, anon, authenticated;\n` +
  `grant execute on function public.${FN}() to service_role;`;

// ── Передруки сторожа: 0203 і 0202 ───────────────────────────────────────────
const reprintOf = (txt: string, file: string) => {
  const at = txt.search(/^create or replace function public\.invariants_check/m);
  const end = txt.indexOf("\n$function$;", at);
  if (at < 0 || end < 0) throw new Error(`${file}: передрук invariants_check не знайдено`);
  return txt.slice(at, end);
};
const RP_NEW = reprintOf(MIG, MIG_FILE);
const RP_OLD = reprintOf(PREV, PREV_FILE);

/** Запит №17 від `select array_agg(...) into v_tmp` до `) x;` — рівно так, як
 *  його ріже генератор (накат/відкат/фальсифікація звіряють ДОСЛІВНО цей текст). */
const q17Of = (body: string) => {
  const start = "  select array_agg(x.txt order by x.txt) into v_tmp\n    from (\n      select case when a.def is null";
  const endMark = "\n    ) x;\n  if v_tmp is not null then\n    v_fail := v_fail || jsonb_build_array(jsonb_build_object(\n      'check', 'guard_triggers'";
  if (count(body, start) !== 1 || count(body, endMark) !== 1) throw new Error("запит №17: якорі не по одному");
  const a = body.indexOf(start);
  const b = body.indexOf(endMark, a);
  return body.slice(a, b + "\n    ) x;".length);
};
const Q17_NEW = q17Of(RP_NEW);
const Q17_OLD = q17Of(RP_OLD);
/** Запит №19 цілком — від `v_tmp := null;` + читання тригера `auth.users` до
 *  обробника `guard_fn_bodies_raised:` включно. */
const Q19_NEW = (() => {
  const start = "  v_tmp := null;\n  select regexp_replace(pg_get_triggerdef(t.oid), '\\s+', ' ', 'g') || '/' || t.tgenabled::text\n    into v_atg\n";
  const end = "  exception when others then\n    v_tmp := array['guard_fn_bodies_raised:' || sqlstate || ':' || left(sqlerrm, 120)];\n  end;\n";
  if (count(RP_NEW, start) !== 1 || count(RP_NEW, end) !== 1) throw new Error("запит №19: якорі не по одному");
  const a = RP_NEW.indexOf(start);
  return RP_NEW.slice(a, RP_NEW.indexOf(end, a) + end.length).replace(/\n$/, "");
})();
/** Вираз `cur` №19 — рецепт піна тіла й атрибутів. */
const CUR = (() => {
  const open = "    ), cur as (";
  const a = RP_NEW.indexOf(open);
  const b = RP_NEW.indexOf("\n    )\n    select", a);
  if (a < 0 || b < 0 || count(RP_NEW, open) !== 1) throw new Error("вираз cur №19 не знайдено");
  return RP_NEW.slice(a, b);
})();

/** Рендер `pg_get_triggerdef` для стейтментів, як вони написані в 0203:
 *  ключові слова — великими, функція — без схеми (`public` у search_path),
 *  таблиця — зі схемою. */
function renderTrigger(name: string, timing: string, events: string, tbl: string, fn: string): string {
  const [ev, cols] = events.split(" of ");
  const evs = ev.toUpperCase() + (cols ? ` OF ${cols}` : "");
  return `CREATE TRIGGER ${name} ${timing.toUpperCase()} ${evs} ON public.${tbl} FOR EACH ROW EXECUTE FUNCTION ${fn}()`;
}
const DDL_RE = /drop trigger if exists (\w+) on public\.(\w+);\ncreate trigger (\w+)\n {2}(after|before) ([a-z ,_]+?) on public\.(\w+)\n {2}for each row execute function public\.(\w+)\(\);/g;
const DDL = [...codeOf(MIG).matchAll(DDL_RE)].map((m) => ({
  text: m[0], dropName: m[1], dropTbl: m[2], name: m[3], timing: m[4], events: m[5], tbl: m[6], fn: m[7],
}));

/** Пари підстановки з фрагмента (`v_from` / `v_to` — масиви `$p$…$p$`). */
function substPairs(frag: string): { from: string[]; to: string[] } {
  const arr = (label: string) => {
    const m = new RegExp(`\\n {2}${label} +constant text\\[\\] := array\\[`).exec(frag);
    const b = m ? frag.indexOf("\n  ];", m.index) : -1;
    if (!m || b < 0) throw new Error(`масив ${label} не знайдено`);
    return [...frag.slice(m.index, b).matchAll(/\$p\$([\s\S]*?)\$p\$/g)].map((x) => x[1]);
  };
  return { from: arr("v_from"), to: arr("v_to") };
}
/** Та сама підстановка, що в `do`-блоці: кожен якір — рівно один раз. */
function substitute(src: string, from: string[], to: string[]): string {
  let out = src;
  from.forEach((f, i) => {
    expect(count(out, f), `якір №${i + 1} трапляється не рівно раз`).toBe(1);
    out = out.split(f).join(to[i]);
  });
  return out;
}

/** Статична симуляція тригерів з УСІХ міграцій: `create [or replace] trigger`
 *  і `drop trigger` у порядку файлів (код без коментарів). Динамічного DDL
 *  тригерів у міграціях немає (перевірено 25.09); `alter trigger … rename` —
 *  теж. Звірено з реплеєм 203 міграцій (PG 16): ті самі набори. */
function simulateTriggers(files: ReadonlyArray<readonly [string, string]>): Map<string, string> {
  const state = new Map<string, string>();
  /* Ідентифікатор як його зберігає Postgres: без лапок — у НИЖНЬОМУ регістрі
     (`ZZZ_LATE` → `zzz_late`, `Queue_Entries` → `queue_entries`), у лапках — як
     є (Low-R3-1 ревʼю р3: без цього `CREATE TRIGGER ZZZ_LATE …` обходив пін). */
  const id = String.raw`(?:"([^"]+)"|(\w+))`;
  const sch = String.raw`(?:(?:"public"|public)\.)?`;
  const re = new RegExp(String.raw`\b(?:create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+${id}\s+(before|after|instead\s+of)\b[\s\S]*?\bon\s+${sch}${id}` +
    String.raw`|drop\s+trigger\s+(?:if\s+exists\s+)?${id}\s+on\s+${sch}${id})`, "gi");
  const canon = (quoted?: string, bare?: string) => quoted ?? (bare ?? "").toLowerCase();
  for (const [, txt] of files) {
    for (const m of codeOf(txt).matchAll(re)) {
      if (m[3]) state.set(`${canon(m[4], m[5])}/${canon(m[1], m[2])}`, m[3].toLowerCase());
      else state.delete(`${canon(m[8], m[9])}/${canon(m[6], m[7])}`);
    }
  }
  return state;
}
const ALL_MIGS: ReadonlyArray<readonly [string, string]> = readdirSync(MIGDIR)
  .filter((f) => f.endsWith(".sql")).sort().map((f) => [f, read(resolve(MIGDIR, f))] as const);
const beforeOf = (state: Map<string, string>, tbl: string) => [...state]
  .filter(([k, v]) => k.startsWith(`${tbl}/`) && v === "before").map(([k]) => k.split("/")[1]).sort(byC);

describe("0203 — гард guard_record_read_keys() (Н-9, Р-1, Р-2): властивості правила", () => {
  it("визначено один раз, і ОСТАННЄ визначення в репозиторії — у 0203", () => {
    /* №19 тримає md5 тіла, а цей файл — ЗМІСТ правила: нова редакція функції в
       пізнішій міграції мусить пройти крізь цей тест (перенести піни), а не
       лише перезняти md5. */
    expect(count(MIG, FN_HEAD)).toBe(1);
    const later = ALL_MIGS.filter(([f]) => f > MIG_FILE)
      .filter(([, txt]) => new RegExp(`create\\s+(or\\s+replace\\s+)?function\\s+public\\.${FN}\\s*\\(`).test(codeOf(txt)))
      .map(([f]) => f);
    expect(later, "гард перевизначено пізнішою міграцією — перенести піни сюди").toEqual([]);
  });

  it("заголовок: trigger, plpgsql, SECURITY DEFINER, search_path = public, pg_temp", () => {
    expect(norm(FN_STMT.slice(0, FN_STMT.indexOf("as $fnbody$") + "as $fnbody$".length)))
      .toBe(`create or replace function public.${FN}() returns trigger language plpgsql security definer set search_path = public, pg_temp as $fnbody$`);
  });

  it("Р-2: жодної відмови — NULL і рівно два warning-сліди без uuid і ПДн; ні `return null`, ні `exception when`; рівно три `return new;`", () => {
    /* `raise exception` — стара відмова (Р-2 її скасувало); `return null` у
       BEFORE-тригері мовчки ВИКИДАЄ рядок; `exception when` проковтнув би помилку
       читання. `raise warning` (L-a ревʼю р3) — лише серверний слід: запису не
       перериває. Його аргументи пінимо ДОСЛІВНО — uuid ключа, актора чи поле
       рядка (ПІБ, телефон) у лозі сервера — витік. */
    const raises = (FN_CODE.match(/\braise\b[^;]*;/gi) || []).map(norm);
    expect(raises).toEqual([WARN_CLEARED("referrer_id"), WARN_CLEARED("created_by")]);
    for (const r of raises) expect(r, "у сліді — uuid або поле рядка").not.toMatch(/\bnew\.|\bold\.|v_actor\b(?!_role)|auth\.uid/i);
    expect(FN_CODE).not.toMatch(/raise\s+exception|return\s+null|exception\s+when/i);
    expect(count(FN_CODE, "return new;")).toBe(3);
  });

  it("присвоєння — лише двом ключам і лише NULL; `doctor` не чіпає", () => {
    expect((FN_CODE.match(/new\.\w+\s*:=[^;]*;/g) || []))
      .toEqual(["new.referrer_id := null;", "new.created_by := null;"]);
    expect(FN_CODE, "гард торкається тексту направлення").not.toMatch(/doctor/i);
  });

  it("порожні й незмінні ключі виходять ДО будь-якого читання; `auth.uid()` — лише як актор, раз", () => {
    /* масові UPDATE (перенос, статус) ключів не міняють — і не мусять платити
       читанням JWT чи `profiles` за кожен рядок */
    const exit = FN_CODE.indexOf("v_ref := v_ref and new.referrer_id is not null;\n  v_cb := v_cb and new.created_by is not null;\n  if not (v_ref or v_cb) then\n    return new;\n  end if;");
    expect(exit, "ранній вихід для порожніх ключів зник").toBeGreaterThan(0);
    expect(exit).toBeLessThan(FN_CODE.indexOf("auth.uid()"));
    expect(exit).toBeLessThan(FN_CODE.indexOf("select "));
    expect(count(FN_CODE, "auth.uid()")).toBe(1);
    expect(FN_CODE).toContain("  v_actor := auth.uid();\n  v_cb := v_cb and new.created_by is distinct from v_actor;\n  if not (v_ref or v_cb) then\n    return new;\n  end if;");
    /* обходу за сесією немає: службова роль — ті самі правила без гілки актора */
    expect(FN_CODE).not.toMatch(/current_user|session_user|current_setting|request\.jwt|service_role|pg_has_role|rolsuper|replication_role|auth\.(role|jwt)\s*\(/i);
  });

  it("UPDATE: незмінний ключ при незмінному центрі не перевіряється — КОЖЕН окремо; зміна центру — обидва", () => {
    /* `update_patient_details` пише `referrer_id` і незмінним; без пропуску грант,
       відкликаний ПІСЛЯ призначення, стирав би ключ при правці телефону. Пара
       замість окремих ключів (мутація ревʼю) перевіряла б `referrer_id`, коли
       міняють лише `created_by`. */
    expect(FN_CODE).toContain("  if tg_op = 'UPDATE' then\n    if new.clinic_id is not distinct from old.clinic_id then\n" +
      "      v_ref := new.referrer_id is distinct from old.referrer_id;\n" +
      "      v_cb := new.created_by is distinct from old.created_by;\n    end if;\n  end if;");
    expect(count(FN_CODE, "tg_op"), "зʼявилась ще одна гілка за операцією").toBe(1);
    expect(count(FN_CODE, "old."), "стан до правки читається ще десь").toBe(3);
    expect(FN_CODE).toContain("  v_ref boolean := true;\n  v_cb boolean := true;");
  });

  it("referrer_id: роль referrer + грант active саме до центру запису; актор-направник — лише сам (L3)", () => {
    expect(FN_N).toContain(
      "if v_ref then if (v_actor_role = 'referrer' and new.referrer_id is distinct from v_actor) or not exists ( " +
      "select 1 from public.profiles p join public.referral_access ra on ra.referrer_id = p.id " +
      "where p.id = new.referrer_id and p.role = 'referrer' and ra.clinic_id = new.clinic_id and ra.status = 'active' ) then " +
      `new.referrer_id := null; ${WARN_CLEARED("referrer_id")} end if; end if;`);
  });

  it("created_by: сам актор; адмін/реєстратор ЦЬОГО центру; направник з active; актор-направник — лише сам", () => {
    /* радіолог і CEO — лише як актори (їх відсіяно вище через `v_actor`) */
    expect(FN_N).toContain(
      "if v_cb then if v_actor_role = 'referrer' or not exists ( select 1 from public.profiles p where p.id = new.created_by " +
      "and ((p.role in ('admin', 'registrar') and p.clinic_id = new.clinic_id) or (p.role = 'referrer' and exists ( " +
      "select 1 from public.referral_access ra where ra.referrer_id = p.id and ra.clinic_id = new.clinic_id and ra.status = 'active'))) ) then " +
      `new.created_by := null; ${WARN_CLEARED("created_by")} end if; end if;`);
    expect(FN_CODE).toContain("  if v_actor is not null then\n    select p.role::text into v_actor_role\n      from public.profiles p\n     where p.id = v_actor;\n  end if;");
  });

  it("L1: статус гранту — лише `= 'active'`, центр — лише центр запису, в обох гілках", () => {
    /* мутації ревʼю: `status in ('active','pending_referrer')` і `<> 'revoked'` */
    expect(count(FN_CODE, "ra.status"), "статус гранту звіряється не двома `= 'active'`").toBe(2);
    expect(count(FN_CODE, "ra.status = 'active'")).toBe(2);
    expect(count(FN_CODE, "ra.clinic_id = new.clinic_id")).toBe(2);
    expect(FN_CODE).not.toMatch(/ra\.status\s*(<>|!=|in\s*\(|not\s+in)/i);
    expect(count(FN_CODE, "p.clinic_id = new.clinic_id")).toBe(1);
  });

  it("md5 тіла, які асертять файл і фрагменти, рахуються з ЦЬОГО тексту", () => {
    /* Рецепт №19 у PG і JS збігається лише на ASCII-пробілах. */
    expect([...FN_STMT].some((ch) => /\s/.test(ch) && ch !== " " && ch !== "\n"),
      "у тексті гарда є табуляція або не-ASCII пробіл").toBe(false);
    const raw = md5(FN_BODY);
    const rec19 = md5(norm(FN_BODY));
    expect(raw).toBe(FN_RAW_MD5);
    expect(rec19).toBe(FN_REC19_MD5);
    const row = `('${FN}()','${rec19}','${ATTRS}')`;
    /* у ФАЙЛІ — рівно рядок списку №19 у тілі сторожа; рецепт №19 для гарда
       (вираз `cur`, вирізаний із тіла) — лише у фрагментах, у файлі його копії
       немає свідомо (якорі стендів), там — прямі атрибути */
    expect(count(MIG, row), `${MIG_FILE}: рядок №19 гарда не рівно раз`).toBe(1);
    expect(RP_NEW).toContain(`      ${row},\n`);
    for (const [lbl, txt] of [["apply", APPLY], ["dryrun", DRYRUN], ["rollback", ROLLBACK], ["falsify", FALSIFY]] as const) {
      expect(txt, `${lbl}: рядок рецепта №19 для гарда не той`).toContain(row);
      expect(count(txt, `'${raw}'`), `${lbl}: сирого md5 гарда немає`).toBeGreaterThanOrEqual(1);
    }
    /* файл: предстан (ідемпотентність) І пост-асерт */
    expect(count(MIG, `'${raw}'`)).toBe(2);
    const post = codeOf(MIG.slice(MIG.indexOf("do $post$"), MIG.indexOf("$post$;")));
    for (const needle of [
      `and md5(replace(p.prosrc, chr(13), '')) = '${raw}'`,
      "and p.prosecdef and p.provolatile = 'v' and p.prorettype = 'trigger'::regtype",
      "and pg_get_userbyid(p.proowner) = 'postgres' and l.lanname = 'plpgsql'",
      "and p.proconfig = array['search_path=public, pg_temp']",
    ]) expect(post, `пост-асерт файлу: немає «${needle}»`).toContain(needle);
  });

  it("ACL — пастка 0122: revoke одразу за функцією, grant лише службовій ролі, асерт у тій самій транзакції", () => {
    expect(MIG).toContain(`${FN_STMT}\n\n${FN_ACL_DDL}`);
    for (const [lbl, txt] of [[MIG_FILE, MIG], ["apply", APPLY], ["dryrun", DRYRUN]] as const) {
      const code = codeOf(txt);
      expect(code, `${lbl}: EXECUTE гарда роздано клієнтській ролі`)
        .not.toMatch(new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${FN}\\(\\)\\s+to\\s+(?!service_role;)`, "i"));
      for (const needle of [
        `has_function_privilege('anon', 'public.${FN}()', 'EXECUTE')`,
        `has_function_privilege('authenticated', 'public.${FN}()', 'EXECUTE')`,
        `where p.oid = 'public.${FN}()'::regprocedure and a.grantee = 0) then`,
        `if not has_function_privilege('service_role', 'public.${FN}()', 'EXECUTE') then`,
        `if v_acl is distinct from '${ACL}' then`,
      ]) expect(code, `${lbl}: асерту ACL «${needle}» немає`).toContain(needle);
    }
  });

  it("№19: рядок гарда — рівно один, між сусідами за абеткою, і фальсифікація вимагає від №19 `body:`", () => {
    const lines = codeOf(RP_NEW).split("\n");
    const at = lines.findIndex((l) => l.startsWith(`      ('${FN}()','`));
    expect(at, "рядка гарда в №19 немає").toBeGreaterThan(0);
    expect(lines.filter((l) => l.startsWith(`      ('${FN}()','`))).toHaveLength(1);
    expect(lines[at - 1].startsWith("      ('guard_radiologist_scope()','")).toBe(true);
    expect(lines[at + 1].startsWith("      ('guard_referrer_doctor()','")).toBe(true);
    /* B1: порожнє тіло (та сама шапка) → №19 мусить назвати РІВНО його md5 */
    const b1 = FALSIFY.slice(FALSIFY.indexOf("as $fxb$") + "as $fxb$".length, FALSIFY.indexOf("\n$fxb$") + 1);
    expect(b1).toContain("-- falsify 0203 B1: вихолощене тіло\n  return new;");
    expect(md5(norm(b1))).not.toBe(FN_REC19_MD5);
    expect(FALSIFY).toContain(`v_want19 constant text[] := array['body:${FN}()->${md5(norm(b1))}']::text[];`);
    expect(FALSIFY).toContain("v_b19 := v_off19 is not distinct from v_want19;");
  });
});

describe("0203 — сім тригерів і їхній порядок", () => {
  it("рівно сім `drop … if exists` + `create`: аудит AFTER I/D/U на fn_audit; гард BEFORE INSERT OR UPDATE БЕЗ списку колонок", () => {
    const code = codeOf(MIG);
    expect(count(code, "create trigger ")).toBe(7);
    expect(count(code, "drop trigger if exists ")).toBe(7);
    expect(DDL).toHaveLength(7);
    expect(DDL.map((d) => `${d.tbl}.${d.name}`).sort(byC))
      .toEqual(PAIRS.map(([t, n]) => `${t}.${n}`).sort(byC));
    for (const d of DDL) {
      expect([d.dropName, d.dropTbl], `drop не свого тригера перед ${d.tbl}.${d.name}`).toEqual([d.name, d.tbl]);
      if (d.fn === "fn_audit") {
        expect(d.name).toBe(`trg_audit_${d.tbl}`);
        expect([d.timing, d.events], `${d.tbl}: аудит не на всі три операції`).toEqual(["after", "insert or delete or update"]);
      } else {
        expect(d.fn).toBe(FN);
        expect(d.name).toBe(TG);
        /* L4: без `UPDATE OF` — правка ключа, що прийшла не згадкою колонки
           (пізніший тригер, RPC), інакше минала б гард */
        expect([d.timing, d.events], `${d.tbl}: гард не на INSERT + UPDATE без колонок`)
          .toEqual(["before", "insert or update"]);
      }
    }
  });

  it("рендер кожного визначення = рядок №17 у передруку 0203 (інакше прод — `wrong_def:` з першої хвилини)", () => {
    for (const d of DDL) {
      const def = renderTrigger(d.name, d.timing, d.events, d.tbl, d.fn);
      expect(RP_NEW, `рядка №17 для ${d.tbl}.${d.name} немає або він інший`)
        .toMatch(new RegExp(`\\n {6}\\('${d.tbl}','${d.name}','${def.replace(/[()]/g, "\\$&")}'\\),?\\n`));
    }
  });

  it("L4: `zz_guard_read_keys` — ОСТАННІЙ BEFORE-тригер кожної з трьох таблиць у сумі ВСІХ міграцій", () => {
    /* Порядок спрацювання — за імʼям (C). BEFORE-тригер, що стоїть за абеткою
       ПІСЛЯ гарда і править ключ, обійшов би його мовчки; №17 порядку не пінить. */
    const state = simulateTriggers(ALL_MIGS);
    /* зелена базова лінія симулятора: відомі тригери він бачить */
    expect(beforeOf(state, "queue_entries")).toEqual(expect.arrayContaining(["a00_radiologist_scope", "trg_sync_cito", TG]));
    expect(beforeOf(state, "patient_cases")).toEqual(expect.arrayContaining(["a00_radiologist_no_write", "cases_touch_updated", TG]));
    expect(beforeOf(state, "waitlist_entries")).toEqual(expect.arrayContaining(["waitlist_touch_updated", TG]));
    for (const t of GUARDED) {
      const names = beforeOf(state, t);
      expect(names.at(-1), `${t}: за абеткою після гарда стоїть ${names.at(-1)}`).toBe(TG);
    }
    /* і сам симулятор ловить порушника — у тій формі, в якій Postgres його
       збереже (незакавичене — нижнім регістром, закавичене — як є) */
    const lastWith = (sql: string) =>
      beforeOf(simulateTriggers([...ALL_MIGS, ["9999_probe.sql", sql]]), "queue_entries").at(-1);
    /* Z1: звичайний `zzz_…` */
    expect(lastWith("create trigger zzz_later before update of referrer_id on public.queue_entries for each row execute function public.x();")).toBe("zzz_later");
    /* Z2: імʼя великими — Postgres збереже `zzz_late` і запустить ПІСЛЯ гарда */
    expect(lastWith("CREATE TRIGGER ZZZ_LATE BEFORE UPDATE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION public.x();")).toBe("zzz_late");
    /* Z3: таблиця змішаним регістром — це та сама `queue_entries` */
    expect(lastWith("create trigger zzz_mixed before insert on public.Queue_Entries for each row execute function public.x();")).toBe("zzz_mixed");
    /* Z4: закавичене — як є: `"ZZZ_Q"` у C-порядку ДО `zz_…`, тобто не обхід */
    expect(lastWith('create trigger "ZZZ_Q" before insert on "public"."queue_entries" for each row execute function public.x();')).toBe(TG);
    /* і зняття теж нормалізується: `DROP TRIGGER ZZ_GUARD_READ_KEYS ON PUBLIC.QUEUE_ENTRIES` знімає гард */
    expect(beforeOf(simulateTriggers([...ALL_MIGS, ["9999_probe.sql", "DROP TRIGGER ZZ_GUARD_READ_KEYS ON public.QUEUE_ENTRIES;"]]), "queue_entries"))
      .not.toContain(TG);
  });

  it("порядок асертять накат, сухий прогін і пост-асерт файлу (ПІСЛЯ DDL), а читання назад його показує", () => {
    const zz = "select t.tgname from pg_trigger t\n       where t.tgrelid = c.oid and not t.tgisinternal\n         and (t.tgtype & 3) = 3 and (t.tgtype & 20) <> 0\n       order by t.tgname collate \"C\" desc limit 1) x";
    for (const [lbl, txt] of [["apply", APPLY], ["dryrun", DRYRUN], [MIG_FILE, MIG]] as const) {
      const code = codeOf(txt);
      expect(count(code, zz), `${lbl}: асерту порядку немає`).toBe(1);
      expect(code.indexOf(zz), `${lbl}: асерт порядку не ПІСЛЯ DDL`).toBeGreaterThan(code.lastIndexOf(`create trigger ${TG}`));
      expect(code).toContain(`     and x.tgname <> '${TG}';`);
    }
    expect(APPLY).toContain(`and x.tgname = '${TG}') as zz_last_tables,`);
    expect(APPLY).toContain("new_triggers = 7, zz_last_tables = 3, guard_fn = true");
  });

  it("fn_audit НЕ перевизначається — його рядок №19 байт у байт той самий, що в 0202", () => {
    expect(codeOf(MIG)).not.toMatch(/create\s+(or\s+replace\s+)?function\s+public\.fn_audit\b/i);
    const row = (rp: string) => rp.split("\n").filter((l) => l.startsWith("      ('fn_audit()',"));
    expect(row(RP_NEW)).toHaveLength(1);
    expect(row(RP_NEW)).toEqual(row(RP_OLD));
  });

  it("передумови дизайну асертяться в накаті: колонки ключів, мітки енумів, межа referrer_private", () => {
    for (const txt of [MIG, APPLY, DRYRUN]) {
      expect(txt).toContain("unnest(array['referrer_id', 'created_by', 'clinic_id']) col");
      expect(txt).toContain("and e.enumlabel in ('admin', 'registrar', 'referrer')) <> 3");
      expect(txt).toContain("and e.enumlabel = 'active') then");
      expect(txt).toContain("where a.attrelid = 'public.referrer_private'::regclass\n                and a.attname in ('id', 'clinic_id') and a.attnum > 0 and not a.attisdropped) then");
    }
    expect(RP_NEW).toContain("`referrer_private` не має ні `id`, ні `clinic_id`: `fn_audit`\n  --           пише `row_id` і `clinic_id` NULL.");
  });
});

describe("0203 — передрук сторожа", () => {
  it("пін №25 — з тіла ЦЬОГО файлу; предстан приймає лише тіло 0202 або 0203", () => {
    expect(pinFor(guardBodyOf(MIG) as string)).toBe(NEW_PIN);
    expect(pinFor(guardBodyOf(PREV) as string), "0202 на диску — не те тіло, від якого рахувались якорі").toBe(PRE_PIN);
    expect(count(MIG, `comment on function public.invariants_check(boolean) is '${NEW_PIN}';`)).toBe(1);
    expect(MIG).toContain(`if md5(v_src) not in ('${PRE_MD5}', '${NEW_MD5}') then`);
  });

  it("код без коментарів = код 0202 + РІВНО вісім рядків (сім у №17, гард у №19) і кома в колишньому останньому рядку №17", () => {
    const isNew = (l: string) => PAIRS.some(([t, n]) => l.startsWith(`      ('${t}','${n}','CREATE TRIGGER `))
      || l.startsWith(`      ('${FN}()','`);
    const lastOld = "      ('waitlist_entries','trg_guard_waitlist_room','CREATE TRIGGER trg_guard_waitlist_room BEFORE INSERT OR UPDATE OF room_id, clinic_id ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_waitlist_room()')";
    const newLines = codeOf(RP_NEW).split("\n");
    const oldLines = codeOf(RP_OLD).split("\n");
    expect(oldLines.filter((l) => l === lastOld), "у 0202 колишній останній рядок не той").toHaveLength(1);
    expect(newLines.filter(isNew)).toHaveLength(8);
    expect(newLines.filter((l) => !isNew(l)), "передрук змінив щось, крім восьми рядків і коми")
      .toEqual(oldLines.map((l) => (l === lastOld ? `${lastOld},` : l)));
    expect(count(codeOf(RP_NEW), "v_n := v_n + 1;")).toBe(26);
    expect(count(codeOf(RP_OLD), "v_n := v_n + 1;")).toBe(26);
  });

  it("список №17 — 30 рядків, унікальних, у порядку C; останній — гард листа очікування без коми", () => {
    const rows = RP_NEW.match(/^ {6}\('[a-z_]+','[a-z0-9_]+','CREATE TRIGGER [^\n]*$/gm) || [];
    expect(rows).toHaveLength(30);
    const keys = rows.map((r) => r.slice(0, r.indexOf(",'CREATE TRIGGER ")));
    expect(new Set(keys).size).toBe(30);
    const tuples = keys.map((k) => k.slice(8, -1).split("','"));
    const sorted = [...tuples].sort((a, b) => byC(a[0], b[0]) || byC(a[1], b[1]));
    expect(tuples).toEqual(sorted);
    rows.forEach((r, i) => expect(r.endsWith(i === rows.length - 1 ? "')" : "'),")).toBe(true));
    expect(tuples.at(-1)).toEqual(["waitlist_entries", TG]);
    for (const t of GUARDED) expect(tuples.filter(([tb]) => tb === t).at(-1)?.[1], `${t}: гард не останній у своїй таблиці`).toBe(TG);
  });

  it("проза 0203 у №17 — рівно один абзац, межі названі (зокрема порядок), без `'` і `$`", () => {
    const head = "  --     ⚠️ 0203 (с79, рішення власника 24–25.09: Р2(б), Н-9, Р-1, Р-2) ДОДАЛА";
    expect(count(RP_NEW, head)).toBe(1);
    const a = RP_NEW.indexOf(head);
    const prose = RP_NEW.slice(a, RP_NEW.indexOf("\n  v_n := v_n + 1;", a));
    expect(prose).toContain("СІМ ПАР (23 → 30), `checked` той самий");
    expect(prose).toContain("⚠️ МЕЖІ 0203, названі вголос:");
    expect(prose).toContain("тримає №19 (0203 внесла його туди ж, 59 → 60)");
    expect(prose).toContain("ПОРЯДОК спрацювання ця перевірка НЕ пінить");
    expect(prose).toContain("`referrer_private` не має ні `id`, ні `clinic_id`");
    /* `$` зламав би `$p$`-літерали підстановки, `'` — канон прози сторожа */
    expect(prose).not.toMatch(/['$]/);
    expect(prose.split("\n").every((l) => l.startsWith("  --"))).toBe(true);
  });

  it("проза №19: абзац 0203 рівно раз, лічильники 60 — у заголовку й історії, без `'` і `$`", () => {
    const head = `  --     ⚠️ 0203 (с79, Н-9 і Р-1) ДОДАЛА ОДНУ: \`${FN}()\``;
    expect(count(RP_NEW, head)).toBe(1);
    const a = RP_NEW.indexOf(head);
    const prose = RP_NEW.slice(a, RP_NEW.indexOf("\n  v_n := v_n + 1;", a));
    expect(prose).toContain("Список став 60.");
    expect(prose).toContain("чиї `referrer_id` і `created_by`");
    expect(prose).not.toMatch(/['$]/);
    expect(prose.split("\n").every((l) => l.startsWith("  --"))).toBe(true);
    /* абзац — останній у прозі №19, перед кроком лічильника самої перевірки */
    expect(RP_NEW.indexOf("'check', 'guard_fn_bodies'", a)).toBeGreaterThan(a);
    expect(RP_NEW.lastIndexOf("  --     ⚠️ 0202 ПЕРЕДРУКУВАЛА ЧОТИРИ md5", a)).toBeGreaterThan(-1);
    expect(RP_NEW).toContain("ЩО ПІНИМО (сьогодні 60 підписів;");
    expect(RP_NEW).not.toContain("сьогодні 59 підписів");
    expect(RP_NEW).toContain("зміни складу; 0203 → 60), а заголовок");
    const rows19 = codeOf(RP_NEW).match(/^ {6}\('[A-Za-z0-9_]+\([^)]*\)','[0-9a-f]{32}','[^']*'\),?$/gm) || [];
    expect(rows19).toHaveLength(60);
  });

  it("заголовок передруку — один, і фраза заголовка не трапляється у файлі раніше", () => {
    /* `privilegeSurface` шукає цю фразу БЕЗ якоря: згадка вище (у прозі
       шапки) зрушила б його вирізку тіла. */
    const phrase = "create or replace function public.invariants_check";
    expect(MIG.match(/^create or replace function public\.invariants_check/gm) || []).toHaveLength(1);
    expect(MIG.indexOf(phrase)).toBe(MIG.search(/^create or replace function public\.invariants_check/m));
  });

  it("підстановки накату й відкату, виконані тут, дають рівно тіла 0203 і 0202", () => {
    const newBody = guardBodyOf(MIG) as string;
    const oldBody = guardBodyOf(PREV) as string;
    for (const frag of [APPLY, DRYRUN]) {
      const { from, to } = substPairs(frag);
      /* 6 вставок у №17 + проза №17 + рядок №19 + проза №19 + два лічильники №19 */
      expect(from).toHaveLength(11);
      expect(to).toHaveLength(11);
      expect(substitute(oldBody, from, to) === newBody, "підстановка накату дала не тіло 0203").toBe(true);
    }
    const back = substPairs(ROLLBACK);
    expect(back.from).toHaveLength(11);
    expect(substitute(newBody, back.from, back.to) === oldBody, "зворотна підстановка дала не тіло 0202").toBe(true);
  });
});

describe("0203 — порядок у файлі міграції", () => {
  const code = codeOf(MIG);
  const at = (needle: string, from = 0) => {
    const i = MIG.indexOf(needle, from);
    expect(i, `у файлі немає «${needle}»`).toBeGreaterThanOrEqual(0);
    return i;
  };

  it("begin; … commit; — по одному; леджер — ОСТАННІМ стейтментом перед commit; після commit — лише ВІДКАТ у коментарях", () => {
    expect(MIG.split("\n").filter((l) => l === "begin;")).toHaveLength(1);
    expect(MIG.split("\n").filter((l) => l === "commit;")).toHaveLength(1);
    expect(count(code, "insert into public.migration_ledger")).toBe(1);
    expect(MIG).toContain(`insert into public.migration_ledger (name)\nvalues ('${LEDGER_NAME}')\non conflict (name) do nothing;\n\ncommit;\n`);
    const tail = MIG.slice(MIG.indexOf("\ncommit;\n") + "\ncommit;\n".length);
    expect(codeOf(tail).trim(), "після commit є код").toBe("");
    expect(tail).toContain("=== ВІДКАТ ===");
  });

  it("повний сторож — ДО DDL на таблицях (урок 0196), після передруку і піна; шукаємо в КОДІ (Low-2)", () => {
    const seq = [
      at("\nbegin;\n"), at("do $pre$"), at(FN_HEAD), at("\ncreate or replace function public.invariants_check"),
      at("comment on function public.invariants_check(boolean) is '"), at("do $chk$"),
      at("drop trigger if exists "), MIG.lastIndexOf("create trigger "), at("do $post$"),
      at("insert into public.migration_ledger"), at("\ncommit;\n"),
    ];
    expect(seq).toEqual([...seq].sort((a, b) => a - b));
    expect(count(code, SENTINEL_CALL), "повний сторож у коді не рівно раз").toBe(1);
    expect(code.indexOf(SENTINEL_CALL)).toBeLessThan(code.indexOf("create trigger "));
    const chk = MIG.slice(at("do $chk$"), at("$chk$;"));
    expect(chk).toContain(SENTINEL_CALL);
    expect(chk).toContain("if (v_res->>'checked')::int <> 26 then");
    expect(chk, "до DDL №17 мусить назвати рівно сім відсутніх пар пакета").toContain(MISSING_SQL);
    expect(chk).toContain("where e.value->>'check' not in ('gcal_sync_overdue', 'guard_triggers')");
    expect(code.slice(code.indexOf("drop trigger if exists ")), "повний сторож під замками на таблиці")
      .not.toMatch(SENTINEL_ANY_CALL);
  });

  it("після DDL — запит №17 САМОГО сторожа: вирізаний із ЖИВОГО тіла, звірений md5 і виконаний; копії тексту у файлі немає", () => {
    expect((Q17_NEW.match(/^ {6}\('[a-z_]+','[a-z0-9_]+','CREATE TRIGGER /gm) || []).length).toBe(30);
    const post = MIG.slice(at("do $post$"), at("$post$;"));
    /* ⚠️ Ревізія стендів 24.09: дослівні копії запиту №17 і виразу `cur` у
       пост-асерті задвоювали якорі falsify-0181 (7) і falsify-0182 (1) —
       стенди мутують ФАЙЛ останнього передруку і вимагають унікальності. */
    expect(post, "у пост-асерті знову копія запиту №17").not.toContain(Q17_NEW.split("\n")[2]);
    expect(post, "у пост-асерті знову копія виразу cur №19").not.toContain(CUR.split("\n")[2]);
    /* тіло звірене ДО вирізання — межі ріжуть рівно тіло 0203 */
    expect(post.indexOf(`if md5(v_src) is distinct from '${NEW_MD5}' or length(v_src) <> ${NEW_LEN}`))
      .toBeLessThan(post.indexOf("v_a := strpos(v_src, "));
    /* межі, зібрані в SQL через chr(10), відтворюють ті самі, що в тілі.
       `'a' || chr(10) || 'b'` → "a\nb"; усередині літерала теж бувають ` || ` */
    const sqlStr = (expr: string) => {
      const lead = expr.startsWith("chr(10) || ") ? "\n" : "";
      return lead + expr.slice(lead ? "chr(10) || ".length : 0).split(" || chr(10) || ")
        .map((p) => p.replace(/^'([\s\S]*)'$/, "$1").replace(/''/g, "'")).join("\n");
    };
    const aTxt = sqlStr(/v_a := strpos\(v_src, (.*)\);\n/.exec(post)?.[1] ?? "");
    const bTxt = sqlStr(/v_b := strpos\(v_src, (.*)\);\n/.exec(post)?.[1] ?? "");
    expect(count(RP_NEW, aTxt), "межа початку не унікальна в тілі").toBe(1);
    expect(count(RP_NEW, bTxt), "межа кінця не унікальна в тілі").toBe(1);
    expect(RP_NEW.indexOf(aTxt), "межа початку — не початок запиту №17").toBe(RP_NEW.indexOf(Q17_NEW));
    expect(RP_NEW.indexOf(bTxt), "межа кінця — не кінець запиту №17").toBe(RP_NEW.indexOf(Q17_NEW) + Q17_NEW.length - "\n    ) x;".length);
    /* md5 того, що піде в execute: запит без `into v_tmp` і без `;` */
    const dyn = Q17_NEW.replace(/;$/, "").replace("select array_agg(x.txt order by x.txt) into v_tmp", "select array_agg(x.txt order by x.txt)");
    expect(post).toContain(`if md5(v_q) is distinct from '${md5(dyn)}' then`);
    expect(post).toContain("  execute v_q into v_tmp;\n  if v_tmp is not null then\n    raise exception '0203: №17 після DDL червоний: %', v_tmp;");
  });

  it("у файлі немає копій тексту тіла поза тілом — інакше стенди отримають «ЯКІР НЕ УНІКАЛЬНИЙ»", () => {
    /* Та сама сітка, що в генераторі: жоден унікальний у тілі рядок (≥ 24 знаки
       без відступу) не трапляється у файлі вдруге. */
    const dups = [...new Set(RP_NEW.split("\n"))]
      .filter((l) => l.trim().length >= 24 && count(RP_NEW, l) === 1 && count(MIG, l) !== 1)
      .map((l) => l.trim().slice(0, 80));
    expect(dups).toEqual([]);
  });

  it("предстан ідемпотентний: 0202 обовʼязкова, останній рядок — 0202 або 0203; функцію шукає `to_regprocedure`", () => {
    const pre = MIG.slice(at("do $pre$"), at("$pre$;"));
    expect(pre).toContain("where name = '0202_tz_kyiv_no_catalog_scan.sql'");
    expect(pre).toContain(`('0202_tz_kyiv_no_catalog_scan.sql', '${LEDGER_NAME}')`);
    /* `::regprocedure` падає на плануванні, коли функції ще немає (локальний стенд) */
    expect(codeOf(pre)).not.toContain(`'public.${FN}()'::regprocedure`);
    expect(pre).toContain(`to_regprocedure('public.${FN}()') is not null`);
  });
});

describe("0203 — фрагменти", () => {
  it("перший стейтмент — бюджет часу, другий — тег блоку; маркери успіху і відкоту", () => {
    for (const [txt, tag] of [[APPLY, "$apply$"], [DRYRUN, "$dryrun$"], [ROLLBACK, "$back$"], [FALSIFY, "$falsify$"]] as const) {
      const stmts = txt.split("\n").filter((l) => l.trim() && !l.startsWith("--"));
      expect(stmts[0]).toBe("set statement_timeout = '5min';");
      expect(stmts[1]).toBe(`do ${tag}`);
      expect(count(txt, tag), `${tag}: тег згадано поза блоком`).toBe(2);
    }
    expect(APPLY).toContain("raise notice 'APPLY_0203_OK");
    expect(DRYRUN).toContain("raise exception 'DRYRUN_0203_ROLLBACK guard=% len=% pin=% checked=% ok17=true zz_last=true failed_before_ddl=% orphans_ref(q/w/c)=%/%/% orphans_cb=%'");
    expect(ROLLBACK).toContain("raise notice 'ROLLBACK_0203_OK");
    expect(FALSIFY).toContain("raise exception 'FALSIFY_0203_ROLLBACK verdict=%");
  });

  it("Low-3: накат і сухий прогін несуть DDL тригерів, текст гарда і revoke/grant ДОСЛІВНО як у файлі — і нічого понад", () => {
    /* ревʼю р2: мутації лише фрагмента (revoke без `public`, інший порядок
       колонок у DDL) лишали набір зеленим — файл і фрагмент розходились мовчки */
    const ddlBlock = DDL.map((d) => d.text).join("\n\n");
    expect(MIG).toContain(ddlBlock);
    const indent = (s: string) => s.split("\n").map((l) => (l ? `  ${l}` : l)).join("\n");
    for (const [lbl, txt] of [["apply", APPLY], ["dryrun", DRYRUN]] as const) {
      expect(count(txt, indent(ddlBlock)), `${lbl}: DDL тригерів не той, що у файлі`).toBe(1);
      expect(count(txt, indent(FN_ACL_DDL)), `${lbl}: revoke/grant не ті, що у файлі`).toBe(1);
      expect(count(txt, FN_STMT.replace(/;$/, "")), `${lbl}: текст гарда не той, що у файлі`).toBe(1);
      const code = codeOf(txt);
      expect(count(code, "create trigger "), `${lbl}: зайвий create trigger`).toBe(7);
      expect(count(code, "drop trigger "), `${lbl}: зайвий drop trigger`).toBe(7);
      expect((code.match(/^\s*(revoke|grant)\s/gim) || []).length, `${lbl}: зайвий revoke/grant`).toBe(2);
    }
  });

  it("apply і dryrun: суворий предстан → функція → передрук → пін → ПОВНИЙ сторож → [замір] → DDL → порядок → №17 дослівно → леджер", () => {
    for (const [lbl, txt] of [["apply", APPLY], ["dryrun", DRYRUN]] as const) {
      expect(txt).toContain(`if exists (select 1 from public.migration_ledger where name = '${LEDGER_NAME}') then`);
      expect(txt).toContain("if md5(v_src) is distinct from 'e1f1fdcfcea99906f02b0af193b814fa' or length(v_src) <> 165537 then");
      expect(txt).toContain(`if to_regprocedure('public.${FN}()') is not null then`);
      const code = codeOf(txt);
      const iChk = code.indexOf(SENTINEL_CALL);
      const iDdl = code.indexOf("drop trigger if exists ");
      const iZz = code.indexOf(`and x.tgname <> '${TG}';`);
      const iQ17 = txt.indexOf(Q17_NEW);
      const iLedger = code.indexOf("insert into public.migration_ledger (name)");
      expect(count(code, SENTINEL_CALL), `${lbl}: повний сторож у коді не рівно раз`).toBe(1);
      expect(iChk, `${lbl}: повний сторож не ДО DDL`).toBeLessThan(iDdl);
      expect(code.indexOf(MISSING_SQL), `${lbl}: до DDL — не рівно сім missing`).toBeGreaterThan(iChk);
      expect(iZz, `${lbl}: асерт порядку не після DDL`).toBeGreaterThan(code.lastIndexOf("create trigger "));
      expect(iQ17, `${lbl}: №17 після DDL не дослівний`).toBeGreaterThan(txt.lastIndexOf("create trigger "));
      expect(iLedger).toBeGreaterThan(code.indexOf("  v_tmp := null;\n  select array_agg(x.txt order by x.txt) into v_tmp"));
      expect(code.slice(iDdl), `${lbl}: виклик сторожа під замками`).not.toMatch(SENTINEL_ANY_CALL);
      expect(txt).toContain("execute format('comment on function public.invariants_check(boolean) is %L', v_pin_db);");
      expect(txt).toContain(`'${NEW_PIN}'`);
    }
  });

  it("dryrun: замір ключів — ДО DDL (Low-4), обидва ключі; текст шапки — про `set statement_timeout` і замір, не про стоп (Low-6, Low-7)", () => {
    const code = codeOf(DRYRUN);
    const iDdl = code.indexOf("create trigger ");
    expect(code.indexOf("into v_oq, v_ow, v_oc")).toBeGreaterThan(code.indexOf(SENTINEL_CALL));
    expect(code.indexOf("into v_oq, v_ow, v_oc")).toBeLessThan(iDdl);
    expect(code.indexOf("into v_ocb")).toBeLessThan(iDdl);
    expect(code).toContain("left join public.profiles p on p.id = x.k");
    for (const cat of ["'no_profile'", "'staff_other_clinic'", "'referrer_no_grant'", "else p.role::text"]) expect(code).toContain(cat);
    expect(DRYRUN).not.toContain("ПОЧИНАЄТЬСЯ з тегу");
    expect(DRYRUN).toContain("-- ⚠️ Запит ПОЧИНАЄТЬСЯ з `set statement_timeout` (перший стейтмент), другий —");
    expect(DRYRUN).toContain("`orphans_ref(q/w/c)` і `orphans_cb` — ЗАМІР, а не умова зупинки");
    expect(MIG).toContain("orphans_ref(q/w/c) і orphans_cb — ЗАМІР, а не умова зупинки");
  });

  it("червоне вікно названо в накаті й у порядку файлу", () => {
    for (const txt of [APPLY, MIG]) {
      expect(txt).toContain("ЧЕРВОНЕ ВІКНО");
      expect(txt).toContain("Redeploy");
      expect(txt).toContain("03:50 UTC");
    }
    expect(APPLY).toContain("`npm run db:gate:check` на `main` І на `dev`");
    expect(MIG).toContain("`npm run db:gate:check` зелений на `main` І на `dev`");
  });

  it("rollback: сім тригерів і функція зняті, №17 — старий запит дослівно, пін 0202, рядок леджера — рівно один", () => {
    for (const [t, n] of PAIRS) expect(ROLLBACK).toContain(`drop trigger if exists ${n} on public.${t};`);
    expect(ROLLBACK).toContain(`drop function public.${FN}();`);
    expect(ROLLBACK).toContain(Q17_OLD);
    expect(ROLLBACK).toContain(`'${PRE_PIN}'`);
    expect(ROLLBACK).toContain(`delete from public.migration_ledger where name = '${LEDGER_NAME}';`);
    /* зняття — ПІСЛЯ перевірки, що в базі саме 0203 (№17 новий дослівно) */
    expect(ROLLBACK.indexOf(Q17_NEW)).toBeLessThan(ROLLBACK.indexOf("drop trigger if exists "));
  });

  it("falsify (Low-1): повний сторож — ДО проб і мутацій; під мутаціями лише дослівні №17 і №19", () => {
    const code = codeOf(FALSIFY);
    const iBase = code.indexOf(SENTINEL_CALL);
    const iProbe = code.indexOf("create temp table falsify_0203_g");
    const iMut = code.indexOf("drop trigger trg_audit_referrer_private on public.referrer_private;");
    expect(count(code, SENTINEL_CALL)).toBe(1);
    expect(iBase).toBeGreaterThan(0);
    expect(iBase).toBeLessThan(iProbe);
    expect(iProbe).toBeLessThan(iMut);
    expect(code.slice(iMut), "повний сторож під замками мутацій").not.toMatch(SENTINEL_ANY_CALL);
    expect(FALSIFY.lastIndexOf(Q17_NEW)).toBeGreaterThan(FALSIFY.indexOf("drop trigger trg_audit_referrer_private"));
    expect(FALSIFY.indexOf(Q19_NEW)).toBeGreaterThan(FALSIFY.lastIndexOf(Q17_NEW));
    expect(count(FALSIFY, Q19_NEW)).toBe(1);
    expect(FALSIFY).toContain("where e.value->>'check' not in ('gcal_sync_overdue', 'ledger_md5');");
  });

  it("falsify: проби ізольовані, читають ОБИДВА ключі; L1 — усі п'ять статусів для обох ключів; мутації №17 і №19", () => {
    expect(FALSIFY).toContain("create temp table falsify_0203_g (id int primary key, clinic_id uuid, referrer_id uuid, created_by uuid) on commit drop;");
    expect(FALSIFY).toContain(`create trigger ${TG} before insert or update on falsify_0203_g\n    for each row execute function public.${FN}();`);
    for (const s of ["active", "pending_referrer", "pending_clinic", "declined", "revoked"]) {
      expect(FALSIFY).toContain(`-- R-${s}\n`);
      expect(FALSIFY).toContain(`-- C-ref-${s}\n`);
      expect(FALSIFY).toContain(`values (v_ref, v_clinic, '${s}')`);
    }
    for (const lbl of ["R-other-clinic", "R-not-referrer", "C-admin-foreign", "C-radiologist", "C-ceo", "A-admin-self-foreign",
      "A-radiologist-self", "A-ref-self-pending", "A-L3-ref-colleague", "A-L3-cb-staff", "U-mention",
      "U-cb-change-keeps-ref", "U-clinic-move", "U-clinic-move-granted"]) {
      expect(FALSIFY, `проби ${lbl} немає`).toContain(`  -- ${lbl}\n`);
    }
    const probes = FALSIFY.match(/select g\.referrer_id, g\.created_by into v_r, v_c from falsify_0203_g g where g\.id = \d+;/g) || [];
    const labels = FALSIFY.match(/v_ok := v_ok \|\| '[^']+'::text;/g) || [];
    expect(probes.length).toBe(labels.length);
    expect(labels.length).toBeGreaterThanOrEqual(36);
    expect(FALSIFY, "проба ловить лише 23514 — стара форма").not.toContain("exception when check_violation");
    expect(FALSIFY).not.toContain("REFERRER_NO_GRANT");
    for (const m of [
      "drop trigger trg_audit_referrer_private on public.referrer_private;",
      "alter table public.doctors disable trigger trg_audit_doctors;",
      "create or replace trigger trg_audit_services\n    after insert or update on public.services",
      `create or replace trigger ${TG}\n    before insert or update of referrer_id on public.patient_cases`,
    ]) expect(FALSIFY, `мутації «${m.split("\n")[0]}» немає`).toContain(m);
    expect(FALSIFY).toContain("v_want_exact constant text[] := array['missing:referrer_private.trg_audit_referrer_private', 'trigger_off:doctors.trg_audit_doctors=D']::text[];");
    expect(FALSIFY).toContain(`v_want_prefix constant text[] := array['wrong_def:patient_cases.${TG}->', 'wrong_def:services.trg_audit_services->']::text[];`);
    expect(norm(FALSIFY)).toContain(norm(`case when cardinality(v_miss) = 0 and cardinality(v_ok) + cardinality(v_na) = ${labels.length}
              and v_missed is null and v_extra is null and v_base_other is null
              and coalesce(array_length(v_off17, 1), 0) = 4 and v_b19 and v_b1b then 'PASS' else 'FAIL' end`));
    /* B1b — ПІСЛЯ вихолощення і ДО запитів сторожа */
    const iB1 = FALSIFY.indexOf("-- falsify 0203 B1: вихолощене тіло");
    const iB1b = FALSIFY.indexOf("values (200, v_clinic, v_ghost, v_ghost);");
    expect(iB1).toBeGreaterThan(0);
    expect(iB1b).toBeGreaterThan(iB1);
    expect(FALSIFY.lastIndexOf(Q17_NEW)).toBeGreaterThan(iB1b);
  });
});

describe("0203 — смоук", () => {
  const code = codeOf(SMOKE);

  it("один блок; критерій — SMOKE_OK останнім; ранній вихід лише SMOKE_SKIP; n/a — у тексті SMOKE_OK", () => {
    expect(count(code, "do $smoke$")).toBe(1);
    expect(code.trimEnd().endsWith("$smoke$;")).toBe(true);
    const last = code.lastIndexOf("raise exception '");
    expect(code.slice(last)).toMatch(/^raise exception 'SMOKE_OK: 0203 [^']*\[%\] n\/a=\[%\]'/);
    expect(count(code, "SMOKE_SKIP")).toBe(1);
    expect(code).toContain(`where name = '${LEDGER_NAME}') then\n    raise exception 'SMOKE_SKIP:`);
  });

  it("L2: кожен обробник — `when others` і кидає SMOKE_FAIL з міткою; пошук слота ковтає ЛИШЕ названі відмови бронювання", () => {
    const handlers = code.split("exception when ").slice(1);
    expect(handlers.length).toBeGreaterThan(20);
    for (const h of handlers) {
      expect(h.startsWith("others then\n"), "обробник не `when others`").toBe(true);
      const body = h.slice(0, h.indexOf("\n    end;") >= 0 ? h.indexOf("end;") : undefined);
      expect(body, "обробник мовчить").toMatch(/raise exception 'SMOKE_FAIL\([a-z0-9-]+|raise exception 'SMOKE_FAIL\((setup)\)/);
    }
    expect(count(code, "if sqlstate not in ('23514', '23P01') or split_part(v_msg, ':', 1) <> all (c_booking) then")).toBe(2);
    expect(code).toContain("c_booking constant text[] := array['ROOM_CLOSED', 'BEFORE_OPEN', 'TOO_LATE', 'OFF_SCHEDULE',\n                                     'PAST_SLOT', 'BREAK', 'OVERLAP', 'INCIDENT'];");
    expect(code, "стара форма — відмова замість NULL").not.toContain("REFERRER_NO_GRANT");
    expect(code).not.toContain("when check_violation");
  });

  it("L1: п'ять статусів гранту × три таблиці, ключ читається після вставки", () => {
    expect(code).toContain("foreach s in array array['active', 'pending_referrer', 'pending_clinic', 'declined', 'revoked'] loop");
    for (const t of GUARDED) expect(code).toContain(`insert into public.${t} (`);
    for (const lbl of ["g-w-%", "g-c-%", "g-q-%"]) expect(code).toContain(`raise exception 'SMOKE_FAIL(${lbl}): referrer_id=% created_by=%'`);
    expect(code).toContain("if v_r is distinct from (case when s = 'active' then v_ref end) or v_c is distinct from v_admin then");
  });

  it("H1, UPDATE, L3, успадкування — кожна мітка є і має перевірку ключа", () => {
    for (const lbl of ["q0", "g-other", "g-role", "h-foreign", "h-rad", "h-rad-actor", "h-reg", "h-ceo", "h-self", "h-staff2",
      "u-data", "u-cb", "u-clinic", "u-cb-bad", "u-rpc-same", "u-rpc-role", "l3-cb", "l3-ref", "i1", "i2", "i3"]) {
      expect(code, `мітки ${lbl} немає`).toContain(`SMOKE_FAIL(${lbl})`);
    }
    for (const rpc of ["schedule_from_waitlist_rpc", "add_case_step_rpc", "case_from_entry_rpc", "update_patient_details"]) {
      expect(code).toContain(`public.${rpc}(`);
    }
    /* `doctor` при успадкуванні — передано в RPC І звірено в умові провалу */
    for (const n of ["i1", "i2", "i3"]) {
      expect(code, `${n}: doctor не передано`).toContain(`'doctor', 'SMOKE 0203 лікар ${n}'`);
      expect(code, `${n}: doctor не звірено`).toContain(`v_doc is distinct from 'SMOKE 0203 лікар ${n}' then`);
    }
    /* n/a — лише для необовʼязкових даних, і кожен — у тексті SMOKE_OK */
    const na = [...code.matchAll(/v_na := v_na \|\| '([^']+)'/g)].map((m) => m[1].trim());
    expect(na.join(" ").split(/\s+/).sort()).toEqual(["h-ceo", "h-rad", "h-rad-actor", "h-reg", "h-staff2", "i3", "l3-ref"].sort());
    expect(code).toContain("set local role authenticated;");
    expect(code).toContain("perform set_config('request.jwt.claims', '{}', true);");
  });

  it("аудит: чотири таблиці × insert/update/delete; referrer_private — row_id і clinic_id NULL", () => {
    for (const t of AUDIT) expect(code).toContain(`l.table_name = '${t}'`);
    expect(count(code, "is distinct from (1::bigint, 1::bigint, 1::bigint, 0::bigint) then")).toBe(4);
    expect(code).toContain("count(*) filter (where l.row_id is not null or l.clinic_id is not null or l.actor is distinct from v_admin)");
  });
});

describe("0203 — застосунок і правила проєкту", () => {
  it("класифікації відмови гарда немає: гард не відмовляє (Р-2), мапінг прибрано", () => {
    expect(existsSync("lib/referrerGrant.ts")).toBe(false);
    for (const f of ["app/queue/actions.ts", "app/waitlist/actions.ts"]) {
      expect(read(f)).not.toMatch(/REFERRER_NO_GRANT|isReferrerNoGrant|referrerGrant/);
    }
  });

  it("AGENTS.md («Миграции и БД»): відновлення з before-образів іде крізь гард; точний образ — disable/enable у тій самій транзакції", () => {
    const agents = read("AGENTS.md");
    const a = agents.indexOf("## Миграции и БД");
    const b = agents.indexOf("\n## ", a + 1);
    const section = agents.slice(a, b);
    expect(section).toContain(`disable trigger ${TG}`);
    expect(section).toContain("trigger_off");
  });
});
