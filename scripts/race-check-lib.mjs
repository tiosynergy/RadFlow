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

/** SQLSTATE, яким тригер 0064 відмовляє тому, хто програв гонку. */
export const OVERLAP_SQLSTATE = "23P01";

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

/** Вердикт гонки за слот.

    Три різні присуди, і плутати їх не можна:
    - PASS         — рівно одна удача, решта відмовлені САМЕ тригером 0064;
    - FAIL         — доведений дефект (двоє записались / не записався ніхто /
                     невдаха впав не через гонку);
    - INCONCLUSIVE — прогін нічого не довів (запити пішли не одночасно).
      Це НЕ «майже PASS»: послідовний прогін теж дає «рівно одну удачу»,
      тому без доведеної одночасності PASS був би самообманом. */
export function verdictSlotRace(outcomes, { spreadLimitMs = START_SPREAD_LIMIT_MS } = {}) {
  const wins = outcomes.filter((o) => o.ok);
  const losses = outcomes.filter((o) => !o.ok);
  const spread = startSpreadMs(outcomes);

  if (outcomes.length < 2) {
    return { verdict: "FAIL", reason: `учасників ${outcomes.length}, гонки не було`, spread };
  }
  if (wins.length > 1) {
    return {
      verdict: "FAIL", spread,
      reason: `ПОДВІЙНЕ БРОНЮВАННЯ: удач ${wins.length} — тригер 0064 гонку не втримав`,
      ids: wins.map((o) => o.id),
    };
  }
  if (wins.length === 0) {
    return {
      verdict: "FAIL", spread,
      reason: `не записався НІХТО (${losses.map((o) => o.sqlstate).join(", ")}) — слот або фікстура непридатні`,
    };
  }

  const wrong = losses.filter((o) => o.sqlstate !== OVERLAP_SQLSTATE);
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
    reason: `1 удача з ${outcomes.length}, решта — ${OVERLAP_SQLSTATE} від тригера 0064`,
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
