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
import { readRoomModality, modalityVerdict } from "@/lib/studies";

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
  "app/queue/actions.ts",
];

/* Лапки будь-які: одинарні/зворотні теж мають потрапляти в скан, інакше
   найдешевший спосіб обійти сторожа — написати .from('rooms').

   ⚠️ `incidents` додано в с49 (U-14). Ревʼю U-11 звіряло всі девʼять
   продуктових читань цієї таблиці руками — дірок не було; сканер потрібен був
   на МАЙБУТНЄ, і одразу знайшов минуле: `app/queue/actions.ts` (U-17).

   ⚠️ `queue_entries` СВІДОМО не тут — і це заміряно, а не здогад. Один рядок
   у цій регулярці робить червоними ще **вісім** місць: шість у
   `app/queue/actions.ts` (серед них `const { data: cur }`, чий збій читання
   показується як «Запис не знайдено»), одне в `CeoDashboard` і одне в
   `RescheduleModal`. Це окремий пакет (борг **U-55**), а не хвіст цього:
   змішати «слід аварійної зупинки» з «читання бреше про ненайдений запис»
   означало б ревʼювати два різні ризики одним поглядом. */
const TABLE_RE = /\.from\(\s*["'`](rooms|schedule_overrides|incidents)["'`]\s*\)/g;

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

/* ПРИЙМАЧ виклику — будь-який, а не літеральне імʼя `supabase`.
   ⚠️ с49: перша редакція вимагала саме `await supabase.from(…)`. Тому
   `await createClient().from("incidents")` у `ReferralPortal` сканер зарахував
   у НЕВІДОМУ форму, хоча код там правильний і `error` перевіряє. Наслідок гірший
   за хибну тривогу: найдешевший спосіб сховати читання від сторожа — назвати
   клієнт інакше (`sb`, `admin`) або створити його на місці. Приймаємо
   ідентифікатор, ланцюжок через крапку і виклик із аргументами. */
const RECEIVER = String.raw`[\w$]+(?:\.[\w$]+)*(?:\([^()]*\))?`;

type Occ = { table: string; index: number; form: "named" | "destructured" | "promise-all" | "unknown"; binder: string; checkFrom: number };

function occurrences(code: string): Occ[] {
  const out: Occ[] = [];
  for (const m of code.matchAll(TABLE_RE)) {
    const ix = m.index as number;
    const table = m[1];
    const before = code.slice(Math.max(0, ix - 200), ix);

    // F1 — результат зв'язаний іменем безпосередньо перед .from(...)
    const named = before.match(new RegExp(String.raw`(?:const|let)\s+(\w+)\s*=\s*await\s+` + RECEIVER + String.raw`\s*$`));
    if (named) { out.push({ table, index: ix, form: "named", binder: named[1], checkFrom: ix }); continue; }

    /* F2 — деструктуризація. ⚠️ Ревʼю р2: перша редакція приймала цю форму за
       самим фактом слова `error` у шаблоні і ВИКЛЮЧАЛА її з подальших перевірок
       (`occ.filter(form !== "destructured")`). Тобто `const { data, error } = …;
       void error;` проходив мовчки — дірка ширша за обидві задокументовані межі
       сканера. Тепер витягуємо РЕАЛЬНЕ імʼя (враховуючи аліас `error: e`) і
       ганяємо по ньому той самий `consultsError`, що й для F1. */
    const destr = before.match(new RegExp(String.raw`(?:const|let)\s*\{([^}]*)\}\s*=\s*await\s+` + RECEIVER + String.raw`\s*$`));
    if (destr) {
      const alias = destr[1].match(/\berror\s*:\s*([\w$]+)/);
      const plain = /(^|[,{\s])error\s*(,|}|$)/.test(destr[1] + "}");
      const name = alias ? alias[1] : (plain ? "error" : "");
      if (name) { out.push({ table, index: ix, form: "destructured", binder: name, checkFrom: ix }); continue; }
    }

    // F3 — елемент масиву Promise.all з деструктуризацією імен вище
    const pa = code.lastIndexOf("Promise.all([", ix);
    const open = pa >= 0 ? pa + "Promise.all(".length : -1;
    const arr = open >= 0 ? scanArray(code, open, ix) : { k: null, end: -1 };
    const names = pa >= 0 ? code.slice(Math.max(0, pa - 200), pa).match(/(?:const|let)\s*\[([^\]]*)\]\s*=\s*await\s*$/) : null;
    if (arr.k !== null && names) {
      const list = names[1].split(",").map((s) => s.trim()).filter(Boolean);
      /* ⚠️ Ревʼю р2: біндер мусить бути ІДЕНТИФІКАТОРОМ. Форма
         `const [{ data: room, error: roomErr }, …] = await Promise.all([…])`
         давала биндер «{ data: room», з якого будувалась регулярка, що ніколи
         не збігається, — червоний тест із безглуздим імʼям. Така форма живе в
         `app/fhir/R4/Slot/route.ts` і чекає лише додавання файлу в FILES.
         Чесніше визнати форму НЕВІДОМОЮ: тоді автор або приведе її до відомої,
         або допише сюди розбір. */
      if (list[arr.k] && /^[\w$]+$/.test(list[arr.k])) {
        out.push({ table, index: ix, form: "promise-all", binder: list[arr.k], checkFrom: arr.end }); continue;
      }
    }

    out.push({ table, index: ix, form: "unknown", binder: "", checkFrom: ix });
  }
  return out;
}

/* Межа слова обов'язкова: без неї сторож із binder="res" задовольняється чужим
   "ovRes.error" у тому ж вікні (ревʼю пакета, знахідка 7). */
const consultsError = (window: string, binder: string) =>
  new RegExp("(^|[^\\w$.])" + binder + "\\.error\\b").test(window);

/* Для F2 биндер — це САМА помилка (`const { data, error } = …`), а не відповідь,
   тож шукати `error.error` безглуздо: перевіряють ЇЇ, а не її поле. Межа тут та
   сама, що задокументована в шапці для решти форм: сканер вимагає, щоб змінну
   ПРОЧИТАЛИ, а не щоб із нею щось зробили — `void error;` пройде. */
const consultsBinding = (window: string, name: string) =>
  new RegExp("(^|[^\\w$.])" + name + "\\b").test(window);

/* ЧЕТВЕРТА законна форма (U-13, с49): відповідь віддано ПРАВИЛУ, яке саме
   дивиться на `.error` І додатково розрізняє порожній рядок. Без цієї гілки
   сканер вимагав би лишити `res.error` поруч із делегуванням — тобто дві
   перевірки одного й того самого, і одна з них неминуче б розʼїхалась.

   ⚠️ Делегування — це довіра, тому вона перевіряється окремим тестом нижче
   («правило, якому делегують, справді дивиться на error»): інакше достатньо
   було б назвати будь-яку функцію `readRoomScheduleRow`, і сторож замовк би. */
const delegatesToRule = (window: string, binder: string) =>
  new RegExp("(readRoomScheduleRow|roomSchedulesById|readRoomModality|modalityVerdict)\\(\\s*" + binder + "\\b").test(window);

/* Сам ОБСЯГ нагляду — теж інваріант. Без цього тесту звузити сканер (прибрати
   таблицю зі списку або файл із FILES) можна мовчки: усе лишиться зеленим, бо
   зелене на порожньому наборі. Саме так у с49 виявилось, що `app/queue/actions.ts`
   не сканувався ЖОДНОГО дня — і обидва дефекти (U-17, U-18) жили в ньому. */
describe("Сканер: обсяг нагляду не звужується мовчки", () => {
  /* ⚠️ Ревʼю р2: перша редакція читала `TABLE_RE.source` і довжину `FILES` —
     тобто ВЛАСНЕ оголошення, а не поведінку. `rooms` лишався б у `source` і
     після перейменування в `rooms_v2`, а `FILES.length >= 7` тримався б при
     викиданні пʼяти екранів і дописуванні одного чужого файла. Перевіряємо
     ПОВЕДІНКОЮ (сканер справді знаходить читання кожної таблиці) і ПОІМЕННО. */
  it.each(["rooms", "schedule_overrides", "incidents"])(
    "сканер справді знаходить читання %s", (t) => {
      const occ = occurrences(`const a = await supabase.from("${t}").select("x");`);
      expect(occ.length, `читання ${t} не потрапляє в скан`).toBe(1);
      expect(occ[0].table).toBe(t);
    },
  );

  it("перелік файлів під наглядом — поіменний", () => {
    /* Дефекти U-17/U-18 жили саме в серверних діях: сканер дивився лише в
       components/. Список поіменний, щоб зникнення БУДЬ-ЯКОГО з них червоніло,
       а не ховалось за збереженою довжиною. */
    expect([...FILES].sort()).toEqual([
      "app/queue/actions.ts",
      "components/BookingModal.tsx",
      "components/CeoDashboard.tsx",
      "components/CollisionPanel.tsx",
      "components/ReferralPortal.tsx",
      "components/RescheduleModal.tsx",
      "components/StudyEditModal.tsx",
    ]);
  });

  it("межа охоплення названа, а не замовчана", () => {
    /* ⚠️ Ревʼю р2 порахувало: поза `FILES` лишається 30+ літеральних читань цих
       таблиць (сторінки `page.tsx` під `app/`, дошки, кілька route-handler-ів).
       Це не обовʼязково дефекти, але новий describe міг створити враження, що
       охоплення під замком. Межа названа тут і в шапці файла; розширення —
       борг **U-55** разом із `queue_entries`. */
    expect(readFileSync(resolve(process.cwd(), "tests/readErrorTrust.test.ts"), "utf8"))
      .toMatch(/U-55/);
  });
});

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

    /* ⚠️ Порядковий номер у ЗАГОЛОВКУ (ревʼю р1). У `app/queue/actions.ts` два
       різні читання `rooms` мають однаковий биндер `roomRes` (`scheduleGate` і
       `roomDayCtx`), тож без номера обидва тести звались однаково — і по
       червоному звіту не можна було зрозуміти, яке саме читання зламали.
       Номер саме порядковий, а не char-index: індекс міняється від будь-якої
       правки вище по файлу, і імена тестів «пливли» б на кожному коміті. */
    const seen = new Map<string, number>();
    /* ⚠️ Ревʼю р2: `destructured` більше НЕ виключена. Раніше вона проходила
       повз усі перевірки за самим фактом слова `error` у шаблоні. */
    for (const o of occ) {
      const key = o.table + "|" + o.form + "|" + o.binder;
      const nth = (seen.get(key) ?? 0) + 1;
      seen.set(key, nth);
      it(f + " — " + o.table + " #" + nth + " (" + o.form + ", " + o.binder + "): error перевірено", () => {
        const w = code.slice(o.checkFrom, o.checkFrom + 700);
        const seen = o.form === "destructured"
          ? consultsBinding(w, o.binder)
          : consultsError(w, o.binder) || delegatesToRule(w, o.binder);
        expect(seen).toBe(true);
      });
    }
  }
});

