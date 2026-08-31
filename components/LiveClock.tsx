"use client";

import { useState, useEffect } from "react";
import { getClinicTz } from "@/lib/incidents";
import { serverNow } from "@/lib/serverClock";

// Поточний час у шапці — спільний компонент для всіх ролей.
// Час показуємо ЛИШЕ після монтування на клієнті, інакше SSR-рядок не збігається
// з клієнтським і виникає hydration mismatch.
//
// Годинник іде за часом ЦЕНТРУ, а не браузера: уся решта дошки (слоти, «Запізнення»,
// блокування виклику) рахується в настінному часі клініки, і оператор з іншої зони
// бачив би розбіжність між власним годинником і поведінкою системи (аудит M-4).
// tz: явна зона (мультицентрові екрани) → singleton setClinicTz() → зона браузера.
//
// ⚠️ U-70: момент береться з `serverNow()` — ВИМІРЯНОГО годинника бази, а не з
// `Date.now()` (знахідка ревʼю А, HIGH). Ф4-8 виправив таймери й звук, U-70 —
// увесь настінний канон (слоти, «Запізнення», блокування виклику), і цей підпис
// лишався б ЄДИНИМ місцем на годиннику ПК. На одному екрані було б два різні
// «зараз», причому невірним був би саме той, на який дивиться людина: ПК, що
// поспішає на 8 хвилин, підтверджував би собою власну помилку, і система
// виглядала б не «з поправкою», а «з двома різними часами».
// Поки зсув не виміряно, serverNow() === Date.now() — тобто поведінка колишня.
export default function LiveClock({ tz }: { tz?: string }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date(serverNow()));
    const t = setInterval(() => setNow(new Date(serverNow())), 1000);
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
