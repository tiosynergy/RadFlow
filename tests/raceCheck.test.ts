/* Вердикти харнеса гонки (scripts/race-check-lib.mjs), беклог №1.

   Навіщо тест на скрипт, який і так «просто друкує». Вердикт — єдине, що
   відрізняє доказ від збігу: PASS, виданий за INCONCLUSIVE, закриє хвіст с32
   брехнею, а наступна сесія повірить хендоффу (урок с37: три хвости були
   описані невірно й нікого не насторожили). */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  verdictSlotRace, verdictControl, verdictInProgressRace, verdictCas,
  verdictWaitlistRace,
  clinicDay, startSpreadMs, windowsOverlap,
  buildFixture, buildWaitlistFixture, buildWaitlistBooking,
  OVERLAP_SQLSTATE, IN_PROGRESS_SQLSTATE, FIXTURE_NAME, CAS_TO,
  WAITLIST_STALE_SQLSTATE, WAITLIST_NOT_FOUND_SQLSTATE,
  FIXTURE_DUR_MIN, FIXTURE_BUF_MIN,
  verdictCaseCancelRace, buildCaseFixture, buildCaseStep,
  CASE_NOT_OPEN_SQLSTATE, CASE_ACTIVE_STATUSES,
  verdictEmergencyStop, DEADLOCK_SQLSTATE, INCIDENT_TAKEN_SQLSTATE,
  RETRYABLE_LOCK_SQLSTATES, assertUsableJwt,
  verdictCaseRounds, CASE_NOT_OPEN_MESSAGE,
  verdictMidnightRace, MIDNIGHT_LATE_TIME, MIDNIGHT_EARLY_TIME, MIDNIGHT_CONTROL_TIME,
  deliveryGuardVerdict, N8N_EVIDENCE_WINDOW_DAYS, INTEGRATION_PREFIX_MIRROR,
  N8N_DEFER_NOTE, N8N_FREE_COMMANDS,
} from "../scripts/race-check-lib.mjs";

/* ⚠️ ЗНАЙДЕНО СТЕНДОМ `falsify-race-check` (с62), і це дефект САМИХ ТЕСТІВ,
   а не продукту. Мутація «`WAITLIST_STALE_SQLSTATE = "23P01"`» лишила ВЕСЬ
   набір зеленим: тести подавали ту саму константу і на вхід (`sqlstate`
   невдахи), і в очікування вердикту — тобто порівнювали значення САМЕ ІЗ
   СОБОЮ. Це рівно правило 2 з с50 («розводити треба ВХОДИ»), і воно було
   порушене в цьому файлі з с38 для ВСІХ трьох сценаріїв.

   Лікування двоступеневе:
     • нижче константи ПРИПНУТІ до літералів — вони кодують ЗАМІРЯНИЙ факт
       про БД, тож пін тут не тавтологія, а контракт;
     • у сценарії листа на вхід подаються ЛІТЕРАЛИ, а не константи.
   Старі сценарії лишені на піні свідомо: переписувати їх входи — окрема
   правка, і робити її «за компанію» означало б змішати дві зміни в одній. */
describe("SQLSTATE-константи припнуті до заміряних значень", () => {
  it("гонка за слот — 23P01 від тригера 0064", () => {
    expect(OVERLAP_SQLSTATE).toBe("23P01");
  });
  it("гонка за кабінет — 23505 від унікального індексу 0018", () => {
    expect(IN_PROGRESS_SQLSTATE).toBe("23505");
  });
  it("гонка за кандидата — 55000 WAITLIST_STALE зі schedule_from_waitlist_rpc", () => {
    expect(WAITLIST_STALE_SQLSTATE).toBe("55000");
  });
  it("кандидата немає — 42501, і це НЕ програш у гонці", () => {
    expect(WAITLIST_NOT_FOUND_SQLSTATE).toBe("42501");
  });
  it("кейс не активний — 22023 з add_case_step_rpc", () => {
    expect(CASE_NOT_OPEN_SQLSTATE).toBe("22023");
  });
  it("дедлок — 40P01, і це ЄДИНИЙ спостережуваний наслідок зламаного порядку локів", () => {
    expect(DEADLOCK_SQLSTATE).toBe("40P01");
  });
  /* ⚠️ Літерал збігається з `IN_PROGRESS_SQLSTATE`, і саме тому пін окремий:
     за ними стоять РІЗНІ індекси (0017 проти 0018). Звести їх до однієї
     константи означало б, що правка одного сценарію нечутно перевизначає
     очікування іншого. */
  it("кабінет уже має простій — 23505 від індексу 0017 (НЕ 0018)", () => {
    expect(INCIDENT_TAKEN_SQLSTATE).toBe("23505");
  });
  /* ⚠️ Цей список — дзеркало ТРЬОХ місць у БД одночасно
     (`check_case_distinct_room`, `check_case_no_time_overlap`,
     `case_recompute_status`). Розійшовшись із ними, він зробив би вердикт
     «заборонений стан» мʼякшим за саму базу: крок у пропущеному статусі
     БД вважала б активним, а харнес — ні, і дефект пройшов би як PASS. */
  it("активні статуси кроку — рівно ті чотири, що знає БД", () => {
    expect([...CASE_ACTIVE_STATUSES].sort()).toEqual(
      ["in_progress", "needs_reschedule", "scheduled", "waiting"]);
  });
});

/** Учасник гонки: за замовчуванням старти щільні (одночасність доведена). */
function outcome(ok: boolean, sqlstate = "", startedAt = 1000, ms = 40) {
  return {
    id: `id-${startedAt}-${sqlstate || "ok"}`,
    ok, sqlstate, message: sqlstate ? `помилка ${sqlstate}` : "",
    startedAt, finishedAt: startedAt + ms,
  };
}

describe("verdictSlotRace — доказ, а не збіг", () => {
  it("рівно одна удача, решта 23P01 → PASS", () => {
    const r = verdictSlotRace([outcome(true, "", 1000), outcome(false, OVERLAP_SQLSTATE, 1005)]);
    expect(r.verdict).toBe("PASS");
  });

  it("ДВОЄ записались у слот → FAIL (це і є шуканий дефект)", () => {
    const r = verdictSlotRace([outcome(true, "", 1000), outcome(true, "", 1004)]);
    expect(r.verdict).toBe("FAIL");
    expect(r.reason).toMatch(/ПОДВІЙНЕ БРОНЮВАННЯ/);
  });

  it("не записався ніхто → FAIL, а не PASS «бо подвійного нема»", () => {
    const r = verdictSlotRace([outcome(false, "23514", 1000), outcome(false, OVERLAP_SQLSTATE, 1003)]);
    expect(r.verdict).toBe("FAIL");
  });

  it("невдаха впав НЕ через гонку (23514) → FAIL, а не PASS", () => {
    // Найпідступніший випадок: «одна удача з двох» виглядає як успіх, але
    // другий упав на модальності/графіку — гонки не було взагалі.
    const r = verdictSlotRace([outcome(true, "", 1000), outcome(false, "23514", 1002)]);
    expect(r.verdict).toBe("FAIL");
    expect(r.reason).toMatch(/НЕ через гонку/);
  });
});

describe("одночасність — межа між доказом і самообманом", () => {
  it("послідовний прогін (розкид 3 с) НЕ дає PASS, хоча удача рівно одна", () => {
    const r = verdictSlotRace([outcome(true, "", 1000), outcome(false, OVERLAP_SQLSTATE, 4000)]);
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.spread).toBe(3000);
  });

  it("ДЕФЕКТ важливіший за недоведену одночасність: подвійне бронювання з великим розкидом усе одно FAIL", () => {
    // Якби порядок перевірок був зворотний, реальний дефект сховався б за
    // «одночасність не доведена» — і сесія доповіла б «нічого не з'ясували».
    const r = verdictSlotRace([outcome(true, "", 1000), outcome(true, "", 9000)]);
    expect(r.verdict).toBe("FAIL");
  });

  it("менше двох учасників — гонки не було", () => {
    expect(verdictSlotRace([outcome(true)]).verdict).toBe("FAIL");
  });

  it("startSpreadMs рахує розкид СТАРТІВ, не тривалостей", () => {
    expect(startSpreadMs([outcome(true, "", 1000, 500), outcome(true, "", 1020, 5)])).toBe(20);
  });
});

describe("verdictControl — сторож придатності фікстури", () => {
  it("усі пройшли і вікна перетинаються → PASS", () => {
    const r = verdictControl([outcome(true, "", 1000, 80), outcome(true, "", 1010, 70)]);
    expect(r.verdict).toBe("PASS");
  });

  it("хоч один упав → FAIL: фікстура непридатна, гонку інтерпретувати не можна", () => {
    const r = verdictControl([outcome(true, "", 1000), outcome(false, "23514", 1005)]);
    expect(r.verdict).toBe("FAIL");
  });

  it("вікна НЕ перетинаються → INCONCLUSIVE: клієнт стріляв по черзі", () => {
    // Саме цей випадок ловить «паралельність» через послідовний await:
    // всі удачі на місці, а конкуренції не було ні секунди.
    const r = verdictControl([outcome(true, "", 1000, 50), outcome(true, "", 2000, 50)]);
    expect(r.verdict).toBe("INCONCLUSIVE");
  });

  it("windowsOverlap не залежить від порядку у масиві", () => {
    const a = outcome(true, "", 1000, 100);
    const b = outcome(true, "", 1050, 100);
    expect(windowsOverlap([a, b])).toBe(true);
    expect(windowsOverlap([b, a])).toBe(true);
  });
});

/* Сценарій «кабінет» (с42): гарант ІНШИЙ — не тригер 0064, а унікальний
   частковий індекс 0018. Переплутати SQLSTATE тут дорого: 23505 від індексу
   й 23P01 від тригера означають різні інваріанти, і зелений вердикт на
   чужому коді довів би не те, що написано в назві сценарію. */
