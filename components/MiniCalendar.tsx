"use client";

/* ===== RadFlow — міні-календар (спільний) =====
   Місячна сітка вибору дати. Використовується на дошці адміністратора
   (QueueBoard — з редагуванням графіка) і в порталі направника
   (ReferrerBoard — лише вибір дати). */

import { useState } from "react";
import { dayStatus, type DayOverride } from "@/lib/schedule";
import { wallToday0 } from "@/lib/incidents";
import { useUnreadChanges } from "@/lib/useUnreadChanges";
import { calendarDayKey, unreadForDate } from "@/lib/unreadChanges";

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
  /** Базові графіки кабінетів (rooms.schedule) — щоб позначати «вихідний» за
      реальним графіком, а не лише за неділею. Не передані → фолбек на неділю. */
  roomSchedules?: unknown[];
  /** Центр, чий календар показуємо. ОБОВʼЯЗКОВО для мультицентрових екранів
      (портал направника): без нього крапка чужого центру світилась би тут і
      не гасла. Персонал свого центру може не передавати. */
  clinicId?: string | null;
}

export default function MiniCalendar({ selectedDate, onSelectDate, overridesByDate, onEditSchedule, highlightSelected = true, tz, roomSchedules, clinicId }: MiniCalendarProps) {
  const today = wallToday0(tz);
  const ovMap = overridesByDate || {};
  /* Контекстні позначки на календарі (0133). Дата приходить у самій позначці
     (subject_date), а не виводиться з завантажених записів: календар показує
     МІСЯЦЬ, а дошка вантажить ОДИН день — вивести було б нізвідки (урок с24).
     Крапка тут ПОХІДНА: гасне, коли погашено всі позначки цього дня, тобто
     після того, як користувач відкрив день і розгорнув відповідні картки. */
  const { index: unreadIx } = useUnreadChanges();
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
          const st = dayStatus(ov, cd, roomSchedules);
          const markClosed = st.kind === "closed";
          const markCustom = st.kind === "custom";
          const dayUnread = unreadForDate(unreadIx, calendarDayKey(cd), clinicId);
          /* ⚠️ Стан не лише кольором (WCAG 1.4.1): крапку дублює доступне імʼя.
             aria-label будуємо ЗАВЖДИ, коли є що сказати, — і число дня в ньому
             лишається першим, щоб видимий текст був неперервною підстрокою
             доступного імені (2.5.3 Label in Name, правило проєкту). */
          /* На календарі — ЗАВЖДИ групове формулювання, навіть для однієї
             позначки: markerLabel описує блок поля («перелік послуг»), якого
             на календарі немає, і в контексті дня це збивало б з пантелику. */
          const unreadLabel = dayUnread.length ? `Є непрочитані зміни: ${dayUnread.length}` : null;
          const labelParts = [String(d), st.label || null, unreadLabel].filter(Boolean);
          return (
            <button key={d} className={"cal-day" + (isToday ? " today" : "") + (isSel && !isToday ? " selected" : "") + (markClosed ? " holiday" : "") + (markCustom ? " custom" : "")}
              title={[st.label || null, unreadLabel].filter(Boolean).join(" · ") || undefined}
              aria-label={labelParts.length > 1 ? labelParts.join(" — ") : undefined}
              onClick={() => onSelectDate(startOfDay(cd))}>
              {d}
              {(markClosed || markCustom) && <span className={"cal-sched " + (markClosed ? "closed" : "custom")} />}
              {/* .cal-change — крапка з «вирізом» під фон дня; клас був у
                  прототипі й досі не використовувався. */}
              {dayUnread.length > 0 && <span className="cal-change" aria-hidden="true" />}
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
