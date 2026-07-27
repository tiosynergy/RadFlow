"use client";

/* ===== RadFlow — модалка «Імпорт прайса» (Stage 2, фази 3a+3b) =====
   Флоу: файл (.xlsx/.csv — детерміновано; .pdf/.docx/фото — AI Grok) АБО
   https-посилання на прайс → POST /api/services/import (n8n парсить, сервер
   нормалізує/класифікує) → передперегляд по групах: «Зміна ціни/часу» / «Нові» /
   «Вимкнені (оживити?)» / «Нерозпізнані» (адмін обирає модальність) / «Без змін»
   → підтвердження → Server Action importServices → services_import_rpc (0115).

   Правила відображення = правила RPC: вимкнена позиція чіпається лише з
   галочкою «оживити»; тривалість оновлюється лише коли була в прайсі.
   3b: AI-рядки з confidence < порога сервер кладе в «Нерозпізнані» — тут
   модальність від AI підставляється в селект як пропозиція, рішення за адміном. */

import { useEffect, useMemo, useRef, useState } from "react";
import { useModalA11y } from "@/lib/useModalA11y";
import { importServices, type ImportServiceRow } from "@/app/services/actions";
import { BOOKABLE_MODALITIES, modalityLabel, normDur } from "@/lib/studies";
import { AI_CONF_MIN, type ClassifiedRow, type DetectedColumns } from "@/lib/priceImport";

interface Preview {
  rows: ClassifiedRow[];
  skipped: number;
  columns: DetectedColumns;
  totalRaw: number;
  truncated?: boolean; // файл більший за ліміт розбору — частина рядків не потрапила
  ai?: boolean;        // 3b: розібрано AI (Grok) — перевіряти уважніше
}

interface Props {
  onClose: () => void;
  /** Викликається ПІСЛЯ успішного імпорту (батько робить notify + refresh). */
  onDone: (msg: string) => void;
  /** 0120: якщо задано — імпорт У КАБІНЕТ (база + переозначення) лише цієї модальності. */
  roomModality?: ImportServiceRow["modality"];
  /** 0120: id кабінета для переозначень (обовʼязковий разом із roomModality). */
  roomId?: string;
}

type Step = "pick" | "loading" | "preview" | "applying";
/** Модальності з формами запису (без OTHER) — тип збігається з ImportServiceRow.modality. */
type BookableMod = ImportServiceRow["modality"];

const fmtUah = (n: number) => n.toLocaleString("uk-UA") + " ₴";

