"use client";

/* ===== RadFlow — стан, похідний від «сьогодні», слідує за поправкою годинника =====
   U-70 (дошки) → U-72 (форми, які ПИШУТЬ дату в БД).

   ЧОМУ ЦЕ ІСНУЄ. U-70 перевів настінний канон (`wallNow`) на ВИМІРЯНИЙ годинник
   бази. Зсув приїжджає асинхронно — вже після того, як екран зафіксував свою
   дату першим рендером (`useState(() => wallToday0(tz))` і подібне), і потім
   ще раз кожні 10 хвилин та на `visibilitychange`. Якщо поправка перетинає
   північ клініки, зафіксоване значення протухає, а решта екрана рахує вже за
   новою добою — екран показує або ЗАПИСУЄ чужу добу.

   ЦІНА РІЗНА, І ЦЕ ВАРТО НАЗВАТИ. На дошках (U-70) наслідок гучний: `isToday`
   хибний, «Викликати» заблоковано, у радіолога `isPast` вмикає read-only. У
   формах (U-72) наслідок ТИХИЙ і дорожчий: `BookingModal`, `ReferralPortal`,
   `RescheduleModal` віддають свою дату прямо в `scheduled_date`, а
   `WaitlistModal` — у `desired_date_from`. Причому напрямок зсуву не
   симетричний: коли ПК ВІДСТАЄ, зафіксована дата стає МИНУЛОЮ і гарди
   («минулий день», `isPastDay`) її ловлять — відмова гучна, дані цілі; коли ПК
   СПІШИТЬ, зафіксована дата стає МАЙБУТНЬОЮ, а запис у майбутнє легальний, і
   не спрацьовує НІЧОГО. Саме другий напрямок і є причина пакета.

   ОДИН ЕКЗЕМПЛЯР НА ВСІХ — свідомо. У цьому проєкті вже тричі розходились дві
   копії одного правила (гейт `safetyUnknown`, дзеркало вікна виклику, годинник
   у шапці). Тут споживачів було б сім.

   ⚠️ ПИТАННЯ, НА ЯКЕ ВІДПОВІДАЄ ПРАВИЛО — «чи перенесла добу сама ПОПРАВКА»,
   а не «чи змінилась доба з минулого разу» (знахідка ревʼю А по U-70, HIGH).
   Перша редакція порівнювала ключ доби з тим, що лишився від попереднього
   запуску ефекту, тож справжня північ при відкритому екрані лишала по собі
   ПРОТУХЛИЙ ключ: наступна ж поправка — будь-яка, хоч на секунду і хоч через
   10 хвилин — читала цю різницю як свою. Тобто правило не «не реагувало на
   північ», воно ВІДКЛАДАЛО реакцію на північ до найближчого перезаміру.
   Тепер обидві доби рахуються від ОДНОГО Й ТОГО САМОГО `Date.now()` різними
   зсувами — до поправки і після; різниця може бути тільки поправчина, і від
   таймінгу рендерів вона не залежить зовсім.

   ⚠️ НА СПРАВЖНЮ ПІВНІЧ ПРАВИЛО НЕ РЕАГУЄ, і це не недогляд. Екран, відкритий
   о 23:59, о 00:00 лишається на вчорашній добі — так було до пакета, і міняти
   цю поведінку U-70/U-72 не збирались: оператор може дописувати вчорашній день.
   Закривається рівно те, що створив сам перехід на виміряний годинник. */

import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { clockOffsetMs } from "./serverClock";
import { wallDayKeyAt } from "./incidents";
import { dateKeyOf } from "./schedule";
import { useClockEpoch } from "./useClockEpoch";

/** Локальна північ дати з ключа «YYYY-MM-DD» — той самий фрейм, що віддає
    `wallToday0` (локальна північ, календарний день клініки).
    ⚠️ Саме `key + "T00:00:00"`, а НЕ `new Date(key)` (знахідка ревʼю Б): голий
    ключ ECMAScript парсить як UTC-північ, і в будь-якій зоні на захід від
    Гринвіча локальні гетери дадуть попередню добу — правило тихо померло б
    (портал направника глобальний за призначенням). У тестах TZ=Europe/Kyiv,
    тож поведінково цю підміну там не спіймати — тому на неї стоїть пін. */
export function dayOfKey(key: string): Date {
  return new Date(key + "T00:00:00");
}

/** Зсув на N діб У ФРЕЙМІ КАЛЕНДАРНОЇ ДАТИ (через локальні частини, як усі
    `dateKey`/`today0` у компонентах), а не додаванням 86 400 000 мс: у добу з
    переходом на літній час арифметика в мілісекундах дала б 23 або 25 годин і
    зсунула б дату. */
