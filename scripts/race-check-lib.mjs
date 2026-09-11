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

/** Фрагмент ТЕКСТУ тієї самої відмови — і без нього SQLSTATE тут не працює.

    ⚠️ ЗАМІРЯНО В ПРОДІ 11.09.2026 (`pg_get_functiondef(add_case_step_rpc)`):
    `22023` ця RPC піднімає у ПʼЯТИ місцях, не у двох, як писав план доробки:
      • 'BAD_INPUT: крок без кабінету'      ← валідація входу, ДО локів
      • 'BAD_INPUT: крок без досліджень'    ← валідація входу, ДО локів
      • 'BAD_INPUT: крок без тривалості'    ← валідація входу, ДО локів
      • 'BAD_INPUT: крок без слота'         ← валідація входу, ДО локів
      • 'BAD_INPUT: кейс не активний — крок додати не можна'  ← ЄДИНИЙ гоночний
    Чотири перші означають ЗЛАМАНУ ФІКСТУРУ і трапляються без жодної гонки.
    Отже вердикт, що звіряє лише SQLSTATE (або префікс `BAD_INPUT`), зарахував
    би непридатну фікстуру за «переможене скасуванням» — тобто видав би
    найгірший різновид зеленого: той, що виникає САМ, без предмета перевірки.

    Тому дискримінатор — текст. Розійдеться з тілом RPC (переклад, правка
    формулювання) — сценарій почне чесно казати «впав НЕ через гонку», а не
    тихо зараховувати чуже. */
export const CASE_NOT_OPEN_MESSAGE = "кейс не активний";

/** Статуси кроку, які `check_case_distinct_room`, `check_case_no_time_overlap`
    і `case_recompute_status` вважають АКТИВНИМИ (звірено з тілами в проді
    10.09.2026). Список тут один на всі три місця: розійшовшись, він зробив би
    вердикт «заборонений стан» м'якшим за саму БД. */
export const CASE_ACTIVE_STATUSES = ["scheduled", "waiting", "in_progress", "needs_reschedule"];

/** SQLSTATE тієї ж RPC, коли кандидата немає в ЦЬОМУ центрі. У вердикті
    гонки він означає не «інший оператор випередив», а зламану фікстуру —
    і `verdictExclusive` покаже це окремим рядком «впали НЕ через гонку». */
export const WAITLIST_NOT_FOUND_SQLSTATE = "42501";

/** Дедлок. ЄДИНИЙ спостережуваний наслідок того, що дисципліна порядку
    захвату локів у `emergency_stop_rpc` / `submit_incident_rpc` (0083, 0109)
    зламалась.

    ⚠️ ЧЕСНО ПРО МЕЖУ ЦЬОГО СЦЕНАРІЮ. Усі інші гонки в цьому файлі стережуть
    ПОДІЮ: 23P01, 23505, 55000 — те, що з'являється, коли гард спрацював. Тут
    навпаки: гарантія — це ВІДСУТНІСТЬ 40P01. Червону базу на живому проді для
    неї отримати неможливо, бо «червоне» тут означає «прод зламаний»; а
    рукотворний AB-BA-контроль на тих самих ключах вимагав би нової
    SECURITY DEFINER-функції в проді, тобто нової поверхні заради тесту.
    Тому червона база для самої драбинки живе у `falsify-race-check.mjs`
    (мутує lib, не БД), а прогін у проді доводить рівно одне: сьогодні
    регресії немає. Це слабше за інші чотири сценарії, і так і написано.

    ⚠️ І ЩЕ ОДНЕ, ЗАМІРЯНЕ ВЖЕ ПІСЛЯ ПРОГОНУ (с63). Спершу тут стояло
    виправдання «зате зламана дисципліна падає ГУЧНО, дедлоком». Це НЕПРАВДА:
    `app/queue/actions.ts` ловить 40P01 через `isRetryableLockError` і показує
    оператору «Кабінет саме зараз зупиняє інший оператор — спробуйте ще раз».
    Тобто продукт дедлок СВІДОМО ковтає, і в проді зламаний порядок виглядав
    би як рідкісна підказка «спробуйте ще раз» — тихо. Висновок протилежний
    до первісного: цей сценарій не «менш потрібен, бо й так помітно», а
    ЄДИНЕ місце, де 40P01 узагалі видно. */
export const DEADLOCK_SQLSTATE = "40P01";

/** SQLSTATE, які ПРОДУКТ вважає транзієнтними локовими помилками, — знято з
    `isRetryableLockError` (`app/queue/actions.ts`) 11.09.2026.

    ⚠️ НАВІЩО КОПІЯ В ХАРНЕСІ. Режим `stop --with-case` (с63) спирається на
    заяву БД «вікно 40P01 транзієнтне, клієнт повторює». Заява вірна рівно
    доти, доки клієнт справді класифікує 40P01 як транзієнт. Розійдеться
    продукт із цим списком — і терпимість вердикту до дедлока стане
    безпідставною МОВЧКИ. Тому список не переказується памʼяттю, а пінить
    його тест `tests/raceCheck.test.ts`, читаючи сам `actions.ts`.

    ⚠️ І ОДРАЗУ ЧЕСНО ПРО МЕЖУ САМОГО СЛОВА «ПОВТОРЮЄ». Автоматичного ретраю
    в продукті НЕМАЄ: на 40P01 аварійна зупинка віддає
    `{ ok: false, error: "Кабінет саме зараз зупиняє інший оператор —
    спробуйте ще раз" }`, і повторює ЛЮДИНА, натиснувши ще раз. Тобто в те
    вікно зупинка НЕ СТАЄТЬСЯ, а оператор під час аварії бачить підказку. */
