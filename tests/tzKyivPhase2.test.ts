/**
 * Піни пакета 0202 — фаза 2 таймзон (рішення власника Р74-3(а), 15.09):
 * прод з legacy-аліаса `Europe/Kiev` на `Europe/Kyiv`, CHECK без аліаса,
 * шість функцій без скану `pg_timezone_names`, передрук сторожа (4 md5 у №19,
 * дайджест `k:clinics` у №23).
 *
 * ЩО ТРИМАЄ ЦЕЙ ТЕСТ (і чого не тримає):
 *  • ОСТАННЄ визначення кожної з шести функцій у репозиторії — без скану
 *    каталогу в КОДІ й рівно з одним `coalesce(c.timezone, 'UTC')`. Регресія
 *    «повернули підзапит» червоніє тут, до накату;
 *  • md5 чотирьох пінованих рядків у ПЕРЕДРУКУ рахується ТИМ САМИМ рецептом,
 *    що №19 (`md5(btrim(regexp_replace(prosrc, '\s+', ' ', 'g')))`), із тексту
 *    функції в 0202 — незалежно від генератора. Розбіжність = передрук пінить
 *    не те тіло, і прод червонів би `body:` з першого дня;
 *  • CHECK: список ('Europe/Kyiv', 'UTC') і той самий рендер, що асертить
 *    накат; дайджест `k:clinics` у передруку відтворюється з пʼяти рядків
 *    constraint-ів тим самим рецептом, що №23 (`count:md5(sorted lines)[:12]`);
 *  • дані: ОДИН явний id, до-образ `Europe/Kiev`, ніякого `update … where
 *    timezone = …` без id;
 *  • фрагменти: тег блоку першим стейтментом, маркер відкоту в dryrun/falsify,
 *    фальсифікація вимагає тиші про `check_no_overlap` (межа, а не пропуск).
 *  НЕ тримає: живих значень на проді (це роблять фрагменти й окремі запити) і
 *  того, що Google приймає `Europe/Kyiv` (зонд `scripts/gcal-tz-probe.mjs`).
 *
 * ⚠️ Тест читає 0202 ПРИБИТИМ шляхом, як `tzCheckConstraint.test.ts` читає 0192:
 *    накатану міграцію не редагують, тож ці піни не можуть протухнути тихо;
 *    склад №19 і дайджест — з ОСТАННЬОГО передруку (`latestReprint`), щоб
 *    майбутній передрук, який загубить ці рядки, теж почервонів.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const MIGDIR = "supabase/migrations";
const MIG_FILE = "0202_tz_kyiv_no_catalog_scan.sql";
const MIG = readFileSync(resolve(MIGDIR, MIG_FILE), "utf8").replace(/\r/g, "");
const APPLY = readFileSync("scripts/frag/0202_apply.sql", "utf8").replace(/\r/g, "");
const DRYRUN = readFileSync("scripts/frag/0202_dryrun.sql", "utf8").replace(/\r/g, "");
const ROLLBACK = readFileSync("scripts/frag/0202_rollback.sql", "utf8").replace(/\r/g, "");
const FALSIFY = readFileSync("scripts/frag/0202_falsify.sql", "utf8").replace(/\r/g, "");
const PREV_ESR = readFileSync("scripts/frag/0202_prev_emergency_stop_rpc.body.sql", "utf8").replace(/\r/g, "");

const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const codeOf = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");

const CLINIC_ID = "c79588d6-c379-4949-9c23-a22c227a12e1";
const TZ_SCAN = "coalesce((select name from pg_timezone_names where name = c.timezone), 'UTC')";
const TZ_DIRECT = "coalesce(c.timezone, 'UTC')";
const CON_DEF_NEW = "CHECK ((timezone = ANY (ARRAY['Europe/Kyiv'::text, 'UTC'::text])))";
const CON_DEF_OLD = "CHECK ((timezone = ANY (ARRAY['Europe/Kyiv'::text, 'Europe/Kiev'::text, 'UTC'::text])))";
const DIG_OLD = "5:588baa1ac5d2";

const FNS = {
  check_no_overlap: { sig: "check_no_overlap()", pinned: false },
  check_not_in_past: { sig: "check_not_in_past()", pinned: false },
  queue_set_status_rpc: {
    sig: "queue_set_status_rpc(p_id uuid, p_status queue_status, p_expected queue_status, p_allowed queue_status[], p_note text, p_set_note boolean)",
    pinned: true,
  },
  emergency_stop_rpc: { sig: "emergency_stop_rpc(p_room_ids uuid[], p_date date, p_note text)", pinned: true },
  submit_incident_rpc: {
    sig: "submit_incident_rpc(p_room_id uuid, p_reason text, p_id uuid, p_reason_label text, p_note text, p_started_at timestamp with time zone, p_blocked_until timestamp with time zone, p_auto_unblock boolean)",
    pinned: true,
  },
  room_busy_slots: { sig: "room_busy_slots(p_room uuid, p_date date, p_exclude uuid)", pinned: true },
} as const;
type FnName = keyof typeof FNS;

function latestReprint(): { fn: string; file: string } {
  const files = readdirSync(MIGDIR).filter((f) => f.endsWith(".sql")).sort();
  let best = { fn: "", file: "" };
  for (const f of files) {
    const txt = readFileSync(resolve(MIGDIR, f), "utf8").replace(/\r/g, "");
    const at = txt.search(/^create or replace function public\.invariants_check/m);
    if (at < 0) continue;
    const end = txt.indexOf("\n$function$;", at);
    if (end < 0) throw new Error(`${f}: передрук не закритий "$function$;"`);
    best = { fn: txt.slice(at, end), file: f };
  }
  if (!best.fn) throw new Error("НЕ ЗНАЙДЕНО жодного передруку invariants_check");
  return best;
}
const REPRINT = latestReprint();
const REPRINT_CODE = codeOf(REPRINT.fn);

/** Останнє визначення функції в ЛЮБІЙ міграції: statement і тіло (prosrc). */
function lastDefinition(name: FnName): { file: string; stmt: string; body: string } {
  const files = readdirSync(MIGDIR).filter((f) => f.endsWith(".sql")).sort();
  const head = new RegExp(`^create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${name}\\s*\\(`, "gim");
  let hit: { file: string; stmt: string; body: string } | null = null;
  for (const f of files) {
    const sql = readFileSync(resolve(MIGDIR, f), "utf8").replace(/\r/g, "");
    let at = -1;
    for (const m of sql.matchAll(head)) at = m.index ?? at;
    if (at === -1) continue;
    const tag = /\bas\s+(\$[a-z0-9_]*\$)\n/i.exec(sql.slice(at));
    if (!tag) throw new Error(`${f}: ${name} без 'as $тег$'`);
    const bodyStart = at + (tag.index ?? 0) + tag[0].length - 1;
    const end = sql.indexOf(`\n${tag[1]};`, bodyStart);
    if (end < 0) throw new Error(`${f}: ${name} без закриття ${tag[1]};`);
    hit = { file: f, stmt: sql.slice(at, end + tag[1].length + 2), body: sql.slice(bodyStart, end + 1) };
  }
  if (!hit) throw new Error(`функцію ${name} не знайдено`);
  return hit;
}