describe("verdictInProgressRace — двоє в один кабінет", () => {
  it("один зайшов, другий отримав 23505 → PASS", () => {
    const r = verdictInProgressRace([outcome(true, "", 1000), outcome(false, IN_PROGRESS_SQLSTATE, 1004)]);
    expect(r.verdict).toBe("PASS");
    expect(r.reason).toMatch(/індексу 0018/);
  });

  it("ДВОЄ зайшли в кабінет → FAIL", () => {
    const r = verdictInProgressRace([outcome(true, "", 1000), outcome(true, "", 1003)]);
    expect(r.verdict).toBe("FAIL");
    expect(r.reason).toMatch(/ДВОЄ В ОДНОМУ КАБІНЕТІ/);
  });

  it("невдаха впав на 23P01 (гарант слота, не кабінету) → FAIL, а не PASS", () => {
    // Найпідступніше: «одна удача з двох» виглядає правильно, але спрацював
    // ІНШИЙ гард — отже сценарій перевіряв не те, що обіцяв.
    const r = verdictInProgressRace([outcome(true, "", 1000), outcome(false, OVERLAP_SQLSTATE, 1002)]);
    expect(r.verdict).toBe("FAIL");
    expect(r.reason).toMatch(/НЕ через гонку/);
  });

  it("не зайшов ніхто → FAIL", () => {
    const r = verdictInProgressRace([outcome(false, IN_PROGRESS_SQLSTATE, 1000), outcome(false, IN_PROGRESS_SQLSTATE, 1002)]);
    expect(r.verdict).toBe("FAIL");
  });

  it("послідовний прогін (розкид 3 с) → INCONCLUSIVE, а не PASS", () => {
    const r = verdictInProgressRace([outcome(true, "", 1000), outcome(false, IN_PROGRESS_SQLSTATE, 4000)]);
    expect(r.verdict).toBe("INCONCLUSIVE");
  });
});

/* Сценарій «лист очікування» (с62): гарант — УМОВНИЙ UPDATE усередині
   `schedule_from_waitlist_rpc`, а не тригер і не індекс. Різниця не
   термінологічна: 23P01 і 23505 породжує двигун, а 55000 тут піднято РУКАМИ
   після `row_count = 0`. Тому мутація «прибрати `and status = 'waiting'`» не
   дала б жодної помилки БД — вона дала б ДВОХ переможців, і єдиний, хто це
   ловить, — вердикт. */
describe("verdictWaitlistRace — двоє записують одного кандидата", () => {
  /* ⚠️ На вхід іде ЛІТЕРАЛ, а не константа: подавши константу, тест порівняв
     би її саму із собою й лишився б зеленим на будь-якому її значенні
     (заміряно стендом `falsify-race-check`, мутація M1). */
  it("один записав, другий отримав 55000 → PASS", () => {
    const r = verdictWaitlistRace([outcome(true, "", 1000), outcome(false, "55000", 1006)]);
    expect(r.verdict).toBe("PASS");
    expect(r.reason).toMatch(/schedule_from_waitlist_rpc/);
  });

  /* ⚠️ ЦЕ головний тест файлу для цього сценарію: саме так виглядає знята
     умова `status='waiting'` — БЕЗ жодної помилки БД, просто два успіхи. */
  it("ДВОЄ записали одного кандидата → FAIL", () => {
    const r = verdictWaitlistRace([outcome(true, "", 1000), outcome(true, "", 1004)]);
    expect(r.verdict).toBe("FAIL");
    expect(r.reason).toMatch(/КАНДИДАТА ЗАПИСАЛИ ДВІЧІ/);
  });

  /* 42501 — це «кандидата немає в цьому центрі», тобто зламана фікстура, а
     НЕ «інший оператор випередив». Прийняти його за гонку означало б видати
     непридатну фікстуру за доказ взаємного виключення. */
  it("невдаха впав на 42501 (кандидата немає) → FAIL, а не PASS", () => {
    const r = verdictWaitlistRace([outcome(true, "", 1000), outcome(false, "42501", 1003)]);
    expect(r.verdict).toBe("FAIL");
    expect(r.reason).toMatch(/НЕ через гонку/);
  });

  /* Вставка (крок 2 RPC) впала на booking-тригері й відкотила застовплення
     разом із собою — переможців нуль. Це НЕ «гарант спрацював двічі». */
  it("не записав ніхто (23P01 у обох) → FAIL з назвою причини", () => {
    const r = verdictWaitlistRace([
      outcome(false, OVERLAP_SQLSTATE, 1000), outcome(false, OVERLAP_SQLSTATE, 1002),
    ]);
    expect(r.verdict).toBe("FAIL");
    expect(r.reason).toMatch(/не записав НІХТО/);
  });

  /* ⚠️ ВІКНА ТУТ НАВМИСНЕ ПЕРЕТИНАЮТЬСЯ (перший висить 1000→5000, другий
     стартує о 4000). Інакше цей тест ловив би гейт ПЕРЕТИНУ ВІКОН, а не
     поріг РОЗКИДУ СТАРТІВ, і два різні гаранти доводились би одним тестом —
     що стенд і показав: мутація порога лишала тест зеленим, бо його червонив
     сусідній гейт. Гаранти пінуються ПООДИНЦІ. */
  it("послідовний прогін (розкид 3 с) → INCONCLUSIVE, а не PASS", () => {
    const r = verdictWaitlistRace([
      { id: "a", ok: true, sqlstate: "", message: "", startedAt: 1000, finishedAt: 5000 },
      { id: "b", ok: false, sqlstate: "55000", message: "стало", startedAt: 4000, finishedAt: 4500 },
    ]);
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.reason).toMatch(/розкид стартів/);
  });

  /* ⚠️ ГЕЙТ, ЯКОГО НЕМАЄ В ІНШИХ СЦЕНАРІЯХ (знахідка ревʼю Б, с62). Розкид
     СТАРТІВ тут ≈0 за побудовою, тож він доводить лише «не переписали на
     послідовний for…await». Справжній свідок паралельності — перетин ВІКОН
     запитів, і для цього сценарію він обовʼязковий: користувацький клієнт
     інший, ніж у контролю службової ролі. */
  it("старти щільні, але вікна НЕ перетнулись → INCONCLUSIVE", () => {
    // Другий стартував за 5 мс після першого, але перший уже завершився.
    const r = verdictWaitlistRace([
      { id: "a", ok: true, sqlstate: "", message: "", startedAt: 1000, finishedAt: 1002 },
      { id: "b", ok: false, sqlstate: "55000", message: "стало", startedAt: 1005, finishedAt: 1009 },
    ]);
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.reason).toMatch(/вікна запитів НЕ перетнулись/);
  });

  it("вікна перетинаються → PASS лишається PASS", () => {
    const r = verdictWaitlistRace([
      { id: "a", ok: true, sqlstate: "", message: "", startedAt: 1000, finishedAt: 1080 },
      { id: "b", ok: false, sqlstate: "55000", message: "стало", startedAt: 1005, finishedAt: 1090 },
    ]);
    expect(r.verdict).toBe("PASS");
  });

  /* Дефект важливіший за недоведену паралельність: подвійний запис лишається
     FAIL навіть без перетину вікон. Інакше реальний дефект сховався б за
     «нічого не зʼясували». */
  it("ДВОЄ переможців без перетину вікон — усе одно FAIL, а не INCONCLUSIVE", () => {
    const r = verdictWaitlistRace([
      { id: "a", ok: true, sqlstate: "", message: "", startedAt: 1000, finishedAt: 1002 },
      { id: "b", ok: true, sqlstate: "", message: "", startedAt: 1005, finishedAt: 1009 },
    ]);
    expect(r.verdict).toBe("FAIL");
  });
});

/* Сценарій «кейс» (с62): вердикт дивиться не на кількість удач, а на КІНЦЕВИЙ
   СТАН. Обидва впорядкування законні й дають однаковий кінець — кейс
   `cancelled`, усі кроки `cancelled`; різниця лише в тому, чи встиг крок
   додатись. Питання одне: чи може існувати кейс `cancelled` з АКТИВНИМ кроком. */
describe("verdictCaseCancelRace — скасування кейса проти додавання кроку", () => {
  /* `message` у типі з с63: текст відмови став частиною вердикту (той самий
     22023 RPC піднімає ще в чотирьох валідаціях входу), тож подавати його
     тести мусять. Без цього поля `tsc` червонів — а vitest проходив. */
  const add = (o: Partial<{ok: boolean; entryId: string | null; sqlstate: string; message: string; startedAt: number; finishedAt: number}> = {}) => ({
    ok: true, entryId: "e-new", sqlstate: "", message: "",
    startedAt: 1000, finishedAt: 1080, ...o,
  });
  const cancel = (o: Partial<{ok: boolean; cancelled: number | null; sqlstate: string; startedAt: number; finishedAt: number}> = {}) => ({
    ok: true, cancelled: 2, sqlstate: "", message: "",
    startedAt: 1005, finishedAt: 1090, ...o,
  });

  it("порядок «крок → скасування»: крок додано і зметено → PASS", () => {
    const r = verdictCaseCancelRace(add(), cancel(), {
      caseStatus: "cancelled",
      steps: [{ id: "e1", status: "cancelled" }, { id: "e-new", status: "cancelled" }],
    });
    expect(r.verdict).toBe("PASS");
    expect(r.reason).toMatch(/крок → скасування/);
  });

  it("порядок «скасування → крок»: крок відмовлено 22023 → PASS", () => {
    const r = verdictCaseCancelRace(
      /* ⚠️ ТЕКСТ ОБОВʼЯЗКОВИЙ із с63: сам по собі 22023 більше не зараховується.
         Та сама RPC піднімає його ще в чотирьох валідаціях входу. */
      add({ ok: false, entryId: null, sqlstate: "22023",
            message: "BAD_INPUT: кейс не активний — крок додати не можна" }),
      cancel(),
      { caseStatus: "cancelled", steps: [{ id: "e1", status: "cancelled" }] });
    expect(r.verdict).toBe("PASS");
    expect(r.reason).toMatch(/скасування → крок/);
  });

  /* ⚠️ ГОЛОВНЕ ТВЕРДЖЕННЯ ФАЙЛУ для цього сценарію. Саме так виглядає
     перевірка «кейс відкритий», винесена з-під `for update`: жодної помилки
     БД, крок вставився, а кейс лишився скасованим із живим кроком усередині. */
  it("кейс cancelled із АКТИВНИМ кроком → FAIL (заборонений стан)", () => {
    const r = verdictCaseCancelRace(add(), cancel(), {
      caseStatus: "cancelled",
      steps: [{ id: "e1", status: "cancelled" }, { id: "e-new", status: "scheduled" }],
    });
    expect(r.verdict).toBe("FAIL");
    expect(r.reason).toMatch(/ЗАБОРОНЕНИЙ СТАН/);
    expect(r.ids).toEqual(["e-new"]);
  });

  /* Кожен із чотирьох активних статусів мусить ловитись однаково: пропущений
     у списку статус зробив би вердикт мʼякшим за БД. */
  it.each(["scheduled", "waiting", "in_progress", "needs_reschedule"])(
    "активний крок у статусі %s теж дає FAIL", (st) => {
      const r = verdictCaseCancelRace(add(), cancel(), {
        caseStatus: "cancelled", steps: [{ id: "e-new", status: st }],
      });
      expect(r.verdict).toBe("FAIL");
    });

  it("термінальний крок (no_show) НЕ вважається живим — PASS", () => {
    const r = verdictCaseCancelRace(add(), cancel(), {
      caseStatus: "cancelled", steps: [{ id: "e-new", status: "no_show" }],
    });
    expect(r.verdict).toBe("PASS");
  });

  /* Другий бік того самого дефекту: кейс міг лишитись `open` (наприклад
     скасування нічого не змело), але доданий крок живий попри скасування. */
  it("доданий крок лишився активним при кейсі open → FAIL за id", () => {
    const r = verdictCaseCancelRace(add(), cancel(), {
      caseStatus: "open", steps: [{ id: "e-new", status: "scheduled" }],
    });
    expect(r.verdict).toBe("FAIL");
    expect(r.reason).toMatch(/лишився активним/);
  });

  it("крок відмовлено ЧУЖИМ кодом (23505) → FAIL, а не PASS", () => {
    const r = verdictCaseCancelRace(
      add({ ok: false, entryId: null, sqlstate: "23505" }), cancel(),
      { caseStatus: "cancelled", steps: [{ id: "e1", status: "cancelled" }] });
    expect(r.verdict).toBe("FAIL");
    expect(r.reason).toMatch(/НЕ через скасування/);
  });

  it("скасування впало → FAIL: постановка зламана", () => {
    const r = verdictCaseCancelRace(add(), cancel({ ok: false, cancelled: null, sqlstate: "42501" }), {
      caseStatus: "open", steps: [],
    });
    expect(r.verdict).toBe("FAIL");
    expect(r.reason).toMatch(/постановка зламана/);
  });

  it("вікна НЕ перетнулись → INCONCLUSIVE", () => {
    const r = verdictCaseCancelRace(
      add({ startedAt: 1000, finishedAt: 1002 }),
      cancel({ startedAt: 1005, finishedAt: 1009 }),
      { caseStatus: "cancelled", steps: [{ id: "e-new", status: "cancelled" }] });
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.reason).toMatch(/вікна запитів НЕ перетнулись/);
  });

  /* Дефект важливіший за недоведену одночасність — інакше реальний
     заборонений стан сховався б за «нічого не зʼясували». */
  it("заборонений стан без перетину вікон — усе одно FAIL", () => {
    const r = verdictCaseCancelRace(
      add({ startedAt: 1000, finishedAt: 1002 }),
      cancel({ startedAt: 1005, finishedAt: 1009 }),
      { caseStatus: "cancelled", steps: [{ id: "e-new", status: "scheduled" }] });
    expect(r.verdict).toBe("FAIL");
  });
});

