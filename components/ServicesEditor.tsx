"use client";

/* ===== RadFlow — Редактор каталогу послуг (Stage 2, фаза 2b) =====
   Ядро редактора, спільне для сторінки /services (ServicesManager) і кроку
   Майстра налаштувань «Послуги та прайс» (embedded). Два режими (селектор зверху):

   • «Базовий каталог центру» — перелік/тривалості/ціни на модальність (services,
     0107): додати/редагувати/увімк-вимк/видалити + сід із базового довідника.
   • «Кабінет N» — переозначення каталогу ПО КАБІНЕТУ (service_room_overrides,
     0108): для послуг модальності кабінету — своя ціна/тривалість/контраст або
     «сховати тут». Порожньо → кабінет успадковує базу. «Скинути» повертає до бази.

   Мутації — Server Actions (app/services/actions.ts); RLS admin-write як
   defense-in-depth. Після мутації — router.refresh (низькооборотна таблиця). */

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import ConfirmDialog from "@/components/ConfirmDialog";
import {
  createService, updateService, setServiceActive, deleteService, seedServicesFromCatalog,
  setRoomServiceOverride, clearRoomServiceOverride, type ServiceInput,
} from "@/app/services/actions";
import { BOOKABLE_MODALITIES, CONTRAST_SURCHARGE, modalityLabel, modalityKind, modalityCode, type ModalityCode } from "@/lib/studies";
import type { Tables } from "@/supabase/types";

type ServiceRow = Tables<"services">;
type SroRow = Tables<"service_room_overrides">;
type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null };

/* ---- Базовий каталог: чернетка рядка (як у попередній версії ServicesManager) ---- */
interface Draft { name: string; durationMin: string; price: string; contrastAllowed: boolean; contrastPrice: string; sortOrder: string }
const emptyDraft = (): Draft => ({ name: "", durationMin: "20", price: "0", contrastAllowed: false, contrastPrice: "", sortOrder: "0" });
const draftOf = (s: ServiceRow): Draft => ({
  name: s.name, durationMin: String(s.duration_min), price: String(s.price),
  contrastAllowed: s.contrast_allowed, contrastPrice: s.contrast_price != null ? String(s.contrast_price) : "",
  sortOrder: String(s.sort_order),
});
type BookableModality = ServiceInput["modality"];
function draftToInput(d: Draft, modality: BookableModality, active = true): ServiceInput {
  return {
    name: d.name.trim(), modality, durationMin: Number(d.durationMin) || 0, price: Number(d.price) || 0,
    contrastAllowed: d.contrastAllowed,
    contrastPrice: d.contrastAllowed && d.contrastPrice.trim() !== "" ? Number(d.contrastPrice) : null,
    active, sortOrder: Number(d.sortOrder) || 0,
  };
}

/* ⚠️ МОДУЛЬНИЙ рівень (ревью B-1): вкладений компонент-функція втрачав би фокус. */
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
          <input className="inp" type="number" min={0} step={50} style={{ width: 96 }} placeholder={String(CONTRAST_SURCHARGE)}
            value={d.contrastPrice} onChange={(e) => setD((p) => ({ ...p, contrastPrice: e.target.value }))} /> ₴
        </label>
      )}
    </>
  );
}

/* ---- Кабінет: чернетка переозначення (порожнє поле = успадкувати базу) ---- */
interface OvDraft { price: string; durationMin: string; contrastPrice: string; active: boolean }
const ovDraftOf = (o?: SroRow | null): OvDraft => ({
  price: o?.price != null ? String(o.price) : "",
  durationMin: o?.duration_min != null ? String(o.duration_min) : "",
  contrastPrice: o?.contrast_price != null ? String(o.contrast_price) : "",
  active: o ? o.active : true,
});
const numOrNull = (s: string): number | null => (s.trim() === "" ? null : Number(s));

interface Props {
  clinicId: string;
  services: ServiceRow[];
  rooms?: RoomOpt[];
  roomOverrides?: SroRow[];
  /** embedded=true — без внутрішнього банера-підказки (Майстер показує свій). */
  embedded?: boolean;
}