function shiftDays(d: Date, n: number): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (n) x.setDate(x.getDate() + n);
  return x;
}

export type FollowTodayCommon = {
  /** Зона клініки/центру — та сама, з якої екран рахує своє «сьогодні». */
  clinicTz?: string;
  /** Дата, обрана ЯВНО (deep-link «Пошук», prefill) — її не переносимо. */
  pinnedKey?: string | null;
  /** Дію не можна переривати (відкрита модалка поверх, збереження в польоті).
      Перенесення не скасовується, а ВІДКЛАДАЄТЬСЯ до зняття прапорця. */
  busy?: boolean;
  /** На скільки діб значення відстоїть від «сьогодні»: 0 — саме сьогодні,
      1 — «завтра» (дефолт форм переносу/обдзвону), −6 — початок тижневого
      діапазону журналу. Переносимо, лише якщо поточне значення ДОСІ дорівнює
      цьому дефолту за старим годинником, тобто користувач його не міняв. */
  offsetDays?: number;
  /** Викликається ПІСЛЯ фактичного перенесення (не викликається, якщо значення
      лишили як є). Потрібен формам для двох речей, і обидві названі ревʼю А:
        • СКИНУТИ ОБРАНИЙ СЛОТ. Ручна зміна дати в усіх трьох формах запису
          робить `setTime("")` — а автоперенесення без цього лишало б слот від
          іншої доби. Наслідок був гірший за сам дефект: оператор диктує
          пацієнту «друге вересня, девʼята», дата тихо їде на перше, слот
          «09:00» лишається валідним, і в БД потрапляє день, якого пацієнт не
          чув. Правило слот не чіпає саме — це справа форми;
        • СКАЗАТИ ОПЕРАТОРУ. Дата змінилась сама, а поле дати в двоколонковій
          формі часто поза полем зору (ПІБ ліворуч, календар праворуч). Без
          повідомлення будь-яке «правило саме поправило» невідрізнюване від
          «нічого не сталось». */
  onShift?: (nextDay: Date) => void;
};

/** Рішення ядра: що робити з відкладеним перенесенням і чи застосовувати його
    ЗАРАЗ. `applyFrom`/`applyTo` — ключі старої і нової доби; null = не час. */
export type ShiftDecision = {
  pendingKey: string | null;
  applyFrom: string | null;
  applyTo: string | null;
};

/** ЧИСТЕ РІШЕННЯ ЯДРА.

    ⚠️ Винесено з ефекту після ревʼю Б (три знахідки MEDIUM в одну точку). Поки
    воно жило всередині хука, ТРИ його властивості трималися лише текстовими
    пінами — тобто доводили наявність рядка, а не вердикт:
      • відкладання під `busy` (перестановка одного рядка перетворювала
        «відкласти» на «викинути», і пін лишався зеленим);
      • «ключ задає лише ПЕРША незастосована поправка» (зняття половини умови
        не червонило нічого);
      • те, що обидві доби рахуються від ОДНОГО моменту.
    Останнє до цієї правки було ще й НЕПРАВДОЮ: `before` брався від
    `Date.now()`, а `after` — від власного `Date.now()` усередині `wallDayKey`.
    Шапка модуля стверджувала протилежне. Тепер момент один — параметр `nowMs`.

    ⚠️ «Лише перша поправка задає ключ» — не оптимізація. Дві поправки поспіль
    (штатно буває при поверненні з фонової вкладки: `ServerClockSync` міряє на
    `visibilitychange`) під `busy` затерли б ключ на ПРОМІЖНУ добу, а значення
    лишилось би на вихідній — і `followedDay` не впізнав би дефолт, тобто
    перенесення тихо не сталось би зовсім. */