describe("фікстури сценарію «кейс»", () => {
  const study = { dur: FIXTURE_DUR_MIN, type: "КТ", price: 100, region: "КТ ОГК", contrast: false };

  /* `status` не задаємо: дефолт БД `'open'` — саме той, який перевіряє
     `add_case_step_rpc` під локом. Продубльований тут, він мовчки розійшовся б. */
  it("рядок кейса НЕ задає status — його дає дефолт БД", () => {
    const k = buildCaseFixture({ id: "c1", clinicId: "cl1", label: "кейс" });
    expect(Object.keys(k)).not.toContain("status");
    expect(k.patient_name.startsWith(FIXTURE_NAME)).toBe(true);
  });

  /* ⚠️ Усі чотири поля перевіряються в тілі RPC ДО взяття локів і дають
     `22023 BAD_INPUT` — ТОЙ САМИЙ SQLSTATE, що й «кейс не активний». Тобто
     неповний `p_step` виглядав би як коректна відмова через скасування, і
     вердикт зарахував би зламану фікстуру за PASS. */
  it("p_step несе всі поля, які RPC перевіряє ДО локів", () => {
    const s = buildCaseStep({ roomId: "r1", day: "2026-09-20", time: "10:00", study });
    for (const k of ["room_id", "studies", "duration_min", "scheduled_date", "scheduled_time"]) {
      expect(s[k as keyof typeof s], `у p_step немає ${k} — RPC дасть 22023 BAD_INPUT`).toBeDefined();
    }
    expect(Array.isArray(s.studies) && s.studies.length).toBeTruthy();
    expect(s.scheduled_time).toMatch(/^\d{2}:\d{2}$/);
  });
});

/* Фікстури листа: обидві форми мусять задовольняти те, що ЗАМІРЯНО в проді
   (`check_waitlist_consistency` 0103 і тіло RPC), а не те, що здається
   очевидним. Тому тут пінуються саме ті три речі, поламавши які, прогін
   упав би на 23514 або на NOT NULL, і це виглядало б як «гонка зламалась». */
describe("фікстури сценарію «лист очікування»", () => {
  const study = { dur: FIXTURE_DUR_MIN, type: "КТ", price: 100, region: "КТ ОГК", contrast: false };

  it("рядок листа несе modality — інакше 23514 WAITLIST_MODALITY_MISMATCH", () => {
    const wl = buildWaitlistFixture({
      id: "w1", clinicId: "c1", modality: "CT", study, label: "лист",
    });
    expect(wl.modality).toBe("CT");
    expect(wl.patient_name.startsWith(FIXTURE_NAME)).toBe(true);
  });

  /* `status` НЕ задаємо руками: дефолт БД `'waiting'` — саме той стан, який
     застовплює CAS. Продубльований у харнесі, він мовчки розійшовся б із БД. */
  /* ⚠️ Перевіряємо КЛЮЧІ, а не значення властивості. Перша редакція писала
     `expect(wl.status).toBeUndefined()` — і tsc відмовився це компілювати:
     властивості просто немає в типі. Це не формальність, а різниця у СИЛІ
     твердження: `undefined` було б правдою і для `status: undefined`, який
     PostgREST усе одно надіслав би. Список ключів ловить обидва випадки. */
  it("рядок листа НЕ задає status — його дає дефолт БД", () => {
    const wl = buildWaitlistFixture({ id: "w1", clinicId: "c1", modality: "CT", study, label: "лист" });
    expect(Object.keys(wl), "харнес почав дублювати дефолт БД").not.toContain("status");
  });

  /* `room_id` у листа немає свідомо: гонка йде за КАНДИДАТА. Привʼязка
     кабінету додала б у сценарій другий гарант, який тут ні до чого. */
  it("рядок листа НЕ привʼязує кабінет — кабінет приходить у p_booking", () => {
    const wl = buildWaitlistFixture({ id: "w1", clinicId: "c1", modality: "CT", study, label: "лист" });
    expect(Object.keys(wl), "кандидату привʼязали кабінет — у сценарій заліз другий гарант")
      .not.toContain("room_id");
    const b = buildWaitlistBooking({ roomId: "r1", day: "2026-09-20", time: "10:00", study });
    expect(b.room_id).toBe("r1");
  });

  /* Ключі `p_booking` — рівно ті, які читає тіло RPC. `scheduled_time` там
     text-колонка без касту, тож формат «HH:MM» тримається саме тут. */
  it("p_booking несе всі NOT NULL-поля вставки", () => {
    const b = buildWaitlistBooking({ roomId: "r1", day: "2026-09-20", time: "10:00", study });
    for (const k of ["room_id", "patient_name", "studies", "duration_min", "scheduled_date", "scheduled_time"]) {
      expect(b[k as keyof typeof b], `у p_booking немає ${k} — вставка впаде на NOT NULL`).toBeDefined();
    }
    expect(b.scheduled_time).toMatch(/^\d{2}:\d{2}$/);
    expect(b.buffer_time_min).toBe(FIXTURE_BUF_MIN);
  });
});

/* Сценарій CAS (с42): тут «невдача» — НЕ виняток, а updated=false. Головне
   твердження — невдаха бачить статус ПЕРЕМОЖЦЯ: це і є доказ, що після
   `for update` рядок перечитано, а не взято зі старого знімка. */
describe("verdictCas — паралельний CAS на одному записі", () => {
  const cas = (
    updated: boolean | null, currentStatus: string | null,
    startedAt = 1000, ok = true, sqlstate = ""
  ) => ({
    id: "e1", ok, updated, currentStatus, sqlstate,
    message: sqlstate ? `помилка ${sqlstate}` : "",
    startedAt, finishedAt: startedAt + 30,
  });

  it("один оновив, другий бачить статус переможця → PASS", () => {
    const r = verdictCas([cas(true, CAS_TO, 1000), cas(false, CAS_TO, 1005)], { target: CAS_TO });
    expect(r.verdict).toBe("PASS");
  });

  it("ДВОЄ оновили → FAIL: for update не серіалізував", () => {
    const r = verdictCas([cas(true, CAS_TO, 1000), cas(true, CAS_TO, 1003)], { target: CAS_TO });
    expect(r.verdict).toBe("FAIL");
    expect(r.reason).toMatch(/ПОДВІЙНИЙ CAS/);
  });

  it("невдаха бачить СТАРИЙ статус → FAIL, хоча оновлення рівно одне", () => {
    // Саме той дефект, заради якого сценарій існує: CAS «спрацював», але
    // читання пішло повз лок — у проді це давало б хибне «вас випередили».
    const r = verdictCas([cas(true, CAS_TO, 1000), cas(false, "scheduled", 1004)], { target: CAS_TO });
    expect(r.verdict).toBe("FAIL");
    expect(r.reason).toMatch(/СТАРИЙ стан/);
  });

  it("виняток замість updated=false → FAIL", () => {
    const r = verdictCas([cas(true, CAS_TO, 1000), cas(null, null, 1002, false, "42501")], { target: CAS_TO });
    expect(r.verdict).toBe("FAIL");
    expect(r.reason).toMatch(/виняток/);
  });

  it("не оновив ніхто → FAIL", () => {
    const r = verdictCas([cas(false, "scheduled", 1000), cas(false, "scheduled", 1002)], { target: CAS_TO });
    expect(r.verdict).toBe("FAIL");
  });

  it("розкид стартів більший за межу → INCONCLUSIVE", () => {
    const r = verdictCas([cas(true, CAS_TO, 1000), cas(false, CAS_TO, 5000)], { target: CAS_TO });
    expect(r.verdict).toBe("INCONCLUSIVE");
  });
});

