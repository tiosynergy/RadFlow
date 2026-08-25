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
