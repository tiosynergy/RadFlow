/* RadFlow — харнес живої конкурентності: чиста логіка (беклог №1, хвіст с32).
   CLI — race-check.mjs. Розділення lib+CLI — щоб вердикт можна було ганяти
   під vitest без БД: саме вердикт легко зіпсувати непомітно.

   ЩО ПЕРЕВІРЯЄМО. Гарант неперетину слотів живе в тригері `check_no_overlap`
   (0064): він бере `pg_advisory_xact_lock(hashtextextended(room_id))` ДО
   перевірки перетину, а сама функція plpgsql VOLATILE — отже в READ COMMITTED
   її внутрішній `exists` бере СВІЖИЙ знімок і мусить побачити щойно
   закомічений рядок суперника. Це теорія; харнес доводить її живим прогоном.

   ЧОМУ НЕ vitest НА ВЕСЬ ПАКЕТ. Потрібні РЕАЛЬНІ паралельні транзакції в
   живій БД. Мок довів би рівно те, що ми самі й запрограмували.

   ЧОМУ РІВЕНЬ PostgREST, А НЕ HTTP-ФОРМА. `createBooking` робить дорадчий
   `hasSlotClash` ОКРЕМОЮ транзакцією (під гонкою він пройде в обох), а далі
   одиночний `insert`. Власної серіалізації прикладний шар не додає —
   авторитетний рубіж саме тригери. Тому результат на рівні PostgREST
   переноситься на застосунок. Це прочитано в коді, а не припущено.

   ⚠️ ПИШЕ В ПРОД (dev і prod — одна БД). Тому: усі id генеруються НА КЛІЄНТІ
   до пострілу, прибирання йде за ЯВНИМ списком id (правило с14 — ніяких
   «усе, що підходить під критерій»), а без `--run` скрипт не пише нічого. */

/** Ім'я-маркер фікстур. За ним працює аварійне прибирання `--cleanup`. */
export const FIXTURE_NAME = "ТЕСТ Гонка с38";
/** Телефон фікстури: свідомо нереальний, щоб не сплутати з пацієнтом. */
export const FIXTURE_PHONE = "+380000000038";

/** Розкид стартів запитів, вище якого «одночасність» більше НЕ доведена.
    Без цієї межі «рівно одна удача» нічого не варта: послідовний прогін дає
    той самий результат. Урок с37 (пастки вимірювання) — не приймати збіг
    очікуваного за доказ механізму.

    ⚠️ ЩО САМЕ ловить цей сторож, а що — ні. `startedAt` пишеться ДО `await`,
    тобто всі постріли одного `Promise.all` стартують в ОДНОМУ тіку і розкид
    майже завжди ≈0. Отже поріг ловить рівно один (але реальний) клас
    регресії: перепис `Promise.all` на послідовний `for … await`, після якого
    «гонка» перестала б бути гонкою, а вердикт лишився б зеленим.
    ДОКАЗ справжньої паралельності дає інше — `windowsOverlap` у контрольному
    сценарії (вікна запитів реально перетинаються) плюс спостережуваний факт:
    той, хто програв, чекає на advisory-локу, тож його тривалість ≈ тривалості
    переможця, а не «відмовили одразу». */
export const START_SPREAD_LIMIT_MS = 250;

/** SQLSTATE, яким тригер 0064 відмовляє тому, хто програв гонку за слот. */
export const OVERLAP_SQLSTATE = "23P01";

/** SQLSTATE, яким унікальний частковий індекс `queue_one_in_progress_per_room`
    (0018) відмовляє другому пацієнту в тому самому кабінеті. Це саме
    unique_violation, а не check: інваріант тримає індекс, а не тригер. */
export const IN_PROGRESS_SQLSTATE = "23505";

/** Статуси сценарію CAS: з чого і в що переводимо фікстуру. Перехід
    scheduled → waiting свідомо найбезпечніший — він нічого не займає в
    кабінеті й дозволений усім ролям персоналу (на відміну від in_progress). */
export const CAS_FROM = "scheduled";
export const CAS_TO = "waiting";

