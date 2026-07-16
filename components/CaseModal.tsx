"use client";

/* ===== RadFlow — Екран крос-модального кейса (перегляд + групове скасування) =====
   Кейс (patient_cases, 0091) групує N записів РІЗНИХ модальностей одного пацієнта.
   Тягне СВОЇ кроки сам (усі дати, не лише день дошки) — RLS віддає лише свій центр.
   «Скасувати кейс» → cancelCase (0092): знімає активні НЕ-in_progress кроки;
   виконані та ті, що в кабінеті, лишаються. Статус/прогрес — з lib/case.ts
   (той самий підрахунок, що й на сервері). */

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { cancelCase } from "@/app/queue/actions";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useModalA11y } from "@/lib/useModalA11y";
import { modalityLabel, studyText, type Study } from "@/lib/studies";
import {
  sortSteps, caseStatusFromSteps, caseProgress, cancellableCount, isActiveStep,
  type CaseStepLite,
} from "@/lib/case";
import type { CaseStatus } from "@/supabase/types";

type StepRow = CaseStepLite & {
  id: string;
  patient_name: string | null;
  scheduled_date: string | null;
  scheduled_time: string | null;
  studies: unknown;
  room: { name: string | null; modality: string | null } | null;
};

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
}

export default function CaseModal({ caseId, onClose, onCancelled }: CaseModalProps) {
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  const [steps, setSteps] = useState<StepRow[] | null>(null);
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [askCancel, setAskCancel] = useState(false);
  const [cancelErr, setCancelErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const supabase = createClient();
        const { data, error } = await supabase
          .from("queue_entries")
          .select("id, patient_name, status, case_step, scheduled_date, scheduled_time, studies, room:room_id(name, modality)")
          .eq("case_id", caseId);
        if (!alive) return;
        if (error) { setErr(true); return; }
        setSteps((data || []) as unknown as StepRow[]);
      } catch {
        if (alive) setErr(true);
      }
    })();
    return () => { alive = false; };
  }, [caseId]);

  const ordered = sortSteps(steps || []);
  const patient = ordered.find((s) => s.patient_name)?.patient_name || "Пацієнт";
  const cStatus = caseStatusFromSteps(steps || []);
  const prog = caseProgress(steps || []);
  const nCancel = cancellableCount(steps || []);

  async function doCancel() {
    setBusy(true);
    setCancelErr(null);
    const res = await cancelCase(caseId);
    setBusy(false);
    setAskCancel(false);
    if (!res.ok) { setCancelErr(res.error); return; }
    onCancelled?.();
    onClose();
  }

  return (
    <div className="overlay">
      <div className="dialog fade-in" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Кейс пацієнта" style={{ maxWidth: 560 }}>
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

          {cancelErr && (
            <div style={{ fontSize: 12.5, color: "var(--danger, #c0392b)" }}>Не вдалося скасувати: {cancelErr}</div>
          )}
          {err && (
            <div style={{ fontSize: 12.5, color: "var(--danger, #c0392b)" }}>Не вдалося завантажити кроки кейса — оновіть сторінку.</div>
          )}
          {!err && steps === null && (
            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Завантаження…</div>
          )}

          {!err && steps !== null && (
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {ordered.map((s, i) => {
                const arr = Array.isArray(s.studies) ? (s.studies as Study[]) : [];
                const label = arr.length ? arr.map((x) => studyText(x)).join(" + ") : modalityLabel(s.room?.modality || "");
                const active = isActiveStep(s.status);
                const dateTxt = s.scheduled_date ? s.scheduled_date.split("-").reverse().slice(0, 2).join(".") : "";
                const timeTxt = s.scheduled_time ? String(s.scheduled_time).slice(0, 5) : "";
                return (
                  <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", padding: "9px 12px", opacity: active ? 1 : 0.55 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", minWidth: 18, textAlign: "center" }}>{s.case_step ?? i + 1}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {modalityLabel(s.room?.modality || "")} · {s.room?.name || "—"}
                      </div>
                      <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {label}{dateTxt ? " · " + dateTxt : ""}{timeTxt ? " " + timeTxt : ""}
                      </div>
                    </div>
                    <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999, border: "1px solid var(--border)", color: "var(--text-muted)" }}>
                      {STATUS_LABEL[s.status] || s.status}
                    </span>
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
          <button className="btn btn-ghost" onClick={onClose}>Закрити</button>
          <button className="btn btn-danger" disabled={busy || nCancel === 0} onClick={() => setAskCancel(true)}>
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
    </div>
  );
}
