/**
 * Статичний сторож перевірки №19 `guard_fn_bodies` (0172).
 *
 * ЧОМУ ВІН ІСНУЄ. Аргумент із `guardTriggersInvariant.test.ts` застосовний
 * дослівно: мутація `where c.body <> e.body and false` лишає весь набір
 * зеленим І `checked = 19`, тож ані тести, ані смоуки нічого б не сказали.
 * Перевірка, що тримається лише на лічильнику, — це не перевірка.
 *
 * ⚠️ ЧОГО ЦЕЙ ФАЙЛ НЕ ДОВОДИТЬ: він читає ТЕКСТ міграції, а не виконує SQL.
 *    «Перевірка написана» ≠ «перевірка ловить». Останнє доводиться
 *    фальсифікацією на проді (шість гілок, кожна назвалась своїм іменем) і
 *    живим кроком (h2) у `invariants_watch_smoke.sql`.
 *
 * ⚠️ Джерело — ОСТАННІЙ передрук, а не файл 0172 за іменем (урок с47/с55).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const MIGDIR = resolve(process.cwd(), "supabase/migrations");

/**
 * Підписи, заради яких перевірка й писалась. Ключ — імʼя РАЗОМ із типами
 * аргументів: `auth_radiologist_room_ok(p_room uuid)` має аргумент, і голого
 * `proname` як ключа не досить (замір с56).
 */
const PINNED: readonly string[] = [
  // гарди, які виконують 14 тригерів зі списку №17
  "check_case_clinic_match()",
  "cleanup_orphan_clinic()",
  "guard_no_client_delete()",
  "guard_no_client_delete_incident()",
  "guard_profile_privileges()",
  "guard_radiologist_no_write()",
  "guard_radiologist_scope()",
  "guard_referrer_doctor()",
  "guard_room_in_clinic()",
  "guard_status_change_referrer()",
  "guard_waitlist_room()",
  // хелпери, яким гарди делегують РІШЕННЯ про доступ (знахідка ревʼю с56)
  "auth_clinic_id()",
  "auth_is_admin()",
  "auth_is_referrer()",
  "auth_radiologist_room_ok(p_room uuid)",
  "auth_role()",
  "request_is_client_role()",
  // аудит-слід, роль нового профілю, обсяг читання направника, вихід назовні
  "fn_audit()",
  "handle_new_user()",
  "validate_referral_rooms()",
  "prune_referral_rooms_on_room_delete()",
  "integration_outbox_enqueue()",
];

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
/** Код без коментарів: у коментарях свідомо цитуються полагоджені дефекти
 *  (напр. `substr(md5(…), 1, 12)`), і наївний пошук по всьому тексту хибно
 *  спрацьовував би — той самий клас, що «мітла сиріт» у перевірці №9. */
const CODE = SRC.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");

/**
 * КОД САМЕ №19, а не всього сторожа. Перший прогін цього файлу показав, навіщо:
 * пін «усічений md5 не повернувся» червонів на `substr(md5(…` із перевірки №16
 * `policy_digest` — легального чужого коду, а пін «exception when others» був би
 * ЗЕЛЕНИМ за рахунок обробника в №18, навіть якби в №19 його не було зовсім.
 * Обидва — той самий клас, що «чужий сторож» у стендах (U-80б).
 */
const BLOCK19 = (() => {
  const at = CODE.indexOf("'check', 'guard_fn_bodies'");
  if (at < 0) throw new Error("у передруку немає мітки guard_fn_bodies");
  const start = CODE.lastIndexOf("v_n := v_n + 1;", at);
  if (start < 0) throw new Error("перед міткою №19 немає кроку лічильника");
  return CODE.slice(start, at);
})();

