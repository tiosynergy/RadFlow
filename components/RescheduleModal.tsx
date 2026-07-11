"use client";

/* ===== RadFlow — Перенести на новий слот =====
   Портовано з rf-shell.jsx (RescheduleModal). Кабінети — з props (та сама модальність),
   зайняті слоти — через знеособлений RPC room_busy_slots (без PII; для направника
   обходить RLS-сліпоту на чужі записи). p_exclude прибирає сам перенесений запис. */

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { roomScheduleFor, effectiveRoomBreaks, inBreak, breakClash, type DayOverride } from "@/lib/schedule";
import { incidentEffectiveEnd, wallNow, wallMinOfDay, type IncidentLike } from "@/lib/incidents";
import { BUFFER_DEFAULT, normBuffer } from "@/lib/studies";
import { useModalA11y } from "@/lib/useModalA11y";
import { buildSlots, countFit } from "@/lib/slots";
import SlotPicker from "@/components/SlotPicker";

type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null };
// Знеособлені зайняті слоти з RPC room_busy_slots (без id/статусу/PII).
type DayEntry = { scheduled_time: string | null; duration_min: number | null; buffer_time_min: number | null };
// Минимально необходимый набор полей записи (доски передают разные подмножества).
type ReschedulePatient = { id: string; room_id: string | null; duration_min: number | null; buffer_time_min?: number | null; patient_name: string | null; studies?: unknown; note?: string | null; status?: string };

interface RescheduleModalProps {
  patient: ReschedulePatient;
  rooms?: RoomOpt[];
  clinicId?: string | null;
  clinicTz?: string | null; // TZ центру запису (для «зараз» у мультиклінічному порталі)
  incidents?: IncidentLike[];
  onClose: () => void;
  onConfirm: (sel: { roomId: string; date: Date; time: string; dur: number; buffer: number; reason: string }) => void;
}

function modalityLabel(m: string) { return m === "MRI" ? "МРТ" : m === "CT" ? "КТ" : "Інше"; }
function pad(n: number) { return String(n).padStart(2, "0"); }
function toMin(t: string | null | undefined) { const p = String(t || "").split(":"); return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0); }
function fmt(m: number) { return pad(Math.floor(m / 60)) + ":" + pad(m % 60); }
function dateVal(d: Date) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function procLabel(e: { studies?: unknown; note?: string | null }) {
  const s = Array.isArray(e.studies) ? (e.studies as Array<{ type?: string; region?: string; contrast?: boolean }>) : [];
  if (s.length) return s.map((x) => (x.type || "") + (x.region ? " · " + x.region : "") + (x.contrast ? " з контрастом" : "")).join(" + ");
  return e.note || "—";
}

