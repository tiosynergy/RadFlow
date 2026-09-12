/**
 * с63 — ГРАФІК кабінету в модалках оновлюється, поки вікно відкрите.
 *
 * ЗАМІР, ЩО ЗАВІВ ЦЕЙ ФАЙЛ. `BookingModal`, `RescheduleModal` і
 * `StudyEditModal` читали `rooms.schedule` та особливий графік дня РІВНО ОДИН
 * РАЗ — `useEffect` зі статичними залежностями, без підписки і без тика. При
 * цьому ЗАЙНЯТІСТЬ у тих самих вікнах давно жила через `useRoomBusy` з
 * realtime. Тобто половина сітки оновлювалась, а половина ні: адмін закриває
 * день або пересуває перерву — а людина з відкритим вікном необмежено довго
 * обирає слоти СТАРОГО графіка і дізнається про це лише з відмови сервера
 * після «Зберегти».
 *
 * ⚠️ ЧОМУ САМЕ СТОРОЖ, А НЕ РАЗОВА ПРАВКА. Тут три тихі способи відкотити
 * пакет, і жоден із них не видно на екрані:
 *   (1) прибрати виклик хука в одній із трьох модалок — решта оновлюються, і
 *       регресію помітить лише той, хто відкриє саме її;
 *   (2) лишити виклик, але передати в `onChange` не той лоадер (або no-op);
 *   (3) лишити хук і прибрати ВЛАСНИЙ ефект первинного читання — підписки
 *       позначені `skipInitial`, тож вікно відкриється БЕЗ графіка і чекатиме
 *       першої події. Рівно та регресія, яку `skipInitial` робить можливою
 *       (урок U-62/Д5).
 *
 * ⚠️ Компонентних тестів у проєкті немає навмисно (`vitest.config.ts` —
 * environment: "node"), тож три перші describe — сторожі ФОРМИ. Межа
 * усвідомлена і тому названа: поведінковий бік (`SCHED_POLL_MS`) перевіряється
 * значенням, а не текстом.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { codeOf } from "./helpers/codeOf";
import { SCHED_POLL_MS } from "../lib/useScheduleRefetch";

/** ⚠️ `codeOf` знімає коментарі: інакше половина пінів нижче задовольнялась би
    ПРОЗОЮ про правку, а не самою правкою (урок с46). */
const src = (p: string) => codeOf(readFileSync(resolve(process.cwd(), p), "utf8"));

/** Три вікна з сіткою слотів: `scope` і ЗАМІРЯНЕ число звірок покоління в
    лоадері. Третє число різне не випадково: `StudyEditModal` виходить із
    лоадера ДО читання оверрайда, якщо немає дати або кабінету, тож гілки
    «кабінет не обраний» у нього немає взагалі. */
const MODALS: Array<[file: string, scope: string, genGuards: number]> = [
  ["components/BookingModal.tsx", "booking", 5],
  ["components/RescheduleModal.tsx", "resched", 5],
  ["components/StudyEditModal.tsx", "study", 4],
];

/** Тіло лоадера графіка: від `const loadSched = useCallback` до ефекту, який
    його кличе. Потрібне окремо, бо в цих файлах є ІНШІ ефекти зі своїм
    `cancel`, і перевірки нижче не мають їх бачити. */
function loaderBody(file: string): string {
  const code = src(file);
  const from = code.indexOf("const loadSched = useCallback");
  const to = code.indexOf("useEffect(() => { setSchedLoading(true); loadSched(); }", from);
  expect(from, `${file}: лоадер графіка не знайдено — сторож застарів`).toBeGreaterThan(-1);
  expect(to, `${file}: ефект первинного читання не знайдено — сторож застарів`).toBeGreaterThan(from);
  return code.slice(from, to);
}

describe("с63 — зелена лінія: у всіх трьох вікнах лоадер графіка є", () => {
  /* Без цієї половини всі піни нижче нефальсифіковані: якби файл читався не
     той, «не знайшли» збіглося б із очікуванням. */
  it.each(MODALS)("%s: лоадер читає графік кабінету", (file) => {
    expect(loaderBody(file), `${file}: у лоадері немає читання rooms.schedule`)
      .toMatch(/from\("rooms"\)\s*\.select\("schedule"\)/);
  });
});

