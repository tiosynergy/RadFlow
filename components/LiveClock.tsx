"use client";

import { useState, useEffect } from "react";
import { getClinicTz } from "@/lib/incidents";

// Поточний час у шапці — спільний компонент для всіх ролей.
// Час показуємо ЛИШЕ після монтування на клієнті, інакше SSR-рядок не збігається
// з клієнтським і виникає hydration mismatch.
//
// Годинник іде за часом ЦЕНТРУ, а не браузера: уся решта дошки (слоти, «Запізнення»,
// блокування виклику) рахується в настінному часі клініки, і оператор з іншої зони
// бачив би розбіжність між власним годинником і поведінкою системи (аудит M-4).
// tz: явна зона (мультицентрові екрани) → singleton setClinicTz() → зона браузера.
export default function LiveClock({ tz }: { tz?: string }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const zone = tz || getClinicTz();
  const fmt = (d: Date) => {
    const opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" };
    try { return d.toLocaleTimeString("uk-UA", zone ? { ...opts, timeZone: zone } : opts); }
    catch { return d.toLocaleTimeString("uk-UA", opts); }   // невалідна IANA-зона → локальна
  };
  return (
    <span className="tabular" style={{ fontVariantNumeric: "tabular-nums" }} suppressHydrationWarning>
      🕐 {now ? fmt(now) : "--:--:--"}
    </span>
  );
}
