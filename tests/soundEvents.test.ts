/* ===== Тести звукових сповіщень: чисті класифікатори + дедуп =====
   Компонентного jsdom-стека у проєкті немає (свідомо) — тому вся критична
   логіка звуку винесена в чисті функції (lib/soundEvents.ts, lib/soundTabDedupe.ts)
   і покривається тут. Web Audio-движок і React-хук лишаються тонкими обгортками,
   що перевіряються живьем. */

import { describe, it, expect } from "vitest";
import {
  isStudyOverrun,
  diffOverruns,
  DEFAULT_CRITICAL_STATUSES,
  REFERRER_CRITICAL_STATUSES,
  dedupeHash,
  diffIncidents,
  diffQueueEntries,
  resolveBurst,
  settleEvents,
  type SoundEvent,
  type SoundIncident,
} from "../lib/soundEvents";
import { TabSoundDedupe, type LockManagerLike } from "../lib/soundTabDedupe";

const e = (id: string, status: string) => ({ id, status });

/* Прогін послідовності snapshot'ів через diffQueueEntries — так, як це робить хук. */
function runSnapshots(snaps: Array<Array<{ id: string; status: string }>>, cfg?: Parameters<typeof diffQueueEntries>[2]) {
  let prev: Map<string, string> | null = null;
  const all: SoundEvent[][] = [];
  for (const s of snaps) {
    const { events, next } = diffQueueEntries(prev, s, cfg);
    prev = next;
    all.push(events);
  }
  return all;
}

describe("diffQueueEntries — записи черги", () => {
  it("перший snapshot — baseline, тиша (навіть із waiting/needs_reschedule всередині)", () => {
    const [ev] = runSnapshots([[e("a", "waiting"), e("b", "needs_reschedule"), e("c", "scheduled")]]);
    expect(ev).toEqual([]);
  });

  it("scheduled → waiting дає patientReady", () => {
    const [, ev] = runSnapshots([[e("a", "scheduled")], [e("a", "waiting")]]);
    expect(ev).toEqual([{ kind: "ready", key: "qe-ready:a" }]);
  });

  it("нова запис одразу у waiting НЕ звучить (порівнюємо лише наявні в попередньому snapshot)", () => {
    const [, ev] = runSnapshots([[e("a", "scheduled")], [e("a", "scheduled"), e("b", "waiting")]]);
    expect(ev).toEqual([]);
  });

  it("нова запис одразу в needs_reschedule НЕ звучить", () => {
    const [, ev] = runSnapshots([[e("a", "scheduled")], [e("a", "scheduled"), e("b", "needs_reschedule")]]);
    expect(ev).toEqual([]);
  });

  it("waiting → in_progress та in_progress → done мовчать", () => {
    const [, ev1, ev2] = runSnapshots([[e("a", "waiting")], [e("a", "in_progress")], [e("a", "done")]]);
    expect(ev1).toEqual([]);
    expect(ev2).toEqual([]);
  });

  it("cancelled / no_show / not_held у персоналу мовчать (DEFAULT_CRITICAL_STATUSES)", () => {
    expect(DEFAULT_CRITICAL_STATUSES).toEqual(["needs_reschedule"]);
    const [, ev] = runSnapshots([
      [e("a", "scheduled"), e("b", "scheduled"), e("c", "waiting")],
      [e("a", "cancelled"), e("b", "no_show"), e("c", "not_held")],
    ]);
    expect(ev).toEqual([]);
  });

  it("перехід у needs_reschedule дає critical", () => {
    const [, ev] = runSnapshots([[e("a", "scheduled")], [e("a", "needs_reschedule")]]);
    expect(ev).toEqual([{ kind: "critical", key: "qe-crit:a:needs_reschedule" }]);
  });

  it("повторний ідентичний snapshot мовчить (polling/focus/reconnect)", () => {
    const [, ev1, ev2] = runSnapshots([
      [e("a", "scheduled")],
      [e("a", "waiting")],
      [e("a", "waiting")],
    ]);
    expect(ev1.length).toBe(1);
    expect(ev2).toEqual([]);
  });

  it("направник: власний not_held дає critical; needs_reschedule — теж", () => {
    const cfg = { readyEnabled: false, criticalStatuses: REFERRER_CRITICAL_STATUSES };
    const [, ev] = runSnapshots(
      [[e("a", "scheduled"), e("b", "scheduled")], [e("a", "not_held"), e("b", "needs_reschedule")]],
      cfg
    );
    expect(ev.map((x) => x.kind)).toEqual(["critical", "critical"]);
  });

  it("readyEnabled=false (направник / не-сьогодні) глушить scheduled → waiting", () => {
    const [, ev] = runSnapshots([[e("a", "scheduled")], [e("a", "waiting")]], { readyEnabled: false });
    expect(ev).toEqual([]);
  });

  it("перехід МІЖ критичними статусами не звучить повторно", () => {
    const cfg = { criticalStatuses: REFERRER_CRITICAL_STATUSES };
    const [, ev] = runSnapshots([[e("a", "needs_reschedule")], [e("a", "not_held")]], cfg);
    // a вже був у критичному статусі в baseline → перехід not_held не «перший».
    expect(ev).toEqual([]);
  });

  it("зникнення запису зі snapshot'а мовчить, повернення — знову як нова", () => {
    const [, ev1, ev2] = runSnapshots([
      [e("a", "scheduled")],
      [],
      [e("a", "waiting")],
    ]);
    expect(ev1).toEqual([]);
    expect(ev2).toEqual([]); // «a» не існувала в попередньому snapshot
  });
});

