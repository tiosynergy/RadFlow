/* Аудит с46, U-3 / U-4 / U-7 — проковтнута помилка читання.
 *
 * Один клас на три знахідки. PostgREST НЕ кидає: він повертає {data, error}.
 * Якщо `error` не подивитись, збій читання перетворюється на порожні дані, а
 * порожні дані екран показує як ФАКТ:
 *
 *  • U-3 RescheduleModal: `ovRes.error` не перевірявся (сусідній `roomRes.error`
 *    — перевірявся) → «особливого дня немає»: закритий святковий день малювався
 *    робочим, скорочений — повним;
 *  • U-4 StudyEditModal: не перевірялась ЖОДНА з двох помилок → графік кабінету
 *    відкочувався на хардкод 08–18, і тривалість дослідження можна було
 *    розтягнути за реальне закриття та крізь перерву без жодної згоди. Коментар
 *    «сітку прикриє busyErr» був фактично хибним: busyErr — інше джерело;
 *  • U-7 CeoDashboard: помилка НАВІТЬ НЕ ЗВʼЯЗУВАЛАСЬ (`const { data: rdata }`)
 *    → rooms=[] → capacityMin=0 → «0% завантаж.» ЧЕРВОНИМ і «Кабінетів немає».
 *    Керівник читав збій читання як «апарати простоюють».
 *
 * Ревʼю пакета додало четверте, суміжне: «не читали» — теж «не знаємо». Порожній
 * рядок від maybeSingle() (кабінет невидимий за RLS / видалений) і пропущене
 * читання (немає кабінету або дати) давали той самий хардкод 08–18, лише без
 * помилки; а прочитане при збої лишалось на екрані від ПОПЕРЕДНЬОЇ дати.
 *
 * Урок пакета U-8 (правило, застосоване руками, забудуть) тут застосований до
 * читань: головний сторож — СКАНЕР. Він знаходить КОЖНЕ читання rooms/
 * schedule_overrides у цих екранах сам і вимагає, щоб помилку подивились. Нове
 * читання (або нова форма виклику, якої сканер не знає) робить тест червоним —
 * тобто наступного порушника знаходить сам тест, а не наступний аудит.
 *
 * ⚠️ Межі сканера (свідомі): він бачить лише ЛІТЕРАЛЬНЕ імʼя таблиці у .from().
 * `.from(TBL)` зі змінною лишиться непоміченим — статично це не ловиться без
 * типізації. Так само він перевіряє, що error ПРОЧИТАЛИ, а не що з ним щось
 * зробили: `if (x.error) {}` пройде. Обидва обмеження задокументовані навмисно.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { codeOf } from "./helpers/codeOf";

const src = (p: string) => codeOf(readFileSync(resolve(process.cwd(), p), "utf8"));

/* Екрани, які СТВЕРДЖУЮТЬ щось про кабінет: межі слота, сітку дня, завантаженість
   апаратів. Саме тут «порожньо» і «не знаємо» — різні речі. */
const FILES = [
  "components/BookingModal.tsx",
  "components/ReferralPortal.tsx",
  "components/RescheduleModal.tsx",
  "components/StudyEditModal.tsx",
  "components/CollisionPanel.tsx",
  "components/CeoDashboard.tsx",
];

/* Лапки будь-які: одинарні/зворотні теж мають потрапляти в скан, інакше
   найдешевший спосіб обійти сторожа — написати .from('rooms'). */
