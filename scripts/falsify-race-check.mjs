// ============================================================
//  Стенд фальсифікації вердиктів харнеса конкурентності (с62).
//
//  Головне питання: чи почервоніє сторож, якщо ВИМКНУТИ гарант мовчки.
//
//  ⚠️ ЧОМУ ЦЕЙ СТЕНД ЗʼЯВИВСЯ ТІЛЬКИ ЗАРАЗ — і чому це діра, а не педантизм.
//  `race-check-lib.mjs` живе з с32, `tests/raceCheck.test.ts` — з с38, а
//  стенда на них не було ЖОДНОГО. При тому шапка самого спека каже: «вердикт —
//  єдине, що відрізняє доказ від збігу». Тобто найдорожчий файл харнеса не мав
//  перевірки на те, що його власні тести хоч щось тримають.
//
//  ⚠️ ОСОБЛИВІСТЬ СЦЕНАРІЮ `waitlist`, заради якого стенд і написаний:
//  його гарант — не тригер і не індекс, а УМОВНИЙ UPDATE у тілі
//  `schedule_from_waitlist_rpc`. 23P01 і 23505 породжує двигун; 55000 тут
//  піднято РУКАМИ після `row_count = 0`. Отже гарант можна зняти, не отримавши
//  ЖОДНОЇ помилки БД — лише двох переможців. Мутація M2 — рівно це.
//
//  ⚠️ НАЗВАНА МЕЖА ЦЬОГО СТЕНДА (знахідка ревʼю Б, с62): він мутує ЛИШЕ
//  `race-check-lib.mjs`. Половина харнеса — CLI `race-check.mjs` — не покрита
//  ні цим стендом, ні vitest: рішення «вердикт → код виходу», гейт контролю,
//  форма `Promise.all`, дочитування звʼязку. Мутація `code = 0` там лишиться
//  зеленою скрізь. Частину діри закриває гейт `windowsOverlap` у самому
//  вердикті (M11): переписаний на послідовний `for … await` клієнт більше не
//  дає PASS. Решта — відкритий борг, і краще назвати його тут, ніж лишити
//  читача з враженням, що стенд покриває харнес цілком.
//
//  ⚠️ Правлю БОЙОВИЙ файл → try/finally + обробники сигналів.
//  ⚠️ Кожен якір перевіряється на УНІКАЛЬНІСТЬ.
//
//  Запуск: node scripts/falsify-race-check.mjs   Звіт: falsify-race-check.md
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { verdictOf, finishStand } from "./lib/falsify-verdict.mjs";

const FILES = {
  lib: "scripts/race-check-lib.mjs",
};
const NEW_SPEC = "tests/raceCheck.test.ts";
const SPECS = [NEW_SPEC];
const OUT = "falsify-race-check.md";
const REPORT = ".falsify-race-check.json";