describe("с63 — кожне вікно підписане на зміни графіка", () => {
  it.each(MODALS)("%s: кличе useScheduleRefetch зі СВОЇМ лоадером", (file) => {
    const code = src(file);
    /* Пінимо АРГУМЕНТ, а не факт виклику: `onChange: () => {}` — найдешевший
       спосіб лишити виклик на місці й зробити його мертвим. */
    expect(code, `${file}: useScheduleRefetch не отримує loadSched`)
      .toMatch(/useScheduleRefetch\(\{[^}]*onChange: loadSched[^}]*\}\)/);
  });

  it.each(MODALS)("%s: хук береться з lib і не перекритий локально", (file) => {
    const code = src(file);
    /* Той самий прийом, що в U-13: імʼя можна ПЕРЕКРИТИ локальною обгорткою,
       яка нічого не робить, і всі піни вище лишаться зеленими. */
    expect(code, `${file}: хук більше не імпортується з lib`)
      .toMatch(/import \{ useScheduleRefetch \} from "@\/lib\/useScheduleRefetch";/);
    expect(code, `${file}: хук перекритий локальним оголошенням`)
      .not.toMatch(/(const|let|function)\s+useScheduleRefetch\b/);
  });

  it.each(MODALS)("%s: передає клініку, дату і кабінет — а не частину з них", (file) => {
    const call = /useScheduleRefetch\(\{[^}]*\}\)/.exec(src(file));
    expect(call, `${file}: виклик хука не знайдено`).not.toBeNull();
    const c = (call as RegExpExecArray)[0];
    /* ⚠️ `clinicId` і `dateStr` — умови КАНАЛУ: без них хук вимикається цілком
       (краще без realtime, ніж без фільтра — U-61). Якщо викликач перестане їх
       передавати, вікно тихо повернеться до «читаємо один раз». */
    expect(c, `${file}: без clinicId канал не створюється — підписки не буде`).toMatch(/\bclinicId\b/);
    /* ⚠️ Саме `\b…\b`, а не `dateStr:` — два з трьох вікон передають скорочено
       (`{ clinicId, dateStr, roomId }`), і пін на двокрапку червонив би їх на
       рівному місці. Знайдено першим же прогоном. */
    expect(c, `${file}: без dateStr канал не створюється — підписки не буде`).toMatch(/\bdateStr\b/);
    expect(c, `${file}: без roomId імʼя каналу не розрізняє кабінети`).toMatch(/\broomId\b/);
  });

  /* ⚠️ ОКРЕМИЙ тест, а не шостий `expect` вище: правило проєкту — одне
     твердження, одне імʼя, інакше стенд не може сказати, що саме почервоніло. */
  it.each(MODALS)("%s: scope саме той, що заміряний", (file, scope) => {
    const call = /useScheduleRefetch\(\{[^}]*\}\)/.exec(src(file));
    expect(call, `${file}: виклик хука не знайдено`).not.toBeNull();
    expect((call as RegExpExecArray)[0], `${file}: scope не той, що заміряний`)
      .toMatch(new RegExp('scope: "' + scope + '"'));
  });

  it("scope у трьох вікон РІЗНІ", () => {
    /* `RescheduleModal` монтує всередині себе `BookingModal` (шлях
       «переоформлення в інший кабінет»), тож два виклики хука з тим самим
       кабінетом і датою живуть ОДНОЧАСНО. Однаковий scope означав би два
       канали Supabase з однаковою назвою. */
    const scopes = MODALS.map(([, s]) => s);
    expect(new Set(scopes).size, "scope продубльовано — два вікна просять канал з однаковою назвою")
      .toBe(scopes.length);
  });
});

describe("с63 — первинне читання лишилось за власним ефектом", () => {
  /* ⚠️ НАЙВАЖЛИВІШИЙ ПІН ФАЙЛА (той самий, що в `realtimeInitialLoad` для
     `WaitlistBoard`). Підписки хука позначені `skipInitial`; приберіть цей
     ефект — і вікно відкриється БЕЗ графіка, чекаючи першої чужої події. */
  it.each(MODALS)("%s: ефект первинного читання на місці", (file) => {
    expect(src(file), `${file}: зник ефект первинного читання графіка`)
      .toMatch(/useEffect\(\(\) => \{ setSchedLoading\(true\); loadSched\(\); \}, \[loadSched\]\);/);
  });

  it.each(MODALS)("%s: прапорець завантаження НЕ всередині лоадера", (file) => {
    /* Інакше сітка блимала б «завантаження» на кожній події і на кожному тику
       30 с — фонове перечитування виглядало б збоєм. */
    expect(loaderBody(file), `${file}: setSchedLoading(true) переїхав у лоадер`)
      .not.toMatch(/setSchedLoading\(true\)/);
  });
});

