/* ===== №26 role_surface — СТАТИЧНИЙ сторож над сторожем (0201, с74) =====
 *
 * Перевірка №26 живе В БАЗІ і читає каталог; поведінку юніт-тестом не дістати —
 * її доведено фальсифікацією на проді (`scripts/frag/0201_falsify.sql`, протокол у
 * `docs/audit/PR-0201-gated-rpcs-role-surface.md`). Правило с57: перевірка, яку
 * тримає лише лічильник `checked`, — не перевірка. `where c.dig is distinct from
 * e.dig and false` лишала б усі 26 зеленими, `checked` = 26, і жоден смоук цього
 * не побачив би.
 *
 * Тому тут пінимо ВЛАСТИВОСТІ блоку №26 в ОСТАННЬОМУ передруку — рівно ті, на яких
 * тримається рішення Р74-2(б) і які зонд 15.09 назвав робочими обходами:
 *   • ролі НЕ хардкодом і ТРАНЗИТИВНО (канон №15/№22 + ревʼю с74): нова клієнтська
 *     роль і роль, успадкована через іншу, мусять з'явитися самі;
 *   • членство в ОБИДВА боки: що клієнт успадковує І хто може стати клієнтом
 *     (новий LOGIN-член `authenticated` сам виставляє `request.jwt.claims`);
 *   • атрибути ролі, у т.ч. `rolbypassrls` (до 0201 — 0 згадок у сторожі);
 *   • поза `g:` — рівно названі таймаути й спостережуваність, а небезпечні
 *     параметри supautils (session_replication_role, pgrst.*) — ні;
 *   • ACL УСІХ схем, а не лише `public`; default ACL разом із глобальним
 *     (`defaclnamespace = 0`) і синтетичним ключем глобального обмеження; ACL бази;
 *   • PUBLIC (grantee = 0) і `WITH GRANT OPTION` у дайджесті;
 *   • три напрямки дрейфу, `changed:` каже очікуване і фактичне — і хвіст
 *     порівняння, і where кожної гілки дослівно канонічні (ревʼю с74, лінза Б:
 *     дев'ять мутацій проходили попередню редакцію зеленими);
 *   • список — рівно 62 ключі, усі різні, з усіх шести гілок.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const MIGDIR = resolve(process.cwd(), "supabase/migrations");

function latestReprint(): { fn: string; file: string } {
  const files = readdirSync(MIGDIR).filter((f) => f.endsWith(".sql")).sort();
  let best = { fn: "", file: "" };
  for (const f of files) {
    const txt = readFileSync(resolve(MIGDIR, f), "utf8");
    const at = txt.search(/^create or replace function public\.invariants_check/m);
    if (at < 0) continue;
    const end = txt.indexOf("\n$function$;", at);
    if (end < 0) throw new Error(`${f}: передрук не закритий "$function$;"`);
    best = { fn: txt.slice(at, end), file: f };
  }
  if (!best.fn) throw new Error("НЕ ЗНАЙДЕНО жодного передруку invariants_check");
  return best;
}

const { fn: RAW, file: FILE } = latestReprint();
const SRC = RAW.replace(/\r/g, "");
/** Код без коментарів — обидві форми (урок с66, ревʼю Ф-1): у прозі №26 свідомо
 *  цитуються обходи (`grant … to authenticated`, `bypassrls`), і наївний пошук
 *  зеленів би на них. */
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");

/** Рівно блок №26: від кроку лічильника до ПЕРШОЇ мітки перевірки. */
const BLOCK26 = (() => {
  const at = CODE.indexOf("'check', 'role_surface'");
  if (at < 0) throw new Error("у передруку немає мітки role_surface");
  const start = CODE.lastIndexOf("v_n := v_n + 1;", at);
  if (start < 0) throw new Error("перед міткою №26 немає кроку лічильника");
  return CODE.slice(start, at);
})();

/** Нормалізація пробілів — для канонічних пінів нижче. */
const norm = (x: string) => x.replace(/\s+/g, " ").trim();

