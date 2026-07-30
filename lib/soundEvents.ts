/* ===== RadFlow — звукові сповіщення: чисті класифікатори =====
   Мінімальний набір: ДВА звукові профілі на весь продукт.
     • ready    — «пацієнт готовий до виклику»: реальний перехід scheduled → waiting;
     • critical — «критичне втручання»: перший перехід запису в needs_reschedule
                  (для направника — також not_held) або інцидент, що ФАКТИЧНО
                  став активним (новий активний чи planned, який дійшов до started_at).

   Джерело подій — порівняння послідовних УСПІШНИХ snapshot'ів стану дошки
   (useRealtimeRefetch не передає payload, лише смикає лоадер, тому дифаємо стани).
   Правила, які тримає саме цей шар:
     • перший snapshot — baseline, без звуку;
     • порівнюємо ЛИШЕ записи, що існували в попередньому snapshot (новий запис
       одразу у waiting / needs_reschedule НЕ звучить);
     • деактивація/зняття/закінчення інциденту — тиша;
     • похідні статуси («Запізнення», «Уточнити») свідомо НЕ озвучуються — вони
       обчислюються таймерами і дали б повторні сигнали, які нема чим дедуплікувати.

   Тут НЕМАЄ React, DOM, Web Audio і таймерів — усе покривається vitest.
   Стан між викликами (baseline-мапи, fired-ключі) тримає хук useQueueSounds. */

import { incidentActiveAt, type IncidentLike } from "./incidents";

export type QueueSoundKind = "ready" | "critical";

/** Подія зі стабільним ключем: той самий бізнес-факт → той самий ключ (дедуп). */
export type SoundEvent = { kind: QueueSoundKind; key: string };

/** Мінімальна форма запису черги, потрібна класифікатору. */
export type SoundQueueEntry = { id: string; status?: string | null };

/** Мінімальна форма інциденту (підмножина IncidentRow дошок). */
export type SoundIncident = IncidentLike & { id: string; room_id?: string | null };

export type QueueDiffConfig = {
  /** Чи дозволені події «пацієнт готовий» (дошка відкрита на СЬОГОДНІ за TZ клініки). */
  readyEnabled?: boolean;
  /** Статуси, перший перехід у які дає critical. Персонал — лише needs_reschedule;
   *  направник — needs_reschedule + not_held (окремого звуку для staff not_held НЕМАЄ). */
  criticalStatuses?: readonly string[];
};

export const DEFAULT_CRITICAL_STATUSES: readonly string[] = ["needs_reschedule"];
export const REFERRER_CRITICAL_STATUSES: readonly string[] = ["needs_reschedule", "not_held"];

/* Диф записів черги: prev — мапа id → status із попереднього УСПІШНОГО snapshot
   (null = baseline ще не встановлено). Повертає події та наступну мапу.
   Помилковий snapshot сюди не потрапляє взагалі — baseline не очищається. */
export function diffQueueEntries(
  prev: ReadonlyMap<string, string> | null,
  entries: readonly SoundQueueEntry[],
  cfg: QueueDiffConfig = {}
): { events: SoundEvent[]; next: Map<string, string> } {
  const critical = new Set(cfg.criticalStatuses ?? DEFAULT_CRITICAL_STATUSES);
  const next = new Map<string, string>();
  const events: SoundEvent[] = [];
  for (const e of entries) {
    if (!e || !e.id) continue;
    const status = String(e.status ?? "");
    next.set(e.id, status);
    if (!prev) continue; // перший snapshot — baseline без звуку
    const was = prev.get(e.id);
    // Новий запис (не існував у попередньому snapshot) або без переходу — тиша.
    if (was === undefined || was === status) continue;
    if (cfg.readyEnabled !== false && was === "scheduled" && status === "waiting") {
      events.push({ kind: "ready", key: "qe-ready:" + e.id });
    }
    if (!critical.has(was) && critical.has(status)) {
      // Ключ містить статус: перехід у needs_reschedule і (у направника) в
      // not_held — різні факти, але повтор того САМОГО факту не звучить.
      events.push({ kind: "critical", key: "qe-crit:" + e.id + ":" + status });
    }
  }
  return { events, next };
}

/* Диф інцидентів: prevKnown — мапа id → «чи був фактично активним» (null = baseline).
   Активність — за ІСНУЮЧИМ вікном [started_at, blocked_until) через incidentActiveAt
   і настінним nowMs (wallNow за TZ клініки) — тому planned-інцидент мовчить до
   started_at і звучить один раз, коли вікно настало (навіть без realtime-події:
   хук перевіряє періодично). roomIds звужує scope (радіолог — лише свої кабінети).
   breakdown / maintenance / emergency НЕ розрізняються — один критичний звук. */
export function diffIncidents(
  prevKnown: ReadonlyMap<string, boolean> | null,
  incidents: readonly SoundIncident[],
  nowMs: number,
  roomIds?: readonly string[] | null
): { events: SoundEvent[]; next: Map<string, boolean> } {
  const scope = roomIds ? new Set(roomIds) : null;
  const next = new Map<string, boolean>();
  const events: SoundEvent[] = [];
  for (const inc of incidents) {
    if (!inc || !inc.id) continue;
    if (scope && (!inc.room_id || !scope.has(inc.room_id))) continue;
    const active = incidentActiveAt(inc, nowMs);
    next.set(inc.id, active);
    if (!prevKnown) continue; // baseline: фіксуємо стан, не звучимо
    const was = prevKnown.get(inc.id);
    // Звучить лише поява ФАКТИЧНОЇ активності: новий активний (was === undefined)
    // або відомий planned, що дійшов до started_at (was === false).
    if (active && was !== true) events.push({ kind: "critical", key: "inc:" + inc.id });
    // active=false при was=true (вікно скінчилось / зняли) — свідома тиша.
  }
  return { events, next };
}

/* Burst-агрегація: кілька подій в одному вікні → ОДИН звук; критичний має
   пріоритет над «пацієнт готовий». */
export function resolveBurst(events: readonly SoundEvent[]): QueueSoundKind | null {
  if (!events.length) return null;
  return events.some((e) => e.kind === "critical") ? "critical" : "ready";
}

/* Гейт відтворення. Події СПОЖИВАЮТЬСЯ (потрапляють у fired) незалежно від того,
   чи буде звук: вимкнена настройка або прихована вкладка означає «факт відомий,
   але мовчимо» — після вмикання/повернення на вкладку накопичена історія НЕ
   програється, а polling/focus/reconnect не повторюють уже відомі події. */
export function settleEvents(
  events: readonly SoundEvent[],
  fired: Set<string>,
  opts: { enabled: boolean; visible: boolean }
): SoundEvent[] {
  const fresh: SoundEvent[] = [];
  for (const ev of events) {
    if (fired.has(ev.key)) continue;
    fired.add(ev.key);
    fresh.push(ev);
  }
  if (!opts.enabled || !opts.visible) return [];
  return fresh;
}

/* Неперсональний dedupe-ключ для міжвкладкової координації (BroadcastChannel):
   назовні не виходять ні id записів, ні статуси — лише короткий хеш (djb2). */
export function dedupeHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