export default function ServicesEditor({ services, rooms, roomOverrides, embedded }: Props) {
  const router = useRouter();
  const roomList = (rooms || []).filter((r) => BOOKABLE_MODALITIES.includes(modalityCode(r.modality)));

  const [items, setItems] = useState<ServiceRow[]>(services);
  const [overrides, setOverrides] = useState<SroRow[]>(roomOverrides || []);
  // SSR-props оновлюються після router.refresh() (сід «Заповнити з базового», додавання
  // послуги, зміна override). useState бере значення лише на монтуванні, тож без цієї
  // синхронізації нове не видно до повного F5. Мутації тут оптимістичні + await, тож на
  // момент зміни props вони вже в БД — перезапис локального стану сервером-істиною безпечний.
  useEffect(() => { setItems(services); }, [services]);
  useEffect(() => { setOverrides(roomOverrides || []); }, [roomOverrides]);
  // scope: "base" (каталог центру) або room.id (переозначення кабінету).
  const [scope, setScope] = useState<string>("base");
  const [tab, setTab] = useState<ModalityCode>((BOOKABLE_MODALITIES[0] ?? "MRI") as ModalityCode);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);
  // Базовий режим
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [addOpen, setAddOpen] = useState(false);
  const [addDraft, setAddDraft] = useState<Draft>(emptyDraft());
  const [confirmDel, setConfirmDel] = useState<ServiceRow | null>(null);
  // Режим кабінету
  const [ovEditId, setOvEditId] = useState<string | null>(null); // service_id у режимі правки
  const [ovDraft, setOvDraft] = useState<OvDraft>(ovDraftOf());

  const room = scope === "base" ? null : roomList.find((r) => r.id === scope) || null;
  const roomMod: ModalityCode | null = room ? modalityCode(room.modality) : null;
  const effTab: ModalityCode = roomMod ?? tab; // у режимі кабінету модальність фіксована

  function notify(msg: string, type = "success") { setToast({ msg, type }); setTimeout(() => setToast(null), 3500); }
  function refresh() { router.refresh(); }

  const ovByService = useMemo(() => {
    const m = new Map<string, SroRow>();
    if (room) for (const o of overrides) if (o.room_id === room.id) m.set(o.service_id, o);
    return m;
  }, [overrides, room]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter((s) => s.modality === effTab)
      .filter((s) => !q || s.name.toLowerCase().includes(q))
      .sort((a, b) => Number(b.active) - Number(a.active) || a.sort_order - b.sort_order || a.name.localeCompare(b.name, "uk"));
  }, [items, effTab, query]);

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of items) m[s.modality] = (m[s.modality] || 0) + (s.active ? 1 : 0);
    return m;
  }, [items]);

  /* ---------- Базовий каталог ---------- */
  async function onSeed() {
    setBusy(true);
    try {
      const res = await seedServicesFromCatalog();
      if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
      notify(res.count ? "Додано " + res.count + " послуг із базового каталогу" : "Усі позиції базового каталогу вже додані", "success");
      refresh();
    } finally { setBusy(false); }
  }
  async function onAdd() {
    setBusy(true);
    try {
      const res = await createService(draftToInput(addDraft, tab as BookableModality));
      if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
      notify("Послугу додано: " + addDraft.name.trim(), "success");
      setAddOpen(false); setAddDraft(emptyDraft()); refresh();
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
      setEditId(null); notify("Збережено", "success"); refresh();
    } finally { setBusy(false); }
  }
  async function onToggleActive(s: ServiceRow) {
    setBusy(true);
    try {
      const res = await setServiceActive(s.id, !s.active);
      if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
      setItems((arr) => arr.map((x) => (x.id === s.id ? { ...x, active: !s.active } : x)));
      notify(!s.active ? "Послугу увімкнено" : "Послугу вимкнено (лишається в історії)", "info"); refresh();
    } finally { setBusy(false); }
  }
  async function onDelete(s: ServiceRow) {
    setBusy(true);
    try {
      const res = await deleteService(s.id);
      if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
      setItems((arr) => arr.filter((x) => x.id !== s.id));
      notify("Послугу видалено", "info"); refresh();
    } finally { setBusy(false); }
  }

  /* ---------- Переозначення кабінету ---------- */
  async function onSaveOverride(s: ServiceRow) {
    if (!room) return;
    setBusy(true);
    try {
      const res = await setRoomServiceOverride(room.id, s.id, {
        price: numOrNull(ovDraft.price), durationMin: numOrNull(ovDraft.durationMin),
        contrastPrice: s.contrast_allowed ? numOrNull(ovDraft.contrastPrice) : null, active: ovDraft.active,
      });
      if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
      const next: SroRow = {
        clinic_id: s.clinic_id, room_id: room.id, service_id: s.id,
        price: numOrNull(ovDraft.price), duration_min: numOrNull(ovDraft.durationMin),
        contrast_price: s.contrast_allowed ? numOrNull(ovDraft.contrastPrice) : null, active: ovDraft.active,
        updated_at: new Date(0).toISOString(), created_at: new Date(0).toISOString(),
      };
      setOverrides((arr) => [...arr.filter((o) => !(o.room_id === room.id && o.service_id === s.id)), next]);
      setOvEditId(null); notify("Збережено для кабінету «" + room.name + "»", "success"); refresh();
    } finally { setBusy(false); }
  }
  async function onClearOverride(s: ServiceRow) {
    if (!room) return;
    setBusy(true);
    try {
      const res = await clearRoomServiceOverride(room.id, s.id);
      if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
      setOverrides((arr) => arr.filter((o) => !(o.room_id === room.id && o.service_id === s.id)));
      setOvEditId(null); notify("Повернено до базового каталогу", "info"); refresh();
    } finally { setBusy(false); }
  }

  const fmtUah = (n: number) => n.toLocaleString("uk-UA") + " ₴";
  // Компактні колонки — щоб таблиця влазила і у вужчу колонку Майстра (~680px),
  // без горизонтального скролу. Назва — minmax(0,…) (стискається/еліпсис), дії — іконки.
  const GRID_BASE = "minmax(100px,2.4fr) 66px 78px 80px 68px 112px";
  const GRID_ROOM = "minmax(120px,2.4fr) 74px 96px 116px 84px";

  // Пілюля стану послуги в кабінеті (замість шумного зеленого «пропонується» на кожному
  // рядку). Функція-хелпер, НЕ вкладений компонент (правило: вкладений компонент =
  // ремоунт піддерева щорендер).
  const statusChip = (hidden: boolean, changed: boolean) => {
    const base: CSSProperties = { display: "inline-block", fontSize: 12, fontWeight: 600, padding: "2px 9px", borderRadius: 999, border: "1px solid" };
    if (hidden) return <span style={{ ...base, color: "var(--text-muted)", borderColor: "var(--border-strong)" }}>Прихована</span>;
    if (changed) return <span style={{ ...base, color: "var(--blue)", borderColor: "var(--blue)", background: "color-mix(in srgb, var(--blue) 12%, transparent)" }}>Змінено</span>;
    return <span style={{ ...base, color: "var(--text-faint)", borderColor: "var(--border)" }}>Базове</span>;
  };

  return (
    <div>
      {!embedded && (
        <div className="info-banner">
          <span className="ib-ic" aria-hidden="true">₴</span>
          <span className="ib-txt">
            <b>Каталог послуг центру</b> — базовий перелік, тривалості та ціни на модальність.
            Для кожного <b>кабінета</b> ціну/тривалість/склад можна переозначити окремо
            (оберіть кабінет у списку нижче). Вимкнена послуга зникає з форм запису, але
            лишається в історії.
          </span>
        </div>
      )}

      {/* Селектор області: базовий каталог або конкретний кабінет */}
      <div className="qctrl" style={{ marginBottom: 8 }}>
        <label className="fld-lab" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          Налаштувати:
          <select className="inp" value={scope} onChange={(e) => { setScope(e.target.value); setEditId(null); setOvEditId(null); }} style={{ minWidth: 220 }}>
            <option value="base">Базовий каталог центру</option>
            {roomList.length > 0 && <optgroup label="Кабінети (своя ціна/час)">
              {roomList.map((r) => <option key={r.id} value={r.id}>{modalityLabel(r.modality)} · {r.name}</option>)}
            </optgroup>}
          </select>
        </label>
        {room && <span className="badge" title="Порожні поля успадковують базовий каталог">кабінет «{room.name}» · {modalityLabel(room.modality)}</span>}
      </div>

      <div className="qctrl">
        <div className="pills">
          {(room ? [effTab] : (BOOKABLE_MODALITIES as ModalityCode[])).map((m) => (
            <button key={m} className={"pill" + (effTab === m ? " active" : "")} disabled={!!room}
              onClick={() => { setTab(m); setEditId(null); }}>
              {modalityLabel(m)}<span className="ct">({counts[m] || 0})</span>
            </button>
          ))}
        </div>
        <div className="spacer" />
        <div className="search"><span className="si">⌕</span>
          <input placeholder="Пошук послуги…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {scope === "base" && (
          <span style={{ display: "inline-flex", gap: 8, marginLeft: 8 }}>
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={onSeed}
              title="Разово наповнити базовий каталог позиціями з довідника">⤓ З базового довідника</button>
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => { setAddDraft(emptyDraft()); setAddOpen(true); }}>＋ Додати</button>
          </span>
        )}
      </div>

      {scope === "base" && addOpen && (
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

      {/* Заголовок таблиці */}
      {scope === "base" ? (
        <div className="wlhead" style={{ gridTemplateColumns: GRID_BASE }}>
          <div>Послуга</div><div style={{ textAlign: "right" }}>Тривалість</div><div style={{ textAlign: "right" }}>Ціна</div><div style={{ textAlign: "right" }}>Контраст</div><div>Стан</div><div style={{ textAlign: "right" }}>Дії</div>
        </div>
      ) : (
        <div className="wlhead" style={{ gridTemplateColumns: GRID_ROOM }}>
          <div>Послуга</div><div style={{ textAlign: "right" }}>Тривалість</div><div style={{ textAlign: "right" }}>Ціна</div><div>У кабінеті</div><div style={{ textAlign: "right" }}>Дії</div>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="empty"><div className="ei">₴</div>
          <div className="et">У модальності {modalityLabel(effTab)} поки немає послуг</div>
          <div className="es">{scope === "base" ? "Додайте вручну або натисніть «З базового довідника»" : "Спершу наповніть базовий каталог центру"}</div></div>
      ) : scope === "base" ? (
        /* ---------- РЯДКИ: базовий каталог ---------- */
        <div className="clrows">
          {rows.map((s) => {
            const editing = editId === s.id;
            return (
              <div className="clrow-wrap" key={s.id}>
                <div className="wlrow" style={{ gridTemplateColumns: GRID_BASE, opacity: s.active ? 1 : 0.55 }}>
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
                      <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.name}>{s.name}
                        {s.source === "import" && <span className="badge" style={{ marginLeft: 8 }} title="Завантажено імпортом">імпорт</span>}</div>
                      <div className="tabular" style={{ textAlign: "right" }}>{s.duration_min} хв</div>
                      <div className="tabular" style={{ textAlign: "right" }}>{s.price ? fmtUah(s.price) : <span style={{ color: "var(--orange)" }} title="Ціну ще не задано">0 ₴</span>}</div>
                      <div style={{ textAlign: "right" }}>{s.contrast_allowed ? <span title="Доплата за контраст">＋{fmtUah(s.contrast_price ?? CONTRAST_SURCHARGE)}</span> : <span style={{ color: "var(--text-faint)" }}>—</span>}</div>
                      <div>{s.active ? <span style={{ color: "var(--green)" }}>активна</span> : <span style={{ color: "var(--text-faint)" }}>вимкнена</span>}</div>
                      <div className="cl-actions" style={{ justifyContent: "flex-end" }}>
                        <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { setEditId(s.id); setDraft(draftOf(s)); }} title="Редагувати" aria-label={"Редагувати " + s.name}>✎</button>
                        <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onToggleActive(s)}
                          title={s.active ? "Вимкнути (прибрати з форм)" : "Увімкнути"} aria-label={s.active ? "Вимкнути" : "Увімкнути"}>⏻</button>
                        <button className="btn btn-secondary btn-sm" style={{ color: "var(--red)" }} disabled={busy} onClick={() => setConfirmDel(s)} title="Видалити" aria-label={"Видалити " + s.name}>✕</button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* ---------- РЯДКИ: переозначення кабінету ---------- */
        <div className="clrows">
          {rows.map((s) => {
            const ov = ovByService.get(s.id);
            const editing = ovEditId === s.id;
            const effDur = ov?.duration_min ?? s.duration_min;
            const effPrice = ov?.price ?? s.price;
            const hidden = ov ? !ov.active : false;
            const changed = !!ov;
            const durChanged = ov?.duration_min != null && ov.duration_min !== s.duration_min;
            const priceChanged = ov?.price != null && ov.price !== s.price;

            if (editing) {
              // Форма — окрема картка (не всередині grid-рядка), тому поля не обрізаються.
              return (
                <div className="cl-detail" key={s.id} style={{ marginBottom: 8, borderLeft: "3px solid var(--blue)" }}>
                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 12 }}>
                    <span style={{ fontWeight: 650, fontSize: 14.5 }}>{s.name}</span>
                    {room && <span className="badge" style={{ color: "var(--text-muted)" }}>кабінет «{room.name}»</span>}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end" }}>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--text-muted)" }}>
                      Тривалість, хв
                      <input className="inp" type="number" step={5} min={5} max={480} style={{ width: 110 }} placeholder={String(s.duration_min)}
                        value={ovDraft.durationMin} onChange={(e) => setOvDraft((p) => ({ ...p, durationMin: e.target.value }))} />
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--text-muted)" }}>
                      Ціна, ₴
                      <input className="inp" type="number" min={0} step={50} style={{ width: 130 }} placeholder={String(s.price)}
                        value={ovDraft.price} onChange={(e) => setOvDraft((p) => ({ ...p, price: e.target.value }))} />
                    </label>
                    {s.contrast_allowed && (
                      <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--text-muted)" }}>
                        Доплата за контраст, ₴
                        <input className="inp" type="number" min={0} step={50} style={{ width: 150 }} placeholder={String(s.contrast_price ?? CONTRAST_SURCHARGE)}
                          value={ovDraft.contrastPrice} onChange={(e) => setOvDraft((p) => ({ ...p, contrastPrice: e.target.value }))} />
                      </label>
                    )}
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13.5, paddingBottom: 8 }}>
                      <input type="checkbox" checked={ovDraft.active} onChange={(e) => setOvDraft((p) => ({ ...p, active: e.target.checked }))} />
                      Пропонується в цьому кабінеті
                    </label>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 12, color: "var(--text-faint)" }}>Порожнє поле = як у базовому каталозі ({s.duration_min} хв · {fmtUah(s.price)}).</span>
                    <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
                      {changed && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onClearOverride(s)} title="Прибрати переозначення — успадкувати базовий каталог">↺ До базового</button>}
                      <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setOvEditId(null)}>Скасувати</button>
                      <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => onSaveOverride(s)}>Зберегти</button>
                    </span>
                  </div>
                </div>
              );
            }

            return (
              <div className="clrow-wrap" key={s.id}
                style={{ borderLeft: "3px solid " + (hidden ? "var(--border-strong)" : changed ? "var(--blue)" : "transparent") }}>
                <div className="wlrow" style={{ gridTemplateColumns: GRID_ROOM, opacity: hidden ? 0.62 : 1 }}>
                  <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.name}>{s.name}</div>
                  <div className="tabular" style={{ textAlign: "right" }}>
                    <span style={durChanged ? { color: "var(--blue)", fontWeight: 600 } : undefined}>{effDur} хв</span>
                    {durChanged && <div style={{ fontSize: 11, color: "var(--text-faint)" }}>база {s.duration_min}</div>}
                  </div>
                  <div className="tabular" style={{ textAlign: "right" }}>
                    {effPrice
                      ? <span style={priceChanged ? { color: "var(--blue)", fontWeight: 600 } : undefined}>{fmtUah(effPrice)}</span>
                      : <span style={{ color: "var(--orange)" }} title="Ціну не задано ні в кабінеті, ні в базі">0 ₴</span>}
                    {priceChanged && <div style={{ fontSize: 11, color: "var(--text-faint)" }}>база {fmtUah(s.price)}</div>}
                  </div>
                  <div>{statusChip(hidden, changed)}</div>
                  <div className="cl-actions" style={{ justifyContent: "flex-end" }}>
                    <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { setOvEditId(s.id); setOvDraft(ovDraftOf(ov)); }}
                      title={"Налаштувати «" + s.name + "» для цього кабінету"} aria-label={"Налаштувати " + s.name}>✎</button>
                    {changed && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onClearOverride(s)} title="Повернути до базового каталогу" aria-label="Повернути до базового">↺</button>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {confirmDel && (
        <ConfirmDialog title="Видалити послугу"
          text={<>Видалити <b style={{ color: "var(--text)" }}>{confirmDel.name}</b> назовсім? Якщо ще може знадобитись — краще «Вимкнути».</>}
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
