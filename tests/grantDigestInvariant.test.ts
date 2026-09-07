/* ===== №22 grant_digest — СТАТИЧНИЙ сторож над сторожем (пакет 40, с59) =====
 *
 * Перевірка №22 живе В БАЗІ і читає каталог; юніт-тестом її поведінку не
 * дістати. Але с57 назвав правило прямо: перевірка, яку тримає лише лічильник
 * `checked`, — не перевірка. `where e.dig <> c.dig and false` лишає всі 22
 * зеленими, `checked` = 22, і жоден смоук цього не бачить.
 *
 * Тому тут пінимо ВЛАСТИВОСТІ блоку №22 в ОСТАННЬОМУ передруку — рівно ті, які
 * ревʼю пакета 40 назвало обходами першої редакції:
 *   • ролі НЕ хардкодом (перша редакція мала `in ('anon','authenticated')` —
 *     роль-портал, видана через `grant portal to anon`, була б невидима);
 *   • `is_grantable` у дайджесті (без нього `grant … with grant option` не
 *     міняє нічого, а роль отримує право роздавати доступ далі);
 *   • гілка f: пінить ВЛАСНИКА і ПОВНИЙ md5 тіла (7 з 11 anon-функцій не
 *     входять у список №19: підміна тіла `auth_ceo_clinics` відкривала 23
 *     політики RLS, лишаючи все зеленим);
 *   • джерело — КАТАЛОГ, не information_schema (та не показує MAINTAIN узагалі);
 *   • `changed:` каже і ОЧІКУВАНЕ, і фактичне — інакше о 03:50 offender без
 *     другого запиту не читається;
 *   • список рівно 69 ключів і всі різні.
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

const { fn: SRC, file: FILE } = latestReprint();
/** Код без коментарів: у коментарях блоку №22 свідомо цитуються обходи
 *  (`in ('anon','authenticated')`, `substr(…, 1, 12)`) — наївний пошук по
 *  всьому тексту хибно зеленів би на них (той самий клас, що в №19). */
const CODE = SRC.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");

/** Рівно блок №22: від кроку лічильника до мітки перевірки. */
const BLOCK22 = (() => {
  const at = CODE.indexOf("'check', 'grant_digest'");
  if (at < 0) throw new Error("у передруку немає мітки grant_digest");
  const start = CODE.lastIndexOf("v_n := v_n + 1;", at);
  if (start < 0) throw new Error("перед міткою №22 немає кроку лічильника");
  return CODE.slice(start, at);
})();

/** Рядки очікуваного списку: ('<префікс>:<ключ>','<дайджест>'), */
const ROWS = BLOCK22.match(/^ {6}\('[tscf]:[^']*','[^']*'\),?$/gm) || [];