describe(`№19 guard_fn_bodies — статичний сторож (${FILE})`, () => {
  it("мітка перевірки на місці рівно один раз", () => {
    expect(CODE.match(/'check',\s*'guard_fn_bodies'/g) || []).toHaveLength(1);
  });

  it.each(PINNED)("підпис %s пінується", (sig) => {
    const re = new RegExp(
      `\\('${sig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}','[0-9a-f]{32}','[^']*'\\)`
    );
    expect(BLOCK19).toMatch(re);
  });

  it("пінів рівно стільки, скільки названо — список не всох і не роздувся", () => {
    const rows = BLOCK19.match(/^ {6}\('[A-Za-z0-9_]+\([^)]*\)','[0-9a-f]{32}','[^']*'\),?$/gm) || [];
    expect(rows).toHaveLength(PINNED.length);
  });

  it("дайджест ПОВНИЙ: усічений md5 (48 біт) не повернувся", () => {
    // 12 hex перебираються за години — знахідка ревʼю с56.
    expect(BLOCK19).not.toMatch(/substr\s*\(\s*md5\s*\(/);
    expect(BLOCK19).toMatch(/md5\(btrim\(regexp_replace\(/);
  });

  it("тіло береться і з prosrc, і з sqlbody (BEGIN ATOMIC живе не в prosrc)", () => {
    expect(BLOCK19).toMatch(/p\.prosrc \|\| coalesce\(pg_get_function_sqlbody\(p\.oid\)::text, ''\)/);
  });

  it("атрибути несуть НАЗВАНІ поля, разом із власником і мовою", () => {
    for (const field of ["secdef=", ";vol=", ";owner=", ";lang=", ";cfg="]) {
      expect(BLOCK19).toContain(field);
    }
    // власник — це і є права виконання для SECURITY DEFINER (знахідка ревʼю)
    expect(BLOCK19).toMatch(/pg_get_userbyid\(p\.proowner\)/);
    expect(BLOCK19).toMatch(/join pg_language l on l\.oid = p\.prolang/);
  });

  it("ключ розрізняє типи аргументів, а не лише імʼя", () => {
    expect(BLOCK19).toMatch(
      /p\.proname::text \|\| '\(' \|\| pg_get_function_identity_arguments\(p\.oid\) \|\| '\)'/
    );
    expect(BLOCK19).toMatch(/split_part\(e\.fn, '\(', 1\)/);
  });

  it.each([
    ["missing:", /select 'missing:' \|\| e\.fn/],
    ["body:", /select 'body:' \|\| e\.fn \|\| '->' \|\| c\.body/],
    ["attrs:", /select 'attrs:' \|\| e\.fn \|\| '->' \|\| c\.attrs/],
    ["auth_trigger:", /select 'auth_trigger:' \|\| coalesce\(v_atg, 'MISSING'\)/],
  ])("діагноз %s названий окремою гілкою", (_name, re) => {
    expect(BLOCK19).toMatch(re as RegExp);
  });

  /**
   * ⚠️ ЧОМУ ДОСЛІВНО, А НЕ ПО РЕГЕКСУ. Перша редакція цього файлу пінила лише
   *    `select 'body:' …` — і мутація `where c.body <> e.body and false`
   *    лишала пін ЗЕЛЕНИМ, тобто сторож сторожа не ловив головну атаку на
   *    себе. Правило те саме, що в стендах: якір + ТЕРМІНАЛІЗАТОР.
   */
  it.each([
    ["missing", "        select 'missing:' || e.fn as txt\n"
      + "          from expd e\n"
      + "         where not exists (select 1 from cur c where c.fn = e.fn)\n"
      + "        union all\n"],
    ["body", "        select 'body:' || e.fn || '->' || c.body\n"
      + "          from expd e join cur c on c.fn = e.fn\n"
      + "         where c.body <> e.body\n"
      + "        union all\n"],
    ["attrs", "        select 'attrs:' || e.fn || '->' || c.attrs\n"
      + "          from expd e join cur c on c.fn = e.fn\n"
      + "         where c.attrs <> e.attrs\n"
      + "        union all\n"],
  ])("гілка %s дослівна — дописану умову видно", (_n, block) => {
    expect(BLOCK19).toContain(block);
  });

  it("body: несе НОВИЙ дайджест — інакше з журналу не написати міграцію", () => {
    expect(BLOCK19).toMatch(/'body:' \|\| e\.fn \|\| '->' \|\| c\.body/);
  });

  it("тригер на auth.users під наглядом — №17 фільтрує nspname='public'", () => {
    expect(BLOCK19).toMatch(/n\.nspname = 'auth' and c\.relname = 'users'/);
    expect(BLOCK19).toContain("on_auth_user_created");
    expect(BLOCK19).toMatch(/handle_new_user\(\)\/O/);
  });

  it("виняток стає ЧЕРВОНИМ, а не тишею", () => {
    expect(BLOCK19).toMatch(/exception when others then/);
    expect(BLOCK19).toMatch(/guard_fn_bodies_raised:' \|\| sqlstate/);
  });

  it("перевірка рахує себе кроком лічильника", () => {
    const at = CODE.indexOf("'check', 'guard_fn_bodies'");
    expect(at).toBeGreaterThan(0);
    const before = CODE.slice(0, at);
    expect(before.match(/v_n := v_n \+ 1;/g) || []).toHaveLength(
      (CODE.match(/'check',\s*'[a-z0-9_]+'/g) || []).length
    );
  });
});
