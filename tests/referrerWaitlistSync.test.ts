/**
 * Портал направника: лист очікування мусить бути СИНХРОННИМ і чесним (F4-3,
 * F4-10, F4-11 — фаза 4 аудиту 2026-08-27).
 *
 * Дефект, який тут зафіксовано пінами. Вибірка листа читає ДВІ гілки
 * (`created_by` АБО `referrer_id`), а realtime-підписка була на ОДНУ
 * (`created_by=eq.`). Коли центр записував пацієнта з листа, `created_by` —
 * реєстратор, тож подія до направника не доходила ВЗАГАЛІ. Позначку ж БД
 * адресує по `referrer_id`, і вона приходила своїм каналом. Виходило найгірше
 * поєднання: крапка є, список старий, а поверхневий ack при відкритті вкладки
 * гасив крапку по СТАРОМУ знімку — лікар назавжди втрачав звістку про те, що
 * його пацієнта записали.
 *
 * Чому піни по тексту, а не виклик. `ReferralPortal` — компонент, а
 * компонентних тестів у проєкті немає (аудит L-2, environment: "node"). Чиста
 * частина — ключ перезаморозки — винесена в `lib/unreadChanges.ts` і
 * перевіряється ВИКЛИКОМ у tests/unreadChanges.test.ts; тут лишається рівно
 * те, що виражається лише проводкою.
 *
 * ⚠️ Піни зрізані по БЛОКУ, а не шукаються по всьому файлу. У цьому ж файлі
 * живе другий хук (`ref-slots-`), у якого і свій `pollWhenSubscribedMs`, і свої
 * підписки — пін «десь у файлі є pollWhenSubscribedMs» був би декоративним і
 * лишався зеленим після видалення тікера з каналу `ref-`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { codeOf } from "./helpers/codeOf";

const code = codeOf(readFileSync(resolve(process.cwd(), "components/ReferralPortal.tsx"), "utf8"));

const countOf = (s: string, needle: string): number => s.split(needle).length - 1;

/** Зріз хука каналу «ref-» (не «ref-slots-»). */
function refChannel(): string {
  const anchor = 'channelName: doctorId ? "ref-" + doctorId : null';
  expect(countOf(code, anchor), "якір каналу ref- не унікальний — пін нижче став би двозначним").toBe(1);
  const at = code.indexOf(anchor);
  const end = code.indexOf("});", at);
  expect(end, "кінець виклику useRealtimeRefetch не знайдено").toBeGreaterThan(at);
  return code.slice(at, end);
}

/** Зріз компонента MyWaitlist до наступного оголошення верхнього рівня. */
function myWaitlist(): string {
  const start = code.indexOf("function MyWaitlist(");
  expect(start, "MyWaitlist не знайдено").toBeGreaterThan(-1);
  const m = code.slice(start + 1).match(/\n(?:export default )?function /);
  expect(m, "межа зрізу MyWaitlist не знайдена — зріз поїхав би до кінця файла").not.toBeNull();
  return code.slice(start, start + 1 + (m as RegExpMatchArray).index!);
}

/** Зріз лоадера листа. */
function reloadWaitlistFn(): string {
  const anchor = "const reloadWaitlist = useCallback(async () => {";
  expect(countOf(code, anchor), "якір лоадера листа не унікальний").toBe(1);
  const at = code.indexOf(anchor);
  const end = code.indexOf("}, [doctorId]);", at);
  expect(end, "кінець reloadWaitlist не знайдено").toBeGreaterThan(at);
  return code.slice(at, end);
}

/** Колонки, за якими вибірка листа читає рядки: гілки `.or(...)`. */
function loaderBranches(): string[] {
  const fn = reloadWaitlistFn();
  const at = fn.indexOf(".or(");
  expect(at, "вибірка листа більше не використовує .or(...) — контракт нижче треба переписати").toBeGreaterThan(-1);
  const orCall = fn.slice(at, fn.indexOf(")", at) + 1);
  const cols = [...orCall.matchAll(/([a-z_]+)\.eq\./g)].map((m) => m[1]);
  expect(cols.length, "гілок у .or(...) менше двох — розбір поїхав").toBeGreaterThan(1);
  return cols;
}