describe("0202 — шість функцій без скану каталогу", () => {
  for (const name of Object.keys(FNS) as FnName[]) {
    it(`${name}: останнє визначення — у 0202, без pg_timezone_names у коді, з одним coalesce(c.timezone, 'UTC')`, () => {
      const d = lastDefinition(name);
      expect(d.file).toBe(MIG_FILE);
      const code = codeOf(d.stmt);
      expect(code).not.toContain("pg_timezone_names");
      expect(code.split(TZ_DIRECT).length - 1).toBe(1);
      expect(d.stmt).toMatch(/security definer/i);
      expect(d.stmt).toMatch(/set search_path (= public, pg_temp|to 'public', 'pg_temp')/i);
      expect(d.stmt).toMatch(/^create or replace function public\./);
    });
  }

  it("кожна функція згадує 0202 у коментарі біля підстановки (щоб наступний знав, чому валідації немає)", () => {
    for (const name of Object.keys(FNS) as FnName[]) {
      const d = lastDefinition(name);
      const at = d.stmt.indexOf(TZ_DIRECT);
      expect(d.stmt.slice(Math.max(0, at - 700), at)).toContain("0202");
      expect(d.stmt.slice(Math.max(0, at - 700), at)).toContain("clinics_timezone_chk");
    }
  });

  it("№19: чотири md5 у передруку = md5 тіл із 0202 за рецептом №19", () => {
    for (const [name, meta] of Object.entries(FNS) as [FnName, (typeof FNS)[FnName]][]) {
      const d = lastDefinition(name);
      const m = md5(norm(d.body));
      const row = `('${meta.sig}','${m}',`;
      if (meta.pinned) {
        expect(REPRINT_CODE, `${name}: рядок із md5 ${m} у передруку ${REPRINT.file}`).toContain(row);
      } else {
        expect(REPRINT_CODE, `${name}: НЕ пінується (прийнятий ризик) — рядка бути не мусить`).not.toContain(`('${meta.sig}',`);
      }
    }
  });

  it("№19: старі md5 чотирьох функцій у передруку відсутні", () => {
    for (const old of ["ef04f36d0d79727429074451cb6a4efb", "ac62900bdcd7d5cd689f5aa9066d99b9",
      "3534d77cd3d27c72aa7d3d454d09aa86", "83ddb89d6b1cd33ae19c8d314d29b73c"]) {
      expect(REPRINT_CODE).not.toContain(`'${old}'`);
    }
  });

  it("emergency_stop_rpc: прод-текст для відкату — код той самий, md5 = пін 0201", () => {
    const d = lastDefinition("emergency_stop_rpc");
    expect(md5(norm(PREV_ESR))).toBe("ac62900bdcd7d5cd689f5aa9066d99b9");
    expect(norm(codeOf(PREV_ESR).replace(TZ_SCAN, TZ_DIRECT))).toBe(norm(codeOf(d.body)));
    /* повний прод-текст — дослівно у відкаті і НІДЕ в накаті (ревʼю с75, Б-M4) */
    expect(ROLLBACK).toContain(PREV_ESR);
    expect(APPLY).not.toContain(PREV_ESR);
    expect(DRYRUN).not.toContain(PREV_ESR);
  });
});