/** SQLSTATE, яким `schedule_from_waitlist_rpc` відмовляє тому, хто програв
    гонку за КАНДИДАТА листа очікування.

    ⚠️ Гарант тут — НЕ тригер і НЕ індекс, а УМОВНИЙ UPDATE усередині самої
    RPC: `set status='scheduled' where id=… and status='waiting'`. Той, хто
    прийшов другим, чекає на рядковому блокуванні, після коміту переможця
    бачить уже `'scheduled'`, отримує `row_count = 0` і піднімає це виключення
    РУКАМИ. Тобто на відміну від 23P01/23505 його не породжує двигун — його
    написали в тілі, і саме тому мутація «прибрати умову `status='waiting'`»
    зробила б сценарій зеленим із ДВОМА переможцями. Це головне, що тут
    стережеться. */
export const WAITLIST_STALE_SQLSTATE = "55000";

/** SQLSTATE, яким `add_case_step_rpc` відмовляє, коли кейс уже НЕ `open`.

    ⚠️ Гарант тут — той самий клас, що в листі очікування: перевірка стоїть
    ПІСЛЯ `select … for update` на рядку кейса, і саме лок робить її чесною.
    Перенести перевірку ПЕРЕД лок — і вона читатиме знімок ДО коміту
    скасування: крок ляже в уже скасований кейс, `case_recompute_status` для
    нього не перерахується, і в проді залишиться кейс `cancelled` з АКТИВНИМ
    кроком. Жодної помилки БД при цьому не буде. Це і є заборонений стан. */
export const CASE_NOT_OPEN_SQLSTATE = "22023";

/** Статуси кроку, які `check_case_distinct_room`, `check_case_no_time_overlap`
    і `case_recompute_status` вважають АКТИВНИМИ (звірено з тілами в проді
    10.09.2026). Список тут один на всі три місця: розійшовшись, він зробив би
    вердикт «заборонений стан» м'якшим за саму БД. */
export const CASE_ACTIVE_STATUSES = ["scheduled", "waiting", "in_progress", "needs_reschedule"];

/** SQLSTATE тієї ж RPC, коли кандидата немає в ЦЬОМУ центрі. У вердикті
    гонки він означає не «інший оператор випередив», а зламану фікстуру —
    і `verdictExclusive` покаже це окремим рядком «впали НЕ через гонку». */
export const WAITLIST_NOT_FOUND_SQLSTATE = "42501";

/** Тривалість і буфер фікстури: 20+5 = 25 хв зайнятості.
    Кандидати слотів рознесені на годину (див. TIMES у CLI), тож вікна
    зайнятості контрольного сценарію не перетинаються за побудовою. */
export const FIXTURE_DUR_MIN = 20;
export const FIXTURE_BUF_MIN = 5;

/** Склад дослідження мусить проходити `check_studies_match_room` (0088) і
    `check_studies_active_catalog`: тип ↔ модальність кабінету, позиція —
    у ЧИННОМУ каталозі. Тому склад не константа, а будується з каталогу.

    ⚠️ ДЗЕРКАЛО SQL-функції `study_type_modality` (single source в БД).
    Звірено з `pg_get_functiondef` у с38. Розійдеться — харнес почне падати
    на 23514 (MODALITY_MISMATCH) і виглядатиме як «гонка зламалась»,
    хоча зламався мапінг. `OTHER` свідомо відсутній: для нього тригер
    інваріант не застосовує, і кабінет «Інше» слот-гонку не показує. */
export const MODALITY_STUDY_TYPE = {
  MRI: "МРТ",
  CT: "КТ",
  US: "УЗД",
  XRAY: "Рентген",
  MAMMO: "Мамографія",
};

/** @typedef {{ ok: boolean, sqlstate: string, message: string,
 *              startedAt: number, finishedAt: number, id: string }} Outcome */

/** Дата у форматі YYYY-MM-DD за КАЛЕНДАРЕМ центру, зсунута на offsetDays.

    ⚠️ Арифметика йде по КАЛЕНДАРЮ, а не по мілісекундах. Наївне
    `now + offsetDays*86400000` з подальшим форматуванням у зоні центру
    з'їжджає на добу, якщо у вікні стався перехід DST, а локальний час
    близький до півночі: доба переходу не 24 години. Тому спершу беремо
    СЬОГОДНІШНЮ дату центру, далі рахуємо в UTC (де DST не існує взагалі)
    і повертаємо назад. Той самий клас помилки, що закривав `lib/fhirTime.ts`. */
export function clinicDay(tz, offsetDays, now = new Date()) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const [y, m, d] = today.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + offsetDays * 86400000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** Рядок фікстури. `id` приходить ЗЗОВНІ (згенерований до пострілу) — саме
    він потім є явним списком для прибирання. */