export const RETRYABLE_LOCK_SQLSTATES = ["40P01", "40001", "55P03", "57014"];

/** ГАРД ФОРМИ ТОКЕНА. Кидає з ІМЕНЕМ причини; значення токена НЕ повертає і
    НЕ друкує — жодного фрагмента, навіть у повідомленні помилки.

    ⚠️ ЗАПЛАЧЕНО ЖИВИМ ПРОГОНОМ 11.09.2026 (пакет 61). У `RADFLOW_USER_JWT`
    опинився ПЛЕЙСХОЛДЕР із довідки — `<токен>`, кирилицею. Харнес діагноз
    поставив правильно і надрукував «заголовок не розібрався — це не схоже на
    JWT»… після чого пішов у мережу з цим значенням у заголовку
    `Authorization`. `fetch` відмовився ще на рівні HTTP:

      Cannot convert argument to a ByteString because the character at index 8
      has a value of 1090 which is greater than 255.

    Тобто ВЕРДИКТ ПРО ПРИДАТНІСТЬ ТОКЕНА ІСНУВАВ, але нічого не вирішував:
    діагностика, яка не зупиняє, — це коментар. Той самий клас, що
    `fn_audit` із `exception when others then null` (0187), просто в харнесі.

    Чому саме ця трійка перевірок і в цьому порядку:
      1) порожньо — окреме повідомлення, бо це «змінна не задана», а не
         «токен зіпсутий»;
      2) НЕ-ASCII — САМЕ ця умова ламає `fetch`, і вона мусить називатись
         своїм імʼям, а не ховатись за «не схоже на JWT». Байт > 255 у
         значенні заголовка HTTP заборонений за специфікацією;
      3) форма `a.b.c` + розбір header/payload — власне JWT.
    @param {string} jwt
    @returns {{alg: string, kid: boolean, role: string, minLeft: number | null}} */
export function assertUsableJwt(jwt) {
  const t = String(jwt ?? "");
  if (!t) {
    throw new Error("RADFLOW_USER_JWT порожній — змінна не задана.");
  }
  /* Ітеруємо по code points, а не по `charCodeAt`: сурогатна пара дала б
     два «символи» по 0xD800+, і позиція у повідомленні поїхала б. */
  const badAt = [...t].findIndex((ch) => ch.codePointAt(0) > 255);
  if (badAt >= 0) {
    throw new Error(
      `RADFLOW_USER_JWT містить не-ASCII символ (позиція ${badAt}) — це не токен.\n`
      + "  Найчастіша причина: у змінну пішов ПЛЕЙСХОЛДЕР із довідки («<токен>»), а не значення.\n"
      + "  Такий рядок не можна покласти в заголовок Authorization: HTTP забороняє байт > 255,\n"
      + "  і fetch упав би сирим «Cannot convert argument to a ByteString».\n"
      + "  Візьміть токен сніпетом із шапки scripts/race-check.mjs (він кладе його в буфер обміну).");
  }
  const parts = t.split(".");
  if (parts.length !== 3) {
    throw new Error(
      `RADFLOW_USER_JWT не має форми JWT (частин ${parts.length}, очікується 3).`);
  }
  let h, b;
  try {
    h = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    b = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("RADFLOW_USER_JWT: header або payload не розбираються як JSON — це не токен.");
  }
  return {
    alg: String(h.alg ?? "?"),
    kid: Boolean(h.kid),
    role: String(b.role ?? "?"),
    minLeft: b.exp ? Math.round((b.exp * 1000 - Date.now()) / 60000) : null,
  };
}

/** SQLSTATE, яким `submit_incident_rpc` (0110) відмовляє, коли кабінет уже має
    активний простій. Це РУКОТВОРНИЙ `raise` після `on conflict do nothing`, а
    не помилка двигуна — сама RPC конфлікт ковтає, а потім бачить `v_id is null`.

    ⚠️ ОКРЕМА КОНСТАНТА, хоч літерал збігається з `IN_PROGRESS_SQLSTATE`. За
    ними стоять РІЗНІ гаранти — частковий індекс 0017 (один активний інцидент
    на кабінет) проти 0018 (один in_progress на кабінет). Злити їх в одну
    означало б, що правка одного сценарію нечутно перевизначає очікування
    іншого. */
export const INCIDENT_TAKEN_SQLSTATE = "23505";

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
    він потім є явним списком для прибирання.

    ⚠️ `offSchedule` (с63, сценарій `midnight`). Дефолт `false` — жоден наявний
    сценарій не змінюється. Ставиться РІВНО там, де без нього фікстура
    незаконна: запис, що ПЕРЕТИНАЄ північ, закінчується після закриття будь-якого
    кабінету за побудовою (`check_room_schedule` рахує кінець як
    `start + duration` У ХВИЛИНАХ ТІЄЇ Ж ДОБИ, тож 23:50 + 20 хв = 1450 > 1440 ≥
    будь-якого `close`). Продукт для такої роботи вимагає підтвердження
    оператора, і прапорець — саме воно, а не обхід гарда: закритий день, час до
    відкриття і стеля +120 хв він НЕ відкриває (0084).

    ⚠️ Чому це взагалі працює з-під харнеса: `guard_off_schedule` (0077) б'є по
    `auth.uid() is not null and auth_clinic_id() is null`, тобто по направнику й
    CEO. Службова роль має `auth.uid()` = NULL і в гарді прямо названа
    довіреною. Заміряно з тіла функції, не припущено. */
