/**
 * Піни пакета 0205 (с83, Н-22(а)): `handle_new_user` обрізає `clinic_name` /
 * `full_name` з metadata так само, як форма реєстрації (`components/RegisterPage.tsx`:
 * `trim()`, пробіли схлопуються, `NAME_MAX = 200`); порожнє після обрізки —
 * логін (як 0124); гілка `managed`, обчислення логіна, телефон — побайтово 0124.
 * Передрук сторожа: рядок №19 `handle_new_user()` з новим дайджестом (attrs ті
 * самі, склад 60), абзац прози, самопін №25.
 *
 * ЩО ТРИМАЄ ЦЕЙ ТЕСТ (статично, з ТЕКСТУ файлів):
 *  • тіло функції = тіло 0124 + РІВНО дві змінні, два присвоєння і дві
 *    підстановки в `coalesce` (код без коментарів порівнюється порядково);
 *    вираз обрізки — дослівно один і той самий для обох полів, межа 200 =
 *    `NAME_MAX` форми, схлопування форми — те саме правило;
 *  • md5 (сирий, з провідним переносом як у `prosrc`, і рецепт №19) — з тексту
 *    файлу; рядок №19 у передруку несе новий дайджест, 0204 — старий; attrs
 *    (secdef, vol, owner, lang, cfg, acl) — ті самі; ACL — пастка 0122;
 *  • тригер `on_auth_user_created` міграція НЕ чіпає (жодного DDL на тригерах і
 *    таблицях), а предстан і пост-асерти вимагають саме його і ввімкненим;
 *  • передрук: код без коментарів = код 0204 зі зміною РІВНО одного рядка;
 *    `checked` 26; перевірки №20–№26 байт у байт ті самі; підстановки накату /
 *    відкату, виконані тут у JS, дають рівно тіла 0205 / 0204;
 *  • порядок у файлі й фрагментах: предстан → функція + ACL → передрук → пін →
 *    ПОВНИЙ сторож → пост-асерти → леджер; поведінкова проба — лише там, де
 *    транзакція відкочується (dryrun, falsify), у накаті її НЕМАЄ;
 *  • смоук: один блок, мітки проб, константи = файлу; AGENTS.md.
 *  НЕ тримає поведінки в живій базі — її доводять сухий прогін, смоук і
 *  фальсифікація (протокол — `docs/audit/PR-0205-new-user-name-trim.md`).
 *
 * ⚠️ Читає 0205 і 0204 ПРИБИТИМИ шляхами: накатану міграцію не редагують.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { guardBodyOf, pinFor } from "../scripts/migration-gate-lib.mjs";

const MIGDIR = "supabase/migrations";
const MIG_FILE = "0205_new_user_name_trim.sql";
const PREV_FILE = "0204_referrer_grant_read.sql";
const HNU_SRC_FILE = "0124_login_required.sql";
const read = (p: string) => readFileSync(p, "utf8").replace(/\r/g, "");
const MIG = read(resolve(MIGDIR, MIG_FILE));
const PREV = read(resolve(MIGDIR, PREV_FILE));
const HNU_SRC = read(resolve(MIGDIR, HNU_SRC_FILE));
const APPLY = read("scripts/frag/0205_apply.sql");
const DRYRUN = read("scripts/frag/0205_dryrun.sql");
const ROLLBACK = read("scripts/frag/0205_rollback.sql");
const FALSIFY = read("scripts/frag/0205_falsify.sql");
const SMOKE = read("supabase/smoke/0205_new_user_name_trim_smoke.sql");
const FORM = read("components/RegisterPage.tsx");
const AGENTS = read("AGENTS.md");

const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");
/** Рецепт №19 (`cur`): md5(btrim(regexp_replace(prosrc, '\s+', ' ', 'g'))) — `\s` PG = [[:space:]]. */
const rec19 = (body: string) => md5(body.replace(/[ \t\n\r\f\v]+/g, " ").replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, ""));
/** Код без коментарів (обидві форми) — проза свідомо цитує вирази. */
const codeOf = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
const codeLines = (s: string) => codeOf(s).split("\n");
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

const PRE_MD5 = "cf1a920d2052a6debaff8b46c450aeff";
const PRE_LEN = 178426;
const PRE_PIN = `guard_body_md5=${PRE_MD5};len=${PRE_LEN}`;
const NEW_MD5 = "49cf5fb8af00195f1e656740248d8e43";
const NEW_LEN = 179066;
const NEW_PIN = `guard_body_md5=${NEW_MD5};len=${NEW_LEN}`;
const LEDGER_NAME = MIG_FILE;
const ACL = "postgres=X/postgres,service_role=X/postgres";

// ── handle_new_user ──────────────────────────────────────────────────────────
const HNU = "handle_new_user";
const HNU_SIG = "handle_new_user()";
const HNU_REGPROC = "public.handle_new_user()";
const HNU_ATTRS = `secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=${ACL}`;
const HNU_OLD_RAW = "0a3adc1445a761e384980ca2606e20e7";
const HNU_OLD_LEN = 1251;
const HNU_OLD_REC19 = "f894603059909d0ac8c4155202453b49";
const HNU_NEW_RAW = "742b5d69b180364e0680825768451590";
const HNU_NEW_LEN = 2022;
const HNU_NEW_REC19 = "e20e3c8342970918eb6eb1e339196a8e";
const ROW19 = (digest: string) => `      ('${HNU_SIG}','${digest}','${HNU_ATTRS}'),\n`;
const TRIGGER_DEF = "CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user()";
const HNU_HEAD = [
  `create or replace function public.${HNU}()`,
  "returns trigger",
  "language plpgsql",
  "security definer",
  "set search_path = public, pg_temp",
].join("\n");
/** Вираз обрізки — один для обох полів: схлопнути → зрізати краї → 200 → зрізати край після зрізу → порожнє = NULL. */
const NAME_MAX = 200;
const TRIM_EXPR = (key: string) =>
  `nullif(btrim(left(btrim(regexp_replace(coalesce(new.raw_user_meta_data->>'${key}', ''), '\\s+', ' ', 'g')), ${NAME_MAX})), '')`;

