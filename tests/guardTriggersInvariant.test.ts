/**
 * Статичний сторож перевірок №17 `guard_triggers` і №18 `server_now` (0171).
 *
 * ЧОМУ ВІН ІСНУЄ. Ревʼю с56 показало вимірюванням: слів `guard_triggers`,
 * `server_now`, `tgenabled` не було НІ В ОДНОМУ файлі `tests/` — при зеленій
 * базовій лінії пошуку (24 влучання на `invariants_check|policy_digest|
 * priv_drift`). Тобто чотирнадцять гардів PII і годинник сервера трималися
 * рівно на лічильнику `checked`: мутація `where x.diag is not null and false;`
 * лишала 2467 тестів зеленими І `checked = 18`, тож навіть ручний прогін
 * смоуків нічого б не сказав. У сусіда `priv_drift` такий сторож є
 * (`privilegeSurface.test.ts`) — тут його бракувало.
 *
 * ⚠️ ЧОГО ЦЕЙ ФАЙЛ НЕ ДОВОДИТЬ, і це не відписка: він читає ТЕКСТ міграції, а
 *    не виконує SQL. «Перевірка написана» ≠ «перевірка ловить» — останнє
 *    доводиться фальсифікацією на проді (підміна очікуваного списку в обидва
 *    боки) і кроком (j)/(e) смоуків. Тут ми стережемо рівно те, що можна
 *    стерегти статично: предикати, діагнози й інвентар на місці.
 *
 * ⚠️ Джерело — ОСТАННІЙ передрук, а не файл 0171 за іменем (урок с47/с55):
 *    наступна міграція, що передрукує сторожа, зробила б пін по 0171 сторожем
 *    мертвого тексту.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const MIGDIR = resolve(process.cwd(), "supabase/migrations");

/** Пари (таблиця, тригер), заради яких перевірка №17 і писалась. */
const GUARDS: ReadonlyArray<readonly [string, string]> = [
  ["incidents", "a01_no_client_delete"],
  ["incidents", "trg_guard_incident_room"],
  ["patient_cases", "a00_radiologist_no_write"],
  ["profiles", "trg_cleanup_orphan_clinic"],
  ["profiles", "trg_guard_profile_privileges"],
  ["queue_entries", "a00_radiologist_scope"],
  ["queue_entries", "a01_no_client_delete"],
  ["queue_entries", "check_case_clinic_match"],
  ["queue_entries", "trg_guard_queue_room"],
  ["queue_entries", "trg_guard_referrer_doctor"],
  ["queue_entries", "trg_guard_status_referrer"],
  ["waitlist_entries", "a00_radiologist_no_write"],
  ["waitlist_entries", "a01_no_client_delete"],
  ["waitlist_entries", "trg_guard_waitlist_room"],
];

/** Тіло останнього передрука сторожа. Правило вибору — спільне на три місця. */
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
  return best;
}

