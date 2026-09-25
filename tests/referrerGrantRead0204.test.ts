/**
 * Піни пакета 0204 (с80, рішення власника 25.09.2026):
 *   • Н-14 «відкликання гранту забирає читання» — політики `queue_select`,
 *     `waitlist_select`, `cases_select_referrer` читають за `created_by` /
 *     `referrer_id` лише з АКТИВНИМ грантом до центру запису (`clinic_id in
 *     (select auth_referrer_clinics())`); `change_marker_recipients` (гілка
 *     `entry`) шле позначку ЗАПИСУ направнику лише з активним грантом; мітла
 *     `tg_ref_entry_markers_prune_on_access()` / `trg_zzz_ref_entry_markers_prune`
 *     знімає його позначки записів, щойно грант перестає бути активним; №14 —
 *     гілка `unreachable:` (НЕПРОЧИТАНА позначка запису, якого отримувач не
 *     бачить; раунд ревʼю 2 — лише непрочитані);
 *   • Н-17 — №17 пінить ПОРЯДОК: гілка `order:` (гард ключів 0203 — останній
 *     BEFORE-тригер рядка на трьох таблицях).
 *
 * ЩО ТРИМАЄ ЦЕЙ ТЕСТ (статично, з ТЕКСТУ файлів):
 *  • політики: рівно три `alter policy`, гілка ключа — кон'юнкт із грантом,
 *    гілка персоналу — байт у байт та, що була (відкат несе її ж); дайджести
 *    №16 рахуються тут із рендеру PG (знятого реплеєм і проду) — не з генератора;
 *  • `change_marker_recipients`: тіло = тіло 0184 + РІВНО п'ять рядків умови
 *    гранту; md5 (сирий і рецепт №19) — з тексту файлу; ACL — пастка 0122;
 *  • мітла: властивості правила (стара пара, три типи записів, вихід для
 *    неактивного гранту і для того самого живого гранту, `new.` лише в гілці
 *    UPDATE, жодного raise), ACL, DDL тригера, рядок №17, відсутність у №19;
 *  • передрук: код без коментарів = код 0203 + два блоки гілок і рядок №17,
 *    чотири рядки змінено (три №16, один №19); `checked` 26; перевірки
 *    №20–№26 байт у байт ті самі; підстановки накату/відкату, виконані тут у
 *    JS, дають рівно тіла 0204/0203;
 *  • порядок у файлі й фрагментах: повний сторож — ДО DDL на таблицях (урок
 *    0196), після DDL — лише мілісекундні запити №16/№17 із живого тіла;
 *  • замір сухого прогону — ДО DDL і без пастки NULL-логіки (`coalesce`);
 *  • смоук і суміжні смоуки (`rls_initplan`, `search_roles`), AGENTS.md.
 *  НЕ тримає поведінки в живій базі — її доводять сухий прогін, смоук і
 *  фальсифікація (протокол — `docs/audit/PR-0204-referrer-grant-read.md`).
 *
 * ⚠️ Читає 0204 ПРИБИТИМ шляхом: накатану міграцію не редагують. Наявність
 *    пари мітли й гілки `order:` в ОСТАННЬОМУ передруку стереже
 *    `tests/guardTriggersInvariant.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { guardBodyOf, pinFor } from "../scripts/migration-gate-lib.mjs";

const MIGDIR = "supabase/migrations";
const MIG_FILE = "0204_referrer_grant_read.sql";
const PREV_FILE = "0203_audit_pii_referrer_grant.sql";
const CMR_SRC_FILE = "0184_rf03b_sched_marker_fanout.sql";
const read = (p: string) => readFileSync(p, "utf8").replace(/\r/g, "");
const MIG = read(resolve(MIGDIR, MIG_FILE));
const PREV = read(resolve(MIGDIR, PREV_FILE));
const CMR_SRC = read(resolve(MIGDIR, CMR_SRC_FILE));
const APPLY = read("scripts/frag/0204_apply.sql");
const DRYRUN = read("scripts/frag/0204_dryrun.sql");
const ROLLBACK = read("scripts/frag/0204_rollback.sql");
const FALSIFY = read("scripts/frag/0204_falsify.sql");
const APPLY_0203 = read("scripts/frag/0203_apply.sql");
const SMOKE = read("supabase/smoke/0204_referrer_grant_read_smoke.sql");

const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
/** Код без коментарів (обидві форми) — проза свідомо цитує політики й предикати. */
const codeOf = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
const byC = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const PRE_MD5 = "8c8e6403db7653949e03d026320c6099";
const PRE_LEN = 170446;
const PRE_PIN = `guard_body_md5=${PRE_MD5};len=${PRE_LEN}`;
const NEW_MD5 = "cf1a920d2052a6debaff8b46c450aeff";
const NEW_LEN = 178426;
const NEW_PIN = `guard_body_md5=${NEW_MD5};len=${NEW_LEN}`;
const LEDGER_NAME = MIG_FILE;
const SENTINEL_CALL = "  v_res := public.invariants_check(false);";
const SENTINEL_ANY_CALL = /invariants_check\s*\((true|false)?\)/;
const ACL = "postgres=X/postgres,service_role=X/postgres";

// ── Політики ─────────────────────────────────────────────────────────────────
const KEY_OLD = "(created_by = (select auth.uid())) or (referrer_id = (select auth.uid()))";
const KEY_NEW = "((created_by = (select auth.uid())) or (referrer_id = (select auth.uid()))) and (clinic_id in (select auth_referrer_clinics()))";
/** Рендер `pg_policies.qual` (пробіли стиснуто) — знятий реплеєм PG16 і
 *  збіжний із прод-дайджестами PG17 (оркестратор, 25.09). */
const POLICIES = [
  {
    tbl: "patient_cases", pol: "cases_select_referrer", oldDig: "d6b423f8c727", newDig: "a406bc42d13d",
    oldRender: "((created_by = ( SELECT auth.uid() AS uid)) OR (referrer_id = ( SELECT auth.uid() AS uid)))",
    newRender: "(((created_by = ( SELECT auth.uid() AS uid)) OR (referrer_id = ( SELECT auth.uid() AS uid))) AND (clinic_id IN ( SELECT auth_referrer_clinics() AS auth_referrer_clinics)))",
    staff: null as string | null,
  },
  {
    tbl: "queue_entries", pol: "queue_select", oldDig: "ff3f89d6a1a2", newDig: "6061c08c210b",
    oldRender: "(((clinic_id = auth_clinic_id()) AND ((( SELECT auth_role() AS auth_role) IS DISTINCT FROM 'radiologist'::user_role) OR auth_radiologist_room_ok(room_id))) OR (created_by = ( SELECT auth.uid() AS uid)) OR (referrer_id = ( SELECT auth.uid() AS uid)))",
    newRender: "(((clinic_id = auth_clinic_id()) AND ((( SELECT auth_role() AS auth_role) IS DISTINCT FROM 'radiologist'::user_role) OR auth_radiologist_room_ok(room_id))) OR (((created_by = ( SELECT auth.uid() AS uid)) OR (referrer_id = ( SELECT auth.uid() AS uid))) AND (clinic_id IN ( SELECT auth_referrer_clinics() AS auth_referrer_clinics))))",
    staff: "((clinic_id = auth_clinic_id()) and (((select auth_role()) is distinct from 'radiologist'::user_role) or auth_radiologist_room_ok(room_id)))",
  },
  {
    tbl: "waitlist_entries", pol: "waitlist_select", oldDig: "659164e8f637", newDig: "0cf225150efe",
    oldRender: "(((clinic_id = ( SELECT auth_clinic_id() AS auth_clinic_id)) AND ((( SELECT auth_role() AS auth_role) IS DISTINCT FROM 'radiologist'::user_role) OR auth_radiologist_room_ok(room_id))) OR (created_by = ( SELECT auth.uid() AS uid)) OR (referrer_id = ( SELECT auth.uid() AS uid)))",
    newRender: "(((clinic_id = ( SELECT auth_clinic_id() AS auth_clinic_id)) AND ((( SELECT auth_role() AS auth_role) IS DISTINCT FROM 'radiologist'::user_role) OR auth_radiologist_room_ok(room_id))) OR (((created_by = ( SELECT auth.uid() AS uid)) OR (referrer_id = ( SELECT auth.uid() AS uid))) AND (clinic_id IN ( SELECT auth_referrer_clinics() AS auth_referrer_clinics))))",
    staff: "((clinic_id = (select auth_clinic_id())) and (((select auth_role()) is distinct from 'radiologist'::user_role) or auth_radiologist_room_ok(room_id)))",
  },
] as const;
/** Рецепт №16 (0170): md5(cmd|permissive|roles|qual|with_check), 12 знаків. */
const dig16 = (render: string) => md5(`SELECT|PERMISSIVE|authenticated|${render}|`).slice(0, 12);
const ddlOf = (p: (typeof POLICIES)[number], key: string) => p.staff
  ? `alter policy ${p.pol} on public.${p.tbl} using (\n  ${p.staff}\n  or ${key}\n);`
  : `alter policy ${p.pol} on public.${p.tbl} using (\n  ${key}\n);`;