/** Тіла `as <tag> … <tag>` у тексті (у фрагментах їх кілька). */
function bodiesOf(txt: string, tag: string): string[] {
  const out: string[] = [];
  const open = `as ${tag}`;
  let i = txt.indexOf(open);
  while (i >= 0) {
    const a = i + open.length;
    const b = txt.indexOf(tag, a);
    if (b < 0) throw new Error(`тіло ${tag} без кінця`);
    out.push(txt.slice(a, b));
    i = txt.indexOf(open, b + tag.length);
  }
  return out;
}
function hnuBodyOf(txt: string, tag: string): string {
  const h = txt.indexOf(`create or replace function public.${HNU}()`);
  expect(h, `немає визначення ${HNU}`).toBeGreaterThanOrEqual(0);
  const bodies = bodiesOf(txt.slice(h), tag);
  expect(bodies.length, `тіл ${tag} після визначення ${HNU} не одне`).toBeGreaterThanOrEqual(1);
  return bodies[0];
}
const HNU_OLD_BODY = hnuBodyOf(HNU_SRC, "$$");
const HNU_NEW_BODY = hnuBodyOf(MIG, "$hnu$");
const HNU_NEW_STMT = `${HNU_HEAD}\nas $hnu$${HNU_NEW_BODY}$hnu$`;
const HNU_OLD_STMT = `${HNU_HEAD}\nas $hnu$${HNU_OLD_BODY}$hnu$`;

/** Пари підстановки з фрагмента (`v_from` / `v_to` — масиви `$q$…$q$`). */
function substPairs(frag: string): { from: string[]; to: string[] } {
  const arr = (label: string) => {
    const m = new RegExp(`\\n {2}${label} +constant text\\[\\] := array\\[`).exec(frag);
    const b = m ? frag.indexOf("\n  ];", m.index) : -1;
    if (!m || b < 0) throw new Error(`масив ${label} не знайдено`);
    return [...frag.slice(m.index, b).matchAll(/\$q\$([\s\S]*?)\$q\$/g)].map((x) => x[1]);
  };
  return { from: arr("v_from"), to: arr("v_to") };
}
function substitute(src: string, from: string[], to: string[]): string {
  let out = src;
  from.forEach((f, i) => {
    expect(count(out, f), `якір №${i + 1} трапляється не рівно раз`).toBe(1);
    out = out.split(f).join(to[i]);
  });
  return out;
}

const ALL_MIGS: ReadonlyArray<readonly [string, string]> = readdirSync(MIGDIR)
  .filter((f) => f.endsWith(".sql")).sort().map((f) => [f, read(resolve(MIGDIR, f))] as const);
const definesFn = (txt: string, fn: string) =>
  new RegExp(`create\\s+(or\\s+replace\\s+)?function\\s+public\\.${fn}\\s*\\(`).test(codeOf(txt));

const RP_NEW = guardBodyOf(MIG) as string;
const RP_OLD = guardBodyOf(PREV) as string;
const PROSE_0205 = [
  "  --     ⚠️ 0205 (с83, Н-22(а)) ПЕРЕДРУКУВАЛА ОДИН md5 БЕЗ ЗМІНИ СКЛАДУ (список так",
  "  --        само 60): `handle_new_user()` — `clinic_name` / `full_name` з metadata",
].join("\n");