/* Інциденти: вікно [started_at, blocked_until) — через існуючий incidentActiveAt. */
const T0 = Date.UTC(2026, 6, 30, 12, 0, 0); // «зараз» (настінні мс, як wallNow)
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60000;

const inc = (id: string, startMs: number, endMs: number | null, room = "r1"): SoundIncident => ({
  id,
  room_id: room,
  started_at: iso(startMs),
  blocked_until: endMs == null ? null : iso(endMs),
  auto_unblock: true,
});

describe("diffIncidents — інциденти", () => {
  it("baseline: активний інцидент у першому snapshot НЕ звучить", () => {
    const { events, next } = diffIncidents(null, [inc("i1", T0 - 10 * MIN, null)], T0);
    expect(events).toEqual([]);
    expect(next.get("i1")).toBe(true);
  });

  it("новий фактично активний інцидент дає critical", () => {
    const s1 = diffIncidents(null, [], T0);
    const s2 = diffIncidents(s1.next, [inc("i1", T0 - MIN, null)], T0);
    expect(s2.events).toEqual([{ kind: "critical", key: "inc:i1" }]);
  });

  it("planned до started_at мовчить; при настанні started_at звучить один раз", () => {
    const planned = inc("i1", T0 + 30 * MIN, T0 + 90 * MIN);
    const s1 = diffIncidents(null, [], T0);
    const s2 = diffIncidents(s1.next, [planned], T0);            // з'явився, ще не активний
    expect(s2.events).toEqual([]);
    const s3 = diffIncidents(s2.next, [planned], T0 + 31 * MIN); // вікно настало
    expect(s3.events).toEqual([{ kind: "critical", key: "inc:i1" }]);
    const s4 = diffIncidents(s3.next, [planned], T0 + 32 * MIN); // далі — тиша
    expect(s4.events).toEqual([]);
  });

  it("зняття/закінчення вікна/зникнення зі списку — тиша", () => {
    const a = inc("i1", T0 - 60 * MIN, T0 + 5 * MIN);
    const s1 = diffIncidents(null, [a], T0);
    // Вікно скінчилось (blocked_until позаду) — активність зникла, звуку немає.
    const s2 = diffIncidents(s1.next, [a], T0 + 10 * MIN);
    expect(s2.events).toEqual([]);
    expect(s2.next.get("i1")).toBe(false);
    // Resolved → рядок зник із запиту (status-фільтр) — теж тиша.
    const s3 = diffIncidents(s2.next, [], T0 + 11 * MIN);
    expect(s3.events).toEqual([]);
    expect(s3.next.has("i1")).toBe(false);
  });

  it("радіолог чує лише призначені кабінети (roomIds-scope)", () => {
    const s1 = diffIncidents(null, [], T0, ["r1"]);
    const s2 = diffIncidents(
      s1.next,
      [inc("mine", T0 - MIN, null, "r1"), inc("other", T0 - MIN, null, "r2")],
      T0,
      ["r1"]
    );
    expect(s2.events).toEqual([{ kind: "critical", key: "inc:mine" }]);
  });

  it("смена scope: baseline будується заново без звуку (prevKnown=null)", () => {
    const active = inc("i1", T0 - MIN, null);
    const s1 = diffIncidents(null, [active], T0);
    expect(s1.events).toEqual([]);
    // «Скид» — хук передає null знову: той самий активний інцидент не озвучується.
    const s2 = diffIncidents(null, [active], T0 + MIN);
    expect(s2.events).toEqual([]);
  });
});

