"use client";

/* ===== RadFlow — Аварійна зупинка =====
   Блокує роботу одного/кількох/усіх кабінетів до з'ясування обставин. Пацієнтів
   цього дня буде позначено на обдзвон (Колл-лист) + подія в автоматизацію.
   Відкривається кнопкою-тумблером «Аварійна зупинка» в сайдбарі. */

import { useState } from "react";
import { useModalA11y } from "@/lib/useModalA11y";

type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null };
function modalityLabel(m: string) { return m === "MRI" ? "МРТ" : m === "CT" ? "КТ" : "Інше"; }

interface EmergencyModalProps {
  rooms?: RoomOpt[];
  stoppedRoomIds?: string[]; // кабінети з активною аварією
  affectedCount?: number;    // постраждалих сьогодні (опційно, для інформації)
  busy?: boolean;
  onClose: () => void;
  onStop: (roomIds: string[], note: string) => void | Promise<void>;
  onResume: (roomIds: string[]) => void | Promise<void>;
}

export default function EmergencyModal({ rooms = [], stoppedRoomIds = [], affectedCount, busy, onClose, onStop, onResume }: EmergencyModalProps) {
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  const stopped = new Set(stoppedRoomIds);
  const free = rooms.filter((r) => !stopped.has(r.id));
  const stoppedList = rooms.filter((r) => stopped.has(r.id));
  const [sel, setSel] = useState<Set<string>>(() => new Set()); // за замовч. — нічого не обрано (свідомий вибір)
  const [note, setNote] = useState("");
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selList = free.filter((r) => sel.has(r.id)).map((r) => r.id);

  /* Відновлення — теж ВИБІР кабінетів. Раніше кнопка «▶ Відновити роботу»
     викликала onResume() без аргументів → сервер знімав аварію з УСІХ кабінетів
     клініки, хоча в списку були перелічені конкретні. За замовчуванням обрані
     всі зупинені (типовий сценарій), але зняти можна частково.
     Зберігаємо ЗНЯТІ галочки (а не обрані): stoppedRoomIds оновлюється realtime —
     кабінет, зупинений іншим оператором при відкритій модалці, потрапляє у вибір
     сам, а відновлений — зникає зі списку без «висячого» id. */
  const [unselResume, setUnselResume] = useState<Set<string>>(() => new Set());
  const toggleResume = (id: string) => setUnselResume((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const isResumeSel = (id: string) => !unselResume.has(id);
  const resumeList = stoppedList.filter((r) => isResumeSel(r.id)).map((r) => r.id);

  return (
    <div className="overlay">
      <div className="dialog fade-in" style={{ maxWidth: 560 }} ref={dialogRef} role="dialog" aria-modal="true" aria-label="Аварійна зупинка">
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic" style={{ background: "var(--red-bg)", color: "var(--red)" }}>🛑</span>Аварійна зупинка</div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="dlg-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="ctx-hint red" style={{ fontSize: 13 }}>
            Зупинка блокує обрані кабінети <b>до з'ясування обставин</b>. Пацієнтів цього дня буде позначено на <b>обдзвон</b> (Колл-лист) і надіслано подію в автоматизацію.
          </div>

          {stoppedList.length > 0 && (
            <div className="fld" style={{ marginBottom: 0 }}>
              <span className="fld-lab">Зараз зупинено{typeof affectedCount === "number" ? ` · постраждалих сьогодні: ${affectedCount}` : ""} — оберіть, які відновити</span>
              <div className="bd-rooms">
                {stoppedList.map((r) => (
                  <button key={r.id} className={"bd-room" + (isResumeSel(r.id) ? " active" : "")} onClick={() => toggleResume(r.id)}
                    aria-pressed={isResumeSel(r.id)} title={"Відновити " + r.name}>
                    <span className={"bd-room-kind " + (r.modality === "MRI" ? "mrt" : "ct")}>{modalityLabel(r.modality)}</span>
                    <span className="bd-room-meta"><span className="bd-room-name">{r.name}</span><span className="bd-room-model" style={{ color: "var(--red)" }}>🛑 зупинено</span></span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {free.length > 0 ? (
            <>
              <div className="fld" style={{ marginBottom: 0 }}>
                <span className="fld-lab">Які кабінети зупинити?</span>
                <div className="bd-rooms">
                  {free.map((r) => (
                    <button key={r.id} className={"bd-room" + (sel.has(r.id) ? " active" : "")} onClick={() => toggle(r.id)} title={r.name + (r.apparatus_model ? " · " + r.apparatus_model : "")}>
                      <span className={"bd-room-kind " + (r.modality === "MRI" ? "mrt" : "ct")}>{modalityLabel(r.modality)}</span>
                      <span className="bd-room-meta"><span className="bd-room-name">{r.name}</span><span className="bd-room-model">{r.apparatus_model || ""}</span></span>
                    </button>
                  ))}
                </div>
              </div>
              <label className="fld" style={{ marginBottom: 0 }}>
                <span className="fld-lab">Причина (необовʼязково)</span>
                <input className="inp" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Напр.: витік / пожежна тривога / збій електроживлення" />
              </label>
            </>
          ) : (
            <div className="ctx-hint blue" style={{ fontSize: 12.5 }}>Усі кабінети вже зупинено.</div>
          )}
        </div>
        <div className="dlg-foot">
          {stoppedList.length > 0 && (
            <button className="btn btn-green" disabled={busy || resumeList.length === 0} onClick={() => onResume(resumeList)} style={{ marginRight: "auto" }}>
              ▶ Відновити роботу{resumeList.length ? ` (${resumeList.length})` : ""}
            </button>
          )}
          <button className="btn btn-ghost" onClick={onClose}>Скасувати</button>
          <button className="btn btn-breakdown" disabled={busy || selList.length === 0} onClick={() => onStop(selList, note.trim())}>
            🛑 Зупинити{selList.length ? ` (${selList.length})` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
