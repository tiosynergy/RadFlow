"use client";

/* ===== RadFlow — Редактор досліджень =====
   Портовано з rf-shell.jsx (StudyEditModal). Тип фіксується кабінетом (МРТ/КТ).
   Сумарна тривалість не може перевищити вільний час до наступного запису —
   зайнятість кабінету беремо через знеособлений RPC room_busy_slots (без PII;
   для направника обходить RLS-сліпоту), p_exclude прибирає сам редагований запис. */

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { regionsFor, BUFFER_DEFAULT, BUFFER_OPTIONS, normBuffer } from "@/lib/studies";
import { roomScheduleFor, roomBreaksFor, type DayOverride } from "@/lib/schedule";
import { useModalA11y } from "@/lib/useModalA11y";

const MIN_STUDY = 15;

type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null };
type StudyRow = { type: string; region: string; dur: number };
type StudyLike = { type?: string; region?: string; dur?: number; contrast?: boolean };
type StudyPatient = { id: string; room_id: string | null; scheduled_time: string | null; buffer_time_min?: number | null; patient_name: string | null; studies?: unknown };

interface StudyEditModalProps {
  patient: StudyPatient;
  scheduledDate?: string | null;
  rooms?: RoomOpt[];
  clinicId?: string | null;
  onClose: () => void;
  onConfirm: (arr: StudyRow[], meta: { dur: number; buffer: number }) => void;
}

function modalityLabel(m: string) { return m === "MRI" ? "МРТ" : m === "CT" ? "КТ" : "Інше"; }
function pad(n: number) { return String(n).padStart(2, "0"); }
function toMin(t: string | null | undefined) { const p = String(t || "").split(":"); return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0); }
function fmt(m: number) { return pad(Math.floor(m / 60)) + ":" + pad(m % 60); }

