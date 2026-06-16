"use client";

/* ===== RadFlow — Режим роботи (графік на дату) =====
   Портовано з queue-app.jsx (ScheduleEditModal). Закрити всю клініку (свято/вихідний)
   або змінити графік окремих кабінетів. Зберігається у schedule_overrides. */

import { useState } from "react";
import { DEF_START, DEF_END, defaultClosed, roomScheduleFor } from "@/lib/schedule";

const LABELS = ["Державне свято", "Вихідний день", "Санітарний день", "Технічне обслуговування"];
function modalityLabel(m) { return m === "MRI" ? "МРТ" : m === "CT" ? "КТ" : "Інше"; }
function fmtShort(d) {
  const MON = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
  return d.getDate() + " " + MON[d.getMonth()];
}

export default function ScheduleEditModal({ date, rooms, existing, entries, onClose, onSave, onReset }) {
  const defClosed = defaultClosed(date);
  const [allClosed, setAllClosed] = useState(!!(existing && existing.all_closed));
  const [label, setLabel] = useState((existing && existing.label) || "");
  const [roomState, setRoomState] = useState(() => {
    const m = {};
    (rooms || []).forEach((r) => {
      const eff = roomScheduleFor(date, r.id, existing);
      const mode = eff.closed ? "closed" : ((eff.start !== DEF_START || eff.end !== DEF_END) ? "custom" : "open");
      m[r.id] = { mode, start: eff.start || DEF_START, end: eff.end || DEF_END };
    });
    return m;
  });
  function setRoom(k, patch) { setRoomState((s) => ({ ...s, [k]: { ...s[k], ...patch } })); }

  function buildOv() {
    if (allClosed) return { all_closed: true, label: label.trim() || "Неробочий день", rooms: {} };
    const ro = {};
    (rooms || []).forEach((r) => {
      const st = roomState[r.id];
      if (st.mode === "closed") { if (!defClosed) ro[r.id] = { closed: true }; }
      else if (st.mode === "custom") { ro[r.id] = { start: st.start, end: st.end }; }
      else { if (defClosed) ro[r.id] = { start: st.start, end: st.end }; }
    });
    const o = { all_closed: false, rooms: ro };
    if (label.trim()) o.label = label.trim();
    return o;
  }

  // Записи, яких торкнеться закриття/зміна (scheduled/waiting у кабінетах, що закриваються).
  const previewOv = buildOv();
  const affected = (entries || []).filter((e) => {
    if (e.status !== "scheduled" && e.status !== "waiting") return false;
    if (previewOv.all_closed) return true;
    const ro = previewOv.rooms ? previewOv.rooms[e.room_id] : null;
    if (ro && ro.closed) return true;
    return false;
  });

  return (
    <div className="overlay">
      <div className="dialog fade-in" style={{ maxWidth: 560 }}>
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic">🗓</span>Режим роботи · {fmtShort(date)}</div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="dlg-body">
          <div className="ctx-hint blue">Графік на <b>{fmtShort(date)}</b>. Закрийте всю клініку на свято/вихідний або змініть години окремих кабінетів. Зміни одразу відображаються в календарі та черзі.</div>

          <label className="sch-allclosed">
            <input type="checkbox" checked={allClosed} onChange={(e) => setAllClosed(e.target.checked)} />
            <span><b>Неробочий день</b> — вся клініка зачинена</span>
          </label>

          <label className="fld">
            <span className="fld-lab">Причина / підпис{allClosed ? "" : " (необов'язково)"}</span>
            <input className="inp" placeholder="напр. Державне свято" value={label} onChange={(e) => setLabel(e.target.value)} />
            <div className="sch-chips">
              {LABELS.map((l) => <button key={l} type="button" className={"sch-chip" + (label === l ? " on" : "")} onClick={() => setLabel(label === l ? "" : l)}>{l}</button>)}
            </div>
          </label>

          {!allClosed && (
            <div className="sch-rooms">
              <div className="sch-rooms-lab">Кабінети та обладнання</div>
              {(rooms || []).map((r) => {
                const st = roomState[r.id];
                return (
                  <div className="sch-room" key={r.id}>
                    <div className="sch-room-info">
                      <span className={"sch-room-ic " + (r.modality === "MRI" ? "mrt" : "ct")}>{r.modality === "MRI" ? "🧲" : "🩻"}</span>
                      <div className="sch-room-txt">
                        <span className="sch-room-name">{r.name}</span>
                        <span className="sch-room-model">{modalityLabel(r.modality)}{r.apparatus_model ? " · " + r.apparatus_model : ""}</span>
                      </div>
                    </div>
                    <div className="sch-room-ctl">
                      <div className="bk-seg bk-seg-sm">
                        <button className={"bk-seg-btn" + (st.mode === "open" ? " active" : "")} onClick={() => setRoom(r.id, { mode: "open" })}>Працює</button>
                        <button className={"bk-seg-btn" + (st.mode === "custom" ? " active" : "")} onClick={() => setRoom(r.id, { mode: "custom" })}>Інші години</button>
                        <button className={"bk-seg-btn" + (st.mode === "closed" ? " active" : "")} onClick={() => setRoom(r.id, { mode: "closed" })}>Зачинено</button>
                      </div>
                      {st.mode === "custom" && (
                        <div className="sch-hours">
                          <input className="inp tabular" type="time" value={st.start} onChange={(e) => setRoom(r.id, { start: e.target.value })} />
                          <span className="sch-dash">–</span>
                          <input className="inp tabular" type="time" value={st.end} onChange={(e) => setRoom(r.id, { end: e.target.value })} />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {affected.length > 0 && (
            <div className="ctx-hint red sch-affected">
              <div className="sch-aff-head">⚠ На цю дату вже заплановано {affected.length} {affected.length === 1 ? "запис" : "записів"} у кабінетах, що закриваються.</div>
              <div className="sch-aff-sub">Після збереження їх буде позначено бейджем «🔧 Перезапис» і додано до панелі переносу.</div>
            </div>
          )}
        </div>
        <div className="dlg-foot sch-foot">
          {existing
            ? <button className="btn btn-ghost sch-reset" onClick={onReset} title="Прибрати ручні зміни — повернути типовий графік">↺ Скинути до типового</button>
            : <span className="sch-foot-sp" style={{ marginRight: "auto" }} />}
          <div className="sch-foot-r" style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
            <button className="btn btn-ghost" onClick={onClose}>Скасувати</button>
            <button className="btn btn-primary" onClick={() => onSave(buildOv())}>✓ Зберегти графік</button>
          </div>
        </div>
      </div>
    </div>
  );
}
