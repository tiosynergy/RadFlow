"use client";

/* ===== RadFlow — Перенести на новий слот =====
   Портовано з rf-shell.jsx (RescheduleModal). Кабінети — з props (та сама модальність),
   зайняті слоти — через знеособлений RPC room_busy_slots (без PII; для направника
   обходить RLS-сліпоту на чужі записи). p_exclude прибирає сам перенесений запис. */

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  roomScheduleFor, effectiveRoomBreaks, inBreak, breakClash, offScheduleKind, OFF_SCHED_GRACE_MIN,
  type DayOverride,
} from "@/lib/schedule";
import { incidentEffectiveEnd, wallNow, wallMinOfDay, wallDayKey, wallToday0, type IncidentLike } from "@/lib/incidents";
import { useRoomBusy, busyAt, busyTooltip } from "@/lib/slotBusy";
import { BUFFER_DEFAULT, normBuffer, modalityLabel, modalityShort, modalityKind } from "@/lib/studies";
import { useModalA11y } from "@/lib/useModalA11y";
import { buildSlots, countFit } from "@/lib/slots";
import SlotPicker from "@/components/SlotPicker";

type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null };
// Минимально необходимый набор полей записи (доски передают разные подмножества).
type ReschedulePatient = { id: string; room_id: string | null; duration_min: number | null; buffer_time_min?: number | null; patient_name: string | null; studies?: unknown; note?: string | null; status?: string };

interface RescheduleModalProps {
  patient: ReschedulePatient;
  rooms?: RoomOpt[];
  clinicId?: string | null;
  clinicTz?: string | null; // TZ центру запису (для «зараз» у мультиклінічному порталі)
  incidents?: IncidentLike[];
  onClose: () => void;
  /* Повертає ТЕКСТ ПОМИЛКИ (або null, якщо перенесено) — див. коментар у BookingModal:
     тост із помилкою малювався ПІД оверлеєм, і відмова сервера виглядала як «нічого
     не сталося». Тут це критичніше: без блокування кнопки подвійний клік проходив
     ДВІЧІ (M-6), і другий виклик перезаписував reschedule_origin знімком уже нового
     слота — історія переносу псувалась. */
  onConfirm: (sel: { roomId: string; date: Date; time: string; dur: number; buffer: number; reason: string; offSchedule?: boolean }) => Promise<string | null> | void;
  /* 0077: чи можна переносити ПОЗА графік (після закриття / у перерву) з підтвердженням.
     true — лише дошки ПЕРСОНАЛУ (черга, колл-лист). Портал направника НЕ передає цей
     проп: направник записує пацієнтів ззовні й не знає, чи лишиться зміна. Сервер і
     тригер БД тримають те саме правило — але сітка не має й пропонувати того, що впаде. */
  allowOffSchedule?: boolean;
}

function pad(n: number) { return String(n).padStart(2, "0"); }
function toMin(t: string | null | undefined) { const p = String(t || "").split(":"); return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0); }
function fmt(m: number) { return pad(Math.floor(m / 60)) + ":" + pad(m % 60); }
function dateVal(d: Date) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function procLabel(e: { studies?: unknown; note?: string | null }) {
  const s = Array.isArray(e.studies) ? (e.studies as Array<{ type?: string; region?: string; contrast?: boolean }>) : [];
  if (s.length) return s.map((x) => (x.type || "") + (x.region ? " · " + x.region : "") + (x.contrast ? " з контрастом" : "")).join(" + ");
  return e.note || "—";
}