export default function StudyEditModal({ patient, scheduledDate, rooms, clinicId, onClose, onConfirm }: StudyEditModalProps) {
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  const room = (rooms || []).find((r) => r.id === patient.room_id);
  const roomKind = room ? modalityLabel(room.modality) : "МРТ"; // "МРТ" | "КТ"
  const lockType = roomKind === "МРТ" || roomKind === "КТ";
  const defaultType = lockType ? roomKind : "МРТ";

  const [nextStart, setNextStart] = useState<number | null>(null);
  const [override, setOverride] = useState<DayOverride | null>(null);
  const [roomSchedule, setRoomSchedule] = useState<unknown>(null); // rooms.schedule кабінету (для перерв)
  useEffect(() => {
    let cancel = false;
    (async () => {
      if (!patient.room_id || !scheduledDate) return;
      try {
        const supabase = createClient();
        if (clinicId) {
          const ov = await supabase.from("schedule_overrides").select("all_closed, label, rooms").eq("clinic_id", clinicId).eq("override_date", scheduledDate).maybeSingle();
          if (!cancel) setOverride((ov.data as unknown as DayOverride) || null);
        }
        const roomRes = await supabase.from("rooms").select("schedule").eq("id", patient.room_id).maybeSingle();
        if (!cancel) setRoomSchedule((roomRes.data as { schedule?: unknown } | null)?.schedule ?? null);
        // Знеособлена зайнятість кабінету; p_exclude прибирає сам редагований запис.
        const { data } = await supabase.rpc("room_busy_slots", { p_room: patient.room_id, p_date: scheduledDate, p_exclude: patient.id });
        if (cancel) return;
        const startMin = toMin(patient.scheduled_time);
        const ns = (data || []).map((p) => toMin(p.scheduled_time)).filter((m) => m > startMin).sort((a, b) => a - b)[0];
        setNextStart(ns != null ? ns : null);
      } catch {
        // Транзієнтний збій (оновлення токена / мережа) — не рушимо модаль.
        if (!cancel) setNextStart(null);
      }
    })();
    return () => { cancel = true; };
  }, [patient.id, patient.room_id, patient.scheduled_time, scheduledDate, clinicId]);

  const [buffer, setBuffer] = useState<number>(normBuffer(patient.buffer_time_min ?? BUFFER_DEFAULT));

  const startMin = toMin(patient.scheduled_time);
  // Реальний старт: якщо запис сьогодні і плановий час уже минув (пацієнт
  // запізнюється або вже в кабінеті), фактична зайнятість кабінету рахується
  // від ЗАРАЗ, а не від планового слота. Використовується для м'якого
  // попередження про наїзд на наступний запис (плановий check_no_overlap
  // цього не ловить, бо порівнює планові вікна).
  const _now = new Date();
  const nowMin = _now.getHours() * 60 + _now.getMinutes();
  const todayStr = _now.getFullYear() + "-" + pad(_now.getMonth() + 1) + "-" + pad(_now.getDate());
  const isTodayLate = scheduledDate === todayStr && nowMin > startMin;
  const refStartMin = isTodayLate ? nowMin : startMin;
  // Кінець вікна — за графіком кабінету (з урахуванням особливого графіка),
  // але не далі наступного запису. Буфер займає кабінет ПІСЛЯ досліджень, тож
  // дослідження + буфер не повинні перетнути наступний запис (для графіка —
  // саме дослідження має вміститись, буфер може вийти за межі закриття).
  const dateObj = scheduledDate ? new Date(scheduledDate + "T00:00:00") : new Date();
  const roomSched = roomScheduleFor(dateObj, patient.room_id || "", override);
  const schedEnd = toMin(roomSched.end);
  const capByNext = nextStart != null ? nextStart - startMin - buffer : Infinity;
  const capBySched = schedEnd - startMin;
  // Перерва кабінету після старту теж обмежує тривалість — дослідження не може її перетнути.
  const nextBreakStart = roomBreaksFor(dateObj, roomSchedule).map((b) => toMin(b.start)).filter((m) => m > startMin).sort((a, b) => a - b)[0];
  const capByBreak = nextBreakStart != null ? nextBreakStart - startMin : Infinity;
  const availableDur = Math.max(0, Math.min(capByNext, capBySched, capByBreak));
  const windowLabel = (capByBreak <= capByNext && capByBreak <= capBySched && nextBreakStart != null)
    ? ("до перерви о " + fmt(nextBreakStart))
    : (nextStart != null && (nextStart - buffer) <= schedEnd)
      ? ("до наступного запису о " + fmt(nextStart) + (buffer > 0 ? ` − ${buffer} буфер` : ""))
      : ("до кінця графіка (" + fmt(schedEnd) + ")");

  function recalc(type: string, region: string, prevDur?: number): number {
    const ro = regionsFor(type).find((r) => r.label === region);
    return ro ? ro.dur : (prevDur || (type === "КТ" ? 20 : 45));
  }
  function seed(): StudyRow[] {
    const base: StudyLike[] = Array.isArray(patient.studies) && patient.studies.length
      ? (patient.studies as StudyLike[])
      : [{ type: defaultType, region: "", dur: defaultType === "КТ" ? 20 : 45 }];
    return base.map((s) => {
      const t = lockType ? roomKind : (s.type || "МРТ");
      const keepRegion = !lockType || !s.type || s.type === roomKind;
      const region = keepRegion ? (s.region || "") : "";
      return { type: t, region, dur: region ? (s.dur || 45) : recalc(t, "") };
    });
  }
  const [rows, setRows] = useState<StudyRow[]>(seed);

  function patch(i: number, p: Partial<StudyRow>) { setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...p } : r))); }
  function setType(i: number, type: string) { if (lockType) return; patch(i, { type, region: "", dur: recalc(type, "") }); }
  function setRegion(i: number, region: string) { const r = rows[i]; patch(i, { region, dur: recalc(r.type, region, r.dur) }); }
  function setDur(i: number, v: string) { patch(i, { dur: Math.max(5, parseInt(v, 10) || 0) }); }
  function addRow() { setRows((rs) => [...rs, { type: defaultType, region: "", dur: recalc(defaultType, "") }]); }
  function removeRow(i: number) { setRows((rs) => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs)); }

  const totalDur = rows.reduce((s, r) => s + (Number(r.dur) || 0), 0);
  const overflow = totalDur > availableDur;
  const remaining = availableDur - totalDur;
  // М'яке попередження (НЕ блокує збереження): за фактом старту дослідження+буфер
  // закінчаться пізніше наступного запису кабінету.
  const projectedEndMin = refStartMin + totalDur + buffer;
  const realClash = isTodayLate && nextStart != null && projectedEndMin > nextStart;
  const canAdd = remaining >= MIN_STUDY;
  const valid = rows.length > 0 && rows.every((r) => r.region) && !overflow;

  function save() {
    const arr = rows.filter((r) => r.region).map((r) => ({ type: r.type, region: r.region, dur: Number(r.dur) || 0 }));
    onConfirm(arr, { dur: totalDur, buffer });
  }

  return (
    <div className="overlay">
      <div className="dialog fade-in" style={{ maxWidth: 600 }} ref={dialogRef} role="dialog" aria-modal="true" aria-label="Редагування дослідження">
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic" style={{ background: "var(--blue-bg)", color: "var(--blue)" }}>🩻</span>Дослідження пацієнта</div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="dlg-body">
          <div className="ctx-hint blue" style={{ fontSize: 13 }}>Пацієнт: <b>{patient.patient_name}</b> · слот о <b>{patient.scheduled_time}</b>{room ? <> · {room.name}{lockType ? <> · <b>{roomKind}</b></> : null}</> : null}. {lockType ? <>Усі дослідження слота — лише <b>{roomKind}</b>.</> : null}</div>
          <div className={"ctx-hint " + (overflow ? "red" : "blue")} style={{ fontSize: 12.5 }}>
            {overflow
              ? <>⚠ Не вміщується: разом <b>{totalDur} хв</b>, доступно <b>{availableDur} хв</b> ({windowLabel}). Скоротіть на {totalDur - availableDur} хв.</>
              : <>Доступно у слоті: <b>{availableDur} хв</b> ({windowLabel}). Вільно ще <b>{remaining} хв</b>.</>}
          </div>
          {!overflow && realClash && (
            <div className="ctx-hint red" style={{ fontSize: 12.5 }}>
              ⚠ Пацієнт запізнюється/у кабінеті: за фактом (з ~<b>{fmt(refStartMin)}</b>) дослідження + буфер закінчаться о ~<b>{fmt(projectedEndMin)}</b> і перекриють наступний запис о <b>{fmt(nextStart ?? 0)}</b>. Зберегти можна, але перенесіть наступний запис.
            </div>
          )}
          <div className="st-rows">
            {rows.map((r, i) => {
              const regions = regionsFor(r.type);
              const hasRegion = !r.region || regions.some((x) => x.label === r.region);
              return (
                <div className="st-row" key={i}>
                  <div className="st-row-head">
                    <span className="st-row-n">Дослідження {i + 1}</span>
                    {rows.length > 1 && <button className="st-row-del" title="Прибрати" onClick={() => removeRow(i)}>✕</button>}
                  </div>
                  <div className="st-row-body">
                    <div className="st-field st-field-type">
                      <span className="st-flab">Тип</span>
                      {lockType ? (
                        <div className="bk-seg st-seg st-seg-locked" title="Тип апарата задає кабінет">
                          <button className={"bk-seg-btn active " + (roomKind === "МРТ" ? "mrt" : "ct")} disabled>{roomKind} 🔒</button>
                        </div>
                      ) : (
                        <div className="bk-seg st-seg">
                          <button className={"bk-seg-btn" + (r.type === "МРТ" ? " active mrt" : "")} onClick={() => setType(i, "МРТ")}>МРТ</button>
                          <button className={"bk-seg-btn" + (r.type === "КТ" ? " active ct" : "")} onClick={() => setType(i, "КТ")}>КТ</button>
                        </div>
                      )}
                    </div>
                    <label className="st-field st-field-region">
                      <span className="st-flab">Область дослідження</span>
                      <select className="inp" value={hasRegion ? r.region : ""} onChange={(e) => setRegion(i, e.target.value)}>
                        <option value="">— Оберіть область —</option>
                        {!hasRegion && r.region && <option value={r.region}>{r.region} (поточне)</option>}
                        {regions.map((x) => <option key={x.label} value={x.label}>{x.label} · {x.dur} хв</option>)}
                      </select>
                    </label>
                    <label className="st-field st-field-dur">
                      <span className="st-flab">Тривалість</span>
                      <div className="st-dur"><input className="inp" type="number" min="5" step="5" value={r.dur} onChange={(e) => setDur(i, e.target.value)} /><span className="st-dur-u">хв</span></div>
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
          <button className="btn btn-secondary btn-sm" style={{ marginTop: 10 }} disabled={!canAdd} onClick={addRow}
            title={canAdd ? "" : "Немає вільного часу у слоті"}>＋ Додати дослідження</button>
        </div>
        <div className="dlg-foot">
          <label className="st-total" style={{ display: "flex", alignItems: "center", gap: 6 }} title="Буфер після дослідження (переукладка/дезінфекція)">
            Буфер:
            <select className="inp" style={{ width: 74, padding: "2px 6px" }} value={buffer} onChange={(e) => setBuffer(normBuffer(Number(e.target.value)))}>
              {BUFFER_OPTIONS.map((b) => <option key={b} value={b}>{b} хв</option>)}
            </select>
          </label>
          <span className="st-total">Разом: <b>{totalDur} хв</b>{buffer > 0 ? <> + {buffer} буфер</> : null} · {rows.length} {rows.length === 1 ? "дослідження" : "досл."}</span>
          <button className="btn btn-ghost" onClick={onClose}>Скасувати</button>
          <button className="btn btn-primary" disabled={!valid} onClick={save}>✓ Зберегти дослідження</button>
        </div>
      </div>
    </div>
  );
}