describe("clinicDay — календар центру, а не арифметика мілісекунд", () => {
  it("рахує від СЬОГОДНІ у зоні центру", () => {
    const now = new Date("2026-08-23T09:00:00Z");
    expect(clinicDay("Europe/Kiev", 0, now)).toBe("2026-08-23");
    expect(clinicDay("Europe/Kiev", 7, now)).toBe("2026-08-30");
  });

  it("зона центру може дати ІНШУ добу, ніж UTC", () => {
    // 21:30 UTC = 00:30 наступного дня в Києві.
    const now = new Date("2026-08-23T21:30:00Z");
    expect(clinicDay("Europe/Kiev", 0, now)).toBe("2026-08-24");
  });

  it("перехід DST не з'їдає добу", () => {
    // 25.10.2026 Київ переходить на зимовий час; вікно +7 через перехід.
    const now = new Date("2026-10-22T23:30:00Z");   // 26.10 02:30 у Києві
    expect(clinicDay("Europe/Kiev", 0, now)).toBe("2026-10-23");
    expect(clinicDay("Europe/Kiev", 7, now)).toBe("2026-10-30");
  });

  it("Europe/Kiev (старе написання у clinics.timezone) розпізнається", () => {
    const now = new Date("2026-08-23T09:00:00Z");
    expect(clinicDay("Europe/Kiev", 3, now)).toBe(clinicDay("Europe/Kyiv", 3, now));
  });
});

describe("buildFixture — id приходить ззовні, бо він же список прибирання", () => {
  it("кладе переданий id і впізнаване ім'я", () => {
    const row = buildFixture({
      id: "11111111-2222-3333-4444-555555555555",
      clinicId: "c1", roomId: "r1", day: "2026-08-30", time: "10:00",
      label: "гонка-1", study: { dur: 20, type: "МРТ", price: 1, region: "МРТ голова", contrast: false },
    });
    expect(row.id).toBe("11111111-2222-3333-4444-555555555555");
    expect(row.patient_name.startsWith(FIXTURE_NAME)).toBe(true);
    expect(row.status).toBe("scheduled");
    /* ⚠️ Звіряємо з ВХОДОМ, а не поле з полем (знахідка ревʼю Б, с62).
       `buildFixture` кладе в `studies` і `studies_original` ОДИН І ТОЙ САМИЙ
       масив, тож `toEqual(row.studies_original)` порівнював значення саме із
       собою і проходив би навіть якби обидва поля зникли (`undefined`
       дорівнює `undefined`). Той самий клас, що й із SQLSTATE-константами
       вище. */
    expect(row.studies).toEqual([{ dur: 20, type: "МРТ", price: 1, region: "МРТ голова", contrast: false }]);
    expect(row.studies_original).toEqual(row.studies);
  });

  it("зайнятість = dur + buffer (на цьому тримається рознесення слотів)", () => {
    const row = buildFixture({
      id: "x", clinicId: "c1", roomId: "r1", day: "2026-08-30", time: "10:00",
      label: "l", study: { dur: 20, type: "МРТ", price: 1, region: "r", contrast: false },
    });
    expect(row.duration_min + row.buffer_time_min).toBe(25);
  });

  /* ⚠️ Пакет 56: фікстура отримала `offSchedule`, і ДЕФОЛТ тут — головне.
     `off_schedule = true` вимикає єдину гілку `check_room_schedule`, яку
     взагалі можна вимкнути («робота після закриття»). Поставши дефолтом, він
     мовчки ослабив би ВСІ пʼять наявних сценаріїв: їхні фікстури перестали б
     перевірятись графіком, і ніхто б не помітив — вони й так у робочих
     годинах. Тому пінимо обидва боки. */
  it("off_schedule за замовчуванням ВИМКНЕНО — інакше графік перестає стерегти фікстури", () => {
    const base = {
      id: "x", clinicId: "c1", roomId: "r1", day: "2026-08-30", time: "10:00",
      label: "l", study: { dur: 20, type: "МРТ", price: 1, region: "r", contrast: false },
    };
    expect(buildFixture(base).off_schedule).toBe(false);
    expect(buildFixture({ ...base, offSchedule: true }).off_schedule).toBe(true);
  });
});

/* ------------------------------------------------------- аварійна зупинка */

/* ⚠️ ВХОДИ — ЛІТЕРАЛИ, а не константи модуля (правило 2 з с50, підтверджене
   стендом у с62). Подати `DEADLOCK_SQLSTATE` і на вхід, і в очікування
   означало б порівняти значення САМЕ ІЗ СОБОЮ: мутація «40P01 → 23P01»
   лишила б увесь набір зеленим. Константи припнуті окремо, вище. */
const R_A = "room-A";
const R_B = "room-B";

function stopShot(id: string, rooms: string[], o: {
  startedAt?: number; ms?: number; sqlstate?: string; asked?: string[];
} = {}) {
  const startedAt = o.startedAt ?? 1000;
  const sqlstate = o.sqlstate ?? "";
  return {
    id, ok: !sqlstate, rooms, asked: o.asked ?? [R_A, R_B],
    sqlstate, message: sqlstate ? `помилка ${sqlstate}` : "",
    startedAt, finishedAt: startedAt + (o.ms ?? 40),
  };
}

function brkShot(o: {
  ok?: boolean; sqlstate?: string; room?: string; startedAt?: number; ms?: number;
} = {}) {
  const ok = o.ok ?? false;
  const sqlstate = ok ? "" : (o.sqlstate ?? "23505");
  const startedAt = o.startedAt ?? 1000;
  return {
    id: "поломка(B)", ok, room: o.room ?? R_B,
    sqlstate, message: sqlstate ? `помилка ${sqlstate}` : "",
    startedAt, finishedAt: startedAt + (o.ms ?? 70),
  };
}

/** Здорова сцена: зупинка[A,B] забрала обидва кабінети, зупинка[B,A] не
    забрала нічого і чекала на локу, «поломка» програла індексу 0017. */
function healthy() {
  return {
    stops: [
      stopShot("зупинка[A,B]", [R_A, R_B], { ms: 40 }),
      stopShot("зупинка[B,A]", [], { ms: 55 }),
    ],
    breakdown: brkShot({ ms: 70 }),
    rooms: [R_A, R_B],
    activeByRoom: { [R_A]: 1, [R_B]: 1 },
  };
}

describe("verdictEmergencyStop — дві аварійні зупинки навхрест", () => {
  it("дедлоку немає, по одному інциденту на кабінет, невдахи чекали → PASS", () => {
    const v = verdictEmergencyStop(healthy());
    expect(v.verdict).toBe("PASS");
    /* PASS тут свідомо слабший за решту сценаріїв — і мусить це говорити. */
    expect(v.reason).toContain("НЕ доказ дисципліни порядку");
  });

  it("40P01 хоч в одного → FAIL з назвою учасника", () => {
    const s = healthy();
    s.stops[1] = stopShot("зупинка[B,A]", [], { ms: 55, sqlstate: "40P01" });
    const v = verdictEmergencyStop(s);
    expect(v.verdict).toBe("FAIL");
    expect(v.reason).toContain("ДЕДЛОК");
    expect(v.ids).toEqual(["зупинка[B,A]"]);
  });

  it("дедлок важливіший за недоведену одночасність: великий розкид усе одно FAIL", () => {
    const s = healthy();
    s.stops[1] = stopShot("зупинка[B,A]", [], { startedAt: 9000, ms: 20, sqlstate: "40P01" });
    const v = verdictEmergencyStop(s);
    expect(v.verdict).toBe("FAIL");
    expect(v.reason).toContain("ДЕДЛОК");
  });

  it("дедлок у «поломки» теж ловиться — вона учасник, а не діагностика", () => {
    const s = healthy();
    s.breakdown = brkShot({ sqlstate: "40P01", ms: 70 });
    const v = verdictEmergencyStop(s);
    expect(v.verdict).toBe("FAIL");
    expect(v.ids).toEqual(["поломка(B)"]);
  });

  it("ОБИДВІ зупинки заявили той самий кабінет → FAIL: індекс 0017 не втримав", () => {
    const s = healthy();
    s.stops[1] = stopShot("зупинка[B,A]", [R_B], { ms: 55 });
    s.activeByRoom = { [R_A]: 1, [R_B]: 2 };
    const v = verdictEmergencyStop(s);
    expect(v.verdict).toBe("FAIL");
    expect(v.reason).toContain("ЗУПИНЕНО ДВІЧІ");
  });

  /* ⚠️ Кабінет, якого не просили, — окремий дефект, а не привід мовчки його
     пропустити: він означає, що RPC зупинила НЕ ТЕ, що їй передали. */
  it("зупинено кабінет, якого НЕ просили → FAIL, а не тихий пропуск", () => {
    const s = healthy();
    s.stops[1] = stopShot("зупинка[B,A]", ["room-C"], { ms: 55 });
    const v = verdictEmergencyStop(s);
    expect(v.verdict).toBe("FAIL");
    expect(v.reason).toContain("якого не просили");
  });

  it("«поломка» ПРОЙШЛА на кабінеті, який уже зупинили → FAIL (той самий інваріант)", () => {
    const s = healthy();
    s.breakdown = brkShot({ ok: true, ms: 70 });
    const v = verdictEmergencyStop(s);
    expect(v.verdict).toBe("FAIL");
    expect(v.reason).toContain("ЗУПИНЕНО ДВІЧІ");
  });

  /* ⚠️ Стан судимо ЗА БАЗОЮ, а не за відповідями RPC. Відповіді можуть бути
     бездоганні, а рядків у базі — два: саме це і є дефект індексу 0017. */
  it("відповіді чисті, а в базі ДВА активні інциденти → FAIL", () => {
    const s = healthy();
    s.activeByRoom = { [R_A]: 1, [R_B]: 2 };
    const v = verdictEmergencyStop(s);
    expect(v.verdict).toBe("FAIL");
    expect(v.reason).toContain("не по одному активному інциденту");
    expect(v.ids).toEqual([R_B]);
  });

  it("кабінет узагалі не зупинено (у базі 0) → FAIL, а не PASS «бо подвійного нема»", () => {
    const s = healthy();
    s.activeByRoom = { [R_A]: 1, [R_B]: 0 };
    const v = verdictEmergencyStop(s);
    expect(v.verdict).toBe("FAIL");
  });

  it("інцидент у базі є, але його не заявив ніхто → FAIL: сцена не наша", () => {
    const s = healthy();
    s.stops[0] = stopShot("зупинка[A,B]", [R_A], { ms: 40 });
    const v = verdictEmergencyStop(s);
    expect(v.verdict).toBe("FAIL");
    expect(v.reason).toContain("інцидент чужий");
  });

  it("зупинка впала НЕ дедлоком (42501) → FAIL: гард ролі, а не гонка", () => {
    const s = healthy();
    s.stops[1] = stopShot("зупинка[B,A]", [], { ms: 55, sqlstate: "42501" });
    const v = verdictEmergencyStop(s);
    expect(v.verdict).toBe("FAIL");
    expect(v.reason).toContain("зупинка впала НЕ через гонку");
  });

  it("«поломка» впала ЧУЖИМ кодом (42501) → FAIL, хоча падати їй можна", () => {
    const s = healthy();
    s.breakdown = brkShot({ sqlstate: "42501", ms: 70 });
    const v = verdictEmergencyStop(s);
    expect(v.verdict).toBe("FAIL");
    expect(v.reason).toContain("«поломка» впала НЕ через гонку");
  });

  it("менше двох зупинок — гонки не було", () => {
    const s = healthy();
    s.stops = [s.stops[0]];
    expect(verdictEmergencyStop(s).verdict).toBe("FAIL");
  });

  it("розкид стартів більший за межу → INCONCLUSIVE", () => {
    const s = healthy();
    s.stops[1] = stopShot("зупинка[B,A]", [], { startedAt: 4000, ms: 55 });
    s.breakdown = brkShot({ startedAt: 4000, ms: 70 });
    const v = verdictEmergencyStop(s);
    expect(v.verdict).toBe("INCONCLUSIVE");
    expect(v.reason).toContain("розкид стартів");
  });

  /* ⚠️ ГОЛОВНИЙ ТЕСТ ЦЬОГО ФАЙЛА, і він фіксує рішення, а не поведінку.
     Перша редакція драбинки мала гейт «слід зіткнення»: 23505 у «поломки»
     або неповний `stopped_rooms`. Обидва — порожні: ПОСЛІДОВНИЙ прогін дає
     їх один-в-один. Сцена нижче — саме послідовна (вікна не перетинаються),
     а «сліди» на місці. PASS тут означав би той самий вакуум, через який
     заблоковано сценарій `case`. */
  it("послідовний прогін із «слідами зіткнення» → INCONCLUSIVE, а не PASS", () => {
    const v = verdictEmergencyStop({
      stops: [
        stopShot("зупинка[A,B]", [R_A, R_B], { startedAt: 1000, ms: 60 }),
        stopShot("зупинка[B,A]", [], { startedAt: 1100, ms: 40 }),
      ],
      breakdown: brkShot({ startedAt: 1160, ms: 30 }),
      rooms: [R_A, R_B],
      activeByRoom: { [R_A]: 1, [R_B]: 1 },
    });
    expect(v.verdict).toBe("INCONCLUSIVE");
    expect(v.reason).toContain("НЕ перетнулись");
  });

  /* ⚠️ Другий бік того самого рішення: вікна перетнулись, але ВСІ невдахи
     фінішували раніше за переможця. На advisory-локу вони не стояли — отже
     їхня відмова прийшла звідкись іще, і PASS був би припущенням. */
  it("вікна перетнулись, але невдахи фінішували РАНІШЕ за переможця → INCONCLUSIVE", () => {
    const v = verdictEmergencyStop({
      stops: [
        stopShot("зупинка[A,B]", [R_A, R_B], { startedAt: 1000, ms: 200 }),
        stopShot("зупинка[B,A]", [], { startedAt: 1010, ms: 20 }),
      ],
      breakdown: brkShot({ startedAt: 1010, ms: 25 }),
      rooms: [R_A, R_B],
      activeByRoom: { [R_A]: 1, [R_B]: 1 },
    });
    expect(v.verdict).toBe("INCONCLUSIVE");
    expect(v.reason).toContain("на локу вони не чекали");
  });

  it("досить ОДНОГО невдахи, що дочекався коміту → PASS", () => {
    const v = verdictEmergencyStop({
      stops: [
        stopShot("зупинка[A,B]", [R_A, R_B], { startedAt: 1000, ms: 200 }),
        stopShot("зупинка[B,A]", [], { startedAt: 1010, ms: 20 }),
      ],
      breakdown: brkShot({ startedAt: 1010, ms: 400 }),
      rooms: [R_A, R_B],
      activeByRoom: { [R_A]: 1, [R_B]: 1 },
    });
    expect(v.verdict).toBe("PASS");
  });

  /* ⚠️ Дефект важливіший за недоведену одночасність — той самий канон, що в
     `verdictExclusive`: подвійна зупинка реальна незалежно від таймінгів. */
  it("подвійна зупинка при послідовному прогоні — усе одно FAIL", () => {
    const v = verdictEmergencyStop({
      stops: [
        stopShot("зупинка[A,B]", [R_A, R_B], { startedAt: 1000, ms: 40 }),
        stopShot("зупинка[B,A]", [R_B], { startedAt: 9000, ms: 40 }),
      ],
      breakdown: brkShot({ startedAt: 9000, ms: 40 }),
      rooms: [R_A, R_B],
      activeByRoom: { [R_A]: 1, [R_B]: 2 },
    });
    expect(v.verdict).toBe("FAIL");
    expect(v.reason).toContain("ЗУПИНЕНО ДВІЧІ");
  });
});