export function buildFixture({ id, clinicId, roomId, day, time, label, study, offSchedule = false }) {
  const studies = [study];
  return {
    id, clinic_id: clinicId, room_id: roomId,
    patient_name: `${FIXTURE_NAME} ${label}`,
    patient_phone: FIXTURE_PHONE,
    studies, studies_original: studies,
    duration_min: FIXTURE_DUR_MIN, buffer_time_min: FIXTURE_BUF_MIN,
    scheduled_date: day, scheduled_time: time,
    status: "scheduled", call_status: "not_called",
    off_schedule: offSchedule,
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

/** Часи фікстур сценарію `midnight` — ПЕРЕХІД ЧЕРЕЗ ПІВНІЧ.

    Геометрія: 23:50 доби D займає кабінет до 00:15 доби D+1 (20 хв
    дослідження + 5 хв буфера), а 00:00 доби D+1 — до 00:25. Вікна САМИХ
    ДОСЛІДЖЕНЬ (без буфера) перетинаються 00:00–00:10, тобто перетин не
    тримається на буфері й лишився б перетином, навіть якби буфер прибрали.

    ⚠️ Числа не «зручні», а підібрані під `FIXTURE_DUR_MIN`. Зміните
    тривалість — перевірте, що перетин ще існує: `verdictMidnightRace` рахує
    його сам і віддає INCONCLUSIVE, якщо сцена виродилась. Саме цієї
    перевірки бракувало сценарію `case` до с63. */
export const MIDNIGHT_LATE_TIME = "23:50";
export const MIDNIGHT_EARLY_TIME = "00:00";
/** Контрольний слот НАСТУПНОЇ доби: свідомо далеко від хвоста 00:15. */
export const MIDNIGHT_CONTROL_TIME = "03:00";

/** Хвилини доби з «HH:MM». Без дефолтів: зламаний рядок має дати NaN і
    провалити перевірку геометрії, а не тихо стати нулем. */
function minOfDay(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

/** Різниця дат «YYYY-MM-DD» у добах. Рахуємо в UTC, де DST не існує: доби
    переходу не 24 години, і наївна різниця мілісекунд локального часу дала б
    0 або 2 замість 1 (той самий клас, що закривав `clinicDay` і lib/fhirTime). */
function dayDiff(a, b) {
  const p = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  };
  return (p(b) - p(a)) / 86400000;
}

/** Вердикт гонки ЧЕРЕЗ МЕЖУ ДОБИ: пізній запис доби D проти раннього доби D+1.

    ЩО САМЕ ТУТ ПЕРЕВІРЯЄТЬСЯ І ЧОМУ ЦЕ НЕ ДУБЛІКАТ `run`. Гарант той самий —
    тригер `check_no_overlap` (0064), — але геометрія інша, і саме вона ніколи
    не ганялась: у всіх пʼяти наявних сценаріїв обидві фікстури мають ОДНАКОВУ
    `scheduled_date`. Тригер порівнює `tstzrange` на `scheduled_at`, тобто на
    абсолютних «настінних UTC» миттєвостях (0035), і межі доби не знає взагалі
    — але це ТВЕРДЖЕННЯ ПРО КОД, і поза добою його ніхто не міряв. Продукт
    хвости через північ підтримує явно: `room_busy_slots` (0074) обрізає вікна
    по добі й віддає «хвостові» рядки з `duration_min = 0`, а мʼяка
    пред-перевірка в `app/queue/actions.ts` спеціально бере СУСІДНІ доби (±1)
    саме тому, що інакше «слот зелений, але незаписуваний».

    ⚠️ ТРИ ГЕЙТИ ГЕОМЕТРІЇ СТОЯТЬ ПЕРЕД ДРАБИНКОЮ, і кожен закриває свій
    спосіб зробити сценарій вакуумним — тобто зеленим, який нічого не довів:
      1. доби РІЗНІ. Однакові — і це просто `run` під іншим іменем;
      2. доби СУСІДНІ. `dayDiff = 1` перевіряємо самі з рядків, а не віримо
         тому, хто їх побудував: 23:50 доби D і 00:00 доби D+5 не перетнуться
         ніколи, і «не записався НІХТО» прочиталось би як дефект тригера;
      3. вікна ЗАЙНЯТОСТІ справді перетинаються. Хвіст пізнього запису заходить
         у наступну добу на `minOfDay(timeLate) + occMin − 1440` хвилин; якщо це
         не більше за старт раннього, ЗАБОРОНЕНОГО СТАНУ НЕ ІСНУЄ, і «рівно одна
         удача» була б чистим збігом. Рівно ця перевірка й відрізняє доказ від
         збігу — її відсутність в `case` коштувала сесії 62 хибного блокування.

    Усі три дають INCONCLUSIVE, а не FAIL: зіпсована сцена — це «нічого не
    довели», а не «знайдено дефект». Плутати їх не можна.

    ⚠️ Форма сцени оголошена JSDoc-ом НАВМИСНО, а не лишена на висновок. У .mjs
    TypeScript виводить тип деструктурованого параметра з дефолта `= {}` плюс
    ті поля, що мають власні дефолти, — тобто вийшло б `{ spreadLimitMs?: … }`,
    і будь-який виклик із реальною сценою не збирався б (TS2559/TS2353). Це не
    косметика: без анотації спек цієї функції не написати взагалі.

    @param {Array<Outcome>} outcomes
    @param {{ dayLate?: string, timeLate?: string, dayEarly?: string,
              timeEarly?: string, occMin?: number, spreadLimitMs?: number }} [scene] */
export function verdictMidnightRace(outcomes, {
  dayLate, timeLate, dayEarly, timeEarly, occMin,
  spreadLimitMs = START_SPREAD_LIMIT_MS,
} = {}) {
  const spread = startSpreadMs(outcomes || []);
  const diff = dayDiff(dayLate, dayEarly);
  if (!Number.isFinite(diff)) {
    return { verdict: "INCONCLUSIVE", spread,
      reason: `дати фікстур нечитані (${dayLate} → ${dayEarly}) — сцену не перевірити` };
  }
  if (diff === 0) {
    return { verdict: "INCONCLUSIVE", spread,
      reason: `обидві фікстури на ОДНУ добу (${dayLate}) — це сценарій \`run\` під іншим іменем, `
        + "межу доби не перетнуто" };
  }
  if (diff !== 1) {
    return { verdict: "INCONCLUSIVE", spread,
      reason: `доби не сусідні (${dayLate} → ${dayEarly}, різниця ${diff}) — вікна не могли перетнутись` };
  }
  const lateStart = minOfDay(timeLate);
  const earlyStart = minOfDay(timeEarly);
  const tail = lateStart + Number(occMin) - 1440;   // скільки хвилин хвіст заходить у добу D+1
  if (!Number.isFinite(tail) || !Number.isFinite(earlyStart)) {
    return { verdict: "INCONCLUSIVE", spread,
      reason: `часи або зайнятість нечитані (${timeLate} +${occMin} хв, ${timeEarly})` };
  }
  if (tail <= earlyStart) {
    return { verdict: "INCONCLUSIVE", spread,
      reason: `вікна НЕ перетинаються: ${timeLate} +${occMin} хв закінчується на ${tail} хв доби D+1, `
        + `а ранній запис починається на ${earlyStart} — забороненого стану не існує` };
  }
  return verdictExclusive(outcomes, {
    sqlstate: OVERLAP_SQLSTATE,
    guard: "тригера 0064 ЧЕРЕЗ межу доби",
    doubleWin: "ПОДВІЙНЕ БРОНЮВАННЯ ЧЕРЕЗ ПІВНІЧ",
    noWin: "не записався НІХТО — слоти біля півночі або фікстура непридатні",
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
  } else if (add.sqlstate !== CASE_NOT_OPEN_SQLSTATE
             || !String(add.message).includes(CASE_NOT_OPEN_MESSAGE)) {
    /* Крок не додався — але ЧОМУ. Єдина законна причина: кейс уже не `open`.
       Будь-яка інша (42501 доступ, 23505 кабінет уже в кейсі, 40P01 дедлок)
       означає, що ми перевіряли не те, що обіцяли.

       ⚠️ ЗВІРЯЄМО І ТЕКСТ, а не лише SQLSTATE (замір с63). Той самий `22023`
       ця RPC піднімає ще в ЧОТИРЬОХ місцях — усі вони валідація входу ДО
       локів («крок без кабінету/досліджень/тривалості/слота»), тобто ознака
       зламаної фікстури. Перевірка по самому лише коду зараховувала б їх за
       програш у гонці: зелений без предмета. Деталі — біля
       `CASE_NOT_OPEN_MESSAGE`. */
    return {
      verdict: "FAIL", spread,
      reason: `крок відмовлено НЕ через скасування: ${add.sqlstate} (${String(add.message).slice(0, 70)})`,
    };
  }

  /* ⚠️ СКАСУВАННЯ МУСИТЬ БУЛО ЩО СКАСУВАТИ. `cancel_case_rpc` повертає
     `row_count` свого UPDATE (заміряно в тілі: `get diagnostics v_count`), і
     нуль тут означає, що на момент лока активних кроків уже не було — тобто
     сцена розвалилась ДО гонки (крок-фікстура не ліг, чужий прогін прибрав
     його, кейс був не той). Без цієї перевірки такий прогін давав би PASS
     «заборонений стан не виник» — по порожньому кейсу він і не міг виникнути. */
  if (cancel.cancelled != null && cancel.cancelled < 1) {
    return {
      verdict: "FAIL", spread,
      reason: "скасування не зачепило ЖОДНОГО кроку — сцена розвалилась до гонки, "
        + "а не «заборонений стан не виник»",
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

/** Вердикт СЕРІЇ прогонів гонки за кейс — і саме він знімає блокування с62.

    ⚠️ НАВІЩО СЕРІЯ, А НЕ ОДИН ПОСТРІЛ. Ревʼю Б (с62) показало, що з двох
    можливих упорядкувань лише ОДНЕ щось перевіряє:

      • «скасування → крок» — `add` перечитує рядок кейса ПІД ЛОКОМ, бачить
        не-`open` і падає 22023. Приберіть лок — і він прочитає знімок ДО
        коміту скасування, покладе крок у вже скасований кейс, і в проді
        лишиться `cancelled` з живим кроком. Тобто це упорядкування РОЗРІЗНЯЄ
        справний код і зламаний;
      • «крок → скасування» — крок лягає, а скасування потім змітає його своїм
        `for update`. Справний і зламаний код дають БАЙТ У БАЙТ той самий
        результат, бо зламаний гард тут просто не встигає знадобитись.

    Один постріл дає друге упорядкування приблизно в половині випадків, і тоді
    PASS не значить нічого. Тому серія і ВИМОГА: хоча б один прогін мусить
    лягти в упорядкування «скасування → крок». Не ліг — INCONCLUSIVE, і в
    причині сказано, що перевірено лише вакуумну половину.

    ⚠️ Це НЕ «пожорсткішали про всяк випадок». Без цієї вимоги сценарій
    відтворює рівно ту помилку, через яку його заблокували: зелений, отриманий
    із прогону, який не міг почервоніти.

    @param {Array<{add: {ok: boolean}, cancel: object, final: object,
                   verdict: {verdict: string, reason: string, spread: number}}>} rounds */
export function verdictCaseRounds(rounds) {
  if (!rounds || !rounds.length) {
    return { verdict: "FAIL", spread: 0, reason: "жодного прогону — гонки не було" };
  }
  const spread = Math.max(...rounds.map((r) => r.verdict.spread ?? 0));

  /* 1. Дефект у будь-якому прогоні важливіший за статистику серії. */
  const bad = rounds.findIndex((r) => r.verdict.verdict === "FAIL");
  if (bad >= 0) {
    return {
      ...rounds[bad].verdict,
      reason: `прогін ${bad + 1}/${rounds.length}: ${rounds[bad].verdict.reason}`,
    };
  }

  /* 2. Упорядкування рахуємо ЛИШЕ по прогонах, які самі по собі PASS:
     прогін, де вікна не перетнулись, про упорядкування не свідчить. */
  const good = rounds.filter((r) => r.verdict.verdict === "PASS");
  const decisive = good.filter((r) => !r.add.ok);   // «скасування → крок»
  const vacuous = good.filter((r) => r.add.ok);     // «крок → скасування»

  if (!good.length) {
    return {
      verdict: "INCONCLUSIVE", spread,
      reason: `жоден із ${rounds.length} прогонів не довів одночасності `
        + `(${rounds.map((r) => r.verdict.verdict).join(", ")})`,
    };
  }
  if (!decisive.length) {
    return {
      verdict: "INCONCLUSIVE", spread,
      reason: `${rounds.length} прогонів, і ВСІ лягли в упорядкування «крок → скасування» — `
        + "те, у якому справний і зламаний код дають однаковий результат. "
        + "Гарант не перевірено; збільште кількість прогонів",
    };
  }
  return {
    verdict: "PASS", spread,
    reason: `${rounds.length} прогонів: ${decisive.length} у вирішальному упорядкуванні `
      + `«скасування → крок» (крок відмовлено ${CASE_NOT_OPEN_SQLSTATE} «${CASE_NOT_OPEN_MESSAGE}»), `
      + `${vacuous.length} у вакуумному «крок → скасування». Заборонений стан не виник у жодному`,
  };
}

/** Вердикт гонки АВАРІЙНИХ ЗУПИНОК.

    Що стріляє (три постріли в одному `Promise.all`):
      S1 `emergency_stop_rpc([A, B], D)`
      S2 `emergency_stop_rpc([B, A], D)`   ← той самий набір у ПРОТИЛЕЖНОМУ порядку
      S3 `submit_incident_rpc(B)`          ← пара, названа в шапці 0083

    Що стережеться:
      1) 40P01 не виникає в жодного — дисципліна порядку (`order by pc.id` →
         `order by q.id` → advisory `order by r.id`) тримається. Порядок
         `p_room_ids` на захват не впливає ЗА ПОБУДОВОЮ, і в цьому вся суть:
         зникне `order by r.id` — S1 і S2 візьмуть advisory навхрест.
      2) кабінет не зупиняється ДВІЧІ: `stopped_rooms` двох зупинок не
         перетинаються, і в кожному кабінеті рівно один активний інцидент
         (частковий індекс 0017 — єдиний арбітр, `on conflict do nothing`).
      3) обидва кабінети зупинені бодай кимось.

    ⚠️ ДОКАЗ КОНКУРЕНЦІЇ ТУТ ЛИШЕ ЧАСОВИЙ, і це не лінощі. Послідовний прогін
    дає ТУ САМУ картину результатів: другий бачить уже закомічені інциденти,
    ковтає конфлікт і повертає порожній `stopped_rooms`, а «поломка» так само
    кидає 23505. Тобто ні 23505, ні неповний набір кабінетів конкуренції не
    доводять. Доводить перетин вікон плюс те, що невдаха фінішував НЕ раніше
    за переможця — бо він стояв на advisory-локу. Деталі — у гейтах 6–7.

    ⚠️ І навіть PASS тут слабший за PASS решти сценаріїв: він означає «40P01
    не сталося сьогодні», а не «дисципліна порядку доведена». Причина — у
    коментарі до `DEADLOCK_SQLSTATE`.

    ⚠️ МЕЖА «БУДЬ-ЯКИЙ 40P01 = FAIL», І ВОНА ТРИМАЄТЬСЯ НЕ САМА (замір с63).
    У тілі `cancel_case_rpc` (рядки 56–60, знято `pg_get_functiondef` із прода
    11.09.2026) стоїть авторська заява:

      «Вузьке вікно 40P01 з багаторядковими emergency_stop/submit_incident та
       з тригером перерахунку статусу (лок кейса після лока запису) —
       транзієнтне, клієнт повторює (isRetryableLockError).»

    Тобто БАЗА САМА оголошує одне вікно 40P01 між аварійною зупинкою і
    перерахунком статусу КЕЙСА відомим і допустимим. Цей вердикт назвав би його
    дефектом.

    Чому він усе-таки правий СЬОГОДНІ: фікстури сценарію будуються
    `buildFixture`, тобто БЕЗ `case_id`. Жоден рядок `patient_cases` не
    лочиться, тригер перерахунку не спрацьовує, і в те вікно прогін потрапити
    не може — воно поза сценою. Прогін 10.09 (PASS) під цю умову підпадає.

    ⚠️ РЕЖИМ `caseLinked` (с63, пакет 61) — і він відповідає на ІНШЕ ПИТАННЯ.
    Фікстури зі звʼязкою кейса плюс ЧЕТВЕРТИЙ постріл `cancel_case_rpc` на
    тому ж кейсі. Навіщо четвертий: двох зупинок для інверсії НЕ ВИСТАЧАЄ.
    Заміряно з тіла `emergency_stop_rpc` 11.09.2026 — передлок кейсів там є,
    але з предикатом `q.status = 'in_progress'`:

      perform 1 from public.patient_cases pc
       where pc.id in (select distinct q.case_id from public.queue_entries q
                        where … and q.status = 'in_progress' and q.case_id is not null)
       order by pc.id for update;

    А `update … set call_status = 'to_recall'` далі бʼє по
    `status in ('scheduled','waiting','in_progress')`. Тобто крок кейса у
    статусі `scheduled` оновлюється БЕЗ передлока свого кейса, і лок на
    `patient_cases` бере вже AFTER-тригер `trg_z_case_status_recompute` через
    `case_recompute_status` — тобто queue→case. `cancel_case_rpc` іде
    case→queue. Ось ця пара і є ABBA; дві зупинки між собою йдуть в однаковому
    порядку `order by q.id` і не інвертуються за побудовою.

    ⚠️ ЧОМУ В ЦЬОМУ РЕЖИМІ 40P01 — INCONCLUSIVE, А НЕ PASS І НЕ FAIL.
    Postgres називає лише ЖЕРТВУ, а не другого учасника дедлока. Тобто харнес
    не може відрізнити оголошене вікно (зупинка ↔ скасування кейса) від
    зламаної дисципліни порядку, яка дала б 40P01 між двома зупинками. PASS
    тут був би припущенням, FAIL — звинуваченням бази в тому, що вона сама
    оголосила допустимим. Чесна відповідь одна: «вікно відкрилось, судити про
    дисципліну звідси не можна».

    ⚠️ І ТОМУ ЦЕЙ РЕЖИМ НЕ ЗАМІНЮЄ ЗВИЧАЙНИЙ. Сторожем регресії лишається
    прогін БЕЗ `caseLinked`: там фікстури без `case_id`, вікно поза сценою, і
    будь-який 40P01 — дефект. `--with-case` питає інше: чи відкривається
    оголошене вікно в проді ВЗАГАЛІ і що при цьому бачить оператор.

    Умову тримає не памʼять, а асерти в самому сценарії
    (`assertFixturesHaveNoCase` / `assertFixturesHaveCase` у race-check.mjs) і
    `caseLinked` без `canceller`, який кидає: межа, що тримається на памʼяті, —
    це майбутня брехня харнеса.

    @param {{stops: Array<{id: string, ok: boolean, rooms: string[], asked: string[],
                           sqlstate: string, message: string,
                           startedAt: number, finishedAt: number}>,
             breakdown: {id: string, ok: boolean, room: string, sqlstate: string,
                         message: string, startedAt: number, finishedAt: number},
             rooms: string[],
             activeByRoom: Record<string, number>,
             canceller?: {id: string, ok: boolean, sqlstate: string, message: string,
                          startedAt: number, finishedAt: number} | null}} shots
    activeByRoom — скільки АКТИВНИХ інцидентів у кожному кабінеті ПІСЛЯ гонки
    (звірено запитом, а не за відповідями RPC: «RPC не повернула помилки» ≠
    «в базі один рядок»).
    canceller — четвертий постріл `cancel_case_rpc`; є ЛИШЕ в режимі caseLinked.
    @param {{spreadLimitMs?: number, caseLinked?: boolean}} [opts] */
export function verdictEmergencyStop({ stops, breakdown, rooms, activeByRoom, canceller = null },
                                     { spreadLimitMs = START_SPREAD_LIMIT_MS,
                                       caseLinked = false } = {}) {
  /* ⚠️ КИДАЄМО, А НЕ ПОСЛАБЛЮЄМО МОВЧКИ. `caseLinked` без `cancel_case_rpc` —
     це сцена, де інверсії порядку немає за побудовою (обидві зупинки йдуть
     queue→case в однаковому `order by q.id`). Терпіти в ній 40P01 означало б
     ковтати РЕАЛЬНИЙ дефект дисципліни під виглядом оголошеного вікна. */
  if (caseLinked && !canceller) {
    throw new Error(
      "verdictEmergencyStop: caseLinked без canceller — інверсії порядку в такій сцені немає,\n"
      + "  і терпимість до 40P01 була б безпідставною. Дайте четвертий постріл cancel_case_rpc\n"
      + "  або не вмикайте caseLinked.");
  }
  const all = [...stops, breakdown, ...(canceller ? [canceller] : [])];
  const spread = startSpreadMs(all);

  if (stops.length < 2 || !breakdown) {
    return { verdict: "FAIL", spread, reason: `учасників ${all.length}, гонки не було` };
  }

  /* 1. ДЕДЛОК — головне, заради чого сценарій існує. Стоїть першим: він
     реальний незалежно від того, довели ми одночасність чи ні. */
  const dead = all.filter((o) => o.sqlstate === DEADLOCK_SQLSTATE);
  if (dead.length) {
    /* ⚠️ У режимі caseLinked це ОГОЛОШЕНЕ вікно, і судити звідси не можна:
       Postgres називає лише жертву, а не другого учасника дедлока. Деталі —
       у шапці функції. Не PASS (це було б припущення) і не FAIL (це було б
       звинувачення бази в тому, що вона сама оголосила допустимим). */
    if (caseLinked) {
      return {
        verdict: "INCONCLUSIVE", spread,
        reason: `ОГОЛОШЕНЕ ВІКНО ${DEADLOCK_SQLSTATE} відкрилось у ${dead.map((o) => o.id).join(", ")}. `
          + "Передлок кейсів у emergency_stop_rpc бере лише in_progress-кроки, тож крок "
          + "у статусі scheduled лочить свій кейс уже з AFTER-тригера (queue→case), а "
          + "cancel_case_rpc іде case→queue. Двигун називає лише ЖЕРТВУ, тож відрізнити це "
          + "вікно від зламаної дисципліни порядку звідси НЕМОЖЛИВО — сторожем регресії "
          + "лишається прогін БЕЗ --with-case. Продукт на 40P01 не ретраїть сам: оператор "
          + "бачить «спробуйте ще раз», а зупинка НЕ СТАЛАСЬ",
        ids: dead.map((o) => o.id),
      };
    }
    return {
      verdict: "FAIL", spread,
      reason: `ДЕДЛОК ${DEADLOCK_SQLSTATE} у ${dead.map((o) => o.id).join(", ")} — `
        + "порядок захвату локів більше не детермінований (0083/0109)",
      ids: dead.map((o) => o.id),
    };
  }

  /* 2. Аварійна зупинка НЕ МАЄ падати взагалі: конфлікт інцидентів вона
     ковтає (`on conflict do nothing`), а решта причин — це зламана фікстура
     або гард ролі, тобто діагноз «не через гонку». */
  const badStops = stops.filter((o) => !o.ok);
  if (badStops.length) {
    return {
      verdict: "FAIL", spread,
      reason: "зупинка впала НЕ через гонку: "
        + badStops.map((o) => `${o.id}=${o.sqlstate}(${(o.message || "").slice(0, 60)})`).join("; "),
    };
  }
  /* «Поломці» ж програти МОЖНА і треба — але саме 23505 від індексу 0017. */
  if (!breakdown.ok && breakdown.sqlstate !== INCIDENT_TAKEN_SQLSTATE) {
    return {
      verdict: "FAIL", spread,
      reason: `«поломка» впала НЕ через гонку: ${breakdown.sqlstate}`
        + `(${(breakdown.message || "").slice(0, 60)})`,
    };
  }
  /* 2б. Скасування кейса (є лише в caseLinked). 40P01 у нього вже розібрано
     гейтом 1; будь-яка ІНША відмова — це зламана фікстура або гард ролі, тобто
     сцена не відбулась. Мовчки її пропустити означало б рахувати зеленим
     прогін, у якому четвертого учасника фактично не було — а без нього
     інверсії порядку немає, і вся терпимість до дедлока безпідставна. */
  if (canceller && !canceller.ok) {
    return {
      verdict: "FAIL", spread,
      reason: `скасування кейса впало НЕ через гонку: ${canceller.sqlstate}`
        + `(${(canceller.message || "").slice(0, 60)}) — четвертого учасника в сцені не було`,
      ids: [canceller.id],
    };
  }

  /* 3. Подвійна зупинка одного кабінету.

     ⚠️ ЧУЖИЙ КАБІНЕТ У ВІДПОВІДІ — ОКРЕМИЙ ДЕФЕКТ, а не привід мовчки його
     пропустити. Перша редакція писала `claims.get(r)?.push(...)`: кабінет,
     якого ми не просили, просто зникав з підрахунку. А означав би він, що
     RPC зупинила НЕ ТЕ, що їй передали — тобто рівно ту аварію, від якої весь
     сценарій і стереже. */
  const claims = new Map(rooms.map((r) => [r, []]));
  const strangers = [];
  const claim = (r, who) => {
    if (claims.has(r)) claims.get(r).push(who);
    else strangers.push(`${who}→${r}`);
  };
  for (const s of stops) for (const r of s.rooms || []) claim(r, s.id);
  if (breakdown.ok) claim(breakdown.room, breakdown.id);
  if (strangers.length) {
    return {
      verdict: "FAIL", spread,
      reason: `зупинено КАБІНЕТ, якого не просили: ${strangers.join(", ")}`,
      ids: strangers,
    };
  }
  const twice = [...claims].filter(([, who]) => who.length > 1);
  if (twice.length) {
    return {
      verdict: "FAIL", spread,
      reason: "КАБІНЕТ ЗУПИНЕНО ДВІЧІ: "
        + twice.map(([r, who]) => `${r} ← ${who.join(" + ")}`).join("; ")
        + " — індекс 0017 гонку не втримав",
      ids: twice.map(([r]) => r),
    };
  }

  /* 4. Стан У БАЗІ, а не у відповідях. Рівно один активний інцидент на
     кабінет — це і є інваріант, який стереже 0017. */
  const wrongDb = rooms.filter((r) => activeByRoom[r] !== 1);
  if (wrongDb.length) {
    return {
      verdict: "FAIL", spread,
      reason: "у базі не по одному активному інциденту: "
        + wrongDb.map((r) => `${r}→${activeByRoom[r]}`).join(", "),
      ids: wrongDb,
    };
  }

  /* 5. Кабінет, якого не зупинив НІХТО (при тому, що в базі інцидент є —
     значить його поставив хтось сторонній, і сцена не наша). */
  const orphan = [...claims].filter(([, who]) => who.length === 0);
  if (orphan.length) {
    return {
      verdict: "FAIL", spread,
      reason: "кабінет зупинено, але жоден наш постріл цього не заявив: "
        + orphan.map(([r]) => r).join(", ") + " — інцидент чужий, сцена не наша",
      ids: orphan.map(([r]) => r),
    };
  }

  /* 6. ОДНОЧАСНІСТЬ — останньою (канон `verdictExclusive`): дефекти вище
     реальні незалежно від того, довели ми одночасність чи ні.

     ⚠️ ТУТ ЖИВЕ ЄДИНИЙ ДОКАЗ КОНКУРЕНЦІЇ, І ВІН ЧАСОВИЙ. Перша редакція цієї
     драбинки мала окремий гейт «слід зіткнення»: 23505 у «поломки» або
     зупинка, що забрала МЕНШЕ кабінетів, ніж просила. Обидва — порожні.
     ПОСЛІДОВНИЙ прогін дає їх один-в-один: другий приходить до вже
     закомічених інцидентів, ковтає конфлікт і повертає порожній
     `stopped_rooms`, а «поломка» так само бачить активний простій і кидає
     23505. Тобто «сліди» не відрізняють гонку від черги взагалі — рівно той
     клас зеленого, проти якого написана вся ця машинерія (урок сценарію
     `case`, с62).

     Що ВІДРІЗНЯЄ: невдаха, який справді конкурував, паркується на
     advisory-локу і НЕ МОЖЕ завершитись раніше, ніж переможець закомітить.
     Тобто його вікно перетинає вікно переможця. Послідовний невдаха
     стартує вже ПІСЛЯ коміту — перетину немає за побудовою. */
  if (spread > spreadLimitMs) {
    return {
      verdict: "INCONCLUSIVE", spread,
      reason: `розкид стартів ${spread} мс > ${spreadLimitMs} мс — одночасність не доведена`,
    };
  }
  if (!windowsOverlap(all)) {
    return {
      verdict: "INCONCLUSIVE", spread,
      reason: "вікна запитів НЕ перетнулись — виклики пішли по черзі. "
        + "23505 і неповний `stopped_rooms` при цьому виглядають так само, "
        + "тож без перетину доводити нічого",
    };
  }

  /* 7. Слід чекання на локу — сильніший за простий перетин вікон. Той, хто
     нічого не забрав, мусив дочекатись коміту переможця, отже фінішує НЕ
     раніше за нього. Якщо ж він фінішував першим — його відмова прийшла з
     чогось іншого, ніж лок, і PASS був би припущенням. */
  const winners = stops.filter((s) => (s.rooms || []).length > 0);
  const empty = [...stops.filter((s) => (s.rooms || []).length === 0),
                 ...(breakdown.ok ? [] : [breakdown])];
  const lastWin = winners.length ? Math.max(...winners.map((s) => s.finishedAt)) : 0;
  const early = empty.filter((o) => o.finishedAt < lastWin);
  if (empty.length && early.length === empty.length) {
    return {
      verdict: "INCONCLUSIVE", spread,
      reason: `усі невдахи (${early.map((o) => o.id).join(", ")}) завершились РАНІШЕ за переможця `
        + "— на локу вони не чекали, тож їхня відмова не доводить серіалізації",
    };
  }

  return {
    verdict: "PASS", spread,
    reason: `дедлоку немає, кабінетів ${rooms.length} — по одному активному інциденту, `
      + `вікна перетинаються, невдах, що чекали на локу: ${empty.length - early.length}. `
      + "⚠️ Це «регресії сьогодні немає», а НЕ доказ дисципліни порядку"
      /* ⚠️ PASS у caseLinked слабший ЩЕ НА ОДИН крок, і мусить це говорити:
         оголошене вікно вузьке, тож «не відкрилось цього разу» не означає
         «не відкриється в проді». Мовчазний PASS тут читався б як «вікна
         немає» — а воно є, заміряне з тіла RPC. */
      + (caseLinked
        ? ". Сцена БУЛА зі звʼязкою кейса (скасування поруч) — оголошене вікно 40P01 "
          + "цього разу не відкрилось. Вікно вузьке: це НЕ доказ, що його немає"
        : ""),
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
