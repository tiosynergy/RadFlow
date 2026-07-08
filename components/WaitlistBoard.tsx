"use client";

/* ===== RadFlow — Лист очікування (окремий екран) =====
   Пацієнти, що чекають на вільне вікно. Порядок: cito → urgent → planned.
   «Записати» відкриває повну модалку запису з передзаповненням; після
   успішного запису рядок листа отримує status='scheduled' + посилання на
   створений запис. Realtime — таблиця waitlist_entries (0047). */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";
import Sidebar from "@/components/Sidebar";
import LiveClock from "@/components/LiveClock";
import BookingModal, { type BookingPayload, type BookingPrefill } from "@/components/BookingModal";
import WaitlistModal, { type WaitlistFormOut } from "@/components/WaitlistModal";
import ConfirmDialog from "@/components/ConfirmDialog";
import { createBooking } from "@/app/queue/actions";
import { addWaitlistEntry, markWaitlistScheduled, setWaitlistPriority, setWaitlistStatus, updateWaitlistEntry } from "@/app/waitlist/actions";
import { WAITLIST_STATUS_META, compareWaitlist, desiredWindowText } from "@/lib/waitlist";
import { PRIORITY_OPTIONS, PRIORITY_META, type PatientPriority } from "@/lib/priority";
import type { WaitlistEntry } from "@/supabase/types";
import type { Study } from "@/lib/studies";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";

type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null };
type IncidentRow = { id: string; room_id: string; reason_label: string | null; note: string | null; started_at: string; blocked_until: string | null; status: string };

const WK = ["Неділя", "Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця", "Субота"];
const MON_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
function fmtFull(d: Date) { return WK[d.getDay()] + ", " + d.getDate() + " " + MON_GEN[d.getMonth()] + " " + d.getFullYear(); }
function dateKey(d: Date) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }

function procLabel(e: { studies?: unknown; note?: string | null }) {
  const s = Array.isArray(e.studies) ? (e.studies as Study[]) : [];
  if (s.length) return s.map((x) => (x.type || "") + (x.region ? " · " + x.region : "") + (x.contrast ? " з контрастом" : "")).join(" + ");
  return e.note || "—";
}

function addedAgo(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return "сьогодні";
  if (days === 1) return "вчора";
  return days + " дн. тому";
}

/* ── Меню дій рядка («⋯»): доступний поповер без бібліотек.
   role=menu/menuitem, закриття по кліку зовні та Escape, фокус — назад на тригер. ── */
function RowMenu({ disabled, onEdit, onRemove }: { disabled?: boolean; onEdit: () => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: Event) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); btnRef.current?.focus(); } };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div className="wl-menu-wrap" ref={wrapRef}>
      <button ref={btnRef} type="button" className="mini-icon" aria-haspopup="menu" aria-expanded={open} aria-label="Ще дії"
        disabled={disabled} onClick={() => setOpen((o) => !o)}>⋯</button>
      {open && (
        <div className="wl-menu" role="menu" aria-label="Дії із записом">
          <button type="button" role="menuitem" className="wl-menu-item" onClick={() => { setOpen(false); btnRef.current?.focus(); onEdit(); }}>
            <span aria-hidden="true">✎</span> Редагувати
          </button>
          <button type="button" role="menuitem" className="wl-menu-item danger" onClick={() => { setOpen(false); btnRef.current?.focus(); onRemove(); }}>
            <span aria-hidden="true">✕</span> Зняти з листа
          </button>
        </div>
      )}
    </div>
  );
}

interface WaitlistBoardProps {
  clinicId: string;
  rooms?: RoomOpt[];
  clinicName?: string;
  adminName?: string;
  adminRole?: string;
  roleKey?: string;
}