/* --------------------------- аварійна зупинка ЗІ ЗВʼЯЗКОЮ КЕЙСА (пакет 61) */

/** Четвертий постріл — `cancel_case_rpc`. Саме він дає інверсію порядку
    (case→queue) проти зупинки, яка після AFTER-тригера йде queue→case. */
function cancelShot(o: {
  sqlstate?: string; startedAt?: number; ms?: number;
} = {}) {
  const sqlstate = o.sqlstate ?? "";
  const startedAt = o.startedAt ?? 1000;
  return {
    id: "скасування кейса", ok: !sqlstate,
    sqlstate, message: sqlstate ? `помилка ${sqlstate}` : "",
    startedAt, finishedAt: startedAt + (o.ms ?? 90),
  };
}

function healthyWithCase() {
  return { ...healthy(), canceller: cancelShot({ ms: 90 }) };
}

describe("verdictEmergencyStop — режим caseLinked (stop --with-case)", () => {
  /* ⚠️ ГОЛОВНИЙ ТЕСТ ЦЬОГО БЛОКУ: послаблення НЕ ПОШИРЮЄТЬСЯ на звичайний
     прогін. Сторожем регресії лишається сцена БЕЗ кейса, і там 40P01 —
     дефект. Якби режим протік у дефолт, проєкт мовчки втратив би єдине
     місце, де 40P01 узагалі видно. */
  it("без caseLinked 40P01 лишається FAIL — старий сторож недоторканий", () => {
    const s = healthyWithCase();
    s.stops[1] = stopShot("зупинка[B,A]", [], { ms: 55, sqlstate: "40P01" });
    const v = verdictEmergencyStop(s);            // caseLinked НЕ переданий
    expect(v.verdict).toBe("FAIL");
    expect(v.reason).toContain("ДЕДЛОК");
  });

  it("caseLinked + 40P01 → INCONCLUSIVE з назвою ОГОЛОШЕНОГО вікна", () => {
    const s = healthyWithCase();
    s.stops[1] = stopShot("зупинка[B,A]", [], { ms: 55, sqlstate: "40P01" });
    const v = verdictEmergencyStop(s, { caseLinked: true });
    expect(v.verdict).toBe("INCONCLUSIVE");
    expect(v.reason).toContain("ОГОЛОШЕНЕ ВІКНО");
    expect(v.ids).toEqual(["зупинка[B,A]"]);
  });

  /* ⚠️ Причина мусить нести ОБИДВІ половини межі, інакше наступний читач
     побачить INCONCLUSIVE і вирішить, що це просто «не довели». */
  it("причина називає і механізм (in_progress-передлок), і те, що бачить оператор", () => {
    const s = healthyWithCase();
    s.canceller = cancelShot({ sqlstate: "40P01", ms: 90 });
    const v = verdictEmergencyStop(s, { caseLinked: true });
    expect(v.reason).toContain("in_progress");
    expect(v.reason).toContain("cancel_case_rpc");
    expect(v.reason).toContain("ЖЕРТВУ");
    expect(v.reason).toContain("спробуйте ще раз");
  });

  /* ⚠️ Без четвертого пострілу інверсії немає ЗА ПОБУДОВОЮ: обидві зупинки
     лочать `order by q.id` однаково. Терпіти 40P01 у такій сцені означало б
     ковтати реальний дефект дисципліни. Тому не «тихо FAIL», а ВИНЯТОК:
     це помилка виклику, а не результат заміру. */
  it("caseLinked без canceller — КИДАЄ, а не послаблює мовчки", () => {
    expect(() => verdictEmergencyStop(healthy(), { caseLinked: true }))
      .toThrow(/caseLinked без canceller/);
  });

  it("скасування впало НЕ дедлоком (42501) → FAIL: четвертого учасника не було", () => {
    const s = healthyWithCase();
    s.canceller = cancelShot({ sqlstate: "42501", ms: 90 });
    const v = verdictEmergencyStop(s, { caseLinked: true });
    expect(v.verdict).toBe("FAIL");
    expect(v.reason).toContain("четвертого учасника в сцені не було");
    expect(v.ids).toEqual(["скасування кейса"]);
  });

  it("здорова сцена з кейсом → PASS, і PASS чесно каже, що вікно ЛИШЕ не відкрилось", () => {
    const v = verdictEmergencyStop(healthyWithCase(), { caseLinked: true });
    expect(v.verdict).toBe("PASS");
    expect(v.reason).toContain("НЕ доказ, що його немає");
  });

  it("без caseLinked той самий PASS цієї приписки НЕ має", () => {
    const v = verdictEmergencyStop(healthy());
    expect(v.verdict).toBe("PASS");
    expect(v.reason).not.toContain("НЕ доказ, що його немає");
  });

  /* ⚠️ Четвертий постріл — УЧАСНИК, а не спостерігач: його старт мусить
     рахуватись у розкиді. Інакше сцена, де скасування пішло на секунду
     пізніше, виглядала б одночасною. */
  it("старт скасування входить у розкид — пізній четвертий дає INCONCLUSIVE", () => {
    const s = healthyWithCase();
    s.canceller = cancelShot({ startedAt: 9000, ms: 90 });
    const v = verdictEmergencyStop(s, { caseLinked: true });
    expect(v.verdict).toBe("INCONCLUSIVE");
    expect(v.reason).toContain("розкид стартів");
  });
});

/* ⚠️ ПІН КОНТРАКТУ З ПРОДУКТОМ, а не з памʼяттю. Уся терпимість режиму
   `--with-case` до 40P01 спирається на заяву БД «транзієнтне, клієнт
   повторює». Розійдеться `isRetryableLockError` із цим списком — і терпимість
   стане безпідставною МОВЧКИ. Тому читаємо САМ `actions.ts`. */