export function buildFixture({ id, clinicId, roomId, day, time, label, study }) {
  const studies = [study];
  return {
    id, clinic_id: clinicId, room_id: roomId,
    patient_name: `${FIXTURE_NAME} ${label}`,
    patient_phone: FIXTURE_PHONE,
    studies, studies_original: studies,
    duration_min: FIXTURE_DUR_MIN, buffer_time_min: FIXTURE_BUF_MIN,
    scheduled_date: day, scheduled_time: time,
    status: "scheduled", call_status: "not_called",
  };
}

/** Рядок ЛИСТА ОЧІКУВАННЯ для сценарію `waitlist`.

    ⚠️ `modality` тут ОБОВʼЯЗКОВА і мусить збігатися з типом кожної позиції
    складу: `check_waitlist_consistency` (0103) звіряє `study_type_modality(type)`
    з колонкою і кидає 23514 `WAITLIST_MODALITY_MISMATCH`. Взяти модальність
    із кабінету — не «зручність», а єдиний спосіб не розійтися з тим самим
    мапінгом, що вже живе в `MODALITY_STUDY_TYPE`.

    ⚠️ `room_id` НЕ ставимо, і це рішення. Гард `guard_waitlist_room` вимагає
    кабінет СВОГО центру, а `check_waitlist_consistency` — ще й збіг
    модальності; обидва ми б задовольнили. Але жорстко привʼязаний кабінет
    звужує те, що ми перевіряємо: гонка йде за КАНДИДАТА, а не за кабінет,
    і зайва привʼязка додала б у сценарій другий гарант, який тут не при
    справах. Кабінет приходить у `p_booking` кроком запису.

    ⚠️ `status` НЕ задаємо: дефолт `'waiting'` — саме той стан, який CAS у
    `schedule_from_waitlist_rpc` і застовплює. Написати його руками означало б
    продублювати дефолт БД у харнесі й не помітити, якщо його колись змінять. */
export function buildWaitlistFixture({ id, clinicId, modality, study, label }) {
  return {
    id, clinic_id: clinicId,
    patient_name: `${FIXTURE_NAME} ${label}`,
    patient_phone: FIXTURE_PHONE,
    studies: [study],
    modality,
    duration_min: FIXTURE_DUR_MIN, buffer_time_min: FIXTURE_BUF_MIN,
  };
}

/** `p_booking` для `schedule_from_waitlist_rpc`.

    ⚠️ Ключі — рівно ті, які читає тіло RPC (звірено з `pg_get_functiondef`
    10.09.2026). `scheduled_time` там **text**-колонка і кладеться без касту,
    тож формат «HH:MM» тримається саме тут; `studies` іде і в `studies`, і в
    `studies_original` — це робить сама RPC, дублювати не треба. */
export function buildWaitlistBooking({ roomId, day, time, study }) {
  return {
    room_id: roomId,
    patient_name: `${FIXTURE_NAME} лист-запис`,
    patient_phone: FIXTURE_PHONE,
    studies: [study],
    duration_min: FIXTURE_DUR_MIN,
    buffer_time_min: FIXTURE_BUF_MIN,
    scheduled_date: day,
    scheduled_time: time,
  };
}

/** Рядок КЕЙСА для сценарію `case`. `status` не задаємо — дефолт БД `'open'`,
    і саме його перевіряє `add_case_step_rpc` під локом. */
export function buildCaseFixture({ id, clinicId, label }) {
  return {
    id, clinic_id: clinicId,
    patient_name: `${FIXTURE_NAME} ${label}`,
    patient_phone: FIXTURE_PHONE,
  };
}

/** `p_step` для `add_case_step_rpc`.

    ⚠️ Ключі — рівно ті, які тіло RPC перевіряє ДО взяття локів
    (`room_id`, непорожній масив `studies`, `duration_min`, `scheduled_date`,
    `scheduled_time`); звірено з `pg_get_functiondef` 10.09.2026. Пропустивши
    будь-який, ми отримали б `22023 BAD_INPUT` — той самий SQLSTATE, що й
    «кейс не активний», і вердикт зарахував би зламану фікстуру за коректну
    відмову. Саме тому склад тут будується, а не пишеться в місці виклику. */
export function buildCaseStep({ roomId, day, time, study }) {
  return {
    room_id: roomId,
    studies: [study],
    duration_min: FIXTURE_DUR_MIN,
    buffer_time_min: FIXTURE_BUF_MIN,
    scheduled_date: day,
    scheduled_time: time,
  };
}

