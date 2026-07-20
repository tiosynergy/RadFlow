/* ===== RadFlow — план при затримці дослідження (0078/0079, етап 3) =====

   Дослідження затягнулося. Пацієнт усе ще в кабінеті, а наступні записи вже
   «горять». Що система пропонує адміну — рахує цей файл.

   ЧОМУ ЧИСТІ ФУНКЦІЇ. Той самий план має порахувати сервер (щоб застосувати) і
   показати клієнт (щоб адмін побачив, ЩО саме підтверджує). Дві реалізації
   розійшлися б — у цьому проєкті так уже було (0074: сітка малювала слот
   зеленим, а тригер бронь відхиляв). Тут — один код на обидва боки.

   ЧАС. Усі величини — ХВИЛИНИ ДОБИ в НАСТІННОМУ часі клініки. Викликач зобовʼязаний
   передати nowMin/runStartMin, порахований через wallNow(clinics.timezone) — на
   сервері зона приходить із БД, на клієнті пропом clinicTz. `new Date()` тут не
   зʼявляється жодного разу свідомо.

   ПРАВИЛО СПРАЦЮВАННЯ (рішення власника):

     actual_end = in_progress_at + duration_min + buffer_time_min
     delay_min  = actual_end − scheduled_start наступного запису
     сценарій запускається, ЛИШЕ якщо delay_min > поріг (за замовч. 15 хв)

   Рівно поріг — НЕ запускає: 15 хв наїзду — це те, що буфер і має поглинати. */

import { firstFittingSlot, slotFmt, slotToMin, type BusySpan } from "./slots";
import { normBuffer, BUFFER_DEFAULT } from "./studies";
import { OFF_SCHED_GRACE_MIN, overlapsBreak, type Break } from "./schedule";

/** Запис черги в обсязі, потрібному планувальнику. */
export interface DelayEntry {
  id: string;
  status: string;
  scheduled_time: string | null;
  duration_min: number | null;
  buffer_time_min: number | null;
  patient_name?: string | null;
}

export interface DelayContext {
  /** Хвилина доби, коли кабінет РЕАЛЬНО звільниться (дослідження + буфер прибирання). */
  freeAtMin: number;
  /** Графік кабінету на цю дату (хвилини доби). */
  schedStartMin: number;
  schedEndMin: number;
  breaks: Break[];
  /** Вікна простоїв кабінету (хвилини доби) — бронювати в них не можна ЖОДНИМ планом. */
  incidentSpans: BusySpan[];
  /** Дозволити зсув за кінець графіка (clinics.allow_after_hours_shift). */
  allowAfterHours: boolean;
  /** Стеля кількості записів у плані (clinics.max_cascade_patients). */
  maxItems: number;
}

export type PlanItemKind =
  /** Запис лишається на місці — кабінет устигає. */
  | "keep"
  /** Запис їде на новий слот. */
  | "shift"
  /** Запис нікуди не влазить у цей день → «Потребує переносу» (needs_reschedule). */
  | "no_fit"
  /** Стратегія B: запис перетнувся з фактичним вікном → «Потребує переносу». */
  | "conflict";

export interface PlanItem {
  id: string;
  name: string | null;
  kind: PlanItemKind;
  /** Старий час "HH:MM". */
  from: string;
  /** Новий час "HH:MM"; null для no_fit / conflict — слота немає. */
  to: string | null;
  /** Наскільки посунули (хв). 0 для keep. */
  shiftMin: number;
  /** Машинна причина — для журналу та підказки в UI. */
  reason: "on_time" | "cascade" | "no_slot_today" | "overlap_with_actual";
  /** Чи виходить НОВИЙ слот за межі робочого графіка (потребує окремого підтвердження). */
  offSchedule?: boolean;
}

export interface DelayPlan {
  strategy: "cascade_shift" | "reschedule_conflicts";
  items: PlanItem[];
  /** Скільки записів реально змінюється (keep не рахуємо). */
  affected: number;
  /** Скільки записів план відправляє в «Потребує переносу». */
  needsReschedule: number;
  /** План уперся в стелю maxItems — решту записів дня він НЕ чіпає. */
  truncated: boolean;
}

const durOf = (e: DelayEntry) => e.duration_min || 30;
const bufOf = (e: DelayEntry) => normBuffer(e.buffer_time_min ?? BUFFER_DEFAULT);