describe("с63 — гонка: фонове перечитування не перетирає новий кабінет/дату", () => {
  /* ⚠️ ЦЕ НЕ КОСМЕТИКА, а те, що правка зробила ОБОВʼЯЗКОВИМ. Доти лоадер жив
     усередині ефекту, і його `cancel` знімався при зміні залежностей. Тепер
     лоадер кличуть і ЗЗОВНІ (подія, тик) — на такий виклик `cancel` із чужого
     замикання не діє взагалі, і відповідь по старому кабінету перетерла б
     новий. Взірець — `genRef` у `useRoomBusy`. */
  it.each(MODALS)("%s: лоадер бере покоління на вході", (file) => {
    /* ⚠️ Імʼя біндера НЕ пінимо (`req`/`gen` — те саме): пін на імʼя зробив би
       звичайне перейменування червоним, тобто сторож змушував би переписувати
       робочий код заради себе (урок U-55). Пінимо ФОРМУ: щось інкрементується з
       `schedReqRef` на вході в лоадер. */
    expect(loaderBody(file), `${file}: лічильник поколінь зник`)
      .toMatch(/const \w+ = \+\+schedReqRef\.current;/);
  });

  it.each(MODALS)("%s: у лоадері немає прапорця cancel із замикання ефекту", (file) => {
    expect(loaderBody(file), `${file}: повернувся cancel — на фоновий виклик він не діє`)
      .not.toMatch(/\bcancel\b/);
  });

  it.each(MODALS)("%s: звірок поколінь рівно стільки, скільки гілок запису", (file, _scope, genGuards) => {
    /* ⚠️ Пін на ЧИСЛО, а не на «є хоч одна». Гонку відкриває ОДИН незвірений
       запис у стан, тож «хоч одна звірка» — підпис ширший за доказ. Заміряні
       значення живуть у таблиці MODALS поруч зі `scope`; зміна числа має
       змусити прочитати цей файл, а не пройти тихо. */
    const body = loaderBody(file);
    const decl = /const (\w+) = \+\+schedReqRef\.current;/.exec(body);
    expect(decl, `${file}: лічильник поколінь не знайдено — сторож застарів`).not.toBeNull();
    const name = (decl as RegExpExecArray)[1];
    const writes = (body.match(/set(Override|RoomSchedule|SchedErr|SchedLoading)\(/g) || []).length;
    expect(writes, `${file}: записів у стан графіка не знайдено — сторож застарів`).toBeGreaterThan(0);
    const guards = (body.match(new RegExp("\\b" + name + " (!==|===) schedReqRef\\.current", "g")) || []).length;
    expect(guards, `${file}: звірок поколінь стало ${guards} замість ${genGuards}`).toBe(genGuards);
  });
});

describe("с63 — сам хук: поверхня підписки і період тика", () => {
  const hook = src("lib/useScheduleRefetch.ts");

  it("обидві підписки фільтровані по клініці", () => {
    /* U-61: без фільтра підписка отримує подію про КОЖНЕ видалення в цій
       таблиці по всій базі — крос-тенантний оракул. Загальний сканер
       (`realtimeSubscriptionSurface`) це вже ловить; тут пін на те, що фільтр
       саме `clinic_id`, а не будь-який. */
    expect(hook).toMatch(/table: "schedule_overrides", filter: "clinic_id=eq\." \+ clinicId/);
    expect(hook).toMatch(/table: "rooms", filter: "clinic_id=eq\." \+ clinicId/);
  });

  it("обидві підписки позначені skipInitial", () => {
    /* Інакше кожне відкриття вікна читало б графік ДВІЧІ: власний ефект плюс
       первинний `callAll` хука (урок U-62/Д5). */
    const subs = hook.split("\n").filter((l) => /\{ table: "/.test(l));
    expect(subs.length, "склад підписок хука змінився").toBe(2);
    for (const l of subs) expect(l, `підписка без skipInitial: ${l.trim().slice(0, 80)}`).toContain("skipInitial: true");
  });

  it("без клініки або без дати канал не створюється зовсім", () => {
    /* Fail-closed: порожня клініка дала б фільтр `clinic_id=eq.undefined`, а
       зняти фільтр означало б повернути оракул. */
    expect(hook).toMatch(/channelName: enabled && clinicId && dateStr/);
  });

  it("тик графіка дорівнює тику зайнятості — інакше половини сітки розходяться", () => {
    /* ⚠️ Єдина ПОВЕДІНКОВА перевірка файла, і вона не про текст. Для
       направника подій по `schedule_overrides` немає взагалі (0183 зняла
       `sched_referrer_read`), тож тик — єдиний шлях доставки, і саме це
       записано в самій міграції. Якщо періоди розійдуться, зʼявляться кадри, у
       яких зайнятість уже нова, а межі дня ще старі. */
    expect(SCHED_POLL_MS).toBe(30_000);
    expect(src("lib/slotBusy.ts"), "тик зайнятості змінився — звірте з SCHED_POLL_MS")
      .toMatch(/pollWhenSubscribedMs: 30_000/);
  });
});