describe("0205 — handle_new_user: обрізка clinic_name / full_name (Н-22(а))", () => {
  it("визначення: 0124 — попереднє, 0205 — останнє в репозиторії; між ними функцію ніхто не чіпав", () => {
    const defs = ALL_MIGS.filter(([, t]) => definesFn(t, HNU)).map(([f]) => f);
    expect(defs.at(-1)).toBe(MIG_FILE);
    expect(defs.at(-2)).toBe(HNU_SRC_FILE);
    const between = ALL_MIGS.filter(([f]) => f > HNU_SRC_FILE && f < MIG_FILE)
      .filter(([, t]) => /\b(alter|drop)\s+function\s+public\.handle_new_user\b/i.test(codeOf(t))).map(([f]) => f);
    expect(between).toEqual([]);
  });

  it("заголовок — trigger, plpgsql, SECURITY DEFINER, search_path = public, pg_temp; статмент у файлі дослівно", () => {
    expect(MIG).toContain(`${HNU_NEW_STMT};\n`);
    expect(count(MIG, `create or replace function public.${HNU}(`)).toBe(1);
    expect(HNU_SRC).toContain(`${HNU_HEAD}\nas $$${HNU_OLD_BODY}$$;`);
  });

  it("код тіла = код 0124 + дві змінні, два присвоєння (і порожній рядок) і дві підстановки в coalesce", () => {
    const expected: string[] = [];
    let swaps = 0;
    for (const l of codeLines(HNU_OLD_BODY)) {
      if (l === "  insert into public.clinics (name)") {
        expected.push(`  v_clinic_name := ${TRIM_EXPR("clinic_name")};`);
        expected.push(`  v_full_name   := ${TRIM_EXPR("full_name")};`);
        expected.push("");
      }
      if (l === "  values (coalesce(nullif(new.raw_user_meta_data->>'clinic_name',''), v_login, 'Моя клініка'))") {
        swaps++;
        expected.push("  values (coalesce(v_clinic_name, v_login, 'Моя клініка'))");
        continue;
      }
      if (l === "          coalesce(nullif(new.raw_user_meta_data->>'full_name',''), v_login),") {
        swaps++;
        expected.push("          coalesce(v_full_name, v_login),");
        continue;
      }
      expected.push(l);
      if (l === "  v_login       text;") {
        expected.push("  v_clinic_name text;");
        expected.push("  v_full_name   text;");
      }
    }
    expect(swaps, "у 0124 не знайдено обох coalesce, що міняються").toBe(2);
    expect(codeLines(HNU_NEW_BODY)).toEqual(expected);
    /* Нічого з 0124 не зникло: гілка managed, логін, телефон — дослівно. */
    for (const keep of [
      "  if coalesce(new.raw_user_meta_data->>'managed','') = 'true' then\n    return new;\n  end if;",
      "  v_login := lower(btrim(coalesce(new.raw_user_meta_data->>'login', '')));",
      "    v_login := public.unique_login_from_email(new.email);",
      "    v_login := public.unique_login(v_login);",
      "          new.email, nullif(new.raw_user_meta_data->>'phone',''),",
      "          'admin', true, true);",
    ]) {
      expect(HNU_NEW_BODY).toContain(keep);
      expect(HNU_OLD_BODY).toContain(keep);
    }
    expect(HNU_NEW_BODY, "сирий ключ metadata лишився в insert — обрізка обійдена").not.toMatch(/values \(coalesce\(nullif\(new\.raw_user_meta_data/);
    expect(HNU_NEW_BODY).not.toMatch(/raise\s+exception/i);
  });

  it("межа 200 = NAME_MAX форми; форма схлопує пробіли і зрізає краї тим самим правилом", () => {
    expect(FORM).toContain(`const NAME_MAX = ${NAME_MAX};`);
    expect(FORM).toContain('clinic_name: values.clinic.trim().replace(/\\s+/g, " "),');
    expect(FORM).toContain('full_name: values.fullName.trim().replace(/\\s+/g, " "),');
    expect(FORM).toMatch(/v\.trim\(\)\.length > NAME_MAX \? `Не більше \$\{NAME_MAX\} символів`/);
    expect(count(HNU_NEW_BODY, `, ${NAME_MAX})), '')`)).toBe(2);
    /* Обидві стелі — рівно NAME_MAX (розбір, а не регулярка «до першої дужки»). */
    expect([...HNU_NEW_BODY.matchAll(/\), (\d+)\)\), ''\)/g)].map((m) => m[1])).toEqual([String(NAME_MAX), String(NAME_MAX)]);
    expect(count(HNU_NEW_BODY, "left(")).toBe(2);
  });

  it("md5 тіла (сирий з провідним переносом, як у prosrc, і рецепт №19) — з тексту файлу; 0124 — старі", () => {
    expect(HNU_NEW_BODY.startsWith("\ndeclare\n")).toBe(true);
    expect(md5(HNU_NEW_BODY)).toBe(HNU_NEW_RAW);
    expect(HNU_NEW_BODY.length).toBe(HNU_NEW_LEN);
    expect(rec19(HNU_NEW_BODY)).toBe(HNU_NEW_REC19);
    expect(md5(HNU_OLD_BODY)).toBe(HNU_OLD_RAW);
    expect(HNU_OLD_BODY.length).toBe(HNU_OLD_LEN);
    expect(rec19(HNU_OLD_BODY)).toBe(HNU_OLD_REC19);
    expect(count(RP_NEW, ROW19(HNU_NEW_REC19))).toBe(1);
    expect(count(RP_NEW, ROW19(HNU_OLD_REC19))).toBe(0);
    expect(count(RP_OLD, ROW19(HNU_OLD_REC19))).toBe(1);
    expect(count(RP_OLD, ROW19(HNU_NEW_REC19))).toBe(0);
    for (const t of [MIG, APPLY, DRYRUN]) {
      expect(t).toContain(`and md5(replace(p.prosrc, chr(13), '')) = '${HNU_NEW_RAW}'`);
    }
    expect(MIG).toContain(`if v_hnu is null or v_hnu not in ('${HNU_OLD_RAW}', '${HNU_NEW_RAW}') then`);
  });

  it("ACL — пастка 0122: revoke одразу за функцією, grant лише службовій ролі; асерти в пост-блоці", () => {
    const after = MIG.slice(MIG.indexOf(`${HNU_NEW_STMT};\n`) + `${HNU_NEW_STMT};\n`.length);
    expect(after.startsWith(
      `\nrevoke all on function ${HNU_REGPROC} from public, anon, authenticated;\n`
      + `grant execute on function ${HNU_REGPROC} to service_role;\n`,
    )).toBe(true);
    const post = MIG.slice(MIG.indexOf("do $post$"), MIG.indexOf("$post$;"));
    expect(post).toContain(`has_function_privilege('anon', '${HNU_REGPROC}', 'EXECUTE')`);
    expect(post).toContain(`has_function_privilege('authenticated', '${HNU_REGPROC}', 'EXECUTE')`);
    expect(post).toContain("a.grantee = 0");
    expect(post).toContain(`if not has_function_privilege('service_role', '${HNU_REGPROC}', 'EXECUTE') then`);
    expect(post).toContain(`if v_acl is distinct from '${ACL}' then`);
    expect(count(codeOf(MIG), "revoke ")).toBe(1);
    expect(count(codeOf(MIG), "grant ")).toBe(1);
  });

  it("тригер on_auth_user_created: міграція його НЕ чіпає, предстан і пост-асерти вимагають саме його і ввімкненим", () => {
    /* Код файлу ПОЗА тілом сторожа (саме тіло законно цитує DDL у текстах перевірок). */
    const outside = codeOf(MIG.replace(RP_NEW, ""));
    /* DDL — лише на початку стейтмента (предстан/пост-асерти цитують `CREATE TRIGGER …` як ТЕКСТ очікування). */
    expect(outside).not.toMatch(/^\s*(execute\s+(\$[a-z]*\$|')?\s*)?(create\s+(or\s+replace\s+)?trigger|drop\s+trigger|alter\s+table|alter\s+policy|create\s+policy|drop\s+policy|alter\s+function|drop\s+function)\b/im);
    expect(count(outside, "CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user()/O")).toBe(2);
    for (const blk of ["$pre$", "$post$"]) {
      const b = MIG.slice(MIG.indexOf(`do ${blk}`), MIG.indexOf(`${blk};`));
      expect(b).toContain(`if v_atg is distinct from '${TRIGGER_DEF}/O' then`);
      expect(b).toContain("and not t.tgisinternal and t.tgname = 'on_auth_user_created';");
      expect(b).toContain("and p.proname = 'handle_new_user') <> 1 then");
    }
  });

  it("фрагменти: накат/сухий — той самий текст функції; відкат і проба A — тіло 0124; C — вихолощене; D — поведінка", () => {
    for (const frag of [APPLY, DRYRUN]) {
      expect(bodiesOf(frag, "$hnu$")).toEqual([HNU_NEW_BODY]);
      expect(frag).toContain(`  execute $fxa$\n${HNU_NEW_STMT}\n$fxa$;\n`);
      expect(frag).toContain(`  revoke all on function ${HNU_REGPROC} from public, anon, authenticated;\n  grant execute on function ${HNU_REGPROC} to service_role;\n`);
    }
    expect(bodiesOf(ROLLBACK, "$hnu$")).toEqual([HNU_OLD_BODY]);
    expect(ROLLBACK).toContain(`  execute $fxa$\n${HNU_OLD_STMT}\n$fxa$;\n`);
    expect(bodiesOf(FALSIFY, "$hnu$")).toEqual([HNU_OLD_BODY, HNU_NEW_BODY, "\nbegin\n  return new;\nend;\n", HNU_NEW_BODY]);
    expect(FALSIFY).toContain(`  if v_tmp is distinct from array['body:${HNU_SIG}->${HNU_OLD_REC19}']::text[] then`);
    expect(FALSIFY).toContain(`v_tmp[1] not like 'body:${HNU_SIG}->%'`);
    expect(FALSIFY).toContain(`    raise exception 'falsify: C — тригер змінився, а не мав: %', coalesce(v_atg, '(NULL)');`);
    /* Поведінкова проба — ЛИШЕ там, де транзакція відкочується. */
    expect(count(APPLY, "insert into auth.users")).toBe(0);
    expect(count(DRYRUN, "insert into auth.users")).toBe(1);
    expect(count(FALSIFY, "insert into auth.users")).toBe(1);
    for (const frag of [DRYRUN, FALSIFY]) {
      expect(frag).toContain("'managed', 'true'");
      expect(frag).toContain("if length(v_cn) <> 200 or v_cn not like 'Центр «Проба» щщщ%' or v_cn ~ '\\s\\s' or v_cn ~ '^\\s|\\s$' then");
      expect(frag).toContain("if v_fn is distinct from 'Іван Петренко' then");
      /* Проба 2: порожня назва → логін І зріз ПІБ на пробілі → 199 без хвоста (втрата другого btrim — ревʼю с83, лінза C). */
      expect(frag).toContain("'full_name', repeat('ж', 199) || ' ' || repeat('з', 50))),");
      expect(frag).toContain("if v_cn is distinct from v_lg or v_fn is distinct from repeat('ж', 199) then");
      expect(frag).toContain("@radflow.test");
      expect(frag).not.toMatch(/\bcommit\b/i);
    }
  });
});

describe("0205 — передрук сторожа", () => {
  it("пін №25 — з тіла ЦЬОГО файлу; предстан приймає лише тіло 0204 або 0205", () => {
    expect(pinFor(RP_NEW)).toBe(NEW_PIN);
    expect(pinFor(RP_OLD), "0204 на диску — не те тіло, від якого рахувались якорі").toBe(PRE_PIN);
    expect(count(MIG, `comment on function public.invariants_check(boolean) is '${NEW_PIN}';`)).toBe(1);
    expect(MIG).toContain(`if md5(v_src) not in ('${PRE_MD5}', '${NEW_MD5}') then`);
  });

  it("код без коментарів = код 0204 зі зміною РІВНО одного рядка (дайджест handle_new_user); checked 26", () => {
    const oldLines = codeLines(RP_OLD);
    const newLines = codeLines(RP_NEW);
    expect(newLines).toHaveLength(oldLines.length);
    const diff = newLines.map((l, i) => [i, oldLines[i], l] as const).filter(([, o, n]) => o !== n);
    expect(diff).toHaveLength(1);
    expect(diff[0][1]).toBe(ROW19(HNU_OLD_REC19).slice(0, -1));
    expect(diff[0][2]).toBe(ROW19(HNU_NEW_REC19).slice(0, -1));
    expect(count(codeOf(RP_NEW), "v_n := v_n + 1;")).toBe(26);
    expect(count(codeOf(RP_OLD), "v_n := v_n + 1;")).toBe(26);
    expect(RP_NEW.length - RP_OLD.length).toBe(NEW_LEN - PRE_LEN);
  });

  it("перевірки №20–№26 байт у байт ті самі; абзац 0205 — один, у блоці №19, без ' і $", () => {
    const tail = (s: string) => s.slice(s.indexOf("\n  -- 20."));
    expect(tail(RP_NEW)).toBe(tail(RP_OLD));
    expect(count(RP_NEW, PROSE_0205)).toBe(1);
    expect(count(RP_OLD, PROSE_0205)).toBe(0);
    const at = RP_NEW.indexOf(PROSE_0205);
    expect(at).toBeGreaterThan(RP_NEW.indexOf("\n  -- 19."));
    expect(at).toBeLessThan(RP_NEW.indexOf("\n  -- 20."));
    const para = RP_NEW.slice(at, RP_NEW.indexOf("\n", RP_NEW.indexOf("рівно з його дайджестом.", at)));
    expect(para.split("\n").every((l) => /^  --/.test(l))).toBe(true);
    expect(para).not.toMatch(/['$]/);
  });

  it("підстановки накату й відкату, виконані тут, дають рівно тіла 0205 і 0204", () => {
    for (const frag of [APPLY, DRYRUN]) {
      const { from, to } = substPairs(frag);
      expect(from).toHaveLength(2);
      expect(to).toHaveLength(2);
      expect(substitute(RP_OLD, from, to) === RP_NEW, "підстановка накату дала не тіло 0205").toBe(true);
    }
    const back = substPairs(ROLLBACK);
    expect(back.from).toHaveLength(2);
    expect(substitute(RP_NEW, back.from, back.to) === RP_OLD, "зворотна підстановка дала не тіло 0204").toBe(true);
  });

  it("заголовок передруку — один, і фраза заголовка не трапляється у файлі раніше", () => {
    const phrase = "create or replace function public.invariants_check";
    expect(MIG.match(/^create or replace function public\.invariants_check/gm) || []).toHaveLength(1);
    expect(MIG.indexOf(phrase)).toBe(MIG.search(/^create or replace function public\.invariants_check/m));
  });
});

describe("0205 — порядок у файлі міграції", () => {
  const code = codeOf(MIG);
  const at = (needle: string, from = 0) => {
    const i = MIG.indexOf(needle, from);
    expect(i, `у файлі немає «${needle}»`).toBeGreaterThanOrEqual(0);
    return i;
  };

  it("begin; … commit; — по одному; леджер — ОСТАННІМ перед commit; після commit — лише ВІДКАТ у коментарях", () => {
    expect(MIG.split("\n").filter((l) => l === "begin;")).toHaveLength(1);
    expect(MIG.split("\n").filter((l) => l === "commit;")).toHaveLength(1);
    expect(count(code, "insert into public.migration_ledger")).toBe(1);
    expect(MIG).toContain(`insert into public.migration_ledger (name)\nvalues ('${LEDGER_NAME}')\non conflict (name) do nothing;\n\ncommit;\n`);
    const tail = MIG.slice(MIG.indexOf("\ncommit;\n") + "\ncommit;\n".length);
    expect(codeOf(tail).trim(), "після commit є код").toBe("");
    expect(tail).toContain("=== ВІДКАТ ===");
    expect(tail).toContain("scripts/frag/0205_rollback.sql");
  });

  it("предстан → функція + ACL → передрук → пін → ПОВНИЙ сторож → пост-асерти → леджер", () => {
    const seq = [
      at("\nbegin;\n"), at("do $pre$"), at(`create or replace function public.${HNU}()`),
      at(`revoke all on function ${HNU_REGPROC}`), at(`grant execute on function ${HNU_REGPROC}`),
      at("\ncreate or replace function public.invariants_check"), at("comment on function public.invariants_check(boolean) is"),
      at("do $chk$"), at("  v_res := public.invariants_check(false);"), at("do $post$"),
      at("insert into public.migration_ledger"), at("\ncommit;\n"),
    ];
    for (let i = 1; i < seq.length; i++) expect(seq[i], `крок ${i} не після кроку ${i - 1}`).toBeGreaterThan(seq[i - 1]);
    expect(count(code, "invariants_check(false)")).toBe(1);
    expect(count(code, "invariants_check(true)")).toBe(0);
    expect(MIG).toContain("if (v_res->>'checked')::int <> 26 then");
    expect(MIG).toContain("   where e.value->>'check' not in ('gcal_sync_overdue')\n     and not (e.value->>'check' = 'ledger_md5'\n              and e.value->'offenders' = jsonb_build_array('0205_new_user_name_trim.sql'));");
  });

  it("предстан ідемпотентний: 0204 обовʼязкова, останній рядок — 0204 або 0205; тіла — 0204/0205 і 0124/0205", () => {
    const pre = MIG.slice(MIG.indexOf("do $pre$"), MIG.indexOf("$pre$;"));
    expect(pre).toContain("begin\n  perform set_config('search_path', 'public, pg_temp', true);\n  if current_user <> 'postgres' then");
    expect(pre).toContain("if not exists (select 1 from public.migration_ledger where name = '0204_referrer_grant_read.sql') then");
    expect(pre).toContain("('0204_referrer_grant_read.sql', '0205_new_user_name_trim.sql') then");
    expect(pre).toContain(`if md5(v_src) not in ('${PRE_MD5}', '${NEW_MD5}') then`);
    expect(pre).toContain(`not in ('${HNU_OLD_RAW}', '${HNU_NEW_RAW}')`);
    expect(pre).toContain("replace(p.prosrc, chr(13), '')");
    expect(pre).toContain(`if v_atg is distinct from '${TRIGGER_DEF}/O' then`);
  });

  it("у файлі немає копій тексту тіла поза тілом — інакше стенди отримають «ЯКІР НЕ УНІКАЛЬНИЙ»", () => {
    const seen = new Set<string>();
    const dup: string[] = [];
    for (const line of RP_NEW.split("\n")) {
      if (line.trim().length < 24 || seen.has(line)) continue;
      seen.add(line);
      if (count(RP_NEW, line) !== 1) continue;
      if (count(MIG, line) !== 1) dup.push(line.trim().slice(0, 70));
    }
    expect(dup).toEqual([]);
  });

  it("шапка: урок с25 — жодного `*` + `/` у рядкових коментарях; тег $hnu$ лише навколо тіла функції", () => {
    const starSlash = "*" + "/";
    expect(MIG.split("\n").filter((l) => /^\s*--/.test(l) && l.includes(starSlash))).toEqual([]);
    expect(count(MIG, "$hnu$")).toBe(2);
    for (const t of ["$apply$", "$dryrun$", "$back$", "$falsify$", "$fxa$", "$q$"]) expect(MIG).not.toContain(t);
  });
});

describe("0205 — фрагменти", () => {
  const firstStmts = (frag: string) => codeOf(frag).split("\n").filter((l) => l.trim()).slice(0, 2);

  it("перший стейтмент — бюджет часу, другий — тег блоку; маркери успіху і відкоту; lock_timeout 5s", () => {
    expect(firstStmts(APPLY)).toEqual(["set statement_timeout = '5min';", "do $apply$"]);
    expect(firstStmts(DRYRUN)).toEqual(["set statement_timeout = '5min';", "do $dryrun$"]);
    expect(firstStmts(ROLLBACK)).toEqual(["set statement_timeout = '5min';", "do $back$"]);
    expect(firstStmts(FALSIFY)).toEqual(["set statement_timeout = '5min';", "do $falsify$"]);
    for (const frag of [APPLY, DRYRUN, ROLLBACK, FALSIFY]) {
      expect(frag).toContain("perform set_config('lock_timeout', '5s', true);");
      expect(frag).toContain("perform set_config('search_path', 'public, pg_temp', true);");
      for (const t of ["$pre$", "$chk$", "$post$"]) expect(frag).not.toContain(t);
    }
    expect(DRYRUN).toContain("raise exception 'DRYRUN_0205_ROLLBACK guard=% len=% pin=% hnu_raw=% hnu_rec19_ok=% probes=3/3 ledger_last=%',");
    expect(DRYRUN).toContain(`    (select md5(btrim(regexp_replace(f.prosrc || coalesce(pg_get_function_sqlbody(f.oid)::text, ''), '\\s+', ' ', 'g'))) = '${HNU_NEW_REC19}'`);
    expect(FALSIFY).toContain("raise exception 'FALSIFY_0205 verdict=PASS probes=A,B,C,D guard=% hnu_raw=%', md5(v_src),");
    expect(count(APPLY, "raise exception 'DRYRUN")).toBe(0);
    expect(count(APPLY, "do $")).toBe(1);
    expect(count(DRYRUN, "do $")).toBe(1);
    expect(count(ROLLBACK, "do $")).toBe(1);
  });

  it("гучність: кожна відмова — raise exception (жодного notice), тексти провалу сторожа — дослівно, число raise — пін", () => {
    /* Ревʼю с83 (лінза C): пін наявності сторожа не ловить `raise exception → raise notice`. */
    for (const [frag, n] of [[APPLY, 31], [DRYRUN, 37], [ROLLBACK, 24], [FALSIFY, 20], [SMOKE, 21]] as const) {
      expect(count(frag, "raise notice")).toBe(0);
      expect(count(frag, "raise warning")).toBe(0);
      expect(count(frag, "raise exception")).toBe(n);
    }
    expect(count(MIG.replace(RP_NEW, ""), "raise notice")).toBe(0);
    expect(count(MIG.replace(RP_NEW, ""), "raise exception")).toBe(16);
    expect(APPLY).toContain("    raise exception 'apply: сторож після передруку червоний: % — %', v_failed, v_res->'failed';");
    expect(DRYRUN).toContain("    raise exception 'dryrun: сторож після передруку червоний: % — %', v_failed, v_res->'failed';");
    expect(ROLLBACK).toContain("    raise exception 'back: сторож після відкату червоний: % — %', v_failed, v_res->'failed';");
    expect(FALSIFY).toContain("    raise exception 'falsify: сторож до проб червоний: % — %', v_failed, v_res->'failed';");
    expect(MIG).toContain("  if v_failed is not null then\n    raise exception '0205: після передруку сторож червоний: % — %', v_failed, v_res->'failed';\n  end if;");
    for (const [frag, tag] of [[APPLY, "apply"], [DRYRUN, "dryrun"]] as const) {
      expect(frag).toContain(`    raise exception '${tag}: №19 після передруку червоний: %', v_tmp;`);
      expect(frag).toContain(`    raise exception '${tag}: у БД лягло % / % замість ${NEW_MD5} / ${NEW_LEN}', md5(v_src), length(v_src);`);
      expect(frag).toContain(`    raise exception '${tag}: handle_new_user після заміни не та: %', v_bad;`);
    }
  });

  it("apply і dryrun: суворий предстан (леджер рівно на 0204), повний сторож ПІСЛЯ передруку, леджер останнім", () => {
    for (const [frag, tag] of [[APPLY, "apply"], [DRYRUN, "dryrun"]] as const) {
      expect(frag).toContain(`if exists (select 1 from public.migration_ledger where name = '${LEDGER_NAME}') then\n    raise exception '${tag}: рядок уже в леджері — повторний накат заборонено';`);
      expect(frag).toContain("if (select max(name) from public.migration_ledger) is distinct from\n     '0204_referrer_grant_read.sql' then");
      expect(frag).toContain(`if md5(v_src) is distinct from '${PRE_MD5}' or length(v_src) <> ${PRE_LEN} then`);
      expect(frag).toContain(`is distinct from '${PRE_PIN}' then`);
      const seq = [
        frag.indexOf(`and md5(replace(p.prosrc, chr(13), '')) = '${HNU_OLD_RAW}'`),
        frag.indexOf("  execute $fxa$"),
        frag.indexOf(`and md5(replace(p.prosrc, chr(13), '')) = '${HNU_NEW_RAW}'`),
        frag.indexOf("  execute v_head || v_new || '$function$';"),
        frag.indexOf("execute format('comment on function public.invariants_check(boolean) is %L', v_pin_db);"),
        frag.indexOf("'check', 'guard_fn_bodies'") >= 0 ? frag.indexOf("'check', 'guard_fn_bodies'") : frag.indexOf("guard_fn_bodies_raised:"),
        frag.indexOf("  v_res := public.invariants_check(false);"),
        frag.indexOf("insert into public.migration_ledger (name)"),
      ];
      for (let i = 1; i < seq.length; i++) expect(seq[i], `${tag}: крок ${i} не після кроку ${i - 1}`).toBeGreaterThan(seq[i - 1]);
      expect(count(frag, "invariants_check(false)")).toBe(1);
      expect(frag).toContain(`if md5(v_new) is distinct from '${NEW_MD5}' or length(v_new) <> ${NEW_LEN} then`);
      expect(frag).toContain(`  if v_pin_db is distinct from '${NEW_PIN}' then`);
    }
    expect(APPLY.trimEnd().endsWith("--            hnu_acl = postgres=X/postgres,service_role=X/postgres, hnu_trigger = 1.")).toBe(true);
    expect(DRYRUN.indexOf("insert into auth.users")).toBeGreaterThan(DRYRUN.indexOf("  v_res := public.invariants_check(false);"));
    expect(DRYRUN.indexOf("insert into public.migration_ledger (name)")).toBeGreaterThan(DRYRUN.indexOf("insert into auth.users"));
    expect(DRYRUN.indexOf("raise exception 'DRYRUN_0205_ROLLBACK")).toBeGreaterThan(DRYRUN.indexOf("insert into public.migration_ledger (name)"));
  });

  it("запит №19 у фрагментах — вирізаний ДОСЛІВНО з тіла 0205 (той самий текст, що виконує сторож)", () => {
    const start = "  v_tmp := null;\n  select regexp_replace(pg_get_triggerdef(t.oid), '\\s+', ' ', 'g') || '/' || t.tgenabled::text\n    into v_atg\n";
    const end = "  exception when others then\n    v_tmp := array['guard_fn_bodies_raised:' || sqlstate || ':' || left(sqlerrm, 120)];\n  end;\n";
    expect(count(RP_NEW, start)).toBe(1);
    expect(count(RP_NEW, end)).toBe(1);
    const q = RP_NEW.slice(RP_NEW.indexOf(start), RP_NEW.indexOf(end) + end.length);
    expect(q).toContain(ROW19(HNU_NEW_REC19));
    expect(count(APPLY, q)).toBe(1);
    expect(count(DRYRUN, q)).toBe(1);
    expect(count(FALSIFY, q)).toBe(4);
    const qOld = RP_OLD.slice(RP_OLD.indexOf(start), RP_OLD.indexOf(end) + end.length);
    expect(count(ROLLBACK, qOld)).toBe(1);
    expect(count(ROLLBACK, q)).toBe(0);
  });

  it("rollback: тіло 0124, старий рядок і проза назад, пін 0204, рядок леджера знято; предстан — леджер на 0205", () => {
    expect(ROLLBACK).toContain("if (select max(name) from public.migration_ledger) is distinct from\n     '0205_new_user_name_trim.sql' then");
    expect(ROLLBACK).toContain("if not exists (select 1 from public.migration_ledger where name = '0205_new_user_name_trim.sql') then");
    expect(ROLLBACK).toContain(`if md5(v_src) is distinct from '${NEW_MD5}' or length(v_src) <> ${NEW_LEN} then`);
    expect(ROLLBACK).toContain(`if md5(v_new) is distinct from '${PRE_MD5}' or length(v_new) <> ${PRE_LEN} then`);
    expect(ROLLBACK).toContain(`  if v_pin_db is distinct from '${PRE_PIN}' then`);
    expect(ROLLBACK).toContain(`and md5(replace(p.prosrc, chr(13), '')) = '${HNU_OLD_RAW}'`);
    expect(ROLLBACK).toContain(`  delete from public.migration_ledger where name = '${LEDGER_NAME}';\n  get diagnostics v_rows = row_count;\n  if v_rows <> 1 then`);
    expect(ROLLBACK).toContain(`  revoke all on function ${HNU_REGPROC} from public, anon, authenticated;\n  grant execute on function ${HNU_REGPROC} to service_role;\n`);
    expect(count(ROLLBACK, "insert into auth.users")).toBe(0);
    /* Ревʼю с83 (лінза A, High): відкат живе у вікні «накат → db:gate», коли md5 рядка
       0205 ще NULL і №7 `ledger_md5` з ним червоний. Тому рядок леджера знімається ДО
       повного сторожа (строгого — без терпимості), і сторож бачить кінцевий стан. */
    const delAt = ROLLBACK.indexOf("  delete from public.migration_ledger where name = '0205_new_user_name_trim.sql';");
    const guardAt = ROLLBACK.indexOf("  v_res := public.invariants_check(false);");
    expect(delAt).toBeGreaterThan(0);
    expect(guardAt).toBeGreaterThan(delAt);
    expect(count(ROLLBACK, "invariants_check(false)")).toBe(1);
    expect(ROLLBACK).toContain("   where e.value->>'check' not in ('gcal_sync_overdue');\n  if v_failed is not null then\n    raise exception 'back: сторож після відкату червоний: % — %', v_failed, v_res->'failed';");
    expect(ROLLBACK.indexOf("raise exception 'back: №19 після відкату червоний: %', v_tmp;")).toBeLessThan(delAt);
  });

  it("falsify: предстан — леджер на 0205 і тіло 0205; порядок проб A → B → C → D; після кожної мутації — відновлення", () => {
    expect(FALSIFY).toContain("if (select max(name) from public.migration_ledger) is distinct from '0205_new_user_name_trim.sql' then");
    expect(FALSIFY).toContain(`if md5(v_src) is distinct from '${NEW_MD5}' or length(v_src) <> ${NEW_LEN} then`);
    const seq = [
      FALSIFY.indexOf("  -- ── A. тіло 0124 назад"),
      FALSIFY.indexOf(`  if v_tmp is distinct from array['body:${HNU_SIG}->${HNU_OLD_REC19}']::text[] then`),
      FALSIFY.indexOf("  -- ── B. тіло 0205 назад"),
      FALSIFY.indexOf("    raise exception 'falsify: №19 на тілі 0205 червоний: %', v_tmp;"),
      FALSIFY.indexOf("  -- ── C. вихолощене тіло"),
      FALSIFY.indexOf("    raise exception 'falsify: C — вихолощене тіло мусило дати рівно один body:, а дало %', coalesce(v_tmp::text, '(NULL — зелений)');"),
      FALSIFY.indexOf("    raise exception 'falsify: №19 після відновлення 0205 червоний: %', v_tmp;"),
      FALSIFY.indexOf("  -- ── D. поведінка ──"),
      FALSIFY.indexOf("insert into auth.users"),
      FALSIFY.indexOf("raise exception 'FALSIFY_0205 verdict=PASS"),
    ];
    for (let i = 1; i < seq.length; i++) expect(seq[i], `falsify: крок ${i} не після кроку ${i - 1}`).toBeGreaterThan(seq[i - 1]);
    expect(count(FALSIFY, "  execute $fxa$")).toBe(4);
    expect(count(FALSIFY, "insert into public.migration_ledger")).toBe(0);
    /* Повний сторож — РІВНО раз, ДО проб (зелена базова лінія); ledger_md5 — лише з offender-ом 0205. */
    expect(count(FALSIFY, "invariants_check(false)")).toBe(1);
    expect(count(FALSIFY, "invariants_check(true)")).toBe(0);
    expect(FALSIFY.indexOf("  v_res := public.invariants_check(false);")).toBeLessThan(seq[0]);
    expect(FALSIFY).toContain("     and not (e.value->>'check' = 'ledger_md5'\n              and e.value->'offenders' = jsonb_build_array('0205_new_user_name_trim.sql'));");
    expect(FALSIFY).toContain("if (v_res->>'checked')::int <> 26 then");
    for (const frag of [APPLY, DRYRUN, ROLLBACK]) expect(frag).not.toContain("jsonb_build_array('0205_new_user_name_trim.sql')");
  });
});

describe("0205 — смоук", () => {
  const LABELS = ["role", "0", "long", "exact", "over", "edge", "empty", "absent", "managed"];

  it("один блок; критерій — SMOKE_OK останнім; ранній вихід лише SMOKE_SKIP; жодного commit", () => {
    const code = codeOf(SMOKE);
    expect(count(code, "do $smoke$")).toBe(1);
    expect(count(code, "$smoke$;")).toBe(1);
    expect(count(code, "raise exception 'SMOKE_OK")).toBe(1);
    expect(count(code, "raise exception 'SMOKE_SKIP")).toBe(1);
    expect(code.indexOf("raise exception 'SMOKE_OK")).toBeGreaterThan(code.lastIndexOf("raise exception 'SMOKE_FAIL"));
    expect(code.indexOf("raise exception 'SMOKE_SKIP")).toBeLessThan(code.indexOf("raise exception 'SMOKE_FAIL(0)"));
    expect(code).not.toMatch(/^\s*(commit|rollback)\b/im);
    expect(code).not.toMatch(/invariants_check\(/);
    expect(SMOKE).toContain("if not exists (select 1 from public.migration_ledger where name = '0205_new_user_name_trim.sql') then\n    raise exception 'SMOKE_SKIP");
  });

  it("мітки проб — рівно ці, кожна кидає SMOKE_FAIL і кожна (крім role) лягає у v_done", () => {
    const fails = [...SMOKE.matchAll(/SMOKE_FAIL\(([a-z0-9]+)\)/g)].map((m) => m[1]);
    expect(new Set(fails)).toEqual(new Set(LABELS));
    for (const l of LABELS.filter((x) => x !== "role")) {
      expect(SMOKE, `мітка ${l} не лягає у v_done`).toMatch(new RegExp(`v_done := v_done \\|\\| '${l} ?';`));
    }
  });

  it("константи смоуку = файлу: сирий md5 функції, ACL, тіло сторожа і пін, рядок №19 новий і не старий, тригер", () => {
    expect(SMOKE).toContain(`c_hnu_md5 constant text := '${HNU_NEW_RAW}';`);
    expect(SMOKE).toContain(`c_hnu_acl constant text := '${ACL}';`);
    expect(SMOKE).toContain(`c_guard_md5 constant text := '${NEW_MD5}';`);
    expect(SMOKE).toContain(`c_guard_len constant int := ${NEW_LEN};`);
    expect(SMOKE).toContain(`c_row19 constant text := '(''${HNU_SIG}'',''${HNU_NEW_REC19}'',';`);
    expect(SMOKE).toContain(`c_row19_old constant text := '(''${HNU_SIG}'',''${HNU_OLD_REC19}'',';`);
    expect(SMOKE).toContain("if position(c_row19 in v_src) = 0 or position(c_row19_old in v_src) > 0 then");
    expect(SMOKE).toContain("c_trigger constant text := 'CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users'\n                          || ' FOR EACH ROW EXECUTE FUNCTION handle_new_user()/O';");
  });

  it("проби: межі форми (200, 201 → 200, зріз на пробілі → 199), порожнє і відсутнє → логін, managed — без профілю", () => {
    expect(SMOKE).toContain("if length(v_cn) <> 200 or v_cn <> 'Центр «Проба» ' || repeat('щ', 186) then");
    expect(SMOKE).toContain("if v_cn is distinct from repeat('в', 200) or v_fn is distinct from repeat('г', 200) then");
    expect(SMOKE).toContain("if v_cn is distinct from repeat('д', 200) or v_fn is distinct from repeat('е', 200) then");
    expect(SMOKE).toContain("if v_cn is distinct from repeat('а', 199) or v_fn is distinct from repeat('ж', 199) then");
    expect(count(SMOKE, "or v_cn is distinct from v_login or v_fn is distinct from v_login then")).toBe(2);
    expect(SMOKE).toContain("jsonb_build_object('login', v_lg[6])");
    expect(SMOKE).toContain("if v_n <> 0 or exists (select 1 from public.clinics where name = 'НЕ МАЄ З''ЯВИТИСЬ') then");
    expect(SMOKE).toContain("if v_n <> 6 then");
    expect(SMOKE).toContain("@radflow.test");
    expect(SMOKE).toContain("'+380501234567'");
    expect(count(SMOKE, "insert into auth.users")).toBe(1);
  });
});

describe("0205 — документи й правила проєкту", () => {
  it("AGENTS.md: абзац 0205 — тригер ріже як форма, NAME_MAX сводит этот тест, предел меняется миграцией с №19", () => {
    const i = AGENTS.indexOf("- **(с83 / 0205) `handle_new_user` обрезает `clinic_name` / `full_name` из metadata так же,");
    expect(i).toBeGreaterThanOrEqual(0);
    const para = AGENTS.slice(i, AGENTS.indexOf("\n- ", i + 1));
    expect(para).toContain("`NAME_MAX = 200`");
    expect(para).toContain("Триггер РЕЖЕТ, а не отказывает");
    expect(para).toContain("`tests/newUserNameTrim0205.test.ts`");
    expect(para).toContain("передрук №19 (строка `handle_new_user()` в списке)");
    expect(para).toContain("`[[:space:]]`");
    expect(para).not.toMatch(/[іїєґ]/);
  });

  it("форма реєстрації не змінилась: межа і схлопування — ті самі, що пінить тригер", () => {
    expect(count(FORM, "NAME_MAX")).toBeGreaterThanOrEqual(5);
    expect(FORM).toMatch(/maxLength: NAME_MAX/);
  });
});