export function decideShift(args: {
  prevOffsetMs: number;
  nowOffsetMs: number;
  pendingKey: string | null;
  nowMs: number;
  busy?: boolean;
  clinicTz?: string;
}): ShiftDecision {
  const { prevOffsetMs, nowOffsetMs, pendingKey, nowMs, busy, clinicTz } = args;
  let pending = pendingKey;
  if (nowOffsetMs !== prevOffsetMs) {
    const before = wallDayKeyAt(nowMs + prevOffsetMs, clinicTz);   // доба за СТАРИМ годинником
    const after = wallDayKeyAt(nowMs + nowOffsetMs, clinicTz);     // доба за НОВИМ, ТОЙ САМИЙ момент
    if (before !== after && pending === null) pending = before;
  }
  /* ⚠️ ПІД ВІДКРИТОЮ МОДАЛКОЮ / ЗБЕРЕЖЕННЯМ — ЧЕКАЄМО, а не пропускаємо
     (знахідка ревʼю А, MEDIUM). Це не косметика: `StudyEditModal` отримує
     `scheduledDate`, `ScheduleEditModal` — `date`, і зміна дати посеред
     заповнення записала б редагування в ІНШУ добу. Перенесення саме
     ВІДКЛАДАЄТЬСЯ (ключ лишається в `pendingKey`), а не губиться — інакше ми
     міняли б одну тиху ваду на іншу. */
  if (pending === null || busy) return { pendingKey: pending, applyFrom: null, applyTo: null };
  const to = wallDayKeyAt(nowMs + nowOffsetMs, clinicTz);
  /* ⚠️ ФАНТОМНЕ ПЕРЕНЕСЕННЯ (знахідка ревʼю Б, с51, HIGH). `applyFrom` — доба
     на момент ВІДКЛАДАННЯ, `applyTo` — доба на момент ЗВІЛЬНЕННЯ, і вони
     можуть збігтися: поправка з'їхала і повернулась, поки була відкрита
     модалка. Без цієї перевірки `followedDay` чесно повертав НОВИЙ обʼєкт тієї
     самої доби, а споживач кликав `onShift` — тобто форма стирала обраний
     слот і показувала банер «дату змінено на …» з ТІЄЮ САМОЮ датою. Екран
     брехав і забирав роботу оператора, зроблену за час відкладання.
     ⚠️ Тест «поправка туди-назад» іменувався «no-op за смислом» і при цьому
     ЗАКРІПЛЮВАВ старе значення — тобто називав властивість, якої в коді не
     було. Це рівно той клас, проти якого писався весь пакет. */
  if (to === pending) return { pendingKey: null, applyFrom: null, applyTo: null };
  return { pendingKey: null, applyFrom: pending, applyTo: to };
}

/** ЧИСТИЙ КРОК ЕФЕКТУ: памʼять хука на вході — памʼять хука на виході.
 *
 *  ⚠️ ВИНЕСЕНО В с51 ПІСЛЯ РЕВʼЮ А, і це виправлення моєї помилки. Спершу я
 *  закрив проводку хука ПІНАМИ ПО ДЖЕРЕЛУ і написав, що поведінкового тесту
 *  «тут бути не може». Ревʼю А показало, що це неправда: з десяти несучих
 *  фактів проводки піни тримали чотири, а одна однорядкова мутація
 *  (`nowOffsetMs: nowOffset` → `nowOffsetMs: prevOffsetRef.current`) робить
 *  `prevOffsetMs === nowOffsetMs` тотожно, вбиває U-70 і U-72 ЦІЛКОМ — і
 *  лишає зеленими всі чотири піни, tsc і eslint. Тобто «не може» означало
 *  «я не став виносити далі».
 *
 *  Тепер перенесення зсуву, доля відкладеного ключа і сам факт виклику —
 *  ПОВЕДІНКА, яку видно з `environment: "node"`. В ефекті лишились рівно
 *  зчитування годинника, запис двох ref-ів і виклик; що з цього НЕ тримається
 *  поведінкою — перелічено в пінах `tests/followToday.test.ts`. */
export function stepClockShift(
  state: { prevOffsetMs: number; pendingKey: string | null },
  input: { nowOffsetMs: number; nowMs: number; busy?: boolean; clinicTz?: string },
): { prevOffsetMs: number; pendingKey: string | null; apply: { from: string; to: string } | null } {
  const d = decideShift({
    prevOffsetMs: state.prevOffsetMs,
    nowOffsetMs: input.nowOffsetMs,
    pendingKey: state.pendingKey,
    nowMs: input.nowMs,
    busy: input.busy,
    clinicTz: input.clinicTz,
  });
  return {
    /* Наступний крок мусить порівнюватись із ЦИМ зсувом, інакше друга поправка
       міряється від першої і привласнює собі чужий перехід. */
    prevOffsetMs: input.nowOffsetMs,
    pendingKey: d.pendingKey,
    apply: d.applyFrom && d.applyTo ? { from: d.applyFrom, to: d.applyTo } : null,
  };
}

/** ЯДРО-ХУК. Викликає `apply(prevDay, nextDay)`, коли поправка годинника
    перенесла добу клініки. Уся логіка — у `decideShift` і `stepClockShift`
    вище; тут лишились рівно годинник, два ref-и і виклик. */
