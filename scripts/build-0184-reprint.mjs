// ============================================================
//  Генератор передруку `invariants_check` для 0184 (RF-03b).
//
//  ⚠️ ЧОМУ ГЕНЕРАТОР, А НЕ РУКИ. Тіло сторожа ~96 КБ. Переписане руками, воно
//     означало б «я не зачепив зайвого, чесне слово». Тут навпаки: блок
//     береться з файла 0183 ДОСЛІВНО, робляться ДВІ заякорені вставки, і
//     кожна мусить збігтися РІВНО ОДИН раз — інакше скрипт падає.
//
//  ⚠️ ЗЕЛЕНИЙ БАЗИС ІНСТРУМЕНТА вбудований: скрипт друкує md5 і довжину
//     СТАРОГО тіла (без CR). Вони мусять збігтися з тим, що віддає прод
//     (`3ac1aa3c88230816b8cf5ade32c1305d`, 96322). Якщо не збіглись — читач
//     блока або якорі зламані, і НОВОМУ числу вірити не можна теж.
//
//  Запуск: node scripts/build-0184-reprint.mjs
// ============================================================
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const SRC = "supabase/migrations/0183_rf03_sched_override_read.sql";
const DST = "supabase/migrations/0184_rf03b_sched_marker_fanout.sql";
const MARK = "-- <<<INVARIANTS_REPRINT>>>";
const ENDM = "-- <<<END INVARIANTS_REPRINT>>>";

const die = (m) => { console.error("⛔ " + m); process.exit(1); };
const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const noCR = (s) => s.replace(/\r/g, "");

const src = readFileSync(SRC, "utf8");
const eol = src.includes("\r\n") ? "\r\n" : "\n";

/* 1. Витягуємо блок передруку з 0183 — від заголовка до `$function$;` включно. */
const head = src.search(/^create or replace function public\.invariants_check/m);
if (head < 0) die(`у ${SRC} немає передруку invariants_check`);
const tail = src.indexOf("$function$;", head);
if (tail < 0) die("не знайдено кінець тіла ($function$;)");
const block = src.slice(head, tail + "$function$;".length);

/* Тіло — між `as $function$` і фінальним `$function$;`: рівно те, що Postgres
   збереже в prosrc. Саме на ньому рахуються піни. */
const bodyOf = (b) => {
  const o = b.indexOf("as $function$");
  if (o < 0) die("у блоці немає `as $function$`");
  return b.slice(o + "as $function$".length, b.lastIndexOf("$function$;"));
};

/* ⚠️ ДАЙДЖЕСТ РАХУЄМО З ФАЙЛА, А НЕ ВПИСУЄМО РУКАМИ. Перша редакція мала його
   константою — і рівно один правлений коментар усередині
   `change_marker_recipients` зробив константу протухлою МОВЧКИ. Тут вона
   виводиться з того самого тексту, який поїде в прод, тож розійтись їм ніде.
   Формула — рівно та, що в перевірці №19. */
const dst0 = readFileSync(DST, "utf8");
const cmrHead = "create or replace function public.change_marker_recipients(";
const cmrAt = dst0.indexOf(cmrHead);
if (cmrAt < 0) die(`у ${DST} немає change_marker_recipients`);
const cmrOpen = dst0.indexOf("as $function$", cmrAt) + "as $function$".length;
const cmrEnd = dst0.indexOf("$function$;", cmrOpen);
if (cmrOpen < 0 || cmrEnd < 0) die("не знайдено тіло change_marker_recipients");
const CMR_DIGEST = md5(dst0.slice(cmrOpen, cmrEnd).replace(/\s+/g, " ").trim());
console.log("дайджест change_marker_recipients із файла:", CMR_DIGEST);

const oldBody = bodyOf(block);
console.log("СТАРЕ тіло (базис інструмента):");
console.log("  довжина без CR:", noCR(oldBody).length, " md5 без CR:", md5(noCR(oldBody)));
console.log("  очікується:      96322                3ac1aa3c88230816b8cf5ade32c1305d");

/* 2. Дві заякорені вставки. Кожна — рівно один збіг, інакше падаємо. */
const INSERTS = [
  {
    name: "№17 guard_triggers",
    anchor: "      ('referral_access','trg_audit_referral_access','CREATE TRIGGER trg_audit_referral_access AFTER INSERT OR DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION fn_audit()'),",
    add: [
      "      ('referral_access','trg_zzz_sched_markers_prune','CREATE TRIGGER trg_zzz_sched_markers_prune AFTER DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION tg_sched_markers_prune_on_access()'),",
      "      ('schedule_overrides','trg_zz_change_markers','CREATE TRIGGER trg_zz_change_markers AFTER INSERT OR DELETE OR UPDATE ON public.schedule_overrides FOR EACH ROW EXECUTE FUNCTION tg_change_markers_sched_override()'),",
    ],
  },
  {
    name: "№19 guard_fn_bodies",
    anchor: "      ('ceo_list_for_clinic(p_clinic uuid)','4f3ee1ff598634aa8993f04fbad0a77c','secdef=true;vol=s;owner=postgres;lang=plpgsql;cfg=search_path=public'),",
    add: [
      "      ('change_marker_recipients(p_clinic uuid, p_actor uuid, p_scope_kind text, p_room uuid, p_referrer uuid, p_severity text, p_room_relevant boolean)','"
        + CMR_DIGEST
        + "','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),",
    ],
  },
];

let out = block;
for (const ins of INSERTS) {
  const n = out.split(ins.anchor).length - 1;
  if (n !== 1) die(`якір ${ins.name} збігся ${n} разів, а мусить рівно 1`);
  out = out.replace(ins.anchor, ins.anchor + ins.add.map((l) => eol + l).join(""));
  console.log(`  вставлено ${ins.add.length} рядк(ів) — ${ins.name}`);
}

const newBody = bodyOf(out);
const nb = noCR(newBody);
console.log("НОВЕ тіло:");
console.log("  довжина без CR:", nb.length, " md5 без CR:", md5(nb));
console.log("  приріст:", nb.length - noCR(oldBody).length, "байтів");

/* 3. Вставляємо блок у 0184 між сентинелами (скрипт можна ганяти повторно). */
let dst = readFileSync(DST, "utf8");
if (!dst.includes(MARK)) die(`у ${DST} немає мітки ${MARK}`);
const a = dst.indexOf(MARK);
const b = dst.indexOf(ENDM);
const payload = MARK + eol + out + eol + ENDM;
dst = b > a
  ? dst.slice(0, a) + payload + dst.slice(b + ENDM.length)
  : dst.slice(0, a) + payload + dst.slice(a + MARK.length);
writeFileSync(DST, dst, "utf8");
console.log(`\n✅ Блок (${out.length} байтів) вписано у ${DST}.`);
