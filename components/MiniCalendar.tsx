"use client";

/* ===== RadFlow — міні-календар (спільний) =====
   Місячна сітка вибору дати. Використовується на дошці адміністратора
   (QueueBoard — з редагуванням графіка) і в порталі направника
   (ReferrerBoard — лише вибір дати). */

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { dayStatusFromFeed, type OverrideFeed } from "@/lib/schedule";
import { wallToday0 } from "@/lib/incidents";
import { useUnreadChanges } from "@/lib/useUnreadChanges";
import { calendarDayKey, unreadForDate } from "@/lib/unreadChanges";
import { isEntryDrag, DRAG_HOVER_OPEN_MS, DRAG_HOVER_MONTH_MS } from "@/lib/dragMove";

const WK_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
const MON_NOM = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
function startOfDay(d: Date) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function sameDay(a: Date, b: Date) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function dowMon(d: Date) { return (d.getDay() + 6) % 7; }
/* Ключ дати більше не будується тут: вибір override'а по даті переїхав у
   lib/schedule (dayStatusFromFeed → dateKeyOf), щоб разом із рядком не
   губився прапорець збою читання (U-16). */

interface MiniCalendarProps {
  selectedDate: Date;
  onSelectDate: (d: Date) => void;
  /* U-16: ФІД, а не гола мапа. Позначки «вихідний» / «особливий графік» — це
     ТВЕРДЖЕННЯ про день; при збої читання мапа порожня, і календар мовчки
     називав закритий день звичайним.
     ⚠️ Проп лишається необовʼязковим свідомо: `ReferrerBoard` особливих
     графіків не читає ВЗАГАЛІ (там календар — лише фільтр дати), і написати
     йому `failed: false` означало б збрехати типом. Відсутній фід і фід зі
     збоєм — різні відповіді, їх розрізняє dayStatusFromFeed. */
  overrides?: OverrideFeed;
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
  /* с81, перенос перетягуванням. Поки над дошкою тягнуть запис
     (`dragActive`), день календаря — ціль наведення: потримати курсор над
     днем `DRAG_HOVER_OPEN_MS` або відпустити на ньому → батько відкриває карту
     дня («Зайнятість кабінету») з кабінетом запису, де запис і кидають на
     вільний слот. Стрілки місяця перегортають календар після
     `DRAG_HOVER_MONTH_MS` наведення — інакше далі поточного місяця не дотягти.
     Минулі дні ціллю не є: перенести в минуле не можна жодною роллю. */
  dragActive?: boolean;
  onDragOpenDay?: (d: Date) => void;
}

