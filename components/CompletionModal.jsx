"use client";

/* ===== RadFlow — Завершення процедури =====
   Портовано з queue-app.jsx (CompletionModal). Успіх → done, Не відбулось → no_show
   (причина зберігається у note). Перенос — окремий етап. */

import { useState, useEffect } from "react";

const FAIL_REASONS = [
  { group: "Стан пацієнта", items: ["Клаустрофобія", "Несумісний імплант", "Кардіостимулятор", "Не готовий", "Погано почувається", "Відмовився"] },
  { group: "Технічні причини", items: ["Поломка обладнання", "Апарат потребує ТО"] },
  { group: "Інше", items: ["Інше"] },
];

function fmtTimer(sec) {
  const m = Math.floor(sec / 60), s = sec % 60, h = Math.floor(m / 60);
  if (h) return h + ":" + String(m % 60).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  return m + ":" + String(s).padStart(2, "0");
}
function LiveTimer({ enteredAt, children }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const sec = enteredAt ? Math.max(0, Math.floor((now - new Date(enteredAt).getTime()) / 1000)) : 0;
  return children(sec);
}

export default function CompletionModal({ patient, proc, roomName, enteredAt, onClose, onSuccess, onFail }) {
  const [result, setResult] = useState("success");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const canConfirm = result === "success" || (result === "failed" && reason);
  const callHint = reason === "Не готовий" || reason === "Відмовився" || reason === "Погано почувається";
  const techHint = reason === "Поломка обладнання" || reason === "Апарат потребує ТО";

  function confirm() {
    if (result === "success") onSuccess(notes);
    else onFail(reason, notes);
  }

  return (
    <div className="overlay">
      <div className="dialog fade-in" style={{ maxWidth: 540 }}>
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic" style={{ background: "var(--green-bg)", color: "var(--green)" }}>✓</span>Завершення процедури</div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="dlg-body">
          <div className="pc-card">
            <div className="pc-top">
              <div className="pc-name">{patient.patient_name}</div>
              <LiveTimer enteredAt={enteredAt}>{(sec) => (
                <span className="badge blue tabular" style={{ flexShrink: 0 }}><span aria-hidden>▷</span> В кабінеті: {fmtTimer(sec)}</span>
              )}</LiveTimer>
            </div>
            <div className="pc-proc">{proc} · {patient.duration_min} хв</div>
            <div className="pc-meta">
              <span><b>Час:</b> {patient.scheduled_time}</span>
              <span><b>Кабінет:</b> {roomName}</span>
              {patient.patient_age != null && <span><b>Вік:</b> {patient.patient_age} р.</span>}
            </div>
          </div>

          <div className="res-group">
            <button className={"res-opt" + (result === "success" ? " sel green" : "")} onClick={() => setResult("success")}>
              <span className="res-ic" style={{ background: "var(--green-bg)" }}>✅</span>
              <span className="res-txt">
                <span className="res-title">Успішно завершено</span>
                <span className="res-sub">Дослідження проведено повністю. Статус → «Виконано».</span>
              </span>
              <span className={"res-radio" + (result === "success" ? " on green" : "")} />
            </button>
            <button className={"res-opt" + (result === "failed" ? " sel red" : "")} onClick={() => setResult("failed")}>
              <span className="res-ic" style={{ background: "var(--red-bg)" }}>❌</span>
              <span className="res-txt">
                <span className="res-title">Не відбулось</span>
                <span className="res-sub">Дослідження не проведено. Слот буде звільнено.</span>
              </span>
              <span className={"res-radio" + (result === "failed" ? " on red" : "")} />
            </button>
          </div>

          {result === "failed" && (
            <div className="fade-in" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="dlg-divider" />
              <label className="fld">
                <span className="fld-lab">Причина (обов'язково) *</span>
                <select className="inp" value={reason} onChange={(e) => setReason(e.target.value)}>
                  <option value="">— Оберіть причину —</option>
                  {FAIL_REASONS.map((g) => (
                    <optgroup key={g.group} label={g.group}>
                      {g.items.map((it) => <option key={it} value={it}>{it}</option>)}
                    </optgroup>
                  ))}
                </select>
              </label>
              {techHint && <div className="ctx-hint red">⚠ Причина — несправність обладнання. Блокування апарата / інциденти — окремий етап.</div>}
              {callHint && <div className="ctx-hint blue">↩ Пацієнт не пройшов дослідження — перенос на новий слот зʼявиться окремим етапом.</div>}
            </div>
          )}

          <label className="fld">
            <span className="fld-lab">Нотатка</span>
            <textarea className="inp" rows={2} placeholder="Додатковий коментар (необов'язково)…" value={notes} onChange={(e) => setNotes(e.target.value)} style={{ resize: "vertical" }} />
          </label>

          <div className="hint-blue">⚡ <b>Realtime:</b> статус миттєво оновиться для всіх ролей через Supabase Realtime.</div>
        </div>
        <div className="dlg-foot">
          <button className="btn btn-ghost" onClick={onClose}>Скасувати</button>
          <button className={"btn " + (result === "success" ? "btn-green" : "btn-danger")} disabled={!canConfirm} onClick={confirm}>
            {result === "success" ? "✓ Підтвердити — Виконано" : "Зафіксувати — Не відбулось"}
          </button>
        </div>
      </div>
    </div>
  );
}