const DDL_NEW = POLICIES.map((p) => ddlOf(p, p.staff ? `(${KEY_NEW})` : KEY_NEW));
const DDL_OLD = POLICIES.map((p) => ddlOf(p, KEY_OLD));
/** Усередині `do`-блоку фрагмента DDL іде з відступом у два пробіли. */
const indent2 = (x: string) => x.split("\n").map((l) => (l ? `  ${l}` : l)).join("\n");

// ── change_marker_recipients ─────────────────────────────────────────────────
const CMR = "change_marker_recipients";
const CMR_REGPROC = "public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean)";
const CMR_SIG19 = "change_marker_recipients(p_clinic uuid, p_actor uuid, p_scope_kind text, p_room uuid, p_referrer uuid, p_severity text, p_room_relevant boolean)";
const CMR_ATTRS = `secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=${ACL}`;
const CMR_OLD_RAW = "cef6f91b5dd1dcdc35e93fd732cf7162";
const CMR_OLD_REC19 = "259d744f8db5189360b6b3ef2f81b3cc";
const CMR_NEW_RAW = "c7a602edb861ecceb598e4d65534345d";
const CMR_NEW_REC19 = "48ecffeeaba0b8e899fa34f37fdf2a2b";
const CMR_GRANT_LINES = [
  "       and (p_scope_kind = 'access'",
  "            or exists (select 1 from public.referral_access ra",
  "                        where ra.referrer_id = p_referrer",
  "                          and ra.clinic_id = p_clinic",
  "                          and ra.status = 'active'))",
];
/** Тіло функції (prosrc) — від `\n` після тега до `\n` перед закриттям. */
const bodyBetween = (stmt: string, tag: string) =>
  stmt.slice(stmt.indexOf(`as ${tag}`) + `as ${tag}`.length, stmt.lastIndexOf(`\n${tag};`) + 1);
