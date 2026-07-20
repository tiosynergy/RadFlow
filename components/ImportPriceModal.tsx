"use client";

/* ===== RadFlow — модалка «Імпорт прайса» (Stage 2, фаза 3a) =====
   Флоу: файл (.xlsx/.csv) → POST /api/services/import (n8n парсить, сервер
   нормалізує/класифікує) → передперегляд по групах: «Зміна ціни/часу» / «Нові» /
   «Вимкнені (оживити?)» / «Нерозпізнані» (адмін обирає модальність) / «Без змін»
   → підтвердження → Server Action importServices → services_import_rpc (0115).

   Правила відображення = правила RPC: вимкнена позиція чіпається лише з
   галочкою «оживити»; тривалість оновлюється лише коли була в прайсі. */

import { useMemo, useRef, useState } from "react";
import { useModalA11y } from "@/lib/useModalA11y";
import { importServices, type ImportServiceRow } from "@/app/services/actions";
import { BOOKABLE_MODALITIES, modalityLabel } from "@/lib/studies";
import type { ClassifiedRow, DetectedColumns } from "@/lib/priceImport";

interface Preview {
  rows: ClassifiedRow[];
  skipped: number;
  columns: DetectedColumns;
  totalRaw: number;
  truncated?: boolean; // файл більший за ліміт розбору — частина рядків не потрапила
}

interface Props {
  onClose: () => void;
  /** Викликається ПІСЛЯ успішного імпорту (батько робить notify + refresh). */
  onDone: (msg: string) => void;
}

type Step = "pick" | "loading" | "preview" | "applying";
/** Модальності з формами запису (без OTHER) — тип збігається з ImportServiceRow.modality. */
type BookableMod = ImportServiceRow["modality"];

const fmtUah = (n: number) => n.toLocaleString("uk-UA") + " ₴";