describe(`№22 grant_digest — статичний сторож (${FILE})`, () => {
  it("мітка перевірки на місці: успіх + гілка винятку, і більше ніде", () => {
    expect(CODE.match(/'check',\s*'grant_digest'/g) || []).toHaveLength(2);
    expect(BLOCK22).not.toMatch(/'check',\s*'(?!grant_digest)/);
  });

  it("ролі НЕ хардкодом: беруться з членів authenticator без service_role", () => {
    expect(BLOCK22).toMatch(/pg_auth_members/);
    expect(BLOCK22).toMatch(/a\.rolname = 'authenticator'/);
    expect(BLOCK22).toMatch(/g\.rolname <> 'service_role'/);
    expect(BLOCK22).toMatch(/select 'PUBLIC'/);
    // сам обхід, яким жила перша редакція
    expect(BLOCK22, "ролі знову захардкожені").not.toMatch(/in \('anon',\s*'authenticated'\)/);
  });

  it("джерело — КАТАЛОГ: relacl / attacl / pg_proc, а не information_schema", () => {
    expect(BLOCK22).toMatch(/aclexplode\(coalesce\(c\.relacl/);
    expect(BLOCK22).toMatch(/aclexplode\(att\.attacl\)/);
    expect(BLOCK22).toMatch(/from pg_proc p/);
    expect(BLOCK22, "information_schema не показує MAINTAIN узагалі")
      .not.toMatch(/information_schema/);
  });

  it("WITH GRANT OPTION входить у дайджест обох ACL-гілок", () => {
    expect(BLOCK22.match(/is_grantable/g) || []).toHaveLength(2);
    expect(BLOCK22.match(/when t\.grantable then '\*'/g) || []).toHaveLength(1);
    expect(BLOCK22.match(/when cc\.grantable then '\*'/g) || []).toHaveLength(1);
  });

  it("чотири гілки на місці: t/s (relkind), c (колонки), f (definer-функції)", () => {
    expect(BLOCK22).toMatch(/case when c\.relkind = 'S' then 's' else 't' end/);
    expect(BLOCK22).toMatch(/c\.relkind in \('r','p','v','m','f','S'\)/);
    expect(BLOCK22).toMatch(/'c:' \|\| cc\.obj/);
    expect(BLOCK22).toMatch(/'f:' \|\| p\.oid::regprocedure::text/);
    expect(BLOCK22).toMatch(/p\.prosecdef and has_function_privilege\('anon'/);
  });

  it("гілка f: пінить ВЛАСНИКА і ПОВНИЙ md5 тіла (не усічений)", () => {
    expect(BLOCK22).toMatch(/pg_get_userbyid\(p\.proowner\)/);
    expect(BLOCK22).toMatch(/md5\(replace\(p\.prosrc, chr\(13\), ''\)\)/);
    // 12 hex перебираються за години (урок с56) — на ТІЛІ усічення заборонене
    expect(BLOCK22).not.toMatch(/substr\(md5\(replace\(p\.prosrc/);
  });

  it("усі три напрямки дрейфу дають offender, і changed: каже очікуване → фактичне", () => {
    expect(BLOCK22).toMatch(/'changed:' \|\| c\.key \|\| ':' \|\| e\.dig \|\| '->' \|\| c\.dig/);
    expect(BLOCK22).toMatch(/'new:' \|\| c\.key/);
    expect(BLOCK22).toMatch(/'missing:' \|\| e\.key/);
  });

  /* Окремим тестом, а не асертом усередині попереднього: стенд називає
     сторожа ІМЕНЕМ тесту, і дві різні мутації (формат offender-а і
     знешкоджене порівняння) мусять червонити РІЗНІ імена — інакше «сторож
     тримає» доводиться чужим спеком (урок U-80б). */
  it("порівняння дайджестів не знешкоджене константою", () => {
    expect(BLOCK22).toMatch(/where e\.dig <> c\.dig/);
    expect(BLOCK22, "порівняння вимкнене — перевірка тримається лише на лічильнику")
      .not.toMatch(/e\.dig <> c\.dig and false/);
  });

  it("список очікуваного — рівно 69 ключів, усі різні, з усіх чотирьох гілок", () => {
    expect(ROWS).toHaveLength(69);
    const keys = ROWS.map((r) => r.match(/\('([^']*)'/)![1]);
    expect(new Set(keys).size).toBe(69);
    const n = (p: string) => keys.filter((k) => k.startsWith(p)).length;
    expect([n("t:"), n("s:"), n("c:"), n("f:")]).toEqual([48, 6, 4, 11]);
  });

  it("гілка f: пінить рівно ті 11 функцій, що доступні anon, повним md5", () => {
    const f = ROWS.filter((r) => r.includes("('f:"));
    expect(f).toHaveLength(11);
    for (const row of f) {
      expect(row, row).toMatch(/','(PUBLIC|anon)\|[a-z_]+\|[0-9a-f]{32}'\)/);
    }
  });

  it("перевірка загорнута у власний fail-loud обробник (канон 0174)", () => {
    expect(SRC).toMatch(
      /'check', 'grant_digest', 'offenders',\s*\n\s*\/\* 0174 \*\/\s+to_jsonb\(array\['raised:'/
    );
  });
});