const MUTATIONS = [
  {
    /* ⚠️ Ця мутація вже спрацювала як треба: у ПЕРШОМУ прогоні вона лишила
       набір ЗЕЛЕНИМ і показала, що тести подавали ту саму константу і на
       вхід, і в очікування. Дефект тестів виправлено (пін констант + літерали
       на вході), і сторож тепер називається саме піном. */
    id: "M1", file: "lib", green: false,
    expect: /55000 WAITLIST_STALE зі schedule_from_waitlist_rpc/,
    what: "сценарій листа чекає SQLSTATE слота (23P01) замість свого 55000",
    from: 'export const WAITLIST_STALE_SQLSTATE = "55000";',
    to: 'export const WAITLIST_STALE_SQLSTATE = "23P01";',
  },
  {
    /* ⚠️ ЦЕ ГОЛОВНА МУТАЦІЯ СТЕНДА. Саме так виглядає знята умова
       `and status = 'waiting'` у RPC: жодної помилки, просто два переможці. */
    id: "M2", file: "lib", green: false,
    expect: /ДВОЄ записали одного кандидата → FAIL/,
    what: "драбинка перестала вважати ДВОХ переможців дефектом",
    /* ⚠️ ЯКІР ШИРШИЙ, НІЖ ХОЧЕТЬСЯ, і це не стиль. `if (wins.length > 1) {`
       у файлі ДВА рази — у спільній драбинці `verdictExclusive` і в
       `verdictCas`; перший прогін стенда це й показав («ЯКІР НЕ УНІКАЛЬНИЙ
       (2)»). Беремо разом із наступним рядком, який у цих двох місцях
       різний. */
    from: "  if (wins.length > 1) {\n    return {\n      verdict: \"FAIL\", spread,\n      reason: `${doubleWin}",
    to: "  if (wins.length > 2) {\n    return {\n      verdict: \"FAIL\", spread,\n      reason: `${doubleWin}",
  },
  {
    id: "M3", file: "lib", green: false,
    expect: /невдаха впав на 42501/,
    what: "«кандидата немає» (42501) зараховано як програш у гонці",
    from: "    sqlstate: WAITLIST_STALE_SQLSTATE,\n    guard: \"CAS-застовплення в schedule_from_waitlist_rpc\",",
    to: "    sqlstate: WAITLIST_NOT_FOUND_SQLSTATE,\n    guard: \"CAS-застовплення в schedule_from_waitlist_rpc\",",
  },
  {
    id: "M4", file: "lib", green: false,
    expect: /не записав ніхто \(23P01 у обох\) → FAIL/,
    what: "нуль переможців більше не FAIL — непридатна фікстура зійде за доказ",
    from: "  if (wins.length === 0) {\n    return {\n      verdict: \"FAIL\", spread,\n      reason: `${noWin}",
    to: "  if (wins.length === -1) {\n    return {\n      verdict: \"FAIL\", spread,\n      reason: `${noWin}",
  },
  {
    /* ⚠️ `expect` НЕСЕ ІМʼЯ DESCRIBE (знахідка ревʼю Б, с62). «розкид 3 с»
       зустрічається в ТРЬОХ тестах файлу, і два з них матчились попередньою
       регуляркою. Оцінка йде через `redInNew.some(...)`, тож мутація
       зараховувалась би ✅, навіть якби тест сценарію листа видалили. */
    id: "M5", file: "lib", green: false,
    expect: /verdictWaitlistRace.*розкид 3 с\) → INCONCLUSIVE/,
    what: "поріг одночасності роздутий у 100 разів — послідовний прогін стане PASS",
    from: "  if (spread > spreadLimitMs) {\n    return {\n      verdict: \"INCONCLUSIVE\", spread,\n      reason: `розкид стартів ${spread} мс > ${spreadLimitMs} мс — одночасність не доведена`,\n    };\n  }\n  return {\n    verdict: \"PASS\", spread,\n    reason: `1 удача з ${outcomes.length}",
    to: "  if (spread > spreadLimitMs * 100) {\n    return {\n      verdict: \"INCONCLUSIVE\", spread,\n      reason: `розкид стартів ${spread} мс > ${spreadLimitMs} мс — одночасність не доведена`,\n    };\n  }\n  return {\n    verdict: \"PASS\", spread,\n    reason: `1 удача з ${outcomes.length}",
  },
  {
    id: "M6", file: "lib", green: false,
    expect: /рядок листа несе modality/,
    what: "фікстура листа втратила modality — прогін упав би на 23514 як «гонка зламалась»",
    from: "    studies: [study],\n    modality,\n    duration_min: FIXTURE_DUR_MIN, buffer_time_min: FIXTURE_BUF_MIN,\n  };\n}",
    to: "    studies: [study],\n    duration_min: FIXTURE_DUR_MIN, buffer_time_min: FIXTURE_BUF_MIN,\n  };\n}",
  },
  {
    id: "M7", file: "lib", green: false,
    expect: /рядок листа НЕ задає status/,
    what: "харнес продублював дефолт БД (status: 'waiting')",
    from: "    studies: [study],\n    modality,",
    to: "    studies: [study],\n    status: \"waiting\",\n    modality,",
  },
  {
    id: "M8", file: "lib", green: false,
    expect: /рядок листа НЕ привʼязує кабінет/,
    what: "кандидату привʼязали кабінет — у сценарій заліз другий гарант",
    from: "    modality,\n    duration_min: FIXTURE_DUR_MIN, buffer_time_min: FIXTURE_BUF_MIN,\n  };\n}",
    to: "    modality,\n    room_id: null,\n    duration_min: FIXTURE_DUR_MIN, buffer_time_min: FIXTURE_BUF_MIN,\n  };\n}",
  },
  {
    /* ⚠️ ЯКІР ПЕРЕПИСАНО (с62). Він починався з `studies: [study],` і став
       НЕУНІКАЛЬНИМ, щойно поруч зʼявився `buildCaseStep` із таким самим
       хвостом. Стенд це й показав — «ЯКІР НЕ УНІКАЛЬНИЙ (2)». Тепер якір
       починається з рядка, який є ЛИШЕ в `buildWaitlistBooking`. */
    id: "M9", file: "lib", green: false,
    expect: /p_booking несе всі NOT NULL-поля/,
    what: "з p_booking зникла duration_min — вставка впала б на NOT NULL",
    from: "    patient_phone: FIXTURE_PHONE,\n    studies: [study],\n    duration_min: FIXTURE_DUR_MIN,\n    buffer_time_min: FIXTURE_BUF_MIN,\n    scheduled_date: day,",
    to: "    patient_phone: FIXTURE_PHONE,\n    studies: [study],\n    buffer_time_min: FIXTURE_BUF_MIN,\n    scheduled_date: day,",
  },
  {
    /* `scheduled_time` у БД — text-колонка без касту, тож зайві секунди
       доїхали б у рядок як є і зламали б формат мовчки. */
    id: "M10", file: "lib", green: false,
    expect: /p_booking несе всі NOT NULL-поля/,
    what: "у scheduled_time додано секунди — text-колонка проковтне й зіпсує формат",
    from: "    buffer_time_min: FIXTURE_BUF_MIN,\n    scheduled_date: day,\n    scheduled_time: time,\n  };\n}\n\n/** Рядок КЕЙСА",
    to: "    buffer_time_min: FIXTURE_BUF_MIN,\n    scheduled_date: day,\n    scheduled_time: `${time}:00`,\n  };\n}\n\n/** Рядок КЕЙСА",
  },
  {
    /* Гейт перетину вікон — єдиний свідок того, що КОРИСТУВАЦЬКИЙ клієнт
       стріляв паралельно. Знявши його, послідовний прогін дав би PASS. */
    id: "M11", file: "lib", green: false,
    expect: /вікна НЕ перетнулись → INCONCLUSIVE/,
    what: "знято гейт перетину вікон у сценарії листа",
    from: '  if (base.verdict === "PASS" && !windowsOverlap(outcomes)) {',
    to: '  if (false && base.verdict === "PASS" && !windowsOverlap(outcomes)) {',
  },
  {
    /* Гейт мусить стояти ПІСЛЯ драбинки, а не замість неї: подвійний запис —
       доведений дефект і лишається FAIL навіть без перетину вікон. */
    id: "M12", file: "lib", green: false,
    expect: /ДВОЄ переможців без перетину вікон — усе одно FAIL/,
    what: "гейт перетину вікон переїхав поперед перевірки на подвійного переможця",
    from: '  if (base.verdict === "PASS" && !windowsOverlap(outcomes)) {',
    to: '  if (!windowsOverlap(outcomes)) {',
  },
  {
    /* ⚠️ ГОЛОВНА МУТАЦІЯ СЦЕНАРІЮ «КЕЙС». Заборонений стан — кейс `cancelled`
       з живим кроком — це ЄДИНЕ, заради чого сценарій існує. Знявши гілку,
       отримуємо PASS на стані, який у проді означає скасований кейс із
       пацієнтом, що досі стоїть у сітці кабінету. */
    id: "M13", file: "lib", green: false,
    expect: /кейс cancelled із АКТИВНИМ кроком → FAIL/,
    what: "вердикт кейса перестав вважати «cancelled + активний крок» дефектом",
    from: '  if (final.caseStatus === "cancelled" && active.length) {',
    to: '  if (false && final.caseStatus === "cancelled" && active.length) {',
  },
  {
    /* Список активних статусів — дзеркало ТРЬОХ місць у БД. Викинувши один,
       робимо вердикт мʼякшим за базу: крок у цьому статусі БД вважає живим,
       а харнес — уже ні. */
    id: "M14", file: "lib", green: false,
    expect: /активні статуси кроку — рівно ті чотири/,
    what: "зі списку активних статусів кроку зник needs_reschedule",
    from: 'export const CASE_ACTIVE_STATUSES = ["scheduled", "waiting", "in_progress", "needs_reschedule"];',
    to: 'export const CASE_ACTIVE_STATUSES = ["scheduled", "waiting", "in_progress"];',
  },
  {
    /* Другий бік того самого дефекту: крок, доданий пострілом, лишився живим,
       але статус кейса до `cancelled` не дійшов — за id це ще ловиться. */
    id: "M15", file: "lib", green: false,
    expect: /доданий крок лишився активним при кейсі open → FAIL за id/,
    what: "перевірка «доданий крок зметено» знята",
    from: "    if (mine && CASE_ACTIVE_STATUSES.includes(mine.status)) {",
    to: "    if (false && mine && CASE_ACTIVE_STATUSES.includes(mine.status)) {",
  },
  {
    /* Відмова кроку ЧУЖИМ кодом означає, що перевіряли не те, що обіцяли:
       23505 — «кабінет уже в кейсі», тобто зламана постановка, а не гонка. */
    id: "M16", file: "lib", green: false,
    expect: /крок відмовлено ЧУЖИМ кодом \(23505\) → FAIL/,
    what: "будь-яка відмова кроку зараховується як «через скасування»",
    /* ⚠️ ЯКІР ОНОВЛЕНО В с63: умова стала ДВОРЯДКОВОЮ (додався текстовий
       дискримінатор), і старий однорядковий якір протух би мовчки — рівно той
       клас, заради якого в ревізії є колонка «протухлих якорів». Мутуємо ВСЮ
       умову: вимкнувши лише половину, ми лишили б другу тримати сторожа, і
       позиція показала б «не тримає» там, де вона просто неповна. */
    from: "  } else if (add.sqlstate !== CASE_NOT_OPEN_SQLSTATE\n"
        + "             || !String(add.message).includes(CASE_NOT_OPEN_MESSAGE)) {",
    to: "  } else if (false) {",
  },
  /* ------------------------------- сценарій «кейс»: розблокування (с63) */
  {
    /* ⚠️ ГОЛОВНА МУТАЦІЯ РОЗБЛОКУВАННЯ. Без текстового дискримінатора вердикт
       зараховує за «програш у гонці» будь-яку з ЧОТИРЬОХ валідацій входу —
       тобто видає PASS на прогоні, де гонки не було зовсім. */
    id: "M24", file: "lib", green: false,
    expect: /22023 від ВАЛІДАЦІЇ входу → FAIL/,
    what: "22023 знову зараховується без перевірки тексту",
    from: "             || !String(add.message).includes(CASE_NOT_OPEN_MESSAGE)) {",
    to: "             || (false && !String(add.message).includes(CASE_NOT_OPEN_MESSAGE))) {",
  },
  {
    id: "M25", file: "lib", green: false,
    expect: /скасування не зачепило жодного кроку → FAIL/,
    what: "порожнє скасування більше не дефект — «заборонений стан не виник» по порожньому кейсу",
    from: "  if (cancel.cancelled != null && cancel.cancelled < 1) {",
    to: "  if (false && cancel.cancelled != null && cancel.cancelled < 1) {",
  },
  {
    /* ⚠️ Рівно те, через що сценарій стояв заблокованим: серія з самих
       вакуумних упорядкувань знову давала б PASS. */
    id: "M26", file: "lib", green: false,
    expect: /усі раунди у ВАКУУМНОМУ упорядкуванні → INCONCLUSIVE/,
    what: "вимога «хоч один вирішальний раунд» знята",
    from: "  if (!decisive.length) {",
    to: "  if (false && !decisive.length) {",
  },
  {
    id: "M27", file: "lib", green: false,
    expect: /раунди без доведеної одночасності не рахуються за вирішальні/,
    what: "у вирішальні зараховуються раунди, які не довели одночасності",
    from: "  const good = rounds.filter((r) => r.verdict.verdict === \"PASS\");",
    to: "  const good = rounds;",
  },
  {
    id: "M28", file: "lib", green: false,
    expect: /дефект у будь-якому раунді важливіший за статистику серії/,
    what: "червоний раунд тоне в статистиці серії",
    from: "  const bad = rounds.findIndex((r) => r.verdict.verdict === \"FAIL\");",
    to: "  const bad = rounds.findIndex((r) => false && r.verdict.verdict === \"FAIL\");",
  },
  /* ---------------------------------------- сценарій «аварійна зупинка» (с63) */
  {
    /* ⚠️ ГОЛОВНА МУТАЦІЯ СЦЕНАРІЮ. 40P01 — ЄДИНИЙ спостережуваний наслідок
       зламаної дисципліни порядку локів; знявши цей гейт, ми отримаємо
       PASS на прогоні, який щойно спіймав дедлок у проді. */
    id: "M17", file: "lib", green: false,
    expect: /40P01 хоч в одного → FAIL з назвою учасника/,
    what: "дедлок більше не вважається дефектом",
    from: "  const dead = all.filter((o) => o.sqlstate === DEADLOCK_SQLSTATE);",
    to: "  const dead = all.filter((o) => false && o.sqlstate === DEADLOCK_SQLSTATE);",
  },
  {
    id: "M18", file: "lib", green: false,
    expect: /ОБИДВІ зупинки заявили той самий кабінет/,
    what: "подвійна зупинка одного кабінету більше не дефект",
    from: "  const twice = [...claims].filter(([, who]) => who.length > 1);",
    to: "  const twice = [...claims].filter(([, who]) => who.length > 2);",
  },
  {
    /* Найкоштовніший гейт після дедлока: без нього вердикт судить за
       ВІДПОВІДЯМИ RPC, а інваріант 0017 — про РЯДКИ в таблиці. */
    id: "M19", file: "lib", green: false,
    expect: /в базі ДВА активні інциденти → FAIL/,
    what: "стан у базі більше не перевіряється — судимо за відповідями RPC",
    from: "  const wrongDb = rooms.filter((r) => activeByRoom[r] !== 1);",
    to: "  const wrongDb = rooms.filter((r) => false && activeByRoom[r] !== 1);",
  },
  {
    /* ⚠️ Саме цей гейт лишився ЄДИНИМ доказом конкуренції після того, як
       «слід зіткнення» визнано порожнім. Знявши його, сценарій починає
       видавати PASS за послідовний прогін. */
    id: "M20", file: "lib", green: false,
    expect: /послідовний прогін із «слідами зіткнення» → INCONCLUSIVE/,
    what: "перетин вікон більше не потрібен — послідовний прогін дає PASS",
    from: "  if (!windowsOverlap(all)) {",
    to: "  if (false && !windowsOverlap(all)) {",
  },
  {
    id: "M21", file: "lib", green: false,
    expect: /невдахи фінішували РАНІШЕ за переможця → INCONCLUSIVE/,
    what: "слід чекання на локу більше не вимагається",
    from: "  if (empty.length && early.length === empty.length) {",
    to: "  if (false && empty.length && early.length === empty.length) {",
  },
  {
    id: "M22", file: "lib", green: false,
    expect: /«поломка» впала ЧУЖИМ кодом \(42501\) → FAIL/,
    what: "будь-яка відмова «поломки» зараховується як програш індексу 0017",
    from: "  if (!breakdown.ok && breakdown.sqlstate !== INCIDENT_TAKEN_SQLSTATE) {",
    to: "  if (false && !breakdown.ok && breakdown.sqlstate !== INCIDENT_TAKEN_SQLSTATE) {",
  },
  {
    /* Повернення до першої редакції: `claims.get(r)?.push(…)` мовчки ковтав
       кабінет, якого не просили. */
    id: "M23", file: "lib", green: false,
    expect: /зупинено кабінет, якого НЕ просили → FAIL/,
    what: "кабінет поза набором мовчки випадає з підрахунку",
    from: "    else strangers.push(`${who}→${r}`);",
    to: "    else if (false) strangers.push(`${who}→${r}`);",
  },
  /* ⚠️ РЕФАКТОРНІ КОНТРОЛІ. Без них «усе червоніє» неможливо відрізнити від
     «сторож надчутливий»: спек, який червоніє на будь-яку правку, не сторож,
     а сигналізація на вітер. */
  {
    id: "T1", file: "lib", green: true,
    what: "переставлено порядок полів у p_booking (семантика та сама)",
    from: "    scheduled_date: day,\n    scheduled_time: time,\n  };\n}\n\n/** Рядок КЕЙСА",
    to: "    scheduled_time: time,\n    scheduled_date: day,\n  };\n}\n\n/** Рядок КЕЙСА",
  },
  {
    id: "T2", file: "lib", green: true,
    what: "змінено суфікс імені пацієнта в p_booking (тексту спек не пінить)",
    from: 'patient_name: `${FIXTURE_NAME} лист-запис`,',
    to: 'patient_name: `${FIXTURE_NAME} запис-з-листа`,',
  },
  {
    /* Порядок учасників у зведеному масиві семантично байдужий:
       `startSpreadMs` бере min/max, `windowsOverlap` сортує сам. Якщо ця
       перестановка щось червонить — сторожі тримаються за порядок масиву,
       а не за інваріант. */
    id: "T3", file: "lib", green: true,
    what: "переставлено порядок учасників у зведеному масиві аварійної зупинки",
    from: "  const all = [...stops, breakdown, ...(canceller ? [canceller] : [])];",
    to: "  const all = [breakdown, ...(canceller ? [canceller] : []), ...stops];",
  },
  /* ---------------------------------------- сценарій «північ» (пакет 56, с63)
     ⚠️ ЧОТИРИ З ПʼЯТИ ПОЗИЦІЙ ТУТ — ПРО ВИРОДЖЕННЯ СЦЕНИ, а не про драбинку.
     Драбинка (`verdictExclusive`) спільна і вже застережена M2…M11; нове в
     цьому сценарії рівно одне — ГЕОМЕТРІЯ через межу доби, і саме її можна
     зламати так, що вердикт лишиться бездоганно зеленим. */
  {
    /* ГОЛОВНА мутація сценарію: доби перестають перевірятись, і `midnight`
       тихо стає `run` — той самий тригер, та сама доба, PASS на кожному
       прогоні. Ніхто б не помітив роками. */
    id: "M29", file: "lib", green: false,
    expect: /обидві фікстури на ОДНУ добу/,
    what: "гейт «доби РІЗНІ» знято — сценарій вироджується в `run`",
    from: "  if (diff === 0) {",
    to: "  if (false && diff === 0) {",
  },
  {
    id: "M30", file: "lib", green: false,
    expect: /доби не сусідні/,
    what: "гейт сусідства діб знято — 23:50 доби D проти 00:00 доби D+5",
    from: "  if (diff !== 1) {",
    to: "  if (false && diff !== 1) {",
  },
  {
    /* Найтихіша з усіх: перетину немає, заборонений стан не існує, «рівно одна
       удача» — чистий збіг. Рівно цього гейта бракувало сценарію `case`. */
    id: "M31", file: "lib", green: false,
    expect: /вікна не перетинаються → INCONCLUSIVE/,
    what: "перевірку реального перетину вікон знято",
    from: "  if (tail <= earlyStart) {",
    to: "  if (false && tail <= earlyStart) {",
  },
  {
    /* Межа `<=` проти `<`: `tstzrange` напіввідкритий, тож дотик кінця й
       початку перетином НЕ є. З `<` сцена «23:50 + 10 хв проти 00:00»
       вважалась би придатною, а тригер законно пропустив би обох. */
    id: "M32", file: "lib", green: false,
    expect: /хвіст рівно ДО старту раннього/,
    what: "дотик вікон зараховано за перетин (`<` замість `<=`)",
    from: "  if (tail <= earlyStart) {",
    to: "  if (tail < earlyStart) {",
  },
  {
    /* Гейти геометрії мусять стояти ПЕРЕД драбинкою. Перенісши їх після, ми
       перетворили б зламану сцену на обвинувачення тригера. */
    id: "M33", file: "lib", green: false,
    expect: /геометрія перевіряється ДО драбинки/,
    what: "гейти геометрії знято цілком — зламана сцена стає FAIL",
    from: "  const diff = dayDiff(dayLate, dayEarly);",
    to: "  const diff = 1;",
  },
  {
    /* Часи фікстур — ЗАМІРЯНІ значення, під які рахована вся геометрія
       (23:50 + 25 хв = 00:15 доби D+1). Зсунувши будь-який із трьох, можна
       тихо зробити перетин нульовим; пін мусить це ловити. Мутуємо
       КОНТРОЛЬНИЙ слот — той, що в самій гонці не бере участі: якщо навіть
       він не запінений, то й решта двох трималась би на випадковості. */
    id: "M34", file: "lib", green: false,
    expect: /константи часів лишились тими, під які рахована геометрія/,
    what: "контрольний слот доби D+1 посунуто 03:00 → 04:00",
    from: 'export const MIDNIGHT_CONTROL_TIME = "03:00";',
    to: 'export const MIDNIGHT_CONTROL_TIME = "04:00";',
  },
  {
    /* ⚠️ Найдешевший спосіб мовчки ослабити ВСІ пʼять наявних сценаріїв: один
       символ у дефолті. `off_schedule = true` вимикає гілку «робота після
       закриття» в `check_room_schedule` (0084) — денні фікстури від цього
       нічого не помітять, бо вони й так у графіку, і сторожа не буде. */
    id: "M35", file: "lib", green: false,
    expect: /off_schedule за замовчуванням ВИМКНЕНО/,
    what: "off_schedule став дефолтом фікстури — графік перестає стерегти всі сценарії",
    from: "study, offSchedule = false }) {",
    to: "study, offSchedule = true }) {",
  },
  /* ---- пакет 61 (с63): режим `stop --with-case`, послаблення 40P01 ------- */
  {
    /* Найдорожча з усіх: послаблення протікає в ДЕФОЛТ. Тоді звичайний прогін
       `stop` перестає називати 40P01 дефектом — тобто проєкт мовчки втрачає
       ЄДИНЕ місце, де дедлок узагалі видно (продукт його ковтає підказкою
       «спробуйте ще раз»). */
    id: "M36", file: "lib",
    expect: /старий сторож недоторканий/,
    what: "caseLinked став дефолтом — послаблення протекло у звичайний прогін",
    from: "                                       caseLinked = false } = {}) {",
    to: "                                       caseLinked = true } = {}) {",
  },
  {
    id: "M37", file: "lib",
    expect: /з назвою ОГОЛОШЕНОГО вікна/,
    what: "гілку «оголошене вікно» знято — caseLinked + 40P01 знову FAIL",
    from: "    if (caseLinked) {\n      return {\n        verdict: \"INCONCLUSIVE\", spread,",
    to: "    if (false && caseLinked) {\n      return {\n        verdict: \"INCONCLUSIVE\", spread,",
  },
  {
    /* Без четвертого пострілу інверсії порядку немає ЗА ПОБУДОВОЮ. Зняти цей
       кидок означає дозволити терпимість до 40P01 у сцені, де він був би
       справжнім дефектом дисципліни. */
    id: "M38", file: "lib",
    expect: /КИДАЄ, а не послаблює мовчки/,
    what: "кидок «caseLinked без canceller» знято — терпимість без підстави",
    from: "  if (caseLinked && !canceller) {",
    to: "  if (false && caseLinked && !canceller) {",
  },
  {
    /* Четвертий постріл — УЧАСНИК. Викинувши його з `all`, ми перестаємо
       бачити і його 40P01, і його старт у розкиді: сцена, де скасування
       пішло на секунду пізніше, виглядала б одночасною. */
    id: "M39", file: "lib",
    expect: /старт скасування входить у розкид/,
    what: "скасування прибрано зі списку учасників — його таймінг не рахується",
    from: "  const all = [...stops, breakdown, ...(canceller ? [canceller] : [])];",
    to: "  const all = [...stops, breakdown];",
  },
  {
    id: "M40", file: "lib",
    expect: /четвертого учасника не було/,
    what: "гейт відмови скасування знято — сцена без четвертого учасника стає зеленою",
    from: "  if (canceller && !canceller.ok) {",
    to: "  if (false && canceller && !canceller.ok) {",
  },
  {
    /* PASS у caseLinked мусить казати, що вікно ЛИШЕ не відкрилось. Мовчазний
       PASS читався б як «вікна немає» — а воно заміряне з тіла RPC. */
    id: "M41", file: "lib",
    expect: /вікно ЛИШЕ не відкрилось/,
    what: "приписку до PASS у caseLinked знято — PASS читається як «вікна немає»",
    from: "      + (caseLinked\n        ? \". Сцена БУЛА зі звʼязкою кейса",
    to: "      + (false && caseLinked\n        ? \". Сцена БУЛА зі звʼязкою кейса",
  },
  {
    /* Уся терпимість спирається на те, що ПРОДУКТ вважає 40P01 транзієнтом.
       Звузивши список у харнесі, ми розійшлися б із `isRetryableLockError`
       мовчки — і пін мусить це ловити. */
    id: "M42", file: "lib",
    expect: /57014 — і в харнесі, і в продукті/,
    what: "зі списку транзієнтних локових SQLSTATE прибрано 57014",
    from: 'export const RETRYABLE_LOCK_SQLSTATES = ["40P01", "40001", "55P03", "57014"];',
    to: 'export const RETRYABLE_LOCK_SQLSTATES = ["40P01", "40001", "55P03"];',
  },
  {
    /* Правка живого прогону 11.09: гард форми токена мусить ЗУПИНЯТИ, а не
       друкувати діагноз. Знявши кидок, ми повертаємо рівно ту поведінку, що
       поклала прогін — сирий ByteString за двісті рядків. */
    id: "M43", file: "lib",
    expect: /кидає ІЗ НАЗВОЮ причини/,
    what: "перевірку не-ASCII у токені знято — кирилиця знову доїде до fetch",
    from: "  if (badAt >= 0) {",
    to: "  if (false && badAt >= 0) {",
  },
  {
    /* Позиція символу — єдине, що робить повідомлення дієвим: без неї
       «десь не-ASCII» у 700-символьному рядку нічого не дає. */
    id: "M44", file: "lib",
    expect: /позиція поганого символу названа/,
    what: "позицію поганого символу прибрано з повідомлення",
    from: "містить не-ASCII символ (позиція ${badAt})",
    to: "містить не-ASCII символ (десь у рядку)",
  },
  {
    /* Порожня змінна і зіпсутий токен — РІЗНІ діагнози; злиття їх посилає
       шукати не там. */
    id: "M45", file: "lib",
    expect: /окреме повідомлення/,
    what: "гілку «порожня змінна» знято — порожній токен падає як «не JWT»",
    from: "  if (!t) {\n    throw new Error(\"RADFLOW_USER_JWT порожній",
    to: "  if (false && !t) {\n    throw new Error(\"RADFLOW_USER_JWT порожній",
  },
  {
    /* РЕФАКТОРНИЙ КОНТРОЛЬ: два оголошення часів помінялись місцями. Порядок
       констант — не інваріант; якщо це щось червонить, сторожі тримаються за
       текст файла, а не за значення. */
    id: "T4", file: "lib", green: true,
    what: "оголошення MIDNIGHT_LATE_TIME і MIDNIGHT_EARLY_TIME помінялись місцями",
    from: 'export const MIDNIGHT_LATE_TIME = "23:50";\nexport const MIDNIGHT_EARLY_TIME = "00:00";',
    to: 'export const MIDNIGHT_EARLY_TIME = "00:00";\nexport const MIDNIGHT_LATE_TIME = "23:50";',
  },
];

