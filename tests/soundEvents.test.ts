/* ===== Тести звукових сповіщень: чисті класифікатори + дедуп =====
   Компонентного jsdom-стека у проєкті немає (свідомо) — тому вся критична
   логіка звуку винесена в чисті функції (lib/soundEvents.ts, lib/soundTabDedupe.ts)
   і покривається тут. Web Audio-движок і React-хук лишаються тонкими обгортками,
   що перевіряються живьем. */

import { describe, it, expect } from "vitest";
import {
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
import { TabSoundDedupe } from "../lib/soundTabDedupe";

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