/** Вираз `cur` №26: від `), cur as (` до `), expd(key, dig) as (values`. */
const CUR26 = (() => {
  const a = BLOCK26.indexOf("), cur as (");
  const b = BLOCK26.indexOf("), expd(key, dig) as (values", a);
  if (a < 0 || b < 0) throw new Error("межі cur у №26 не знайдено");
  return BLOCK26.slice(a, b);
})();

/** Одна гілка `cur` за її префіксом ключа: від `select '<p>:'` (n-те входження)
 *  до наступного `union all` або до кінця `cur`. */
function branch(p: string, nth = 0): string {
  let a = -1;
  for (let k = 0; k <= nth; k++) {
    a = CUR26.indexOf(`select '${p}:'`, a + 1);
    if (a < 0) throw new Error(`гілки ${p}: №${nth + 1} у cur немає`);
  }
  const b = CUR26.indexOf("union all", a);
  return CUR26.slice(a, b < 0 ? CUR26.length : b);
}

/** Агрегат прав: DISTINCT, `*` за grant option, детермінований порядок. */
const AGG = `string_agg(distinct v.pv collate "C", ',' order by v.pv collate "C")`;
const PV = "cross join lateral (select a.privilege_type || case when a.is_grantable then '*' else '' end as pv) v";

/** Рядки очікуваного списку: ('<префікс>:<ключ>','<дайджест>') */
const ROWS = BLOCK26.match(/^ {6}\('[a-z]:[^']*','[^']*'\),?$/gm) || [];

