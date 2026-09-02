"use client";

/* ===== RadFlow — Екран крос-модального кейса (перегляд + правка + групове скасування) =====
   Кейс (patient_cases, 0091) групує N записів РІЗНИХ кабінетів/модальностей одного
   пацієнта. Тягне СВОЇ кроки сам (усі дати, не лише день дошки) — RLS віддає лише
   свій центр.

   ПРАВКА КРОКУ (0096): активний крок можна перенести (RescheduleModal →
   rescheduleQueueEntry) або змінити дослідження (StudyEditModal →
   editQueueEntryStudies). Обидва шляхи проходять DB-гарди кейса:
     • різні кабінети (тригер 0095) — крок не можна посунути в кабінет іншого кроку;
     • не перетинаються за часом (тригер 0096) — крок не можна посунути/розтягнути
       на час, зайнятий іншим кроком кейса (пацієнт не в двох місцях).
   Помилки цих гардів мапляться в actions.ts (CASE_SAME_ROOM/CASE_PATIENT_OVERLAP)
   і показуються в модалці правки — той самий контроль пересічень, що й при створенні.

   СИНХРОНІЗАЦІЯ ДЛЯ ВСІХ РОЛЕЙ: підписка realtime на queue_entries + patient_cases
   цього кейса (useRealtimeRefetch) — будь-яка зміна (правка/скасування/статус) з
   іншої вкладки чи іншим оператором одразу оновлює екран.

   «Скасувати кейс» → cancelCase (0092): знімає активні НЕ-in_progress кроки.

   0118 (referralMode): екран працює і для НАПРАВНИКА — його власні кейси. Дії
   кейса (додати крок / скасувати) йдуть через referral-обгортки; правка кроку
   (перенос/дослідження) — ті САМІ entry-екшени, що вже доступні направнику на
   його дошці (queue_reschedule_rpc авторизує направника-власника, RLS
   queue_write_referrer — останній рубіж). Скасування — лише до старту кроків. */

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { cancelCase, rescheduleQueueEntry, editQueueEntryStudies, addCaseStep, addReferralCaseStep, cancelReferralCase } from "@/app/queue/actions";
import ConfirmDialog from "@/components/ConfirmDialog";
import RescheduleModal, { type RescheduleStudy } from "@/components/RescheduleModal";
import StudyEditModal from "@/components/StudyEditModal";
import BookingModal, { type BookingPayload } from "@/components/BookingModal";
import { useModalA11y } from "@/lib/useModalA11y";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";
import { modalityLabel, studyText, type Study } from "@/lib/studies";
import {
  sortSteps, caseStatusFromSteps, caseProgress, cancellableCount, isActiveStep,
  type CaseStepLite,
} from "@/lib/case";
import type { CaseStatus, Json } from "@/supabase/types";
import type { IncidentFeed } from "@/lib/incidents";
import type { ClockClaim } from "@/lib/clockTrust";   // Г1-F: заявку про годинник везем від форми
import type { ServiceLike, RoomOverrideRow } from "@/lib/catalog";

type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null; active?: boolean | null };

type StepRow = CaseStepLite & {
  id: string;
  patient_name: string | null;
  patient_phone: string | null;
  patient_dob: string | null;
  patient_sex: string | null;
  patient_email: string | null;
  patient_weight: number | null;
  scheduled_date: string | null;
  scheduled_time: string | null;
  duration_min: number | null;
  buffer_time_min: number | null;
  note: string | null;
  off_schedule: boolean | null;
  room_id: string | null;
  studies: unknown;
  room: { name: string | null; modality: string | null } | null;
};

const STEP_SELECT =
  "id, patient_name, patient_phone, patient_dob, patient_sex, patient_email, patient_weight, status, case_step, scheduled_date, scheduled_time, duration_min, buffer_time_min, note, off_schedule, room_id, studies, room:room_id(name, modality)";

