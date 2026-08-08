"use client";

/* Бейдж стану realtime-каналу дошки.
   Аудит 2026-08-07 (M-2): раніше в кожній дошці стояв літерал
   `<span className="rt-pill">…Real-time</span>` із зеленою крапкою НАЗАВЖДИ —
   він світився однаково і при живому сокеті, і при CHANNEL_ERROR/TIMED_OUT.
   Це не косметика: при обриві дошка переходить на аварійний полінг із backoff
   8→60 с, тобто «зараз» на екрані може відставати на хвилину, а оператор саме
   за цим бейджем вирішує, чи можна довіряти станам кабінетів.
   Компонент навмисно НІЧОГО не знає про підписки — лише малює `health`, який
   віддає useRealtimeRefetch. Один компонент на всі дошки, щоб наступна не
   народилась із власним зеленим літералом. */

import type { RealtimeHealth } from "@/lib/useRealtimeRefetch";

export default function RealtimeBadge({ health }: { health: RealtimeHealth }) {
  /* Три стани, а не два: перше підключення ≠ обрив — інакше бейдж тривожив би на
     кожному маунті дошки, поки сокет ще піднімається.
     «lost» вмикає БУДЬ-ЯКА невдала спроба (`failed`), а не лише розрив після
     успіху: якщо Realtime лежить і сокет не піднявся жодного разу, дошка так само
     сидить на аварійному полінгу й дані відстають (ревʼю пакета M-2, р.1). */
  const state = health.live ? "live" : health.everLive || health.failed ? "lost" : "connecting";
  const meta = {
    live: {
      cls: "",
      color: "var(--green)",
      text: "Real-time",
      /* «Підписка активна», а не «ви бачите все зараз»: realtime ходить під RLS
         (частину подій адресат просто не отримує) і мовчки згасає після ротації
         токена. Бейдж чесно каже про СТАН КАНАЛУ (ревʼю р.2). */
      title: "Підписка на зміни активна",
      pulse: true,
    },
    lost: {
      cls: " rt-pill-lost",
      color: "var(--orange)",
      text: "Звʼязок втрачено",
      title: "Миттєві оновлення недоступні — дані оновлюються періодичними запитами. Дані на екрані можуть відставати.",
      pulse: false,
    },
    connecting: {
      cls: " rt-pill-wait",
      color: "var(--text-muted)",
      text: "Підключення…",
      title: "Встановлюємо зʼєднання для миттєвих оновлень",
      pulse: false,
    },
  }[state];

  return (
    /* aria-live="polite": втрату звʼязку читач екрана має почути, але не
       переривати поточну фразу. */
    <span className={"rt-pill" + meta.cls} title={meta.title} aria-live="polite">
      <span
        className={meta.pulse ? "pulse-dot" : undefined}
        style={{ background: meta.color, width: 7, height: 7, borderRadius: "50%", display: "inline-block", flexShrink: 0 }}
        aria-hidden="true"
      />
      {meta.text}
    </span>
  );
}