describe("resolveBurst — агрегація сплеску", () => {
  const ready = (id: string): SoundEvent => ({ kind: "ready", key: "qe-ready:" + id });
  const crit = (id: string): SoundEvent => ({ kind: "critical", key: "inc:" + id });

  it("порожньо → null; кілька однакових → один звук", () => {
    expect(resolveBurst([])).toBeNull();
    expect(resolveBurst([ready("a"), ready("b"), ready("c")])).toBe("ready");
    expect(resolveBurst([crit("a"), crit("b")])).toBe("critical");
  });

  it("critical має пріоритет над patientReady", () => {
    expect(resolveBurst([ready("a"), crit("b"), ready("c")])).toBe("critical");
  });
});

describe("settleEvents — гейт відтворення і «впервые»", () => {
  const ev = (key: string): SoundEvent => ({ kind: "ready", key });

  it("вимкнена настройка блокує відтворення, але СПОЖИВАЄ події (без реплею після вмикання)", () => {
    const fired = new Set<string>();
    expect(settleEvents([ev("k1")], fired, { enabled: false, visible: true })).toEqual([]);
    expect(fired.has("k1")).toBe(true);
    // Увімкнули звук — та сама подія вже не грає.
    expect(settleEvents([ev("k1")], fired, { enabled: true, visible: true })).toEqual([]);
  });

  it("прихована вкладка не програє накопичену історію після повернення", () => {
    const fired = new Set<string>();
    expect(settleEvents([ev("k1"), ev("k2")], fired, { enabled: true, visible: false })).toEqual([]);
    expect(settleEvents([ev("k1"), ev("k2")], fired, { enabled: true, visible: true })).toEqual([]);
  });

  it("той самий факт двічі (bounce статусу) — грає один раз", () => {
    const fired = new Set<string>();
    expect(settleEvents([ev("k1")], fired, { enabled: true, visible: true }).length).toBe(1);
    expect(settleEvents([ev("k1")], fired, { enabled: true, visible: true })).toEqual([]);
  });
});

