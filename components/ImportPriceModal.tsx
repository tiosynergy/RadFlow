"use client";

/* ===== RadFlow — модалка «Імпорт прайса» (Stage 2, фази 3a+3b) =====
   Флоу: файл (.xlsx/.csv — детерміновано; .pdf/.docx — AI Grok) АБО
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
import {
  AI_CONF_MIN, importFileKind, isAiFileKind,
  IMPORT_ACCEPT_ATTR, IMPORT_ACCEPT_EXT_TEXT, IMPORT_FORMATS_HINT, IMPORT_MAX_FILE_BYTES,
  type ClassifiedRow, type DetectedColumns, type ImportFileKind,
} from "@/lib/priceImport";

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

/* Крок `loading` розділено надвоє (2026-07-29). Це не косметика: у двох фаз
   принципово різна природа, і зливати їх в одну «крутилку» — обманювати.
     uploading — байти летять на сервер. Прогрес ВІДОМИЙ, тож смужка визначена
                 (XMLHttpRequest.upload.onprogress; fetch такого не вміє — саме
                 тому тут XHR, а не fetch).
     parsing   — сервер + n8n + LLM. Прогрес НЕ відомий у принципі, тож смужка
                 невизначена, а поруч — лічильник часу й чесне очікування
                 («секунди» для таблиці, «1–3 хвилини» для AI). Малювати тут
                 відсотки означало б їх вигадати. */
type Step = "pick" | "uploading" | "parsing" | "preview" | "applying";
/** Модальності з формами запису (без OTHER) — тип збігається з ImportServiceRow.modality. */
type BookableMod = ImportServiceRow["modality"];

const fmtUah = (n: number) => n.toLocaleString("uk-UA") + " ₴";
/** Розмір файла людською мовою. КБ до мегабайта — щоб «0,0 МБ» не лякало. */
const fmtSize = (b: number) =>
  b < 1024 * 1024
    ? `${Math.max(1, Math.round(b / 1024))} КБ`
    : `${(b / 1024 / 1024).toFixed(1).replace(".", ",")} МБ`;
