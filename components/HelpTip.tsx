"use client";

/* P2.2 — Контекстна довідка: маленька кнопка «?» з поповером-поясненням.
   Закривається по кліку поза, по Esc; доступна з клавіатури. */

import { useEffect, useRef, useState, type ReactNode } from "react";

export default function HelpTip({ text, label = "Довідка" }: { text: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <span className="helptip" ref={ref}>
      <button
        type="button"
        className="helptip-btn"
        aria-label={label}
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
      >
        ?
      </button>
      {open && (
        <span className="helptip-pop" role="tooltip">
          {text}
        </span>
      )}
    </span>
  );
}
