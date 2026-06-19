"use client";

/* ===== RadFlow — Поломка / Технічне обслуговування =====
   Два окремі події в ОДНОМУ діалозі, кожне редагується незалежно:
     🔧 Поломка обладнання  — як правило блокування «зараз» (status active);
     ⚙️ Планове ТО          — запланований простій у майбутньому (status planned).
   Події одного кабінету не можуть перетинатися в часі (перевірка перетину).
   Якщо подія вже існує — показується з можливістю редагувати / зняти. */

import { useState } from "react";
import { roomScheduleFor } from "@/lib/schedule";

function modalityLabel(m) { return m === "MRI" ? "МРТ" : m === "CT" ? "КТ" : "Інше"; }
function pad(n) { return String(n).padStart(2, "0"); }
function nowHHMM() { const d = new Date(); return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
function dateVal(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function hhmmFromISO(iso) { try { const d = new Date(iso); return pad(d.getHours()) + ":" + pad(d.getMinutes()); } catch { return nowHHMM(); } }
function dtFrom(dateStr, hhmm) { const [h, m] = String(hhmm).split(":").map(Number); const d = new Date(dateStr + "T00:00:00"); d.setHours(h || 0, m || 0, 0, 0); return d; }
function nextWorkday(d) { const x = new Date(d); while (x.getDay() === 0) x.setDate(x.getDate() + 1); return x; }
function fmtDT(iso) { try { return new Date(iso).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); } catch { return ""; } }
function overlaps(aS, aE, bS, bE) { return aS < bE && bS < aE; }

const DURATIONS = [
  { k: "1h", label: "1 год" }, { k: "2h", label: "2 год" }, { k: "4h", label: "4 год" },
  { k: "eod", label: "До кінця дня" }, { k: "restore", label: "До відновлення" },
];

/* ── 🔧 Поломка обладнання ── */
function BreakdownSection({ roomId, room, existing, others, onSave, onResolve }) {
  const [open, setOpen] = useState(!existing); // немає події → одразу форма; є → спершу зведення
  const [startDate, setStartDate] = useState(existing ? dateVal(new Date(existing.started_at)) : dateVal(new Date()));
  const [startTime, setStartTime] = useState(existing ? hhmmFromISO(existing.started_at) : nowHHMM());
  const [durKey, setDurKey] = useState(existing ? "restore" : "");
  const [restoreDate, setRestoreDate] = useState(existing?.blocked_until ? dateVal(new Date(existing.blocked_until)) : dateVal(nextWorkday((() => { const d = new Date(); d.setDate(d.getDate() + 1); return d; })())));
  const [restoreTime, setRestoreTime] = useState(existing?.blocked_until ? hhmmFromISO(existing.blocked_until) : "08:00");
  const [err, setErr] = useState("");

  const schedEnd = (() => { const d = dtFrom(startDate, "00:00"); return roomScheduleFor(d, roomId, null).end; })();
  function blockedUntil(startedAt) {
    if (durKey === "1h") return new Date(startedAt.getTime() + 3600e3);
    if (durKey === "2h") return new Date(startedAt.getTime() + 2 * 3600e3);
    if (durKey === "4h") return new Date(startedAt.getTime() + 4 * 3600e3);
    if (durKey === "eod") { const [eh, em] = schedEnd.split(":").map(Number); const d = dtFrom(startDate, "00:00"); d.setHours(eh || 18, em || 0, 0, 0); return d; }
    if (durKey === "restore") return dtFrom(restoreDate, restoreTime);
    return null;
  }
  function save() {
    setErr("");
    if (!durKey) { setErr("Оберіть тривалість"); return; }
    const s = dtFrom(startDate, startTime), e = blockedUntil(s);
    if (e && e.getTime() <= s.getTime()) { setErr("Кінець має бути пізніше початку"); return; }
    const eMs = e ? e.getTime() : Infinity;
    if ((others || []).some((o) => overlaps(s.getTime(), eMs, new Date(o.started_at).getTime(), o.blocked_until ? new Date(o.blocked_until).getTime() : Infinity))) {
      setErr("Період перетинається з ТО цього кабінету"); return;
    }
    const durLabel = durKey === "restore" ? "до " + restoreDate + " " + restoreTime : DURATIONS.find((d) => d.k === durKey)?.label;
    onSave({ id: existing?.id, roomId, reason: "breakdown", reasonLabel: "Поломка обладнання", startedAt: s.toISOString(), blockedUntil: e ? e.toISOString() : null, note: "Поломка " + startDate + " " + startTime + " · " + durLabel });
    setOpen(false);
  }

  return (
    <div style={{ border: "1px solid var(--red)", borderRadius: 12, padding: 14, background: "var(--red-bg)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 16 }}>🔧</span>
        <b style={{ color: "var(--red)" }}>Поломка обладнання</b>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>несправність — потрібен ремонт</span>
      </div>
      {existing && !open ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ flex: 1, fontSize: 13 }}>Активна з <b>{fmtDT(existing.started_at)}</b>{existing.blocked_until ? <> до <b>{fmtDT(existing.blocked_until)}</b></> : null}</span>
          <button className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}>✎ Редагувати</button>
          <button className="btn btn-secondary btn-sm" onClick={() => onResolve(existing.id)}>🔓 Розблокувати</button>
        </div>
      ) : (
        <>
          <div className="fld-row">
            <label className="fld" style={{ maxWidth: 160 }}><span className="fld-lab">Дата початку *</span><input className="inp tabular" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>
            <label className="fld" style={{ maxWidth: 110 }}><span className="fld-lab">Час *</span><input className="inp tabular" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} /></label>
          </div>
          <div className="fld"><span className="fld-lab">Тривалість *</span>
            <div className="bd-durs">{DURATIONS.map((d) => <button key={d.k} className={"bd-chip" + (durKey === d.k ? " active" : "")} onClick={() => setDurKey(d.k)}>{d.label}</button>)}</div>
          </div>
          {durKey === "restore" && (
            <div className="fld-row">
              <label className="fld" style={{ maxWidth: 160 }}><span className="fld-lab">Дата відновлення *</span><input className="inp tabular" type="date" min={startDate} value={restoreDate} onChange={(e) => setRestoreDate(e.target.value)} /></label>
              <label className="fld" style={{ maxWidth: 110 }}><span className="fld-lab">Час *</span><input className="inp tabular" type="time" value={restoreTime} onChange={(e) => setRestoreTime(e.target.value)} /></label>
            </div>
          )}
          {err && <div className="ctx-hint red" style={{ fontSize: 12.5 }}>⚠ {err}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
            {existing && <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>Скасувати</button>}
            <button className="btn btn-danger btn-sm" onClick={save}>{existing ? "💾 Зберегти" : "🔒 Заблокувати"}</button>
          </div>
        </>
      )}
    </div>
  );
}