export default function ImportPriceModal({ onClose, onDone }: Props) {
  const [step, setStep] = useState<Step>("pick");
  // Під час застосування закривати не можна (Esc/✕): імпорт на сервері завершиться,
  // а onDone/refresh — ні, і адмін бачитиме старий каталог (ревью L6).
  const stepRef = useRef(step);
  stepRef.current = step;
  const safeClose = () => { if (stepRef.current !== "applying") onClose(); };
  const dialogRef = useModalA11y<HTMLDivElement>(safeClose);
  const fileRef = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  // Вибір рядків: ключ = індекс у preview.rows. changed/new — увімкнені за
  // замовчуванням; inactive (оживити) — вимкнені; unrecognized — вимкнені, поки
  // не обрано модальність (modPick).
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [modPick, setModPick] = useState<Record<number, BookableMod | "">>({});

  async function onUpload(file: File) {
    setErr(null);
    setStep("loading");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const resp = await fetch("/api/services/import", { method: "POST", body: fd });
      const json = await resp.json().catch(() => null);
      if (!resp.ok || !json?.ok) {
        setErr(json?.error || "Не вдалося розібрати файл — додайте позиції вручну");
        setStep("pick");
        return;
      }
      const pv = json.preview as Preview;
      const init: Record<number, boolean> = {};
      pv.rows.forEach((r, i) => {
        if (r.kind === "new" || r.kind === "changed") init[i] = true;
      });
      setChecked(init);
      setModPick({});
      setPreview(pv);
      setStep("preview");
    } catch {
      // Транзієнтний збій мережі — не валимо модалку в overlay (канон try/catch).
      setErr("Не вдалося звʼязатися з сервером — спробуйте ще раз");
      setStep("pick");
    }
  }

  const groups = useMemo(() => {
    const g = { changed: [] as number[], news: [] as number[], inactive: [] as number[], unrecognized: [] as number[], unchanged: 0 };
    preview?.rows.forEach((r, i) => {
      if (r.kind === "changed") g.changed.push(i);
      else if (r.kind === "new") g.news.push(i);
      else if (r.kind === "inactive") g.inactive.push(i);
      else if (r.kind === "unrecognized") g.unrecognized.push(i);
      else g.unchanged++;
    });
    return g;
  }, [preview]);

  const selectedRows: ImportServiceRow[] = useMemo(() => {
    if (!preview) return [];
    const out: ImportServiceRow[] = [];
    preview.rows.forEach((r, i) => {
      if (!checked[i]) return;
      if (r.kind === "unchanged") return;
      if (r.kind === "unrecognized") {
        const m = modPick[i];
        if (!m) return;
        out.push({ name: r.row.name, modality: m, price: r.row.price, durationMin: r.row.durationMin, revive: false });
        return;
      }
      out.push({
        name: r.row.name,
        // ImportRow.modality тут завжди booking-модальність (unrecognized відсіяні вище).
        modality: r.row.modality as BookableMod,
        price: r.row.price,
        durationMin: r.row.durationMin,
        revive: r.kind === "inactive",
      });
    });
    return out;
  }, [preview, checked, modPick]);

  async function onApply() {
    if (!selectedRows.length) return;
    setErr(null);
    setStep("applying");
    try {
      const res = await importServices(selectedRows);
      if (!res.ok) { setErr(res.error); setStep("preview"); return; }
      const parts = [
        res.inserted ? `нових: ${res.inserted}` : null,
        res.updated ? `оновлено: ${res.updated}` : null,
        res.skippedInactive ? `пропущено вимкнених: ${res.skippedInactive}` : null,
      ].filter(Boolean);
      onDone("Імпорт застосовано" + (parts.length ? " (" + parts.join(", ") + ")" : ""));
    } catch {
      setErr("Не вдалося застосувати імпорт — спробуйте ще раз");
      setStep("preview");
    }
  }

  const rowLine = (i: number, extra?: React.ReactNode, disabled?: boolean) => {
    const r = preview!.rows[i];
    return (
      <label key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", borderBottom: "1px solid var(--border)", fontSize: 13.5, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.6 : 1 }}>
        <input type="checkbox" checked={!!checked[i]} disabled={disabled}
          onChange={(e) => setChecked((p) => ({ ...p, [i]: e.target.checked }))} />
        <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.row.name}>
          {r.row.name}
        </span>
        {r.row.modality && <span className="badge">{modalityLabel(r.row.modality)}</span>}
        {extra}
      </label>
    );
  };

  return (
    <div className="overlay">
      <div className="dialog fade-in" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Імпорт прайса"
        style={{ maxWidth: 720, width: "min(720px, 94vw)" }}>
        <div className="dlg-head">
          <div className="dlg-title">⇪ Імпорт прайса</div>
          <button className="icon-btn" onClick={safeClose} disabled={step === "applying"} aria-label="Закрити">✕</button>
        </div>

        <div className="dlg-body" style={{ maxHeight: "min(68vh, 640px)", overflowY: "auto" }}>
          {err && (
            <div style={{ color: "var(--red)", fontSize: 13.5, border: "1px solid var(--red)", borderRadius: 10, padding: "8px 12px" }} role="alert">
              {err}
            </div>
          )}

          {step === "pick" && (
            <div>
              <p className="dlg-text" style={{ marginBottom: 12 }}>
                Завантажте файл прайса <b>.xlsx</b> або <b>.csv</b> (до 4 МБ). Потрібні колонки
                «назва послуги» та «ціна»; «тривалість» і «модальність» — за наявності.
                Модальність без своєї колонки визначається за назвою (МРТ/КТ/УЗД/рентген/мамо…).
                Після розбору буде <b>передперегляд</b> — без підтвердження каталог не зміниться.
              </p>
              <input ref={fileRef} type="file" accept=".xlsx,.csv" style={{ display: "none" }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ""; }} />
              <button className="btn btn-primary" onClick={() => fileRef.current?.click()}>Обрати файл…</button>
              <p className="dlg-text" style={{ marginTop: 12, fontSize: 12.5, color: "var(--text-faint)" }}>
                pdf / doc / посилання на сайт — наступна фаза (AI-розбір).
              </p>
            </div>
          )}

          {step === "loading" && <p className="dlg-text">Розбираємо файл…</p>}

          {(step === "preview" || step === "applying") && preview && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                Розпізнано колонки: назва — «{preview.columns.name ?? "—"}», ціна — «{preview.columns.price ?? "—"}»
                {preview.columns.duration ? `, тривалість — «${preview.columns.duration}»` : ""}
                {preview.columns.modality ? `, модальність — «${preview.columns.modality}»` : ""}.
                {preview.skipped > 0 && <> Пропущено рядків без назви/ціни або дублів: <b>{preview.skipped}</b>.</>}
              </div>

              {preview.truncated && (
                <div style={{ color: "var(--orange)", fontSize: 12.5, border: "1px solid var(--orange)", borderRadius: 10, padding: "8px 12px" }} role="alert">
                  Файл завеликий — розібрано лише перші рядки. Розбийте прайс на кілька файлів,
                  щоб імпортувати решту.
                </div>
              )}

              {groups.changed.length > 0 && (
                <section>
                  <div style={{ fontWeight: 650, marginBottom: 4 }}>Зміна ціни/часу ({groups.changed.length})</div>
                  {groups.changed.map((i) => {
                    const r = preview.rows[i];
                    if (r.kind !== "changed") return null;
                    return rowLine(i, (
                      <span className="tabular" style={{ whiteSpace: "nowrap", fontSize: 12.5 }}>
                        {r.existing.price !== r.row.price && (
                          <>
                            <span style={{ color: "var(--text-faint)", textDecoration: "line-through" }}>{fmtUah(r.existing.price)}</span>
                            {" → "}<b>{fmtUah(r.row.price)}</b>
                          </>
                        )}
                        {r.row.durationMin != null && r.row.durationMin !== r.existing.duration_min && (
                          <span style={{ marginLeft: 8 }}>
                            <span style={{ color: "var(--text-faint)", textDecoration: "line-through" }}>{r.existing.duration_min} хв</span>
                            {" → "}<b>{r.row.durationMin} хв</b>
                          </span>
                        )}
                      </span>
                    ));
                  })}
                </section>
              )}

              {groups.news.length > 0 && (
                <section>
                  <div style={{ fontWeight: 650, marginBottom: 4 }}>Нові позиції ({groups.news.length})</div>
                  {groups.news.map((i) => {
                    const r = preview.rows[i];
                    return rowLine(i, (
                      <span className="tabular" style={{ whiteSpace: "nowrap", fontSize: 12.5 }}>
                        <b>{fmtUah(r.row.price)}</b>
                        <span style={{ color: "var(--text-faint)", marginLeft: 8 }}>{r.row.durationMin ?? 20} хв{r.row.durationMin == null ? " (типово)" : ""}</span>
                      </span>
                    ));
                  })}
                </section>
              )}

              {groups.inactive.length > 0 && (
                <section>
                  <div style={{ fontWeight: 650, marginBottom: 4 }}>
                    Вимкнені в каталозі ({groups.inactive.length})
                    <span style={{ fontWeight: 400, fontSize: 12.5, color: "var(--text-muted)", marginLeft: 8 }}>
                      позначте, щоб «оживити» з новою ціною — інакше не чіпаємо
                    </span>
                  </div>
                  {groups.inactive.map((i) => {
                    const r = preview.rows[i];
                    if (r.kind !== "inactive") return null;
                    return rowLine(i, (
                      <span className="tabular" style={{ whiteSpace: "nowrap", fontSize: 12.5 }}>
                        <b>{fmtUah(r.row.price)}</b>
                      </span>
                    ));
                  })}
                </section>
              )}

              {groups.unrecognized.length > 0 && (
                <section>
                  <div style={{ fontWeight: 650, marginBottom: 4 }}>
                    Нерозпізнана модальність ({groups.unrecognized.length})
                    <span style={{ fontWeight: 400, fontSize: 12.5, color: "var(--text-muted)", marginLeft: 8 }}>
                      оберіть модальність або залиште — такі рядки не імпортуються
                    </span>
                  </div>
                  {groups.unrecognized.map((i) => {
                    const r = preview.rows[i];
                    const m = modPick[i] ?? "";
                    return rowLine(i, (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <select className="inp" value={m} style={{ minWidth: 130 }}
                          onClick={(e) => e.preventDefault()}
                          onChange={(e) => {
                            const val = e.target.value as BookableMod | "";
                            setModPick((p) => ({ ...p, [i]: val }));
                            setChecked((p) => ({ ...p, [i]: !!val }));
                          }}>
                          <option value="">— модальність —</option>
                          {(BOOKABLE_MODALITIES as BookableMod[]).map((mm) => (
                            <option key={mm} value={mm}>{modalityLabel(mm)}</option>
                          ))}
                        </select>
                        <span className="tabular" style={{ fontSize: 12.5 }}><b>{fmtUah(r.row.price)}</b></span>
                      </span>
                    ), !m);
                  })}
                </section>
              )}

              {groups.unchanged > 0 && (
                <div style={{ fontSize: 12.5, color: "var(--text-faint)" }}>
                  Без змін (ціна й час збігаються з каталогом): {groups.unchanged}
                </div>
              )}

              {preview.rows.length === 0 && (
                <p className="dlg-text">
                  У файлі не знайшлося жодної позиції з назвою та ціною. Перевірте, що перший
                  рядок аркуша — заголовки колонок («Назва послуги», «Ціна, грн»…).
                </p>
              )}
            </div>
          )}
        </div>

        <div className="dlg-foot">
          <button className="btn btn-ghost" onClick={safeClose} disabled={step === "applying"}>Скасувати</button>
          {(step === "preview" || step === "applying") && preview && preview.rows.length > 0 && (
            <button className="btn btn-primary" disabled={step === "applying" || selectedRows.length === 0}
              aria-busy={step === "applying"} onClick={onApply}>
              {step === "applying" ? "Застосовуємо…" : `Застосувати (${selectedRows.length})`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
