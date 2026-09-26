/* ===== с81 — автомат «потримати над ціллю» (lib/dragHover.ts) =====
   Поведінкою, з підробленими таймерами, в ОБОХ порядках подій рушіїв:
     Blink/WebKit — `dragenter` нової цілі ПЕРЕД `dragleave` старої;
     Gecko        — `dragleave` старої ПЕРЕД `dragenter` нової.
   Саме на першому порядку р1-ревʼю зловило High: безумовне гасіння в
   `dragleave` вбивало щойно заведений таймер сусіднього дня. */
import { describe, it, expect } from "vitest";
import { createHoverArmer, type HoverTarget } from "../lib/dragHover";

/** Підроблені таймери: спрацьовують за `tick(ms)`. */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      set: (fn: () => void, ms: number) => { const id = ++seq; pending.set(id, { at: now + ms, fn }); return id; },
      clear: (h: unknown) => { pending.delete(h as number); },
    },
    tick(ms: number) {
      now += ms;
      /* у порядку строку спрацювання; колбек може завести новий таймер */
      for (;;) {
        const due = [...pending.entries()].filter(([, p]) => p.at <= now).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        due[1].fn();
      }
    },
    count: () => pending.size,
  };
}

const target = (log: string[], name: string, repeat = false): HoverTarget => ({ ms: 600, fire: () => log.push(name), repeat });

describe("наведення на день", () => {
  it("тримаємо над одним днем — спрацьовує РІВНО раз, поки не вийти", () => {
    const t = fakeTimers(); const log: string[] = [];
    const a = createHoverArmer(t.timers);
    a.enter("A", target(log, "A"));
    for (let i = 0; i < 10; i++) { t.tick(100); a.over("A", target(log, "A")); }
    expect(log).toEqual(["A"]);
    t.tick(5000); a.over("A", target(log, "A"));
    expect(log).toEqual(["A"]);            // повторні dragover тієї ж цілі не відкривають удруге
    expect(a.armedKey()).toBe("A");
    a.leave("A"); expect(a.armedKey()).toBeNull();
    a.enter("A", target(log, "A")); t.tick(600);
    expect(log).toEqual(["A", "A"]);       // вихід і повернення заводять заново
  });

  it("Blink/WebKit: enter(B) → leave(A) → over(B) — таймер B ЖИВЕ", () => {
    const t = fakeTimers(); const log: string[] = [];
    const a = createHoverArmer(t.timers);
    a.enter("A", target(log, "A")); t.tick(300);
    a.enter("B", target(log, "B"));        // нова ціль першою
    a.leave("A");                          // стара — після; свій ключ уже не A
    a.over("B", target(log, "B"));
    expect(a.armedKey()).toBe("B");
    t.tick(599); expect(log).toEqual([]);  // A не спрацював (згасив перехід), B ще ні
    t.tick(1); expect(log).toEqual(["B"]);
  });

  it("Gecko: leave(A) → enter(B) → over(B) — те саме", () => {
    const t = fakeTimers(); const log: string[] = [];
    const a = createHoverArmer(t.timers);
    a.enter("A", target(log, "A")); t.tick(300);
    a.leave("A"); expect(a.armedKey()).toBeNull();
    a.enter("B", target(log, "B")); a.over("B", target(log, "B"));
    t.tick(600); expect(log).toEqual(["B"]);
  });

  it("A → B → A швидко (Blink): таймер від ОСТАННЬОГО входу, старий A не спрацьовує", () => {
    const t = fakeTimers(); const log: string[] = [];
    const a = createHoverArmer(t.timers);
    a.enter("A", target(log, "A")); t.tick(400);
    a.enter("B", target(log, "B")); a.leave("A"); t.tick(100);
    a.enter("A", target(log, "A")); a.leave("B");
    t.tick(500); expect(log).toEqual([]);  // з другого входу в A минуло 500 < 600
    t.tick(100); expect(log).toEqual(["A"]);
    expect(t.count()).toBe(0);
  });

  it("вхід у дочірній елемент цілі (inside) — не вихід", () => {
    const t = fakeTimers(); const log: string[] = [];
    const a = createHoverArmer(t.timers);
    a.enter("A", target(log, "A")); t.tick(300);
    a.leave("A", true);                    // dragleave з relatedTarget усередині
    a.over("A", target(log, "A"));
    t.tick(300); expect(log).toEqual(["A"]);
  });

  it("leave чужого ключа нічого не гасить; cancel гасить усе", () => {
    const t = fakeTimers(); const log: string[] = [];
    const a = createHoverArmer(t.timers);
    a.enter("A", target(log, "A"));
    a.leave("Z"); expect(a.armedKey()).toBe("A");
    a.cancel(); expect(a.armedKey()).toBeNull(); expect(t.count()).toBe(0);
    t.tick(1000); expect(log).toEqual([]);
  });
});

describe("стрілки місяця (repeat)", () => {
  it("гортає раз на період, поки курсор на стрілці, і зупиняється на leave", () => {
    const t = fakeTimers(); const log: string[] = [];
    const a = createHoverArmer(t.timers);
    a.enter("nav:1", target(log, "next", true));
    t.tick(600); expect(log).toEqual(["next"]);
    a.over("nav:1", target(log, "next", true));   // dragover не перезаводить (ключ той самий)
    t.tick(600); expect(log).toEqual(["next", "next"]);
    a.leave("nav:1");
    t.tick(3000); expect(log).toEqual(["next", "next"]);
    expect(t.count()).toBe(0);
  });

  it("перехід зі стрілки на день перехоплює ключ — стрілка більше не гортає", () => {
    const t = fakeTimers(); const log: string[] = [];
    const a = createHoverArmer(t.timers);
    a.enter("nav:1", target(log, "next", true)); t.tick(600);
    a.enter("D", target(log, "D")); a.leave("nav:1");
    t.tick(600); expect(log).toEqual(["next", "D"]);
    t.tick(1200); expect(log).toEqual(["next", "D"]);
  });
});