export default function ImportPriceModal({ onClose, onDone, roomModality, roomId }: Props) {
  const [step, setStep] = useState<Step>("pick");
  // Під час застосування закривати не можна (Esc/✕): імпорт на сервері завершиться,
  // а onDone/refresh — ні, і адмін бачитиме старий каталог (ревью L6).
  const stepRef = useRef(step);
  stepRef.current = step;
  const safeClose = () => {
    // Застосування — жорсткий блок: імпорт на сервері завершиться, а onDone/refresh — ні
    // (адмін бачив би старий каталог; ревью L6).
    if (stepRef.current === "applying") return;
    // Розбір (файл/URL → Grok, до ~3 хв) — перепитуємо: закриття втратить передперегляд
    // і змарнує виклик AI. Гард від випадкового Esc / кліку повз модалку під час очікування.
    if (stepRef.current === "loading" &&
        !window.confirm("Розбір прайса ще триває. Закрити й скасувати перегляд?")) return;
    onClose();
  };
  const dialogRef = useModalA11y<HTMLDivElement>(safeClose);
  const fileRef = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  // Вибір рядків: ключ = індекс у preview.rows. changed/new — увімкнені за
  // замовчуванням; inactive (оживити) — вимкнені; unrecognized — вимкнені, поки
  // не обрано модальність (modPick).
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [modPick, setModPick] = useState<Record<number, BookableMod | "">>({});
  // Ручна тривалість для нових/нерозпізнаних позицій: у прайсах час зазвичай
  // НЕ вказано (рішення власника 2026-07-20 — вводиться тут, у передперегляді).
  // Порожньо → значення з файла; якщо і його немає — час лишиться «—» (NULL, 0117).
  const [durPick, setDurPick] = useState<Record<number, string>>({});
  const pickedDur = (i: number, fileDur: number | null): number | null => {
    const raw = (durPick[i] ?? "").trim();
    if (raw === "") return fileDur;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? normDur(n) : fileDur;
  };

  // 3b: режим «посилання на прайс» (https-сторінка центру → n8n → Grok).
  const [urlInput, setUrlInput] = useState("");

  async function onUpload(file: File | null, url?: string) {
    setErr(null);
    setStep("loading");
    try {
      const fd = new FormData();
      if (file) fd.append("file", file);
      if (url) fd.append("url", url);
      // 0121: у режимі кабінета превʼю рахує diff проти ВЛАСНИХ послуг кабінету
      // (той самий набір, що оновлює RPC) — інакше класифікація і optimistic-lock
      // зʼїхали б на базовий каталог, якого кабінетний імпорт не торкається.
      if (roomId) fd.append("room_id", roomId);
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
        // Нові (в т.ч. без ціни — рішення власника: скелет каталогу теж імпортується)
        // і зміни — увімкнені одразу; вимкнені/нерозпізнані — свідомий вибір адміна.
        // 3b (ревʼю M3): AI-розбір НЕ пред-відмічається — зловмисний прайс міг би
        // підсунути 200 правдоподібних «змін цін» під один клік «Застосувати».
        // Для AI кожен рядок (або «Відмітити всі») — свідомий вибір адміна.
        // 0121 (ревю Ф3 №2): у режимі кабінета чужа модальність не пред-відмічається —
        // вона однаково відкидається при застосуванні (баннер «ігноруються»).
        if (roomModality && r.row.modality && r.row.modality !== roomModality) return;
        if (!pv.ai && (r.kind === "new" || r.kind === "changed")) init[i] = true;
      });
      setChecked(init);
      setModPick({});
      setDurPick({}); // ревю Ф3 №1: ручні тривалості привʼязані до індексів СТАРОГО превʼю
      setPreview(pv);
      setStep("preview");
    } catch {
      // Транзієнтний збій мережі — не валимо модалку в overlay (канон try/catch).
      setErr("Не вдалося звʼязатися з сервером — спробуйте ще раз");
      setStep("pick");
    }
  }

  const groups = useMemo(() => {
    const g = { changed: [] as number[], news: [] as number[], newsNoPrice: [] as number[], inactive: [] as number[], unrecognized: [] as number[], unchanged: 0 };
    preview?.rows.forEach((r, i) => {
      if (r.kind === "changed") g.changed.push(i);
      else if (r.kind === "new") (r.row.price == null ? g.newsNoPrice : g.news).push(i);
      else if (r.kind === "inactive") g.inactive.push(i);
      else if (r.kind === "unrecognized") g.unrecognized.push(i);
      else g.unchanged++;
    });
    return g;
  }, [preview]);

  // 0120: у режимі кабінета нерозпізнаним рядкам одразу проставляємо модальність кабінета —
  // тоді вони стають вибірними й імпортуються без ручного вибору (модальність кабінета відома).
  useEffect(() => {
    if (!roomModality || !preview) return;
    setModPick((p) => {
      const next = { ...p };
      preview.rows.forEach((r, i) => { if (r.kind === "unrecognized" && next[i] == null) next[i] = roomModality; });
      return next;
    });
  }, [roomModality, preview]);

  /* Майстер-чекбокс «Усі»: рядки, які МОЖНА ввімкнути (все, крім «без змін»
     і нерозпізнаних без обраної модальності — тим спершу обирають модальність). */
  const selectableIdx = useMemo(() => {
    if (!preview) return [] as number[];
    const out: number[] = [];
    preview.rows.forEach((r, i) => {
      if (r.kind === "unchanged") return;
      if (r.kind === "unrecognized" && !modPick[i]) return;
      // 0121 (ревю Ф3 №2): чужа модальність у режимі кабінета не вибирається —
      // інакше лічильник «вибрано X із Y» рахував би рядки, які не застосуються.
      if (roomModality && r.kind !== "unrecognized" && r.row.modality && r.row.modality !== roomModality) return;
      out.push(i);
    });
    return out;
  }, [preview, modPick, roomModality]);
  const checkedCount = selectableIdx.reduce((n, i) => n + (checked[i] ? 1 : 0), 0);
  const allChecked = selectableIdx.length > 0 && checkedCount === selectableIdx.length;
  function toggleAll() {
    const target = !allChecked;
    setChecked((p) => {
      const next = { ...p };
      selectableIdx.forEach((i) => { next[i] = target; });
      return next;
    });
  }

  const selectedRows: ImportServiceRow[] = useMemo(() => {
    if (!preview) return [];
    const out: ImportServiceRow[] = [];
    preview.rows.forEach((r, i) => {
      if (!checked[i]) return;
      if (r.kind === "unchanged") return;
      if (r.kind === "unrecognized") {
        // 3b: модальність від AI — лише пропозиція в селекті; без явного вибору
        // (modPick) рядок не імпортується (чекбокс вмикається разом із вибором).
        const m = modPick[i];
        if (!m) return;
        // 0120: у режимі кабінета застосовуємо ЛИШЕ його модальність.
        if (roomModality && m !== roomModality) return;
        out.push({ name: r.row.name, modality: m, price: r.row.price, durationMin: pickedDur(i, r.row.durationMin), revive: false });
        return;
      }
      // 0120: у режимі кабінета відкидаємо чужу модальність (RPC теж фільтрує — це UI-рубіж).
      if (roomModality && (r.row.modality as BookableMod) !== roomModality) return;
      out.push({
        name: r.row.name,
        // ImportRow.modality тут завжди booking-модальність (unrecognized відсіяні вище).
        modality: r.row.modality as BookableMod,
        price: r.row.price,
        // Ручний час із передперегляду (для нових); інакше — з файла.
        durationMin: pickedDur(i, r.row.durationMin),
        revive: r.kind === "inactive",
        // 0119: версія існуючої позиції (changed/inactive) для optimistic-lock;
        // нові — без версії, але з isNew (RPC конфліктує, лише якщо активна вже зʼявилась).
        expectedUpdatedAt: "existing" in r ? r.existing.updated_at : null,
        isNew: r.kind === "new",
      });
    });
    return out;
  }, [preview, checked, modPick, durPick, roomModality]); // eslint-disable-line react-hooks/exhaustive-deps -- pickedDur читає durPick

  async function onApply() {
    if (!selectedRows.length) return;
    setErr(null);
    setStep("applying");
    try {
      const res = await importServices(selectedRows, roomId);
      if (!res.ok) {
        // 0119: каталог змінився під час перегляду — імпорт нічого не застосував.
        // Повертаємо на крок вибору файла/посилання, щоб адмін перезчитав актуальний
        // каталог (передперегляд застарів; повторне застосування без цього — той самий lost-update).
        if (res.code === "stale") {
          const names = (res.conflicts ?? []).slice(0, 8).join(", ");
          setErr(res.error + (names ? `. Змінилися: ${names}${(res.conflicts?.length ?? 0) > 8 ? "…" : ""}` : ""));
          setPreview(null);
          setChecked({});
          setModPick({});
          setDurPick({}); // ревю Ф3 №1: інакше тривалості прилипнуть до нового превʼю
          setStep("pick");
          return;
        }
        setErr(res.error);
        setStep("preview");
        return;
      }
      // 0121: room-режим RPC пише ТІЛЬКИ власні послуги кабінета (ключ overrides
      // завжди 0 — мертву гілку прибрано, ревю Ф3 №4); формулювання це відбиває.
      const parts = [
        res.inserted ? (roomId ? `нових у кабінеті: ${res.inserted}` : `нових: ${res.inserted}`) : null,
        res.updated ? (roomId ? `оновлено в кабінеті: ${res.updated}` : `оновлено: ${res.updated}`) : null,
        res.skippedInactive ? `пропущено вимкнених: ${res.skippedInactive}` : null,
        res.noop ? `без змін: ${res.noop}` : null,
      ].filter(Boolean);
      onDone("Імпорт застосовано" + (parts.length ? " (" + parts.join(", ") + ")" : ""));
    } catch {
      setErr("Не вдалося застосувати імпорт — спробуйте ще раз");
      setStep("preview");
    }
  }

  // A11y/мобільні (ревʼю): інтерактивні контроли (`extra` — select / поле часу) живуть
  // ПОЗА <label>, який зв'язує лише чекбокс + назву. Раніше все було в одному <label>, і
  // клік по select/інпуту довелося глушити preventDefault — а на тачі це блокувало відкриття
  // нативного пікера select. Тепер label — тільки для чекбокса; extra не тригерить чекбокс,
  // preventDefault не потрібен. Клік по назві перемикає рядок, як і раніше.
  const rowLine = (i: number, extra?: React.ReactNode, disabled?: boolean) => {
    const r = preview!.rows[i];
    return (
      <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", borderBottom: "1px solid var(--border)", fontSize: "0.84375rem", opacity: disabled ? 0.6 : 1 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 10, flex: "1 1 auto", minWidth: 0, cursor: disabled ? "default" : "pointer" }}>
          <input type="checkbox" checked={!!checked[i]} disabled={disabled}
            onChange={(e) => setChecked((p) => ({ ...p, [i]: e.target.checked }))} />
          <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.row.name}>
            {r.row.name}
          </span>
          {r.row.modality && <span className="badge">{modalityLabel(r.row.modality)}</span>}
        </label>
        {extra}
      </div>
    );
  };

  // Інпут ручної тривалості (у прайсах час зазвичай відсутній). Живе ПОЗА <label>
  // рядка (див. rowLine) — тому preventDefault на кліку більше не потрібен.
  const durInput = (i: number, fileDur: number | null) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: "0.78125rem", color: "var(--text-muted)" }}>
      <input className="inp" type="number" step={5} min={5} max={480} style={{ width: 64 }}
        placeholder={fileDur != null ? String(fileDur) : "—"} value={durPick[i] ?? ""}
        onChange={(e) => setDurPick((p) => ({ ...p, [i]: e.target.value }))}
        aria-label="Тривалість, хв" />
      хв
    </span>
  );

  return (
    <div className="overlay">
      <div className="dialog fade-in" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Імпорт прайса"
        style={{ maxWidth: 720, width: "min(720px, 94vw)", maxHeight: "90vh", display: "flex", flexDirection: "column" }}>
        <div className="dlg-head">
          <div className="dlg-title">⇪ Імпорт прайса</div>
          <button className="icon-btn" onClick={safeClose} disabled={step === "applying"} aria-label="Закрити">✕</button>
        </div>

        <div className="dlg-body" style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto" }}>
          {err && (
            <div style={{ color: "var(--red)", fontSize: "0.84375rem", border: "1px solid var(--red)", borderRadius: 10, padding: "8px 12px" }} role="alert">
              {err}
            </div>
          )}

          {roomModality && (
            <div style={{ fontSize: "0.78125rem", color: "var(--text-secondary)", border: "1px solid var(--blue)", borderRadius: 10, padding: "8px 12px", background: "var(--blue-bg)" }}>
              🏥 Імпорт у кабінет — застосуються <b>лише позиції {modalityLabel(roomModality)}</b>:
              вони стануть <b>послугами саме цього кабінета</b> (його власний прайс).
              Базовий каталог центру не змінюється; інші модальності з прайса ігноруються.
            </div>
          )}

          {step === "pick" && (
            <div>
              <p className="dlg-text" style={{ marginBottom: 12 }}>
                Завантажте файл прайса (до 4 МБ): <b>.xlsx</b> / <b>.csv</b> — точний розбір таблиці;
                <b> .pdf</b> / <b>.docx</b> / <b>фото прайса</b> (.jpg/.png) — AI-розбір.
                Модальність визначається за назвою чи розділом (МРТ/КТ/УЗД/рентген/мамо…).
                Після розбору буде <b>передперегляд</b> — без підтвердження каталог не зміниться.
              </p>
              <input ref={fileRef} type="file" accept=".xlsx,.csv,.pdf,.docx,.jpg,.jpeg,.png,.webp" style={{ display: "none" }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ""; }} />
              <button className="btn btn-primary" onClick={() => fileRef.current?.click()}>Обрати файл…</button>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                <span style={{ fontSize: "0.78125rem", color: "var(--text-muted)" }}>або посилання на сторінку з прайсом:</span>
                <input className="inp" type="url" placeholder="https://clinic.ua/price" value={urlInput}
                  style={{ flex: "1 1 220px", minWidth: 200 }}
                  onChange={(e) => setUrlInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && urlInput.trim()) onUpload(null, urlInput.trim()); }} />
                <button className="btn btn-secondary" disabled={!urlInput.trim()}
                  onClick={() => onUpload(null, urlInput.trim())}>Розібрати</button>
              </div>
            </div>
          )}

          {step === "loading" && <p className="dlg-text">Розбираємо прайс… Для pdf/фото/docx/посилання працює AI — великий прайс може зайняти 1–3 хвилини, не закривайте вікно.</p>}

          {(step === "preview" || step === "applying") && preview && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {preview.ai ? (
                <div style={{ fontSize: "0.78125rem", color: "var(--text-muted)", border: "1px solid var(--border-strong)", borderRadius: 10, padding: "8px 12px" }}>
                  🤖 Розібрано <b>AI</b> — рядки НЕ відмічені: перевірте назви й ціни та
                  відмітьте потрібні (модель могла помилитися); «Усі» нижче вмикає все разом.
                  Невпевнені — у «Нерозпізнаних».
                  {preview.skipped > 0 && <> Відкинуто рядків: <b>{preview.skipped}</b>.</>}
                </div>
              ) : (
                <div style={{ fontSize: "0.78125rem", color: "var(--text-muted)" }}>
                  Розпізнано колонки: назва — «{preview.columns.name ?? "—"}», ціна — «{preview.columns.price ?? "—"}»
                  {preview.columns.duration ? `, тривалість — «${preview.columns.duration}»` : ""}
                  {preview.columns.modality ? `, модальність — «${preview.columns.modality}»` : ""}.
                  {preview.skipped > 0 && <> Пропущено рядків без назви/ціни або дублів: <b>{preview.skipped}</b>.</>}
                </div>
              )}

              {preview.truncated && (
                <div style={{ color: "var(--orange)", fontSize: "0.78125rem", border: "1px solid var(--orange)", borderRadius: 10, padding: "8px 12px" }} role="alert">
                  Файл завеликий — розібрано лише перші рядки. Розбийте прайс на кілька файлів,
                  щоб імпортувати решту.
                </div>
              )}

              {/* Майстер-чекбокс: увімкнути/зняти ВСІ рядки разом. Не чіпає «без змін»
                  і нерозпізнані без модальності (тим спершу обирають модальність). */}
              {selectableIdx.length > 0 && (
                <label style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 8px", borderBottom: "2px solid var(--border-strong)", fontSize: "0.84375rem", fontWeight: 650, cursor: "pointer", position: "sticky", top: 0, background: "var(--card)", zIndex: 1 }}>
                  <input type="checkbox" checked={allChecked} disabled={step === "applying"}
                    ref={(el) => { if (el) el.indeterminate = checkedCount > 0 && !allChecked; }}
                    onChange={toggleAll} aria-label="Відмітити всі позиції" />
                  <span>Усі</span>
                  <span style={{ fontWeight: 400, fontSize: "0.78125rem", color: "var(--text-muted)" }}>
                    вибрано {checkedCount} із {selectableIdx.length}
                    {groups.unrecognized.some((i) => !modPick[i]) ? " · нерозпізнані без модальності не вмикаються" : ""}
                  </span>
                </label>
              )}

              {groups.changed.length > 0 && (
                <section>
                  <div style={{ fontWeight: 650, marginBottom: 4 }}>Зміна ціни/часу ({groups.changed.length})</div>
                  {groups.changed.map((i) => {
                    const r = preview.rows[i];
                    if (r.kind !== "changed") return null;
                    return rowLine(i, (
                      <span className="tabular" style={{ whiteSpace: "nowrap", fontSize: "0.78125rem" }}>
                        {r.row.price != null && r.existing.price !== r.row.price && (
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
                      <span className="tabular" style={{ whiteSpace: "nowrap", fontSize: "0.78125rem", display: "inline-flex", alignItems: "center", gap: 10 }}>
                        <b>{fmtUah(r.row.price ?? 0)}</b>
                        {durInput(i, r.row.durationMin)}
                      </span>
                    ));
                  })}
                </section>
              )}

              {groups.newsNoPrice.length > 0 && (
                <section>
                  <div style={{ fontWeight: 650, marginBottom: 4 }}>
                    Нові без ціни ({groups.newsNoPrice.length})
                    <span style={{ fontWeight: 400, fontSize: "0.78125rem", color: "var(--text-muted)", marginLeft: 8 }}>
                      ціна/час без значення = «—» у каталозі; заповніть тут або пізніше
                    </span>
                  </div>
                  {groups.newsNoPrice.map((i) => {
                    const r = preview.rows[i];
                    return rowLine(i, (
                      <span className="tabular" style={{ whiteSpace: "nowrap", fontSize: "0.78125rem", display: "inline-flex", alignItems: "center", gap: 10 }}>
                        <span style={{ color: "var(--orange)" }}>— ₴</span>
                        {durInput(i, r.row.durationMin)}
                      </span>
                    ));
                  })}
                </section>
              )}

              {groups.inactive.length > 0 && (
                <section>
                  <div style={{ fontWeight: 650, marginBottom: 4 }}>
                    Вимкнені в каталозі ({groups.inactive.length})
                    <span style={{ fontWeight: 400, fontSize: "0.78125rem", color: "var(--text-muted)", marginLeft: 8 }}>
                      позначте, щоб «оживити» з новою ціною — інакше не чіпаємо
                    </span>
                  </div>
                  {groups.inactive.map((i) => {
                    const r = preview.rows[i];
                    if (r.kind !== "inactive") return null;
                    return rowLine(i, (
                      <span className="tabular" style={{ whiteSpace: "nowrap", fontSize: "0.78125rem" }}>
                        {r.row.price != null ? <b>{fmtUah(r.row.price)}</b> : <span style={{ color: "var(--text-faint)" }}>ціна лишиться</span>}
                      </span>
                    ));
                  })}
                </section>
              )}

              {groups.unrecognized.length > 0 && (
                <section>
                  <div style={{ fontWeight: 650, marginBottom: 4 }}>
                    Нерозпізнана модальність ({groups.unrecognized.length})
                    <span style={{ fontWeight: 400, fontSize: "0.78125rem", color: "var(--text-muted)", marginLeft: 8 }}>
                      оберіть модальність або залиште — такі рядки не імпортуються
                    </span>
                  </div>
                  {groups.unrecognized.map((i) => {
                    const r = preview.rows[i];
                    const m = modPick[i] ?? "";
                    // 3b: AI запропонував модальність, але не впевнений — показуємо
                    // пропозицію і % впевненості; вибір лишається за адміном.
                    const aiHint = preview.ai && r.row.modality ? modalityLabel(r.row.modality) : null;
                    const lowConf = preview.ai && r.row.confidence < AI_CONF_MIN;
                    return rowLine(i, (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        {lowConf && (
                          <span title={"AI впевнений на " + Math.round(r.row.confidence * 100) + "%" + (aiHint ? " · пропозиція: " + aiHint : "")}
                            style={{ fontSize: "0.71875rem", color: "var(--orange)", whiteSpace: "nowrap" }}>
                            ⚠ {Math.round(r.row.confidence * 100)}%{aiHint ? " · " + aiHint + "?" : ""}
                          </span>
                        )}
                        <select className="inp" value={m} style={{ minWidth: 130 }}
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
                        <span className="tabular" style={{ fontSize: "0.78125rem" }}>
                          {r.row.price != null ? <b>{fmtUah(r.row.price)}</b> : <span style={{ color: "var(--orange)" }}>— ₴</span>}
                        </span>
                        {durInput(i, r.row.durationMin)}
                      </span>
                    ), !m);
                  })}
                </section>
              )}

              {groups.unchanged > 0 && (
                <div style={{ fontSize: "0.78125rem", color: "var(--text-faint)" }}>
                  Без змін (ціна й час збігаються з каталогом): {groups.unchanged}
                </div>
              )}

              {preview.rows.length === 0 && (
                <p className="dlg-text">
                  {preview.columns.name && preview.columns.price ? (
                    <>Колонки розпізнано, але жоден рядок не пройшов розбір (порожні
                    назви, дублі або заголовки розділів). Перевірте вміст колонки
                    «{preview.columns.name}».</>
                  ) : (
                    <>У файлі не знайшлося таблиці з назвою та ціною. Перевірте, що на
                    аркуші є рядок заголовків («Назва послуги», «Ціна, грн»…).</>
                  )}
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