/* Делегування чинне рівно доти, доки правило справді робить те, за що йому
   довіряють. Без цього тесту четверта форма — дірка: назви функцію потрібним
   іменем, і сканер замовкне (клас «сторож пінить ІМʼЯ», урок с46). */
describe("Правило, якому делегує сканер, справді дивиться на error", () => {
  const rule = src("lib/roomSchedule.ts");

  it("readRoomScheduleRow перевіряє .error", () => {
    expect(rule).toMatch(/if \(res\.error\) return \{ known: false, reason: "error" \};/);
  });

  it("…і окремо ПОРОЖНІЙ рядок — те, чого сама перевірка error не ловить", () => {
    expect(rule).toMatch(/if \(!res\.data\) return \{ known: false, reason: "missing" \};/);
  });

  it("roomSchedulesById (спискова форма) перевіряє і error, і повноту", () => {
    expect(rule).toMatch(/if \(!res \|\| res\.error\) return \{ known: false, reason: "error" \};/);
    expect(rule).toMatch(/if \(!\(id in byId\)\) return \{ known: false, reason: "missing" \};/);
  });

  /* U-18 (с49): правила з `lib/studies.ts`, яким сканер довіряє на шляху
     модальності. ⚠️ Ревʼю р2: перевіряємо їх ВИКЛИКОМ, а не регулярками по
     тексту файлу. Текстові піни тут нічого не ловили (мутації N01–N04 і так
     червонили поведінкові тести в `roomModalityRead.test.ts`), зате червоніли
     б на `if (res.error != null)` чи переносі рядка — тобто на правці без
     дефекту. Довіра сканера має триматись на ПОВЕДІНЦІ.
     ⚠️ Текстові піни для `lib/roomSchedule.ts` вище лишені як були: то чужий
     пакет (U-13), і його поведінку стереже власний файл тестів. Переписати їх
     тим самим способом — окремий борг **U-57**. */
  it("readRoomModality: помилка і порожній рядок — це НЕ значення", () => {
    expect(readRoomModality({ data: null, error: { message: "x" } }).known).toBe(false);
    expect(readRoomModality({ data: { modality: "MRI" }, error: { message: "x" } }).known).toBe(false);
    expect(readRoomModality({ data: null, error: null }).known).toBe(false);
    expect(readRoomModality({ data: { modality: "MRI" }, error: null }))
      .toEqual({ known: true, modality: "MRI" });
  });

  it("modalityVerdict: незнання не стає ані ok, ані mismatch", () => {
    /* Саме на це делегує гейт у `app/queue/actions.ts`; якби вердикт при збої
       читання давав "ok", сканер мовчав би про рівно вихідний дефект. */
    expect(modalityVerdict({ data: null, error: { message: "x" } }, [{ type: "КТ" }]))
      .toBe("unreadable");
    expect(modalityVerdict({ data: null, error: null }, [{ type: "КТ" }])).toBe("gone");
    expect(modalityVerdict({ data: { modality: "MRI" }, error: null }, [{ type: "КТ" }]))
      .toBe("mismatch");
    expect(modalityVerdict({ data: { modality: "OTHER" }, error: null }, [{ type: "КТ" }]))
      .toBe("ok");
  });
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
    /* ⚠️ До с49 `incidents` не сканувався, і цей зразок давав рівно одне
       входження. Тепер обидва — і це робить перевірку СИЛЬНІШОЮ: важливо не
       «скільки знайшли», а що КОЖНЕ звʼязалось зі СВОЇМ елементом масиву.
       Зсув індексу на одиницю раніше було видно лише за биндером "b". */
    expect(occ.map((o) => o.table + ":" + o.binder)).toEqual(["incidents:a", "rooms:b"]);
  });

  /* ⚠️ с49: приймач виклику. Перша редакція вимагала літерального `supabase`,
     і `createClient().from(…)` у `ReferralPortal` рахувався НЕВІДОМОЮ формою,
     хоча error там перевіряється. Гірше за хибну тривогу: найдешевший спосіб
     сховати читання від сторожа — назвати клієнт інакше. */
  it("приймач будь-який: createClient().from — теж відома форма", () => {
    const occ = occurrences(wrap(
      'const { data, error } = await createClient().from("incidents").select("id");'
    ));
    expect(occ.length).toBe(1);
    expect(occ[0].form).toBe("destructured");
  });

  it("приймач-змінна з іншим імʼям — теж відома форма", () => {
    const occ = occurrences(wrap('const r = await sb.from("rooms").select("modality");'));
    expect(occ[0].form).toBe("named");
    expect(occ[0].binder).toBe("r");
  });

  it("делегування правилу зараховується лише для СВОГО биндера", () => {
    /* Інакше сусіднє `readRoomModality(other)` у тому ж вікні закривало б
       читання, якого ніхто не розібрав, — той самий клас, що межа слова
       в consultsError. */
    expect(delegatesToRule("const m = readRoomModality(res);", "res")).toBe(true);
    expect(delegatesToRule("const m = readRoomModality(other);", "res")).toBe(false);
    expect(delegatesToRule("const m = notARule(res);", "res")).toBe(false);
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

  /* Порожній рядок від maybeSingle() — не «графіка немає», а «не знаємо».
     ⚠️ U-13 (с49): перевірка переїхала з інлайну в `lib/roomSchedule`, бо саме
     інлайновою вона й НЕ доїхала до BookingModal, ReferralPortal, кнопки
     швидкого переносу і серверного гарда. Тест лишається — але пінить те, що
     чинне зараз: результат правила ЗУПИНЯЄ завантаження. */
  it("відсутній рядок кабінету трактується як невідомий графік", () => {
    expect(code).toMatch(/const sched = readRoomScheduleRow\(roomRes\);/);
    expect(code).toMatch(/if \(!sched\.known\) throw roomScheduleReadError\(sched\.reason\);/);
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

  /* ⚠️ U-13 (с49): правило переїхало в `lib/roomSchedule` — інлайновим воно не
     доїхало до чотирьох сусідніх екранів і серверного гарда. Пін оновлено на
     чинну форму; сама вимога («порожній рядок = не знаємо») не змінилась. */
  it("відсутній рядок кабінету трактується як невідомий графік", () => {
    expect(code).toMatch(/const sched = readRoomScheduleRow\(roomRes\);/);
    expect(code).toMatch(/if \(!sched\.known\) throw roomScheduleReadError\(sched\.reason\);/);
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