/* ── ⚙️ Планове ТО ── */
function MaintenanceSection({ roomId, existing, others, onSave, onResolve }) {
  const tmrw = dateVal(nextWorkday((() => { const d = new Date(); d.setDate(d.getDate() + 1); return d; })()));
  const [open, setOpen] = useState(!existing);
  const [startDate, setStartDate] = useState(existing ? dateVal(new Date(existing.started_at)) : tmrw);
  const [startTime, setStartTime] = useState(existing ? hhmmFromISO(existing.started_at) : "08:00");
  const [endDate, setEndDate] = useState(existing?.blocked_until ? dateVal(new Date(existing.blocked_until)) : tmrw);
  const [endTime, setEndTime] = useState(existing?.blocked_until ? hhmmFromISO(existing.blocked_until) : "12:00");
  const [err, setErr] = useState("");

  function save() {
    setErr("");
    const s = dtFrom(startDate, startTime), e = dtFrom(endDate, endTime);
    if (e.getTime() <= s.getTime()) { setErr("Кінець має бути пізніше початку"); return; }
    if ((others || []).some((o) => overlaps(s.getTime(), e.getTime(), new Date(o.started_at).getTime(), o.blocked_until ? new Date(o.blocked_until).getTime() : Infinity))) {
      setErr("Період перетинається з поломкою цього кабінету"); return;
    }
    onSave({ id: existing?.id, roomId, reason: "maintenance", reasonLabel: "Планове ТО", startedAt: s.toISOString(), blockedUntil: e.toISOString(), note: "Планове ТО " + startDate + " " + startTime + "–" + endDate + " " + endTime });
    setOpen(false);
  }

  return (
    <div style={{ border: "1px solid var(--orange)", borderRadius: 12, padding: 14, background: "var(--orange-bg)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 16 }}>⚙️</span>
        <b style={{ color: "var(--orange)" }}>Планове ТО</b>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>заплановане технічне обслуговування</span>
      </div>
      {existing && !open ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ flex: 1, fontSize: 13 }}>Заплановано <b>{fmtDT(existing.started_at)}</b>{existing.blocked_until ? <> – <b>{fmtDT(existing.blocked_until)}</b></> : null}</span>
          <button className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}>✎ Редагувати</button>
          <button className="btn btn-secondary btn-sm" onClick={() => onResolve(existing.id)}>✕ Скасувати</button>
        </div>
      ) : (
        <>
          <div className="fld-row">
            <label className="fld" style={{ maxWidth: 160 }}><span className="fld-lab">Початок — дата *</span><input className="inp tabular" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>
            <label className="fld" style={{ maxWidth: 110 }}><span className="fld-lab">Час *</span><input className="inp tabular" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} /></label>
          </div>
          <div className="fld-row">
            <label className="fld" style={{ maxWidth: 160 }}><span className="fld-lab">Кінець — дата *</span><input className="inp tabular" type="date" min={startDate} value={endDate} onChange={(e) => setEndDate(e.target.value)} /></label>
            <label className="fld" style={{ maxWidth: 110 }}><span className="fld-lab">Час *</span><input className="inp tabular" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} /></label>
          </div>
          {err && <div className="ctx-hint red" style={{ fontSize: 12.5 }}>⚠ {err}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
            {existing && <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>Скасувати</button>}
            <button className="btn btn-primary btn-sm" onClick={save}>{existing ? "💾 Зберегти" : "🗓 Запланувати ТО"}</button>
          </div>
        </>
      )}
    </div>
  );
}