describe("dedupeHash + TabSoundDedupe — міжвкладкова координація", () => {
  it("хеш стабільний і не містить вихідного id", () => {
    const key = "qe-ready:0b7f2c9a-1111-2222-3333-444455556666";
    const h = dedupeHash(key);
    expect(h).toBe(dedupeHash(key));
    expect(h).not.toContain("0b7f2c9a");
    expect(h.length).toBeLessThan(10);
  });

  it("ключ, оголошений іншою вкладкою, не грає повторно; свіжі ключі — оголошуються", () => {
    const d = new TabSoundDedupe("rf-sound-test-" + Math.random());
    const now = 1_000_000;
    d.receive({ t: "played", keys: ["h1"], ts: now }, now);
    expect(d.claim(["h1", "h2"], now + 100)).toEqual(["h2"]);
    d.close();
  });

  it("запис «зіграно» протухає (TTL), некоректні повідомлення ігноруються", () => {
    const d = new TabSoundDedupe("rf-sound-test-" + Math.random());
    const now = 1_000_000;
    d.receive({ t: "played", keys: ["h1"], ts: now }, now);
    // @ts-expect-error — навмисно бите повідомлення від чужого коду в каналі
    d.receive({ nonsense: true }, now);
    d.receive(null, now);
    expect(d.claim(["h1"], now + 11_000)).toEqual(["h1"]); // TTL 10 с минув
    d.close();
  });

  it("без BroadcastChannel вкладка просто грає сама (fallback)", () => {
    const G = globalThis as { BroadcastChannel?: unknown };
    const orig = G.BroadcastChannel;
    // Симулюємо старий браузер: конструктор недоступний.
    delete G.BroadcastChannel;
    try {
      const d = new TabSoundDedupe();
      expect(d.claim(["h1"])).toEqual(["h1"]);
      d.close();
    } finally {
      if (orig !== undefined) G.BroadcastChannel = orig;
    }
  });
});

/* ===== Арбітраж права зіграти через Web Locks (с39) =====
   Запасна схема вище («оголосив у канал — і граю») дубль НЕ прибирає: доставка
   каналу асинхронна, і дві вкладки, що флашать в одну мить, обидві бачать
   порожній seen. Тут перевіряється основний шлях: імʼя локу і Є хеш події,
   переможця обирає браузер. Фейковий менеджер моделює рівно те, що робить
   ifAvailable: імʼя зайняте → колбек отримує null; лок тримається, поки не
   зарезолвиться проміс колбека. */
