/* Вердикти харнеса гонки (scripts/race-check-lib.mjs), беклог №1.

   Навіщо тест на скрипт, який і так «просто друкує». Вердикт — єдине, що
   відрізняє доказ від збігу: PASS, виданий за INCONCLUSIVE, закриє хвіст с32
   брехнею, а наступна сесія повірить хендоффу (урок с37: три хвости були
   описані невірно й нікого не насторожили). */

import { describe, expect, it } from "vitest";
import {
  verdictSlotRace, verdictControl, verdictInProgressRace, verdictCas,
  verdictWaitlistRace,
  clinicDay, startSpreadMs, windowsOverlap,
  buildFixture, buildWaitlistFixture, buildWaitlistBooking,
  OVERLAP_SQLSTATE, IN_PROGRESS_SQLSTATE, FIXTURE_NAME, CAS_TO,
  WAITLIST_STALE_SQLSTATE, WAITLIST_NOT_FOUND_SQLSTATE,
  FIXTURE_DUR_MIN, FIXTURE_BUF_MIN,
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
});