/** Розкид стартів пострілів. Якщо він великий — запити пішли НЕ одночасно,
    і будь-який «правильний» результат нічого не доводить. */
export function startSpreadMs(outcomes) {
  if (!outcomes.length) return 0;
  const starts = outcomes.map((o) => o.startedAt);
  return Math.max(...starts) - Math.min(...starts);
}

/** Чи перетинаються вікна [startedAt, finishedAt] хоч у якоїсь пари.
    Доказ того, що клієнт справді стріляє паралельно, а не по черзі. */
export function windowsOverlap(outcomes) {
  const sorted = [...outcomes].sort((a, b) => a.startedAt - b.startedAt);
  return sorted.some((o, i) => i > 0 && o.startedAt < sorted[i - 1].finishedAt);
}

/** Спільне ядро вердикту «взаємне виключення»: рівно один переможець, решта
    відмовлені САМЕ тим гардом, який ми стережемо.

    Три різні присуди, і плутати їх не можна:
    - PASS         — рівно одна удача, решта відмовлені саме цим гардом;
    - FAIL         — доведений дефект (двоє пройшли / не пройшов ніхто /
                     невдаха впав не через гонку);
    - INCONCLUSIVE — прогін нічого не довів (запити пішли не одночасно).
      Це НЕ «майже PASS»: послідовний прогін теж дає «рівно одну удачу»,
      тому без доведеної одночасності PASS був би самообманом.

    Ядро винесене в с42, коли додався другий сценарій (гонка за кабінет).
    Дві копії цієї драбинки розійшлись би при першій же правці — а саме вона
    відрізняє доказ від збігу. */
function verdictExclusive(outcomes, { sqlstate, guard, doubleWin, noWin, spreadLimitMs }) {
  const wins = outcomes.filter((o) => o.ok);
  const losses = outcomes.filter((o) => !o.ok);
  const spread = startSpreadMs(outcomes);

  if (outcomes.length < 2) {
    return { verdict: "FAIL", reason: `учасників ${outcomes.length}, гонки не було`, spread };
  }
  if (wins.length > 1) {
    return {
      verdict: "FAIL", spread,
      reason: `${doubleWin}: удач ${wins.length} — ${guard} гонку не втримав`,
      ids: wins.map((o) => o.id),
    };
  }
  if (wins.length === 0) {
    return {
      verdict: "FAIL", spread,
      reason: `${noWin} (${losses.map((o) => o.sqlstate).join(", ")})`,
    };
  }

  const wrong = losses.filter((o) => o.sqlstate !== sqlstate);
  if (wrong.length) {
    return {
      verdict: "FAIL", spread,
      reason: `невдахи впали НЕ через гонку: ${wrong.map((o) => `${o.sqlstate}(${o.message.slice(0, 60)})`).join("; ")}`,
    };
  }
  // Одночасність перевіряємо ОСТАННЬОЮ: якщо вище знайдено дефект, він
  // реальний незалежно від того, довели ми одночасність чи ні.
  if (spread > spreadLimitMs) {
    return {
      verdict: "INCONCLUSIVE", spread,
      reason: `розкид стартів ${spread} мс > ${spreadLimitMs} мс — одночасність не доведена`,
    };
  }
  return {
    verdict: "PASS", spread,
    reason: `1 удача з ${outcomes.length}, решта — ${sqlstate} від ${guard}`,
    ids: wins.map((o) => o.id),
  };
}

/** Вердикт гонки за СЛОТ (двоє пишуться в один час одного кабінету). */
export function verdictSlotRace(outcomes, { spreadLimitMs = START_SPREAD_LIMIT_MS } = {}) {
  return verdictExclusive(outcomes, {
    sqlstate: OVERLAP_SQLSTATE,
    guard: "тригера 0064",
    doubleWin: "ПОДВІЙНЕ БРОНЮВАННЯ",
    noWin: "не записався НІХТО — слот або фікстура непридатні",
    spreadLimitMs,
  });
}

/** Вердикт гонки за КАБІНЕТ: двох пацієнтів одночасно заводять у той самий
    кабінет (`status → in_progress`). Фізичний інваріант «в кабінеті один
    пацієнт» тримає УНІКАЛЬНИЙ ЧАСТКОВИЙ ІНДЕКС `queue_one_in_progress_per_room`
    (0018), а не тригер: другий чекає на індексі, поки перший комітить, і
    падає 23505. Саме тому сценарій має сенс на рівні таблиці — тут гарант
    той самий, що в проді. */