/* ⚠️ Кожна мутація, яка МУСИТЬ почервоніти, називає ТЕСТ-СТОРОЖА. Без цього
   вердикт спирався б на «набір червоний», байдуже який тест — а в цьому спеку
   81 тест про ШІСТЬ різних сценаріїв, і зачепити сусіда тут дуже легко. */
for (const m of MUTATIONS) {
  const bad =
    (!m.green && !m.expect) ? "мутація мусить червоніти, але не називає сторожа (`expect`)"
    : (m.green && m.expect) ? "`expect` у рядку, який МУСИТЬ лишитись зеленим — сторожа тут не буває"
    /* Вертикальна риска зламала б markdown-таблицю, а її розбирає `verdictOf`. */
    : (m.expect && /\|/.test(m.expect.source)) ? "у регулярці `|` — вона зламає таблицю звіту"
    : null;
  if (bad) {
    console.error(`⛔ ІНВЕНТАР БРЕШЕ: ${m.id} — ${bad}. Стенд НЕ прогнано.`);
    process.exit(1);
  }
}

/* ⚠️ ПІН НА КІЛЬКІСТЬ АДРЕСНИХ ПОЗИЦІЙ. Правило вище ВИМАГАЄ прибрати `expect`
   у рядка з `green: true` — а отже саме воно й дає найдешевший спосіб погасити
   червону позицію: перевести її в зелені і зняти сторожа. Мутація при цьому
   далі застосовується, набір лишається зеленим, рядок друкує ✅, слідів немає.
   Тому кількість адресних — константа. */