/* "HH:MM" + N хв → "HH:MM" (щоб показувати кінець слота поряд із початком). */
function addMinToHHMM(hhmm: string, min: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const t = h * 60 + m + (min || 0);
  return String(Math.floor((t % 1440) / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
}
function dateKey(d: Date) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

const STATUS_LABEL: Record<string, string> = {
  scheduled: "Заплановано",
  waiting: "Очікує",
  in_progress: "В кабінеті",
  done: "Виконано",
  no_show: "Неявка",
  not_held: "Не відбулося",
  cancelled: "Скасовано",
  needs_reschedule: "Потребує переносу",
};
const CASE_STATUS_LABEL: Record<CaseStatus, string> = {
  open: "Активний",
  completed: "Завершений",
  cancelled: "Скасований",
};

interface CaseModalProps {
  caseId: string;
  onClose: () => void;
  onCancelled?: () => void;
  /** Контекст персоналу для правки кроків. Без нього екран — лише перегляд. */
  rooms?: RoomOpt[];
  clinicId?: string | null;
  clinicTz?: string | null;
  /* U-11: транзитний проп — сам CaseModal простої не читає, але передає їх
     у BookingModal і RescheduleModal, які на них ухвалюють рішення. Тому фід
     їде наскрізь незмінним: якщо тут лишити масив, «не знаємо» знову стане
     «простоїв немає» саме там, де це вирішує долю запису. */
  incidents: IncidentFeed;
  /** Каталог послуг центру (services, 0107) — для форм кроків. Порожній → статика. */
  services?: ServiceLike[];
  /** Переозначення каталогу по кабінетах (service_room_overrides, 0108) — проброс у форми кроків (2b). */
  roomOverrides?: RoomOverrideRow[];
  /** 0118: режим НАПРАВНИКА — дії кейса йдуть через referral-обгортки
      (addReferralCaseStep / cancelReferralCase; авторизація — гілка направника
      в RPC). rooms передавайте ВЖЕ відфільтровані грантом (room_ids). Скасування
      можливе лише поки жоден крок не стартував (сервер — CASE_STARTED).

      ⚠️ ОБОВʼЯЗКОВИЙ і БЕЗ дефолта (U-12, с47). Відколи екран кейса роздає
      `allowOffSchedule` у StudyEditModal, цей проп означає ще й РОЛЬ, а дефолт
      `= false` мовчки казав би «це персонал центру». Екран кейса рендерять двоє —
      QueueBoard (персонал) і ReferralPortal (направник), — і третій виклик, що
      забув би проп, дав би направнику галочку «Підтверджую роботу поза графіком»,
      яку сервер усе одно відхиляє (`scheduleBlock`: `if (!opts.isStaff)`).
      Рівно та обіцянка, заради зняття якої писався U-12. Тепер `tsc` перелічує
      місця виклику сам. */
  referralMode: boolean;
}

export default function CaseModal({ caseId, onClose, onCancelled, rooms, clinicId, clinicTz, incidents, services, roomOverrides, referralMode }: CaseModalProps) {
  /* Стани вкладених вікон — ДО useModalA11y (конвенція с43): вони потрібні
     хуку параметром `active`. Кейс малює аж ЧОТИРИ вкладені вікна, і саме тут
     `active` забули (аудит с46, U-8): обидва слухачі keydown живуть на document
     у capture, stopPropagation їх не розділяє, тож Esc у формі переносу закривав
     ВЕСЬ кейс разом із незбереженими правками, а Tab перехоплювався двічі й
     замикав фокус на двох елементах — відказ WCAG 2.1.2 рівня A. */
  const [steps, setSteps] = useState<StepRow[] | null>(null);
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [askCancel, setAskCancel] = useState(false);
  const [opErr, setOpErr] = useState<string | null>(null);
  const [reschedStep, setReschedStep] = useState<StepRow | null>(null);
  const [editStudiesStep, setEditStudiesStep] = useState<StepRow | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const nestedOpen = askCancel || !!reschedStep || !!editStudiesStep || addOpen;
  const dialogRef = useModalA11y<HTMLDivElement>(onClose, !nestedOpen);

  const canEdit = !!clinicId && (rooms?.length ?? 0) > 0;

  const load = useCallback(async () => {
    try {
      const supabase = createClient();
      const { data, error } = await supabase.from("queue_entries").select(STEP_SELECT).eq("case_id", caseId);
      if (error) { setErr(true); return; }
      setErr(false);
      setSteps((data || []) as unknown as StepRow[]);
    } catch {
      setErr(true);
    }
  }, [caseId]);

  useEffect(() => { load(); }, [load]);

  // Синхронізація для всіх ролей: зміни кроків/кейса з інших вкладок і операторів.
  useRealtimeRefetch({
    channelName: caseId ? "case-" + caseId : null,
    subscriptions: [
      { table: "queue_entries", filter: "case_id=eq." + caseId, onChange: load },
      { table: "patient_cases", filter: "id=eq." + caseId, onChange: load },
    ],
  });

  const ordered = sortSteps(steps || []);
  const pfStep = ordered.find((s) => s.patient_name) || null;
  const patient = pfStep?.patient_name || "Пацієнт";
  const cStatus = caseStatusFromSteps(steps || []);
  const prog = caseProgress(steps || []);
  const nCancel = cancellableCount(steps || []);

  // Зайнятість наявними активними кроками — для контролю пересічень при додаванні
  // нового кроку (той самий кабінет заблоковано, зайнятий час — casebusy у сітці).
  const activeSiblings = (steps || [])
    .filter((s) => isActiveStep(s.status) && s.room_id && s.scheduled_date && s.scheduled_time && s.duration_min)
    .map((s) => ({
      id: s.id,   // щоб при переносі виключити САМ крок, що переносимо
      roomId: s.room_id as string,
      date: new Date((s.scheduled_date as string) + "T00:00:00"),
      time: String(s.scheduled_time).slice(0, 5),
      dur: s.duration_min as number,
    }));

  // 0118: направник скасовує лише НЕстартований кейс — дзеркало серверного гарда
  // CASE_STARTED (кнопка гаситься, сервер усе одно останній рубіж).
  const refStarted = referralMode && (steps || []).some((s) => ["in_progress", "done", "no_show", "not_held"].includes(s.status));

  async function doCancel() {
    setBusy(true);
    setOpErr(null);
    const res = referralMode ? await cancelReferralCase(caseId) : await cancelCase(caseId);
    setBusy(false);
    setAskCancel(false);
    if (!res.ok) { setOpErr(res.error); return; }
    onCancelled?.();
    onClose();
  }

  /* Перенос кроку. Помилки гардів кейса (CASE_SAME_ROOM/CASE_PATIENT_OVERLAP) і
     звичайні booking-помилки повертаємо в RescheduleModal — вона їх покаже. */
  async function doReschedule(sel: { roomId: string; date: Date; time: string; dur: number; buffer: number; reason: string; offSchedule?: boolean; studies?: RescheduleStudy[]; clock: ClockClaim }): Promise<string | null> {
    const st = reschedStep;
    if (!st) return null;
    const [hh, mm] = sel.time.split(":").map(Number);
    const at = new Date(sel.date.getFullYear(), sel.date.getMonth(), sel.date.getDate(), hh, mm).toISOString();
    const res = await rescheduleQueueEntry({
      id: st.id, roomId: sel.roomId, scheduledDate: dateKey(sel.date), scheduledTime: sel.time,
      scheduledAt: at, durationMin: sel.dur, bufferTimeMin: sel.buffer, reason: sel.reason, offSchedule: sel.offSchedule,
      studies: sel.studies,   // 0122: перепризначений склад для іншого кабінету
      clock: sel.clock,       // Г1-F: заявку про годинник знімає форма, ми лише везем
    });
    if (!res.ok) return res.error;   // успіх → закриваємо модалку тут
    setReschedStep(null);
    load();
    return null;
  }

  async function doEditStudies(arr: { type: string; region: string; dur: number }[], meta: { dur: number; buffer?: number; offSchedule: boolean }) {
    const st = editStudiesStep;
    if (!st) return;
    setEditStudiesStep(null);
    setOpErr(null);
    const res = await editQueueEntryStudies(st.id, (arr || []) as unknown as Json, (meta && meta.dur) || st.duration_min || 30, meta?.buffer, meta.offSchedule);
    if (!res.ok) { setOpErr(res.error); return; }
    load();
  }

  /* Додати новий крок (інша модальність/кабінет) до кейса. Помилки гардів
     (CASE_SAME_ROOM/CASE_PATIENT_OVERLAP) повертаємо в модалку — вона їх покаже. */
  async function onAddStep(b: BookingPayload): Promise<string | null> {
    const step = {
      roomId: b.roomId, studies: b.studies, durationMin: b.dur, bufferTimeMin: b.buffer,
      priorityLevel: b.priority, scheduledDate: dateKey(b.date), scheduledTime: b.time,
      contraindications: !!b.hasContra, doctor: b.doctor ?? null, note: b.notes ?? null,
    };
    // 0118: направник — через referral-обгортку (клініка параметром, не з профілю).
    const res = referralMode && clinicId
      ? await addReferralCaseStep(caseId, clinicId, step)
      : await addCaseStep(caseId, step);
    if (!res.ok) return res.error;
    setAddOpen(false);
    load();
    return null;
  }

  return (
    <div className="overlay">
      <div className="dialog fade-in" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Кейс пацієнта" style={{ maxWidth: 580 }}>
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic">🔗</span>Кейс · {patient}</div>
          <button className="icon-btn" onClick={onClose} aria-label="Закрити">✕</button>
        </div>

        <div className="dlg-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="info-banner">
            <span className="ib-ic">🔗</span>
            <span className="ib-txt">
              Крос-модальний кейс — <b>{CASE_STATUS_LABEL[cStatus]}</b> · виконано {prog.done}/{prog.total} кроків.
            </span>
          </div>

          {opErr && (
            <div style={{ fontSize: "0.78125rem", color: "var(--danger, #c0392b)" }}>{opErr}</div>
          )}
          {err && (
            <div style={{ fontSize: "0.78125rem", color: "var(--danger, #c0392b)" }}>Не вдалося завантажити кроки кейса — оновіть сторінку.</div>
          )}
          {!err && steps === null && (
            <div style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>Завантаження…</div>
          )}

          {!err && steps !== null && (
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {ordered.map((s, i) => {
                const arr = Array.isArray(s.studies) ? (s.studies as Study[]) : [];
                const label = arr.length ? arr.map((x) => studyText(x)).join(" + ") : modalityLabel(s.room?.modality || "");
                const active = isActiveStep(s.status);
                const dateTxt = s.scheduled_date ? s.scheduled_date.split("-").reverse().slice(0, 2).join(".") : "";
                const timeTxt = s.scheduled_time ? String(s.scheduled_time).slice(0, 5) : "";
                const endTxt = timeTxt && s.duration_min ? "–" + addMinToHHMM(timeTxt, s.duration_min) : "";
                return (
                  <div key={s.id} style={{ display: "flex", flexDirection: "column", gap: 8, background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", padding: "9px 12px", opacity: active ? 1 : 0.55 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: "0.75rem", fontWeight: 700, color: "var(--text-muted)", minWidth: 18, textAlign: "center" }}>{s.case_step ?? i + 1}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: "0.84375rem", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {modalityLabel(s.room?.modality || "")} · {s.room?.name || "—"}
                        </div>
                        <div style={{ fontSize: "0.71875rem", color: "var(--text-muted)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {label}{dateTxt ? " · " + dateTxt : ""}{timeTxt ? " " + timeTxt + endTxt : ""}
                        </div>
                      </div>
                      <span style={{ flexShrink: 0, fontSize: "0.6875rem", fontWeight: 600, padding: "2px 8px", borderRadius: 999, border: "1px solid var(--border)", color: "var(--text-muted)" }}>
                        {STATUS_LABEL[s.status] || s.status}
                      </span>
                    </div>
                    {/* Правка кроку — персоналу центру АБО направнику-власнику (0118),
                        лише для активних кроків. Обидві дії проходять DB-гарди кейса
                        (різні кабінети / без перетину часу) і власну авторизацію RPC/RLS. */}
                    {canEdit && active && (
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        <button className="btn btn-secondary btn-xs" onClick={() => { setOpErr(null); setEditStudiesStep(s); }} title="Змінити дослідження кроку">🩻 Дослідження</button>
                        <button className="btn btn-secondary btn-xs" onClick={() => { setOpErr(null); setReschedStep(s); }} title="Перенести крок на інший слот/кабінет">🗓 Перенести</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="dlg-foot">
          <span className="bk-summary">
            {nCancel > 0 ? `Скасувати можна ${nCancel} активних кроків` : "Активних кроків для скасування немає"}
          </span>
          {canEdit && cStatus === "open" && (
            <button className="btn btn-secondary" onClick={() => { setOpErr(null); setAddOpen(true); }} title="Додати крок іншої модальності/кабінету">＋ Додати крок</button>
          )}
          <button className="btn btn-ghost" onClick={onClose}>Закрити</button>
          <button className="btn btn-danger" disabled={busy || nCancel === 0 || refStarted} onClick={() => setAskCancel(true)}
            title={refStarted ? "Кейс уже в роботі центру — скасування веде персонал" : undefined}>
            Скасувати кейс
          </button>
        </div>
      </div>

      {askCancel && (
        <ConfirmDialog
          title="Скасувати кейс?"
          text={`Буде скасовано ${nCancel} активних кроків кейса пацієнта ${patient}. Виконані та ті, що в кабінеті, лишаться. Повернути можна лише новими записами.`}
          confirmLabel="Так, скасувати кейс"
          cancelLabel="Ні, залишити"
          danger
          busy={busy}
          onConfirm={doCancel}
          onClose={() => setAskCancel(false)}
        />
      )}

      {reschedStep && (
        <RescheduleModal
          patient={{
            id: reschedStep.id, room_id: reschedStep.room_id, duration_min: reschedStep.duration_min,
            buffer_time_min: reschedStep.buffer_time_min, patient_name: reschedStep.patient_name,
            studies: reschedStep.studies, note: reschedStep.note, status: reschedStep.status,
          }}
          rooms={rooms} clinicId={clinicId} clinicTz={clinicTz} incidents={incidents}
          allowOffSchedule={!referralMode}   /* 0077: направнику поза графіком зась */
          /* Інші активні кроки кейса, БЕЗ того, що переносимо: форма переоформлення
             в інший кабінет має бачити зайнятість пацієнта (0095/0096), інакше про
             конфлікт скаже тригер уже після того, як правки пацієнта пішли в базу. */
          caseSiblings={activeSiblings.filter((s) => s.id !== reschedStep.id)}
          onClose={() => setReschedStep(null)}
          onConfirm={doReschedule}
        />
      )}

      {/* U-12: allowOffSchedule — З РЕЖИМУ ЕКРАНА, а не константа. Той самий CaseModal
          відкривають і персонал (QueueBoard), і направник (ReferralPortal); `true`
          тут дало б направнику галочку понаднормової роботи, яку сервер однаково
          відхиляє (`scheduleBlock`: `if (!opts.isStaff)`). */}
      {editStudiesStep && (
        <StudyEditModal
          patient={{
            id: editStudiesStep.id, room_id: editStudiesStep.room_id, scheduled_time: editStudiesStep.scheduled_time,
            buffer_time_min: editStudiesStep.buffer_time_min, duration_min: editStudiesStep.duration_min,
            patient_name: editStudiesStep.patient_name, studies: editStudiesStep.studies,
          }}
          scheduledDate={editStudiesStep.scheduled_date || dateKey(new Date())}
          rooms={rooms} clinicId={clinicId} clinicTz={clinicTz} services={services} roomOverrides={roomOverrides} incidents={incidents} offSchedule={!!editStudiesStep.off_schedule}
          allowOffSchedule={!referralMode}
          onClose={() => setEditStudiesStep(null)}
          onConfirm={doEditStudies}
        />
      )}

      {addOpen && (
        <BookingModal
          rooms={rooms} clinicId={clinicId} clinicTz={clinicTz} incidents={incidents} services={services} roomOverrides={roomOverrides}
          prefill={{
            name: pfStep?.patient_name || "", phone: pfStep?.patient_phone || "",
            dob: pfStep?.patient_dob || "", gender: pfStep?.patient_sex || "",
            weight: pfStep?.patient_weight ?? null, email: pfStep?.patient_email || "",
            priority: "planned",
            // Крок кейса — той самий візит: відкриваємо день кейса (кабінет/час не підставляємо).
            // U-72: дата з ДАНИХ (scheduled_date сусіднього кроку) — поправка годинника її не рухає.
            date: pfStep?.scheduled_date || undefined,
            datePinned: true,
          }}
          caseSiblings={activeSiblings}
          onAddCaseStep={onAddStep}
          onSave={() => {}}
          onClose={() => setAddOpen(false)}
        />
      )}
    </div>
  );
}