export default function RescheduleModal({ patient, rooms, clinicId, clinicTz, incidents = [], onClose, onConfirm }: RescheduleModalProps) {
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  const curRoom = (rooms || []).find((r) => r.id === patient.room_id);
  const modality = curRoom ? curRoom.modality : "MRI";
  const kind = modalityLabel(modality);
  const dur = patient.duration_min || 30;
  const buffer = normBuffer(patient.buffer_time_min ?? BUFFER_DEFAULT); // переноситься разом із записом
  // Кабінети тієї ж модальності, зокрема заблоковані — щоб можна було перенести на дату ПІСЛЯ відновлення.
  const options = (rooms || []).filter((r) => r.modality === modality);

  const [roomId, setRoomId] = useState<string>(() => patient.room_id || options[0]?.id || "");
  const [dateStr, setDateStr] = useState<string>(() => { const d = new Date(); d.setDate(d.getDate() + 1); return dateVal(d); });
  const [time, setTime] = useState("");
  const [dayEntries, setDayEntries] = useState<DayEntry[]>([]);
  const [override, setOverride] = useState<DayOverride | null>(null);
  const [roomSchedule, setRoomSchedule] = useState<unknown>(null); // rooms.schedule обраного кабінету (для перерв)
  const [reason, setReason] = useState("");
  // Поки зайнятість кабінету не завантажена — НЕ показуємо сітку як «усе вільно»
  // (інакше можна обрати слот, що насправді зайнятий: race при відкритті/зміні дня).
  const [slotsLoading, setSlotsLoading] = useState(true);

  useEffect(() => {
    let cancel = false;
    setSlotsLoading(true);
    (async () => {
      try {
        const supabase = createClient();
        if (clinicId) {
          const ovRes = await supabase.from("schedule_overrides").select("all_closed, label, rooms").eq("clinic_id", clinicId).eq("override_date", dateStr).maybeSingle();
          if (!cancel) setOverride((ovRes.data as unknown as DayOverride) || null);
        }
        if (!roomId) { if (!cancel) { setDayEntries([]); setRoomSchedule(null); } return; }
        const roomRes = await supabase.from("rooms").select("schedule").eq("id", roomId).maybeSingle();
        if (!cancel) setRoomSchedule((roomRes.data as { schedule?: unknown } | null)?.schedule ?? null);
        // Знеособлена зайнятість кабінету; p_exclude прибирає сам перенесений запис.
        const { data } = await supabase.rpc("room_busy_slots", { p_room: roomId, p_date: dateStr, p_exclude: patient.id });
        if (!cancel) setDayEntries((data || []) as DayEntry[]);
      } catch {
        // Транзієнтний збій (оновлення токена / мережа) — не рушимо модаль.
        if (!cancel) setDayEntries([]);
      } finally {
        if (!cancel) setSlotsLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, [roomId, dateStr, patient.id, clinicId]);

  const busy = dayEntries.filter((e) => e.scheduled_time).map((e) => ({ s: toMin(e.scheduled_time), e: toMin(e.scheduled_time) + (e.duration_min || 30) + (e.buffer_time_min ?? BUFFER_DEFAULT) }));
  const dateObj = new Date(dateStr + "T00:00:00");
  // «Зараз» у настінному часі клініки (wall-as-UTC мс): і хвилини доби, і «сьогодні».
  const _nowW = wallNow(clinicTz || undefined);
  const nowMin = wallMinOfDay(_nowW);
  const _nowD = new Date(_nowW);
  const clinicTodayStr = _nowD.getUTCFullYear() + "-" + String(_nowD.getUTCMonth() + 1).padStart(2, "0") + "-" + String(_nowD.getUTCDate()).padStart(2, "0");
  const isToday = dateStr === clinicTodayStr;
  const roomSched = roomScheduleFor(dateObj, roomId, override);
  const schedStart = toMin(roomSched.start), schedEnd = toMin(roomSched.end);
  const roomBreaks = effectiveRoomBreaks(dateObj, roomId, roomSchedule, override); // перерви кабінету на цю дату
  // Простій обраного кабінету (поломка + ТО): слоти у будь-якому вікні — недоступні (на дату після відновлення кабінет вільний).
  const roomIncidents = (incidents || []).filter((i) => i.room_id === roomId);
  const roomIncident = roomIncidents[0];
  function slotBlockedByIncident(slotMin: number) {
    if (!roomIncidents.length) return false;
    const dt = Date.UTC(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), Math.floor(slotMin / 60), slotMin % 60);
    return roomIncidents.some((inc) => {
      const start = new Date(inc.started_at).getTime();
      return dt >= start && dt < incidentEffectiveEnd(inc);
    });
  }
  const slots: string[] = buildSlots(schedStart, schedEnd); // крок 5 хв
  function slotState(s: string) {
    // b — кінець дослідження (має вміститись у графік); bBlock — з буфером (перетин з іншими).
    const a = toMin(s), b = a + dur, bBlock = a + dur + buffer;
    if (roomSched.closed) return "closed";
    if (slotBlockedByIncident(a)) return "blocked";
    if (a < schedStart || a >= schedEnd) return "offhours";
    if (b > schedEnd) return "tight";
    if (inBreak(a, roomBreaks)) return "break";              // сам слот — перерва кабінету
    if (breakClash(a, dur, roomBreaks)) return "tight";      // слот робочий, але дослідження заїде в перерву
    if (isToday && a < nowMin) return "past";
    if (busy.some((x) => a >= x.s && a < x.e)) return "busy";
    if (busy.some((x) => a < x.e && x.s < bBlock)) return "tight";
    return "free";
  }
  function nextApptAfter(s: string) { const a = toMin(s); const f = busy.filter((x) => x.s >= a).sort((x, y) => x.s - y.s)[0]; return f ? fmt(f.s) : null; }
  function breakLabel(s: string) { const br = inBreak(toMin(s), roomBreaks); return br ? "Перерва в роботі кабінету · " + br.start + "–" + br.end : "Перерва в роботі кабінету"; }
  // Причина «не вміщується» — у тому ж порядку, що й перевірки в slotState.
  function tightReason(s: string) {
    const a = toMin(s);
    if (a + dur > schedEnd) return "кінець дня";
    const br = breakClash(a, dur, roomBreaks);
    if (br) return "перерву " + br.start + "–" + br.end;
    const appt = nextApptAfter(s);
    return appt ? "запис о " + appt : "кінець дня";
  }
  // Реальна місткість дня для цієї тривалості (жадібна укладка), а не к-сть 5-хв позицій.
  const fitCount = countFit(slots, (s) => slotState(s) === "free", dur + buffer);
  const busyList = busy.slice().sort((a, b) => a.s - b.s);
  const room = (rooms || []).find((r) => r.id === roomId);
  const valid = roomId && time && !roomSched.closed && slotState(time) === "free";

  return (
    <div className="overlay">
      <div className="dialog fade-in" style={{ maxWidth: 520 }} ref={dialogRef} role="dialog" aria-modal="true" aria-label="Перенесення запису">
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic" style={{ background: "var(--blue-bg)", color: "var(--blue)" }}>🗓</span>Перенести на новий слот</div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="dlg-body">
          <div className="ctx-hint blue" style={{ fontSize: 13 }}>Пацієнт: <b>{patient.patient_name}</b> · {procLabel(patient)} · {dur} хв{buffer > 0 ? ` + ${buffer} буфер` : ""}</div>
          <label className="fld"><span className="fld-lab">Причина переносу (необовʼязково)</span>
            <input className="inp" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Напр.: пацієнт запізнився / за бажанням пацієнта / апарат зайнятий" /></label>
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
              <input className="inp tabular" type="date" min={clinicTodayStr} value={dateStr} onChange={(e) => { setDateStr(e.target.value); setTime(""); }} /></label>
            <div className="fld"><span className="fld-lab">Вільні слоти · блок {dur} хв · {slotsLoading ? "завантаження…" : "вміщується ще " + fitCount}</span></div>
          </div>
          <div className="fld">
            {roomSched.closed && <div className="ctx-hint red" style={{ marginBottom: 10 }}>🚫 {room ? room.name : "Кабінет"} не працює {dateStr}{override && override.label ? " · " + override.label : ""}. Оберіть інший день.</div>}
            {!roomSched.closed && roomSched.custom && <div className="ctx-hint blue" style={{ marginBottom: 10 }}>🕐 Особливий графік: {roomSched.start}–{roomSched.end}.</div>}
            {roomIncident && slots.some((s) => slotState(s) === "blocked") && <div className="ctx-hint red" style={{ marginBottom: 10 }}>🔧 {room ? room.name : "Кабінет"} на ремонті/ТО{roomIncident.blocked_until ? " до " + new Date(roomIncident.blocked_until).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) : ""}. Оберіть слот після відновлення або інший день.</div>}
            {slotsLoading
              ? <div className="ctx-hint" style={{ fontSize: 13, padding: "20px 0", textAlign: "center", color: "var(--text-muted)" }}>⏳ Завантаження вільних слотів…</div>
              : <SlotPicker
                  slots={slots}
                  value={time}
                  onChange={setTime}
                  spanMin={dur}
                  resetKey={roomId + "|" + dateStr + "|" + dur + "|" + buffer}
                  stateOf={slotState}
                  titleOf={(s, st) => st === "busy" ? "Зайнято" : st === "blocked" ? "Кабінет на ремонті/ТО" : st === "break" ? breakLabel(s) : st === "tight" ? ("Не вміщується: блок " + dur + " хв перетне " + tightReason(s)) : st === "past" ? "Час минув" : ("Вільно · " + s + "–" + fmt(toMin(s) + dur))}
                />}
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
              {roomBreaks.length > 0 && <span><span className="lg-dot brk" />перерва</span>}
            </div>
          </div>
        </div>
        <div className="dlg-foot">
          {valid
            ? <span className="bk-summary">{room ? room.name : ""} · {dateStr} {time}–{fmt(toMin(time) + dur)}</span>
            : <span style={{ fontSize: 12, color: "var(--text-faint)", marginRight: "auto", alignSelf: "center" }}>Оберіть кабінет, дату та слот</span>}
          <button className="btn btn-ghost" onClick={onClose}>Скасувати</button>
          <button className="btn btn-primary" disabled={!valid} onClick={() => onConfirm({ roomId, date: dateObj, time, dur, buffer, reason: reason.trim() })}>✓ Перенести на цей слот</button>
        </div>
      </div>
    </div>
  );
}