export function verdictInProgressRace(outcomes, { spreadLimitMs = START_SPREAD_LIMIT_MS } = {}) {
  return verdictExclusive(outcomes, {
    sqlstate: IN_PROGRESS_SQLSTATE,
    guard: "унікального індексу 0018",
    doubleWin: "ДВОЄ В ОДНОМУ КАБІНЕТІ",
    noWin: "у кабінет не зайшов НІХТО — фікстура непридатна",
    spreadLimitMs,
  });
}

/** Вердикт гонки за КАНДИДАТА листа очікування: N паралельних
    `schedule_from_waitlist_rpc` на ОДНОМУ `p_waitlist_id`.

    ⚠️ ЧОМУ ЦЕ ТА САМА ДРАБИНКА, ЩО Й СЛОТ/КАБІНЕТ, а не форма CAS. Тут
    невдаха отримує саме ВИНЯТОК (`55000`), а не «`updated=false`»: RPC
    повертає `uuid`, тож сказати «не вийшло» їй нічим, крім `raise`. Отже
    `ok` мапиться один-в-один і `verdictExclusive` підходить без натяжки.

    ⚠️ ЩО СТЕРЕЖЕ САМЕ ЦЕЙ ВЕРДИКТ, а що — ні. Він доводить взаємне виключення
    ЗАСТОВПЛЕННЯ (крок 1 RPC). Він НЕ доводить, що переможець дійсно створив
    запис черги: вставка (крок 2) може впасти на booking-тригері й відкотити
    застовплення разом із собою. Тоді переможців буде нуль, а невдахи впадуть
    із чужим SQLSTATE — і драбинка скаже це вголос («впали НЕ через гонку»),
    а не видасть за успіх. Перевірку «звʼязок проставлено» робить CLI окремо,
    бо це вже не про конкурентність. */
export function verdictWaitlistRace(outcomes, { spreadLimitMs = START_SPREAD_LIMIT_MS } = {}) {
  const base = verdictExclusive(outcomes, {
    sqlstate: WAITLIST_STALE_SQLSTATE,
    guard: "CAS-застовплення в schedule_from_waitlist_rpc",
    doubleWin: "КАНДИДАТА ЗАПИСАЛИ ДВІЧІ",
    noWin: "кандидата не записав НІХТО — фікстура або слот непридатні",
    spreadLimitMs,
  });
  /* ⚠️ ДОДАТКОВИЙ ГЕЙТ, ЯКОГО НЕМАЄ В ІНШИХ СЦЕНАРІЯХ, і причина конкретна
     (знахідка ревʼю Б, с62). `verdictExclusive` міряє одночасність лише
     розкидом СТАРТІВ, а він ≈0 за побудовою: `startedAt` пишеться до `await`.
     У `run`/`room` цю дірку закриває КОНТРОЛЬ — він ганяє ТОЙ САМИЙ клієнт
     тим самим транспортом і перевіряє `windowsOverlap`. Тут клієнт ІНШИЙ
     (користувацький, з токеном персоналу), тож контроль службової ролі про
     його паралельність не говорить нічого.

     Що це ловить насправді: якщо N запитів користувацького клієнта пішли
     ПО ЧЕРЗІ (один сокет, `maxSockets: 1`, оновлення токена всередині
     supabase-js, пул PostgREST на одне зʼєднання), то «1 удача + N−1 × 55000»
     зʼявиться і БЕЗ жодного блокування рядка: другий просто прочитає вже
     закомічений 'scheduled'. Такий самий зелений результат дала б RPC, у якій
     взаємного виключення немає взагалі. Тому без перетину вікон — не PASS. */
  if (base.verdict === "PASS" && !windowsOverlap(outcomes)) {
    return {
      ...base,
      verdict: "INCONCLUSIVE",
      reason: "вікна запитів НЕ перетнулись — виклики пішли по черзі, "
        + "а послідовний CAS дає ті самі 55000 і без взаємного виключення",
    };
  }
  return base;
}