const TABLE_RE = /\.from\(\s*["'`](rooms|schedule_overrides)["'`]\s*\)/g;

/* ── Розбір форм виклику ────────────────────────────────────────────────────
   Три законні форми:
     F1 «named»        const res = await supabase.from("rooms")…;    → res.error
     F2 «destructured» const { data, error } = await supabase.from(…) → error у шаблоні
     F3 «promise-all»  const [ov, inc, roomRes] = await Promise.all([ …from… ]);
                       → ov.error ?? inc.error ?? roomRes.error
   Форма, якої тут немає, свідомо вважається НЕВІДОМОЮ і валить тест: автор має
   або привести виклик до відомої форми, або дописати сюди розбір — але не
   пройти повз мовчки. Саме так сканер не сліпне на новому синтаксисі. */

/** Межі рядкових літералів пропускаємо: у select() кома всередині
    "room_id, started_at" — НЕ роздільник елементів Promise.all. */
function scanArray(code: string, arrayOpen: number, target: number): { k: number | null; end: number } {
  let depth = 0, commas = 0, quote = "";
  for (let i = arrayOpen; i < code.length; i++) {
    const ch = code[i];
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return { k: i > target ? commas : null, end: i };
    } else if (ch === "," && depth === 1 && i < target) commas++;
  }
  return { k: null, end: code.length };
}

type Occ = { table: string; index: number; form: "named" | "destructured" | "promise-all" | "unknown"; binder: string; checkFrom: number };

function occurrences(code: string): Occ[] {
  const out: Occ[] = [];
  for (const m of code.matchAll(TABLE_RE)) {
    const ix = m.index as number;
    const table = m[1];
    const before = code.slice(Math.max(0, ix - 200), ix);

    // F1 — результат зв'язаний іменем безпосередньо перед .from(...)
    const named = before.match(/(?:const|let)\s+(\w+)\s*=\s*await\s+supabase\s*$/);
    if (named) { out.push({ table, index: ix, form: "named", binder: named[1], checkFrom: ix }); continue; }

    // F2 — деструктуризація: приймається ЛИШЕ якщо в шаблоні справді є error
    const destr = before.match(/(?:const|let)\s*\{([^}]*)\}\s*=\s*await\s+supabase\s*$/);
    if (destr && /\berror\b/.test(destr[1])) { out.push({ table, index: ix, form: "destructured", binder: "", checkFrom: ix }); continue; }

    // F3 — елемент масиву Promise.all з деструктуризацією імен вище
    const pa = code.lastIndexOf("Promise.all([", ix);
    const open = pa >= 0 ? pa + "Promise.all(".length : -1;
    const arr = open >= 0 ? scanArray(code, open, ix) : { k: null, end: -1 };
    const names = pa >= 0 ? code.slice(Math.max(0, pa - 200), pa).match(/(?:const|let)\s*\[([^\]]*)\]\s*=\s*await\s*$/) : null;
    if (arr.k !== null && names) {
      const list = names[1].split(",").map((s) => s.trim()).filter(Boolean);
      if (list[arr.k]) { out.push({ table, index: ix, form: "promise-all", binder: list[arr.k], checkFrom: arr.end }); continue; }
    }

    out.push({ table, index: ix, form: "unknown", binder: "", checkFrom: ix });
  }
  return out;
}

/* Межа слова обов'язкова: без неї сторож із binder="res" задовольняється чужим
   "ovRes.error" у тому ж вікні (ревʼю пакета, знахідка 7). */
const consultsError = (window: string, binder: string) =>
  new RegExp("(^|[^\\w$.])" + binder + "\\.error\\b").test(window);

describe("Сканер: кожне читання rooms/schedule_overrides дивиться на error", () => {
  for (const f of FILES) {
    const code = src(f);
    const occ = occurrences(code);

    it(f + " — читання є і всі вони у ВІДОМІЙ формі", () => {
      // Якщо читань не лишилось узагалі — сторож перестав щось охороняти, і про це
      // треба знати: файл або перейменували, або читання переїхало.
      expect(occ.length).toBeGreaterThan(0);
      expect(occ.filter((o) => o.form === "unknown").map((o) => o.table + "@" + o.index)).toEqual([]);
    });

    for (const o of occ.filter((x) => x.form !== "destructured")) {
      it(f + " — " + o.table + " (" + o.form + ", " + o.binder + "): error перевірено", () => {
        expect(consultsError(code.slice(o.checkFrom, o.checkFrom + 700), o.binder)).toBe(true);
      });
    }
  }
});

/* Сканер має ловити і те, чого в коді зараз немає. Перевіряємо його самого на
   синтетичних зразках — інакше «зелено» означало б лише «сьогодні все добре». */