describe("F4-3 — підписка на лист не вужча за вибірку", () => {
  /* ⚠️ Головний сторож пакета, і він НАВМИСНО не пінить дві конкретні гілки:
     інваріант тут — «множина підписок дорівнює множині гілок вибірки». Пін по
     двох літералах лишався б зеленим, якби у вибірку додали третю гілку, — а це
     рівно той спосіб, яким дефект F4-3 і зʼявився: вибірку розширили (0138), а
     підписку — ні. Тому гілки ВИТЯГУЮТЬСЯ з коду вибірки. */
  it("КОЖНА гілка вибірки має власну підписку — і жодної зайвої", () => {
    const block = refChannel();
    const cols = loaderBranches();
    for (const c of cols) {
      expect(block, `гілка вибірки «${c}» лишилась без підписки — подія по ній не дійде`)
        .toMatch(new RegExp(`table: "waitlist_entries",\\s*filter: "${c}=eq\\."`));
    }
    const subs = (block.match(/table: "waitlist_entries"/g) ?? []).length;
    expect(subs, "число підписок на лист розійшлося з числом гілок вибірки").toBe(cols.length);
  });

  it("обидві підписки листа ведуть в один лоадер зі спільним ключем дебаунсу", () => {
    const block = refChannel();
    /* Подія, що збігається з обома гілками (лікар сам створив рядок), без
       спільного ключа дала б два перезавантаження на кожну зміну. */
    const keyed = (block.match(/table: "waitlist_entries",[^}]*onChange: reloadWaitlist,\s*debounceKey: "wl"/g) ?? []).length;
    expect(keyed, "не всі підписки листа мають спільний debounceKey").toBe(loaderBranches().length);
  });

  it("рідка звірка при живому сокеті увімкнена саме в цьому каналі", () => {
    expect(refChannel(), "канал ref- лишився без pollWhenSubscribedMs")
      .toMatch(/pollWhenSubscribedMs: 60_000/);
  });
});

describe("F4-11 — чотири router.refresh() не множаться на кожному callAll", () => {
  it("у КОЖНОЇ гілки refresh спільний debounceKey", () => {
    const block = refChannel();
    const total = (block.match(/onChange: \(\) => router\.refresh\(\)/g) ?? []).length;
    const keyed = (block.match(/onChange: \(\) => router\.refresh\(\),\s*debounceKey: "rsc"/g) ?? []).length;
    expect(total, "гілок refresh у каналі ref- має бути чотири").toBe(4);
    expect(keyed, "не всі гілки refresh мають спільний ключ").toBe(total);
    /* Негативний пін ловить пʼяту гілку, додану в майбутньому без ключа:
       підрахунок вище на неї теж червонітиме, але саме цей пін назве причину. */
    expect(block, "зʼявилась гілка refresh без debounceKey")
      .not.toMatch(/onChange: \(\) => router\.refresh\(\)(?!,\s*debounceKey)/);
  });
});

describe("F4-10 — крапка листа гасне за показаним станом, а не за станом на маунті", () => {
  it("ack поверхні waitlist отримує ключ перезаморозки", () => {
    expect(myWaitlist(), "ack листа лишився без refreezeKey")
      .toMatch(/useAckWhenVisible\(\s*\{ kind: "surface", surface: "waitlist" \},\s*loaded && !loadErr,\s*surfaceRefreezeKey\([^)]*\),?\s*\)/);
  });

  it("ключ рахується з ПОКАЗАНОГО списку і з позначок ЦІЄЇ поверхні", () => {
    /* `list` = waiting + rest, тобто рівно те, що відрендерено. Пін фіксує
       джерело: майбутня фільтрація рядків не має лишити ключ від іншого
       набору, а поверхня позначок мусить збігатися з поверхнею ack. */
    const mw = myWaitlist();
    expect(mw, "джерело ключа — не показаний список і не позначки цієї поверхні")
      .toMatch(/surfaceRefreezeKey\(list, unreadForSurface\(unreadIx, "waitlist"\)\)/);
    expect(mw, "показаний список рахується інакше, ніж очікує пін")
      .toMatch(/const list = \[\.\.\.waiting, \.\.\.rest\];/);
  });
});