export default function WaitlistBoard({ clinicId, rooms, clinicName, adminName, adminRole, roleKey = "admin" }: WaitlistBoardProps) {
  const [entries, setEntries] = useState<WaitlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"waiting" | "scheduled" | "removed">("waiting");
  const [roomView, setRoomView] = useState("all"); // фільтр сайдбара: кабінет → модальність
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editFor, setEditFor] = useState<WaitlistEntry | null>(null);
  const [bookFor, setBookFor] = useState<WaitlistEntry | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<WaitlistEntry | null>(null);
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [toast, setToast] = useState<{ msg: string; type: string; action?: { label: string; onAction: () => void } } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Рядок із запитом «у польоті»: кнопки цього рядка вимкнені (busy-стан).
  const [busyId, setBusyId] = useState<string | null>(null);
  // Вступна підказка ховається назавжди (localStorage), фільтр-банер не чіпаємо.
  const [hintHidden, setHintHidden] = useState(false);
  useEffect(() => {
    try { setHintHidden(localStorage.getItem("rf_waitlist_hint_hidden") === "1"); } catch { /* ignore */ }
  }, []);
  function hideHint() {
    setHintHidden(true);
    try { localStorage.setItem("rf_waitlist_hint_hidden", "1"); } catch { /* ignore */ }
  }

  const canEditPriority = roleKey === "admin";

  function notify(msg: string, type = "success", action?: { label: string; onAction: () => void }) {
    setToast({ msg, type, action });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    // Тост із дією (Undo) живе довше, щоб встигнути натиснути.
    toastTimer.current = setTimeout(() => setToast(null), action ? 6000 : 3000);
  }

  const reload = useCallback(async () => {
    try {
      const supabase = createClient();
      const { data } = await supabase
        .from("waitlist_entries")
        .select("*")
        .eq("clinic_id", clinicId)
        .order("created_at", { ascending: true });
      setEntries(data || []);
    } catch { /* транзієнтний Failed to fetch (оновлення токена) — не валимо дошку */ }
    setLoading(false);
  }, [clinicId]);

  const loadIncidents = useCallback(async () => {
    try {
      const supabase = createClient();
      const { data } = await supabase
        .from("incidents")
        .select("id, room_id, reason_label, note, started_at, blocked_until, status")
        .eq("clinic_id", clinicId).in("status", ["active", "planned"]);
      setIncidents(data || []);
    } catch { /* ignore */ }
  }, [clinicId]);

  useEffect(() => { setLoading(true); }, [clinicId]);
  useEffect(() => { reload(); loadIncidents(); }, [reload, loadIncidents]);

  // TD-3: єдиний realtime-патерн — лист миттєво синхронний в усіх ролях.
  useRealtimeRefetch({
    channelName: clinicId ? "waitlist-" + clinicId : null,
    subscriptions: [
      { table: "waitlist_entries", filter: "clinic_id=eq." + clinicId, onChange: reload },
      { table: "incidents", filter: "clinic_id=eq." + clinicId, onChange: loadIncidents },
    ],
  });

  async function onAdd(w: WaitlistFormOut) {
    const res = await addWaitlistEntry({
      roomId: w.roomId,
      name: w.name, phone: w.phone, email: w.email, dob: w.dob, sex: w.sex, age: w.age, weight: w.weight,
      priorityLevel: w.priorityLevel, studies: w.studies, durationMin: w.durationMin, bufferTimeMin: w.bufferTimeMin,
      desiredDateFrom: w.desiredDateFrom, desiredDateTo: w.desiredDateTo,
      desiredTimeFrom: w.desiredTimeFrom, desiredTimeTo: w.desiredTimeTo, note: w.note,
    });
    if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
    setAddOpen(false);
    notify("Додано до листа очікування: " + w.name, "success");
    reload();
  }

  async function saveBooking(b: BookingPayload) {
    const wl = bookFor;
    if (!wl) return;
    const [hh, mm] = b.time.split(":").map(Number);
    const at = new Date(b.date.getFullYear(), b.date.getMonth(), b.date.getDate(), hh, mm).toISOString();
    const res = await createBooking({
      roomId: b.roomId, referrerId: b.referrerId ?? (wl.referrer_id || null),
      name: b.name, phone: b.phone || null, email: b.email ?? null,
      dob: b.dob || null, sex: b.gender || null, age: b.age || null, weight: b.weight ?? null,
      hasContra: !!b.hasContra, priorityLevel: b.priority,
      studies: b.studies || [], doctor: b.doctor ?? null, notes: b.notes ?? null, durationMin: b.dur, bufferTimeMin: b.buffer,
      scheduledDate: dateKey(b.date), scheduledTime: b.time, scheduledAt: at,
    });
    if (!res.ok) {
      const msg = (res.code === "slot_taken" || res.code === "slot_unavailable")
        ? "Слот щойно зайняли — оберіть інший час"
        : res.code === "incident" ? "Кабінет у простої (поломка/ТО) у цей час — оберіть інший слот або день"
        : "Помилка збереження: " + res.error;
      notify(msg, "error");
      return;
    }
    const mark = await markWaitlistScheduled(wl.id, res.id ?? null);
    if (!mark.ok) notify("Запис створено, але лист не оновився: " + mark.error, "error");
    else notify("Записано зі списку очікування: " + b.name + " · " + b.time, "success");
    setBookFor(null);
    reload();
  }

  // Редагування даних пацієнта/досліджень/вікна в місці ухвалення рішення.
  async function onEditSave(w: WaitlistFormOut) {
    const p = editFor;
    if (!p) return;
    const res = await updateWaitlistEntry(p.id, {
      patient_name: w.name, patient_phone: w.phone, patient_email: w.email,
      patient_dob: w.dob, patient_sex: w.sex, patient_age: w.age, patient_weight: w.weight,
      studies: w.studies, duration_min: w.durationMin, buffer_time_min: w.bufferTimeMin,
      desired_date_from: w.desiredDateFrom, desired_date_to: w.desiredDateTo,
      desired_time_from: w.desiredTimeFrom, desired_time_to: w.desiredTimeTo,
      note: w.note, room_id: w.roomId,
    });
    if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
    setEditFor(null);
    notify("Запис листа оновлено", "success");
    reload();
  }

  async function restore(p: WaitlistEntry) {
    setBusyId(p.id);
    try {
      const res = await setWaitlistStatus(p.id, "waiting");
      if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
      notify("Повернено в очікування", "success");
      reload();
    } finally { setBusyId(null); }
  }
  // Мʼяке зняття + Undo в тості (замість блокуючого підтвердження).
  async function remove(p: WaitlistEntry) {
    setBusyId(p.id);
    try {
      const res = await setWaitlistStatus(p.id, "cancelled");
      if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
      notify("Знято з листа очікування", "info", { label: "Скасувати", onAction: () => restore(p) });
      reload();
    } finally { setBusyId(null); }
  }
  async function setPrio(p: WaitlistEntry, v: PatientPriority) {
    if (p.priority_level === v) return;
    setEntries((es) => es.map((e) => (e.id === p.id ? { ...e, priority_level: v } : e))); // оптимістично
    setBusyId(p.id);
    try {
      const res = await setWaitlistPriority(p.id, v);
      if (!res.ok) { notify("Помилка: " + res.error, "error"); reload(); return; }
      notify("Пріоритет: " + PRIORITY_META[v].label, "success");
    } finally { setBusyId(null); }
  }

  // Фільтр за кабінетом із сайдбара: рядок листа не привʼязаний до кабінету,
  // тому фільтруємо за МОДАЛЬНІСТЮ обраного кабінету (МРТ/КТ).
  const viewRoom = roomView === "all" ? null : (rooms || []).find((r) => r.id === roomView) || null;
  const scoped = useMemo(
    () => (viewRoom ? entries.filter((e) => !e.modality || e.modality === viewRoom.modality) : entries),
    [entries, viewRoom]
  );

  const waiting = useMemo(() => scoped.filter((e) => e.status === "waiting").sort(compareWaitlist), [scoped]);
  const counts = useMemo(() => {
    const c = { waiting: waiting.length, cito: 0, urgent: 0, scheduled: 0, removed: 0 };
    scoped.forEach((e) => {
      if (e.status === "waiting") { if (e.priority_level === "cito") c.cito++; if (e.priority_level === "urgent") c.urgent++; }
      if (e.status === "scheduled") c.scheduled++;
      if (e.status === "cancelled" || e.status === "expired") c.removed++;
    });
    return c;
  }, [scoped, waiting]);

  const listForTab = filter === "waiting" ? waiting
    : scoped.filter((e) => (filter === "scheduled" ? e.status === "scheduled" : e.status === "cancelled" || e.status === "expired"))
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));

  const filtered = listForTab.filter((p) => {
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    return (p.patient_name || "").toLowerCase().includes(q)
      || (p.patient_phone || "").includes(q)
      || procLabel(p).toLowerCase().includes(q);
  });

  const tabs = [
    { key: "waiting" as const, label: "Очікують", ct: counts.waiting },
    { key: "scheduled" as const, label: "Записані", ct: counts.scheduled },
    { key: "removed" as const, label: "Зняті", ct: counts.removed },
  ];

  const stats = [
    { lab: "В очікуванні", val: counts.waiting, color: "var(--green)" },
    { lab: "CITO", val: counts.cito, color: "var(--red)" },
    { lab: "Терміново", val: counts.urgent, color: "var(--orange)" },
    { lab: "Записано", val: counts.scheduled, color: "#4da3ff" },
  ];

  const bookPrefill: BookingPrefill | null = bookFor ? {
    name: bookFor.patient_name, phone: bookFor.patient_phone, email: bookFor.patient_email,
    dob: bookFor.patient_dob, gender: bookFor.patient_sex, weight: bookFor.patient_weight,
    priority: bookFor.priority_level, notes: bookFor.note, buffer: bookFor.buffer_time_min,
    studies: Array.isArray(bookFor.studies) ? (bookFor.studies as Study[]) : [],
  } : null;

  return (
    <div className="app">
      <Sidebar clinicName={clinicName} adminName={adminName} adminRole={adminRole} roleKey={roleKey} rooms={rooms}
        activeNav="waitlist" activeRoom={roomView} onSelectRoom={setRoomView} />
      <div className="main">
        <header className="topbar">
          <div className="tb-title">
            <span className="tic">⏳</span>
            <div>
              <h1>Лист очікування</h1>
              <div className="date">{fmtFull(new Date())} · <LiveClock /></div>
            </div>
          </div>
          <div className="tb-right">
            <button className="btn btn-primary" onClick={() => setAddOpen(true)}>＋ Додати пацієнта</button>
          </div>
        </header>
        <div className="content-full">
          <div className="page-max">
            {!hintHidden && (
              <div className="info-banner">
                <span className="ib-ic" aria-hidden="true">⏳</span>
                <span className="ib-txt"><b>Лист очікування</b> — пацієнти, що чекають на вільне вікно. Коли слот звільняється (скасування, неявка), запишіть підходящого пацієнта кнопкою «Записати». Порядок: CITO → Терміново → Планово.</span>
                <button type="button" className="mini-icon" style={{ flexShrink: 0 }} aria-label="Сховати підказку" onClick={hideHint}>✕</button>
              </div>
            )}

            <div className="stats" role="status">
              {stats.map((s) => (
                <div className="stat" key={s.lab}>
                  <div className="lab">{s.lab}</div>
                  <div className="val tabular" style={{ color: s.color }}>{s.val}</div>
                </div>
              ))}
            </div>

            {viewRoom && (
              <div className="info-banner" style={{ padding: "8px 14px" }}>
                <span className="ib-ic">{viewRoom.modality === "CT" ? "КТ" : "МРТ"}</span>
                <span className="ib-txt">
                  Фільтр за кабінетом <b>{viewRoom.name}</b>: показано пацієнтів модальності {viewRoom.modality === "CT" ? "КТ" : "МРТ"} (лист не привʼязаний до конкретного кабінету).
                </span>
                <button className="btn btn-secondary btn-sm" style={{ flexShrink: 0 }} onClick={() => setRoomView("all")}>✕ Зняти фільтр</button>
              </div>
            )}

            <div className="qctrl">
              <div className="pills">
                {tabs.map((t) => (
                  <button key={t.key} className={"pill" + (filter === t.key ? " active" : "")} onClick={() => setFilter(t.key)}>
                    {t.label}<span className="ct">({t.ct})</span>
                  </button>
                ))}
              </div>
              <div className="spacer" />
              <div className="search"><span className="si">⌕</span>
                <input placeholder="Пошук…" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
            </div>

            <div className="wlhead">
              <div /><div>Пацієнт</div><div>Дослідження</div><div>Бажане вікно</div><div style={{ textAlign: "right" }}>Дії</div>
            </div>
            {loading ? (
              <div className="empty"><div className="et">Завантаження…</div></div>
            ) : filtered.length === 0 ? (
              <div className="empty"><div className="ei">⏳</div><div className="et">Лист порожній</div><div className="es">{listForTab.length === 0 ? "Додайте пацієнта, що чекає на вільне вікно" : "Змініть фільтр або пошук"}</div></div>
            ) : (
              <div className="clrows">
                {filtered.map((p) => {
                  const expanded = expandedId === p.id;
                  const m = PRIORITY_META[p.priority_level];
                  const stMeta = WAITLIST_STATUS_META[p.status];
                  const busy = busyId === p.id;
                  const boundRoom = p.room_id ? (rooms || []).find((r) => r.id === p.room_id) : null;
                  return (
                    <div className={"clrow-wrap" + (expanded ? " open" : "")} key={p.id}>
                      <div className="wlrow">
                        <button className="cl-exp-btn" onClick={() => setExpandedId((x) => (x === p.id ? null : p.id))}
                          title={expanded ? "Згорнути" : "Розгорнути"} aria-label={expanded ? "Згорнути деталі" : "Розгорнути деталі"} aria-expanded={expanded}>
                          <span className={"cl-chev" + (expanded ? " open" : "")} aria-hidden="true">›</span>
                        </button>
                        <div className="wl-pat">
                          <button className="cl-name cl-name-btn wl-name" onClick={() => setExpandedId((x) => (x === p.id ? null : p.id))}>
                            {p.priority_level !== "planned" && p.status === "waiting" && <span className={"prio-tag " + m.tone}>{m.short}</span>}
                            {p.status !== "waiting" && <span className="badge" style={{ marginRight: 6 }}>{stMeta.label}</span>}
                            {p.status === "waiting" ? (
                              <span onClick={(e) => { e.stopPropagation(); setEditFor(p); }}
                                style={{ cursor: "pointer", textDecorationLine: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 3 }}
                                title="Редагувати дані пацієнта та дослідження">{p.patient_name}</span>
                            ) : p.patient_name}
                          </button>
                          <div className="wl-meta">
                            {p.patient_phone && <a className="tel" href={"tel:" + (p.patient_phone || "").replace(/\s/g, "")} title="Подзвонити пацієнту" aria-label={"Подзвонити пацієнту: " + (p.patient_phone || "")}><span aria-hidden="true">☎</span> {p.patient_phone}</a>}
                            <span>Додано: {addedAgo(p.created_at)}</span>
                            {boundRoom && <span title="Жорстка прив'язка до кабінету">Каб.: {boundRoom.name}</span>}
                          </div>
                        </div>
                        <div className="wl-proc-cell">
                          <div className="wl-proc-main">
                            <span className={"wl-mod " + (p.modality === "CT" ? "ct" : "mrt")}>{p.modality === "CT" ? "КТ" : "МРТ"}</span>
                            <span className="cl-proc">{procLabel(p)}</span>
                          </div>
                          <div className="wl-proc-du">{p.duration_min} хв + буфер {p.buffer_time_min} хв</div>
                        </div>
                        <div className="wl-win" title="Бажане вікно для підбору слота">{desiredWindowText(p)}</div>
                        <div className="cl-actions">
                          {/* Дії згорнутого рядка; у розгорнутому — в картці (без дублю «дії»). */}
                          {p.status === "waiting" && !expanded && (
                            <>
                              <button className="btn btn-green btn-sm" disabled={busy} aria-busy={busy} onClick={() => setBookFor(p)}>{busy ? "…" : "Додати в чергу"}</button>
                              <RowMenu disabled={busy} onEdit={() => setEditFor(p)} onRemove={() => setConfirmRemove(p)} />
                            </>
                          )}
                          {(p.status === "cancelled" || p.status === "expired") && (
                            <button className="btn btn-secondary btn-sm" disabled={busy} aria-busy={busy} onClick={() => restore(p)}>{busy ? "…" : "↩ Повернути"}</button>
                          )}
                        </div>
                      </div>
                      {expanded && (
                        <div className="cl-detail fade-in">
                          <div className="cld-grid">
                            <div className="cld-item cld-item-full"><span className="cld-lab">Пацієнт (ПІБ)</span><span className="cld-val cld-name">
                              {p.status === "waiting" ? (
                                <span onClick={() => setEditFor(p)}
                                  style={{ cursor: "pointer", textDecorationLine: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 3 }}
                                  title="Редагувати дані пацієнта та дослідження">{p.patient_name}</span>
                              ) : p.patient_name}
                            </span></div>
                            <div className="cld-item"><span className="cld-lab">Вік</span><span className="cld-val">{p.patient_age != null ? p.patient_age + " р." : "—"}</span></div>
                            <div className="cld-item"><span className="cld-lab">Модальність</span><span className="cld-val"><span className={"cld-type " + (p.modality === "CT" ? "ct" : "mrt")}>{p.modality === "CT" ? "КТ" : "МРТ"}</span></span></div>
                            <div className="cld-item cld-item-full"><span className="cld-lab">Дослідження</span><span className="cld-val cld-val-wrap">{procLabel(p)} · {p.duration_min} хв + буфер {p.buffer_time_min} хв</span></div>
                            <div className="cld-item"><span className="cld-lab">Телефон</span><span className="cld-val"><a className="tel" href={"tel:" + (p.patient_phone || "").replace(/\s/g, "")}>{p.patient_phone}</a></span></div>
                            <div className="cld-item"><span className="cld-lab">Бажане вікно</span><span className="cld-val">{desiredWindowText(p)}</span></div>
                            <div className="cld-item"><span className="cld-lab">Кабінет</span><span className="cld-val">{boundRoom ? boundRoom.name : "Будь-який (за модальністю)"}</span></div>
                            {p.note && <div className="cld-item cld-item-full"><span className="cld-lab">Нотатка</span><span className="cld-val cld-val-wrap">{p.note}</span></div>}
                          </div>
                          {p.status === "waiting" && (
                            <div className="cld-actions" style={{ justifyContent: "space-between" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <span className="cld-lab">Пріоритет:</span>
                                <div className="prio-seg" role="radiogroup" aria-label="Пріоритет пацієнта">
                                  {PRIORITY_OPTIONS.map((pv) => {
                                    const pm = PRIORITY_META[pv];
                                    return (
                                      <button key={pv} type="button" role="radio" aria-checked={p.priority_level === pv}
                                        className={"prio-seg-btn " + pm.tone + (p.priority_level === pv ? " active" : "")}
                                        disabled={!canEditPriority || busy}
                                        title={canEditPriority ? pm.desc : "Змінювати пріоритет може адміністратор або лікар-направник"}
                                        onClick={() => canEditPriority && setPrio(p, pv)}>
                                        {pm.short}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                              {/* Місце ухвалення рішення: одна група дій (у рядку кнопки сховані, поки картку розгорнуто). */}
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <button className="btn btn-green btn-sm" disabled={busy} aria-busy={busy} onClick={() => setBookFor(p)}>{busy ? "…" : "Додати в чергу"}</button>
                                <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setEditFor(p)}><span aria-hidden="true">✎</span> Редагувати</button>
                                <button className="btn btn-secondary btn-sm" style={{ color: "var(--red)" }} disabled={busy} onClick={() => setConfirmRemove(p)}><span aria-hidden="true">✕</span> Зняти з листа</button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {addOpen && <WaitlistModal rooms={rooms} onClose={() => setAddOpen(false)} onSave={onAdd} />}
      {editFor && <WaitlistModal rooms={rooms} initial={editFor} onClose={() => setEditFor(null)} onSave={onEditSave} />}
      {confirmRemove && (
        <ConfirmDialog title="Зняти з листа очікування"
          text={<>Зняти <b style={{ color: "var(--text)" }}>{confirmRemove.patient_name}</b> з листа очікування? Запис перейде на вкладку «Зняті» — його можна буде повернути.</>}
          confirmLabel="Зняти з листа" danger busy={busyId === confirmRemove.id}
          onConfirm={async () => { const p = confirmRemove; setConfirmRemove(null); await remove(p); }}
          onClose={() => setConfirmRemove(null)} />
      )}
      {bookFor && (
        <BookingModal rooms={rooms} clinicId={clinicId} incidents={incidents} prefill={bookPrefill}
          onClose={() => setBookFor(null)} onSave={saveBooking} />
      )}

      <div role="status" aria-live="polite">
        {toast && (
          <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", display: "flex", alignItems: "center", background: "var(--card)", border: "1px solid var(--border-strong)", borderLeft: "4px solid " + (toast.type === "error" ? "var(--red)" : "var(--green)"), borderRadius: 12, padding: "12px 18px", boxShadow: "var(--shadow-pop)", zIndex: 50, fontSize: 13.5 }}>
            <span>{toast.msg}</span>
            {toast.action && (
              <button type="button" className="wl-toast-action"
                onClick={() => { const a = toast.action; setToast(null); if (toastTimer.current) clearTimeout(toastTimer.current); a?.onAction(); }}>
                {toast.action.label}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