describe("RETRYABLE_LOCK_SQLSTATES звірено з продуктом", () => {
  const actions = readFileSync(resolve(process.cwd(), "app/queue/actions.ts"), "utf8");
  const body = actions.slice(
    actions.indexOf("function isRetryableLockError"),
    actions.indexOf("function classifyError"));

  it("механізм піна робочий: тіло isRetryableLockError знайдено", () => {
    expect(body.length).toBeGreaterThan(40);
    expect(body).toContain("return code ===");
  });

  it.each(["40P01", "40001", "55P03", "57014"])(
    "%s — і в харнесі, і в продукті", (code) => {
      expect(RETRYABLE_LOCK_SQLSTATES).toContain(code);
      expect(body).toContain(`"${code}"`);
    });

  it("список харнеса не ширший за продуктовий", () => {
    for (const code of RETRYABLE_LOCK_SQLSTATES) expect(body).toContain(`"${code}"`);
  });

  /* ⚠️ Половина піна, без якої він не фальсифікується: аварійна зупинка
     мусить і далі ПРОПУСКАТИ 40P01 через цей предикат. Приберуть виклик —
     заява «клієнт повторює» стане неправдою, а тест лишався б зеленим. */
  it("emergencyStop і далі класифікує локову помилку цим предикатом", () => {
    const stop = actions.slice(actions.indexOf('rpc("emergency_stop_rpc"'));
    expect(stop.slice(0, 1200)).toContain("isRetryableLockError");
  });
});

/* ⚠️ ЗАПЛАЧЕНО ЖИВИМ ПРОГОНОМ 11.09.2026. У `RADFLOW_USER_JWT` опинився
   ПЛЕЙСХОЛДЕР із довідки («<токен>», кирилицею). Харнес надрукував правильний
   діагноз «це не схоже на JWT» — і пішов у мережу з цим значенням, упавши за
   двісті рядків сирим «Cannot convert argument to a ByteString … value of 1090
   which is greater than 255». Діагностика, яка не зупиняє, — це коментар.
   Тести нижче стережуть саме ЗУПИНКУ, а не текст. */