const EXPECTED_RED = 45;   // +M17..M23 зупинка, +M24..M28 розблокування «кейса» (с63), +M29..M35 «північ» (пакет 56), +M36..M42 `stop --with-case` (пакет 61), +M43..M45 гард токена (правка живого прогону 11.09)
const redCount = MUTATIONS.filter((m) => !m.green).length;
if (redCount !== EXPECTED_RED) {
  console.error(`⛔ ІНВЕНТАР БРЕШЕ: адресних мутацій ${redCount}, а очікується ${EXPECTED_RED}. `
    + "Якщо позицію знято свідомо — поправте EXPECTED_RED разом із нею. Стенд НЕ прогнано.");
  process.exit(1);
}

/* ⚠️ ЗАМОК. ЗАПЛАЧЕНО ПОМИЛКОЮ В с63, і вона варта окремого абзацу.

   Стенд працює тим, що ПИШЕ мутацію в БОЙОВИЙ файл і повертає оригінал
   назад. Поки він біжить, файл на диску — не той, що в редакторі. У с63 я
   правив `race-check-lib.mjs` рівно тоді, коли стенд крутив по ньому свої
   мутації: `orig` було знято з уже мутованої копії, і `restore()` чесно
   повернув… мутацію T3 (`[breakdown, ...stops]`). Вона пролізла б у коміт —
   цього разу нешкідлива саме тому, що T3 і задумана як рефакторний контроль.
   Наступного разу пощастило б менше: те саме сталося б із будь-якою M-мутацією,
   тобто в проді опинився б вердикт зі знятим гардом, а стенд рапортував би ✅.

   Слід був один-єдиний — рядок «ЯКІР НЕ УНІКАЛЬНИЙ» у T3. Тобто аварія
   виявлялась випадково.

   Замок не вміє зупинити редактор — але робить стан ВИДИМИМ: поки файл
   лежить, файли мутуються, і другий стенд не стартує поверх першого.
   Плюс друкуємо md5 до і після: розбіжність означає, що під час прогону
   у файл писав хтось іще. */