/** Активні записи, які ще чекають на кабінет (тільки їх і можна рухати). */
const PENDING = ["scheduled", "waiting"];

/** Фактичне вікно запису, що ЗАРАЗ у кабінеті: коли кабінет звільниться (з буфером).
    runStartMin — хвилина доби фактичного старту (in_progress_at у настінному часі).
    Кабінет не може «звільнитися в минулому»: якщо планова тривалість уже вичерпана,
    а «Завершити» ніхто не натиснув — пацієнт усе ще там (той самий інваріант, що
    в collisionFor). */
export function actualFreeAtMin(run: DelayEntry, runStartMin: number, nowMin: number): number {
  const end = Math.max(runStartMin + durOf(run), nowMin);
  return end + bufOf(run);
}

/** delay_min для КОНКРЕТНОГО наступного запису. >0 = наїзд. */
export function delayMinFor(freeAtMin: number, next: DelayEntry): number {
  if (!next.scheduled_time) return 0;
  return freeAtMin - slotToMin(next.scheduled_time);
}

/** Чи запускати сценарій узагалі: наїзд на НАЙБЛИЖЧИЙ запис перевищив поріг.
    Рівно поріг — НЕ запускає (буфер для того й існує). */
export function delayTriggers(freeAtMin: number, upcoming: DelayEntry[], thresholdMin: number): number {
  const next = upcomingOf(upcoming)[0];
  if (!next) return 0;
  const d = delayMinFor(freeAtMin, next);
  return d > thresholdMin ? d : 0;
}

/** Записи кабінету, які ще чекають, у хронологічному порядку. */
function upcomingOf(entries: DelayEntry[]): DelayEntry[] {
  return entries
    .filter((e) => PENDING.includes(e.status) && e.scheduled_time)
    .sort((a, b) => slotToMin(String(a.scheduled_time)) - slotToMin(String(b.scheduled_time)));
}

/* ===== A. «Зсунути чергу» =====

   ⚠️ НЕ ПРОСТО ДОДАЄМО ОДНАКОВУ ДЕЛЬТУ. Однакова дельта — це наївно і неправильно:
   вона проштовхує записи крізь перерву, крізь простій і за кінець графіка, а ще
   зберігає «дірки» там, де їх можна закрити. Замість цього для КОЖНОГО запису
   послідовно шукаємо ПЕРШИЙ 5-хвилинний слот, куди він влазить ЦІЛКОМ:
     • не раніше, ніж звільниться кабінет після попереднього (з буфером);
     • дослідження вміщується до кінця графіка (буфер прибирання може вийти);
     • не перетинає перерву;
     • не перетинає простій;
     • не перетинає вже розставлені записи цього ж плану.
   Саме тому каскад не породжує нових накладень за побудовою (той самий приймач,
   що в CollisionPanel — firstFittingSlot).

   Запис, який НЕ влазить у день, НЕ скасовуємо мовчки — він іде в no_fit
   («Потребує переносу») з альтернативами, які підбере UI. */
