"use client";

/* ===== RadFlow — міні-календар (спільний) =====
   Місячна сітка вибору дати. Використовується на дошці адміністратора
   (QueueBoard — з редагуванням графіка) і в порталі направника
   (ReferrerBoard — лише вибір дати). */

import { useState } from "react";
import { dayStatus, type DayOverride } from "@/lib/schedule";
import { wallToday0 } from "@/lib/incidents";

const WK_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
const MON_NOM = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
function startOfDay(d: Date) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function sameDay(a: Date, b: Date) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function dowMon(d: Date) { return (d.getDay() + 6) % 7; }
function dateKey(d: Date) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }

interface MiniCalendarProps {
  selectedDate: Date;
  onSelectDate: (d: Date) => void;
  overridesByDate?: Record<string, DayOverride>;
  onEditSchedule?: () => void;
  /** false → не підсвічувати «обрану» дату (напр. коли фільтр дати вимкнено). */
  highlightSelected?: boolean;
  /** IANA-зона центру. Мультицентрові екрани (портал направника) передають зону
      обраного центру; на дошках персоналу можна не передавати — візьметься
      singleton setClinicTz(). Без цього «сьогодні» підсвічувалося по браузеру. */
  tz?: string;
}

export default function MiniCalendar({ selectedDate, onSelectDate, overridesByDate, onEditSchedule, highlightSelected = true, tz }: MiniCalendarProps) {
  const today = wallToday0(tz);
  const ovMap = overridesByDate || {};
  const [viewMonth, setViewMonth] = useState(() => new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1));
  const shift = (n: number) => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));
  const y = viewMonth.getFullYear(), mo = viewMonth.getMonth();
  const first = new Date(y, mo, 1);
  const days = new Date(y, mo + 1, 0).getDate();
  const startIdx = dowMon(first);
  const cells: (number | null)[] = [];
  for (let i = 0; i < startIdx; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  return (
    <div className="bk-cal">
      <div className="cal-head">
        <span className="cal-month">{MON_NOM[mo]} {y}</span>
        <div className="cal-nav">
          <button className="mini-icon" style={{ width: 24, height: 24 }} onClick={() => shift(-1)} title="Попередній місяць">‹</button>
          <button className="mini-icon" style={{ width: 24, height: 24 }} onClick={() => shift(1)} title="Наступний місяць">›</button>
        </div>
      </div>
      <div className="cal-grid">
        {WK_SHORT.map((d) => <div className="cal-dow" key={d}>{d}</div>)}
        {cells.map((d, i) => {
          if (d === null) return <div className="cal-day empty-day" key={"e" + i} />;
          const cd = new Date(y, mo, d);
          const isToday = sameDay(cd, today);
          const isSel = highlightSelected && sameDay(cd, selectedDate);
          const ov = ovMap[dateKey(cd)] || null;
          const st = dayStatus(ov, cd);
          const markClosed = st.kind === "closed";
          const markCustom = st.kind === "custom";
          return (
            <button key={d} className={"cal-day" + (isToday ? " today" : "") + (isSel && !isToday ? " selected" : "") + (markClosed ? " holiday" : "") + (markCustom ? " custom" : "")}
              title={st.label || undefined} aria-label={st.label ? `${d} — ${st.label}` : undefined} onClick={() => onSelectDate(startOfDay(cd))}>
              {d}
              {(markClosed || markCustom) && <span className={"cal-sched " + (markClosed ? "closed" : "custom")} />}
            </button>
          );
        })}
      </div>
      {onEditSchedule && (
        <button className="btn btn-secondary btn-sm" style={{ width: "100%", marginTop: 10, justifyContent: "center" }} onClick={() => onEditSchedule()}>
          ✎ Графік на {selectedDate.getDate()} {MON_NOM[selectedDate.getMonth()].toLowerCase()}
        </button>
      )}
    </div>
  );
}