function useClockDayShift(
  apply: (prevDay: Date, nextDay: Date) => void,
  { clinicTz, busy }: { clinicTz?: string; busy?: boolean },
): void {
  const epoch = useClockEpoch();          // не читається в тілі — це БУДИЛЬНИК ефекту
  const prevOffsetRef = useRef(clockOffsetMs());
  const pendingKeyRef = useRef<string | null>(null);
  /* Свіжий `apply` без перепідписки ефекту. ⚠️ Присвоєння живе в ЕФЕКТІ, а не
     в тілі рендера (знахідка ревʼю Б): React має право відрендерити дерево і
     викинути результат, а мутація ref пережила б викинутий рендер — і ефект
     закоміченого рендера покликав би замикання, якого в дереві не було.
     Ефект без списку залежностей оголошений ПЕРШИМ, тож на кожен коміт він
     відпрацьовує до основного. */
  const applyRef = useRef(apply);
  useEffect(() => { applyRef.current = apply; });

  useEffect(() => {
    const s = stepClockShift(
      { prevOffsetMs: prevOffsetRef.current, pendingKey: pendingKeyRef.current },
      { nowOffsetMs: clockOffsetMs(), nowMs: Date.now(), busy, clinicTz },
    );
    prevOffsetRef.current = s.prevOffsetMs;
    pendingKeyRef.current = s.pendingKey;
    if (s.apply) applyRef.current(dayOfKey(s.apply.from), dayOfKey(s.apply.to));
  }, [epoch, busy, clinicTz]);
}

/** ЧИСТЕ ПРАВИЛО — яким має стати значення після того, як поправка перенесла
    добу `prevDay` → `nextDay`. `null` = лишити як є.

    ⚠️ Винесено окремо НЕ заради краси. `environment: "node"`, компонентних
    тестів у проєкті немає за задумом — тож усе, що лишиться всередині хука,
    можна пінувати лише статично по джерелу, а це доводить наявність рядка, а
    не вердикт. Тут живе весь вибір («користувач сам обрав дату?», «дата
    прийшла ззовні явно?», «на скільки діб зсунути»), і його перевіряють
    ВИКЛИКОМ. ОДНЕ місце на обидва варіанти стану — інакше правило «не чіпати
    обране користувачем» розійшлось би між ними. */
export function followedDay(args: {
  prevDay: Date;
  nextDay: Date;
  curKey: string;
  offsetDays?: number;
  pinnedKey?: string | null;
}): Date | null {
  const { prevDay, nextDay, curKey, offsetDays = 0, pinnedKey } = args;
  // Дефолт за СТАРИМ годинником. Не збігся — користувач обрав дату сам.
  if (curKey !== dateKeyOf(shiftDays(prevDay, offsetDays))) return null;
  /* Дата прийшла ззовні явно (deep-link «Пошук», prefill із картки пацієнта):
     оператор прийшов саме по неї, і забрати її з-під нього означає зламати
     єдину причину переходу. Щойно він піде з цієї дати сам — правило знову діє. */
  if (pinnedKey && curKey === pinnedKey) return null;
  return shiftDays(nextDay, offsetDays);
}

/** Стан-ДАТА, похідний від «сьогодні» (`useState(() => wallToday0(tz))` і т.п.).

    ⚠️ Поточне значення приходить ПАРАМЕТРОМ `value`, а не читається у
    функціональному апдейтері — і це не стиль. По-перше, рішення тоді ухвалюється
    поза апдейтером, тож `onShift` (побічна дія форми) не залежить від того,
    скільки разів React покличе апдейтер у StrictMode. По-друге, споживач і так
    тримає це значення в руках; читати його з ефекту через свіжий `applyRef` —
    той самий рендерний знімок, що бачить оператор. */
export function useFollowToday(
  opts: FollowTodayCommon & { value: Date; setDate: Dispatch<SetStateAction<Date>> },
): void {
  const { clinicTz, pinnedKey, busy, offsetDays = 0, value, setDate, onShift } = opts;
  useClockDayShift((prevDay, nextDay) => {
    const next = followedDay({ prevDay, nextDay, curKey: dateKeyOf(value), offsetDays, pinnedKey });
    if (!next) return;
    setDate(next);
    onShift?.(next);
  }, { clinicTz, busy });
}

/** Те саме для стану-КЛЮЧА «YYYY-MM-DD» (форми з `<input type="date">`). */
export function useFollowTodayKey(
  opts: FollowTodayCommon & { value: string; setKey: Dispatch<SetStateAction<string>> },
): void {
  const { clinicTz, pinnedKey, busy, offsetDays = 0, value, setKey, onShift } = opts;
  useClockDayShift((prevDay, nextDay) => {
    const next = followedDay({ prevDay, nextDay, curKey: value, offsetDays, pinnedKey });
    if (!next) return;
    setKey(dateKeyOf(next));
    onShift?.(next);
  }, { clinicTz, busy });
}