describe("0202 — CHECK, дані, дайджест k:clinics", () => {
  it("CHECK: список ('Europe/Kyiv', 'UTC'), рендер як у накаті, коментар з 0202", () => {
    expect(MIG).toContain("add constraint clinics_timezone_chk\n  check (timezone in ('Europe/Kyiv', 'UTC'));");
    expect(MIG).toContain("comment on constraint clinics_timezone_chk on public.clinics is");
    expect(MIG).toContain("0192, 0202.");
    expect(APPLY).toContain(CON_DEF_NEW.replace(/'/g, "''"));
    expect(APPLY).toContain(CON_DEF_OLD.replace(/'/g, "''"));
  });

  it("№23: дайджест k:clinics у передруку = рецепт №23 над пʼятьма рядками constraint-ів 0202", () => {
    const lines = [
      "clinics_max_cascade_chk:c:CHECK (((max_cascade_patients >= 1) AND (max_cascade_patients <= 100)))",
      "clinics_overlap_threshold_chk:c:CHECK ((((overlap_threshold_min >= 5) AND (overlap_threshold_min <= 120)) AND ((overlap_threshold_min % 5) = 0)))",
      "clinics_pkey:p:PRIMARY KEY (id)",
      "clinics_queue_delay_policy_chk:c:CHECK ((queue_delay_policy = ANY (ARRAY['manual'::text, 'cascade_shift'::text, 'reschedule_conflicts'::text])))",
      `clinics_timezone_chk:c:${CON_DEF_NEW}`,
    ];
    const dig = `${lines.length}:${md5([...lines].sort().join(",")).slice(0, 12)}`;
    /* контроль рецепта: ті самі рядки зі старим CHECK дають заміряний 0192-дайджест */
    const old = lines.map((l) => (l.startsWith("clinics_timezone_chk:") ? `clinics_timezone_chk:c:${CON_DEF_OLD}` : l));
    expect(`${old.length}:${md5([...old].sort().join(",")).slice(0, 12)}`).toBe(DIG_OLD);
    expect(REPRINT_CODE).toContain(`('k:clinics','${dig}'),`);
    expect(REPRINT_CODE).not.toContain(`('k:clinics','${DIG_OLD}'),`);
    expect(FALSIFY).toContain(`changed:k:clinics:${dig}->${DIG_OLD}`);
  });

  it("дані: один явний id із до-образом; жодного update clinics без id", () => {
    expect(MIG).toContain(`if v_ids is distinct from array['${CLINIC_ID}']::uuid[] then`);
    expect(MIG).toContain(`update public.clinics set timezone = 'Europe/Kyiv' where id = '${CLINIC_ID}' and timezone = 'Europe/Kiev';`);
    for (const txt of [MIG, APPLY, DRYRUN, ROLLBACK, FALSIFY]) {
      for (const m of txt.matchAll(/update public\.clinics set timezone = '[^']+'/g)) {
        const tail = txt.slice(m.index ?? 0, (m.index ?? 0) + 200);
        expect(tail, "update clinics без явного id").toMatch(/where id = '/);
      }
    }
    expect(ROLLBACK).toContain(`update public.clinics set timezone = 'Europe/Kiev' where id = '${CLINIC_ID}' and timezone = 'Europe/Kyiv';`);
  });

  it("ПОРЯДОК даних і CHECK: накат — update під ШИРОКИМ CHECK, відкат — широкий CHECK ПЕРЕД update", () => {
    /* Перша редакція відкату робила update на Europe/Kiev під ще вузьким CHECK
       0202 — check_violation на першому ж кроці (обидві лінзи ревʼю с75). */
    const aUpd = APPLY.indexOf("update public.clinics set timezone = 'Europe/Kyiv' where id = '");
    const aDrop = APPLY.indexOf("drop constraint clinics_timezone_chk");
    expect(aUpd).toBeGreaterThan(0);
    expect(aUpd).toBeLessThan(aDrop);
    const rDrop = ROLLBACK.indexOf("drop constraint clinics_timezone_chk");
    const rAdd = ROLLBACK.indexOf("check (timezone in ('Europe/Kyiv', 'Europe/Kiev', 'UTC'))");
    const rUpd = ROLLBACK.indexOf("update public.clinics set timezone = 'Europe/Kiev' where id = '");
    expect(rDrop).toBeGreaterThan(0);
    expect(rDrop).toBeLessThan(rAdd);
    expect(rAdd).toBeLessThan(rUpd);
    /* доказ, що назва зони є в tzdata ЦЬОГО сервера — у тій самій транзакції */
    /* два РІЗНІ імені: невідома зона кидає 22023, різний час = одне з імен не Київ */
    expect(APPLY).toContain("if (now() at time zone 'Europe/Kyiv') is distinct from (now() at time zone 'Europe/Kiev')");
    expect(DRYRUN).toContain("if (now() at time zone 'Europe/Kyiv') is distinct from (now() at time zone 'Europe/Kiev')");
    expect(ROLLBACK).toContain("if (now() at time zone 'Europe/Kiev') is distinct from (now() at time zone 'Europe/Kyiv')");
  });

  it("список №19 у передруку так само 59, checked 26", () => {
    const rows = REPRINT_CODE.match(/^ {6}\('[A-Za-z0-9_]+\([^)]*\)','[0-9a-f]{32}','[^']*'\),?$/gm) || [];
    expect(rows.length).toBe(59);
    expect((REPRINT.fn.match(/^  v_n := v_n \+ 1;$/gm) || []).length).toBe(26);
  });
});

describe("0202 — канон назви зони в UI (lib/tzCanonical)", () => {
  it("аліас → канон, решта як є; список без дублікатів із збереженим порядком", async () => {
    const { canonicalTz, canonicalTzList } = await import("../lib/tzCanonical");
    expect(canonicalTz("Europe/Kiev")).toBe("Europe/Kyiv");
    expect(canonicalTz("Europe/Kyiv")).toBe("Europe/Kyiv");
    expect(canonicalTz("UTC")).toBe("UTC");
    expect(canonicalTz("Europe/Warsaw")).toBe("Europe/Warsaw");
    expect(canonicalTzList(["UTC", "Europe/Kiev", "Europe/Kyiv", "Europe/Warsaw", "Europe/Kiev"]))
      .toEqual(["UTC", "Europe/Kyiv", "Europe/Warsaw"]);
  });

  it("майстер налаштувань нормалізує зону і в дефолті, і в списку, і перед записом", () => {
    const wiz = readFileSync("components/SetupWizard.tsx", "utf8");
    expect(wiz).toContain('import { canonicalTz, canonicalTzList } from "@/lib/tzCanonical";');
    expect(wiz).toContain("return canonicalTz(Intl.DateTimeFormat().resolvedOptions().timeZone");
    expect(wiz).toContain("if (all && all.length) return canonicalTzList(all);");
    expect(wiz).toContain("useState(canonicalTz(initial.timezone || browserTz()))");
    expect(wiz).toContain('const tz = canonicalTz((d.timezone || "").trim());');
  });
});

describe("0202 — фрагменти", () => {
  it("тег блоку — перший стейтмент; dryrun і falsify валяться маркером; apply/rollback мають читання назад", () => {
    for (const [txt, tag] of [[APPLY, "$apply$"], [DRYRUN, "$dryrun$"], [ROLLBACK, "$back$"], [FALSIFY, "$falsify$"]] as const) {
      const stmts = txt.split("\n").filter((l) => l.trim() && !l.startsWith("--"));
      /* бюджет часу ЗОВНІ блоку (канон 0192: усередині `do` він інертний), далі — тег */
      expect(stmts[0]).toBe("set statement_timeout = '5min';");
      expect(stmts[1]).toBe(`do ${tag}`);
    }
    expect(DRYRUN).toContain("raise exception 'DRYRUN_0202_ROLLBACK");
    expect(FALSIFY).toContain("raise exception 'FALSIFY_0202_ROLLBACK");
    expect(APPLY).toContain("as fns_with_scan");
    expect(ROLLBACK).toContain("as fns_with_scan");
  });

  it("apply: черга леджера, предстан сторожа 0201, живі рядки ДО і ПІСЛЯ, дайджест ДО і ПІСЛЯ, самопін, md5 у v_to", () => {
    expect(APPLY).toContain("у леджері немає 0201");
    expect(APPLY).toContain("if (select max(name) from public.migration_ledger) is distinct from");
    expect(APPLY).toContain("f0134c6203dacab659fd85648c5e9aa9");
    expect(APPLY.split("Живі рядки шести функцій").length - 1).toBe(2);
    expect(APPLY.split("select dig into v_dig from konagg where key = 'k:clinics';").length - 1).toBe(2);
    /* заголовки (DEFAULT-и, тип результату) звіряються ДО і ПІСЛЯ — create or replace міняє їх мовчки */
    expect(APPLY.split("h.args is not distinct from pg_get_function_arguments(p.oid)").length - 1).toBe(2);
    expect(APPLY.split("where h.fn = p.proname and p.prokind = 'f'").length - 1).toBe(2);
    /* самопін №25 у тій самій транзакції — у накаті, сухому прогоні й відкаті */
    for (const txt of [APPLY, DRYRUN, ROLLBACK]) {
      expect(txt).toContain("execute format('comment on function public.invariants_check(boolean) is %L', v_pin_db);");
    }
    const pin = /comment on function public\.invariants_check\(boolean\) is '(guard_body_md5=[0-9a-f]{32};len=\d+)';/.exec(MIG)?.[1];
    expect(pin).toBeTruthy();
    expect(APPLY).toContain(`'${pin}'`);
    expect(DRYRUN).toContain(`'${pin}'`);
    /* кожен новий md5 — і в парі підстановки (v_to), і в живих рядках ПІСЛЯ */
    for (const name of ["queue_set_status_rpc", "emergency_stop_rpc", "submit_incident_rpc", "room_busy_slots"] as FnName[]) {
      const m = md5(norm(lastDefinition(name).body));
      expect(APPLY.split(`'${m}'`).length - 1).toBeGreaterThanOrEqual(2);
      expect(ROLLBACK.split(`'${m}'`).length - 1).toBeGreaterThanOrEqual(1);
    }
    /* читання назад рахує ТОЧНИЙ підзапит скану, не слово (нотатки несуть слово в коментарях) */
    expect(APPLY).toContain(`like '%${TZ_SCAN.replace(/'/g, "''")}%') as fns_with_scan`);
    for (const name of Object.keys(FNS) as FnName[]) expect(lastDefinition(name).stmt).not.toContain(TZ_SCAN);
  });

  it("dryrun: замір до/після (ізольований), сторож на новому тілі з переліком червоних", () => {
    expect(DRYRUN.split("explain (analyze, format json) update public.queue_entries set duration_min = duration_min").length - 1).toBe(2);
    expect(DRYRUN.split("exception when others then").length - 1).toBeGreaterThanOrEqual(2);
    /* замір ДО — перед DDL на clinics (ACCESS EXCLUSIVE не тримається на час холодного скану) */
    expect(DRYRUN.indexOf("explain (analyze, format json)")).toBeLessThan(DRYRUN.indexOf("drop constraint clinics_timezone_chk"));
    expect(DRYRUN).toContain("'guard_fn_bodies', 'guard_self_pin', 'schema_digest', 'secdef_search_path', 'guard_triggers', 'room_busy_service_role'");
  });

  it("falsify: R1 імʼям constraint-а, R2 законне UTC, 4 мутації №19, CHECK назад, тиша про check_no_overlap у вердикті", () => {
    expect(FALSIFY).toContain("get stacked diagnostics v_con = constraint_name;");
    expect(FALSIFY).toContain("if v_con is distinct from 'clinics_timezone_chk' then");
    expect(FALSIFY).toContain(`update public.clinics set timezone = 'UTC' where id = '${CLINIC_ID}';`);
    expect(FALSIFY).toContain("if v_n <> 5 then");
    expect(FALSIFY).toContain("check (timezone in ('Europe/Kyiv', 'Europe/Kiev', 'UTC'))");
    expect(FALSIFY).toContain("v_b1 := not exists (select 1 from unnest(coalesce(v_off19, '{}')) o where o like 'body:check_no_overlap%');");
    expect(FALSIFY).toContain("case when v_r1 and v_r2 and v_b1 and v_miss is null");
  });
});
