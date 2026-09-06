/**
 * U-59 — «відрендерено в DOM» не дорівнює «показано людині».
 *
 * ЧОМУ ЦЕ ІСНУЄ. `useAckWhenVisible` — React-хук, а DOM-тестів у проєкті
 * немає НАВМИСНО (шапка `vitest.config.ts`). Тому саме рішення винесене в
 * `lib/ackVisibility.ts` і пінується поведінково; те, що хук його КЛИЧЕ і що
 * заморозку скидає РІВНО одна гілка, тримають лексичні піни нижче.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { codeOf } from "./helpers/codeOf";
import { ackGate, isDocumentShown, nextFreeze, type AckFreeze, type AckGateInput } from "@/lib/ackVisibility";
import { createVisibilityStore, type VisibilityHost } from "@/lib/useDocumentVisible";

const hook = codeOf(
  readFileSync(resolve(process.cwd(), "lib/useUnreadChanges.tsx"), "utf8")
);
const store = codeOf(
  readFileSync(resolve(process.cwd(), "lib/useDocumentVisible.ts"), "utf8")
);

/** Показаний блок під показаною вкладкою і готовим індексом. */
const SHOWN: AckGateInput = {
  hasScope: true,
  surfaceVisible: true,
  documentVisible: true,
  status: "ready",
};

describe("U-59 — фонова вкладка НЕ гасить позначки", () => {
  it("показаний блок під показаною вкладкою — гасимо", () => {
    expect(ackGate(SHOWN)).toBe("ack");
  });

  it("та сама поверхня під фоновою вкладкою — НЕ гасимо", () => {
    /* Це і є дефект: до пакета тут було б `ack`. */
    expect(ackGate({ ...SHOWN, documentVisible: false })).toBe("hold");
  });

  it("фонова вкладка дає hold, а НЕ collapse — заморозка мусить пережити фон", () => {
    /* Рішення власника (с58). Якби тут був `collapse`, повернення на вкладку
       зробило б НОВИЙ знімок і погасило все, що прилетіло без людини, — тобто
       дефект переїхав би, а не зник. */
    expect(ackGate({ ...SHOWN, documentVisible: false })).not.toBe("collapse");
  });

  it("згорнутий блок — collapse НАВІТЬ під фоновою вкладкою", () => {
    /* Поведінка, яка була до U-59, і вона мусить пережити правку: порядок
       гілок у `ackGate` тут єдине, що її тримає. */
    expect(ackGate({ ...SHOWN, surfaceVisible: false, documentVisible: false })).toBe("collapse");
    expect(ackGate({ ...SHOWN, hasScope: false, documentVisible: false })).toBe("collapse");
  });

  it("немає scope або блок згорнуто — collapse і під показаною вкладкою", () => {
    expect(ackGate({ ...SHOWN, hasScope: false })).toBe("collapse");
    expect(ackGate({ ...SHOWN, surfaceVisible: false })).toBe("collapse");
  });
});

describe("U-59 — межі правила", () => {
  it("індекс не 'ready' — wait, і це НЕ hold і НЕ collapse", () => {
    expect(ackGate({ ...SHOWN, status: "loading" })).toBe("wait");
    expect(ackGate({ ...SHOWN, status: "error-with-previous-data" })).toBe("wait");
  });

  it("фон переважає над неготовим індексом — причина відмови названа чесно", () => {
    expect(ackGate({ ...SHOWN, documentVisible: false, status: "loading" })).toBe("hold");
  });

  it("isDocumentShown — fail-CLOSED: показано лише рівно 'visible'", () => {
    expect(isDocumentShown("visible")).toBe(true);
    expect(isDocumentShown("hidden")).toBe(false);
    expect(isDocumentShown(undefined)).toBe(false);
    /* Історичне значення, і будь-яке майбутнє невідоме: не показано. */
    expect(isDocumentShown("prerender")).toBe(false);
    expect(isDocumentShown("")).toBe(false);
  });
});