export default function RescheduleModal({ patient, rooms, clinicId, clinicTz, incidents = [], onClose, onConfirm, allowOffSchedule = false }: RescheduleModalProps) {
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  const curRoom = (rooms || []).find((r) => r.id === patient.room_id);
  const modality = curRoom ? curRoom.modality : "MRI";
  const kind = modalityLabel(modality);
  const dur = patient.duration_min || 30;
  const buffer = normBuffer(patient.buffer_time_min ?? BUFFER_DEFAULT); // переноситься разом із записом
  // Кабінети тієї ж модальності, зокрема заблоковані — щоб можна було перенести на дату ПІСЛЯ відновлення.
  const options = (rooms || []).filter((r) => r.modality === modality);

  const [roomId, setRoomId] = useState<string>(() => patient.room_id || options[0]?.id || "");
  // «Завтра» — від доби КЛІНІКИ, а не браузера: біля півночі в іншій зоні
  // модалка пропонувала перенести на день, який у центрі вже настав/минув.
  const [dateStr, setDateStr] = useState<string>(() => { const d = wallToday0(clinicTz || undefined); d.setDate(d.getDate() + 1); return dateVal(d); });
  const [time, setTime] = useState("");
  const [override, setOverride] = useState<DayOverride | null>(null);
  const [roomSchedule, setRoomSchedule] = useState<unknown>(null); // rooms.schedule обраного кабінету (для перерв)
  const [reason, setReason] = useState("");
  const [schedLoading, setSchedLoading] = useState(true);
  const [schedErr, setSchedErr] = useState(false); // графік/перерви кабінету не завантажились
  // Слот, який ми обрали, зайняли, поки модалка була відкрита (realtime).
  const [taken, setTaken] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    setSchedLoading(true);
    (async () => {
      try {
        const supabase = createClient();
        if (clinicId) {
          const ovRes = await supabase.from("schedule_overrides").select("all_closed, label, rooms").eq("clinic_id", clinicId).eq("override_date", dateStr).maybeSingle();
          if (!cancel) setOverride((ovRes.data as unknown as DayOverride) || null);
        }
        if (!roomId) { if (!cancel) { setRoomSchedule(null); setSchedErr(false); } return; }
        const roomRes = await supabase.from("rooms").select("schedule").eq("id", roomId).maybeSingle();
        if (roomRes.error) throw roomRes.error; // без графіка кабінету сітка тихо повернулась би до хардкоду 08–18
        if (!cancel) { setRoomSchedule((roomRes.data as { schedule?: unknown } | null)?.schedule ?? null); setSchedErr(false); }
      } catch {
        // Транзієнтний збій (оновлення токена / мережа) — модаль не рушимо, але
        // й сітку не малюємо: графік кабінету невідомий.
        if (!cancel) setSchedErr(true);
      } finally {
        if (!cancel) setSchedLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, [roomId, dateStr, clinicId]);

  /* Зайнятість — спільний хук: RPC room_busy_slots + realtime (queue_entries,
     incidents). Поки не завантажилась — сітку не показуємо як «усе вільно».
     Деталі (ПІБ/статус/дослідження) сервер віддає лише адміну та радіологу (0062). */
  const { spans: busy, loading: busyLoading, error: busyError } = useRoomBusy({ roomId, dateStr, excludeId: patient.id });
  const slotsLoading = busyLoading || schedLoading;
  const dateObj = new Date(dateStr + "T00:00:00");
  // «Зараз» у настінному часі клініки (wall-as-UTC мс): і хвилини доби, і «сьогодні».
  const _nowW = wallNow(clinicTz || undefined);
  const nowMin = wallMinOfDay(_nowW);
  const clinicTodayStr = wallDayKey(clinicTz || undefined);   // «сьогодні» клініки (спільний хелпер)
  const isToday = dateStr === clinicTodayStr;
  /* Дата в МИНУЛОМУ. Раніше перевірка «past» стояла під `isToday`, тому для
     будь-якої минулої дати вона не виконувалась і весь день малювався вільним
     (атрибут min на <input type="date"> нічого не блокує — його можна ввести
     руками або вставити). Тепер минулий день закритий цілком. */
  const isPastDay = dateStr < clinicTodayStr;
  const roomSched = roomScheduleFor(dateObj, roomId, override, roomSchedule);
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
  // 0077: персоналу сітка добудовується на 2 год за кінець графіка (є що клікати);
  // направнику — рівно як раніше, по графіку.
  const slots: string[] = buildSlots(schedStart, allowOffSchedule ? schedEnd + OFF_SCHED_GRACE_MIN : schedEnd);
  /* Порядок перевірок = порядок у BookingModal і на сервері: спершу все, що НЕ
     лікується підтвердженням (минуле, простій, зайнятість), потім «поза графіком». */
  function slotState(s: string) {
    // bBlock — кінець із буфером (перетин з іншими записами).
    const a = toMin(s), bBlock = a + dur + buffer;
    if (isPastDay) return "past";                            // весь день у минулому
    if (roomSched.closed) return "closed";
    if (slotBlockedByIncident(a)) return "blocked";
    if (isToday && a < nowMin) return "past";
    // Розділяємо саме дослідження і буфер прибирання після нього: кабінет зайнятий
    // і там, і там, але видно, коли дослідження реально закінчується.
    if (busy.some((x) => a >= x.s && a < x.eStudy)) return "busy";
    if (busy.some((x) => a >= x.eStudy && a < x.e)) return "buffer";
    if (busy.some((x) => a < x.e && x.s < bBlock)) return "tight";
    const off = offScheduleKind(a, dur, roomSched, roomBreaks);
    if (off) {
      if (off.confirmable && allowOffSchedule) return "offsched";
      // Без права на овертайм — стара поведінка: перерва сірим, «не влазить» помаранчевим.
      return off.kind === "break" ? "break" : off.kind === "after_end" ? "tight" : "offhours";
    }
    return "free";
  }
  const selOff = time ? offScheduleKind(toMin(time), dur, roomSched, roomBreaks) : null;
  const needsOffConfirm = allowOffSchedule && !!selOff?.confirmable;
  const SELECTABLE = ["free", "offsched"];
  function offSchedLabel(s: string) {
    const off = offScheduleKind(toMin(s), dur, roomSched, roomBreaks);
    if (!off) return s;
    if (off.kind === "break" && off.brk) return `Поза графіком · перерва ${off.brk.start}–${off.brk.end}\nПеренести можна, але потрібне підтвердження`;
    return `Поза графіком · кабінет працює до ${off.end}\nПеренести можна, але потрібне підтвердження`;
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
  // Тултип зайнятої пʼятихвилинки: статус/ПІБ/дослідження — лише якщо сервер їх
  // віддав (admin/radiologist центру, гейт у RPC 0062); інакше просто «Зайнято».
  function busyLabel(s: string) {
    const b = busyAt(busy, toMin(s));
    if (!b) return "Зайнято";
    const inBuf = toMin(s) >= b.eStudy;
    return (inBuf ? "Буфер після дослідження (кабінет ще зайнятий)\n" : "") + busyTooltip(b);
  }
  function blockedLabel(s: string) {
    const a = toMin(s);
    const dt = Date.UTC(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), Math.floor(a / 60), a % 60);
    const inc = roomIncidents.find((i) => dt >= new Date(i.started_at).getTime() && dt < incidentEffectiveEnd(i));
    const until = inc?.blocked_until ? new Date(inc.blocked_until).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) : null;
    return "Кабінет на ремонті/ТО" + (until ? "\nДо " + until : "\nДо відновлення");
  }
  // Реальна місткість дня для цієї тривалості (жадібна укладка), а не к-сть 5-хв позицій.
  const fitCount = countFit(slots, (s) => slotState(s) === "free", dur + buffer);
  const busyList = busy.slice().sort((a, b) => a.s - b.s);
  const room = (rooms || []).find((r) => r.id === roomId);
  const [offOk, setOffOk] = useState(false);
  useEffect(() => { setOffOk(false); }, [time, roomId, dateStr]);   // згода протухає при зміні слота
  const valid = roomId && time && !roomSched.closed && SELECTABLE.includes(slotState(time))
    && (!needsOffConfirm || offOk);

  /* Realtime: слот, який ми вже обрали, щойно зайняли (або кабінет закрили) —
     знімаємо вибір і кажемо про це, щоб «Перенести» не впало помилкою в лоб. */
  const stillFree = !time || slotsLoading || SELECTABLE.includes(slotState(time));
  useEffect(() => {
    if (!time || slotsLoading) return;
    if (!SELECTABLE.includes(slotState(time))) { setTaken(time); setTime(""); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, slotsLoading, stillFree]);

  // Запит у польоті + помилка сервера — показуємо в модалці (див. onConfirm).
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  async function handleConfirm() {
    if (!valid || saving) return;   // M-6: подвійний клік більше не переносить двічі
    setSaving(true);
    setSaveErr(null);
    try {
      const err = await onConfirm({
        roomId, date: dateObj, time, dur, buffer, reason: reason.trim(),
        offSchedule: needsOffConfirm && offOk,   // 0077 — згода оператора
      });
      if (err) setSaveErr(err);     // успіх → батько закриває модалку
    } catch {
      setSaveErr("Не вдалося перенести запис — спробуйте ще раз");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="overlay">
      <div className="dialog fade-in" style={{ maxWidth: 520 }} ref={dialogRef} role="dialog" aria-modal="true" aria-label="Перенесення запису">
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic" style={{ background: "var(--blue-bg)", color: "var(--blue)" }}>🗓</span>Перенести на новий слот</div>
          <button className="icon-btn" onClick={onClose} aria-label="Закрити">✕</button>
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
                      <span className={"bd-room-kind " + modalityKind(r.modality)}>{modalityShort(r.modality)}</span>
                      <span className="bd-room-meta"><span className="bd-room-name">{r.name}</span><span className="bd-room-model">{r.apparatus_model || ""}</span></span>
                    </button>
                  ))}
                </div>}
          </div>
          <div className="fld-row">
            <label className="fld" style={{ maxWidth: 180 }}><span className="fld-lab">Дата</span>
              {/* Клампимо в onChange: атрибут min лише малює межу, але не блокує
                  введення/вставку минулої дати. */}
              <input className="inp tabular" type="date" min={clinicTodayStr} value={dateStr}
                onChange={(e) => { const v = e.target.value; setDateStr(v && v < clinicTodayStr ? clinicTodayStr : v); setTime(""); }} /></label>
            <div className="fld"><span className="fld-lab">Вільні слоти · блок {dur} хв · {slotsLoading ? "завантаження…" : "вміщується ще " + fitCount}</span></div>
          </div>
          <div className="fld">
            {isPastDay && <div className="ctx-hint red" style={{ marginBottom: 10 }}>⏳ {dateStr} уже минуло — перенести можна лише на майбутній час.</div>}
            {roomSched.closed && <div className="ctx-hint red" style={{ marginBottom: 10 }}>🚫 {room ? room.name : "Кабінет"} не працює {dateStr}{override && override.label ? " · " + override.label : ""}. Оберіть інший день.</div>}
            {!roomSched.closed && roomSched.custom && <div className="ctx-hint blue" style={{ marginBottom: 10 }}>🕐 Особливий графік: {roomSched.start}–{roomSched.end}.</div>}
            {roomIncident && slots.some((s) => slotState(s) === "blocked") && <div className="ctx-hint red" style={{ marginBottom: 10 }}>🔧 {room ? room.name : "Кабінет"} на ремонті/ТО{roomIncident.blocked_until ? " до " + new Date(roomIncident.blocked_until).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) : ""}. Оберіть слот після відновлення або інший день.</div>}
            {taken && <div className="ctx-hint red" style={{ marginBottom: 10 }}>⚡ Слот {taken} щойно зайняли — оберіть інший. <button className="btn btn-secondary btn-sm" style={{ marginLeft: 6 }} onClick={() => setTaken(null)}>Зрозуміло</button></div>}
            {/* Зайнятість не завантажилась — сітку НЕ показуємо (порожній день = «усе вільно»). */}
            {(busyError || schedErr) && !slotsLoading
              ? <div className="ctx-hint red">⚠ Не вдалося завантажити {busyError ? "зайнятість" : "графік"} кабінету — оновіть сторінку. Показувати вільний час не можемо.</div>
              : slotsLoading
              ? <div className="ctx-hint" style={{ fontSize: 13, padding: "20px 0", textAlign: "center", color: "var(--text-muted)" }}>⏳ Завантаження вільних слотів…</div>
              : <SlotPicker
                  slots={slots}
                  value={time}
                  onChange={setTime}
                  spanMin={dur}
                  bufferMin={buffer}
                  resetKey={roomId + "|" + dateStr + "|" + dur + "|" + buffer}
                  stateOf={slotState}
                  freeStates={SELECTABLE}
                  titleOf={(s, st) => (st === "busy" || st === "buffer") ? busyLabel(s) : st === "blocked" ? blockedLabel(s) : st === "break" ? breakLabel(s) : st === "offsched" ? offSchedLabel(s) : st === "offhours" ? "Кабінет не працює в цей час" : st === "tight" ? ("Не вміщується: блок " + dur + " хв перетне " + tightReason(s)) : st === "past" ? "Час минув" : ("Вільно · " + s + "–" + fmt(toMin(s) + dur))}
                />}
            {busyList.length > 0 && (
              <div className="bk-busy-list">
                <span className="bk-busy-lab">Зайнятий час{room ? " (" + room.name + ")" : ""}:</span>
                {/* Дослідження і буфер прибирання — окремо: видно, коли кабінет реально звільняється. */}
                {busyList.map((b, i) => (
                  <span className="bk-busy-chip" key={i}>
                    {fmt(b.s)}–{fmt(b.eStudy)}{b.e > b.eStudy ? <span style={{ opacity: 0.7 }}> +{b.e - b.eStudy} хв</span> : null}
                  </span>
                ))}
              </div>
            )}
            {/* 0077 — підтвердження переносу поза графік (лише дошки персоналу). */}
            {needsOffConfirm && (
              <div className="info-banner offsched" style={{ marginTop: 10, flexDirection: "column", alignItems: "stretch", gap: 8 }}>
                <span className="ib-txt">
                  <b>⏰ Поза графіком.</b>{" "}
                  {selOff?.kind === "break" && selOff.brk
                    ? <>Слот потрапляє в <b>перерву {selOff.brk.start}–{selOff.brk.end}</b>.</>
                    : <>Кабінет працює до <b>{selOff?.end}</b>, а дослідження закінчиться о <b>{fmt(toMin(time) + dur)}</b>.</>}
                  {" "}Запис буде позначено як «поза графіком».
                </span>
                <label className="fld-lab" style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input type="checkbox" checked={offOk} onChange={(e) => setOffOk(e.target.checked)} />
                  Підтверджую роботу поза графіком
                </label>
              </div>
            )}
            <div className="bk-slot-legend">
              <span><span className="lg-dot free" />вільно</span>
              <span><span className="lg-dot tight" />не вміщується</span>
              <span><span className="lg-dot busy" />зайнято</span>
              <span><span className="lg-dot busybuf" />буфер</span>
              {time && buffer > 0 && <span><span className="lg-dot planbuf" />буфер цього запису</span>}
              {roomBreaks.length > 0 && <span><span className="lg-dot brk" />перерва</span>}
              {allowOffSchedule && <span><span className="lg-dot offsched" />поза графіком</span>}
            </div>
          </div>
        </div>
        {saveErr && <div className="dlg-err" role="alert">⚠ {saveErr}</div>}

        <div className="dlg-foot">
          {valid
            ? <span className="bk-summary">{room ? room.name : ""} · {dateStr} {time}–{fmt(toMin(time) + dur)}{buffer > 0 ? " (+" + buffer + " хв буфер → вільно з " + fmt(toMin(time) + dur + buffer) + ")" : ""}</span>
            : <span style={{ fontSize: 12, color: "var(--text-faint)", marginRight: "auto", alignSelf: "center" }}>Оберіть кабінет, дату та слот</span>}
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>Скасувати</button>
          <button className="btn btn-primary" disabled={!valid || saving} onClick={handleConfirm}>
            {saving ? "Перенесення…" : "✓ Перенести на цей слот"}
          </button>
        </div>
      </div>
    </div>
  );
}
