"use client";

/* ===== RadFlow — таймер дослідження (кільце зворотного відліку) =====
   Показує, СКІЛЬКИ лишилось до кінця дослідження (з буфером прибирання/переукладки).
   Синє кільце вгорі (12 год) убуває за годинниковою стрілкою з кожною секундою.
   Вгорі в кружку — час завершення (🔔 HH:MM). Коли лишається ≤5 хв — кільце й час
   стають червоними з пульсацією (стиль RadFlow, keyframe pulse). Перевищення (−) —
   суцільне червоне + «+MM:SS».

   Основа відліку (за рішенням власника): дослідження + буфер, тобто «коли кабінет
   повністю звільниться». startAt = in_progress_at (реальна мить). Залишок і час
   завершення НЕ залежать від часового поясу (тривалості), а стінний HH:MM рахуємо
   через wallNow() (стінний-як-UTC) + залишок — без подвійного зсуву Intl. */

import { useEffect, useState } from "react";
import { wallNow } from "@/lib/incidents";
import { serverNow } from "@/lib/serverClock";

const CRIT_SEC = 5 * 60; // ≤5 хв → червоне + пульсація

const pad = (n: number) => String(n).padStart(2, "0");
function fmtMS(sec: number) {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60), r = s % 60, h = Math.floor(m / 60);
  if (h) return h + ":" + pad(m % 60) + ":" + pad(r);
  return m + ":" + pad(r);
}

export interface StudyTimerProps {
  startAt: string | null | undefined;   // in_progress_at (ISO). null → відлік від «зараз».
  durationMin: number;                    // тривалість дослідження (хв)
  bufferMin?: number;                     // буфер після дослідження (хв) — входить у кільце
  variant?: "full" | "mini";
  size?: number;                          // перевизначити діаметр (px)
  caption?: React.ReactNode;              // підпис під числом (лише full)
}

export default function StudyTimer({ startAt, durationMin, bufferMin = 0, variant = "full", size, caption }: StudyTimerProps) {
  /* Ф4-8: «зараз» — за годинником БАЗИ, бо startAt (in_progress_at) поставила
     БАЗА. Раніше різниця бралася між двома різними годинниками: ПК без NTP,
     що поспішає на 8 хв, стартував кільце з 27:00 замість 35:00, а «критичне»
     червоне настає на ті ж 8 хв раніше.
     ⚠️ finishLabel нижче рахується через wallNow(), який після U-70 несе ТУ Ж
     поправку. Це не збіг, а вимога: до Ф4-8 дві помилки скорочувались (обидві
     з того самого годинника) і час завершення показувався ВІРНО — виправити
     лише одну з них означало б зламати те, що працювало. */
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => {
    const t = setInterval(() => setNow(serverNow()), 1000);
    return () => clearInterval(t);
  }, []);

  const totalSec = Math.max(1, Math.round((durationMin + bufferMin) * 60));
  const start = startAt ? new Date(startAt).getTime() : now;
  const elapsed = Math.max(0, (now - start) / 1000);
  const remaining = totalSec - elapsed;                 // може бути < 0 (перевищення)
  const over = remaining < 0;
  const critical = !over && remaining <= CRIT_SEC;
  const frac = Math.max(0, Math.min(1, remaining / totalSec));

  // Час завершення (стінний HH:MM) = стінний зараз + залишок (для over — у минулому).
  const finishD = new Date(wallNow() + remaining * 1000);
  const finishLabel = pad(finishD.getUTCHours()) + ":" + pad(finishD.getUTCMinutes());

  const dim = size ?? (variant === "mini" ? 42 : 224);
  const stroke = variant === "mini" ? 4 : 9;
  const r = dim / 2 - stroke / 2 - 1;
  const C = 2 * Math.PI * r;
  const dash = Math.max(0, C * frac);
  const cls = over ? "over" : critical ? "crit" : "ok";
  const remainText = over ? "+" + fmtMS(-remaining) : fmtMS(remaining);
  const aria = (over ? "Перевищення часу " : "Залишилось ") + fmtMS(Math.abs(remaining)) + (over ? "" : (", завершення о " + finishLabel));

  return (
    <div className={"study-timer " + variant + " " + cls} role="timer" aria-label={aria} title={aria}>
      <svg width={dim} height={dim} viewBox={`0 0 ${dim} ${dim}`} className="st-svg" aria-hidden="true">
        <circle className="st-track" cx={dim / 2} cy={dim / 2} r={r} strokeWidth={stroke} fill="none" />
        <circle className="st-arc" cx={dim / 2} cy={dim / 2} r={r} strokeWidth={stroke} fill="none"
          strokeLinecap="round" strokeDasharray={`${dash} ${C}`}
          transform={`rotate(-90 ${dim / 2} ${dim / 2})`} />
      </svg>
      <div className="st-face">
        {variant === "full" && (
          <div className="st-finish">
            <span aria-hidden="true">🔔</span>
            <span className="tabular">{finishLabel}</span>
          </div>
        )}
        <div className="st-remain tabular">{remainText}</div>
        {variant === "full" && caption != null && <div className="st-cap">{caption}</div>}
      </div>
    </div>
  );
}