export default function MiniCalendar({ selectedDate, onSelectDate, overrides, onEditSchedule, highlightSelected = true, tz, roomSchedules, clinicId, dragActive = false, onDragOpenDay }: MiniCalendarProps) {
  const today = wallToday0(tz);
  /* Контекстні позначки на календарі (0133). Дата приходить у самій позначці
     (subject_date), а не виводиться з завантажених записів: календар показує
     МІСЯЦЬ, а дошка вантажить ОДИН день — вивести було б нізвідки (урок с24).
     Крапка тут ПОХІДНА: гасне, коли погашено всі позначки цього дня, тобто
     після того, як користувач відкрив день і розгорнув відповідні картки. */
  const { index: unreadIx } = useUnreadChanges();
  const [viewMonth, setViewMonth] = useState(() => new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1));
  const shift = (n: number) => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));
  /* Таймер наведення при перетягуванні — один на календар: перехід на сусідній
     день перезаводить його, вихід з дня знімає. Гаситься і при розмонтуванні. */
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const clearHover = useCallback(() => { if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null; } }, []);
  useEffect(() => clearHover, [clearHover]);
  useEffect(() => { if (!dragActive) { clearHover(); setDragOver(null); } }, [dragActive, clearHover]);
  const dragOn = dragActive && !!onDragOpenDay;
  const dayDragProps = (cd: Date, key: string) => {
    if (!dragOn || cd < today) return {};
    const arm = () => { clearHover(); hoverTimer.current = setTimeout(() => { hoverTimer.current = null; onDragOpenDay!(startOfDay(cd)); }, DRAG_HOVER_OPEN_MS); };
    return {
      onDragEnter: (e: DragEvent<HTMLButtonElement>) => { if (!isEntryDrag(e.dataTransfer)) return; e.preventDefault(); setDragOver(key); arm(); },
      onDragOver: (e: DragEvent<HTMLButtonElement>) => { if (!isEntryDrag(e.dataTransfer)) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dragOver !== key) { setDragOver(key); arm(); } },
      onDragLeave: () => { clearHover(); setDragOver((o) => (o === key ? null : o)); },
      onDrop: (e: DragEvent<HTMLButtonElement>) => { if (!isEntryDrag(e.dataTransfer)) return; e.preventDefault(); clearHover(); setDragOver(null); onDragOpenDay!(startOfDay(cd)); },
    };
  };
  const navDragProps = (n: number) => {
    if (!dragOn) return {};
    return {
      onDragEnter: (e: DragEvent<HTMLButtonElement>) => { if (!isEntryDrag(e.dataTransfer)) return; clearHover(); hoverTimer.current = setTimeout(() => { hoverTimer.current = null; shift(n); }, DRAG_HOVER_MONTH_MS); },
      onDragLeave: () => clearHover(),
    };
  };
  const y = viewMonth.getFullYear(), mo = viewMonth.getMonth();
  const first = new Date(y, mo, 1);
  const days = new Date(y, mo + 1, 0).getDate();
  const startIdx = dowMon(first);
  const cells: (number | null)[] = [];
  for (let i = 0; i < startIdx; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  return (
    <div className={"bk-cal" + (dragOn ? " drag-target" : "")}>
      <div className="cal-head">
        <span className="cal-month">{MON_NOM[mo]} {y}</span>
        <div className="cal-nav">
          <button className="mini-icon" style={{ width: 24, height: 24 }} onClick={() => shift(-1)} title="Попередній місяць" aria-label="Попередній місяць" {...navDragProps(-1)}><span aria-hidden="true">‹</span></button>
          <button className="mini-icon" style={{ width: 24, height: 24 }} onClick={() => shift(1)} title="Наступний місяць" aria-label="Наступний місяць" {...navDragProps(1)}><span aria-hidden="true">›</span></button>
        </div>
      </div>
      {/* Підказка видима лише під час перетягування — читає її той, хто тягне. */}
      {dragOn && <div className="cal-drag-hint" role="status">Наведіть на день — відкриється карта дня для переносу</div>}
      <div className="cal-grid">
        {WK_SHORT.map((d) => <div className="cal-dow" key={d}>{d}</div>)}
        {cells.map((d, i) => {
          if (d === null) return <div className="cal-day empty-day" key={"e" + i} />;
          const cd = new Date(y, mo, d);
          const isToday = sameDay(cd, today);
          const isSel = highlightSelected && sameDay(cd, selectedDate);
          /* U-16: `null` = особливі графіки не прочитались — тоді про день не
             стверджуємо НІЧОГО (ні «вихідний», ні «особливий графік»), а причину
             називаємо один раз під сіткою. Мовчазна відсутність позначки без
             пояснення і була дефектом: закритий день виглядав звичайним. */
          const st = dayStatusFromFeed(overrides, cd, roomSchedules);
          const markClosed = st?.kind === "closed";
          const markCustom = st?.kind === "custom";
          const dayUnread = unreadForDate(unreadIx, calendarDayKey(cd), clinicId);
          /* ⚠️ Стан не лише кольором (WCAG 1.4.1): крапку дублює доступне імʼя.
             aria-label будуємо ЗАВЖДИ, коли є що сказати, — і число дня в ньому
             лишається першим, щоб видимий текст був неперервною підстрокою
             доступного імені (2.5.3 Label in Name, правило проєкту). */
          /* На календарі — ЗАВЖДИ групове формулювання, навіть для однієї
             позначки: markerLabel описує блок поля («перелік послуг»), якого
             на календарі немає, і в контексті дня це збивало б з пантелику. */
          const unreadLabel = dayUnread.length ? `Є непрочитані зміни: ${dayUnread.length}` : null;
          const labelParts = [String(d), st?.label || null, unreadLabel].filter(Boolean);
          const dayKey = calendarDayKey(cd);
          return (
            <button key={d} className={"cal-day" + (isToday ? " today" : "") + (isSel && !isToday ? " selected" : "") + (markClosed ? " holiday" : "") + (markCustom ? " custom" : "") + (dragOn && dragOver === dayKey ? " drag-over" : "")}
              title={[st?.label || null, unreadLabel].filter(Boolean).join(" · ") || undefined}
              aria-label={labelParts.length > 1 ? labelParts.join(" — ") : undefined}
              aria-current={isSel ? "date" : undefined}
              {...dayDragProps(cd, dayKey)}
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
      {/* U-16: причину відсутності позначок називаємо ОДИН раз під сіткою.
          Без цього рядка «нічого не стверджуємо» виглядає як «звичайний
          місяць» — тобто те саме твердження, лише мовчазне. */}
      {overrides?.failed && (
        <div className="ctx-hint red" style={{ fontSize: "0.75rem", marginTop: 8 }} role="status">
          ⚠ Особливі графіки не завантажились — вихідні й особливі дні не позначено.
        </div>
      )}
      {onEditSchedule && (
        <button className="btn btn-secondary btn-sm" style={{ width: "100%", marginTop: 10, justifyContent: "center" }} onClick={() => onEditSchedule()}>
          ✎ Графік на {selectedDate.getDate()} {MON_NOM[selectedDate.getMonth()].toLowerCase()}
        </button>
      )}
    </div>
  );
}
