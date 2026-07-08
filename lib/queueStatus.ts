/* ===== RadFlow — производный статус «требует уточнения» =====
   Если время начала записи уже прошло, а статус всё ещё «В черзі» (scheduled)
   или «Очікує» (waiting, пациент пришёл, но его не вызвали) — запись не
   проведена вовремя и требует действия администратора/радиолога (провести,
   отметить неявку или перенести).
   Это ВИЗУАЛЬНЫЙ производный статус — в БД статус не меняется. */

export interface ClarifyMeta {
  label: string;
  cls: string;
  title: string;
}

export const CLARIFY_META: ClarifyMeta = {
  label: "⚠ Уточнити",
  cls: "orange",
  title: "Потребує уточнення: час запису минув, а пацієнта ще не проведено",
};

/* ===== Производный статус «Запізнення» =====
   Пацієнт НЕ прийшов (статус усе ще scheduled), а від початку слота минуло
   БІЛЬШЕ буферного часу запису. Прямий виклик у кабінет блокується — потрібне
   явне рішення: повернути в чергу («все ж прийшов»), перенести, до листа
   очікування або «не відбулося». Видно всім ролям (derived, БД не змінюється);
   та сама формула піде в n8n/AI-автоматизацію (Stage 2). */

export const LATE_META = {
  label: "⏰ Запізнення",
  cls: "red",
  title:
    "Пацієнт не прийшов — запізнення понад буферний час. Прямий виклик заблоковано: зателефонуйте і перенесіть, поверніть у чергу або зніміть запис.",
} as const;

// dayDate — Date дня записи (00:00); scheduledTime — "HH:MM"; bufferMin — буфер записи.
export function isLate(
  status: string | null | undefined,
  dayDate: Date | null | undefined,
  scheduledTime: string | null | undefined,
  bufferMin: number | null | undefined,
  now: Date = new Date()
): boolean {
  if (status !== "scheduled") return false; // waiting = пацієнт уже прийшов
  if (!dayDate || !scheduledTime) return false;
  const [h, m] = String(scheduledTime).split(":").map(Number);
  const start = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), h || 0, m || 0);
  return now.getTime() > start.getTime() + Math.max(0, bufferMin ?? 5) * 60000;
}

/* ===== Пізній виклик: перевірка фактичного вікна =====
   Виклик у кабінет ЗАРАЗ займає кабінет на (тривалість + буфер) від поточного
   часу, а не від слота. Якщо це вікно налазить на наступний активний запис
   кабінету (scheduled/waiting) — виклик блокується: спершу перенесіть один із
   записів. Захищає сценарії «пацієнт запізнився → все ж прийшов → виклик»
   та будь-який виклик із затримкою. */
export function lateCallClash(
  p: { id: string; room_id: string | null; duration_min: number | null; buffer_time_min: number | null },
  entries: Array<{ id: string; room_id: string | null; status: string; scheduled_time: string | null; patient_name?: string | null }>,
  now: Date = new Date()
): { time: string; name?: string | null } | null {
  if (!p.room_id) return null;
  const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return (h || 0) * 60 + (m || 0); };
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const endMin = nowMin + (p.duration_min || 30) + Math.max(0, p.buffer_time_min ?? 5);
  const next = entries
    .filter((e) => e.room_id === p.room_id && e.id !== p.id && (e.status === "scheduled" || e.status === "waiting") && e.scheduled_time)
    .map((e) => ({ s: toMin(String(e.scheduled_time)), time: String(e.scheduled_time), name: e.patient_name }))
    .filter((x) => x.s >= nowMin && x.s < endMin)
    .sort((a, b) => a.s - b.s)[0];
  return next || null;
}

/* ===== Причина, чому «Викликати в кабінет» ЗАРАЗ неможливо =====
   Централізована логіка (порядок перевірок + арифметика вікна виклику), спільна
   для адмінської дошки (QueueBoard) та дошки радіолога (RadiologistBoard). Щоб
   не тримати два екземпляри, які розповзаються, тут — лише машинний КОД причини
   + потрібні дані; рольові формулювання повідомлень лишаються в компонентах.

   opts обчислюються в компоненті з наявних хелперів:
     roomBlocked — кабінет заблоковано (поломка/ТО), напр. blockingByRoom[room_id];
     schedClosed — кабінет зачинено за графіком на цей день (roomSchedClosed);
     schedEnd    — "HH:MM" кінець графіка кабінету (null якщо зачинено/невідомо). */
export type CallBlockInfo = {
  id: string;
  room_id: string | null;
  duration_min: number | null;
  buffer_time_min: number | null;
};
export type CallBlockOpts = {
  roomBlocked?: boolean;
  schedClosed?: boolean;
  schedEnd?: string | null;
  now?: Date;
};
export type CallBlock =
  | { code: "room_blocked" }
  | { code: "room_closed" }
  | { code: "room_busy" }
  | { code: "sched_overrun"; durationMin: number; end: string }
  | { code: "clash"; durationMin: number; time: string; name?: string | null };

export function computeCallBlock(
  p: CallBlockInfo,
  entries: Array<{ id: string; room_id: string | null; status: string; scheduled_time: string | null; patient_name?: string | null }>,
  opts: CallBlockOpts = {}
): CallBlock | null {
  const now = opts.now ?? new Date();
  if (opts.roomBlocked) return { code: "room_blocked" };
  if (opts.schedClosed) return { code: "room_closed" };
  if (entries.some((e) => e.room_id === p.room_id && e.status === "in_progress" && e.id !== p.id)) return { code: "room_busy" };
  const durationMin = p.duration_min || 30;
  // Виклик ЗАРАЗ має вміститись до кінця робочого графіка кабінету (саме
  // дослідження; буфер прибирання може вийти за межі — як у редакторі слотів).
  if (p.room_id && opts.schedEnd) {
    const [eh, em] = String(opts.schedEnd).split(":").map(Number);
    const endMin = (eh || 0) * 60 + (em || 0);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    if (nowMin + durationMin > endMin) return { code: "sched_overrun", durationMin, end: opts.schedEnd };
  }
  // Пізній виклик: фактичне вікно (зараз + тривалість + буфер) не має налазити
  // на наступний запис кабінету (напр. після «все ж прийшов»).
  const clash = lateCallClash(p, entries, now);
  if (clash) return { code: "clash", durationMin, time: clash.time, name: clash.name };
  return null;
}

// dayDate — Date дня записи (00:00); scheduledTime — "HH:MM".
export function needsClarification(
  status: string | null | undefined,
  dayDate: Date | null | undefined,
  scheduledTime: string | null | undefined,
  now: Date = new Date()
): boolean {
  if (status && status !== "scheduled" && status !== "waiting") return false; // лише «В черзі»/«Очікує»/невизначений
  if (!dayDate || !scheduledTime) return false;
  const [h, m] = String(scheduledTime).split(":").map(Number);
  const start = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), h || 0, m || 0);
  return start.getTime() < now.getTime();
}