const LOCK = ".falsify-race-check.lock";
if (existsSync(LOCK)) {
  console.error(`⛔ ${LOCK} існує — стенд уже біжить (або впав, не прибравши замок).`);
  console.error("   Поки він біжить, файли МУТОВАНІ: не редагуйте їх і не запускайте другий стенд.");
  console.error(`   Якщо попередній прогін точно мертвий: перевірте \`git diff\` і видаліть ${LOCK}.`);
  process.exit(2);
}

const orig = {};
const md5 = (s) => createHash("md5").update(s).digest("hex").slice(0, 12);
for (const [k, p] of Object.entries(FILES)) orig[k] = readFileSync(p, "utf8");
writeFileSync(LOCK, `${process.pid} ${new Date().toISOString()}\n`
  + Object.entries(FILES).map(([k, p]) => `${k} ${p} ${md5(orig[k])}`).join("\n") + "\n");

let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  for (const [k, p] of Object.entries(FILES)) writeFileSync(p, orig[k]);
  if (existsSync(LOCK)) unlinkSync(LOCK);
}
process.on("SIGINT", () => { restore(); process.exit(130); });
process.on("SIGTERM", () => { restore(); process.exit(143); });
process.on("uncaughtException", (e) => { restore(); console.error(e); process.exit(2); });