describe("assertUsableJwt — токен перевіряється ДО мережі", () => {
  /* Валідний за ФОРМОЮ токен; підпис нікого тут не цікавить. Збираємо його
     з частин, а не беремо константою: у репозиторії не має лежати нічого,
     що виглядає як справжній токен. */
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const good = `${b64({ alg: "ES256", kid: "k1" })}.${b64({ role: "authenticated", exp })}.sig`;

  it("придатний токен → метадані, і ЖОДНОГО фрагмента самого токена", () => {
    const m = assertUsableJwt(good);
    expect(m).toMatchObject({ alg: "ES256", kid: true, role: "authenticated" });
    expect(m.minLeft).toBeGreaterThan(50);
    expect(JSON.stringify(m)).not.toContain("sig");
  });

  it("порожня змінна — окреме повідомлення «не задана», а не «зіпсутий»", () => {
    expect(() => assertUsableJwt("")).toThrow(/порожній/);
    expect(() => assertUsableJwt(undefined as unknown as string)).toThrow(/порожній/);
  });

  /* ⚠️ ГОЛОВНИЙ ТЕСТ: рівно той вхід, який поклав живий прогін. Байт > 255
     у значенні заголовка HTTP заборонений — і причина мусить називатись
     своїм імʼям, а не ховатись за загальним «не схоже на JWT». */
  it("кирилиця в токені → кидає ІЗ НАЗВОЮ причини (не-ASCII), а не йде в мережу", () => {
    expect(() => assertUsableJwt("<токен>")).toThrow(/не-ASCII/);
    expect(() => assertUsableJwt("<токен>")).toThrow(/ПЛЕЙСХОЛДЕР/);
  });

  it("позиція поганого символу названа — інакше шукати нічого", () => {
    expect(() => assertUsableJwt("abcdefghт")).toThrow(/позиція 8/);
  });

  it("ASCII, але не три частини → кидає про форму", () => {
    expect(() => assertUsableJwt("abc.def")).toThrow(/частин 2/);
  });

  it("три частини, але не JSON → кидає про розбір", () => {
    expect(() => assertUsableJwt("aaaa.bbbb.cccc")).toThrow(/не розбираються як JSON/);
  });

  /* ⚠️ Половина піна, без якої він не фальсифікується: гард має бути ВПАЯНИЙ
     у `userClient`. Лишиться він у файлі, але без виклику — тести були б
     зеленими, а прогін падав би як 11.09. */
  it("userClient справді кличе гард ДО createClient", () => {
    const src = readFileSync(resolve(process.cwd(), "scripts/race-check.mjs"), "utf8");
    const fn = src.slice(src.indexOf("function userClient"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("assertUsableJwt(jwt)");
    expect(body.indexOf("assertUsableJwt(jwt)")).toBeLessThan(body.indexOf("createClient("));
    /* ⚠️ Пінимо ПОВЕДІНКУ, а не фразу. Перша редакція цього тесту шукала
       рядок «не схоже на JWT» і почервоніла об ВЛАСНИЙ пояснювальний
       коментар, який ту фразу цитує. Ковтання — це `catch`, що лише друкує;
       його й перевіряємо. */
    expect(body.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/catch\s*\{\s*console\.log/);
  });
});

/* ------------------------------------------ с63: серія раундів замість пострілу */

describe("с63 — 22023 розрізняється за ТЕКСТОМ, а не лише за кодом", () => {
  /* ⚠️ Пін на ЗАМІРЯНИЙ факт: `add_case_step_rpc` піднімає 22023 у пʼяти
     місцях, і чотири з них — валідація входу ДО локів. */
  it("фрагмент тексту припнуто до заміряного", () => {
    expect(CASE_NOT_OPEN_MESSAGE).toBe("кейс не активний");
  });

  const add = (o: Record<string, unknown> = {}) => ({
    ok: true, entryId: "e-new", sqlstate: "", message: "",
    startedAt: 1000, finishedAt: 1080, ...o,
  });
  const cancel = (o: Record<string, unknown> = {}) => ({
    ok: true, cancelled: 2, sqlstate: "", message: "",
    startedAt: 1005, finishedAt: 1090, ...o,
  });
  const swept = { caseStatus: "cancelled", steps: [{ id: "e1", status: "cancelled" }] };

  /* ⚠️ ЦЕНТРАЛЬНИЙ ТЕСТ ПРАВКИ. «Крок без слота» — валідація входу, тобто
     ЗЛАМАНА ФІКСТУРА; до с63 вердикт зараховував її за програш у гонці й
     видавав PASS на прогоні, у якому гонки не було взагалі. */
  it("22023 від ВАЛІДАЦІЇ входу → FAIL, а не «програв скасуванню»", () => {
    const r = verdictCaseCancelRace(
      add({ ok: false, entryId: null, sqlstate: "22023", message: "BAD_INPUT: крок без слота" }),
      cancel(), swept);
    expect(r.verdict).toBe("FAIL");
    expect(r.reason).toMatch(/НЕ через скасування/);
  });

  it("22023 з ГОНОЧНИМ текстом → PASS", () => {
    const r = verdictCaseCancelRace(
      add({ ok: false, entryId: null, sqlstate: "22023",
            message: "BAD_INPUT: кейс не активний — крок додати не можна" }),
      cancel(), swept);
    expect(r.verdict).toBe("PASS");
  });

  /* ⚠️ `cancel_case_rpc` повертає row_count свого UPDATE. Нуль означає, що
     скасовувати не було чого — сцена розвалилась ДО гонки, і «заборонений
     стан не виник» тут не заслуга, а тавтологія. */
  it("скасування не зачепило жодного кроку → FAIL, а не PASS", () => {
    const r = verdictCaseCancelRace(add(), cancel({ cancelled: 0 }),
      { caseStatus: "cancelled", steps: [{ id: "e-new", status: "cancelled" }] });
    expect(r.verdict).toBe("FAIL");
    expect(r.reason).toMatch(/ЖОДНОГО кроку/);
  });
});

describe("verdictCaseRounds — серія, бо половина упорядкувань вакуумна", () => {
  const round = (addOk: boolean, v: string, spread = 5) => ({
    add: { ok: addOk },
    cancel: { cancelled: 2 },
    final: {},
    verdict: { verdict: v, reason: `раунд ${v}`, spread },
  });

  /* ⚠️ ГОЛОВНЕ ТВЕРДЖЕННЯ. Саме через це сценарій був заблокований у с62:
     коли `add` виграє лок, справний і зламаний код дають той самий результат,
     тож серія з самих таких раундів не перевірила НІЧОГО. */
  it("усі раунди у ВАКУУМНОМУ упорядкуванні → INCONCLUSIVE, а не PASS", () => {
    const r = verdictCaseRounds([round(true, "PASS"), round(true, "PASS"), round(true, "PASS")]);
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.reason).toMatch(/крок → скасування/);
  });

  it("хоч один раунд у ВИРІШАЛЬНОМУ упорядкуванні → PASS", () => {
    const r = verdictCaseRounds([round(true, "PASS"), round(false, "PASS"), round(true, "PASS")]);
    expect(r.verdict).toBe("PASS");
    expect(r.reason).toMatch(/1 у вирішальному/);
  });

  it("дефект у будь-якому раунді важливіший за статистику серії", () => {
    const r = verdictCaseRounds([round(false, "PASS"), round(true, "FAIL"), round(false, "PASS")]);
    expect(r.verdict).toBe("FAIL");
    expect(r.reason).toMatch(/прогін 2\/3/);
  });

  /* ⚠️ Раунд, у якому вікна не перетнулись, про упорядкування не свідчить —
     інакше «вирішальним» зарахувався б послідовний прогін. */
  it("раунди без доведеної одночасності не рахуються за вирішальні", () => {
    const r = verdictCaseRounds([round(false, "INCONCLUSIVE"), round(false, "INCONCLUSIVE")]);
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.reason).toMatch(/не довів одночасності/);
  });

  /* ⚠️ ПАКЕТ 62. Вирішальне упорядкування САМЕ ділиться навпіл, і PASS мусить
     це казати. Замір із прода: `add_case_step_rpc` бере `for update` і ЛИШЕ
     потім звіряє статус, тож «add чекав на локу» (доказ) і «скасування
     встигло закомітити до старту add» (вакуум) дають ОДНАКОВУ відмову 22023.
     Мовчазний PASS читався б як доведений гарант. */
  it("PASS називає вакуумну половину ВСЕРЕДИНІ вирішального упорядкування", () => {
    const r = verdictCaseRounds([round(false, "PASS"), round(false, "PASS"), round(true, "PASS")]);
    expect(r.verdict).toBe("PASS");
    expect(r.reason).toMatch(/ділиться навпіл/);
    expect(r.reason).toMatch(/не розрізняються/);
  });

  /* ⚠️ Один вирішальний прогін міг бути вакуумним цілком — спертись немає на
     що. Опора PASS тут статистична («щоб УСІ k були вакуумними…»), і при
     k = 1 її просто немає. Вердикт мусить розрізняти ці два випадки. */
  it("рівно ОДИН вирішальний прогін — PASS, але зі слабкістю названою вголос", () => {
    const r = verdictCaseRounds([round(false, "PASS"), round(true, "PASS")]);
    expect(r.verdict).toBe("PASS");
    expect(r.reason).toMatch(/ВИРІШАЛЬНИЙ ПРОГІН РІВНО ОДИН/);
    expect(r.reason).toMatch(/збільште --rounds/);
  });

  it("два і більше вирішальних — опора названа, попередження про єдиний зникає", () => {
    const r = verdictCaseRounds([round(false, "PASS"), round(false, "PASS")]);
    expect(r.verdict).toBe("PASS");
    expect(r.reason).not.toMatch(/ВИРІШАЛЬНИЙ ПРОГІН РІВНО ОДИН/);
    expect(r.reason).toMatch(/щоб усі 2 були вакуумними/);
  });

  it("порожня серія — гонки не було", () => {
    expect(verdictCaseRounds([]).verdict).toBe("FAIL");
  });
});

/* ── Сценарій `midnight`: перетин ЧЕРЕЗ МЕЖУ ДОБИ (пакет 56, с63) ──────────
   Гарант той самий, що в `run` — тригер `check_no_overlap` (0064). Нове тут
   ОДНЕ: у фікстур РІЗНА `scheduled_date`. Тригер порівнює абсолютні
   `tstzrange` на «настінному UTC» (0035) і меж доби не знає — але це
   твердження про КОД, і поза добою його ніколи не міряли, хоча продукт
   хвости через північ підтримує явно (`room_busy_slots` 0074 обрізає вікна по
   добі, а мʼяка пред-перевірка в `app/queue/actions.ts` спеціально бере
   сусідні доби ±1 — «інакше слот зелений, але незаписуваний»).

   ⚠️ ПІВ ФАЙЛА ТУТ — ПРО ВИРОДЖЕННЯ СЦЕНИ, і це не перестраховка. Урок с62/63
   (`case`): сценарій, у якому заборонений стан НЕ МІГ виникнути, дає «рівно
   одну удачу» і читається як PASS. Тому геометрія перевіряється вердиктом
   САМОСТІЙНО — з тих самих рядків дат і часів, — а не береться на віру від
   того, хто фікстури будував. */
describe("гонка через межу доби — вердикт відрізняє доказ від збігу", () => {
  /* ⚠️ Входи — ЛІТЕРАЛИ, а не константи модуля (правило 2 з с50, і рівно на
     цьому файлі воно вже було порушене для трьох сценаріїв). Подавши
     `OVERLAP_SQLSTATE` і на вхід, і в очікування, ми порівнювали б значення
     саме із собою: мутація константи лишила б набір зеленим. */
  const shot = (ok: boolean, sqlstate = "", startedAt = 0, finishedAt = 40) =>
    ({ id: `id-${startedAt}-${sqlstate}`, ok, sqlstate, message: "", startedAt, finishedAt });
  /* Заміряна геометрія: 23:50 + 25 хв = 00:15 доби D+1, ранній стартує о 00:00.
     Хвіст заходить на 15 хв, перетин реальний. */
  const scene = {
    dayLate: "2026-09-20", timeLate: "23:50",
    dayEarly: "2026-09-21", timeEarly: "00:00",
    occMin: 25,
  };

  it("константи часів лишились тими, під які рахована геометрія", () => {
    /* Пін на ЗАМІРЯНІ значення: зміна часу фікстури мовчки зробила б перетин
       нульовим, а сценарій — вакуумним. Тут же видно, що контрольний слот
       свідомо далеко від хвоста 00:15. */
    expect(MIDNIGHT_LATE_TIME).toBe("23:50");
    expect(MIDNIGHT_EARLY_TIME).toBe("00:00");
    expect(MIDNIGHT_CONTROL_TIME).toBe("03:00");
  });

  it("зайнятість фікстури справді заводить хвіст у наступну добу", () => {
    /* Без цього піна вся сцена трималась би на числах, які ніхто не звіряв із
       самою фікстурою: 23:50 + (20+5) = 00:15 доби D+1. */
    const lateMin = 23 * 60 + 50;
    expect(lateMin + FIXTURE_DUR_MIN + FIXTURE_BUF_MIN).toBeGreaterThan(1440);
  });

  it("рівно одна удача, невдаха 23P01 → PASS", () => {
    const r = verdictMidnightRace([shot(true, "", 0), shot(false, "23P01", 3)], scene);
    expect(r.verdict).toBe("PASS");
    expect(r.reason).toMatch(/ЧЕРЕЗ межу доби/);
  });

  it("обидва записались → FAIL: межа доби відкрила дірку в тригері", () => {
    const r = verdictMidnightRace([shot(true, "", 0), shot(true, "", 3)], scene);
    expect(r.verdict).toBe("FAIL");
    expect(r.reason).toMatch(/ПОДВІЙНЕ БРОНЮВАННЯ ЧЕРЕЗ ПІВНІЧ/);
  });

  it("невдаха впав не тим SQLSTATE → FAIL, а не PASS", () => {
    /* 23505 — це індекс 0018 (двоє в кабінеті), зовсім інший гарант. Зарахувати
       його за перемогу тригера 0064 означало б сказати неправду про те, що
       саме втримало гонку. */
    const r = verdictMidnightRace([shot(true, "", 0), shot(false, "23505", 3)], scene);
    expect(r.verdict).toBe("FAIL");
    expect(r.reason).toMatch(/НЕ через гонку/);
  });

  it("не записався ніхто → FAIL", () => {
    const r = verdictMidnightRace([shot(false, "23P01", 0), shot(false, "23P01", 3)], scene);
    expect(r.verdict).toBe("FAIL");
    expect(r.reason).toMatch(/слоти біля півночі/);
  });

  it("послідовний прогін НЕ дає PASS, хоча удача рівно одна", () => {
    const r = verdictMidnightRace(
      [shot(true, "", 0), shot(false, "23P01", 3000)], scene);
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.reason).toMatch(/одночасність не доведена/);
  });

  /* ── три гейти геометрії ─────────────────────────────────────────────── */

  it("обидві фікстури на ОДНУ добу → INCONCLUSIVE: це `run` під іншим іменем", () => {
    /* Найдешевший спосіб зробити сценарій вакуумним і не помітити: сплутати
       доби при побудові фікстур. Результат виглядав би бездоганним PASS. */
    const r = verdictMidnightRace([shot(true, "", 0), shot(false, "23P01", 3)],
      { ...scene, dayEarly: scene.dayLate });
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.reason).toMatch(/ОДНУ добу/);
  });

  it("доби не сусідні → INCONCLUSIVE, а не «дефект тригера»", () => {
    /* 23:50 доби D і 00:00 доби D+5 не перетнуться ніколи, тож «не записався
       НІХТО» тут означав би зламану сцену, а не дірку в гаранті. */
    const r = verdictMidnightRace([shot(false, "23P01", 0), shot(false, "23P01", 3)],
      { ...scene, dayEarly: "2026-09-25" });
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.reason).toMatch(/не сусідні/);
  });

  it("сусідство рахується по КАЛЕНДАРЮ — межа місяця не збиває", () => {
    /* Наївна арифметика по рядку («+1 до дня») зламалась би на 30 → 01. */
    const r = verdictMidnightRace([shot(true, "", 0), shot(false, "23P01", 3)],
      { ...scene, dayLate: "2026-09-30", dayEarly: "2026-10-01" });
    expect(r.verdict).toBe("PASS");
  });

  it("вікна не перетинаються → INCONCLUSIVE: забороненого стану не існує", () => {
    /* Зайнятість 5 хв: 23:50 закінчується рівно о 23:55, хвоста немає взагалі.
       Саме цю перевірку `case` не мав до с63, і сесія 62 заплатила за це
       хибним блокуванням сценарію. */
    const r = verdictMidnightRace([shot(true, "", 0), shot(false, "23P01", 3)],
      { ...scene, occMin: 5 });
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.reason).toMatch(/НЕ перетинаються/);
  });

  it("хвіст рівно ДО старту раннього — теж вироджена сцена", () => {
    /* 23:50 + 10 хв = рівно 00:00. `tstzrange` напіввідкритий, тож дотик кінця
       й початку перетином НЕ є — і тригер обидва записи пропустив би законно.
       Межа `<=`, а не `<`, саме тому. */
    const r = verdictMidnightRace([shot(true, "", 0), shot(false, "23P01", 3)],
      { ...scene, occMin: 10 });
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.reason).toMatch(/НЕ перетинаються/);
  });

  it("нечитані дати або часи → INCONCLUSIVE, а не мовчазний нуль", () => {
    /* `minOfDay`/`dayDiff` навмисно без дефолтів: «01» замість «01:00» мусить
       дати NaN і зупинити сцену, а не тихо стати північчю. */
    expect(verdictMidnightRace([shot(true, "", 0), shot(false, "23P01", 3)],
      { ...scene, dayEarly: "завтра" }).verdict).toBe("INCONCLUSIVE");
    expect(verdictMidnightRace([shot(true, "", 0), shot(false, "23P01", 3)],
      { ...scene, timeLate: "23-50" }).verdict).toBe("INCONCLUSIVE");
  });

  it("геометрія перевіряється ДО драбинки — зламана сцена не стає FAIL", () => {
    /* Порядок — частина правила. Якби гейти стояли після `verdictExclusive`,
       два переможці на одній добі дали б FAIL «подвійне бронювання через
       північ» — тобто звинувачення тригера в дефекті, якого ніхто не міряв. */
    const r = verdictMidnightRace([shot(true, "", 0), shot(true, "", 3)],
      { ...scene, dayEarly: scene.dayLate });
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.reason).not.toMatch(/ПОДВІЙНЕ/);
  });
});

/* ГАРД ДОСТАВКИ (пакет с65). Перший тест на цей гард узагалі: до с65 слово
   «webhook» не зустрічалось у цьому файлі ЖОДНОГО разу — заміряно пошуком,
   а сам гард жив у CLI `race-check.mjs`, половині харнеса, яку не покривали
   ні vitest, ні стенд (названа межа у шапці falsify-race-check.mjs).

   ⚠️ ВХОДИ — ЛІТЕРАЛИ, очікування — КОДИ вердикту. Урок с62 з цього ж файлу:
   подавати ту саму константу і на вхід, і в очікування означає порівнювати
   значення саме із собою, і мутація лишає набір зеленим. */
