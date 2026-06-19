"use client";

/* ===== RadFlow — Поломка / ТО (блокування кабінету) =====
   Портовано з queue-app.jsx (BreakdownModal), спрощено: фіксує простій і блокує
   кабінет. Автоматичний колл-лист постраждалих пацієнтів — наступний під-етап. */

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { roomScheduleFor } from "@/lib/schedule";

function modalityLabel(m) { return m === "MRI" ? "МРТ" : m === "CT" ? "КТ" : "Інше"; }
function pad(n) { return String(n).padStart(2, "0"); }
function nowHHMM() { const d = new Date(); return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
function dateInputVal(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function hhmmToday(hhmm) { const [h, m] = String(hhmm).split(":").map(Number); const d = new Date(); d.setHours(h || 0, m || 0, 0, 0); return d; }
function hhmmFromISO(iso) { try { const d = new Date(iso); return pad(d.getHours()) + ":" + pad(d.getMinutes()); } catch { return nowHHMM(); } }

const DURATIONS = [
  { k: "1h", label: "1 година" }, { k: "2h", label: "2 години" }, { k: "4h", label: "4 години" },
  { k: "eod", label: "До кінця дня" }, { k: "restore", label: "До відновлення" },
];

export default function BreakdownModal({ rooms, clinicId, incident, blockedRoomIds = [], onClose, onConfirm }) {
  const editing = !!incident;
  const isLocked = (id) => blockedRoomIds.includes(id) && (!incident || incident.room_id !== id);
  const [roomId, setRoomId] = useState(incident?.room_id || ((rooms || []).find((r) => !isLocked(r.id)) || (rooms || [])[0] || {}).id || "");
  const [reason, setReason] = useState(incident?.reason || "breakdown");
  const [startTime, setStartTime] = useState(incident ? hhmmFromISO(incident.started_at) : nowHHMM());
  const [durKey, setDurKey] = useState("");
  const [restoreDate, setRestoreDate] = useState(() => { const d = new Date(); d.setDate(d.getDate() + 1); return dateInputVal(d); });

  // Графік кабінету на сьогодні (для «до кінця дня» — з урахуванням особливого графіка).
  const [override, setOverride] = useState(null);
  useEffect(() => {
    if (!clinicId) return;
    let cancel = false;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase.from("schedule_overrides").select("all_closed, label, rooms").eq("clinic_id", clinicId).eq("override_date", dateInputVal(new Date())).maybeSingle();
      if (!cancel) setOverride(data || null);
    })();
    return () => { cancel = true; };
  }, [clinicId]);
  const schedEndStr = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return roomScheduleFor(d, roomId, override).end; })();

  const reasonLabel = reason === "maintenance" ? "Планове ТО" : "Поломка обладнання";
  const minRestore = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return dateInputVal(d); })();
  const room = (rooms || []).find((r) => r.id === roomId);
  const valid = roomId && reason && durKey && (durKey !== "restore" || restoreDate);

  function compute() {
    const startedAt = hhmmToday(startTime);
    let blockedUntil = null, durationLabel = "";
    if (durKey === "1h") { blockedUntil = new Date(startedAt.getTime() + 3600e3); durationLabel = "1 година"; }
    else if (durKey === "2h") { blockedUntil = new Date(startedAt.getTime() + 2 * 3600e3); durationLabel = "2 години"; }
    else if (durKey === "4h") { blockedUntil = new Date(startedAt.getTime() + 4 * 3600e3); durationLabel = "4 години"; }
    else if (durKey === "eod") { const [eh, em] = String(schedEndStr).split(":").map(Number); const d = new Date(); d.setHours(eh || 18, em || 0, 0, 0); blockedUntil = d; durationLabel = "до кінця дня (" + schedEndStr + ")"; }
    else if (durKey === "restore") { const d = new Date(restoreDate + "T18:00:00"); blockedUntil = d; durationLabel = "до відновлення (" + restoreDate + ")"; }
    return { startedAt, blockedUntil, durationLabel };
  }

  function confirm() {
    const c = compute();
    onConfirm({
      roomId, reason, reasonLabel,
      startedAt: c.startedAt.toISOString(),
      blockedUntil: c.blockedUntil ? c.blockedUntil.toISOString() : null,
      durationLabel: c.durationLabel,
      note: "Простій " + pad(hhmmToday(startTime).getHours()) + ":" + pad(hhmmToday(startTime).getMinutes()) + " · " + c.durationLabel,
    });
  }

  return (
    <div className="overlay">
      <div className="dialog fade-in" style={{ maxWidth: 600 }}>
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic" style={{ background: "var(--red-bg)", color: "var(--red)" }}>🔧</span>{editing ? "Редагувати простій" : "Поломка / Технічне обслуговування"}</div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="dlg-body">
          <div className="ctx-hint red" style={{ fontSize: 13 }}>⚠ Блокування призупиняє нові виклики/записи на апарат. Розблокувати можна кнопкою «🔓 Розблокувати» на дошці.</div>

          <div className="fld">
            <span className="fld-lab">Який апарат? *</span>
            <div className="bd-rooms">
              {(rooms || []).map((r) => {
                const locked = isLocked(r.id);
                return (
                  <button key={r.id} disabled={locked} className={"bd-room" + (roomId === r.id ? " active" : "")} onClick={() => !locked && setRoomId(r.id)} title={locked ? "Кабінет уже заблоковано" : r.name + (r.apparatus_model ? " · " + r.apparatus_model : "")} style={locked ? { opacity: 0.45, cursor: "not-allowed" } : undefined}>
                    <span className={"bd-room-kind " + (r.modality === "MRI" ? "mrt" : "ct")}>{modalityLabel(r.modality)}</span>
                    <span className="bd-room-meta"><span className="bd-room-name">{r.name}{locked ? " 🔒" : ""}</span><span className="bd-room-model">{locked ? "вже заблоковано" : (r.apparatus_model || "")}</span></span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="fld">
            <span className="fld-lab">Причина *</span>
            <div className="res-group" style={{ flexDirection: "row", gap: 10 }}>
              <button className={"res-opt" + (reason === "breakdown" ? " sel red" : "")} onClick={() => setReason("breakdown")} style={{ flex: 1 }}>
                <span className="res-ic" style={{ background: "var(--red-bg)" }}>🔧</span>
                <span className="res-txt"><span className="res-title">Поломка обладнання</span><span className="res-sub">Несправність — потрібен ремонт</span></span>
                <span className={"res-radio" + (reason === "breakdown" ? " on red" : "")} />
              </button>
              <button className={"res-opt" + (reason === "maintenance" ? " sel red" : "")} onClick={() => setReason("maintenance")} style={{ flex: 1 }}>
                <span className="res-ic" style={{ background: "var(--orange-bg)" }}>⚙️</span>
                <span className="res-txt"><span className="res-title">Планове ТО</span><span className="res-sub">Технічне обслуговування</span></span>
                <span className={"res-radio" + (reason === "maintenance" ? " on red" : "")} />
              </button>
            </div>
          </div>

          <div className="fld-row">
            <label className="fld" style={{ maxWidth: 160 }}>
              <span className="fld-lab">Початок простою</span>
              <input className="inp tabular" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </label>
            <div className="fld">
              <span className="fld-lab">Тривалість простою *</span>
              <div className="bd-durs">
                {DURATIONS.map((d) => (
                  <button key={d.k} className={"bd-chip" + (durKey === d.k ? " active" : "")} onClick={() => setDurKey(d.k)}>{d.label}</button>
                ))}
              </div>
            </div>
          </div>

          {durKey === "restore" && (
            <label className="fld">
              <span className="fld-lab">Очікувана дата відновлення *</span>
              <input className="inp tabular" type="date" min={minRestore} value={restoreDate} onChange={(e) => setRestoreDate(e.target.value)} style={{ maxWidth: 200 }} />
            </label>
          )}

          <div className="hint-blue">⚡ <b>Realtime:</b> блокування апарата миттєво зʼявиться у всіх ролей.</div>
        </div>
        <div className="dlg-foot">
          {valid
            ? <span className="bk-summary">{room ? room.name : ""} · {reason === "maintenance" ? "ТО" : "Поломка"} · {compute().durationLabel}</span>
            : <span style={{ fontSize: 12, color: "var(--text-faint)", marginRight: "auto", alignSelf: "center" }}>* Оберіть апарат, причину та тривалість</span>}
          <button className="btn btn-ghost" onClick={onClose}>Скасувати</button>
          <button className="btn btn-danger" disabled={!valid} onClick={confirm}>{editing ? "💾 Зберегти зміни" : "🔒 Заблокувати апарат"}</button>
        </div>
      </div>
    </div>
  );
}
