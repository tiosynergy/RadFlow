"use client";

/* Регулятор щільності інтерфейсу — ползунок із трьома рівнями
   (Компактно / Звичайно / Просторо). Значення зберігається в localStorage
   під ключем 'rf-density' і застосовується до <html data-density> рано
   в app/layout.tsx (без миготіння). CSS — у styles/prototype/radflow.css,
   блок «Щільність інтерфейсу». Розміщується в кінці Майстра налаштувань. */

import { useEffect, useState } from "react";

const LEVELS = ["compact", "comfortable", "spacious"] as const;
type Density = (typeof LEVELS)[number];

const LABELS: Record<Density, string> = {
  compact: "Компактно",
  comfortable: "Звичайно",
  spacious: "Просторо",
};

export default function DensityControl() {
  const [idx, setIdx] = useState(1);

  useEffect(() => {
    const cur = document.documentElement.getAttribute("data-density") as Density | null;
    const i = cur ? LEVELS.indexOf(cur) : -1;
    setIdx(i >= 0 ? i : 1);
  }, []);

  function apply(i: number) {
    const next = Math.min(Math.max(i, 0), LEVELS.length - 1);
    const d = LEVELS[next];
    setIdx(next);
    try {
      document.documentElement.setAttribute("data-density", d);
      localStorage.setItem("rf-density", d);
    } catch {
      /* приватний режим / недоступний storage — ігноруємо */
    }
  }

  const current = LEVELS[idx];

  return (
    <div className="density-ctrl">
      <div className="density-head">
        <span className="density-title">Рівень щільності</span>
        <span className="density-now">{LABELS[current]}</span>
      </div>

      <input
        className="density-slider"
        type="range"
        min={0}
        max={LEVELS.length - 1}
        step={1}
        value={idx}
        onChange={(e) => apply(Number(e.target.value))}
        aria-label="Рівень щільності інтерфейсу"
        aria-valuetext={LABELS[current]}
      />

      <div className="density-ticks">
        {LEVELS.map((l) => (
          <button
            type="button"
            key={l}
            className={"density-tick" + (l === current ? " on" : "")}
            aria-pressed={l === current}
            onClick={() => apply(LEVELS.indexOf(l))}
          >
            {LABELS[l]}
          </button>
        ))}
      </div>
    </div>
  );
}