const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export default function ImportPriceModal({ onClose, onDone, roomModality, roomId }: Props) {
  const [step, setStep] = useState<Step>("pick");
  // Під час застосування закривати не можна (Esc/✕): імпорт на сервері завершиться,
  // а onDone/refresh — ні, і адмін бачитиме старий каталог (ревью L6).
  const stepRef = useRef(step);
  stepRef.current = step;
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const abort = () => { const x = xhrRef.current; xhrRef.current = null; x?.abort(); };
  const safeClose = () => {
    // Застосування — жорсткий блок: імпорт на сервері завершиться, а onDone/refresh — ні
    // (адмін бачив би старий каталог; ревью L6).
    if (stepRef.current === "applying") return;
    // Завантаження/розбір (файл/URL → Grok, до ~3 хв) — перепитуємо: закриття втратить
    // передперегляд і змарнує виклик AI. Гард від випадкового Esc / кліку повз модалку.
    if ((stepRef.current === "uploading" || stepRef.current === "parsing") &&
        !window.confirm("Розбір прайса ще триває. Закрити й скасувати перегляд?")) return;
    abort();
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

  /* Стан зони завантаження. `picked` живе окремо від `step`, бо чип із іменем
     файла має бути видимий і поки байти летять, і якщо розбір упав з помилкою —
     інакше після відмови користувач не бачить, ЯКИЙ саме файл не підійшов. */
  const [picked, setPicked] = useState<{ name: string; size: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [upFrac, setUpFrac] = useState(0);   // 0..1, реальні байти з XHR
  const [aiExpected, setAiExpected] = useState(false);
  const [elapsed, setElapsed] = useState(0); // секунди на кроці parsing

  // Лічильник часу розбору. Не прогрес — просто чесна відповідь на «воно живе?».
  useEffect(() => {
    if (step !== "parsing") return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [step]);

  /* Розмонтування (батько прибрав модалку) не повинно лишати запит у польоті:
     інакше `xhr.onload` спрацював би вже на знятому компоненті. Логіку повторюємо
     тут замість виклику `abort`, щоб замикання йшло лише на стабільний ref і не
     доводилось писати в ref під час рендера (React 19 це забороняє). */
  useEffect(() => () => { const x = xhrRef.current; xhrRef.current = null; x?.abort(); }, []);

  /** Перевірка ДО відправки: формат і розмір. Сервер перевіряє те саме (415/413)
      і лишається справжнім рубежем — але ганяти 4 МБ по мережі, щоб дізнатись
      «не той формат», безглуздо, а на повільному каналі ще й довго. */
  function rejectReason(file: File): string | null {
    if (!importFileKind(file.name)) {
      return `Формат не підтримується. ${IMPORT_FORMATS_HINT}.`;
    }
    if (file.size === 0) return "Файл порожній.";
    if (file.size > IMPORT_MAX_FILE_BYTES) {
      return `Файл завеликий — ${fmtSize(file.size)}. Ліміт 4 МБ.`;
    }
    return null;
  }

  function onPick(file: File | null) {
    if (!file) return;
    setPicked({ name: file.name, size: file.size });
    const bad = rejectReason(file);
    if (bad) { setErr(bad); setStep("pick"); return; }
    onUpload(file);
  }

  function onUpload(file: File | null, url?: string) {
    setErr(null);
    setUpFrac(0);
    setElapsed(0);
    const kind: ImportFileKind | null = file ? importFileKind(file.name) : null;
    setAiExpected(url ? true : !!kind && isAiFileKind(kind));
    // URL-режим нічого не вивантажує — одразу в розбір.
    setStep(file ? "uploading" : "parsing");

    const fd = new FormData();
    if (file) fd.append("file", file);
    if (url) fd.append("url", url);
    // 0121: у режимі кабінета превʼю рахує diff проти ВЛАСНИХ послуг кабінету
    // (той самий набір, що оновлює RPC) — інакше класифікація і optimistic-lock
    // зʼїхали б на базовий каталог, якого кабінетний імпорт не торкається.
    if (roomId) fd.append("room_id", roomId);

    /* XHR, а не fetch: `fetch` не повідомляє прогрес ВИВАНТАЖЕННЯ (ReadableStream
       на запиті в браузерах не працює як duplex), а саме він тут і потрібен —
       прайс до 4 МБ на мобільному каналі йде відчутно довго. */
    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open("POST", "/api/services/import");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) setUpFrac(e.loaded / e.total); };
    // Байти пішли — далі чекаємо на сервер: визначену смужку міняємо на невизначену.
    xhr.upload.onload = () => { setUpFrac(1); setStep("parsing"); };
    xhr.onabort = () => { xhrRef.current = null; };
    xhr.onerror = () => {
      xhrRef.current = null;
      // Транзієнтний збій мережі — не валимо модалку в overlay (канон try/catch).
      setErr("Не вдалося звʼязатися з сервером — спробуйте ще раз");
      setStep("pick");
    };
    xhr.onload = () => {
      xhrRef.current = null;
      let json: { ok?: boolean; error?: string; preview?: Preview } | null = null;
      try { json = JSON.parse(xhr.responseText); } catch { json = null; }
      if (xhr.status < 200 || xhr.status >= 300 || !json?.ok || !json.preview) {
        setErr(json?.error || "Не вдалося розібрати файл — додайте позиції вручну");
        setStep("pick");
        return;
      }
      applyPreview(json.preview);
    };
    xhr.send(fd);
  }

  function applyPreview(pv: Preview) {
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
            <div style={{ fontSize: "0.78125rem", color: "var(--text-secondary)", border: "1px solid var(--blue-line)", borderRadius: 10, padding: "8px 12px", background: "var(--blue-bg)" }}>
              🏥 Імпорт у кабінет — застосуються <b>лише позиції {modalityLabel(roomModality)}</b>:
              вони стануть <b>послугами саме цього кабінета</b> (його власний прайс).
              Базовий каталог центру не змінюється; інші модальності з прайса ігноруються.
            </div>
          )}

          {(step === "pick" || step === "uploading" || step === "parsing") && (
            <div className="imp-pick">
              {/* Довідка про формати — окремим блоком, а не абзацом у полотні тексту:
                  це те, що читають ПЕРЕД вибором файла, і саме через неї найчастіше
                  повертаються після відмови. Клас `.info-banner` уже є в проєкті
                  (колл-лист, послуги) — свій не заводимо. */}
              <div className="info-banner" role="note">
                <span className="ib-ic" aria-hidden="true">ⓘ</span>
                <span className="ib-txt">
                  <b>.xlsx</b> та <b>.csv</b> розбираються точно, як таблиця.
                  <b> .pdf</b> і <b>.docx</b> читає AI — перевірте результат у передперегляді.
                  Розмір — до <b>4 МБ</b>. Модальність визначається за назвою чи розділом
                  (МРТ/КТ/УЗД/рентген/мамо…).
                </span>
              </div>

              <input ref={fileRef} type="file" accept={IMPORT_ACCEPT_ATTR} style={{ display: "none" }}
                onChange={(e) => { onPick(e.target.files?.[0] ?? null); e.target.value = ""; }} />

              {/* Зона завантаження — саме <button>, а не div з onClick: так вона
                  фокусується з клавіатури, спрацьовує на Enter/Space і читається
                  скрінрідером як кнопка без жодного ARIA-милиця. Drag&drop —
                  надбудова для миші, не єдиний шлях.
                  ⚠️ `aria-disabled`, а НЕ `disabled`: користувач із клавіатури
                  активує зону, стоячи на ній фокусом, і справжній `disabled`
                  миттю викинув би фокус у <body> — усередині модалки з пасткою
                  фокусу це глухий кут. Клік у неробочому стані просто
                  ігноруємо. */}
              <button
                type="button"
                className={"imp-drop" + (dragOver ? " is-over" : "") + (step !== "pick" ? " is-busy" : "")}
                aria-disabled={step !== "pick"}
                onClick={() => { if (step === "pick") fileRef.current?.click(); }}
                onDragOver={(e) => { if (step !== "pick") return; e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  if (step !== "pick") return;
                  e.preventDefault();
                  setDragOver(false);
                  onPick(e.dataTransfer.files?.[0] ?? null);
                }}
              >
                {picked ? (
                  <>
                    <span className="imp-drop-name">{picked.name}</span>
                    <span className="imp-drop-sub">
                      {fmtSize(picked.size)}
                      {step === "uploading" && " · надсилаємо…"}
                      {step === "parsing" && " · розбираємо…"}
                      {step === "pick" && " · натисніть, щоб обрати інший"}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="imp-drop-ic" aria-hidden="true">⇪</span>
                    <span className="imp-drop-name">Перетягніть файл прайса сюди</span>
                    <span className="imp-drop-sub">або натисніть, щоб обрати · {IMPORT_ACCEPT_EXT_TEXT}</span>
                  </>
                )}
              </button>

              {/* Фаза 1: байти. Прогрес справжній, тож смужка визначена. */}
              {step === "uploading" && (
                <div className="imp-prog">
                  <div className="imp-prog-bar" role="progressbar" aria-label="Завантаження файла на сервер"
                    aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(upFrac * 100)}>
                    <span className="imp-prog-fill" style={{ width: `${Math.round(upFrac * 100)}%` }} />
                  </div>
                  <div className="imp-prog-row">
                    <span>Надсилаємо файл…</span>
                    <span className="tabular">{Math.round(upFrac * 100)}%</span>
                  </div>
                </div>
              )}

              {/* Фаза 2: сервер + n8n + LLM. Скільки лишилось — не знає ніхто, тож
                  смужка невизначена, а замість вигаданих відсотків показуємо
                  реальний час і чесне очікування. */}
              {step === "parsing" && (
                <div className="imp-prog">
                  <div className="imp-prog-bar is-indeterminate" role="progressbar"
                    aria-label="Розбір прайса" aria-valuemin={0} aria-valuemax={100}>
                    <span className="imp-prog-fill" />
                  </div>
                  {/* ⚠️ Лічильник часу — ПОЗА живою областю і з aria-hidden.
                      Інакше `aria-live` перечитував би весь рядок щосекунди, і
                      скрінрідер перетворився б на метроном на всі три хвилини
                      очікування. У живій області лишається тільки стадія: вона
                      змінюється двічі за весь розбір, і саме її варто почути.
                      Видимий таймер від цього нічого не втрачає — він для ока. */}
                  <div className="imp-prog-row">
                    <span role="status" aria-live="polite">
                      {aiExpected ? "Розбирає AI…" : "Розбираємо таблицю…"}
                      {" "}
                      <span className="imp-prog-hint">
                        {aiExpected
                          ? (elapsed > 180 ? "довше за звичайне — ще працюємо, не закривайте вікно" : "зазвичай 1–3 хвилини")
                          : (elapsed > 30 ? "довше за звичайне — ще працюємо" : "зазвичай кілька секунд")}
                      </span>
                    </span>
                    <span className="tabular" aria-hidden="true">{fmtClock(elapsed)}</span>
                  </div>
                </div>
              )}

              <div className="imp-url">
                <span className="imp-url-lab">або посилання на сторінку з прайсом:</span>
                <input className="inp" type="url" placeholder="https://clinic.ua/price" value={urlInput}
                  disabled={step !== "pick"}
                  onChange={(e) => setUrlInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && urlInput.trim() && step === "pick") onUpload(null, urlInput.trim()); }} />
                <button className="btn btn-secondary" disabled={!urlInput.trim() || step !== "pick"}
                  onClick={() => onUpload(null, urlInput.trim())}>Розібрати</button>
              </div>

              <p className="imp-foot-note">
                Після розбору буде <b>передперегляд</b> — без підтвердження каталог не зміниться.
              </p>
            </div>
          )}

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