const stmtOf = (src: string, head: string, tag: string, file: string) => {
  const a = src.indexOf(head);
  const b = src.indexOf(`\n${tag};`, a);
  if (a < 0 || b < 0) throw new Error(`${file}: стейтмент «${head}» не знайдено`);
  return src.slice(a, b + `\n${tag};`.length);
};
const CMR_STMT = stmtOf(MIG, `create or replace function public.${CMR}(`, "$cmr$", MIG_FILE);
const CMR_BODY = bodyBetween(CMR_STMT, "$cmr$");
/** Тіло 0184 — останнє визначення до 0204 (тег у файлі 0184 — свій). */
const CMR_OLD_BODY = (() => {
  const m = /create or replace function public\.change_marker_recipients\([\s\S]*?\nas (\$[a-z_]*\$)/.exec(CMR_SRC);
  if (!m) throw new Error(`${CMR_SRC_FILE}: визначення ${CMR} не знайдено`);
  const tag = m[1];
  const stmt = CMR_SRC.slice(m.index, CMR_SRC.indexOf(`\n${tag};`, m.index) + `\n${tag};`.length);
  return bodyBetween(stmt, tag);
})();
const CMR_ACL_DDL = `revoke all on function ${CMR_REGPROC} from public, anon, authenticated;\n` +
  `grant execute on function ${CMR_REGPROC} to service_role;`;

// ── Мітла ────────────────────────────────────────────────────────────────────
const PRUNE = "tg_ref_entry_markers_prune_on_access";
const PRUNE_TG = "trg_zzz_ref_entry_markers_prune";
const PRUNE_RAW = "a7d7f8876e46fc9a3b7a0efcf378bbfa";
const PRUNE_STMT = stmtOf(MIG, `create or replace function public.${PRUNE}()`, "$prune$", MIG_FILE);
const PRUNE_BODY = bodyBetween(PRUNE_STMT, "$prune$");
const PRUNE_CODE = codeOf(PRUNE_BODY);
const PRUNE_ACL_DDL = `revoke all on function public.${PRUNE}() from public, anon, authenticated;\n` +
  `grant execute on function public.${PRUNE}() to service_role;`;
const PRUNE_TG_DDL = `drop trigger if exists ${PRUNE_TG} on public.referral_access;\n` +
  `create trigger ${PRUNE_TG}\n  after delete or update on public.referral_access\n` +
  `  for each row execute function public.${PRUNE}();`;
const PRUNE_ROW17 = `      ('referral_access','${PRUNE_TG}','CREATE TRIGGER ${PRUNE_TG} AFTER DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION ${PRUNE}()'),`;

// ── Передруки сторожа: 0204 і 0203 ───────────────────────────────────────────
const reprintOf = (txt: string, file: string) => {
  const at = txt.search(/^create or replace function public\.invariants_check/m);
  const end = txt.indexOf("\n$function$;", at);
  if (at < 0 || end < 0) throw new Error(`${file}: передрук invariants_check не знайдено`);
  return txt.slice(at, end);
};
const RP_NEW = reprintOf(MIG, MIG_FILE);
const RP_OLD = reprintOf(PREV, PREV_FILE);
const codeLines = (s: string) => codeOf(s).split("\n");
/** Посилка накату/сухого/файлу: недосяжні НЕПРОЧИТАНІ позначки записів (предикат №14). */
const PREMISE_UNREAD = (m: string, p: string) => [
  `           where ${m}.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')`,
  `             and ${m}.seen_at is null`,
  `             and ${p}.clinic_id is distinct from ${m}.clinic_id`,
  "",
].join("\n");

/** Нові блоки коду в тілі (без рядків-коментарів) — рівно те, що заявлено. */
const B14 = [
  "      union all",
  "      select 'unreachable:' || m.entity_type || ':' || count(*)",
  "        from public.user_change_markers m",
  "        join public.profiles p on p.id = m.recipient_id",
  "       where m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')",
  "         and m.seen_at is null",
  "         and p.clinic_id is distinct from m.clinic_id",
  "         and not exists (select 1 from public.referral_access ra",
  "                          where ra.referrer_id = m.recipient_id",
  "                            and ra.clinic_id = m.clinic_id",
  "                            and ra.status = 'active')",
  "       group by m.entity_type",
];
const ORDER_LATERAL = [
  "          select t.tgname from pg_trigger t",
  "           where t.tgrelid = c.oid and not t.tgisinternal",
  "             and (t.tgtype & 3) = 3 and (t.tgtype & 20) <> 0",
  "           order by t.tgname collate \"C\" desc limit 1) x",
];
const B17 = [
  "      union all",
  "      select 'order:' || c.relname || '->' || x.tgname",
  "        from pg_class c",
  "        cross join lateral (",
  ...ORDER_LATERAL,
  "       where c.oid in (to_regclass('public.patient_cases'), to_regclass('public.queue_entries'),",
  "                       to_regclass('public.waitlist_entries'))",
  "         and x.tgname <> 'zz_guard_read_keys'",
];
const row16 = (tbl: string, pol: string, dig: string) => `      ('${tbl}','${pol}','${dig}'),`;
const row19 = (rec: string) => `      ('${CMR_SIG19}','${rec}','${CMR_ATTRS}'),`;
/** Змінені рядки: нове → старе. */
const CHANGED = new Map<string, string>([
  ...POLICIES.map((p) => [row16(p.tbl, p.pol, p.newDig), row16(p.tbl, p.pol, p.oldDig)] as [string, string]),
  [row19(CMR_NEW_REC19), row19(CMR_OLD_REC19)],
]);
/** Видалити з масиву рівно одне входження суцільного блоку. */
function removeBlock(lines: string[], block: string[], what: string): string[] {
  const hits: number[] = [];
  for (let i = 0; i + block.length <= lines.length; i++) {
    if (block.every((b, j) => lines[i + j] === b)) hits.push(i);
  }
  expect(hits, `${what}: блок трапляється не рівно раз`).toHaveLength(1);
  return [...lines.slice(0, hits[0]), ...lines.slice(hits[0] + block.length)];
}

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

describe("0204 — політики читання (Н-14)", () => {
  it("рівно три `alter policy`, саме цих трьох політик; жодних create/drop policy і політик запису", () => {
    const code = codeOf(MIG);
    expect(count(code, "alter policy ")).toBe(3);
    expect(code).not.toMatch(/\b(create|drop)\s+policy\b/i);
    for (const p of POLICIES) expect(count(code, `alter policy ${p.pol} on public.${p.tbl} using (`)).toBe(1);
    /* `queue_write_referrer` (FOR ALL) і `waitlist_write_referrer` грант уже
       вимагали — пакет їх не чіпає (рішення оркестратора); їхні рядки №16 —
       ті самі, що в 0203 */
    expect(code).not.toMatch(/alter\s+policy\s+(queue|waitlist)_write_referrer/i);
    for (const r of RP_OLD.match(/^ {6}\('(queue|waitlist)_entries','(queue|waitlist)_write_referrer','[0-9a-f]{12}'\),?$/gm) || []) {
      expect(count(RP_NEW, `${r}\n`), `рядок №16 «${r.trim()}» змінився`).toBe(1);
    }
  });

  it("DDL — дослівно рішення: гілка ключа — КОН'ЮНКТ із грантом, гілка персоналу — та сама, що була", () => {
    for (const ddl of DDL_NEW) expect(count(MIG, ddl), `у файлі немає «${ddl.split("\n")[0]}»`).toBe(1);
    /* відкат несе стару форму — і гілка персоналу в ній байт у байт та сама */
    for (const ddl of DDL_OLD) expect(ROLLBACK, `відкат не повертає «${ddl.split("\n")[0]}»`).toContain(indent2(ddl));
    for (const p of POLICIES.filter((x) => x.staff)) {
      expect(count(MIG, `  ${p.staff}\n  or (${KEY_NEW})\n);`)).toBe(1);
    }
    /* «будь-хто з грантом» (диз'юнкт) — мутація, яку ловить r-colleague смоука */
    expect(MIG).not.toContain(`or (clinic_id in (select auth_referrer_clinics()))`);
  });

  it("дайджести №16 — рецептом 0170 з рендеру PG, а в передруку стоять саме вони (старі — у 0203)", () => {
    for (const p of POLICIES) {
      expect(dig16(p.newRender), `${p.pol}: новий рендер дає інший дайджест`).toBe(p.newDig);
      expect(dig16(p.oldRender), `${p.pol}: старий рендер дає інший дайджест`).toBe(p.oldDig);
      expect(count(RP_NEW, `${row16(p.tbl, p.pol, p.newDig)}\n`)).toBe(1);
      expect(count(RP_OLD, `${row16(p.tbl, p.pol, p.oldDig)}\n`)).toBe(1);
      expect(RP_NEW).not.toContain(`'${p.pol}','${p.oldDig}'`);
      /* рендер — точний образ DDL (auth.uid() → InitPlan, and/or великими) */
      expect(p.newRender.replace(/\( SELECT auth\.uid\(\) AS uid\)/g, "(select auth.uid())")
        .replace(/\( SELECT auth_referrer_clinics\(\) AS auth_referrer_clinics\)/g, "(select auth_referrer_clinics())"))
        .toContain("OR (referrer_id = (select auth.uid()))) AND (clinic_id IN (select auth_referrer_clinics()))");
    }
    const rows = RP_NEW.match(/^ {6}\('[a-z_]+','[a-z_0-9]+','[0-9a-f]{12}'\),?$/gm) || [];
    expect(rows).toHaveLength(63);
  });

  it("накат, сухий прогін і фальсифікація несуть DDL ДОСЛІВНО; відкат і M16 — стару форму", () => {
    const indent = (s: string) => s.split("\n").map((l) => (l ? `  ${l}` : l)).join("\n");
    const block = DDL_NEW.join("\n");
    expect(count(MIG, block)).toBe(1);
    for (const [lbl, txt] of [["apply", APPLY], ["dryrun", DRYRUN]] as const) {
      expect(count(txt, indent(block)), `${lbl}: DDL політик не той, що у файлі`).toBe(1);
      expect(count(codeOf(txt), "alter policy "), `${lbl}: зайвий alter policy`).toBe(3);
    }
    for (const ddl of DDL_OLD) expect(FALSIFY, "M16: старої форми політики немає").toContain(indent2(ddl));
  });
});

describe("0204 — change_marker_recipients: гілка entry лише з активним грантом", () => {
  it("визначення: 0184 — попереднє, 0204 — останнє в репозиторії", () => {
    const defs = ALL_MIGS.filter(([, txt]) => definesFn(txt, CMR)).map(([f]) => f);
    expect(defs.at(-1)).toBe(MIG_FILE);
    expect(defs.at(-2)).toBe(CMR_SRC_FILE);
    expect(count(codeOf(MIG), `create or replace function public.${CMR}(`)).toBe(1);
  });

  it("код тіла = код 0184 + РІВНО п'ять рядків умови гранту після перевірки профілю", () => {
    const newL = codeLines(CMR_BODY);
    const oldL = codeLines(CMR_OLD_BODY);
    const anchor = "       and exists (select 1 from public.profiles pr where pr.id = p_referrer)";
    const at = newL.indexOf(anchor);
    expect(at, "якір (перевірка профілю 0134) зник").toBeGreaterThan(0);
    expect(newL.slice(at + 1, at + 1 + CMR_GRANT_LINES.length)).toEqual(CMR_GRANT_LINES);
    expect([...newL.slice(0, at + 1), ...newL.slice(at + 1 + CMR_GRANT_LINES.length)]).toEqual(oldL);
    /* `access` — без гранту (повідомлення про відкликання мусить дійти) */
    expect(norm(codeOf(CMR_BODY))).toContain("and p_scope_kind in ('entry', 'access')");
  });

  it("md5 тіла (сирий і рецепт №19) — з тексту файлу; рядок №19 передруковано, 0203 мав 0184", () => {
    expect([...CMR_STMT].some((ch) => /\s/.test(ch) && ch !== " " && ch !== "\n"),
      "у тексті є табуляція або не-ASCII пробіл").toBe(false);
    expect(md5(CMR_BODY)).toBe(CMR_NEW_RAW);
    expect(md5(norm(CMR_BODY))).toBe(CMR_NEW_REC19);
    expect(md5(CMR_OLD_BODY)).toBe(CMR_OLD_RAW);
    expect(md5(norm(CMR_OLD_BODY))).toBe(CMR_OLD_REC19);
    expect(count(RP_NEW, `${row19(CMR_NEW_REC19)}\n`)).toBe(1);
    expect(count(RP_OLD, `${row19(CMR_OLD_REC19)}\n`)).toBe(1);
  });

  it("ACL — пастка 0122: revoke одразу за функцією, grant лише службовій ролі; асерти в пост-блоці", () => {
    expect(MIG).toContain(`${CMR_STMT}\n\n${CMR_ACL_DDL}`);
    const post = codeOf(MIG.slice(MIG.indexOf("do $post$"), MIG.indexOf("$post$;")));
    for (const needle of [
      `has_function_privilege('anon', '${CMR_REGPROC}', 'EXECUTE')`,
      `has_function_privilege('authenticated', '${CMR_REGPROC}', 'EXECUTE')`,
      `if not has_function_privilege('service_role', '${CMR_REGPROC}', 'EXECUTE') then`,
      `and md5(replace(p.prosrc, chr(13), '')) = '${CMR_NEW_RAW}'`,
      "and p.proretset and p.prorettype = 'uuid'::regtype and pg_get_function_result(p.oid) = 'TABLE(recipient_id uuid)'",
    ]) expect(post, `пост-асерт файлу: немає «${needle}»`).toContain(needle);
    expect(post).toContain(`if v_acl is distinct from '${ACL}' then`);
  });

  it("фрагменти: накат/сухий — той самий текст функції; відкат і M19 — тіло 0184", () => {
    const inExec = (s: string) => s.replace(/;\s*$/, "");
    for (const [lbl, txt] of [["apply", APPLY], ["dryrun", DRYRUN]] as const) {
      expect(count(txt, inExec(CMR_STMT)), `${lbl}: текст функції не той, що у файлі`).toBe(1);
    }
    for (const [lbl, txt] of [["rollback", ROLLBACK], ["falsify", FALSIFY]] as const) {
      expect(count(txt, CMR_OLD_BODY), `${lbl}: тіла 0184 немає`).toBe(1);
    }
    expect(FALSIFY).toContain(`v_want19 constant text[] := array['body:${CMR_SIG19}->${CMR_OLD_REC19}']::text[];`);
  });
});

describe("0204 — мітла позначок записів при відкликанні", () => {
  it("заголовок: trigger, plpgsql, SECURITY DEFINER, search_path = public, pg_temp; сирий md5 — з тексту", () => {
    expect(norm(PRUNE_STMT.slice(0, PRUNE_STMT.indexOf("as $prune$") + "as $prune$".length)))
      .toBe(`create or replace function public.${PRUNE}() returns trigger language plpgsql security definer set search_path = public, pg_temp as $prune$`);
    expect(md5(PRUNE_BODY)).toBe(PRUNE_RAW);
    for (const [lbl, txt] of [[MIG_FILE, MIG], ["apply", APPLY], ["dryrun", DRYRUN], ["falsify", FALSIFY]] as const) {
      expect(txt, `${lbl}: сирого md5 мітли немає`).toContain(`'${PRUNE_RAW}'`);
    }
  });

  it("правило: стара пара, три типи ЗАПИСІВ, позначки centers/referral_access не чіпає", () => {
    expect(count(PRUNE_CODE, "delete from")).toBe(1);
    expect(norm(PRUNE_CODE)).toContain(
      "delete from public.user_change_markers m where m.recipient_id = old.referrer_id and m.clinic_id = old.clinic_id " +
      "and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case'); return null;");
    expect(PRUNE_CODE).not.toMatch(/referral_access'|centers|surface_key/);
  });

  it("виходи: не був активним — до DELETE; UPDATE того самого живого гранту — вихід; `new.` лише в гілці UPDATE", () => {
    const n = norm(PRUNE_CODE);
    const del = n.indexOf("delete from");
    const notActive = n.indexOf("if old.status is distinct from 'active' then return null; end if;");
    const same = n.indexOf("if tg_op = 'UPDATE' then if new.status = 'active' and new.referrer_id is not distinct from old.referrer_id " +
      "and new.clinic_id is not distinct from old.clinic_id then return null; end if; end if;");
    expect(notActive).toBeGreaterThan(0);
    expect(same).toBeGreaterThan(notActive);
    expect(del).toBeGreaterThan(same);
    /* на DELETE рядок `new` порожній: кон'юнкт із `tg_op` не врятує (канон 0184) */
    expect((PRUNE_CODE.match(/\bnew\./g) || []).length).toBe(3);
    expect(count(PRUNE_CODE, "return null;")).toBe(3);
    expect(PRUNE_CODE).not.toMatch(/return\s+new|raise|exception|current_user|session_user|current_setting|request\.jwt|auth\./i);
    /* кабінети гранту — не межа читання за ключем: їх зміна нічого не знімає */
    expect(PRUNE_CODE).not.toContain("room_ids");
  });

  it("ACL і DDL тригера: AFTER DELETE OR UPDATE на referral_access, рядок №17, у №19 — НІ", () => {
    expect(MIG).toContain(`${PRUNE_STMT}\n\n${PRUNE_ACL_DDL}`);
    expect(count(MIG, PRUNE_TG_DDL)).toBe(1);
    const indent = (s: string) => s.split("\n").map((l) => (l ? `  ${l}` : l)).join("\n");
    for (const [lbl, txt] of [["apply", APPLY], ["dryrun", DRYRUN]] as const) {
      expect(count(txt, indent(PRUNE_TG_DDL)), `${lbl}: DDL тригера не той`).toBe(1);
      expect(count(txt, indent(PRUNE_ACL_DDL)), `${lbl}: ACL мітли не той`).toBe(1);
    }
    expect(count(RP_NEW, `${PRUNE_ROW17}\n`)).toBe(1);
    /* межа імені: мітли позначок №19 не пінить (як і мітлу графіка 0184) */
    expect(RP_NEW).not.toMatch(new RegExp(`^ {6}\\('${PRUNE}\\(\\)','`, "m"));
    expect(RP_NEW).not.toMatch(/^ {6}\('tg_sched_markers_prune_on_access\(\)','/m);
    /* після емітера позначок (`trg_zz_change_markers`) — за C-абеткою */
    expect(["trg_zz_change_markers", PRUNE_TG, "trg_zzz_sched_markers_prune"].sort(byC))
      .toEqual(["trg_zz_change_markers", PRUNE_TG, "trg_zzz_sched_markers_prune"]);
  });
});

describe("0204 — передрук сторожа", () => {
  it("пін №25 — з тіла ЦЬОГО файлу; предстан приймає лише тіло 0203 або 0204", () => {
    expect(pinFor(guardBodyOf(MIG) as string)).toBe(NEW_PIN);
    expect(pinFor(guardBodyOf(PREV) as string), "0203 на диску — не те тіло, від якого рахувались якорі").toBe(PRE_PIN);
    expect(count(MIG, `comment on function public.invariants_check(boolean) is '${NEW_PIN}';`)).toBe(1);
    expect(MIG).toContain(`if md5(v_src) not in ('${PRE_MD5}', '${NEW_MD5}') then`);
  });

  it("код без коментарів = код 0203 + блок №14 + блок order: + рядок №17; змінено рівно чотири рядки", () => {
    let rest = codeLines(RP_NEW);
    rest = removeBlock(rest, B14, "№14 unreachable:");
    rest = removeBlock(rest, B17, "№17 order:");
    rest = removeBlock(rest, [PRUNE_ROW17], "№17 рядок мітли");
    let changed = 0;
    rest = rest.map((l) => {
      const o = CHANGED.get(l);
      if (o) changed++;
      return o ?? l;
    });
    expect(changed, "змінених рядків не чотири").toBe(4);
    expect(rest, "передрук змінив щось поза заявленим").toEqual(codeLines(RP_OLD));
    expect(count(codeOf(RP_NEW), "v_n := v_n + 1;")).toBe(26);
    expect(count(codeOf(RP_OLD), "v_n := v_n + 1;")).toBe(26);
  });

  it("перевірки №20–№26 байт у байт ті самі (№22/№23/№26 пакет не зачіпає)", () => {
    const tail = (s: string) => s.slice(s.indexOf("\n  -- 20."));
    expect(RP_NEW.indexOf("\n  -- 20.")).toBeGreaterThan(0);
    expect(tail(RP_NEW) === tail(RP_OLD), "хвіст тіла від №20 змінився").toBe(true);
  });

  it("№17: 31 рядок, унікальні, у порядку C; гілка order: — бічний підзапит ДОСЛІВНО з асерту накату 0203", () => {
    const rows = RP_NEW.match(/^ {6}\('[a-z_]+','[a-z0-9_]+','CREATE TRIGGER [^\n]*$/gm) || [];
    expect(rows).toHaveLength(31);
    const keys = rows.map((r) => r.slice(0, r.indexOf(",'CREATE TRIGGER ")));
    expect(new Set(keys).size).toBe(31);
    const tuples = keys.map((k) => k.slice(8, -1).split("','"));
    expect(tuples).toEqual([...tuples].sort((a, b) => byC(a[0], b[0]) || byC(a[1], b[1])));
    expect(APPLY_0203, "у накаті 0203 асерт порядку інший — гілка вже не «дослівно»")
      .toContain(`    cross join lateral (\n${ORDER_LATERAL.map((l) => l.slice(4)).join("\n")}\n`);
    expect(count(RP_NEW, `        cross join lateral (\n${ORDER_LATERAL.join("\n")}\n`)).toBe(1);
  });

  it("№14: гілка unreachable: рівно одна, у перевірці ucm_orphan_markers; предстан файлу — той самий предикат", () => {
    expect(count(RP_NEW, "select 'unreachable:' || m.entity_type || ':' || count(*)")).toBe(1);
    const at = RP_NEW.indexOf("select 'unreachable:'");
    const next = RP_NEW.indexOf("'check', 'ucm_orphan_markers', 'offenders', to_jsonb(v_tmp)", at);
    expect(next).toBeGreaterThan(at);
    expect(RP_NEW.lastIndexOf("-- 14.", at), "гілка не в №14").toBeGreaterThan(RP_NEW.lastIndexOf("-- 13.", at));
    /* у файлі предикат — з іншими аліасами (якорі стендів шукають підрядком);
       повернути аліаси → той самий текст, що в гілці */
    const pre = MIG.slice(MIG.indexOf("do $pre$"), MIG.indexOf("$pre$;"));
    const back = norm(pre).replace(/\bum\./g, "m.").replace(/\bpf\./g, "p.").replace(/\bg\./g, "ra.")
      .replace("user_change_markers um", "user_change_markers m").replace("profiles pf", "profiles p")
      .replace("referral_access g ", "referral_access ra ");
    expect(back).toContain(norm(B14.slice(2, 11).join("\n")));
    /* лише НЕПРОЧИТАНІ — і в гілці, і в предстані файлу (ревʼю 2, L-1) */
    expect(back).toContain("and m.seen_at is null");
    expect(pre).toContain("if v_unreach <> '{}'::jsonb then");
  });

  it("проза: фразу «ПОРЯДОК … НЕ пінить» замінено; абзаци 0204 у №14/№16/№17/№19 — по одному, без `'` і `$`", () => {
    expect(RP_NEW).not.toContain("ПОРЯДОК спрацювання ця перевірка НЕ пінить");
    expect(RP_OLD).toContain("ПОРЯДОК спрацювання ця перевірка НЕ пінить");
    expect(count(RP_NEW, "ПОРЯДОК спрацювання з 0204 пінить гілка `order:`")).toBe(1);
    for (const head of [
      "  --     ⚠️ 0204 (с80, Н-14, рішення власника 25.09) ДОДАЛА ГІЛКУ `unreachable:`:",
      "  --     ⚠️ 0204 (с80, Н-14, рішення власника 25.09: «відкликання гранту",
      "  --     ⚠️ 0204 (с80, Н-14 і Н-17) ДОДАЛА ПАРУ І ГІЛКУ, `checked` той самий:",
      "  --     ⚠️ 0204 (с80, Н-14) ПЕРЕДРУКУВАЛА ОДИН md5 БЕЗ ЗМІНИ СКЛАДУ (список так",
    ]) {
      expect(count(RP_NEW, head), `абзацу «${head.slice(8, 60)}» не рівно раз`).toBe(1);
      /* абзац — від заголовка до першого не-коментаря або заголовка ІНШОЇ міграції */
      const prose: string[] = [];
      for (const [i, l] of RP_NEW.slice(RP_NEW.indexOf(head)).split("\n").entries()) {
        if (!l.startsWith("  --") || (i > 0 && /^ {2}-- {5}⚠️ \d{4}/.test(l))) break;
        prose.push(l);
      }
      expect(prose.length, `абзац «${head.slice(8, 60)}» порожній`).toBeGreaterThan(3);
      expect(prose.join("\n"), "`'` зламав би канон прози, `$` — літерали `$p$` підстановки").not.toMatch(/['$]/);
    }
    expect(RP_NEW).toContain("ЩО ПІНИМО (сьогодні 60 підписів;");
  });

  it("підстановки накату й відкату, виконані тут, дають рівно тіла 0204 і 0203", () => {
    const newBody = guardBodyOf(MIG) as string;
    const oldBody = guardBodyOf(PREV) as string;
    for (const frag of [APPLY, DRYRUN]) {
      const { from, to } = substPairs(frag);
      expect(from).toHaveLength(12);
      expect(to).toHaveLength(12);
      expect(substitute(oldBody, from, to) === newBody, "підстановка накату дала не тіло 0204").toBe(true);
    }
    const back = substPairs(ROLLBACK);
    expect(back.from).toHaveLength(12);
    expect(substitute(newBody, back.from, back.to) === oldBody, "зворотна підстановка дала не тіло 0203").toBe(true);
  });

  it("заголовок передруку — один, і фраза заголовка не трапляється у файлі раніше", () => {
    const phrase = "create or replace function public.invariants_check";
    expect(MIG.match(/^create or replace function public\.invariants_check/gm) || []).toHaveLength(1);
    expect(MIG.indexOf(phrase)).toBe(MIG.search(/^create or replace function public\.invariants_check/m));
  });
});

describe("0204 — порядок у файлі міграції", () => {
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
  });

  it("предстан → функції → передрук → пін → ПОВНИЙ сторож → DDL на таблицях → пост-асерти → леджер", () => {
    const seq = [
      at("\nbegin;\n"), at("do $pre$"), at(`create or replace function public.${CMR}(`),
      at(`create or replace function public.${PRUNE}()`), at("\ncreate or replace function public.invariants_check"),
      at("comment on function public.invariants_check(boolean) is '"), at("do $chk$"),
      at("\nalter policy "), at("\ncreate trigger "), at("do $post$"),
      at("insert into public.migration_ledger"), at("\ncommit;\n"),
    ];
    expect(seq).toEqual([...seq].sort((a, b) => a - b));
    expect(count(code, SENTINEL_CALL), "повний сторож у коді не рівно раз").toBe(1);
    expect(code.indexOf(SENTINEL_CALL)).toBeLessThan(code.indexOf("\nalter policy "));
    expect(code.slice(code.indexOf("\nalter policy ")), "повний сторож під замками на таблиці").not.toMatch(SENTINEL_ANY_CALL);
    const chk = MIG.slice(at("do $chk$"), at("$chk$;"));
    expect(chk).toContain("if (v_res->>'checked')::int <> 26 then");
    expect(chk).toContain("where e.value->>'check' not in ('gcal_sync_overdue', 'policy_digest', 'guard_triggers')");
    expect(chk).toContain(`array['${POLICIES.map((p) => `changed:${p.tbl}.${p.pol}`).join("', '")}']::text[]`);
    expect(chk).toContain(`array['missing:referral_access.${PRUNE_TG}']::text[]`);
  });

  it("після DDL — запити №16 і №17 САМОГО сторожа: вирізані з живого тіла, md5, execute; копій тексту немає", () => {
    const post = MIG.slice(at("do $post$"), at("$post$;"));
    expect(count(post, "execute v_q into v_tmp;")).toBe(2);
    expect(post).toContain("raise exception '0204: №16 після DDL червоний: %', v_tmp;");
    expect(post).toContain("raise exception '0204: №17 після DDL червоний: %', v_tmp;");
    expect(post.indexOf(`if md5(v_src) is distinct from '${NEW_MD5}' or length(v_src) <> ${NEW_LEN}`))
      .toBeLessThan(post.indexOf("v_a := strpos(v_src, "));
    /* md5 вирізаних запитів = md5 того самого тексту, вирізаного тут із тіла */
    const cut = (start: string, endMark: string) => {
      const a = RP_NEW.indexOf(start);
      const b = RP_NEW.indexOf(endMark, a);
      expect(count(RP_NEW, start)).toBe(1);
      return RP_NEW.slice(a, b) + (endMark.startsWith("\n  ) x;") ? "\n  ) x" : "\n    ) x");
    };
    const q16 = cut("  with cur as (\n    select p.tablename as tbl,",
      "\n  ) x;\n  if v_tmp is not null then\n    v_fail := v_fail || jsonb_build_array(jsonb_build_object(\n      'check', 'policy_digest'")
      .replace("select array_agg(x.what order by x.what) into v_tmp", "select array_agg(x.what order by x.what)");
    const q17 = cut("  select array_agg(x.txt order by x.txt) into v_tmp\n    from (\n      select case when a.def",
      "\n    ) x;\n  if v_tmp is not null then\n    v_fail := v_fail || jsonb_build_array(jsonb_build_object(\n      'check', 'guard_triggers'")
      .replace("select array_agg(x.txt order by x.txt) into v_tmp", "select array_agg(x.txt order by x.txt)");
    expect(post).toContain(`if md5(v_q) is distinct from '${md5(q16)}' then`);
    expect(post).toContain(`if md5(v_q) is distinct from '${md5(q17)}' then`);
    expect(post, "у пост-асерті копія запиту №17").not.toContain(q17.split("\n")[2]);
  });

  it("у файлі немає копій тексту тіла поза тілом — інакше стенди отримають «ЯКІР НЕ УНІКАЛЬНИЙ»", () => {
    /* Тіло (prosrc), а не заголовок: рядок `set search_path to …` заголовка
       сторожа законно повторює заголовок change_marker_recipients. */
    const body = guardBodyOf(MIG) as string;
    const dups = [...new Set(body.split("\n"))]
      .filter((l) => l.trim().length >= 24 && count(body, l) === 1 && count(MIG, l) !== 1)
      .map((l) => l.trim().slice(0, 80));
    expect(dups).toEqual([]);
  });

  it("предстан ідемпотентний: 0203 обовʼязкова, останній рядок — 0203 або 0204; тіла функцій — 0184/0204", () => {
    const pre = MIG.slice(at("do $pre$"), at("$pre$;"));
    expect(pre).toContain(`where name = '${PREV_FILE}'`);
    expect(pre).toContain(`('${PREV_FILE}', '${LEDGER_NAME}')`);
    expect(pre).toContain(`not in ('${CMR_OLD_RAW}', '${CMR_NEW_RAW}') then`);
    expect(codeOf(pre)).not.toContain(`'public.${PRUNE}()'::regprocedure`);
    expect(pre).toContain(`to_regprocedure('public.${PRUNE}()') is not null`);
    const polArr = (w: "old" | "new") => `array[${POLICIES.map((p) => `'${p.tbl}.${p.pol}=${w === "old" ? p.oldDig : p.newDig}'`).join(", ")}]::text[]`;
    expect(pre).toContain(`if v_pol is distinct from ${polArr("old")} and v_pol is distinct from ${polArr("new")} then`);
  });
});

describe("0204 — фрагменти", () => {
  it("перший стейтмент — бюджет часу, другий — тег блоку; маркери успіху і відкоту; lock_timeout 5s", () => {
    for (const [txt, tag] of [[APPLY, "$apply$"], [DRYRUN, "$dryrun$"], [ROLLBACK, "$back$"], [FALSIFY, "$falsify$"]] as const) {
      const stmts = txt.split("\n").filter((l) => l.trim() && !l.startsWith("--"));
      expect(stmts[0]).toBe("set statement_timeout = '5min';");
      expect(stmts[1]).toBe(`do ${tag}`);
      expect(count(txt, tag), `${tag}: тег згадано поза блоком`).toBe(2);
      expect(txt).toContain("perform set_config('lock_timeout', '5s', true);");
    }
    expect(APPLY).toContain("raise notice 'APPLY_0204_OK");
    expect(DRYRUN).toContain("raise exception 'DRYRUN_0204_ROLLBACK guard=% len=% pin=% checked=% ok16=true ok17=true failed_before_ddl=% unreachable=% radius_rows(q/w/c)=%/%/% radius_profiles=% radius_keys=%'");
    expect(ROLLBACK).toContain("raise notice 'ROLLBACK_0204_OK");
    expect(FALSIFY).toContain("raise exception 'FALSIFY_0204_ROLLBACK verdict=%");
  });

  it("apply і dryrun: повний сторож — ДО DDL на таблицях, після DDL — лише дослівні №16/№17; леджер останнім", () => {
    for (const [lbl, txt] of [["apply", APPLY], ["dryrun", DRYRUN]] as const) {
      expect(txt).toContain(`if exists (select 1 from public.migration_ledger where name = '${LEDGER_NAME}') then`);
      expect(txt).toContain(`if md5(v_src) is distinct from '${PRE_MD5}' or length(v_src) <> ${PRE_LEN} then`);
      const code = codeOf(txt);
      const iChk = code.indexOf(SENTINEL_CALL);
      const iDdl = code.indexOf("alter policy ");
      expect(count(code, SENTINEL_CALL), `${lbl}: повний сторож у коді не рівно раз`).toBe(1);
      expect(iChk, `${lbl}: повний сторож не ДО DDL`).toBeLessThan(iDdl);
      expect(code.slice(iDdl), `${lbl}: виклик сторожа під замками`).not.toMatch(SENTINEL_ANY_CALL);
      expect(code.indexOf("insert into public.migration_ledger (name)")).toBeGreaterThan(code.lastIndexOf("create trigger "));
      expect(txt).toContain("execute format('comment on function public.invariants_check(boolean) is %L', v_pin_db);");
      expect(txt).toContain(`'${NEW_PIN}'`);
      /* недосяжні позначки вже зараз — стоп (сторож назвав би їх червоними) */
      expect(txt).toContain("уже є недосяжні НЕПРОЧИТАНІ позначки записів % — до накату ручна зачистка за явним списком id");
      /* раунд ревʼю 3: посилка рахує ЛИШЕ непрочитані — фільтр `seen_at is null`
         стоїть рівно там, де в гілці №14 (без нього прочитані від відкликань
         зупинили б накат, хоча сторож їх не рахує) */
      expect(count(code, PREMISE_UNREAD("m", "p")), `${lbl}: посилка без \`seen_at is null\``).toBe(1);
    }
    /* файл міграції — та сама посилка з псевдонімами (um/pf), смоук u0 — для направника проби */
    expect(count(codeOf(MIG), PREMISE_UNREAD("um", "pf")), "файл: посилка без `seen_at is null`").toBe(1);
    expect(count(codeOf(SMOKE), "     and m.entity_type = any (c_entry)\n     and m.seen_at is null\n     and p.clinic_id is distinct from m.clinic_id\n"),
      "смоук u0 без `seen_at is null`").toBe(1);
  });

  it("dryrun: замір радіуса — ДО DDL і без пастки NULL-логіки (у направника clinic_id NULL)", () => {
    const code = codeOf(DRYRUN);
    const iMeasure = code.indexOf("into v_rq, v_rw, v_rc, v_rprof, v_rkeys");
    expect(iMeasure).toBeGreaterThan(code.indexOf(SENTINEL_CALL));
    expect(iMeasure).toBeLessThan(code.indexOf("alter policy "));
    /* перша редакція заміру: `p.clinic_id = x.c` для направника → NULL →
       `not keeps` NULL → рядок випадав із лічби (на проді 0 замість 2) */
    expect(code).toContain("(coalesce(p.clinic_id = x.c, false)");
    expect(code).toContain("), false) as keeps");
    expect(code).toContain("left join public.profiles p on p.id = x.pid");
  });

  it("rollback: знімає мітлу, повертає 0184, політики 0203, №16/№17 старі дослівно, пін 0203, рядок леджера", () => {
    expect(ROLLBACK).toContain(`drop trigger if exists ${PRUNE_TG} on public.referral_access;`);
    expect(ROLLBACK).toContain(`drop function public.${PRUNE}();`);
    expect(ROLLBACK).toContain(`'${PRE_PIN}'`);
    expect(ROLLBACK).toContain(`delete from public.migration_ledger where name = '${LEDGER_NAME}';`);
    /* зняття — ПІСЛЯ перевірки, що в базі саме 0204 */
    expect(ROLLBACK.indexOf(`'${NEW_MD5}'`)).toBeLessThan(ROLLBACK.indexOf(`drop trigger if exists ${PRUNE_TG}`));
  });

  it("falsify: повний сторож ДО проб, проби ДО мутацій, під мутаціями — лише дослівні №14/№19/№17/№16", () => {
    const code = codeOf(FALSIFY);
    const iBase = code.indexOf(SENTINEL_CALL);
    const iProbe = FALSIFY.indexOf("  -- R-granted\n");
    const iMut = FALSIFY.indexOf("-- falsify 0204 M14: вихолощена мітла");
    expect(count(code, SENTINEL_CALL)).toBe(1);
    expect(iBase).toBeGreaterThan(0);
    expect(FALSIFY.indexOf(SENTINEL_CALL)).toBeLessThan(iProbe);
    expect(iProbe).toBeLessThan(iMut);
    expect(codeOf(FALSIFY.slice(iMut)), "повний сторож під мутаціями").not.toMatch(SENTINEL_ANY_CALL);
    expect(FALSIFY).toContain("where e.value->>'check' not in ('gcal_sync_overdue', 'ledger_md5')");
  });

  it("falsify: 24 проби (п'ять необовʼязкових), п'ять мутацій з точними очікуваннями, вердикт вимагає всього", () => {
    const labels = FALSIFY.match(/v_ok := v_ok \|\| '[^']+'::text;/g) || [];
    expect(new Set(labels).size).toBe(24);
    const na = [...FALSIFY.matchAll(/v_na := v_na \|\| '([^']+)'::text;/g)].map((m) => m[1]).sort();
    expect(na).toEqual(["P-move-pair", "P-other-clinic-kept", "R-ceo", "R-colleague-pending", "R-other-clinic-only"].sort());
    for (const p of ["R-granted", "R-staff", "R-ceo", "E-granted", "P-revoke-update", "P-access-kept", "P-other-clinic-kept",
      "E-revoked", "R-revoked", "R-pending_referrer", "R-pending_clinic", "R-declined", "P-inactive-update",
      "R-other-clinic-only", "R-regrant", "E-regrant", "P-same-pair", "P-delete", "P-move-pair", "R-colleague-pending",
      /* раунд ревʼю 2: мутанти, що проходили */
      "P-others-kept", "E-pending_referrer", "E-pending_clinic", "E-declined"]) {
      expect(FALSIFY, `проби ${p} немає`).toContain(`v_ok := v_ok || '${p}'::text;`);
    }
    expect(FALSIFY).toContain("v_want14 constant text[] := array['unreachable:patient_case:1', 'unreachable:queue_entry:1', 'unreachable:waitlist_entry:1']::text[];");
    expect(FALSIFY).toContain(`v_want16 constant text[] := array['${POLICIES.map((p) => `changed:${p.tbl}.${p.pol}`).join("', '")}']::text[];`);
    expect(FALSIFY).toContain(`v_want17a constant text[] := array['order:queue_entries->zzz_falsify_0204_late', 'trigger_off:referral_access.${PRUNE_TG}=D']::text[];`);
    expect(FALSIFY).toContain(`v_want17b constant text[] := array['missing:referral_access.${PRUNE_TG}', 'order:queue_entries->zzz_falsify_0204_late']::text[];`);
    /* пізній BEFORE-тригер — справді BEFORE ROW і справді за абеткою після гарда */
    expect(FALSIFY).toMatch(/create trigger zzz_falsify_0204_late\s+before update on public\.queue_entries\s+for each row/);
    expect(["zz_guard_read_keys", "zzz_falsify_0204_late"].sort(byC).at(-1)).toBe("zzz_falsify_0204_late");
    expect(norm(FALSIFY)).toContain(norm(`case when cardinality(v_miss) = 0 and cardinality(v_ok) + cardinality(v_na) = 24
              and v_off14 is not distinct from v_want14 and v_b14
              and v_off19 is not distinct from v_want19 and v_b19
              and v_off16 is not distinct from v_want16
              and v_off17a is not distinct from v_want17a and v_off17b is not distinct from v_want17b
              and v_base_other is null then 'PASS' else 'FAIL' end`));
  });
});

describe("0204 — смоук", () => {
  const code = codeOf(SMOKE);

  it("один блок; критерій — SMOKE_OK останнім; ранній вихід лише SMOKE_SKIP; n/a — у тексті SMOKE_OK", () => {
    expect(count(code, "do $smoke$")).toBe(1);
    expect(code.trimEnd().endsWith("$smoke$;")).toBe(true);
    const last = code.lastIndexOf("raise exception '");
    expect(code.slice(last)).toMatch(/^raise exception 'SMOKE_OK: 0204 [^']*\[%\] n\/a=\[%\]'/);
    expect(count(code, "SMOKE_SKIP")).toBe(1);
    expect(code).toContain(`where name = '${LEDGER_NAME}') then\n    raise exception 'SMOKE_SKIP:`);
  });

  it("кожен обробник — `when others` і кидає SMOKE_FAIL з міткою; пошук слота ковтає ЛИШЕ названі відмови", () => {
    const handlers = code.split("exception when ").slice(1);
    expect(handlers.length).toBeGreaterThan(20);
    for (const h of handlers) {
      expect(h.startsWith("others then\n"), "обробник не `when others`").toBe(true);
      expect(h.slice(0, h.indexOf("end;")), "обробник мовчить").toMatch(/raise exception 'SMOKE_FAIL\(/);
    }
    expect(count(code, "if sqlstate not in ('23514', '23P01') or split_part(v_msg, ':', 1) <> all (c_booking) then")).toBe(1);
  });

  it("мітки: читання за статусом гранту, позначки, мітла, наслідки; n/a — лише для необовʼязкових даних", () => {
    for (const lbl of ["0", "setup", "r-granted", "r-staff", "r-ceo", "m-granted", "p-revoke", "p-access", "p-other", "r-revoked",
      "m-revoked", "p-inactive", "r-other", "r-regrant", "m-regrant", "p-same", "p-delete", "p-move", "r-colleague", "u0",
      "side-rad", "side-moved", "p-others", "m-%"]) {
      expect(code, `мітки ${lbl} немає`).toContain(`SMOKE_FAIL(${lbl})`);
    }
    expect(code).toContain("foreach s in array array['pending_referrer', 'pending_clinic', 'declined'] loop");
    expect(code).toContain("raise exception 'SMOKE_FAIL(r-%): бачить % замість 0/0/0', s, v_seen;");
    const na = [...code.matchAll(/v_na := v_na \|\| '([^']+)'/g)].map((m) => m[1].trim()).sort();
    expect(na).toEqual(["p-move", "p-other", "r-ceo", "r-colleague", "r-other", "side-moved", "side-rad"].sort());
    expect(code).toContain("set local role authenticated;");
    expect(code).toContain("perform set_config('request.jwt.claims', '{}', true);");
    /* унікальність непрочитаних — без clinic_id: позначка того ж запису в іншому центрі — інший field_scope */
    expect(code).toContain("values (v_ref, v_clinic2, 'smoke.probe', 'queue', 'queue_entry', v_q, 'status', null, 'system', 'info');");
  });
});

describe("0204 — раунд ревʼю 2: умови провалу пінимо ТЕКСТОМ (мутанти, що вижили)", () => {
  const smokeCode = codeOf(SMOKE);
  /** Умова провалу мітки — рівно така (пробіли між умовою і raise — будь-які). */
  const failsOn = (src: string, cond: string, label: string) =>
    new RegExp(`${cond.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} then\\s+raise exception 'SMOKE_FAIL\\(${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`).test(src);

  it("D2: u0 і проби мітли падають на `<> 0` / `<> v_n_others`, а не на ослабленій умові", () => {
    /* мутант ревʼю 2: `if v_n <> 0` → `if v_n < 0` у u0 — смоук лишався зеленим */
    for (const [cond, label] of [
      ["if v_n <> 0", "u0"], ["if v_n <> 0", "p-revoke"], ["if v_n <> 0", "m-revoked"], ["if v_n <> 0", "m-%"],
      ["if v_n <> 0", "p-delete"], ["if v_n <> 0", "p-move"], ["if v_n <> 1", "m-granted"], ["if v_n <> 1", "m-regrant"],
      ["if v_n <> 1", "p-same"], ["if v_n <> 3", "p-inactive"], ["if v_n <> v_n_others", "p-others"],
      ["if v_seen is distinct from '0/0/0'", "r-revoked"], ["if v_seen is distinct from '0/0/0'", "r-%"],
      ["if v_seen is distinct from '1/1/1'", "r-granted"], ["if v_seen is distinct from '1/1/1'", "r-regrant"],
    ] as const) {
      expect(failsOn(smokeCode, cond, label), `SMOKE_FAIL(${label}) не на «${cond}»`).toBe(true);
    }
    expect(count(smokeCode, "if v_n <> v_n_others then"), "p-others — не після кожного з трьох спрацювань мітли").toBe(3);
    expect(smokeCode).not.toMatch(/if v_n\s*<\s*0\b/);
  });

  it("C16: після DDL №16 і №17 у накаті й сухому прогоні — raise exception, не notice", () => {
    /* мутант ревʼю 2: `raise exception` №17 після DDL → `raise notice` — накат
       комітив би червоний №17 */
    for (const [lbl, txt, tag] of [["apply", APPLY, "0204"], ["dryrun", DRYRUN, "0204-суха"]] as const) {
      const code = codeOf(txt);
      for (const n of ["16", "17"]) {
        expect(count(code, `  if v_tmp is not null then\n    raise exception '${tag}: №${n} після DDL червоний: %', v_tmp;`),
          `${lbl}: №${n} після DDL не валить накат`).toBe(1);
      }
      expect(code, `${lbl}: після DDL — notice замість exception`).not.toMatch(/raise\s+(notice|warning|info)\s+'0204[^']*№1[67] після DDL/);
    }
  });

  it("шапки: radius_* — замір, не стоп; недосяжні НЕПРОЧИТАНІ позначки — СТОП (L-3)", () => {
    const dryHead = DRYRUN.slice(0, DRYRUN.indexOf("\ndo $dryrun$"));
    const migHead = MIG.slice(0, MIG.indexOf("\nbegin;\n"));
    expect(dryHead).toContain("`radius_*` — ЗАМІР, не стоп");
    expect(dryHead).toContain("Недосяжні НЕПРОЧИТАНІ позначки записів — СТОП");
    expect(migHead).toContain("radius_* — ЗАМІР, не стоп");
    expect(migHead).toContain("недосяжні НЕПРОЧИТАНІ позначки записів — СТОП");
    for (const h of [dryHead, migHead]) {
      expect(h, "стара фраза «unreachable — замір»").not.toMatch(/unreachable[`]? і [`]?radius|radius_\*[`]? і [`]?unreachable/);
    }
  });

  it("проби ревʼю 1: інші отримувачі, неактивні гранти з емісією, прочитана позначка — у смоуку й фальсифікації", () => {
    /* (а) позначки ІНШИХ отримувачів — field_scope `studies`, до першого відкликання */
    expect(SMOKE).toContain("cross join (select v_admin as who union all select v_ref2 where v_ref2 is not null) w;");
    expect(SMOKE.indexOf("'smoke.probe', e.surf, e.et, e.eid, 'studies'"))
      .toBeLessThan(SMOKE.indexOf("update public.referral_access set status = 'revoked'"));
    for (const t of ["queue_entry", "waitlist_entry", "patient_case"]) {
      expect(FALSIFY).toContain(`values (v_admin, v_clinic, 'falsify.probe', ${t === "queue_entry" ? "'queue'" : t === "waitlist_entry" ? "'waitlist'" : "'cases'"}, '${t}', ${t === "queue_entry" ? "v_q" : t === "waitlist_entry" ? "v_w" : "v_c"},\n            'studies', null, 'system', 'info', v_ref);`);
    }
    expect(count(FALSIFY, "  if (select count(*) from public.user_change_markers m where m.clinic_id = v_clinic and m.recipient_id in (v_admin, v_ref2) and m.event_type = 'falsify.probe' and m.field_scope = 'studies') <> v_n_others then"))
      .toBe(3);
    /* (б) емісія при неактивних грантах — у кожному з трьох статусів */
    expect(smokeCode).toContain("raise exception 'SMOKE_FAIL(m-%): направнику з грантом % пішло % позначок записів', s, s, v_n;");
    /* (в) прочитана позначка — до відкликання, з seen_at */
    for (const txt of [SMOKE, FALSIFY]) {
      const i = txt.indexOf("'status', null, 'system', 'info', now());");
      expect(i, "прочитаної позначки немає").toBeGreaterThan(0);
      expect(i).toBeLessThan(txt.indexOf("status = 'revoked'", i) > 0 ? txt.indexOf("status = 'revoked'", i) : Infinity);
    }
    /* правка персоналу — ПЕРЕМИКАЧ, а не «set 'urgent'» (двічі поспіль нічого б не емітувало) */
    /* смоук: m-granted, m-revoked, цикл (один текст на три статуси), m-regrant;
       фальсифікація: E-granted, E-revoked, три E-<статус>, E-regrant, M19b */
    for (const [lbl, txt, n] of [["smoke", SMOKE, 4], ["falsify", FALSIFY, 7]] as const) {
      expect(txt, `${lbl}: правка пріоритету без перемикача`).not.toMatch(/set priority_level = '(urgent|planned)' where id = v_q/);
      expect(count(txt, "set priority_level = case when priority_level = 'urgent' then 'planned'::public.patient_priority"),
        `${lbl}: перемикачів не ${n}`).toBe(n);
    }
  });
});

describe("0204 — раунд ревʼю 3: умови проб фальсифікації, позначки інших, гонка", () => {
  const ENTRY = (ref: string, clinic: string) =>
    `(select count(*) from public.user_change_markers m where m.recipient_id = ${ref} and m.clinic_id = ${clinic} and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case'))`;
  const ACCESS = (ref: string, clinic: string) =>
    `(select count(*) from public.user_change_markers m where m.recipient_id = ${ref} and m.clinic_id = ${clinic} and m.entity_type = 'referral_access')`;
  const SEEN = (want: string) => `v_seen = '${want}'`;
  const E0 = `${ENTRY("v_ref", "v_clinic")} = 0`;
  const E1 = `${ENTRY("v_ref", "v_clinic")} = 1`;
  /** Мітка → умова, за якої проба ЗЕЛЕНА (інакше — v_miss), у порядку файлу. */
  const PASS_ON: [string, string][] = [
    ["R-granted", SEEN("1/1/1")], ["R-staff", SEEN("1/1/1")], ["R-ceo", SEEN("1/1/0")],
    ["E-granted", E1],
    ["R-revoked", SEEN("0/0/0")],
    ["P-revoke-update", E0],
    ["P-access-kept", `${ACCESS("v_ref", "v_clinic")} > v_n_access`],
    ["P-other-clinic-kept", `${ENTRY("v_ref", "v_clinic2")} = 1`],
    ["E-revoked", E0],
    ["R-pending_referrer", SEEN("0/0/0")], ["E-pending_referrer", E0],
    ["R-pending_clinic", SEEN("0/0/0")], ["E-pending_clinic", E0],
    ["R-declined", SEEN("0/0/0")], ["E-declined", E0],
    ["P-inactive-update", `${ENTRY("v_ref", "v_clinic")} = 3`],
    ["R-other-clinic-only", SEEN("0/0/0")],
    ["R-regrant", SEEN("1/1/1")], ["E-regrant", E1],
    ["P-same-pair", E1], ["P-delete", E0], ["P-move-pair", E0],
    ["P-others-kept", "v_others is null and v_n_others >= 3"],
    ["R-colleague-pending", SEEN("0/0/0")],
  ];

  it("falsify: умова кожної з 24 проб — рівно ця (таблиця «мітка → умова», як failsOn у смоуку)", () => {
    /* мутанти ревʼю 2, що вижили: R10 — P-others-kept без `v_others is null`
       (лише `>= 3`), R11 — E-pending_referrer `= 0` → `>= 0` */
    const got = [...FALSIFY.matchAll(/\n\s*if (.+?) then\n\s+v_ok := v_ok \|\| '([^']+)'::text;/g)].map((m) => [m[2], m[1]]);
    expect(PASS_ON.length).toBe(24);
    expect(new Set(PASS_ON.map(([l]) => l)).size).toBe(24);
    expect(got).toEqual(PASS_ON);
    /* кожне `v_ok := …` — під своєю умовою (інших шляхів у зелене немає) */
    expect(count(FALSIFY, "v_ok := v_ok || '")).toBe(24);
  });

  it("позначки ІНШИХ — з subject_referrer_id направника проби (як у справжньої емісії), у смоуку й фальсифікації", () => {
    /* мутант ревʼю 1 M1b: мітла `recipient_id = old.referrer_id or
       subject_referrer_id = old.referrer_id` проходила, бо в сфабрикованих
       позначок інших subject_referrer_id був NULL */
    expect(count(FALSIFY, "            'studies', null, 'system', 'info', v_ref);")).toBe(6);
    expect(count(FALSIFY, "'studies', null, 'system', 'info');"), "позначка іншого без subject_referrer_id").toBe(0);
    expect(count(FALSIFY, "field_scope, actor_id, actor_role, severity, subject_referrer_id)")).toBe(6);
    expect(SMOKE).toContain("entity_id, field_scope, actor_id, actor_role, severity,\n                                          subject_referrer_id)\n"
      + "    select w.who, v_clinic, 'smoke.probe', e.surf, e.et, e.eid, 'studies', null, 'system', 'info', v_ref\n");
  });

  it("гонка «емісія ‖ відкликання»: новий рядок — за БУДЬ-ЯКОГО порядку; `for share` закриває обидва", () => {
    /* ревʼю 1, раунд 2: відкликання першим → UPSERT, що чекав, вставляє НОВИЙ
       рядок (1 непрочитана, №14 unreachable:queue_entry:1) — стара проза
       «UPSERT наявної … потрапляє під мітлу» була правдою лише для одного порядку */
    for (const [lbl, txt] of [["передрук", RP_NEW], ["apply", APPLY], ["dryrun", DRYRUN]] as const) {
      expect(txt, `${lbl}: проза гонки`).toContain("  --           може лишити НОВИЙ рядок позначки за БУДЬ-ЯКОГО порядку commit:\n");
      expect(txt, `${lbl}: обидва порядки`).toContain("  --           №14 ловить обидва порядки; тоді — ручна зачистка ЛИШЕ за явним\n");
      expect(txt, `${lbl}: for share`).toContain("  --           даних проду). Закрити обидва порядки — `for share` на рядку\n");
    }
    const migHead = MIG.slice(0, MIG.indexOf("\nbegin;\n"));
    expect(migHead).toContain("позначки за БУДЬ-ЯКОГО порядку commit");
    const doc = read("docs/audit/PR-0204-referrer-grant-read.md");
    expect(doc).toContain("за **будь-якого** порядку commit");
    expect(doc).toContain("закриває **обидва** порядки");
    for (const [lbl, txt] of [["файл", MIG], ["apply", APPLY], ["dryrun", DRYRUN], ["rollback", ROLLBACK], ["PR-док", doc]] as const) {
      expect(txt, `${lbl}: стара неточна проза гонки`).not.toMatch(/потрапляє під мітлу|UPSERT наявного чекає й видаляється/);
    }
  });
});

describe("0204 — суміжні смоуки, документи, правила проєкту", () => {
  it("rls_initplan: еталон queue_select — форма 0204 (гілка ключа з умовою гранту)", () => {
    const s = read("supabase/smoke/rls_initplan_smoke.sql");
    expect(s).toContain("('queue_entries',    'queue_select',            'q', '(((clinic_id = auth_clinic_id()) AND ((( SELECT auth_role() AS auth_role) IS DISTINCT FROM ''radiologist''::user_role) OR auth_radiologist_room_ok(room_id))) OR (((created_by = auth.uid()) OR (referrer_id = auth.uid())) AND (clinic_id IN ( SELECT auth_referrer_clinics() AS auth_referrer_clinics))))'),");
    /* еталон смоука після заміни auth.uid() — рівно рендер 0204 */
    const q = POLICIES.find((p) => p.pol === "queue_select")!;
    const etalon = "(((clinic_id = auth_clinic_id()) AND ((( SELECT auth_role() AS auth_role) IS DISTINCT FROM 'radiologist'::user_role) OR auth_radiologist_room_ok(room_id))) OR (((created_by = auth.uid()) OR (referrer_id = auth.uid())) AND (clinic_id IN ( SELECT auth_referrer_clinics() AS auth_referrer_clinics))))";
    expect(etalon.split("auth.uid()").join("( SELECT auth.uid() AS uid)")).toBe(q.newRender);
  });

  it("search_roles: крок направника — свій ключ (обидва) І активний грант, NULL-безпечно", () => {
    const s = read("supabase/smoke/search_roles_smoke.sql");
    expect(count(s, "where not ((referrer_id is not distinct from v_ref or created_by is not distinct from v_ref)")).toBe(2);
    expect(count(s, "where ra.referrer_id = v_ref and ra.status = 'active'));")).toBe(2);
    expect(s).not.toContain("select count(*) into v_leak from waitlist_entries where created_by is distinct from v_ref;");
  });

  it("AGENTS.md: чтение по ключу — с активным грантом; №17 пинит порядок; метла и №14 unreachable:", () => {
    const agents = read("AGENTS.md");
    const section = (h: string) => {
      const a = agents.indexOf(h);
      expect(a, `раздела «${h}» нет`).toBeGreaterThanOrEqual(0);
      return agents.slice(a, agents.indexOf("\n## ", a + 1));
    };
    expect(section("## Роли и авторизация")).toContain("Чтение записи по ключу (`created_by` / `referrer_id`) — только с АКТИВНЫМ грантом");
    expect(section("## Миграции и БД")).toContain("№17 с 0204 пинит и ПОРЯДОК гарда ключей");
    expect(section("## Миграции и БД")).toContain("`order:<таблица>-><триггер>`");
    const dots = section("## Контекстные «красные точки»");
    expect(dots).toContain(PRUNE_TG);
    expect(dots).toContain("`unreachable:<тип>:<n>`");
    /* раунд ревʼю 2: процедура ручного переводу і межа `rads` — поруч */
    const db = section("## Миграции и БД");
    expect(db).toContain("Ручной перевод сотрудника в другой центр");
    expect(db).toContain("Радиолог (граница 0204)");
    expect(db).toContain("`radiologist_rooms` при переводе не чистятся");
  });

  it("AGENTS.md: пункты 0204 — по-русски целиком (без украинских букв и слов вне `кода` и «цитат»)", () => {
    /* раунд ревʼю 3: у раунді 2 перевірка брала лише рядки зі «0204» і `\b` —
       а `\b` у JS не бачить межі кириличного слова, тож «межа» вона б не
       впіймала ніколи, а «службовой» (рядок без «0204») — тим паче. Тепер —
       УСІ рядки кожного пункту `- …`, що згадує 0204, і межі слова за \p{L}. */
    const agents = read("AGENTS.md");
    /* пункт — від `- ` до наступного `- `, заголовка чи порожнього рядка */
    const bullets: { at: number; text: string }[] = [];
    const all = agents.split("\n");
    for (let i = 0, at = -1; i <= all.length; i++) {
      const l = i < all.length ? all[i] : "";
      if (/^- /.test(l) || /^#/.test(l) || !l.trim()) {
        if (at >= 0) bullets.push({ at: at + 1, text: all.slice(at, i).join("\n") });
        at = /^- /.test(l) ? i : -1;
      }
    }
    const UA_LETTER = /[іїєґ]/iu;
    const UA_WORD = /(?<!\p{L})(меж[аіу]|службов\p{L}*|лише|якщо|або|також|тобто|отже|щоб)(?!\p{L})/iu;
    const bad = (line: string) => UA_LETTER.test(line) || UA_WORD.test(line);
    /* детектор не сліпий: ловить обидва випадки ревʼю */
    expect(bad("только SQL службовой ролью")).toBe(true);
    expect(bad("Граница: межа тут")).toBe(true);
    expect(bad("между строк; граница 0204; служебной ролью")).toBe(false);
    const b0204 = bullets.filter((b) => b.text.includes("0204"));
    expect(b0204.length, "пунктов 0204 в AGENTS.md меньше четырёх").toBeGreaterThanOrEqual(4);
    const hits: string[] = [];
    for (const b of b0204) {
      const prose = b.text.replace(/`[^`]*`/g, " ").replace(/«[^»]*»/g, " ");
      prose.split("\n").forEach((l, k) => { if (bad(l)) hits.push(`${b.at + k}: ${l.trim()}`); });
    }
    expect(hits, "украинское слово в русском пункте AGENTS.md").toEqual([]);
  });

  it("UNREAD_CHANGES.md: позначки записів направнику — лише з активним грантом; мітла названа", () => {
    const doc = read("docs/UNREAD_CHANGES.md");
    expect(count(doc, "з 0204 — лише з")).toBeGreaterThanOrEqual(4);
    expect(doc).toContain(PRUNE_TG);
  });
});