/** Вердикт паралельного CAS на ОДНОМУ записі (`queue_set_status_rpc` з
    `p_expected`).

    ⚠️ Тут «невдача» — НЕ виняток: RPC чесно повертає `updated=false` і
    ПОТОЧНИЙ статус. Тому дефект виглядає інакше, ніж у двох сценаріях вище:
      • двоє з `updated=true` — `for update` (0075) не серіалізував;
      • невдаха бачить СТАРИЙ статус — читання пішло повз лок (снапшот до
        коміту переможця). Саме це і є суть CAS: після лока рядок
        перечитується, і невдаха мусить побачити РЕЗУЛЬТАТ переможця.
    Помилка RPC (виняток) теж FAIL: CAS не має кидати, він має відмовляти.

    @param {Array<{id: string, ok: boolean, updated: boolean|null,
                   currentStatus: string|null, sqlstate: string, message: string,
                   startedAt: number, finishedAt: number}>} outcomes
    @param {{target?: string, spreadLimitMs?: number}} [opts] */
export function verdictCas(outcomes, { target, spreadLimitMs = START_SPREAD_LIMIT_MS } = {}) {
  const spread = startSpreadMs(outcomes);
  if (outcomes.length < 2) {
    return { verdict: "FAIL", reason: `учасників ${outcomes.length}, гонки не було`, spread };
  }
  const errors = outcomes.filter((o) => !o.ok);
  if (errors.length) {
    return {
      verdict: "FAIL", spread,
      reason: `RPC кинув виняток замість updated=false: ${errors.map((o) => `${o.sqlstate}(${o.message.slice(0, 60)})`).join("; ")}`,
    };
  }
  const wins = outcomes.filter((o) => o.updated === true);
  const losses = outcomes.filter((o) => o.updated !== true);
  if (wins.length > 1) {
    return {
      verdict: "FAIL", spread,
      reason: `ПОДВІЙНИЙ CAS: updated=true у ${wins.length} — for update (0075) не серіалізував`,
      ids: wins.map((o) => o.id),
    };
  }
  if (wins.length === 0) {
    return { verdict: "FAIL", spread, reason: "жоден не оновив запис — фікстура або очікуваний статус непридатні" };
  }
  const stale = losses.filter((o) => o.currentStatus !== target);
  if (stale.length) {
    return {
      verdict: "FAIL", spread,
      reason: `невдаха побачив СТАРИЙ стан (${stale.map((o) => o.currentStatus || "?").join(", ")}) замість «${target}» — читання пішло повз лок`,
    };
  }
  if (spread > spreadLimitMs) {
    return {
      verdict: "INCONCLUSIVE", spread,
      reason: `розкид стартів ${spread} мс > ${spreadLimitMs} мс — одночасність не доведена`,
    };
  }
  return {
    verdict: "PASS", spread,
    reason: `1 updated=true з ${outcomes.length}, решта побачили «${target}» — лок і перечитування працюють`,
    ids: wins.map((o) => o.id),
  };
}

/** Вердикт гонки «скасування кейса ПРОТИ додавання кроку».

    ⚠️ ЧОМУ ЦЕ НЕ ДРАБИНКА ВЗАЄМНОГО ВИКЛЮЧЕННЯ. Тут немає «переможця» й
    «невдах»: обидва впорядкування ЗАКОННІ, і в обох кінцевий стан однаковий —
    кейс `cancelled`, усі кроки `cancelled`. Різниця лише в тому, чи встиг крок
    додатись до скасування. Тому вердикт дивиться не на кількість удач, а на
    КІНЦЕВИЙ СТАН, і питання в нього одне:

      чи існує кейс `cancelled`, у якого лишився АКТИВНИЙ крок?

    Такого стану не має бути ні за яким порядком. Він зʼявляється рівно тоді,
    коли перевірка `status = 'open'` читає знімок ДО коміту скасування — тобто
    коли її винесли з-під `select … for update`. Помилки БД при цьому немає:
    крок вставляється успішно, `case_recompute_status` для нього не
    перераховується, і кейс лишається скасованим із живим кроком усередині.

    @param {{ok: boolean, entryId: string|null, sqlstate: string, message: string,
              startedAt: number, finishedAt: number}} add
    @param {{ok: boolean, cancelled: number|null, sqlstate: string, message: string,
              startedAt: number, finishedAt: number}} cancel
    @param {{caseStatus: string|null, steps: Array<{id: string, status: string}>}} final */
