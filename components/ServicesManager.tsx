"use client";

/* ===== RadFlow — Каталог послуг клініки (/services, admin) =====
   Stage 2, фаза 1. Перелік / ціни / тривалості per-clinic у таблиці services
   (0107). Вкладки за модальністю, інлайн-редагування рядка, м'яке вимкнення,
   разовий сід із базового каталогу lib/studies.ts. Мутації — Server Actions
   (app/services/actions.ts, RLS admin-write як defense-in-depth).
   Фаза 2 підключить каталог у booking-флоу; фаза 3 — імпорт прайсів n8n+AI. */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import LiveClock from "@/components/LiveClock";
import ConfirmDialog from "@/components/ConfirmDialog";
import {
  createService, updateService, setServiceActive, deleteService,
  seedServicesFromCatalog, type ServiceInput,
} from "@/app/services/actions";
import { BOOKABLE_MODALITIES, CONTRAST_SURCHARGE, modalityLabel, modalityKind, type ModalityCode } from "@/lib/studies";
import { setClinicTz, wallToday0 } from "@/lib/incidents";
import type { Tables } from "@/supabase/types";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";

type ServiceRow = Tables<"services">;
type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null };

const WK = ["Неділя", "Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця", "Субота"];
const MON_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
function fmtFull(d: Date) { return WK[d.getDay()] + ", " + d.getDate() + " " + MON_GEN[d.getMonth()] + " " + d.getFullYear(); }

/* Чернетка рядка форми (create/edit) — рядкові значення інпутів, валідація zod на сервері. */
interface Draft { name: string; durationMin: string; price: string; contrastAllowed: boolean; contrastPrice: string; sortOrder: string }
const emptyDraft = (): Draft => ({ name: "", durationMin: "20", price: "0", contrastAllowed: false, contrastPrice: "", sortOrder: "0" });
const draftOf = (s: ServiceRow): Draft => ({
  name: s.name, durationMin: String(s.duration_min), price: String(s.price),
  contrastAllowed: s.contrast_allowed, contrastPrice: s.contrast_price != null ? String(s.contrast_price) : "",
  sortOrder: String(s.sort_order),
});
/* BOOKABLE_MODALITIES не містить OTHER — звужуємо тип до enum схеми. */
type BookableModality = ServiceInput["modality"];
function draftToInput(d: Draft, modality: BookableModality, active = true): ServiceInput {
  return {
    name: d.name.trim(), modality, durationMin: Number(d.durationMin) || 0, price: Number(d.price) || 0,
    contrastAllowed: d.contrastAllowed,
    contrastPrice: d.contrastAllowed && d.contrastPrice.trim() !== "" ? Number(d.contrastPrice) : null,
    active, sortOrder: Number(d.sortOrder) || 0,
  };
}

/* Поля рядка форми (спільні для «додати» і «редагувати»).
   ⚠️ МОДУЛЬНИЙ рівень навмисно: вкладена в компонент функція-компонент
   отримувала б нову ідентичність на кожен рендер → React перемонтовував би
   інпути → втрата фокуса після КОЖНОЇ клавіші (ревью B-1). */
function DraftFields({ d, setD }: { d: Draft; setD: (f: (p: Draft) => Draft) => void }) {
  return (
    <>
      <input className="inp" style={{ flex: "1 1 260px", minWidth: 200 }} placeholder="Назва послуги (область дослідження)"
        value={d.name} onChange={(e) => setD((p) => ({ ...p, name: e.target.value }))} />
      <label className="fld-lab" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        Тривалість
        <input className="inp" type="number" step={5} min={5} max={480} style={{ width: 76 }}
          value={d.durationMin} onChange={(e) => setD((p) => ({ ...p, durationMin: e.target.value }))} /> хв
      </label>
      <label className="fld-lab" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        Ціна
        <input className="inp" type="number" min={0} step={50} style={{ width: 96 }}
          value={d.price} onChange={(e) => setD((p) => ({ ...p, price: e.target.value }))} /> ₴
      </label>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, cursor: "pointer" }}>
        <input type="checkbox" checked={d.contrastAllowed}
          onChange={(e) => setD((p) => ({ ...p, contrastAllowed: e.target.checked }))} />
        Контраст
      </label>
      {d.contrastAllowed && (
        <label className="fld-lab" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          Доплата
          <input className="inp" type="number" min={0} step={50} style={{ width: 96 }}
            placeholder={String(CONTRAST_SURCHARGE)}
            value={d.contrastPrice} onChange={(e) => setD((p) => ({ ...p, contrastPrice: e.target.value }))} /> ₴
        </label>
      )}
    </>
  );
}

interface Props {
  clinicTz: string;
  initialServices: ServiceRow[];
  rooms?: RoomOpt[];
  clinicName?: string;
  adminName?: string;
}