function run() {
  if (existsSync(REPORT)) unlinkSync(REPORT);
  spawnSync("npx", ["vitest", "run", ...SPECS, "--reporter=json", `--outputFile.json=${REPORT}`],
    { shell: true, stdio: "ignore" });
  if (!existsSync(REPORT)) return { crashed: true, ok: false, red: [], redInNew: [], all: [] };
  let r;
  try { r = JSON.parse(readFileSync(REPORT, "utf8")); }
  catch { return { crashed: true, ok: false, red: [], redInNew: [], all: [] }; }
  const red = [], redInNew = [], all = [];
  for (const f of r.testResults || []) {
    const isNew = String(f.name || "").replace(/\\/g, "/").endsWith(NEW_SPEC);
    for (const a of f.assertionResults || []) {
      /* Повний перелік імен потрібен, щоб відрізнити «спіймав чужий сторож» від
         «сторожа з таким іменем узагалі немає» (тобто опечатки в стенді). */
      if (isNew) all.push(a.fullName || a.title);
      if (a.status === "passed") continue;
      const n = a.fullName || a.title;
      red.push(n);
      if (isNew) redInNew.push(n);
    }
  }
  return { crashed: false, ok: r.success === true && red.length === 0, red, redInNew, all, total: r.numTotalTests };
}