export function verdictCaseCancelRace(add, cancel, final, { spreadLimitMs = START_SPREAD_LIMIT_MS } = {}) {
  const outcomes = [add, cancel];
  const spread = startSpreadMs(outcomes);
  const active = (final.steps || []).filter((s) => CASE_ACTIVE_STATUSES.includes(s.status));

  /* Скасування має пройти ЗАВЖДИ: воно не конкурує за право діяти, воно лише
     чекає лок. Виняток тут — не «програш у гонці», а зламана постановка. */
  if (!cancel.ok) {
    return {
      verdict: "FAIL", spread,
      reason: `скасування впало (${cancel.sqlstate}: ${String(cancel.message).slice(0, 70)}) — постановка зламана, гонки не було`,
    };
  }

  /* ГОЛОВНЕ ТВЕРДЖЕННЯ. Перевіряємо ПЕРШИМ: заборонений стан — доведений
     дефект незалежно від того, що повернули виклики і чи довели ми одночасність. */
  if (final.caseStatus === "cancelled" && active.length) {
    return {
      verdict: "FAIL", spread,
      reason: `ЗАБОРОНЕНИЙ СТАН: кейс cancelled, але лишились активні кроки `
        + `(${active.map((s) => s.status).join(", ")}) — перевірка «кейс відкритий» пішла повз лок`,
      ids: active.map((s) => s.id),
    };
  }

  if (add.ok) {
    /* Крок додався → скасування прийшло ПІСЛЯ і мусило змести його разом з
       рештою. Живий крок тут — той самий заборонений стан, лише спійманий
       за id, а не за статусом кейса. */
    const mine = (final.steps || []).find((s) => s.id === add.entryId);
    if (mine && CASE_ACTIVE_STATUSES.includes(mine.status)) {
      return {
        verdict: "FAIL", spread,
        reason: `доданий крок лишився активним (${mine.status}) попри скасування кейса — його не було в списку локів`,
        ids: [mine.id],
      };
    }
  } else if (add.sqlstate !== CASE_NOT_OPEN_SQLSTATE) {
    /* Крок не додався — але ЧОМУ. Єдина законна причина: кейс уже не `open`.
       Будь-яка інша (42501 доступ, 23505 кабінет уже в кейсі, 40P01 дедлок)
       означає, що ми перевіряли не те, що обіцяли. */
    return {
      verdict: "FAIL", spread,
      reason: `крок відмовлено НЕ через скасування: ${add.sqlstate} (${String(add.message).slice(0, 70)})`,
    };
  }

  if (!windowsOverlap(outcomes)) {
    return {
      verdict: "INCONCLUSIVE", spread,
      reason: "вікна запитів НЕ перетнулись — виклики пішли по черзі, "
        + "а послідовний порядок нічого не каже про лок",
    };
  }
  if (spread > spreadLimitMs) {
    return {
      verdict: "INCONCLUSIVE", spread,
      reason: `розкид стартів ${spread} мс > ${spreadLimitMs} мс — одночасність не доведена`,
    };
  }
  return {
    verdict: "PASS", spread,
    reason: add.ok
      ? `порядок «крок → скасування»: крок додано, скасування змело ${cancel.cancelled} кроків, заборонений стан не виник`
      : `порядок «скасування → крок»: скасування змело ${cancel.cancelled} кроків, крок відмовлено ${CASE_NOT_OPEN_SQLSTATE}, заборонений стан не виник`,
  };
}

/** Вердикт КОНТРОЛЬНОГО сценарію: ті самі N пострілів, але в РІЗНІ слоти.

    Навіщо він. Без контролю «одна удача з N» неможливо відрізнити від
    «фікстура зламана, і N−1 запитів упали б у будь-якому разі». Контроль
    доводить, що постріли самі по собі проходять, а отже відмови в основному
    сценарії спричинені САМЕ конкуренцією за слот. Це той самий клас
    сторожа, що й «ворожий payload мусить пробивати ІМЕННО правило» (с25). */
export function verdictControl(outcomes) {
  const losses = outcomes.filter((o) => !o.ok);
  if (losses.length) {
    return {
      verdict: "FAIL",
      reason: `фікстура непридатна: ${losses.length} з ${outcomes.length} упали (${losses.map((o) => o.sqlstate).join(", ")})`,
    };
  }
  if (!windowsOverlap(outcomes)) {
    return {
      verdict: "INCONCLUSIVE",
      reason: "вікна запитів не перетнулись — клієнт стріляв ПО ЧЕРЗІ, паралельності немає",
    };
  }
  return { verdict: "PASS", reason: `усі ${outcomes.length} пройшли, вікна запитів перетинаються` };
}
