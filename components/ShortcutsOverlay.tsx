"use client";

/* Оверлей гарячих клавіш (UX-аудит v2 · P3 discoverability). Викликається клавішею
   «?» на дошці — раніше хоткеї (N / «/» / R / цифри) були прихованими, їх треба було
   вгадувати. Доступність: role="dialog" + useModalA11y (фокус-пастка, Esc, повернення
   фокуса). Список передається пропом, тож дошки можуть показувати свій набір. */

import { useModalA11y } from "@/lib/useModalA11y";

export interface Shortcut {
  keys: string[]; // напр. ["N"] або ["1", "…", "9"]
  label: string;
}

export interface GlossaryTerm {
  glyph?: string;   // гліф статусу (той самий, що в беджі рядка)
  term: string;     // назва (напр. «Не відбулося»)
  desc: string;     // коротке пояснення терміна
}

export default function ShortcutsOverlay({ shortcuts, glossary, onClose }: { shortcuts: Shortcut[]; glossary?: GlossaryTerm[]; onClose: () => void }) {
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  return (
    <div className="overlay">
      <div className="dialog dlg-confirm fade-in" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Довідка: гарячі клавіші та терміни" style={{ maxWidth: 460 }}>
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic">⌨</span>Довідка</div>
          <button className="icon-btn" onClick={onClose} aria-label="Закрити">✕</button>
        </div>
        <div className="dlg-body" style={{ display: "flex", flexDirection: "column", gap: 18, maxHeight: "70vh", overflowY: "auto" }}>
          <section>
            <h3 style={{ margin: "0 0 10px", fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--text-muted)" }}>Гарячі клавіші</h3>
            <dl style={{ display: "flex", flexDirection: "column", gap: 10, margin: 0 }}>
              {shortcuts.map((s, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
                  <dd style={{ margin: 0, fontSize: 13.5, color: "var(--text)" }}>{s.label}</dd>
                  <dt style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                    {s.keys.map((k, j) => (
                      k === "…"
                        ? <span key={j} aria-hidden="true" style={{ color: "var(--text-muted)", fontSize: 12 }}>…</span>
                        : <kbd key={j} style={{ minWidth: 22, textAlign: "center", padding: "2px 6px", fontSize: 12, fontWeight: 700, lineHeight: 1.4, borderRadius: 6, border: "1px solid var(--border-strong)", background: "var(--card-2)", color: "var(--text-secondary)", fontFamily: "inherit" }}>{k}</kbd>
                    ))}
                  </dt>
                </div>
              ))}
            </dl>
          </section>
          {glossary && glossary.length > 0 && (
            <section>
              <h3 style={{ margin: "0 0 10px", fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--text-muted)" }}>Статуси та терміни</h3>
              <dl style={{ display: "flex", flexDirection: "column", gap: 10, margin: 0 }}>
                {glossary.map((g, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                    <dt style={{ flexShrink: 0, minWidth: 108, display: "flex", alignItems: "baseline", gap: 6, fontSize: 13.5, fontWeight: 600, color: "var(--text)" }}>
                      {g.glyph && <span aria-hidden="true" style={{ color: "var(--text-muted)" }}>{g.glyph}</span>}{g.term}
                    </dt>
                    <dd style={{ margin: 0, fontSize: 12.5, lineHeight: 1.4, color: "var(--text-secondary)" }}>{g.desc}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