export function buildCascadePlan(entries: DelayEntry[], ctx: DelayContext): DelayPlan {
  const items: PlanItem[] = [];
  const queue = upcomingOf(entries);
  const truncated = queue.length > ctx.maxItems;
  const list = queue.slice(0, ctx.maxItems);

  // Зайнятість, яку план мусить обходити: простої + уже розставлені записи.
  const busy: BusySpan[] = ctx.incidentSpans.slice();
  // Кабінет вільний не раніше, ніж закінчиться те, що зараз іде.
  let freeFrom = ctx.freeAtMin;

  /* Стеля пошуку. allowAfterHours=false → жорсткий кінець графіка: запис, який
     не влазить, іде в «Потребує переносу», а не виштовхується за графік (рішення
     власника — воно ж дефолт). true → дозволяємо «хвіст» у межах OFF_SCHED_GRACE_MIN,
     але кожен такий слот позначаємо offSchedule: він потребує окремого підтвердження
     і причини (0078: журнал schedule_exceptions). */
  const hardEnd = ctx.allowAfterHours ? ctx.schedEndMin + OFF_SCHED_GRACE_MIN : ctx.schedEndMin;

  for (const e of list) {
    const from = String(e.scheduled_time);
    const fromMin = slotToMin(from);
    const dur = durOf(e), buf = bufOf(e);

    /* Кабінет устигає до планового слота, і слот нічим не зайнятий → не чіпаємо.
       Рухати запис, який і так вкладається, — це зайвий дзвінок пацієнту. */
    const occEnd = fromMin + dur + buf;
    const undisturbed =
      fromMin >= freeFrom &&
      !overlapsBreak(fromMin, dur, ctx.breaks) &&
      !busy.some((b) => fromMin < b.e && b.s < occEnd) &&
      fromMin + dur <= ctx.schedEndMin;

    if (undisturbed) {
      items.push({ id: e.id, name: e.patient_name ?? null, kind: "keep", from, to: from, shiftMin: 0, reason: "on_time" });
      busy.push({ s: fromMin, e: occEnd });
      freeFrom = Math.max(freeFrom, occEnd);
      continue;
    }

    const slot = firstFittingSlot({
      fromMin: freeFrom,
      durMin: dur,
      bufferMin: buf,
      schedStartMin: ctx.schedStartMin,
      schedEndMin: hardEnd,
      busy,
      breaks: ctx.breaks,
    });

    if (!slot) {
      // Не влазить у день узагалі — чесно кажемо про це, а не скасовуємо.
      items.push({
        id: e.id, name: e.patient_name ?? null, kind: "no_fit",
        from, to: null, shiftMin: 0, reason: "no_slot_today",
      });
      continue;
    }

    const toMin = slotToMin(slot);
    items.push({
      id: e.id, name: e.patient_name ?? null, kind: "shift",
      from, to: slot, shiftMin: toMin - fromMin, reason: "cascade",
      // Слот за кінцем графіка — лише якщо власник це дозволив; він однаково
      // вимагає підтвердження і причини (0078).
      offSchedule: toMin + dur > ctx.schedEndMin,
    });
    busy.push({ s: toMin, e: toMin + dur + buf });
    freeFrom = toMin + dur + buf;
  }

  return finalize("cascade_shift", items, truncated);
}

/* ===== B. «Перенести конфліктних» =====

   Чергу не рухаємо. У «Потребує переносу» йдуть РІВНО ті записи, чиї інтервали
   перетинаються з ФАКТИЧНИМ вікном кабінету (тобто ті, кого фізично не встигнуть
   прийняти вчасно). Решта лишається на місці — їх чіпати нема причин.

   Це НЕ 'cancelled': пацієнт нікуди не дівся, на нього чекає обдзвін реєстратури.
   Саме тому в 0078/0079 і зʼявився окремий статус. */
export function buildConflictPlan(entries: DelayEntry[], ctx: DelayContext): DelayPlan {
  const queue = upcomingOf(entries);
  const truncated = queue.length > ctx.maxItems;
  const list = queue.slice(0, ctx.maxItems);

  const items: PlanItem[] = list.map((e) => {
    const from = String(e.scheduled_time);
    const fromMin = slotToMin(from);
    // Перетин зі СПРАВЖНІМ вікном: кабінет зайнятий до freeAtMin.
    const conflicts = fromMin < ctx.freeAtMin;
    return conflicts
      ? {
          id: e.id, name: e.patient_name ?? null, kind: "conflict" as const,
          from, to: null, shiftMin: 0, reason: "overlap_with_actual" as const,
        }
      : {
          id: e.id, name: e.patient_name ?? null, kind: "keep" as const,
          from, to: from, shiftMin: 0, reason: "on_time" as const,
        };
  });

  return finalize("reschedule_conflicts", items, truncated);
}

function finalize(strategy: DelayPlan["strategy"], items: PlanItem[], truncated: boolean): DelayPlan {
  return {
    strategy,
    items,
    affected: items.filter((i) => i.kind !== "keep").length,
    needsReschedule: items.filter((i) => i.kind === "no_fit" || i.kind === "conflict").length,
    truncated,
  };
}

/** Компактний вигляд плану для журналу queue_delay_events (БЕЗ ПІБ і телефонів).
    Вимога 0078: у зовнішні події й журнали PII не тягнемо — там лише id, часи, причини. */
export function planForAudit(plan: DelayPlan) {
  return {
    strategy: plan.strategy,
    truncated: plan.truncated,
    items: plan.items
      .filter((i) => i.kind !== "keep")
      .map((i) => ({ id: i.id, kind: i.kind, from: i.from, to: i.to, shiftMin: i.shiftMin, reason: i.reason })),
  };
}

export { slotFmt };