export default function ServicesManager({ clinicTz, initialServices, rooms, clinicName, adminName }: Props) {
  if (typeof window !== "undefined") setClinicTz(clinicTz);
  const router = useRouter();

  const [items, setItems] = useState<ServiceRow[]>(initialServices);
  const [tab, setTab] = useState<ModalityCode>((BOOKABLE_MODALITIES[0] ?? "MRI") as ModalityCode);
  const [query, setQuery] = useState("");
  const [editId, setEditId] = useState<string | null>(null); // рядок у режимі редагування
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [addOpen, setAddOpen] = useState(false);
  const [addDraft, setAddDraft] = useState<Draft>(emptyDraft());
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState<ServiceRow | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);

  function notify(msg: string, type = "success") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }
  /* Після мутації перечитуємо SSR-проп (router.refresh) І оновлюємо локально —
     список маленький, realtime тут не потрібен (низькооборотна таблиця). */
  function refresh() { router.refresh(); }

  const byTab = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter((s) => s.modality === tab)
      .filter((s) => !q || s.name.toLowerCase().includes(q))
      .sort((a, b) => Number(b.active) - Number(a.active) || a.sort_order - b.sort_order || a.name.localeCompare(b.name, "uk"));
  }, [items, tab, query]);

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of items) m[s.modality] = (m[s.modality] || 0) + (s.active ? 1 : 0);
    return m;
  }, [items]);

  async function onSeed() {
    setBusy(true);
    try {
      const res = await seedServicesFromCatalog();
      if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
      notify(res.count ? "Додано " + res.count + " послуг із базового каталогу" : "Усі позиції базового каталогу вже додані", "success");
      refresh();
      // Локально не мержимо — SSR-проп повернеться повним списком.
    } finally { setBusy(false); }
  }

  async function onAdd() {
    setBusy(true);
    try {
      const res = await createService(draftToInput(addDraft, tab as BookableModality));
      if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
      notify("Послугу додано: " + addDraft.name.trim(), "success");
      setAddOpen(false); setAddDraft(emptyDraft());
      refresh();
    } finally { setBusy(false); }
  }

  async function onSaveEdit(s: ServiceRow) {
    setBusy(true);
    try {
      const res = await updateService(s.id, draftToInput(draft, s.modality as BookableModality, s.active));
      if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
      setItems((arr) => arr.map((x) => (x.id === s.id ? {
        ...x, name: draft.name.trim(), duration_min: Number(draft.durationMin) || x.duration_min,
        price: Number(draft.price) || 0, contrast_allowed: draft.contrastAllowed,
        contrast_price: draft.contrastAllowed && draft.contrastPrice.trim() !== "" ? Number(draft.contrastPrice) : null,
        sort_order: Number(draft.sortOrder) || 0,
      } : x)));
      setEditId(null);
      notify("Збережено", "success");
      refresh();
    } finally { setBusy(false); }
  }

  async function onToggleActive(s: ServiceRow) {
    setBusy(true);
    try {
      const res = await setServiceActive(s.id, !s.active);
      if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
      setItems((arr) => arr.map((x) => (x.id === s.id ? { ...x, active: !s.active } : x)));
      notify(!s.active ? "Послугу увімкнено" : "Послугу вимкнено (лишається в історії)", "info");
      refresh();
    } finally { setBusy(false); }
  }

  async function onDelete(s: ServiceRow) {
    setBusy(true);
    try {
      const res = await deleteService(s.id);
      if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
      setItems((arr) => arr.filter((x) => x.id !== s.id));
      notify("Послугу видалено", "info");
      refresh();
    } finally { setBusy(false); }
  }

  return (
    <div className="app">
      <Sidebar clinicName={clinicName} adminName={adminName} adminRole="Адміністратор" roleKey="admin"
        rooms={rooms} activeNav="services" />
      <div className="main">
        <header className="topbar">
          <div className="tb-title">
            <span className="tic">₴</span>
            <div>
              <h1>Послуги та ціни</h1>
              <div className="date">{fmtFull(wallToday0(clinicTz))} · <LiveClock tz={clinicTz} /></div>
            </div>
          </div>
          <div className="tb-right">
            <button className="btn btn-secondary" disabled={busy} onClick={onSeed}
              title="Разово наповнити каталог позиціями з базового довідника (наявні назви пропускаються)">
              ⤓ Заповнити з базового каталогу
            </button>
            <button className="btn btn-primary" disabled={busy} onClick={() => { setAddDraft(emptyDraft()); setAddOpen(true); }}>
              ＋ Додати послугу
            </button>
          </div>
        </header>
        <div className="content-full">
          <div className="page-max">
            <div className="info-banner">
              <span className="ib-ic" aria-hidden="true">₴</span>
              <span className="ib-txt">
                <b>Каталог послуг центру</b> — перелік, тривалості та ціни для кожної модальності.
                Наразі форми запису використовують базовий довідник; підключення цього каталогу до
                запису/листа — наступний крок (Stage 2). Вимкнена послуга зникає з форм, але
                лишається в історії записів.
              </span>
            </div>

            <div className="qctrl">
              <div className="pills">
                {(BOOKABLE_MODALITIES as ModalityCode[]).map((m) => (
                  <button key={m} className={"pill" + (tab === m ? " active" : "")} onClick={() => { setTab(m); setEditId(null); }}>
                    {modalityLabel(m)}<span className="ct">({counts[m] || 0})</span>
                  </button>
                ))}
              </div>
              <div className="spacer" />
              <div className="search"><span className="si">⌕</span>
                <input placeholder="Пошук послуги…" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
            </div>

            {addOpen && (
              <div className="cl-detail" style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
                  <span className={"wl-mod " + modalityKind(tab)}>{modalityLabel(tab)}</span>
                  <DraftFields d={addDraft} setD={setAddDraft} />
                  <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
                    <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setAddOpen(false)}>Скасувати</button>
                    <button className="btn btn-primary btn-sm" disabled={busy || addDraft.name.trim().length < 2} onClick={onAdd}>Зберегти</button>
                  </span>
                </div>
              </div>
            )}

            <div className="wlhead" style={{ gridTemplateColumns: "minmax(220px,2fr) 110px 110px 140px 90px minmax(180px,1fr)" }}>
              <div>Послуга</div><div>Тривалість</div><div>Ціна</div><div>Контраст</div><div>Стан</div><div style={{ textAlign: "right" }}>Дії</div>
            </div>

            {byTab.length === 0 ? (
              <div className="empty"><div className="ei">₴</div><div className="et">У модальності {modalityLabel(tab)} поки немає послуг</div>
                <div className="es">Додайте вручну або натисніть «Заповнити з базового каталогу»</div></div>
            ) : (
              <div className="clrows">
                {byTab.map((s) => {
                  const editing = editId === s.id;
                  return (
                    <div className="clrow-wrap" key={s.id}>
                      <div className="wlrow" style={{ gridTemplateColumns: "minmax(220px,2fr) 110px 110px 140px 90px minmax(180px,1fr)", opacity: s.active ? 1 : 0.55 }}>
                        {editing ? (
                          <div style={{ gridColumn: "1 / -1", display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", padding: "4px 0" }}>
                            <DraftFields d={draft} setD={setDraft} />
                            <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
                              <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setEditId(null)}>Скасувати</button>
                              <button className="btn btn-primary btn-sm" disabled={busy || draft.name.trim().length < 2} onClick={() => onSaveEdit(s)}>Зберегти</button>
                            </span>
                          </div>
                        ) : (
                          <>
                            <div style={{ fontWeight: 600 }}>{s.name}
                              {s.source === "import" && <span className="badge" style={{ marginLeft: 8 }} title="Завантажено імпортом прайса">імпорт</span>}
                            </div>
                            <div className="tabular">{s.duration_min} хв</div>
                            <div className="tabular">{s.price ? s.price.toLocaleString("uk-UA") + " ₴" : <span style={{ color: "var(--orange)" }} title="Ціну ще не задано">0 ₴</span>}</div>
                            <div>{s.contrast_allowed
                              ? <span title="Доплата за контраст">＋ {(s.contrast_price ?? CONTRAST_SURCHARGE).toLocaleString("uk-UA")} ₴</span>
                              : <span style={{ color: "var(--text-faint)" }}>—</span>}</div>
                            <div>{s.active ? <span style={{ color: "var(--green)" }}>активна</span> : <span style={{ color: "var(--text-faint)" }}>вимкнена</span>}</div>
                            <div className="cl-actions">
                              <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { setEditId(s.id); setDraft(draftOf(s)); }}>✎</button>
                              <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onToggleActive(s)}
                                title={s.active ? "Вимкнути (прибрати з форм, лишити в історії)" : "Увімкнути"}>{s.active ? "⏻ Вимкнути" : "⏻ Увімкнути"}</button>
                              <button className="btn btn-secondary btn-sm" style={{ color: "var(--red)" }} disabled={busy} onClick={() => setConfirmDel(s)} aria-label={"Видалити " + s.name}>✕</button>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {confirmDel && (
        <ConfirmDialog title="Видалити послугу"
          text={<>Видалити <b style={{ color: "var(--text)" }}>{confirmDel.name}</b> назовсім? Якщо послуга ще може знадобитись — краще «Вимкнути».</>}
          confirmLabel="Видалити" danger busy={busy}
          onConfirm={async () => { const s = confirmDel; setConfirmDel(null); await onDelete(s); }}
          onClose={() => setConfirmDel(null)} />
      )}

      <div role="status" aria-live="polite">
        {toast && (
          <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "var(--card)", border: "1px solid var(--border-strong)", borderLeft: "4px solid " + (toast.type === "error" ? "var(--red)" : "var(--green)"), borderRadius: 12, padding: "12px 18px", boxShadow: "var(--shadow-pop)", zIndex: 50, fontSize: 13.5 }}>
            {toast.msg}
          </div>
        )}
      </div>
    </div>
  );
}
