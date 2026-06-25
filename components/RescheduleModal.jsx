"use client";

/* ===== RadFlow — Перенести на новий слот =====
   Портовано з rf-shell.jsx (RescheduleModal). Кабінети — з props (та сама модальність),
   зайняті слоти — з Supabase (queue_entries, окрім самого пацієнта). */

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { roomScheduleFor } from "@/lib/schedule";
import { incidentEffectiveEnd } from "@/lib/incidents";

function modalityLabel(m) { return m === "MRI" ? "МРТ" : m === "CT" ? "КТ" : "Інше"; }
function pad(n) { return String(n).padStart(2, "0"); }
function toMin(t) { const p = String(t || "").split(":"); return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0); }
function fmt(m) { return pad(Math.floor(m / 60)) + ":" + pad(m % 60); }
function dateVal(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function procLabel(e) {
  const s = Array.isArray(e.studies) ? e.studies : [];
  if (s.length) return s.map((x) => (x.type || "") + (x.region ? " · " + x.region : "") + (x.contrast ? " з контрастом" : "")).join(" + ");
  return e.note || "—";
}

export default function RescheduleModal({ patient, rooms, clinicId, incidents = [], onClose, onConfirm }) {
  const curRoom = (rooms || []).find((r) => r.id === patient.room_id);
  const modality = curRoom ? curRoom.modality : "MRI";
  const kind = modalityLabel(modality);
  const dur = patient.duration_min || 30;
  // Кабінети тієї ж модальності, зокрема заблоковані — щоб можна було перенести на дату ПІСЛЯ відновлення.
  const options = (rooms || []).filter((r) => r.modality === modality);

  const [roomId, setRoomId] = useState(() => patient.room_id || (options[0] || {}).id || "");
  const [dateStr, setDateStr] = useState(() => { const d = new Date(); d.setDate(d.getDate() + 1); return dateVal(d); });
  const [time, setTime] = useState("");
  const [dayEntries, setDayEntries] = useState([]);
  const [override, setOverride] = useState(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      const supabase = createClient();
      if (clinicId) {
        const ovRes = await supabase.from("schedule_overrides").select("all_closed, label, rooms").eq("clinic_id", clinicId).eq("override_date", dateStr).maybeSingle();
        if (!cancel) setOverride(ovRes.data || null);
      }
      if (!roomId) { setDayEntries([]); return; }
      const { data } = await supabase
        .from("queue_entries")
        .select("id, scheduled_time, duration_min, status")
        .eq("room_id", roomId).eq("scheduled_date", dateStr)
        .neq("status", "cancelled").neq("status", "no_show").neq("status", "not_held");
      if (!cancel) setDayEntries((data || []).filter((e) => e.id !== patient.id));
    })();
    return () => { cancel = true; };
  }, [roomId, dateStr, patient.id, clinicId]);

  const busy = dayEntries.filter((e) => e.scheduled_time).map((e) => ({ s: toMin(e.scheduled_time), e: toMin(e.scheduled_time) + (e.duration_min || 30) }));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dateObj = new Date(dateStr + "T00:00:00");
  const isToday = dateObj.getTime() === today.getTime();
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const roomSched = roomScheduleFor(dateObj, roomId, override);
  const schedStart = toMin(roomSched.start), schedEnd = toMin(roomSched.end);
  // Простій обраного кабінету (поломка + ТО): слоти у будь-якому вікні — недоступні (на дату після відновлення кабінет вільний).
  const roomIncidents = (incidents || []).filter((i) => i.room_id === roomId);
  const roomIncident = roomIncidents[0];
  function slotBlockedByIncident(slotMin) {
    if (!roomIncidents.length) return false;
    const dt = Date.UTC(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), Math.floor(slotMin / 60), slotMin % 60);
    return roomIncidents.some((inc) => {
      const start = new Date(inc.started_at).getTime();
      return dt >= start && dt < incidentEffectiveEnd(inc);
    });
  }
  const slots = []; { const s0 = Math.ceil(schedStart / 30) * 30; for (let m = s0; m < schedEnd; m += 30) slots.push(fmt(m)); }
  function slotState(s) {
    const a = toMin(s), b = a + dur;
    if (roomSched.closed) return "closed";
    if (slotBlockedByIncident(a)) return "blocked";
    if (a < schedStart || a >= schedEnd) return "offhours";
    if (b > schedEnd) return "tight";
    if (isToday && a < nowMin) return "past";
    if (busy.some((x) => a >= x.s && a < x.e)) return "busy";
    if (busy.some((x) => a < x.e && x.s < b)) return "tight";
    return "free";
  }
  function nextApptAfter(s) { const a = toMin(s); const f = busy.filter((x) => x.s >= a).sort((x, y) => x.s - y.s)[0]; return f ? fmt(f.s) : null; }
  const freeCount = slots.filter((s) => slotState(s) === "free").length;
  const busyList = busy.slice().sort((a, b) => a.s - b.s);
  const room = (rooms || []).find((r) => r.id === roomId);
  const valid = roomId && time && !roomSched.closed && slotState(time) === "free";

  return (
    <div className="overlay">
      <div className="dialog fade-in" style={{ maxWidth: 520 }}>
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic" style={{ background: "var(--blue-bg)", color: "var(--blue)" }}>🗓</span>Перенести на новий слот</div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="dlg-body">
          <div className="ctx-hint blue" style={{ fontSize: 13 }}>Пацієнт: <b>{patient.patient_name}</b> · {procLabel(patient)} · {dur} хв</div>
          <div className="fld">
            <span className="fld-lab">Кабінет ({kind})</span>
            {options.length === 0
              ? <div className="ctx-hint red" style={{ fontSize: 12.5 }}>Немає кабінетів типу {kind}.</div>
              : <div className="bd-rooms">
                  {options.map((r) => (
                    <button key={r.id} className={"bd-room" + (roomId === r.id ? " active" : "")} onClick={() => { setRoomId(r.id); setTime(""); }} title={r.name + (r.apparatus_model ? " · " + r.apparatus_model : "")}>
                      <span className={"bd-room-kind " + (r.modality === "MRI" ? "mrt" : "ct")}>{modalityLabel(r.modality)}</span>
                      <span className="bd-room-meta"><span className="bd-room-name">{r.name}</span><span className="bd-room-model">{r.apparatus_model || ""}</span></span>
                    </button>
                  ))}
                </div>}
          </div>
          <div className="fld-row">
            <label className="fld" style={{ maxWidth: 180 }}><span className="fld-lab">Дата</span>
              <input className="inp tabular" type="date" min={dateVal(today)} value={dateStr} onChange={(e) => { setDateStr(e.target.value); setTime(""); }} /></label>
            <div className="fld"><span className="fld-lab">Вільні слоти · блок {dur} хв · {freeCount} вільних</span></div>
          </div>
          <div className="fld">
            {roomSched.closed && <div className="ctx-hint red" style={{ marginBottom: 10 }}>🚫 {room ? room.name : "Кабінет"} не працює {dateStr}{override && override.label ? " · " + override.label : ""}. Оберіть інший день.</div>}
            {!roomSched.closed && roomSched.custom && <div className="ctx-hint blue" style={{ marginBottom: 10 }}>🕐 Особливий графік: {roomSched.start}–{roomSched.end}.</div>}
            {roomIncident && slots.some((s) => slotState(s) === "blocked") && <div className="ctx-hint red" style={{ marginBottom: 10 }}>🔧 {room ? room.name : "Кабінет"} на ремонті/ТО{roomIncident.blocked_until ? " до " + new Date(roomIncident.blocked_until).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) : ""}. Оберіть слот після відновлення або інший день.</div>}
            <div className="bk-slot-grid">
              {slots.map((s) => {
                const st = slotState(s);
                const title = st === "busy" ? "Зайнято" : st === "blocked" ? "Кабінет на ремонті/ТО" : st === "tight" ? ("Не вміщується: блок " + dur + " хв перетне " + (nextApptAfter(s) ? "запис о " + nextApptAfter(s) : "кінець дня")) : st === "past" ? "Час минув" : ("Вільно · " + s + "–" + fmt(toMin(s) + dur));
                return (
                  <button key={s} className={"slot" + (time === s ? " sel" : "") + (st !== "free" ? " taken" : "") + (st === "tight" ? " tight" : "") + ((st === "busy" || st === "blocked") ? " busy" : "")} disabled={st !== "free"} onClick={() => setTime(s)} title={title}>{s}</button>
                );
              })}
            </div>
            {busyList.length > 0 && (
              <div className="bk-busy-list">
                <span className="bk-busy-lab">Зайнятий час{room ? " (" + room.name + ")" : ""}:</span>
                {busyList.map((b, i) => <span className="bk-busy-chip" key={i}>{fmt(b.s)}–{fmt(b.e)}</span>)}
              </div>
            )}
            <div className="bk-slot-legend">
              <span><span className="lg-dot free" />вільно</span>
              <span><span className="lg-dot tight" />не вміщується</span>
              <span><span className="lg-dot busy" />зайнято</span>
            </div>
          </div>
        </div>
        <div className="dlg-foot">
          {valid
            ? <span className="bk-summary">{room ? room.name : ""} · {dateStr} {time}–{fmt(toMin(time) + dur)}</span>
            : <span style={{ fontSize: 12, color: "var(--text-faint)", marginRight: "auto", alignSelf: "center" }}>Оберіть кабінет, дату та слот</span>}
          <button className="btn btn-ghost" onClick={onClose}>Скасувати</button>
          <button className="btn btn-primary" disabled={!valid} onClick={() => onConfirm({ roomId, date: dateObj, time, dur })}>✓ Перенести на цей слот</button>
        </div>
      </div>
    </div>
  );
}
