/* ===== RadFlow — звукові сповіщення: чисті класифікатори =====
   Мінімальний набір: ТРИ звукові профілі на весь продукт.
     • ready    — «пацієнт готовий до виклику»: реальний перехід scheduled → waiting;
     • critical — «критичне втручання»: перший перехід запису в needs_reschedule
                  (для направника — також not_held) або інцидент, що ФАКТИЧНО
                  став активним (новий активний чи planned, який дійшов до started_at);
     • overrun  — «дослідження триває довше запланованого»: мить, коли таймер
                  кабінету стає червоним («+MM:SS»). Рішення власника: третій
                  профіль, бо це «пора завершувати», а не аварія.

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

export type QueueSoundKind = "ready" | "critical" | "overrun";

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

/* ===== Перевищення планового часу дослідження =====
   ДЗЕРКАЛО components/StudyTimer: відлік іде від in_progress_at і охоплює
   дослідження ПЛЮС буфер прибирання («коли кабінет повністю звільниться» —
   рішення власника). Це мить, коли таймер перемикається на «+MM:SS».
   ⚠️ Уточнення (ревʼю M3): ЧЕРВОНИМ кільце стає РАНІШЕ — за 5 хв до кінця
   (`CRIT_SEC` у StudyTimer, клас `.crit` має той самий `--red`, що й `.over`).
   Тобто звук збігається з появою «+», а не з появою червоного кольору.

   ⚠️ Це РЕАЛЬНА тривалість (різниця двох інстантів), а не «настінний» час: сюди
   НЕ можна підставляти wallNow(), інакше величина поїде на зміщенні таймзони.
   Дефолти теж дзеркальні дошкам: duration_min || 30, buffer_time_min ?? 5. */
export type SoundOverrunEntry = {
  id: string;
  status?: string | null;
  in_progress_at?: string | null;
  duration_min?: number | null;
  buffer_time_min?: number | null;
};

/* КОНТРАКТ джерела перевищень (ревʼю M4). Поля тут ОБОВ'ЯЗКОВІ як ключі (значення
   можуть бути null) — на відміну від SoundOverrunEntry, де вони опційні заради
   зручності класифікатора. Дошки, які вмикають overrunEnabled, ОБОВ'ЯЗАНІ
   анотувати свій масив цим типом: якщо колонку приберуть із select, TS впаде
   тут, а не мовчки перейде на дефолти 30+5 і розійдеться з таймером. */
export type OverrunSource = {
  id: string;
  status: string | null;
  in_progress_at: string | null;
  duration_min: number | null;
  buffer_time_min: number | null;
};

const OVERRUN_BUFFER_DEFAULT = 5; // = BUFFER_DEFAULT (lib/studies)

/** Чи вичерпано планове вікно кабінету (дослідження + буфер) для запису. */
export function isStudyOverrun(e: SoundOverrunEntry | null | undefined, nowMs: number): boolean {
  if (!e || e.status !== "in_progress" || !e.in_progress_at) return false;
  const start = new Date(e.in_progress_at).getTime();
  if (!Number.isFinite(start)) return false;
  const totalMs = ((e.duration_min || 30) + (e.buffer_time_min ?? OVERRUN_BUFFER_DEFAULT)) * 60000;
  return nowMs - start > totalMs;
}

/* Диф перевищень: prevKnown — мапа id → «чи вже перевищував» (null = baseline).
   Перше обчислення тихе: дослідження, яке ВЖЕ висіло понад план, коли дошку
   відкрили, не сигналить — інакше кожне відкриття вкладки давало б звук.
   Подія — лише перехід false → true.
   Ключ `qe-over:<id>` без часової компоненти — СВІДОМО: одне перевищення на
   запис за весь час життя вкладки. Якщо оператор продовжить тривалість і запис
   вийде за план удруге, звуку вже не буде (ревʼю L6): краще недосказати, ніж
   пищати повторно на те саме дослідження. */
export function diffOverruns(
  prevKnown: ReadonlyMap<string, boolean> | null,
  entries: readonly SoundOverrunEntry[],
  nowMs: number
): { events: SoundEvent[]; next: Map<string, boolean> } {
  const next = new Map<string, boolean>();
  const events: SoundEvent[] = [];
  for (const e of entries) {
    if (!e || !e.id) continue;
    const over = isStudyOverrun(e, nowMs);
    next.set(e.id, over);
    if (!prevKnown) continue;            // baseline — фіксуємо, не звучимо
    /* `has` обов'язковий (ревʼю H1): запис, якого в попередньому знімку НЕ БУЛО,
       не може «щойно перетнути поріг» — поріг настає щонайменше через 35 хв
       після старту, тож нове id з over=true це ЗАВЖДИ історія (інший день,
       щойно виданий радіологу кабінет), а не новина. Без `has` повернення на
       сьогоднішню дату озвучувало б дослідження, яке триває понад план годину.
       Те саме правило, що й у diffQueueEntries: порівнюємо лише наявні. */
    if (over && prevKnown.has(e.id) && prevKnown.get(e.id) !== true) {
      events.push({ kind: "overrun", key: "qe-over:" + e.id });
    }
  }
  return { events, next };
}

/* Burst-агрегація: кілька подій в одному вікні → ОДИН звук.
   Пріоритет: critical > overrun > ready — від «щось зламалось» до «просто
   готовий пацієнт». */
export function resolveBurst(events: readonly SoundEvent[]): QueueSoundKind | null {
  if (!events.length) return null;
  if (events.some((e) => e.kind === "critical")) return "critical";
  if (events.some((e) => e.kind === "overrun")) return "overrun";
  return "ready";
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