describe(`№26 role_surface — статичний сторож (${FILE})`, () => {
  it("мітка перевірки на місці: успіх + гілка винятку, і більше ніде", () => {
    expect(CODE.match(/'check',\s*'role_surface'/g) || []).toHaveLength(2);
    expect(BLOCK26).not.toMatch(/'check',\s*'(?!role_surface)/);
  });

  it("стоїть ОСТАННЬОЮ: між №25 і збіркою результату", () => {
    const self = CODE.indexOf("'check', 'role_surface'");
    expect(CODE.lastIndexOf("'check', 'guard_self_pin'")).toBeLessThan(self);
    expect(CODE.indexOf("v_res := jsonb_build_object(")).toBeGreaterThan(CODE.lastIndexOf("'check', 'role_surface'"));
  });

  it("клієнтські ролі — ТРАНЗИТИВНЕ замикання від authenticator, без service_role і без хардкоду", () => {
    /* Ревʼю с74 (лінза А): пряме членство не бачило дрейфу ролі, яку клієнт
       успадковує через іншу, уже запінену. Канон — дослівно. */
    const cr = BLOCK26.slice(BLOCK26.indexOf("with recursive cr(oid) as ("), BLOCK26.indexOf("), cur as ("));
    expect(norm(cr)).toBe(norm(`with recursive cr(oid) as (
      select r.oid from pg_roles r where r.rolname = 'authenticator'
      union
      select m.roleid from pg_auth_members m join cr on cr.oid = m.member
        join pg_roles g on g.oid = m.roleid where g.rolname <> 'service_role'`));
    expect(BLOCK26, "ролі захардкожені — нова клієнтська роль була б невидима")
      .not.toMatch(/'anon'|'authenticated'/);
  });

  it("членство в ОБИДВА боки, агрегатом на пару з грантором і трьома опціями", () => {
    const m = norm(branch("m"));
    /* Список select — дослівно (ревʼю с74, лінза Б): `toContain` імені колонки
       не доводить, що вона потрапляє в дайджест (`'grantor=' || 'supabase_admin'`
       лишав `m.grantor` у order by і тест зеленим). */
    expect(m).toContain(norm(`select 'm:' || pg_get_userbyid(m.roleid) || ':' || pg_get_userbyid(m.member) as key,
           string_agg('grantor=' || pg_get_userbyid(m.grantor)
                      || ',admin=' || m.admin_option::text
                      || ',inherit=' || m.inherit_option::text
                      || ',set=' || m.set_option::text,
                      '|' order by pg_get_userbyid(m.grantor) collate "C") as dig`));
    expect(m).toMatch(/ from pg_auth_members m where m\.roleid in \(select oid from cr\) or m\.member in \(select oid from cr\) group by m\.roleid, m\.member$/);
  });

  it("атрибути ролі — усі сім, і `rolbypassrls` серед них", () => {
    const r = norm(branch("r"));
    expect(r).toContain(norm(`select 'r:' || r.rolname,
           'super=' || r.rolsuper::text || ',createrole=' || r.rolcreaterole::text
           || ',createdb=' || r.rolcreatedb::text || ',bypassrls=' || r.rolbypassrls::text
           || ',inherit=' || r.rolinherit::text || ',login=' || r.rolcanlogin::text
           || ',replication=' || r.rolreplication::text`));
    expect(r).toMatch(/ from pg_roles r where r\.oid in \(select oid from cr\)$/);
  });

  it("налаштування ролі: поза `g:` — рівно названі таймаути й спостережуваність", () => {
    const g = norm(branch("g"));
    expect(g).toContain("coalesce((select quote_ident(d.datname) from pg_database d where d.oid = s.setdatabase), '*')");
    const m = g.match(/ from pg_db_role_setting s cross join lateral unnest\(s\.setconfig\) c\(cfg\) where s\.setrole in \(select oid from cr\) and split_part\(c\.cfg, '=', 1\) !~\* '([^']*)' group by s\.setrole, s\.setdatabase$/);
    expect(m, "where гілки g: не канонічний").not.toBeNull();
    // ⚠️ Небезпечні параметри зі списку supautils (pgrst.*, safeupdate.enabled,
    //    session_replication_role) НЕ сміють потрапити у виключення.
    expect(m![1]).toBe("^(statement_timeout|lock_timeout|idle_in_transaction_session_timeout|idle_session_timeout|transaction_timeout|deadlock_timeout|wal_compression|log_[a-z_]+|track_[a-z_]+|(pgaudit|auto_explain|pg_stat_statements|plan_filter|pg_net)[.][a-z0-9_.]+)$");
    const re = new RegExp(m![1], "i");
    for (const bad of ["session_replication_role", "pgrst.db_schemas", "safeupdate.enabled", "search_path", "role", "request.jwt.claims"]) {
      expect(re.test(bad), `${bad} опинився у виключенні`).toBe(false);
    }
  });

  it("ACL УСІХ схем (не лише public) — канонічний where і агрегат", () => {
    const n = norm(branch("n"));
    expect(n).toContain(norm(AGG));
    expect(n).toContain(norm(PV));
    expect(n).toMatch(/ from pg_namespace n cross join lateral aclexplode\(coalesce\(n\.nspacl, acldefault\('n'::"char", n\.nspowner\)\)\) a cross join lateral \(select [^)]*\) v where n\.nspname !~ '\^pg_\(toast\|temp_\|toast_temp_\)' and \(a\.grantee = 0 or a\.grantee in \(select oid from cr\)\) group by n\.nspname, a\.grantee$/);
  });

  it("default ACL: і в схемі, і ГЛОБАЛЬНИЙ, без join на pg_namespace", () => {
    const d = norm(branch("d"));
    expect(d).toContain("case when d.defaclnamespace = 0 then '*'");
    expect(d).toContain(norm(AGG));
    // `*` за grant option — у дайджесті (без PV `with grant option` не видно)
    expect(d).toContain(norm(PV));
    // inner join на pg_namespace губив рядки з namespace = 0 (урок 0167)
    expect(d, "join на pg_namespace загубить глобальний default ACL").not.toMatch(/join pg_namespace/);
    expect(d).toMatch(/ from pg_default_acl d cross join lateral aclexplode\(d\.defaclacl\) a cross join lateral \(select [^)]*\) v where a\.grantee = 0 or a\.grantee in \(select oid from cr\) group by d\.defaclrole, d\.defaclnamespace, d\.defaclobjtype, a\.grantee$/);
  });

  it("default ACL: синтетичний ключ глобального обмеження f/T без PUBLIC", () => {
    /* Ревʼю с74 (лінза А): зняття глобального `revoke … from public` видаляє
       рядок pg_default_acl, і без цього ключа №26 мовчала б. */
    expect(norm(branch("d", 1))).toBe(norm(`select 'd:' || pg_get_userbyid(d.defaclrole) || ':*:' || d.defaclobjtype::text || ':PUBLIC', '<none>'
      from pg_default_acl d
     where d.defaclnamespace = 0
       and d.defaclobjtype in ('f', 'T')
       and not exists (select 1 from aclexplode(d.defaclacl) x where x.grantee = 0)`));
  });

  it("ACL поточної бази — з acldefault, канонічний where і агрегат", () => {
    const b = norm(branch("b"));
    expect(b).toContain(norm(AGG));
    expect(b).toContain(norm(PV));
    expect(b).toMatch(/ from pg_database db cross join lateral aclexplode\(coalesce\(db\.datacl, acldefault\('d'::"char", db\.datdba\)\)\) a cross join lateral \(select [^)]*\) v where db\.datname = current_database\(\) and \(a\.grantee = 0 or a\.grantee in \(select oid from cr\)\) group by a\.grantee$/);
  });

  it("гілок у cur рівно сім (m, r, g, n, d, d-синтетична, b)", () => {
    expect((CUR26.match(/select '[a-z]:'/g) || []).map((x) => x[8]).join("")).toBe("mrgnddb");
    expect(CUR26.match(/union all/g) || []).toHaveLength(6);
  });

  it("хвіст порівняння — канон дослівно, без додаткових умов", () => {
    /* Ревʼю с74 (лінза Б): `limit 0`, `and 1 = 0`, `into v_atg`, звужений join
       чи вимкнений `not exists` лишали всі попередні піни зеленими. */
    const tail = BLOCK26.slice(BLOCK26.lastIndexOf("select array_agg(x.what order by x.what)"));
    expect(norm(tail)).toBe(norm(`select array_agg(x.what order by x.what) into v_tmp
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
        v_fail := v_fail || jsonb_build_array(jsonb_build_object(`));
  });

  it("список очікуваного — рівно 62 ключі, усі різні, з усіх шести префіксів", () => {
    expect(ROWS).toHaveLength(62);
    const keys = ROWS.map((r) => r.match(/\('([^']*)'/)![1]);
    expect(new Set(keys).size).toBe(62);
    const n = (p: string) => keys.filter((k) => k.startsWith(p + ":")).length;
    expect({ m: n("m"), r: n("r"), g: n("g"), n: n("n"), d: n("d"), b: n("b") })
      .toEqual({ m: 7, r: 3, g: 1, n: 20, d: 30, b: 1 });
    // жодної гілки поза шістьма (`p:` свідомо не заведено — див. прозу №26)
    expect(keys.filter((k) => !/^[mrgndb]:/.test(k))).toEqual([]);
  });

  it("у списку є ключі, заради яких перевірка існує", () => {
    const keys = new Set(ROWS.map((r) => r.match(/\('([^']*)'/)![1]));
    for (const k of ["m:authenticated:authenticator", "m:anon:authenticator", "r:authenticated",
      "r:anon", "n:public:authenticated", "d:postgres:public:r:anon", "b:PUBLIC", "g:authenticator:*"]) {
      expect(keys.has(k), `ключ ${k} випав`).toBe(true);
    }
    const bypass = ROWS.filter((r) => /\('r:(anon|authenticated|authenticator)'/.test(r));
    expect(bypass).toHaveLength(3);
    for (const row of bypass) expect(row).toContain("bypassrls=false");
  });

  it("перевірка загорнута у власний fail-loud обробник (канон 0174)", () => {
    expect(SRC).toMatch(
      /'check', 'role_surface', 'offenders',\s*\n\s*\/\* 0174 \*\/\s+to_jsonb\(array\['raised:'/
    );
  });
});