describe("Сканер: сам себе не обманює", () => {
  const wrap = (body: string) => "async function f() {\n" + body + "\n}";

  it("одинарні лапки й бектіки теж скануються", () => {
    const occ = occurrences(wrap("const a = await supabase.from('rooms').select('x');"));
    expect(occ.length).toBe(1);
    expect(occ[0].form).toBe("named");
  });

  it("деструктуризація БЕЗ error — невідома форма (це і був дефект U-7)", () => {
    const occ = occurrences(wrap('const { data: rd } = await supabase.from("rooms").select("x");'));
    expect(occ[0].form).toBe("unknown");
  });

  it("деструктуризація З error — законна форма", () => {
    const occ = occurrences(wrap('const { data, error } = await supabase.from("rooms").select("x");'));
    expect(occ[0].form).toBe("destructured");
  });

  /* Перша версія цієї перевірки була ДЕКОРАТИВНОЮ: приклад «ovRes.error» проти
     binder="res" не спрацьовував і без межі слова (велика R), тож фальсифікація
     «прибрати межу слова» не червоніла взагалі. Приклади підібрані так, щоб
     ловити саме те, від чого межа й поставлена. */
  it("чуже імʼя з тим самим хвостом не зараховується", () => {
    expect(consultsError("if (prov.error) throw prov.error;", "ov")).toBe(false);   // суфіксний збіг
    expect(consultsError("if (a.ov.error) return;", "ov")).toBe(false);             // це поле чужого об'єкта
    expect(consultsError("if (ovx.error) return;", "ov")).toBe(false);              // префіксний збіг
    expect(consultsError("if (ov.error) throw ov.error;", "ov")).toBe(true);
    expect(consultsError("const e = ov.error ?? busy.error;", "ov")).toBe(true);    // початок виразу
  });

  it("кома всередині select() не зсуває індекс елемента Promise.all", () => {
    const occ = occurrences(wrap(
      'const [a, b] = await Promise.all([\n' +
      '  supabase.from("incidents").select("room_id, started_at, status"),\n' +
      '  supabase.from("rooms").select("schedule"),\n' +
      ']);\n' +
      'const err = a.error ?? b.error;'
    ));
    expect(occ.length).toBe(1);
    expect(occ[0].binder).toBe("b");   // не "a": коми в рядковому літералі не рахуються
  });
});

/* ── U-4: StudyEditModal ───────────────────────────────────────────────────
   Тут мало «не ковтати помилку» — треба ще не брати межі з фолбэка. schedEnd при
   невідомому графіку це хардкод 08–18, тобто чужий кабінет. Правило те саме, що
   вже діяло для зайнятості (busyReady, H-6), тож і форма та сама. */