describe("Гонки лоадерів порталу (ревʼю р.1 пакета F4-3/F4-10)", () => {
  /* ⚠️ Після F4-10 відповідь ПОВІЛЬНОГО запиту, що приземлилась останньою,
     не просто мигає списком — вона керує перезаморозкою, тобто гасить крапку
     по відкоченим даним. Тому лічильник поколінь тут не гігієна, а сторож
     необоротної дії. Пін перевіряє ФОРМУ приймача в обох лоадерах і те, що
     гейт стоїть саме ПЕРЕД записом стану. */
  for (const [fn, genRef, firstSetter] of [
    ["reloadWaitlist", "wlGen", "setWlErr\\(true\\); setWlLoaded\\(true\\); return;"],
    ["reload", "listGen", "setListErr\\(true\\); return;"],
  ] as const) {
    it(`${fn}: лічильник поколінь і гейт перед записом стану`, () => {
      const anchor = `const ${fn} = useCallback(async () => {`;
      expect(countOf(code, anchor), `якір ${fn} не унікальний`).toBe(1);
      const at = code.indexOf(anchor);
      const body = code.slice(at, code.indexOf("}, [doctorId]);", at));
      expect(body, `${fn}: немає лічильника поколінь`)
        .toMatch(new RegExp(`const gen = \\+\\+${genRef}\\.current;`));
      expect(body, `${fn}: немає предиката протухлості`)
        .toMatch(new RegExp(`const stale = \\(\\) => gen !== ${genRef}\\.current;`));
      expect(body, `${fn}: гейт не стоїть перед записом стану`)
        .toMatch(new RegExp(`if \\(stale\\(\\)\\) return;\\s*\\n\\s*if \\(error\\) \\{ ${firstSetter}`));
      expect(body, `${fn}: catch пише стан протухлого запиту`)
        .toMatch(/catch \{ if \(!stale\(\)\)/);
      // Розмиття предиката повертає дефект, лишаючи пін зеленим.
      expect(body, `${fn}: предикат протухлості розмито`)
        .not.toMatch(/const stale = \(\) =>[^;\n]*\|\|/);
    });
  }
});

describe("F4-3 (другий шар) — збій читання листа не бреше про чужий список", () => {
  it("лоадер листа не піднімає прапорець списку направлень", () => {
    expect(reloadWaitlistFn(), "збій листа знову вмикає listErr — плашка збреше про направлення")
      .not.toMatch(/setListErr/);
    expect(reloadWaitlistFn(), "лоадер листа перестав піднімати ВЛАСНИЙ прапорець")
      .toMatch(/setWlErr\(true\)/);
  });

  it("вкладка листа показує власний збій і дає повторити читання", () => {
    const mw = myWaitlist();
    expect(mw, "плашки збою на вкладці листа немає — порожній екран читається як «пацієнтів немає»")
      .toMatch(/\{loadErr && \(/);
    expect(mw, "плашка без ролі alert").toMatch(/role="alert"/);
    expect(mw, "плашка без кнопки повтору").toMatch(/onClick=\{onRetry\}/);
    expect(code, "onRetry не підключено до лоадера листа").toMatch(/onRetry=\{reloadWaitlist\}/);
  });

  it("при збої «Лист порожній» не малюється", () => {
    /* Інакше поруч із плашкою «не завантажився» стоїть УТВЕРДЖЕННЯ «Лист
       порожній» із закликом додати пацієнта — і лікар додає вдруге того, хто
       вже в листі (клас H-6). Пін тримає саме подавлення, а не наявність
       плашки: без нього обидва тексти можуть жити поруч при зеленому тесті. */
    expect(myWaitlist(), "порожній стан малюється навіть при loadErr")
      .toMatch(/\{list\.length === 0 \? \(\s*loadErr \? null : \(/);
  });
});