function fakeLockManager() {
  const held = new Set<string>();
  const lm: LockManagerLike = {
    request(name, _options, cb) {
      if (held.has(name)) return Promise.resolve(cb(null));
      held.add(name);
      return Promise.resolve(cb({ name })).then((out) => {
        held.delete(name);
        return out;
      });
    },
  };
  return { lm, held };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("TabSoundDedupe.claimAsync — арбітраж через Web Locks", () => {
  it("одну й ту саму подію дістає РІВНО одна вкладка", async () => {
    const { lm } = fakeLockManager();
    const a = new TabSoundDedupe("t-a", { locks: lm, holdMs: 10_000 });
    const b = new TabSoundDedupe("t-b", { locks: lm, holdMs: 10_000 });
    const [mineA, mineB] = await Promise.all([a.claimAsync(["h1"]), b.claimAsync(["h1"])]);
    expect(mineA).toEqual(["h1"]); // перша встигла — вона й грає
    expect(mineB).toEqual([]);     // друга мовчить, а не грає дубль
    a.close();
    b.close();
  });

  it("різні події не заважають одна одній — обидві вкладки звучать", async () => {
    const { lm } = fakeLockManager();
    const a = new TabSoundDedupe("t-a", { locks: lm, holdMs: 10_000 });
    const b = new TabSoundDedupe("t-b", { locks: lm, holdMs: 10_000 });
    // Дошки на РІЗНИХ датах/ролях бачать різні події — «грає лише лідер» тут
    // втратило б сигнал, тому дедуп саме по ключу, а не по вкладці.
    expect(await a.claimAsync(["h1"])).toEqual(["h1"]);
    expect(await b.claimAsync(["h2"])).toEqual(["h2"]);
    a.close();
    b.close();
  });

  it("close() віддає ключ одразу, не чекаючи TTL (перемонтування дошки)", async () => {
    const { lm, held } = fakeLockManager();
    const a = new TabSoundDedupe("t-a", { locks: lm, holdMs: 10_000 });
    expect(await a.claimAsync(["h1"])).toEqual(["h1"]);
    a.close();
    await tick(); // відпускання локу асинхронне і в браузері теж
    expect(held.size).toBe(0);
    const b = new TabSoundDedupe("t-b", { locks: lm, holdMs: 10_000 });
    expect(await b.claimAsync(["h1"])).toEqual(["h1"]);
    b.close();
  });

  it("лок звільняється сам після holdMs", async () => {
    const { lm } = fakeLockManager();
    const a = new TabSoundDedupe("t-a", { locks: lm, holdMs: 5 });
    expect(await a.claimAsync(["h1"])).toEqual(["h1"]);
    await new Promise((r) => setTimeout(r, 25));
    const b = new TabSoundDedupe("t-b", { locks: lm, holdMs: 5 });
    expect(await b.claimAsync(["h1"])).toEqual(["h1"]);
    a.close();
    b.close();
  });

  it("без Web Locks падаємо на запасну схему, а не мовчимо", async () => {
    const d = new TabSoundDedupe("t-fallback", { locks: null });
    expect(await d.claimAsync(["h1"])).toEqual(["h1"]);
    d.close();
  });

  it("відмова САМОГО арбітра лишає звук: краще дубль, ніж тиша", async () => {
    // Помилка тут однакова в УСІХ вкладках (небезпечний контекст, AbortError):
    // якби ми мовчали, звук зник би цілком — це гірше за дубль.
    const boom: LockManagerLike = {
      request() {
        throw new Error("SecurityError");
      },
    };
    const d1 = new TabSoundDedupe("t-boom", { locks: boom });
    expect(await d1.claimAsync(["h1", "h2"])).toEqual(["h1", "h2"]);
    d1.close();

    const rejecting: LockManagerLike = { request: () => Promise.reject(new Error("AbortError")) };
    const d2 = new TabSoundDedupe("t-reject", { locks: rejecting });
    expect(await d2.claimAsync(["h1"])).toEqual(["h1"]);
    d2.close();
  });
});

/* ===== Перевищення планового часу дослідження (третій профіль) =====
   Поріг — ДЗЕРКАЛО components/StudyTimer: in_progress_at + (duration + buffer).
   Саме тоді кільце стає червоним і показує «+MM:SS», тож звук збігається з тим,
   що видно на екрані. Рішення власника: окремий звук, не критичний. */
describe("diffOverruns — дослідження довше плану", () => {
  const T = Date.UTC(2026, 6, 30, 12, 0, 0);
  const at = (msAgo: number) => new Date(T - msAgo).toISOString();
  const run = (o: Partial<Parameters<typeof isStudyOverrun>[0]> & { id: string }) => ({
    status: "in_progress", in_progress_at: at(0), duration_min: 30, buffer_time_min: 5, ...o,
  });

  it("поріг = тривалість + буфер (мить, коли таймер червоніє)", () => {
    // 30 + 5 = 35 хв. На 34:59 ще ні, на 35:01 — вже так.
    expect(isStudyOverrun(run({ id: "a", in_progress_at: at(34 * 60000 + 59000) }), T)).toBe(false);
    expect(isStudyOverrun(run({ id: "a", in_progress_at: at(35 * 60000 + 1000) }), T)).toBe(true);
  });

  it("дефолти дзеркальні дошкам: duration || 30, buffer ?? 5", () => {
    const e = { id: "d", status: "in_progress", in_progress_at: at(36 * 60000), duration_min: null, buffer_time_min: null };
    expect(isStudyOverrun(e, T)).toBe(true);           // 30+5=35 < 36
    const e2 = { ...e, in_progress_at: at(34 * 60000) };
    expect(isStudyOverrun(e2, T)).toBe(false);
  });

  it("лише in_progress і лише з in_progress_at", () => {
    expect(isStudyOverrun(run({ id: "s", status: "waiting", in_progress_at: at(99 * 60000) }), T)).toBe(false);
    expect(isStudyOverrun(run({ id: "s", status: "done", in_progress_at: at(99 * 60000) }), T)).toBe(false);
    expect(isStudyOverrun(run({ id: "s", in_progress_at: null }), T)).toBe(false);
    expect(isStudyOverrun(run({ id: "s", in_progress_at: "не дата" }), T)).toBe(false);
  });

  it("перший прогін тихий: вже перевищене дослідження на відкритті НЕ сигналить", () => {
    const list = [run({ id: "a", in_progress_at: at(99 * 60000) })];
    const s1 = diffOverruns(null, list, T);
    expect(s1.events).toEqual([]);
    expect(s1.next.get("a")).toBe(true);
  });

  it("перетин порогу дає рівно одну подію, далі тиша", () => {
    const e = run({ id: "a", in_progress_at: at(10 * 60000) });   // 10 хв — у межах
    const s1 = diffOverruns(null, [e], T);
    expect(s1.events).toEqual([]);
    const s2 = diffOverruns(s1.next, [e], T + 26 * 60000);        // 36 хв — вийшли за план
    expect(s2.events).toEqual([{ kind: "overrun", key: "qe-over:a" }]);
    const s3 = diffOverruns(s2.next, [e], T + 40 * 60000);        // далі мовчимо
    expect(s3.events).toEqual([]);
  });

  it("завершення дослідження після перевищення не дає нового звуку", () => {
    const e = run({ id: "a", in_progress_at: at(40 * 60000) });
    const s1 = diffOverruns(null, [e], T);                        // baseline: вже over
    const s2 = diffOverruns(s1.next, [{ ...e, status: "done" }], T + 60000);
    expect(s2.events).toEqual([]);
    expect(s2.next.get("a")).toBe(false);
  });

  it("кілька кабінетів перевищили одночасно → агрегація в один звук", () => {
    const a = run({ id: "a", in_progress_at: at(10 * 60000) });
    const b = run({ id: "b", in_progress_at: at(10 * 60000) });
    const s1 = diffOverruns(null, [a, b], T);
    const s2 = diffOverruns(s1.next, [a, b], T + 30 * 60000);
    expect(s2.events.length).toBe(2);
    expect(resolveBurst(s2.events)).toBe("overrun");
  });
});

describe("resolveBurst — пріоритет трьох профілів", () => {
  const ev = (kind: "ready" | "critical" | "overrun", k: string) => ({ kind, key: k });
  it("critical б'є overrun, overrun б'є ready", () => {
    expect(resolveBurst([ev("ready", "1"), ev("overrun", "2")])).toBe("overrun");
    expect(resolveBurst([ev("overrun", "1"), ev("critical", "2")])).toBe("critical");
    expect(resolveBurst([ev("ready", "1"), ev("overrun", "2"), ev("critical", "3")])).toBe("critical");
  });
});

/* Ревʼю H1/M2: запис, якого НЕ БУЛО в попередньому знімку, не може «щойно
   перетнути поріг» — поріг настає щонайменше через 35 хв після старту. */
describe("diffOverruns — новий id у непорожньому baseline мовчить", () => {
  const T = Date.UTC(2026, 6, 30, 12, 0, 0);
  const old = (min: number) => new Date(T - min * 60000).toISOString();
  const e = (id: string, startedMinAgo: number) => ({
    id, status: "in_progress", in_progress_at: old(startedMinAgo),
    duration_min: 30, buffer_time_min: 5,
  });

  it("повернення на сьогоднішню дату: давно перевищене дослідження НЕ звучить", () => {
    // baseline зібрано на іншому дні — у ньому id "x" відсутній.
    const s1 = diffOverruns(null, [e("other", 1)], T);
    const s2 = diffOverruns(s1.next, [e("x", 90)], T);   // 90 хв при плані 35
    expect(s2.events).toEqual([]);
    expect(s2.next.get("x")).toBe(true);                 // стан зафіксовано тихо
  });

  it("радіологу видали новий кабінет: його перевищений запис НЕ звучить", () => {
    const s1 = diffOverruns(null, [e("mine", 5)], T);
    const s2 = diffOverruns(s1.next, [e("mine", 5), e("newRoom", 120)], T);
    expect(s2.events).toEqual([]);
  });

  it("…але запис, який БУВ у baseline, перетнувши поріг, звучить", () => {
    const s1 = diffOverruns(null, [e("a", 5)], T);
    const s2 = diffOverruns(s1.next, [e("a", 5)], T + 31 * 60000);
    expect(s2.events).toEqual([{ kind: "overrun", key: "qe-over:a" }]);
  });
});