const lines = [];
let addressedOk = 0;
/* Файли, які змінилися під нами ПОСЕРЕД прогону (див. блок «ЗАМОК» вище). */
const driftSeen = [];
try {
  const base = run();
  lines.push(`# Стенд фальсифікації вердиктів харнеса конкурентності (с62)\n`);
  lines.push(`**БАЗОВА ЛІНІЯ:** ${base.ok ? "ЗЕЛЕНА" : "ЧЕРВОНА"} (${base.total} тестів)\n`);
  if (!base.ok) {
    lines.push(`\n⛔ Базова лінія червона — стенд НІЧОГО не доводить. Червоні: ${base.red.join(", ")}\n`);
  } else {
    lines.push(`\n| # | мутація | очікування | факт | вердикт |`);
    lines.push(`|---|---|---|---|---|`);
    for (const m of MUTATIONS) {
      const path = FILES[m.file];
      const src = readFileSync(path, "utf8");
      /* ⚠️ ДРЕЙФ ЛОВИМО САМЕ ТУТ. `src` читається наново на кожній мутації,
         тож розбіжність із `orig` означає, що між ітераціями у файл писав
         хтось іще (редактор, друга сесія). Далі стенд працює вже з ЧУЖИМ
         кодом, а після себе відновить `orig` — тобто чужу правку затре, а
         власну мутацію може лишити. Це і сталося в с63. */
      if (md5(src) !== md5(orig[m.file]) && !driftSeen.includes(m.file)) {
        driftSeen.push(m.file);
      }
      const edits = m.edits ?? [{ from: m.from, to: m.to }];
      let mutated = src, bad = "";
      for (const e of edits) {
        const n = mutated.split(e.from).length - 1;
        if (n !== 1) { bad = `ЯКІР НЕ УНІКАЛЬНИЙ (${n}): ${e.from.slice(0, 40)}…`; break; }
        mutated = mutated.replace(e.from, () => e.to);
      }
      if (bad) { lines.push(`| ${m.id} | ${m.what} | — | ${bad} | ⛔ відхилено |`); continue; }
      writeFileSync(path, mutated);
      const res = run();
      writeFileSync(path, src);
      const wantRed = !m.green;
      if (res.crashed) {
        lines.push(`| ${m.id} | ${m.what} | ${wantRed ? "ЧЕРВОНЕ" : "ЗЕЛЕНЕ"} | прогін не відбувся | ⛔ мутація зламала збірку |`);
        continue;
      }
      const gotRed = !res.ok;
      const fact = gotRed ? res.redInNew.map((t) => `«${t}»`).join("; ") : "усе зелене";
      const missed = wantRed && gotRed && !res.redInNew.some((t) => m.expect.test(t));
      /* Дві РІЗНІ причини одного «не збіглось»: або сторож існує, але спіймав
         його інший тест, або тесту з таким іменем у наборі НЕМАЄ ВЗАГАЛІ —
         це дефект стенда, а не продукту. */
      const noSuchGuard = missed && !res.all.some((t) => m.expect.test(t));
      const verdict = noSuchGuard ? "⛔ СТОРОЖА З ТАКИМ ІМЕНЕМ НЕМАЄ (дефект стенда)"
        : missed ? "⛔ ЧУЖИЙ спек"
        : (wantRed === gotRed ? "✅" : "⛔ СТОРОЖ НЕ ТРИМАЄ");
      if (verdict === "✅" && wantRed) addressedOk++;
      const want = wantRed ? `ЧЕРВОНЕ: ${m.expect.source}` : "ЗЕЛЕНЕ";
      lines.push(`| ${m.id} | ${m.what} | ${want} | ${fact} | ${verdict} |`);
    }
  }
} finally {
  restore();
  /* ⚠️ ЗВІРЯТИ ФАЙЛ ПІСЛЯ `restore()` — БЕЗГЛУЗДО, і перша редакція цього
     блоку саме це й робила: порівнювала md5 з тим, що сама щойно записала.
     Такий «сторож» зелений завжди. Дрейф ловиться ТАМ, ДЕ ВІН ВИДИМИЙ —
     усередині циклу мутацій, де файл читається наново (`driftSeen`). */
  if (driftSeen.length) {
    lines.push(`\n⛔ ФАЙЛ ЗМІНЮВАВСЯ ПІД ЧАС ПРОГОНУ (${driftSeen.join(", ")}). `
      + "У нього писав хтось паралельно — перевірте `git diff`: у дереві може "
      + "лишитись чужа мутація, а результати вище знято з іншого коду.");
  }
  if (existsSync(REPORT)) unlinkSync(REPORT);
  const verdict = verdictOf(lines, MUTATIONS.length);
  lines.push(`\n${verdict.summary}`);
  lines.push(`\n## ПІДСУМОК: ${addressedOk}/${EXPECTED_RED} адресних, ${MUTATIONS.length - EXPECTED_RED} рефакторних`);
  writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log(`\nЗвіт: ${OUT}. Файли відновлено.`);
  /* ⚠️ ДРЕЙФ ВАЛИТЬ СТЕНД, а не «згадується в звіті». Прогін, під час якого
     файл змінювався, знято з коду, якого вже немає — його ✅ нічого не
     доводить, а мовчазне «зелено» тут дорожче за будь-яку мутацію. */
  finishStand({
    ok: verdict.ok === true && driftSeen.length === 0,
    red: "\n⛔ ВЕРДИКТ: СТЕНД ЧЕРВОНИЙ — причина в таблиці вище.",
  });
}
