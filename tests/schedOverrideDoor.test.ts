/**
 * RF-03 (0183) — ДВЕРІ до графіка дня для екранів, куди заходить направник.
 *
 * ЩО СТАЛОСЬ. Політика `sched_referrer_read` віддавала направнику РЯДОК
 * `schedule_overrides` цілком, а весь погодинний графік дня живе в одній
 * JSONB-колонці `rooms`. RLS ріже РЯДКИ, а не значення всередині них — тож
 * грант на ОДИН кабінет показував години ВСІХ кабінетів центру.
 * ⚠️ Заміряно на проді зондом із відкотом (08.09.2026): направник із грантом
 *    рівно на «КТ Суприя 32» читав рядок 2026-08-09 і бачив ДВА ключі.
 *
 * ЛІКУВАННЯ. Міграція 0183 завела definer-RPC `sched_override_read`, яка ріже
 * `rooms` по `auth_referrer_visible_rooms()`, і ЗНЯЛА політику. Отже пряме
 * читання таблиці направником тепер дає 0 рядків — БЕЗ помилки. Це найгірша
 * форма поломки: екран не падає, він тихо каже «особливого дня немає» і малює
 * закритий санітарний день робочим.
 *
 * ЧОМУ ЦЕЙ ФАЙЛ ІСНУЄ. Сканер `readErrorTrust` стежить, щоб помилку читання
 * ПОДИВИЛИСЬ, — але повернення `.from("schedule_overrides")` він вважає цілком
 * законним: помилки там немає, форма відома. Тобто ЖОДЕН наявний сторож не
 * тримає саме те, що полагодила 0183. Цей — тримає, і рівно це.
 *
 * ⚠️ МЕЖА, НАЗВАНА ВГОЛОС. Список — це екрани, куди заходить НАПРАВНИК.
 *    Дошки персоналу (`QueueBoard`, `RadiologistBoard`), серверні дії
 *    (`app/queue/actions.ts`) та інтеграційні роути читають таблицю НАПРЯМУ, і
 *    це правильно: `sched_staff_read` жива, а роути ходять сервісним ключем
 *    повз RLS. Тягнути їх на RPC означало б лікувати те, що не болить.
 *
 * ⚠️ ЧОМУ `BookingModal` У СПИСКУ. Перший перелік місць називав ТРИ екрани —
 *    портал і дві модалки. `BookingModal` рендериться з `ReferralPortal`
 *    (рядок 2501), тобто теж лежить на дорозі направника, і його знайшов греп,
 *    а не пам'ять. Той самий клас помилки, що в пакеті 41: перелік місць
 *    завжди вужчий за дерево.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { codeOf } from "./helpers/codeOf";

/** ⚠️ `codeOf` знімає коментарі — інакше пояснення «раніше тут стояло
    .from("schedule_overrides")», написані в самих екранах, валили б сторожа
    на власному тексті. Перевіряємо КОД, а не прозу про нього. */
const src = (p: string) => codeOf(readFileSync(resolve(process.cwd(), p), "utf8"));

/** Екрани, куди заходить направник. Поіменно: зникнення БУДЬ-ЯКОГО має
    червоніти, а не ховатись за збереженою довжиною (урок readErrorTrust р2). */
const REFERRER_SCREENS = [
  "components/BookingModal.tsx",
  "components/ReferralPortal.tsx",
  "components/RescheduleModal.tsx",
  "components/StudyEditModal.tsx",
] as const;

const RPC_CALL = /\.rpc\(\s*["'`]sched_override_read["'`]/;
const DIRECT_READ = /\.from\(\s*["'`]schedule_overrides["'`]\s*\)/;

describe("RF-03: направник читає графік дня RPC, а не таблицею", () => {
  it.each(REFERRER_SCREENS)("%s — читає через sched_override_read", (f) => {
    expect(RPC_CALL.test(src(f)), `${f}: виклику sched_override_read немає`).toBe(true);
  });

  it.each(REFERRER_SCREENS)("%s — прямого читання таблиці НЕМАЄ", (f) => {
    /* Повернення прямого читання = мовчазна регресія: 0 рядків без помилки,
       закритий день малюється робочим. Саме тому тут заборона, а не порада. */
    expect(DIRECT_READ.test(src(f)), `${f}: повернулось .from("schedule_overrides")`).toBe(false);
  });

  it("перелік екранів під наглядом — поіменний", () => {
    expect([...REFERRER_SCREENS].sort()).toEqual([
      "components/BookingModal.tsx",
      "components/ReferralPortal.tsx",
      "components/RescheduleModal.tsx",
      "components/StudyEditModal.tsx",
    ]);
  });

  it("сторож справді розрізняє дві форми (перевірка ПОВЕДІНКОЮ)", () => {
    /* Без цього обидві регулярки могли б бути зламані й мовчазно зеленими на
       порожньому наборі — рівно та пастка, за яку переписали readErrorTrust. */
    expect(RPC_CALL.test('await supabase.rpc("sched_override_read", { p_clinic: c })')).toBe(true);
    expect(DIRECT_READ.test('await supabase.from("schedule_overrides").select("rooms")')).toBe(true);
    expect(RPC_CALL.test('await supabase.from("schedule_overrides")')).toBe(false);
  });
});

describe("RF-03: стара дорога закрита в самій базі, а не лише в клієнті", () => {
  /* Клієнт можна переписати; політику — ні, доки її не поверне нова міграція.
     Тому тут пінимо ФАКТ зняття: у дереві міграцій є `drop policy`, і жодна
     ПІЗНІША міграція її не створює назад. Дайджест політики в №16 стереже той
     самий інваріант із боку прода (`new:schedule_overrides.sched_referrer_read`
     — заміряно зондом із відкотом). */
  const MIGDIR = resolve(process.cwd(), "supabase/migrations");
  const files = readdirSync(MIGDIR).filter((f) => f.endsWith(".sql")).sort();

  /** Рядок, який СПРАВДІ виконується: не порожній і не закоментований.
      ⚠️ Перша редакція цієї перевірки читала весь текст файла регуляркою — і
      стенд це спіймав (мутація A7): `-- drop policy …` у секції ВІДКАТ так
      само збігається, тож закоментувати робочий statement можна було МОВЧКИ.
      Сторож, який зелений і на знятому запобіжнику, — це знятий сторож. */
  const liveLines = (f: string) =>
    readFileSync(resolve(MIGDIR, f), "utf8")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"));

  it("міграція, що знімає sched_referrer_read, існує рівно одна", () => {
    const dropping = files.filter((f) =>
      liveLines(f).some((l) =>
        /drop policy\s+sched_referrer_read\s+on\s+public\.schedule_overrides/.test(l),
      ),
    );
    expect(dropping).toEqual(["0183_rf03_sched_override_read.sql"]);
  });

  it("жодна міграція ПІСЛЯ неї політику не повертає", () => {
    const at = files.indexOf("0183_rf03_sched_override_read.sql");
    expect(at).toBeGreaterThanOrEqual(0);
    /* Коментарі у ВІДКАТ-секціях згадують `create policy` — беремо лише
       рядки, що справді виконуються (той самий `liveLines`, що вище). */
    const later = files
      .slice(at + 1)
      .filter((f) => liveLines(f).some((l) => /create policy\s+sched_referrer_read/.test(l)));
    expect(later).toEqual([]);
  });
});
