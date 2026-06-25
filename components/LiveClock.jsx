"use client";

import { useState, useEffect } from "react";

// Поточний час у шапці — спільний компонент для всіх ролей.
export default function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  return (
    <span className="tabular" style={{ fontVariantNumeric: "tabular-nums" }}>
      🕐 {now.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
    </span>
  );
}