describe("StudyEditModal — межі тривалості не беруться з невідомого графіка", () => {
  const code = src("components/StudyEditModal.tsx");

  /* «Не читали» — теж «не знаємо»: без кабінету або без дати графіка кабінету не
     існує, і schedReady не сміє бути true (ревʼю пакета, знахідка 4). */
  it("schedReady враховує і застосовність, і обидва прапорці, без розмиття", () => {
    expect(code).toMatch(/const schedApplies = !!patient\.room_id && !!scheduledDate;/);
    expect(code).toMatch(/const schedReady = schedApplies && !schedLoading && !schedErr;/);
    expect(code).not.toMatch(/const schedReady\s*=\s*[^;\n]*\|\|/);
  });

  it("стан довіри зібраний із ЖИВИХ прапорців компонента", () => {
    expect(code).toContain("busyFailed: busyErr");
    expect(code).toContain("schedFailed: schedErr");
    expect(code).toContain("loading: busyLoading || schedLoading");
  });

  /* Консервативна стеля — поточна тривалість запису. Infinity тут означав би
     «рости скільки завгодно» І друкувався б у UI як «Infinity хв». */
  it("стеля невідомості скінченна: поточна тривалість, інакше DUR_MAX", () => {
    expect(code).toMatch(/const committedDur = patient\.duration_min && patient\.duration_min > 0 \? patient\.duration_min : DUR_MAX;/);
  });

  it("усі стелі графіка прив'язані до schedApplies + schedReady", () => {
    expect(code).toMatch(/const capBySched = !schedApplies\s*\n?\s*\? DUR_MAX/);
    expect(code).toMatch(/const capBySched = !schedApplies[\s\S]{0,200}?schedReady\s*\n?\s*\?/);
    /* U-20 (с48): умова grace — `offAllowed` (прапорець запису АБО право ролі),
       а не самий лише прапорець. Довіру до читання це не послаблює: обидві гілки
       нижче так само тримаються на schedReady/committedDur. */
    expect(code).toMatch(/const offAllowed = offSchedule \|\| allowOffSchedule;/);
    expect(code).toMatch(/const capByBreak = \(offAllowed \|\| !schedApplies\) \? Infinity : \(schedReady \? capByBreakRaw : committedDur\);/);
    expect(code).toMatch(/const capBySchedStrict = !schedApplies \? DUR_MAX : \(schedReady \? schedEnd - startMin : committedDur\);/);
    expect(code).toMatch(/const inSchedCap = [^;]*capBySchedStrict[^;]*;/);
  });

  /* Підпис межі рахується ПО САМІЙ МЕЖІ, а не по глобальному прапорцю: банер
     «поза графіком» показує inSchedCap, а рядок доступності — availableDur, і
     плоский `!availTrusted ? …` ставив би поруч із реальним 18:00 слова «дані не
     підтверджені» (ревʼю пакета, знахідка 6). */
  it("підпис межі окремий для кожного споживача", () => {
    /* U-20 (с48): у labelFor зʼявилась ТРЕТЯ гілка — стеля понад графік
       називається конкретним часом, бо boundaryLabel описує СТРОГУ межу і на
       розширеній стелі був би прямою брехнею («доступно 480 хв (до кінця
       графіка (18:00))»). Порядок гілок пінимо разом: «не підтверджені» мусить
       лишатись ПЕРШИМ, інакше невідомість підмінялась би точним часом. */
    expect(code, "гілка невідомості більше не перша — точний час підмінить «не підтверджені»")
      .toMatch(/const labelFor = \(cap: number\) => \(!availTrusted && cap === committedDur\s*\n?\s*\? untrustedLabel/);
    /* ⚠️ `availTrusted &&` в цій гілці обовʼязковий. Умова невідомості вище
       тримається на `cap === committedDur` і мовчить, щойно вʼяже інша стеля —
       і напис ставав точним часом поруч із банером «збільшувати тривалість поки
       не можна» (ревʼю р1, U-20). */
    /* U-15 (с48, ревʼю р2) дописав до цієї гілки ПРИЧИНУ, коли мʼяку стелю
       вʼяже простій: «до 16:00 — далі простій кабінету». Без неї екран писав
       «Понаднормово — до 480 хв (до 16:00) з підтвердженням», і читач розумів,
       що впирається в овертайм, тоді як о 16:00 стоїть ТО, якого згода не
       знімає. Тому хвіст гілки більше не жорсткий — але і `availTrusted &&`, і
       `fmtDay`, і завершення на `boundaryLabel` лишаються пінами: рівно вони
       тримають те, заради чого гвард писався. */
    expect(code, "стеля понад графік знову описується боундарі-написом строгої межі")
      .toMatch(/\? \("до " \+ fmtDay\(startMin \+ cap\)[\s\S]{0,140}?\)\s*\n?\s*: boundaryLabel\);/);
    expect(code, "гілка овертайму втратила availTrusted — невідомість підміниться точним часом")
      .toMatch(/: \(availTrusted && cap > inSchedCap\)/);
    // Час за добу друкується з переносом: «24:00» і «25:00» — часи, яких не буває.
    expect(code, "стеля з grace знову друкується сирим fmt — на екрані зʼявиться «до 25:00»")
      .toMatch(/function fmtDay\(m: number\) \{ return m >= 1440 \?/);
    expect(code).toMatch(/const windowLabel = labelFor\(availableDur\);/);
    // Кожен споживач кличе labelFor зі СВОЄЮ стелею — спільного напису бути не має.
    expect(code).toContain("{labelFor(inSchedCap)}");
    // Назвати межу графіка можна лише коли графік узагалі застосовний.
    expect(code).toMatch(/schedApplies \? \("до кінця графіка \(" \+ fmt\(schedEnd\) \+ "\)"\)/);
  });

  /* Порожній рядок від maybeSingle() — не «графіка немає», а «не знаємо». */
  it("відсутній рядок кабінету трактується як невідомий графік", () => {
    expect(code).toMatch(/if \(!roomRes\.data\) throw new Error/);
  });

  /* Прочитане при збої мусить обнулятися, інакше на екрані лишиться графік
     ПОПЕРЕДНЬОЇ дати/кабінету і банери говоритимуть про нього як про факт. */
  it("на збої прочитаний графік обнуляється", () => {
    expect(code).toMatch(/catch \{[\s\S]{0,500}?setOverride\(null\); setRoomSchedule\(null\); setSchedErr\(true\);/);
  });
});

/* «Кабінет у цей день не працює» — теж ТВЕРДЖЕННЯ про графік. Якщо ця гілка
   стоятиме вище перевірки довіри, збій читання знову назве день робочим (або
   неробочим) — просто іншими словами. Порядок гілок і є правило. */
describe("StudyEditModal — сітка дня під гейтом довіри", () => {
  const code = src("components/StudyEditModal.tsx");
  const chain = code.slice(code.indexOf("{!showGrid"));

  it("гілки збою й польоту стоять ПЕРЕД твердженням про закритий день", () => {
    const iFail = chain.indexOf("availFailed");
    const iTrust = chain.indexOf("!availTrusted");
    const iClosed = chain.indexOf("roomSched.closed");
    expect(iFail).toBeGreaterThan(-1);
    expect(iTrust).toBeGreaterThan(-1);
    expect(iClosed).toBeGreaterThan(iFail);
    expect(iClosed).toBeGreaterThan(iTrust);
  });

  /* Слова про джерела бере спільний хелпер (lib/availabilityTrust) — інакше
     наступне джерело знову лишиться без свого рядка, як сталося з графіком. */
  it("причину називає спільний хелпер, а не власний текст екрана", () => {
    expect(code).toContain("slotDataFooterText(availState)");
    expect(code).not.toContain("Не вдалося перевірити зайнятість кабінету");
    expect(code).not.toContain("Не вдалося завантажити зайнятість кабінету");
  });
});

/* ── U-3: RescheduleModal ──────────────────────────────────────────────────
   Дата й кабінет тут МІНЯЮТЬСЯ при відкритій модалці, тож «застаріле прочитане»
   не абстракція: збій на новій даті лишав оверрайд старої. */
describe("RescheduleModal — застарілий графік не видається за поточний", () => {
  const code = src("components/RescheduleModal.tsx");

  it("на збої прочитаний графік обнуляється", () => {
    expect(code).toMatch(/catch \{[\s\S]{0,500}?setOverride\(null\); setRoomSchedule\(null\); setSchedErr\(true\);/);
  });

  it("відсутній рядок кабінету трактується як невідомий графік", () => {
    expect(code).toMatch(/if \(!roomRes\.data\) throw new Error/);
  });

  /* Ці два рядки — поза гейтом сітки, тому потребують власної умови. */
  it("банери «не працює» і «особливий графік» під прапорцем schedErr", () => {
    expect(code).toMatch(/\{!schedErr && roomSched\.closed &&/);
    expect(code).toMatch(/\{!schedErr && !roomSched\.closed && roomSched\.custom &&/);
  });
});

/* ── U-7: CeoDashboard ─────────────────────────────────────────────────────
   Тост живе 6 секунд, цифри лишаються назавжди. Тому недостатньо повідомити про
   збій — треба не показувати ПОХІДНІ нулі як факт. */
describe("CeoDashboard — нулі від збою не видаються за факт", () => {
  const code = src("components/CeoDashboard.tsx");

  /* «Свіжі» = дані на екрані описують ОБРАНИЙ зріз. Прапорець один на всі похідні
     числа: жива перевірка на проді показала, що коло чесно ставало «—», а поруч
     лишались «Записи 0» і «Дохід 0 ₴» — той самий дефект у сусідніх картках. */
  it("свіжість рахується по ключу зрізу, без розмиття", () => {
    expect(code).toMatch(/const dataKey = useMemo\(\(\) => scope \+ "\|" \+ period \+ "\|" \+ clinicIds\.join\(","\), \[scope, period, clinicIds\]\);/);
    expect(code).toMatch(/const dataFresh = loadedKey === dataKey;/);
    expect(code).toMatch(/const utilKnown = dataFresh;/);
    expect(code).not.toMatch(/const dataFresh\s*=\s*[^;\n]*\|\|/);
    expect(code).not.toMatch(/const utilKnown\s*=\s*[^;\n]*\|\|/);
    // ключ будується ОДИН раз і використовується reload()-ом, а не дублюється
    expect(code.split('scope + "|" + period + "|"').length - 1).toBe(1);
    expect(code).toMatch(/const key = dataKey;/);
  });

  /* Кожне похідне число екрана під одним гейтом. Перелік навмисно повний: саме
     «забули в сусідній картці» і було знайдено живою перевіркою. */
  it("жодне похідне число не показується без свіжих даних", () => {
    for (const n of ["total", "done", "noShow", "notHeld", "active"]) {
      expect(code).toContain("{dataFresh ? " + n + " : \"—\"}");
    }
    expect(code).toContain('{dataFresh ? fmtUah(revenue) : "—"}');
    expect(code).toMatch(/visibility: dataFresh \? "visible" : "hidden"/);   // тижневий графік
    expect(code).toMatch(/\{dataFresh \? "Немає даних" : "Дані не завантажились[^"]*"\}/);
  });

  it("усі три шляхи провалу ведуть в один обробник", () => {
    expect(code).toMatch(/if \(rres\.error\) \{ failed\(\); return; \}/);
    expect(code).toMatch(/if \(tot\.error \|\| rms\.error \|\| sts\.error \|\| \(wtot && wtot\.error\)\) \{ failed\(\); return; \}/);
    expect(code).toMatch(/catch \(e\) \{[\s\S]{0,300}?failed\(\);/);
    expect(code).toMatch(/const failed = \(\) => \{[\s\S]{0,600}?setDataErr\(true\);/);
  });

  /* Проходи перекриваються (reload перестворюється на зміну періоду/scope і
     запускається негайно). Без покоління пізній успіх старого проходу зняв би
     банер і намалював чужий період як свіжий. */
  it("є захист поколінням і він застосований у кожній точці запису", () => {
    expect(code).toMatch(/const gen = \+\+genRef\.current;/);
    expect(code).toMatch(/const stale = \(\) => gen !== genRef\.current;/);
    expect(code).toMatch(/if \(stale\(\)\) return;\s*\n\s*setRooms\(rres\.data/);
    expect(code).toMatch(/if \(stale\(\)\) return;\s*\n\s*\n?\s*setTotals\(/);
    expect(code).toMatch(/if \(!stale\(\)\) setLoading\(false\);/);
    expect(code).toMatch(/const failed = \(\) => \{\s*\n\s*if \(stale\(\)\) return;/);
  });

  /* Застарілі цифри можна лишати на екрані лише якщо вони про ТОЙ САМИЙ зріз.
     Ключ пишеться ЧЕРЕЗ markLoaded: ref потрібен логіці reload(), стан — рендеру,
     і розійтися вони не мають права. */
  it("при збої на іншому scope/періоді старі дані стираються", () => {
    expect(code).toMatch(/const markLoaded = \(k: string \| null\) => \{ loadedKeyRef\.current = k; setLoadedKey\(k\); \};/);
    expect(code).toMatch(/if \(loadedKeyRef\.current !== key\) \{[\s\S]{0,300}?setRooms\(\[\]\);/);
    expect(code).toMatch(/markLoaded\(key\);\s*\n\s*setDataErr\(false\);/);
    // прямого запису в ref повз markLoaded бути не повинно — інакше рендер відстане
    expect(code.split("loadedKeyRef.current =").length - 1).toBe(1);   // лише всередині markLoaded
  });

  it("прапорець знімається лише після всіх сеттерів успіху", () => {
    const last = code.lastIndexOf("setStudyRows(");
    expect(last).toBeGreaterThan(-1);
    expect(code.indexOf("setDataErr(false)", last)).toBeGreaterThan(-1);
    const inReload = code.slice(code.indexOf("const reload = useCallback"), last);
    // допускається рівно один — у ранньому виході «центрів немає»
    expect(inReload.split("setDataErr(false)").length - 1).toBe(1);
  });

  it("коло завантаженості показує «—», а не 0%, коли даних немає", () => {
    expect(code).toContain("unknown={!utilKnown}");
    expect(code).toMatch(/\{unknown \? "—" : pct \+ "%"\}/);
  });

  it("вердикт «Висока/Помірна/Низька» не виноситься без даних", () => {
    expect(code).toMatch(/\{utilKnown \? \(util > 70 \? "Висока"/);
  });

  /* Третя ситуація — «дані не прийшли» — раніше зливалася з «кабінетів немає». */
  it("нульовий стан по апаратах розрізняє збій і відсутність кабінетів", () => {
    expect(code).toMatch(/!dataFresh \? "Дані не завантажились[^"]*" : rooms\.length > 0 \? "Усі кабінети вимкнено" : "Кабінетів немає"/);
  });

  it("є постійний банер, а не лише зникомий тост", () => {
    expect(code).toMatch(/\{dataErr && \(/);
  });
});