describe("№17 guard_triggers — інвентар гардів у сторожі", () => {
  const { fn, file } = latestReprint();

  it("передрук знайдено і несе обидві нові перевірки", () => {
    expect(file, "жодна міграція не передруковує invariants_check").not.toBe("");
    expect(fn, "перевірка є, а результат нікуди не кладеться")
      .toContain("'check', 'guard_triggers'");
    expect(fn, "перевірка є, а результат нікуди не кладеться")
      .toContain("'check', 'server_now'");
  });

  it("усі 14 гардів названі ПАРОЮ (таблиця, тригер) і з повним визначенням", () => {
    /* ⚠️ Пара, а не імʼя (урок 0165): `a01_no_client_delete` живе на трьох
       таблицях, `a00_radiologist_no_write` на двох. Пін по імені звіряв би
       чужі пари, і зняття гарда з ОДНІЄЇ таблиці лишалось би зеленим. */
    for (const [tbl, tg] of GUARDS) {
      expect(fn, `у списку немає пари ${tbl}/${tg}`)
        .toContain(`('${tbl}','${tg}','CREATE TRIGGER ${tg} `);
    }
    /* Антитавтологія: список не сміє мовчки схуднути. Рахуємо рядки очікувань,
       а не довіряємо циклу вище — він доводить лише «кожен названий є». */
    const rows = (fn.match(/\('[a-z_]+','[a-z0-9_]+','CREATE TRIGGER /g) || []).length;
    expect(rows, "число рядків очікування розійшлося з інвентарем").toBe(GUARDS.length);
  });

  it("пін — на pg_get_triggerdef ЦІЛКОМ, а не на біти tgtype", () => {
    /* ⚠️ Перша редакція звіряла timing/level/події з `tgtype` — і пропускала
       СПИСОК КОЛОНОК (`UPDATE OF …`, у шести гардів із чотирнадцяти), `WHEN`
       і СХЕМУ функції. Повернення до `tgtype` тут — регрес, а не рефакторинг. */
    expect(fn, "визначення тригера більше не пінується цілком")
      .toContain("regexp_replace(pg_get_triggerdef(t.oid), '\\s+', ' ', 'g')");
    expect(fn, "у списку зникли повні визначення — пін виродився")
      .toContain("BEFORE INSERT OR UPDATE OF room_id, clinic_id");
  });

  it("три діагнози названі окремо — червоне мусить казати ЩО саме", () => {
    for (const d of ["'missing:'", "'wrong_def:'", "'trigger_off:'"]) {
      expect(fn, `діагноз ${d} зник — червоне перестане називати причину`).toContain(d);
    }
  });

  it("гілка вимкнення — БЕЗ списку, і ENABLE ALWAYS проходить", () => {
    /* ⚠️ Вимкненню імена не потрібні: під наглядом усі не-внутрішні тригери
       public, а не лише 14. `'A'` (ENABLE ALWAYS) — посилення, і воно мусить
       проходити: інакше укріплення гарда зробило б інваріант вічно червоним,
       а вічно червоний = знятий (урок 0141). */
    expect(fn, "гілка вимкнення звузилась до списку або зникла")
      .toContain("t.tgenabled not in ('O', 'A')");
    expect(fn, "гілка вимкнення перестала бути безсписковою")
      .toContain("where n.nspname = 'public' and not t.tgisinternal\n         and t.tgenabled not in ('O', 'A')");
  });
});

describe("№18 server_now — годинник сервера у сторожі", () => {
  const { fn } = latestReprint();

  it("усі шість наслідків названі окремо", () => {
    /* Кожен рядок — окремий наслідок, який побачить людина в журналі. Злиття
       їх в один «server_now_bad» зробило б червоне німим. */
    for (const d of [
      "'server_now_missing'",
      "'server_now_no_grant:authenticated'",
      "'server_now_extra_grant:'",
      "'server_now_shape:'",
      "'server_now_body'",
      "'server_now_drift'",
      "'server_now_null'",
      "'server_now_raises'",
    ]) {
      expect(fn, `наслідок ${d} зник`).toContain(d);
    }
  });

  it("є ЖИВИЙ виклик, і він у власному блоці з exception", () => {
    /* ⚠️ Головна гілка. Чотири каталожні доводять лише «обʼєкт схожий на
       правильний»: тіло `select now() + interval '2 hours'` проходить їх усі,
       а настінний канон їде на дві години в усіх клієнтів разом.
       Виняток тут не має вбивати ВЕСЬ сторож (урок `to_regclass` з №15) —
       мовчазний cron гірший за названого порушника. */
    expect(fn, "живий виклик зник — лишились самі каталожні гілки")
      .toContain("public.server_now() - now()");
    expect(fn, "живий виклик без exception-обгортки завалив би весь сторож")
      .toContain("exception when others then\n    v_drift := 'server_now_raises';");
  });

  it("негативна половина ACL бере ЧЛЕНСТВО, а не літерал 'anon'", () => {
    /* ⚠️ `grant execute to X; grant X to anon` обходив би літерал в один хоп,
       а нова клієнтська роль (портал, кіоск) була б невидима з дня появи.
       Ролі беремо з членства в `authenticator` — канон №15. */
    expect(fn, "перевірка ACL повернулась до хардкоду ролі")
      .toContain("where a.rolname = 'authenticator'\n                 and g.rolname not in ('service_role', 'authenticated')");
    expect(fn, "грант на PUBLIC перестав бути порушником")
      .toContain("'server_now_extra_grant:PUBLIC'");
  });

  it("позитивна половина ACL на місці — саме вона тримає годинник", () => {
    /* Деградацію на годинник ПК дає ВТРАТА гранту `authenticated`, а не поява
       `anon`; тому ця гілка головніша за негативну. */
    expect(fn, "втрата гранту authenticated перестала бути порушником")
      .toContain("not has_function_privilege('authenticated', 'public.server_now()', 'EXECUTE')");
  });
});
