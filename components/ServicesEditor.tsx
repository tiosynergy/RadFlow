"use client";

/* ===== RadFlow — Редактор каталогу послуг (Stage 2, фаза 2b · room-owned 0121/Ф3) =====
   Ядро редактора, спільне для сторінки /services (ServicesManager) і кроку
   Майстра налаштувань «Послуги та прайс» (embedded). Два режими (селектор зверху):

   • «Базовий каталог центру» — перелік/тривалості/ціни на модальність (services,
     0107, room_id IS NULL): додати/редагувати/увімк-вимк/видалити + сід із довідника.
   • «Кабінет N» — ДВІ групи (0121):
     — «Послуги кабінета» (services.room_id = кабінет): ВЛАСНИЙ прайс кабінета,
       повний CRUD як у базі; «＋ Додати» та «⇪ Імпорт» створюють саме їх;
     — «Базові (успадковано)» (room_id IS NULL тієї ж модальності): переозначення
       ПО КАБІНЕТУ (service_room_overrides, 0108) — своя ціна/тривалість/контраст
       або «сховати тут»; порожньо → успадкувати базу; «Скинути» повертає до бази.
     Дубль імені база↔кабінет допустимий (Q4) — у формах запису видимі обидві,
     пошук за назвою віддає пріоритет кабінетній (lib/catalog.ts).

   Мутації — Server Actions (app/services/actions.ts); RLS admin-write як
   defense-in-depth. Після мутації — router.refresh (низькооборотна таблиця). */

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import Toast from "@/components/Toast";
import { useRouter } from "next/navigation";
import ConfirmDialog from "@/components/ConfirmDialog";
import ImportPriceModal from "@/components/ImportPriceModal";
import {
  createService, updateService, setServiceActive, deleteService, seedServicesFromCatalog,
  setRoomServiceOverride, clearRoomServiceOverride,
  bulkSetServicesActive, bulkDeleteServices, bulkSetRoomServicesActive, bulkClearRoomOverrides,
  type ServiceInput,
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
  name: s.name, durationMin: s.duration_min != null ? String(s.duration_min) : "", price: String(s.price),
  contrastAllowed: s.contrast_allowed, contrastPrice: s.contrast_price != null ? String(s.contrast_price) : "",
  sortOrder: String(s.sort_order),
});
type BookableModality = ServiceInput["modality"];
function draftToInput(d: Draft, modality: BookableModality, active = true): ServiceInput {
  return {
    // 0117: порожній час = null («не задано», «—»), НЕ 0 і НЕ фіктивні 20.
    name: d.name.trim(), modality, durationMin: d.durationMin.trim() === "" ? null : Number(d.durationMin) || 0, price: Number(d.price) || 0,
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
      <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "0.78125rem", cursor: "pointer" }}>
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
  const [importOpen, setImportOpen] = useState(false); // «Імпорт прайса» (фаза 3a)
  // Режим кабінету
  const [ovEditId, setOvEditId] = useState<string | null>(null); // service_id у режимі правки
  const [ovDraft, setOvDraft] = useState<OvDraft>(ovDraftOf());
  // Масовий вибір (чекбокси): ключ = service.id. «Усі» в шапці оперує ВИДИМИМИ
  // рядками (поточна модальність + пошук). Скидається при зміні scope/вкладки.
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [confirmBulkDel, setConfirmBulkDel] = useState(false);

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

  // 0121: базові (room_id NULL) та власні послуги кабінету — РІЗНІ набори.
  // База показує лише базові; режим кабінета — дві групи (власні + успадковані).
  const rowsAll = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter((s) => s.modality === effTab)
      .filter((s) => !q || s.name.toLowerCase().includes(q))
      .sort((a, b) => Number(b.active) - Number(a.active) || a.sort_order - b.sort_order || a.name.localeCompare(b.name, "uk"));
  }, [items, effTab, query]);
  const baseRows = useMemo(() => rowsAll.filter((s) => (s.room_id ?? null) === null), [rowsAll]);
  const roomRows = useMemo(
    () => (room ? rowsAll.filter((s) => s.room_id === room.id) : []),
    [rowsAll, room]
  );
  // Видимі рядки поточного режиму (вибір/лічильники панелі масових дій).
  const rows = useMemo(
    () => (scope === "base" ? baseRows : [...roomRows, ...baseRows]),
    [scope, baseRows, roomRows]
  );

  const counts = useMemo(() => {
    // Активні послуги, видимі поточному контексту: база — лише базові;
    // кабінет — власні кабінету + базові, НЕ приховані override-ом (дзеркало
    // room-видимості 0121; ревю Ф3 №6).
    const m: Record<string, number> = {};
    for (const s of items) {
      const owner = s.room_id ?? null;
      if (room ? owner !== null && owner !== room.id : owner !== null) continue;
      if (!s.active) continue;
      if (room && owner === null && ovByService.get(s.id)?.active === false) continue;
      m[s.modality] = (m[s.modality] || 0) + 1;
    }
    return m;
  }, [items, room, ovByService]);

  /* ---------- Масовий вибір ---------- */
  const selIds = useMemo(() => rows.filter((s) => selected[s.id]).map((s) => s.id), [rows, selected]);
  // 0121: у режимі кабінета масові дії розходяться за групами.
  const selRoomIds = useMemo(() => roomRows.filter((s) => selected[s.id]).map((s) => s.id), [roomRows, selected]);
  const selBaseIds = useMemo(() => baseRows.filter((s) => selected[s.id]).map((s) => s.id), [baseRows, selected]);
  const allSelected = rows.length > 0 && selIds.length === rows.length;
  function toggleSelectAll() {
    const target = !allSelected;
    setSelected((p) => {
      const next = { ...p };
      rows.forEach((s) => { next[s.id] = target; });
      return next;
    });
  }
  // Селект-все для ОКРЕМОЇ групи режиму кабінета (шапка кожної групи має свій).
  const listAllSelected = (list: ServiceRow[]) => list.length > 0 && list.every((s) => selected[s.id]);
  function toggleSelectList(list: ServiceRow[]) {
    const target = !listAllSelected(list);
    setSelected((p) => {
      const next = { ...p };
      list.forEach((s) => { next[s.id] = target; });
      return next;
    });
  }
  function clearSelection() { setSelected({}); }

  async function onBulkActive(active: boolean) {
    setBusy(true);
    try {
      const res = await bulkSetServicesActive(selIds, active);
      if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
      const idSet = new Set(selIds);
      setItems((arr) => arr.map((x) => (idSet.has(x.id) ? { ...x, active } : x)));
      notify((active ? "Увімкнено послуг: " : "Вимкнено послуг: ") + (res.count ?? selIds.length), "info");
      clearSelection(); refresh();
    } finally { setBusy(false); }
  }
  async function onBulkDelete() {
    // 0121: у режимі кабінета видаляються ЛИШЕ власні послуги кабінету
    // (успадковані базові з режиму кабінета не видаляються — їх «Приховати»).
    const ids = scope === "base" ? selIds : selRoomIds;
    if (!ids.length) return;
    setBusy(true);
    try {
      const res = await bulkDeleteServices(ids);
      if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
      const idSet = new Set(ids);
      setItems((arr) => arr.filter((x) => !idSet.has(x.id)));
      notify("Видалено послуг: " + (res.count ?? ids.length), "info");
      clearSelection(); refresh();
    } finally { setBusy(false); }
  }
  /* 0121: «Показати/Приховати» в режимі кабінета — ДВІ групи одним натиском:
     власні послуги кабінету вмикаються/вимикаються самі (bulkSetServicesActive —
     вони існують лише тут), успадковані базові — через override show/hide (0108). */
  async function onBulkRoomActive(active: boolean) {
    if (!room) return;
    setBusy(true);
    try {
      let done = 0;
      if (selRoomIds.length) {
        const res = await bulkSetServicesActive(selRoomIds, active);
        if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
        const idSet = new Set(selRoomIds);
        setItems((arr) => arr.map((x) => (idSet.has(x.id) ? { ...x, active } : x)));
        done += res.count ?? selRoomIds.length;
      }
      if (selBaseIds.length) {
        const res = await bulkSetRoomServicesActive(room.id, selBaseIds, active);
        if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
        const idSet = new Set(selBaseIds);
        setOverrides((arr) => {
          const present = new Set(arr.filter((o) => o.room_id === room.id).map((o) => o.service_id));
          const updated = arr.map((o) => (o.room_id === room.id && idSet.has(o.service_id) ? { ...o, active } : o));
          if (active) return updated; // «показати» без override — no-op (видима базою)
          const now = new Date(0).toISOString();
          const added: SroRow[] = selBaseIds.filter((id) => !present.has(id)).map((sid) => ({
            clinic_id: items.find((x) => x.id === sid)?.clinic_id ?? "", room_id: room.id, service_id: sid,
            price: null, duration_min: null, contrast_price: null, active: false,
            created_at: now, updated_at: now,
          }));
          return [...updated, ...added];
        });
        done += res.count ?? 0;
      }
      // Ревю Ф3 №3: «показати» видимі базою без override — серверний no-op (0 by design).
      notify(
        active
          ? (done > 0 ? "Показано в кабінеті: " + done : "Вибрані вже видимі (успадковано базою)")
          : "Приховано в кабінеті: " + done,
        "info");
      clearSelection(); refresh();
    } finally { setBusy(false); }
  }
  async function onBulkRoomClear() {
    if (!room || !selBaseIds.length) return; // власних послуг «до базового» не існує
    setBusy(true);
    try {
      const res = await bulkClearRoomOverrides(room.id, selBaseIds);
      if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
      const idSet = new Set(selBaseIds);
      setOverrides((arr) => arr.filter((o) => !(o.room_id === room.id && idSet.has(o.service_id))));
      notify("Повернено до базового: " + (res.count ?? 0), "info");
      clearSelection(); refresh();
    } finally { setBusy(false); }
  }

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
      // effTab = модальність активної вкладки (база) або кабінета (у режимі кабінета — фіксована).
      // 0121: у режимі кабінета послуга створюється ВЛАСНОЮ для кабінета
      // (services.room_id = кабінет) — база не торкається, переозначення не потрібне.
      const res = await createService(draftToInput(addDraft, effTab as BookableModality), room?.id);
      if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
      notify("Послугу додано: " + addDraft.name.trim() + (room ? " (кабінет «" + room.name + "»)" : ""), "success");
      setAddOpen(false); setAddDraft(emptyDraft()); refresh();
    } finally { setBusy(false); }
  }
  async function onSaveEdit(s: ServiceRow) {
    setBusy(true);
    try {
      const res = await updateService(s.id, draftToInput(draft, s.modality as BookableModality, s.active));
      if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
      setItems((arr) => arr.map((x) => (x.id === s.id ? {
        ...x, name: draft.name.trim(), duration_min: draft.durationMin.trim() === "" ? null : (Number(draft.durationMin) || x.duration_min),
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
  // Компактні колонки — щоб таблиця влазила і у вужчу колонку Майстра (~680px).
  // Назва — ширша (min 150px) і ПЕРЕНОСИТЬСЯ на новий рядок, якщо не влазить (замість
  // обрізання еліпсисом); дії — іконки. Перша колонка 26px — чекбокс масового вибору.
  const GRID_BASE = "26px minmax(150px,3fr) 66px 78px 80px 68px 112px";
  const GRID_ROOM = "26px minmax(150px,3fr) 74px 96px 116px 84px";

  // Чекбокс рядка (спільний для обох режимів).
  const rowCheckbox = (id: string, name: string) => (
    <input type="checkbox" checked={!!selected[id]} disabled={busy}
      aria-label={"Вибрати " + name}
      onChange={(e) => setSelected((p) => ({ ...p, [id]: e.target.checked }))} />
  );

  // Пілюля стану послуги в кабінеті (замість шумного зеленого «пропонується» на кожному
  // рядку). Функція-хелпер, НЕ вкладений компонент (правило: вкладений компонент =
  // ремоунт піддерева щорендер).
  const statusChip = (hidden: boolean, changed: boolean) => {
    const base: CSSProperties = { display: "inline-block", fontSize: "0.75rem", fontWeight: 600, padding: "2px 9px", borderRadius: 999, border: "1px solid" };
    if (hidden) return <span style={{ ...base, color: "var(--text-muted)", borderColor: "var(--border-strong)" }}>Прихована</span>;
    if (changed) return <span style={{ ...base, color: "var(--blue)", borderColor: "var(--blue)", background: "color-mix(in srgb, var(--blue) 12%, transparent)" }}>Змінено</span>;
    return <span style={{ ...base, color: "var(--text-faint)", borderColor: "var(--border)" }}>Базове</span>;
  };

  /* Рядок «повного CRUD» (базовий каталог АБО власна послуга кабінета — 0121):
     редагування DraftFields, увімк/вимк, видалення. Хелпер-функція, НЕ вкладений
     компонент (правило B-1: вкладений компонент = ремоунт піддерева щорендер). */
  const renderCatalogRow = (s: ServiceRow, roomOwned: boolean) => {
    const editing = editId === s.id;
    return (
      <div className="clrow-wrap" key={s.id} style={roomOwned ? { borderLeft: "3px solid var(--blue)" } : undefined}>
        <div className="wlrow svc-row" style={{ "--svc-cols": GRID_BASE, opacity: s.active ? 1 : 0.55 } as CSSProperties}>
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
              {rowCheckbox(s.id, s.name)}
              <div data-lab="Послуга" style={{ fontWeight: 600, minWidth: 0, overflowWrap: "anywhere", wordBreak: "break-word" }} title={s.name}>{s.name}
                {roomOwned && <span className="badge" style={{ marginLeft: 8, color: "var(--blue)" }} title="Власна послуга кабінета — видима і бронюється лише в ньому">Кабінетна</span>}
                {s.source === "import" && <span className="badge" style={{ marginLeft: 8 }} title="Завантажено імпортом">імпорт</span>}</div>
              <div className="tabular svc-num" data-lab="Тривалість">{s.duration_min != null ? s.duration_min + " хв" : <span style={{ color: "var(--orange)" }} title="Час не задано — введіть у редакторі або вручну при записі">—</span>}</div>
              <div className="tabular svc-num" data-lab="Ціна">{s.price ? fmtUah(s.price) : <span style={{ color: "var(--orange)" }} title="Ціну ще не задано">—</span>}</div>
              <div className="svc-num" data-lab="Контраст">{s.contrast_allowed ? <span title="Доплата за контраст">＋{fmtUah(s.contrast_price ?? CONTRAST_SURCHARGE)}</span> : <span style={{ color: "var(--text-faint)" }}>—</span>}</div>
              <div data-lab="Стан">{s.active ? <span style={{ color: "var(--green)" }}>активна</span> : <span style={{ color: "var(--text-faint)" }}>вимкнена</span>}</div>
              <div className="cl-actions svc-act">
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
  };

  return (
    <div>
      {!embedded && (
        <div className="info-banner">
          <span className="ib-ic" aria-hidden="true">₴</span>
          <span className="ib-txt">
            <b>Каталог послуг центру</b> — базовий перелік, тривалості та ціни на модальність
            (успадковується всіма кабінетами). Кожен <b>кабінет</b> може мати і <b>власний
            прайс</b> (оберіть кабінет у списку нижче): його послуги видимі лише в ньому,
            а базові можна переозначити або сховати. Вимкнена послуга зникає з форм запису,
            але лишається в історії.
          </span>
        </div>
      )}

      {/* Селектор області: базовий каталог або конкретний кабінет */}
      <div className="qctrl" style={{ marginBottom: 8 }}>
        <label className="fld-lab svc-scope">
          Налаштувати:
          <select className="inp" value={scope} onChange={(e) => { setScope(e.target.value); setEditId(null); setOvEditId(null); setSelected({}); }}>
            <option value="base">Базовий каталог центру</option>
            {roomList.length > 0 && <optgroup label="Кабінети (власний прайс)">
              {roomList.map((r) => <option key={r.id} value={r.id}>{modalityLabel(r.modality)} · {r.name}{r.apparatus_model ? " · " + r.apparatus_model : ""}</option>)}
            </optgroup>}
          </select>
        </label>
        {room && <span className="badge" title="Порожні поля успадковують базовий каталог">кабінет «{room.name}» · {modalityLabel(room.modality)}</span>}
      </div>

      {/* Модальності — окремим рядком і в ОДИН ряд (nowrap), щоб не переносились. */}
      <div className="qctrl" style={{ marginBottom: 8 }}>
        <div className="pills" style={{ flexWrap: "nowrap", overflowX: "auto", maxWidth: "100%" }}>
          {(room ? [effTab] : (BOOKABLE_MODALITIES as ModalityCode[])).map((m) => (
            <button key={m} className={"pill" + (effTab === m ? " active" : "")} disabled={!!room}
              onClick={() => { setTab(m); setEditId(null); setSelected({}); }}>
              {modalityLabel(m)}<span className="ct">({counts[m] || 0})</span>
            </button>
          ))}
        </div>
      </div>

      <div className="qctrl">
        <div className="spacer" />
        <div className="search"><span className="si">⌕</span>
          <input placeholder="Пошук послуги…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <span className="svc-toolbar">
          {scope === "base" && (
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={onSeed}
              title="Разово наповнити базовий каталог позиціями з довідника">⤓ З базового довідника</button>
          )}
          <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setImportOpen(true)}
            title={room ? "Імпорт прайса у цей кабінет — власні послуги кабінета, тільки його модальність" : "Завантажити прайс .xlsx/.csv/.pdf/фото — з передпереглядом змін"}>⇪ Імпорт прайса</button>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => { setAddDraft(emptyDraft()); setAddOpen(true); }}>＋ Додати</button>
        </span>
      </div>

      {addOpen && (
        <div className="cl-detail" style={{ marginBottom: 12 }}>
          {room && (
            <div style={{ fontSize: "0.78125rem", color: "var(--text-secondary)", marginBottom: 8 }}>
              Додавання у кабінет «{room.name}»: послуга ({modalityLabel(effTab)}) належатиме
              <b> лише цьому кабінету</b> — видима й бронюється тільки в ньому. Базовий каталог
              центру не змінюється.
            </div>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
            <span className={"wl-mod " + modalityKind(effTab)}>{modalityLabel(effTab)}</span>
            <DraftFields d={addDraft} setD={setAddDraft} />
            <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
              <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setAddOpen(false)}>Скасувати</button>
              <button className="btn btn-primary btn-sm" disabled={busy || addDraft.name.trim().length < 2} onClick={onAdd}>Зберегти</button>
            </span>
          </div>
        </div>
      )}

      {/* Панель масових дій — зʼявляється, коли щось вибрано */}
      {selIds.length > 0 && (
        <div className="cl-detail" style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", borderLeft: "3px solid var(--blue)" }}>
          <b style={{ fontSize: "0.84375rem" }}>Вибрано: {selIds.length}</b>
          {scope === "base" ? (
            <>
              <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onBulkActive(true)} title="Увімкнути вибрані послуги">⏻ Увімкнути</button>
              <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onBulkActive(false)} title="Вимкнути вибрані (зникнуть із форм, лишаться в історії)">⏻ Вимкнути</button>
              <button className="btn btn-secondary btn-sm" style={{ color: "var(--red)" }} disabled={busy} onClick={() => setConfirmBulkDel(true)} title="Видалити вибрані назовсім">✕ Видалити</button>
            </>
          ) : (
            <>
              <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onBulkRoomActive(true)} title="Показати вибрані послуги в цьому кабінеті (власні — увімкнути)">Показати</button>
              <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onBulkRoomActive(false)} title="Приховати вибрані послуги в цьому кабінеті (власні — вимкнути)">Приховати</button>
              {selBaseIds.length > 0 && (
                <button className="btn btn-secondary btn-sm" disabled={busy} onClick={onBulkRoomClear} title="Прибрати переозначення вибраних базових — успадкувати базовий каталог">↺ До базового ({selBaseIds.length})</button>
              )}
              {selRoomIds.length > 0 && (
                <button className="btn btn-secondary btn-sm" style={{ color: "var(--red)" }} disabled={busy} onClick={() => setConfirmBulkDel(true)} title="Видалити вибрані ВЛАСНІ послуги кабінета назовсім (базові не зачіпаються)">✕ Видалити кабінетні ({selRoomIds.length})</button>
              )}
            </>
          )}
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: "auto" }} disabled={busy} onClick={clearSelection}>Зняти вибір</button>
        </div>
      )}

      {/* Таблиця: база — один список; кабінет — ДВІ групи (0121) */}
      {scope === "base" ? (
        <>
          <div className="wlhead svc-row" style={{ "--svc-cols": GRID_BASE, alignItems: "center" } as CSSProperties}>
            <label className="svc-selall" title="Вибрати всі (видимі)">
              <input type="checkbox" checked={allSelected} disabled={busy || rows.length === 0}
                ref={(el) => { if (el) el.indeterminate = selIds.length > 0 && !allSelected; }}
                onChange={toggleSelectAll} aria-label="Вибрати всі послуги" />
              <span className="svc-selall-txt">Вибрати всі</span>
            </label>
            <div>Послуга</div><div style={{ textAlign: "right" }}>Тривалість</div><div style={{ textAlign: "right" }}>Ціна</div><div style={{ textAlign: "right" }}>Контраст</div><div>Стан</div><div style={{ textAlign: "right" }}>Дії</div>
          </div>
          {rows.length === 0 ? (
            <div className="empty"><div className="ei">₴</div>
              <div className="et">У модальності {modalityLabel(effTab)} поки немає послуг</div>
              <div className="es">Додайте вручну або натисніть «З базового довідника»</div></div>
          ) : (
            <div className="clrows">{rows.map((s) => renderCatalogRow(s, false))}</div>
          )}
        </>
      ) : (
        <>
          {/* ---------- Група 1: ВЛАСНІ послуги кабінета (room-owned, 0121) ---------- */}
          <div style={{ fontWeight: 650, fontSize: "0.84375rem", margin: "10px 0 4px", color: "var(--blue)" }}>
            Послуги кабінета ({roomRows.length})
            <span style={{ fontWeight: 400, fontSize: "0.75rem", color: "var(--text-muted)", marginLeft: 8 }}>
              власний прайс — видимі й бронюються лише в цьому кабінеті
            </span>
          </div>
          <div className="wlhead svc-row" style={{ "--svc-cols": GRID_BASE, alignItems: "center" } as CSSProperties}>
            <label className="svc-selall" title="Вибрати всі власні послуги кабінета">
              <input type="checkbox" checked={listAllSelected(roomRows)} disabled={busy || roomRows.length === 0}
                ref={(el) => { if (el) el.indeterminate = selRoomIds.length > 0 && !listAllSelected(roomRows); }}
                onChange={() => toggleSelectList(roomRows)} aria-label="Вибрати всі власні послуги кабінета" />
              <span className="svc-selall-txt">Вибрати всі</span>
            </label>
            <div>Послуга</div><div style={{ textAlign: "right" }}>Тривалість</div><div style={{ textAlign: "right" }}>Ціна</div><div style={{ textAlign: "right" }}>Контраст</div><div>Стан</div><div style={{ textAlign: "right" }}>Дії</div>
          </div>
          {roomRows.length === 0 ? (
            <div style={{ fontSize: "0.78125rem", color: "var(--text-muted)", padding: "10px 8px", borderBottom: "1px solid var(--border)" }}>
              У кабінета ще немає власного прайса — «⇪ Імпорт прайса» або «＋ Додати»
              створять послуги саме цього кабінета.
            </div>
          ) : (
            <div className="clrows">{roomRows.map((s) => renderCatalogRow(s, true))}</div>
          )}

          {/* ---------- Група 2: БАЗОВІ (успадковано) + переозначення 0108 ---------- */}
          <div style={{ fontWeight: 650, fontSize: "0.84375rem", margin: "16px 0 4px" }}>
            Базові (успадковано) ({baseRows.length})
            <span style={{ fontWeight: 400, fontSize: "0.75rem", color: "var(--text-muted)", marginLeft: 8 }}>
              спільні для всіх кабінетів {modalityLabel(effTab)}; тут можна переозначити ціну/час або сховати
            </span>
          </div>
          <div className="wlhead svc-row" style={{ "--svc-cols": GRID_ROOM, alignItems: "center" } as CSSProperties}>
            <label className="svc-selall" title="Вибрати всі базові (успадковані)">
              <input type="checkbox" checked={listAllSelected(baseRows)} disabled={busy || baseRows.length === 0}
                ref={(el) => { if (el) el.indeterminate = selBaseIds.length > 0 && !listAllSelected(baseRows); }}
                onChange={() => toggleSelectList(baseRows)} aria-label="Вибрати всі базові послуги" />
              <span className="svc-selall-txt">Вибрати всі</span>
            </label>
            <div>Послуга</div><div style={{ textAlign: "right" }}>Тривалість</div><div style={{ textAlign: "right" }}>Ціна</div><div>У кабінеті</div><div style={{ textAlign: "right" }}>Дії</div>
          </div>
          {baseRows.length === 0 ? (
            <div style={{ fontSize: "0.78125rem", color: "var(--text-muted)", padding: "10px 8px" }}>
              Базовий каталог {modalityLabel(effTab)} порожній — центр веде прайси по кабінетах.
            </div>
          ) : (
        <div className="clrows">
          {baseRows.map((s) => {
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
                    <span style={{ fontWeight: 650, fontSize: "0.90625rem" }}>{s.name}</span>
                    {room && <span className="badge" style={{ color: "var(--text-muted)" }}>кабінет «{room.name}»</span>}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end" }}>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.75rem", color: "var(--text-muted)" }}>
                      Тривалість, хв
                      <input className="inp" type="number" step={5} min={5} max={480} style={{ width: 110 }} placeholder={s.duration_min != null ? String(s.duration_min) : "—"}
                        value={ovDraft.durationMin} onChange={(e) => setOvDraft((p) => ({ ...p, durationMin: e.target.value }))} />
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.75rem", color: "var(--text-muted)" }}>
                      Ціна, ₴
                      <input className="inp" type="number" min={0} step={50} style={{ width: 130 }} placeholder={String(s.price)}
                        value={ovDraft.price} onChange={(e) => setOvDraft((p) => ({ ...p, price: e.target.value }))} />
                    </label>
                    {s.contrast_allowed && (
                      <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.75rem", color: "var(--text-muted)" }}>
                        Доплата за контраст, ₴
                        <input className="inp" type="number" min={0} step={50} style={{ width: 150 }} placeholder={String(s.contrast_price ?? CONTRAST_SURCHARGE)}
                          value={ovDraft.contrastPrice} onChange={(e) => setOvDraft((p) => ({ ...p, contrastPrice: e.target.value }))} />
                      </label>
                    )}
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: "0.84375rem", paddingBottom: 8 }}>
                      <input type="checkbox" checked={ovDraft.active} onChange={(e) => setOvDraft((p) => ({ ...p, active: e.target.checked }))} />
                      Пропонується в цьому кабінеті
                    </label>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14, flexWrap: "wrap" }}>
                    <span style={{ fontSize: "0.75rem", color: "var(--text-faint)" }}>Порожнє поле = як у базовому каталозі ({s.duration_min != null ? s.duration_min + " хв" : "—"} · {s.price ? fmtUah(s.price) : "—"}).</span>
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
                <div className="wlrow svc-row" style={{ "--svc-cols": GRID_ROOM, opacity: hidden ? 0.62 : 1 } as CSSProperties}>
                  {rowCheckbox(s.id, s.name)}
                  <div data-lab="Послуга" style={{ fontWeight: 600, minWidth: 0, overflowWrap: "anywhere", wordBreak: "break-word" }} title={s.name}>{s.name}</div>
                  <div className="tabular svc-num" data-lab="Тривалість">
                    <span style={durChanged ? { color: "var(--blue)", fontWeight: 600 } : undefined}>{effDur != null ? effDur + " хв" : <span style={{ color: "var(--orange)" }} title="Час не задано">—</span>}</span>
                    {durChanged && <div style={{ fontSize: "0.6875rem", color: "var(--text-faint)" }}>база {s.duration_min ?? "—"}</div>}
                  </div>
                  <div className="tabular svc-num" data-lab="Ціна">
                    {effPrice
                      ? <span style={priceChanged ? { color: "var(--blue)", fontWeight: 600 } : undefined}>{fmtUah(effPrice)}</span>
                      : <span style={{ color: "var(--orange)" }} title="Ціну не задано ні в кабінеті, ні в базі">—</span>}
                    {priceChanged && <div style={{ fontSize: "0.6875rem", color: "var(--text-faint)" }}>база {fmtUah(s.price)}</div>}
                  </div>
                  <div data-lab="У кабінеті">{statusChip(hidden, changed)}</div>
                  <div className="cl-actions svc-act">
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
        </>
      )}

      {importOpen && (
        <ImportPriceModal
          onClose={() => setImportOpen(false)}
          onDone={(msg) => { setImportOpen(false); notify(msg, "success"); refresh(); }}
          roomModality={room ? (effTab as "MRI" | "CT" | "US" | "XRAY" | "MAMMO") : undefined}
          roomId={room?.id}
        />
      )}

      {confirmDel && (
        <ConfirmDialog title="Видалити послугу"
          text={<>Видалити <b style={{ color: "var(--text)" }}>{confirmDel.name}</b> назовсім? Якщо ще може знадобитись — краще «Вимкнути».</>}
          confirmLabel="Видалити" danger busy={busy}
          onConfirm={async () => { const s = confirmDel; setConfirmDel(null); await onDelete(s); }}
          onClose={() => setConfirmDel(null)} />
      )}

      {confirmBulkDel && (
        <ConfirmDialog title={scope === "base" ? "Видалити вибрані послуги" : "Видалити власні послуги кабінета"}
          text={<>Видалити <b style={{ color: "var(--text)" }}>{scope === "base" ? selIds.length : selRoomIds.length}</b> вибраних
            послуг назовсім?{scope !== "base" && <> Це <b>власні послуги кабінета</b> — базові (успадковані) не зачіпаються.</>}
            {" "}Якщо ще можуть знадобитись — краще «Вимкнути» (лишаться в історії).</>}
          confirmLabel={"Видалити (" + (scope === "base" ? selIds.length : selRoomIds.length) + ")"} danger busy={busy}
          onConfirm={async () => { setConfirmBulkDel(false); await onBulkDelete(); }}
          onClose={() => setConfirmBulkDel(false)} />
      )}

      <div role="status" aria-live="polite">
        <Toast toast={toast} onDismiss={() => setToast(null)} />
      </div>
    </div>
  );
}