describe("гард доставки: гілок outbox дві, а не одна", () => {
  /* Факти подаються ЛІТЕРАЛАМИ; хелпер лише не дає забути поле, бо забуте
     поле — це NaN, і воно мусить давати `n8n_malformed`, а не мовчазний
     дозвіл (див. окремий тест нижче). */
  const facts = (o = {}) => ({ windowDays: 30, rows: 0, delivered: 0, deferred: 0, ...o });

  it("увімкнений вебхук клініки — відмова, і --allow-n8n її НЕ знімає", () => {
    /* Прапорець названий «n8n» і мусить знімати САМЕ n8n: вебхук клініки — це
       чужий партнер, а не наш приймач. */
    const r = deliveryGuardVerdict({
      enabledHooks: 1, n8n: facts({ rows: 5, deferred: 5 }), allowN8n: true,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("webhook_live");
  });

  it("нечитані вебхуки — відмова, і ні прапорець, ні «сценарій без n8n» її не знімають", () => {
    /* `enabledHooks: NaN` — це «запит впав», а не «нуль вебхуків»; мовчазний
       нуль тут був би fail-open рівно того класу, що `<>` проти NULL.
       ⚠️ Перша редакція пінила тільки `.code`, і тому мутація `ok: false →
       true` лишала набір зеленим (знахідка ревʼю А). Пінимо ОБОЄ, і ще
       порядок: сліпота на вебхуках важливіша за обидва послаблення. */
    const blind = deliveryGuardVerdict({ enabledHooks: Number.NaN, n8n: facts({ rows: 1, deferred: 1 }) });
    expect(blind.ok).toBe(false);
    expect(blind.code).toBe("hooks_unknown");
    expect(deliveryGuardVerdict({ enabledHooks: Number.NaN, n8n: null, allowN8n: true }).ok).toBe(false);
    expect(deliveryGuardVerdict({
      enabledHooks: Number.NaN, n8n: null, scenarioEmitsN8n: false,
    }).ok).toBe(false);
  });

  it("сценарій без n8n-подій — гілка не перевіряється, і це НЕ вакуум", () => {
    /* `run`/`room`/`cas`/`waitlist`/`midnight` пишуть лише `queue_entries`,
       звідки йдуть тільки `integration.*`. Відмовляти їм «за вакуумом» —
       вимкнути чотири робочі сценарії заради гілки, якої вони не торкаються
       (знахідка ревʼю Б). Вебхук клініки для них уже перевірено вище. */
    const r = deliveryGuardVerdict({ enabledHooks: 0, n8n: null, scenarioEmitsN8n: false });
    expect(r.ok).toBe(true);
    expect(r.code).toBe("n8n_not_in_play");
  });

  it("нечитаний event_outbox — відмова, і прапорець сліпоту не лікує", () => {
    expect(deliveryGuardVerdict({ enabledHooks: 0, n8n: null }).code).toBe("n8n_unknown");
    expect(deliveryGuardVerdict({ enabledHooks: 0, n8n: null, allowN8n: true }).ok).toBe(false);
  });

  it("доставлена подія n8n-гілки — відмова: транспорт ЖИВИЙ", () => {
    /* Саме цей випадок і був у проді 12.09.2026: пʼять `emergency_stop`, усі
       пʼять із `delivered_at`. Старий гард на цих самих фактах казав «чисто». */
    const r = deliveryGuardVerdict({ enabledHooks: 0, n8n: facts({ rows: 5, delivered: 5 }) });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("n8n_live");
  });

  it("ОДНІЄЇ доставленої достатньо — гард не рахує «більшість»", () => {
    const r = deliveryGuardVerdict({ enabledHooks: 0, n8n: facts({ rows: 40, delivered: 1, deferred: 39 }) });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("n8n_live");
  });

  it("мовчання доводиться ПОМІТКОЮ воркера, а не відсутністю доставок", () => {
    /* Єдиний випадок, коли гард пускає без прапорця: КОЖЕН недоставлений
       рядок вікна відкладено з поміткою «гілка не сконфігурована». */
    const r = deliveryGuardVerdict({ enabledHooks: 0, n8n: facts({ rows: 3, deferred: 3 }) });
    expect(r.ok).toBe(true);
    expect(r.code).toBe("n8n_silent");
  });

  it("недоставлені БЕЗ помітки — це не мовчання, а незʼясований стан", () => {
    /* ⚠️ Перша редакція вважала «доставлено 0» доказом мовчання. Але рядок
       без помітки — це або щойно емітований, або той, що падає помилкою
       транспорту, тобто при ЖИВОМУ URL (знахідка ревʼю А). */
    const r = deliveryGuardVerdict({ enabledHooks: 0, n8n: facts({ rows: 3, deferred: 2 }) });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("n8n_unclear");
  });

  it("жодної події у вікні — це «не знаю», а не «чисто»", () => {
    /* Невакуумність вбудована в сам вердикт (урок с63). Порожнє вікно — не
       доказ мовчання: перевіряти просто не було на чому. */
    const r = deliveryGuardVerdict({ enabledHooks: 0, n8n: facts() });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("n8n_vacuous");
  });

  it("зіпсуті факти — відмова, а не провал у фінальний дозвіл", () => {
    /* NaN не більший за нуль і не дорівнює нулю, тож без окремої перевірки всі
       ці входи дійшли б до останнього `return` і отримали дозвіл. */
    for (const bad of [
      {}, { rows: 5 }, { rows: -1, deferred: -1 }, { rows: 1, delivered: 3 }, { rows: 2, deferred: 3 },
    ]) {
      const r = deliveryGuardVerdict({ enabledHooks: 0, n8n: { windowDays: 30, ...bad } });
      expect(r.ok).toBe(false);
      expect(r.code).toBe("n8n_malformed");
    }
  });

  it("--allow-n8n знімає живу гілку, вакуум і незʼясований стан — і тільки їх", () => {
    expect(deliveryGuardVerdict({
      enabledHooks: 0, n8n: facts({ rows: 9, delivered: 9 }), allowN8n: true,
    }).code).toBe("n8n_allowed");
    expect(deliveryGuardVerdict({ enabledHooks: 0, n8n: facts(), allowN8n: true }).code).toBe("n8n_allowed");
    expect(deliveryGuardVerdict({
      enabledHooks: 0, n8n: facts({ rows: 4, deferred: 1 }), allowN8n: true,
    }).code).toBe("n8n_allowed");
    /* А зіпсуті факти прапорець НЕ знімає: знімати перевірку можна свідомо,
       рахувати по сміттю — ні. */
    expect(deliveryGuardVerdict({ enabledHooks: 0, n8n: { windowDays: 30 }, allowN8n: true }).ok).toBe(false);
  });

  it("кожна відмова називає ВИХІД, а порада про змінну оточення — чесна", () => {
    /* ⚠️ Перша редакція радила «зніміть N8N_WEBHOOK_URL і запустіть знову».
       Порада не працює: вердикт читає ІСТОРІЮ, і доставлений рядок лишається
       у вікні (знахідка ревʼю Б). Оператор зняв би змінну в проді, отримав
       той самий текст і вирішив, що гард зламаний. */
    const live = deliveryGuardVerdict({ enabledHooks: 0, n8n: facts({ rows: 2, delivered: 2, lastDeliveredAt: "2026-09-11T15:28:03Z" }) });
    expect(live.message).toMatch(/2026-09-11/);
    expect(live.message).toMatch(/НЕ змінить/);
    for (const r of [
      live,
      deliveryGuardVerdict({ enabledHooks: 0, n8n: facts() }),
      deliveryGuardVerdict({ enabledHooks: 0, n8n: facts({ rows: 3, deferred: 1 }) }),
    ]) expect(r.message).toMatch(/--allow-n8n/);
    expect(deliveryGuardVerdict({ enabledHooks: 1, n8n: facts({ rows: 1, deferred: 1 }) }).message)
      .toMatch(/Вимкніть вебхук/);
  });

  it("вікно доказу дорівнює горизонту прибирання доставлених із 0159", () => {
    /* ⚠️ Пін читає МІГРАЦІЮ, а не літерал у тесті (знахідка обох ревʼю).
       Ширше вікно не додає ЖОДНОГО доказу живості — доставлені старші за
       горизонт уже видалені, — зате додає недоставлених, яких ретенція не
       чіпає ніколи, і тим посуває вердикт у бік дозволу. */
    const sql = readFileSync(resolve(process.cwd(), "supabase/migrations/0159_outbox_retention.sql"), "utf8");
    const m = sql.match(/p_delivered_days\s+integer\s+default\s+(\d+)/);
    expect(Number(m?.[1])).toBe(N8N_EVIDENCE_WINDOW_DAYS);
  });

  it("дзеркало префікса збігається з контрактом lib/integrationContract.ts", () => {
    /* Пін не тавтологічний: значення читається з ІНШОГО файлу. Розійдуться —
       гард рахуватиме не ту гілку й мовчки подобрішає. */
    const src = readFileSync(resolve(process.cwd(), "lib/integrationContract.ts"), "utf8");
    const m = src.match(/INTEGRATION_EVENT_PREFIX\s*=\s*"([^"]+)"/);
    expect(m?.[1]).toBe(INTEGRATION_PREFIX_MIRROR);
  });

  it("дзеркало помітки відкладання збігається з lib/outbox.ts", () => {
    /* Помітка — єдиний позитивний доказ мовчання. Перейменують її у воркері —
       `deferred` стане нулем, і кожен прогін почне впиратись у n8n_unclear. */
    const src = readFileSync(resolve(process.cwd(), "lib/outbox.ts"), "utf8");
    const m = src.match(/deferRows\(deferredN8nIds,[^,]+,\s*"([^"]+)"\)/);
    expect(m?.[1]).toBe(N8N_DEFER_NOTE);
  });

  it("`stop` НЕ в списку сценаріїв без n8n — інакше гард знімається сам собою", () => {
    expect(N8N_FREE_COMMANDS).not.toContain("stop");
    expect(N8N_FREE_COMMANDS).toEqual(["run", "room", "cas", "waitlist", "midnight"]);
  });

  it("гард ВПАЯНИЙ у main — і список сценаріїв береться з константи, а не з літерала", () => {
    /* ⚠️ Половина піна, без якої він не фальсифікується (той самий прийом, що
       для гарда токена вище): вердикт лишиться під тестами й стендом, а
       виклик зникне — і набір буде зеленим, поки фікстури їдуть назовні. */
    const src = readFileSync(resolve(process.cwd(), "scripts/race-check.mjs"), "utf8");
    const main = src.slice(src.indexOf("async function main()"));
    expect(main).toContain("assertNoLiveDelivery(db, room.clinic_id, {");
    expect(main.indexOf("assertNoLiveDelivery(")).toBeLessThan(main.indexOf("findSlots("));
    expect(main).toMatch(/scenarioEmitsN8n:\s*!N8N_FREE_COMMANDS\.includes\(cmd\)/);
  });
});
