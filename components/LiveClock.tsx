"use client";

import { useState, useEffect } from "react";

// Поточний час у шапці — спільний компонент для всіх ролей.
// Час показуємо ЛИШЕ після монтування на клієнті, інакше SSR-рядок не збігається
// з клієнтським і виникає hydration mismatch.
export default function LiveClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="tabular" style={{ fontVariantNumeric: "tabular-nums" }} suppressHydrationWarning>
      🕐 {now ? now.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--:--:--"}
    </span>
  );
}
