"use client";

/* ===== RadFlow — Редактор досліджень =====
   Портовано з rf-shell.jsx (StudyEditModal). Тип фіксується кабінетом (МРТ/КТ).
   Сумарна тривалість не може перевищити вільний час до наступного запису (з Supabase). */

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { regionsFor } from "@/lib/studies";

const MIN_STUDY = 15, DAY_END = 18 * 60;
function modalityLabel(m) { return m === "MRI" ? "МРТ" : m === "CT" ? "КТ" : "Інше"; }
function pad(n) { return String(n).padStart(2, "0"); }
function toMin(t) { const p = String(t || "").split(":"); return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0); }
function fmt(m) { return pad(Math.floor(m / 60)) + ":" + pad(m % 60); }

export default function StudyEditModal({ patient, scheduledDate, rooms, onClose, onConfirm }) {
  const room = (rooms || []).find((r) => r.id === patient.room_id);
  const roomKind = room ? modalityLabel(room.modality) : "МРТ"; // "МРТ" | "КТ"
  const lockType = roomKind === "МРТ" || roomKind === "КТ";
  const defaultType = lockType ? roomKind : "МРТ";

  const [nextStart, setNextStart] = useState(null);
  useEffect(() => {
    let cancel = false;
    (async () => {
      if (!patient.room_id || !scheduledDate) return;
      const supabase = createClient();
      const { data } = await supabase
        .from("queue_entries")
        .select("id, scheduled_time, status")
        .eq("room_id", patient.room_id).eq("scheduled_date", scheduledDate)
        .neq("status", "cancelled").neq("status", "no_show");
      if (cancel) return;
      const startMin = toMin(patient.scheduled_time);
      const ns = (data || []).filter((p) => p.id !== patient.id).map((p) => toMin(p.scheduled_time)).filter((m) => m > startMin).sort((a, b) => a - b)[0];
      setNextStart(ns != null ? ns : null);
    })();
    return () => { cancel = true; };
  }, [patient.id, patient.room_id, patient.scheduled_time, scheduledDate]);

  const startMin = toMin(patient.scheduled_time);
  const windowEnd = nextStart != null ? nextStart : DAY_END;
  const availableDur = Math.max(0, windowEnd - startMin);

  function recalc(type, region, prevDur) {
    const ro = regionsFor(type).find((r) => r.label === region);
    return ro ? ro.dur : (prevDur || (type === "КТ" ? 20 : 45));
  }
  function seed() {
    const base = Array.isArray(patient.studies) && patient.studies.length
      ? patient.studies
      : [{ type: defaultType, region: "", dur: defaultType === "КТ" ? 20 : 45 }];
    return base.map((s) => {
      const t = lockType ? roomKind : (s.type || "МРТ");
      const keepRegion = !lockType || !s.type || s.type === roomKind;
      const region = keepRegion ? (s.region || "") : "";
      return { type: t, region, dur: region ? (s.dur || 45) : recalc(t, "") };
    });
  }
  const [rows, setRows] = useState(seed);

  function patch(i, p) { setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...p } : r))); }
  function setType(i, type) { if (lockType) return; patch(i, { type, region: "", dur: recalc(type, "") }); }
  function setRegion(i, region) { const r = rows[i]; patch(i, { region, dur: recalc(r.type, region, r.dur) }); }
  function setDur(i, v) { patch(i, { dur: Math.max(5, parseInt(v, 10) || 0) }); }
  function addRow() { setRows((rs) => [...rs, { type: defaultType, region: "", dur: recalc(defaultType, "") }]); }
  function removeRow(i) { setRows((rs) => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs)); }

  const totalDur = rows.reduce((s, r) => s + (parseInt(r.dur, 10) || 0), 0);
  const overflow = totalDur > availableDur;
  const remaining = availableDur - totalDur;
  const canAdd = remaining >= MIN_STUDY;
  const valid = rows.length > 0 && rows.every((r) => r.region) && !overflow;

  function save() {
    const arr = rows.filter((r) => r.region).map((r) => ({ type: r.type, region: r.region, dur: parseInt(r.dur, 10) || 0 }));
    onConfirm(arr, { dur: totalDur });
  }

  return (
    <div className="overlay">
      <div className="dialog fade-in" style={{ maxWidth: 600 }}>
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic" style={{ background: "var(--blue-bg)", color: "var(--blue)" }}>🩻</span>Дослідження пацієнта</div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="dlg-body">
          <div className="ctx-hint blue" style={{ fontSize: 13 }}>Пацієнт: <b>{patient.patient_name}</b> · слот о <b>{patient.scheduled_time}</b>{room ? <> · {room.name}{lockType ? <> · <b>{roomKind}</b></> : null}</> : null}. {lockType ? <>Усі дослідження слота — лише <b>{roomKind}</b>.</> : null}</div>
          <div className={"ctx-hint " + (overflow ? "red" : "blue")} style={{ fontSize: 12.5 }}>
            {overflow
              ? <>⚠ Не вміщується: разом <b>{totalDur} хв</b>, доступно <b>{availableDur} хв</b> ({nextStart != null ? <>до наступного запису о {fmt(nextStart)}</> : <>до кінця дня</>}). Скоротіть на {totalDur - availableDur} хв.</>
              : <>Доступно у слоті: <b>{availableDur} хв</b> ({nextStart != null ? <>до наступного запису о {fmt(nextStart)}</> : <>до кінця дня</>}). Вільно ще <b>{remaining} хв</b>.</>}
          </div>
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
          <span className="st-total">Разом: <b>{totalDur} хв</b> · {rows.length} {rows.length === 1 ? "дослідження" : "досл."}</span>
          <button className="btn btn-ghost" onClick={onClose}>Скасувати</button>
          <button className="btn btn-primary" disabled={!valid} onClick={save}>✓ Зберегти дослідження</button>
        </div>
      </div>
    </div>
  );
}