export default function BreakdownModal({ rooms, incidents = [], initialRoomId, onClose, onSubmit, onResolve }) {
  const [roomId, setRoomId] = useState(initialRoomId || (rooms || [])[0]?.id || "");
  const room = (rooms || []).find((r) => r.id === roomId);
  const roomIncidents = (incidents || []).filter((i) => i.room_id === roomId);
  const breakdownInc = roomIncidents.find((i) => i.reason === "breakdown");
  const maintenanceInc = roomIncidents.find((i) => i.reason === "maintenance");

  return (
    <div className="overlay">
      <div className="dialog fade-in" style={{ maxWidth: 600 }}>
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic" style={{ background: "var(--red-bg)", color: "var(--red)" }}>🔧</span>Поломка / Технічне обслуговування</div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="dlg-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="fld" style={{ marginBottom: 0 }}>
            <span className="fld-lab">Який апарат? *</span>
            <div className="bd-rooms">
              {(rooms || []).map((r) => (
                <button key={r.id} className={"bd-room" + (roomId === r.id ? " active" : "")} onClick={() => setRoomId(r.id)} title={r.name + (r.apparatus_model ? " · " + r.apparatus_model : "")}>
                  <span className={"bd-room-kind " + (r.modality === "MRI" ? "mrt" : "ct")}>{modalityLabel(r.modality)}</span>
                  <span className="bd-room-meta"><span className="bd-room-name">{r.name}</span><span className="bd-room-model">{r.apparatus_model || ""}</span></span>
                </button>
              ))}
            </div>
          </div>

          <BreakdownSection key={"b-" + roomId + "-" + (breakdownInc?.id || "new")} roomId={roomId} room={room} existing={breakdownInc} others={maintenanceInc ? [maintenanceInc] : []} onSave={onSubmit} onResolve={onResolve} />
          <MaintenanceSection key={"m-" + roomId + "-" + (maintenanceInc?.id || "new")} roomId={roomId} existing={maintenanceInc} others={breakdownInc ? [breakdownInc] : []} onSave={onSubmit} onResolve={onResolve} />

          <div className="hint-blue" style={{ marginBottom: 0 }}>⚡ <b>Realtime:</b> зміни миттєво зʼявляться у всіх ролей. Поломка блокує апарат відразу; планове ТО — у вказаний час.</div>
        </div>
        <div className="dlg-foot">
          <button className="btn btn-ghost" onClick={onClose} style={{ marginLeft: "auto" }}>Закрити</button>
        </div>
      </div>
    </div>
  );
}