describe("U-59 — хук КОРИСТУЄТЬСЯ правилом, а не тримає копію поруч", () => {
  it("зелена лінія: обидва джерела прочитані і це справді вони", () => {
    /* Без цього кроку кожен `not.toMatch` нижче був би зелений і на порожньому
       рядку — «не знайшов» не доводить нічого, поки не повернулось те, що
       напевно є. */
    expect(hook.length).toBeGreaterThan(5000);
    expect(hook).toMatch(/export function useAckWhenVisible\(/);
    expect(store).toMatch(/export function useDocumentVisible\(/);
  });

  it("рішення береться з lib/ackVisibility, а видимість — зі сховища", () => {
    expect(hook).toMatch(/from "@\/lib\/ackVisibility"/);
    expect(hook).toMatch(/from "@\/lib\/useDocumentVisible"/);
    /* ⚠️ Тут САМЕ факт імпорту й виклику. Форму аргументів тримає окремий
       тест нижче — ревʼю А показало, що «ім'я documentVisible присутнє»
       обходиться в одну правку. */
    expect(hook).toMatch(/const documentVisible = useDocumentVisible\(/);
    expect(hook).toMatch(/nextFreeze\(/);
  });

  it("видимість документа є в залежностях ефекту", () => {
    /* Без неї повернення на вкладку не будило б ефект, і відкладений ack не
       стався б ніколи — правило було б правильним і мертвим. */
    expect(hook).toMatch(/\}, \[key, visible, documentVisible, status, fp, refreezeKey, snap\.ackFailGen\]\);/);
  });

  it("заморозку хук присвоює РІВНО один раз, і рахує її не сам", () => {
    /* ⚠️ Головний пін пакета. Мутація, заради якої він існує: другий скид
       заморозки, доданий у будь-яку гілку — правило лишається на місці, всі
       поведінкові тести зелені, а дефект повертається цілком. */
    const writes = hook.match(/frozenRef\.current = /g) || [];
    expect(writes.length, "заморозку присвоюють ще десь").toBe(1);
    expect(hook).toMatch(/const fr = nextFreeze\(\s*gate,\s*frozenRef\.current,/);
    expect(hook).toMatch(/frozenRef\.current = fr;/);
    expect(hook).toMatch(/if \(gate !== "ack" \|\| fr === null\) return;/);
  });

  it("аргументи ackGate пінуються ДОСЛІВНО — інакше фон складають на стороні виклику", () => {
    /* ⚠️ Найтихіший обхід, знайдений ревʼю А: `surfaceVisible: visible &&
       documentVisible` повертає семантику `collapse` для фону, при цьому
       ім'я `documentVisible` у виклику присутнє, скид заморозки один, і всі
       поведінкові тести `ackGate` зелені — бо сам модуль не тронуто. Тому
       пін тримає САМЕ СПИСОК аргументів, а не наявність імені. */
    expect(hook).toMatch(
      /ackGate\(\{\s*hasScope: !!sc,\s*surfaceVisible: visible,\s*documentVisible,\s*status,\s*\}\)/
    );
  });

  it("видимість питається лише там, де може на щось вплинути", () => {
    /* Замір ревʼю Б: місць виклику тринадцять, чотири порядкові. Без прапорця
       перемикання вкладки будило б ререндером кожен рядок дошки. */
    expect(hook).toMatch(/useDocumentVisible\(!!scope && visible\)/);
  });

  it("хук не читає видимість повз сховище", () => {
    expect(hook, "у хуку знову зʼявився прямий доступ до visibilityState").not.toMatch(/visibilityState/);
    expect(store).toMatch(/isDocumentShown\(/);
    expect(store).toMatch(/addEventListener\("visibilitychange", emit\)/);
  });
});

describe("U-59 — арифметика заморозки (nextFreeze)", () => {
  const FR: AckFreeze = { key: "s:waitlist", refreeze: "K1", uid: "u1", ids: ["m1", "m2"] };
  const NOW = { key: "s:waitlist", refreeze: "K1", uid: "u1" };
  const ids = (calls: { n: number }) => () => { calls.n++; return ["fresh"]; };

  it("collapse — заморозку скинуто", () => {
    expect(nextFreeze("collapse", FR, NOW, () => [])).toBeNull();
  });

  it("wait — заморозка не змінилась узагалі", () => {
    expect(nextFreeze("wait", FR, NOW, () => [])).toBe(FR);
  });

  it("hold без заморозки нічого не створює", () => {
    expect(nextFreeze("hold", null, NOW, () => [])).toBeNull();
  });

  it("hold НЕСЕ ключ перезаморозки, але НЕ чіпає id", () => {
    /* Це і є лікування, знайдене ревʼю. */
    const out = nextFreeze("hold", FR, { ...NOW, refreeze: "K3" }, () => ["fresh"]);
    expect(out).not.toBeNull();
    expect(out?.refreeze).toBe("K3");
    expect(out?.ids).toEqual(["m1", "m2"]);
  });

  it("ЦЕНТРАЛЬНИЙ СЦЕНАРІЙ: поверхня перечиталась у фоні — повернення НЕ робить перезаморозки", () => {
    /* Крок за кроком те, що ревʼю знайшло як невилікуване:
       1) розкрито під видимою вкладкою, заморозка з id m1,m2;
       2) вкладка у фоні, дані перечитались, ключ K1 → K3;
       3) людина повернулась.
       До лікування крок 3 давав НОВУ заморозку по поточному пулу і гасив те,
       чого людина не бачила. Тепер id мусять лишитись тими самими, а
       постачальника свіжих id не мусять покликати ЖОДНОГО разу. */
    const calls = { n: 0 };
    const held = nextFreeze("hold", FR, { ...NOW, refreeze: "K3" }, ids(calls));
    const back = nextFreeze("ack", held, { ...NOW, refreeze: "K3" }, ids(calls));
    expect(back?.ids, "повернення погасило те, що прилетіло у фоні").toEqual(["m1", "m2"]);
    expect(calls.n, "по поверненні зроблено перезаморозку").toBe(0);
  });

  it("зміна ключа ПІД ВИДИМОЮ вкладкою — перезаморозка, і це правильно", () => {
    const calls = { n: 0 };
    const out = nextFreeze("ack", FR, { ...NOW, refreeze: "K2" }, ids(calls));
    expect(out?.ids).toEqual(["fresh"]);
    expect(calls.n).toBe(1);
  });

  it("зміна scope або користувача — теж перезаморозка", () => {
    expect(nextFreeze("ack", FR, { ...NOW, key: "s:incidents" }, () => ["x"])?.ids).toEqual(["x"]);
    expect(nextFreeze("ack", FR, { ...NOW, uid: "u2" }, () => ["x"])?.ids).toEqual(["x"]);
  });

  it("нічого не змінилось — та сама заморозка, без зайвого читання пулу", () => {
    const calls = { n: 0 };
    expect(nextFreeze("ack", FR, NOW, ids(calls))).toBe(FR);
    expect(calls.n).toBe(0);
  });

  it("першe розкриття — заморозка з поточного пулу", () => {
    const calls = { n: 0 };
    const out = nextFreeze("ack", null, NOW, ids(calls));
    expect(out).toEqual({ ...NOW, ids: ["fresh"] });
    expect(calls.n).toBe(1);
  });
});

describe("U-59 — сховище видимості перевіряється БЕЗ DOM", () => {
  /* Рукописний хост замість `document`: канон `vitest.config.ts` (тести —
     чисті функції) не порушено, а поведінка сховища тепер вимірна. До ревʼю
     с58 її не знімало ніщо, і три однобуквені правки лишали піни зеленими. */
  const fakeHost = (state: string) => {
    const on: Array<() => void> = [];
    const host: VisibilityHost & { fire: () => void; count: number; set: (s: string) => void } = {
      visibilityState: state,
      addEventListener: (_t, cb) => { on.push(cb); host.count++; },
      removeEventListener: (_t, cb) => { const i = on.indexOf(cb); if (i >= 0) on.splice(i, 1); },
      fire: () => { for (const cb of [...on]) cb(); },
      count: 0,
      set: (s) => { host.visibilityState = s; },
    };
    return host;
  };

  it("знімок читається з хоста і слухає fail-CLOSED", () => {
    const host = fakeHost("visible");
    const s = createVisibilityStore(host);
    expect(s.getSnapshot()).toBe(true);
    host.set("hidden");
    expect(s.getSnapshot()).toBe(false);
  });

  it("слухач навішується РІВНО один на всіх підписників", () => {
    const host = fakeHost("visible");
    const s = createVisibilityStore(host);
    s.subscribe(() => {});
    s.subscribe(() => {});
    s.subscribe(() => {});
    expect(host.count, "слухач на кожного підписника — саме цього уникали").toBe(1);
    expect(s.listenerCount()).toBe(3);
  });

  it("подія будить УСІХ підписників — інакше правило правильне і мертве", () => {
    /* Мутація, заради якої тест існує: `attached = true` початковим значенням
       або порожній `emit`. Обидві лишали лексичні піни зеленими. */
    const host = fakeHost("hidden");
    const s = createVisibilityStore(host);
    let a = 0, b = 0;
    s.subscribe(() => { a++; });
    s.subscribe(() => { b++; });
    host.set("visible");
    host.fire();
    expect(a, "підписника не розбудили").toBe(1);
    expect(b, "розбудили не всіх").toBe(1);
    expect(s.getSnapshot()).toBe(true);
  });

  it("відписка справді відписує", () => {
    const host = fakeHost("visible");
    const s = createVisibilityStore(host);
    let n = 0;
    const off = s.subscribe(() => { n++; });
    off();
    host.fire();
    expect(n).toBe(0);
    expect(s.listenerCount()).toBe(0);
  });

  it("без хоста (SSR) сховище не падає і каже «не показано»", () => {
    const s = createVisibilityStore(null);
    expect(s.getSnapshot()).toBe(false);
    expect(() => s.subscribe(() => {})()).not.toThrow();
  });
});
