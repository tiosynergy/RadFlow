"use client";

/* ===== RadFlow — Колл-лист (окремий екран) =====
   Записи на завтра (або обраний день) → обдзвін/підтвердження. Статус пишеться у
   queue_entries.call_status (синхронно з дошкою), нотатка — у call_note. Realtime. */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";
import Sidebar from "@/components/Sidebar";
import LiveClock from "@/components/LiveClock";
import { entryInIncidentWindow, incidentExpired, setClinicTz, wallDayKey } from "@/lib/incidents";
import RescheduleModal from "@/components/RescheduleModal";
import StudyEditModal from "@/components/StudyEditModal";
import WaitlistCandidatesModal, { fetchWaitlistCandidates, type FreedSlotInfo } from "@/components/WaitlistCandidatesModal";
import ConfirmDialog from "@/components/ConfirmDialog";
import type { WaitlistEntry } from "@/supabase/types";
import { cancelQueueEntry, setQueueEntryCall, setCallNote, confirmAllCalls, rescheduleQueueEntry, editQueueEntryStudies, setQueueEntryStatus } from "@/app/queue/actions";
import { addEntryToWaitlist } from "@/app/waitlist/actions";
import { isLate } from "@/lib/queueStatus";
import type { CallStatus, Json } from "@/supabase/types";
import { PRIORITY_META, isActiveStatus, type PatientPriority } from "@/lib/priority";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";

type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null };
type CallEntry = {
  id: string; patient_name: string | null; patient_phone: string | null; patient_age: number | null;
  scheduled_time: string | null; duration_min: number | null; buffer_time_min: number | null; status: string; call_status: string | null;
  priority_level?: PatientPriority | null; call_note?: string | null; studies: Json; doctor?: string | null; room_id: string | null; scheduled_date: string | null;
};
type IncidentRow = { id: string; room_id: string; reason_label: string | null; note: string | null; started_at: string; blocked_until: string | null; status: string };

const WK = ["Неділя", "Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця", "Субота"];
const MON_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
function fmtFull(d: Date) { return WK[d.getDay()] + ", " + d.getDate() + " " + MON_GEN[d.getMonth()] + " " + d.getFullYear(); }
function dateKey(d: Date) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function pad(n: number) { return String(n).padStart(2, "0"); }
function shortDate(d: Date) { return pad(d.getDate()) + "." + pad(d.getMonth() + 1); }
function studyKind(e: { studies?: unknown }) {
  const arr = Array.isArray(e.studies) ? (e.studies as Array<{ type?: string }>) : [];
  const s = arr[0] ? arr[0].type : null;
  return s || "МРТ";
}
function procLabel(e: { studies?: unknown; note?: string | null }) {
  const s = Array.isArray(e.studies) ? (e.studies as Array<{ type?: string; region?: string; contrast?: boolean }>) : [];
  if (s.length) return s.map((x) => (x.type || "") + (x.region ? " · " + x.region : "") + (x.contrast ? " з контрастом" : "")).join(" + ");
  return e.note || "—";
}

const CL_META: Record<string, { label: string; cls: string; icon: string }> = {
  not_called: { label: "Ще не дзвонили", cls: "gray", icon: "○" },
  confirmed: { label: "Підтверджено", cls: "green", icon: "✓" },
  no_answer: { label: "Не відповідає", cls: "orange", icon: "✗" },
  to_recall: { label: "Передзвонити", cls: "blue", icon: "↩" },
  declined: { label: "Відмова", cls: "red", icon: "✕" },
};
const CALL_ORDER: Record<string, number> = { not_called: 0, to_recall: 1, no_answer: 2, confirmed: 3, declined: 4 };
const CALL_COLOR: Record<string, string> = { confirmed: "var(--green)", to_recall: "#4da3ff", no_answer: "var(--orange)", declined: "var(--red)", not_called: "var(--text-muted)" };

function StatusBadge({ status }: { status: string | null | undefined }) {
  const key = status || "not_called";
  const m = CL_META[key];
  return <span title={m.label} style={{ fontSize: 17, lineHeight: 1, color: CALL_COLOR[key] }}>☎</span>;
}

interface CallRowProps {
  p: CallEntry;
  roomName: string;
  roomModel?: string;
  dateShort: string;
  expanded: boolean;
  onToggle: (id: string) => void;
  onSet: (id: string, s: CallStatus) => void;
  onNote: (id: string, v: string) => void;
  onReschedule: (p: CallEntry) => void;
  onEditStudies: (p: CallEntry) => void;
}

function CallRow({ p, roomName, roomModel, dateShort, expanded, onToggle, onSet, onNote, onReschedule, onEditStudies }: CallRowProps) {
  const type = studyKind(p);
  return (
    <div className={"clrow-wrap" + (expanded ? " open" : "")}>
      <div className={"clrow " + (p.call_status || "not_called")}>
        <button className="cl-exp-btn" onClick={() => onToggle(p.id)} title={expanded ? "Згорнути" : "Розгорнути"}>
          <span className={"cl-chev" + (expanded ? " open" : "")}>›</span>
        </button>
        <div className="cl-time tabular">{p.scheduled_time}<div className="cl-date">{dateShort}</div></div>
        <button className="cl-name cl-name-btn" onClick={() => onToggle(p.id)}>{p.priority_level && p.priority_level !== "planned" && isActiveStatus(p.status) && <span className={"prio-tag " + PRIORITY_META[p.priority_level].tone} style={{ marginRight: 6 }}>{PRIORITY_META[p.priority_level].short}</span>}{p.patient_name}</button>
        <div><a className="tel" href={"tel:" + (p.patient_phone || "").replace(/\s/g, "")}>☎ {p.patient_phone}</a></div>
        <div className="cl-proc">{procLabel(p)}</div>
        <div className="cl-room">{roomName}{roomModel ? <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{roomModel}</div> : null}</div>
        <div><StatusBadge status={p.call_status} /></div>
        <div>
          <input key={p.id + ":" + (p.call_note || "")} className="note-input" placeholder="Нотатка…" defaultValue={p.call_note || ""} onBlur={(e) => onNote(p.id, e.target.value)} />
        </div>
        <div className="cl-actions">
          {p.call_status === "confirmed" ? (
            <>
              <span className="q-done-lab">✓ Готово</span>
              <button className="mini-icon" title="Скасувати" onClick={() => onSet(p.id, "not_called")}>↩</button>
            </>
          ) : (
            <>
              <button className="btn btn-green btn-sm" title="Підтвердити" onClick={() => onSet(p.id, "confirmed")}>✓</button>
              <button className="mini-icon" title="Не відповідає" style={{ color: "var(--orange)" }} onClick={() => onSet(p.id, "no_answer")}>☏</button>
              <button className="mini-icon" title="Передзвонити" style={{ color: "#4da3ff" }} onClick={() => onSet(p.id, "to_recall")}>↩</button>
            </>
          )}
        </div>
      </div>
      {expanded && (
        <div className="cl-detail fade-in">
          <div className="cld-grid">
            <div className="cld-item cld-item-full"><span className="cld-lab">Пацієнт (ПІБ)</span><span className="cld-val cld-name">{p.patient_name}</span></div>
            <div className="cld-item"><span className="cld-lab">Кабінет</span><span className="cld-val">{roomName}</span></div>
            <div className="cld-item"><span className="cld-lab">Вік</span><span className="cld-val">{p.patient_age != null ? p.patient_age + " р." : "—"}</span></div>
            <div className="cld-item cld-item-full"><span className="cld-lab">Тип дослідження</span><span className="cld-val cld-val-wrap"><span className={"cld-type " + (type === "МРТ" ? "mrt" : "ct")}>{type}</span> {procLabel(p)}</span></div>
            <div className="cld-item"><span className="cld-lab">Телефон</span><span className="cld-val"><a className="tel" href={"tel:" + (p.patient_phone || "").replace(/\s/g, "")}>{p.patient_phone}</a></span></div>
            {p.doctor && <div className="cld-item"><span className="cld-lab">Направник</span><span className="cld-val">{p.doctor}</span></div>}
          </div>
          <div className="cld-actions">
            <span className="cld-lab">Дія:</span>
            <button className="btn btn-green btn-sm" onClick={() => onSet(p.id, "confirmed")}>✓ Підтвердити запис</button>
            <button className="btn btn-secondary btn-sm" onClick={() => onEditStudies(p)}>🩻 Дослідження</button>
            <button className="btn btn-primary btn-sm" onClick={() => onReschedule(p)}>🗓 Перенести на слот</button>
            <button className="btn btn-secondary btn-sm" style={{ color: "var(--orange)" }} onClick={() => onSet(p.id, "no_answer")}>☏ Не відповідає</button>
            <button className="btn btn-secondary btn-sm" style={{ color: "#4da3ff" }} onClick={() => onSet(p.id, "to_recall")}>↩ Передзвонити</button>
            <button className="btn btn-secondary btn-sm" style={{ color: "var(--red)" }} onClick={() => onSet(p.id, "declined")}>✕ Відмова</button>
          </div>
        </div>
      )}
    </div>
  );
}

interface IncidentCallSectionProps {
  incident: IncidentRow;
  roomName: string;
  affected: CallEntry[];
  onReschedule: (p: CallEntry) => void;
  onRecall: (p: CallEntry) => void;
  onRefuse: (p: CallEntry) => void;
}

function IncidentCallSection({ incident, roomName, affected, onReschedule, onRecall, onRefuse }: IncidentCallSectionProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="info-banner red cl-inc-sec" style={{ flexDirection: "column", alignItems: "stretch", borderColor: "var(--red)", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="ib-ic">🔧</span>
        <span className="ib-txt" style={{ flex: 1 }}>
          <b>{roomName} заблоковано</b> — {incident.reason_label || "Поломка"}{incident.note ? " · " + incident.note : ""}.{" "}
          {affected.length > 0
            ? <><b>{affected.length}</b> {affected.length === 1 ? "пацієнт потребує" : "пацієнтів потребують"} обдзвону на перезапис — дзвоніть прямо тут.</>
            : <>Усіх постраждалих опрацьовано ✓</>}
        </span>
      </div>
      {affected.length === 0 ? (
        <div className="cl-inc-empty">У вікні простою активних записів немає.</div>
      ) : (
        <div className="cl-inc-list">
          {affected.map((p) => {
            const isOpen = openId === p.id;
            return (
              <div className={"cl-inc-item" + (isOpen ? " open" : "")} key={p.id}>
                <button className="cl-inc-row" onClick={() => setOpenId((o) => (o === p.id ? null : p.id))}>
                  <span className={"cl-chev" + (isOpen ? " open" : "")}>›</span>
                  <span className="cl-inc-time tabular">{p.scheduled_time}</span>
                  <span className="cl-inc-name">{p.patient_name} · <span style={{ color: "var(--text-muted)" }}>{procLabel(p)}</span></span>
                </button>
                {isOpen && (
                  <div className="cl-inc-detail fade-in">
                    {p.patient_phone && <a className="btn btn-primary btn-sm" href={"tel:" + p.patient_phone.replace(/\s/g, "")}>☎ Подзвонити {p.patient_phone}</a>}
                    <div className="cld-actions" style={{ marginTop: 8 }}>
                      <button className="btn btn-primary btn-sm" onClick={() => onReschedule(p)}>🗓 Перенести на слот</button>
                      <button className="btn btn-secondary btn-sm" style={{ color: "#4da3ff" }} onClick={() => onRecall(p)}>↩ Передзвонити</button>
                      <button className="btn btn-secondary btn-sm" style={{ color: "var(--red)" }} onClick={() => onRefuse(p)}>✕ Відмова</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Секція «Запізнення» (сьогодні): обдзвін пацієнтів, що не прийшли понад буфер ── */
function LateCallSection({ late, roomsById, onReschedule, onRecall, onToWaitlist, onRefuse }: {
  late: CallEntry[];
  roomsById: Record<string, RoomOpt>;
  onReschedule: (p: CallEntry) => void;
  onRecall: (p: CallEntry) => void;
  onToWaitlist: (p: CallEntry) => void;
  onRefuse: (p: CallEntry) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (!late.length) return null;
  return (
    <div className="info-banner red cl-inc-sec" style={{ flexDirection: "column", alignItems: "stretch", borderColor: "var(--red)", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="ib-ic">⏰</span>
        <span className="ib-txt">
          <b>Запізнення сьогодні</b> — <b>{late.length}</b> {late.length === 1 ? "пацієнт не прийшов" : "пацієнтів не прийшли"} понад буферний час.
          Зателефонуйте: перенести на слот, до листа очікування або зафіксувати відмову.
        </span>
      </div>
      <div className="cl-inc-list">
        {late.map((p) => {
          const isOpen = openId === p.id;
          return (
            <div className={"cl-inc-item" + (isOpen ? " open" : "")} key={p.id}>
              <button className="cl-inc-row" onClick={() => setOpenId((o) => (o === p.id ? null : p.id))}>
                <span className={"cl-chev" + (isOpen ? " open" : "")}>›</span>
                <span className="cl-inc-time tabular">{p.scheduled_time}</span>
                <span className="cl-inc-name">{p.patient_name} · <span style={{ color: "var(--text-muted)" }}>{procLabel(p)}{p.room_id && roomsById[p.room_id] ? " · " + roomsById[p.room_id].name : ""}</span></span>
              </button>
              {isOpen && (
                <div className="cl-inc-detail fade-in">
                  {p.patient_phone && <a className="btn btn-primary btn-sm" href={"tel:" + p.patient_phone.replace(/\s/g, "")}>☎ Подзвонити {p.patient_phone}</a>}
                  <div className="cld-actions" style={{ marginTop: 8 }}>
                    <button className="btn btn-primary btn-sm" onClick={() => onReschedule(p)}>🗓 Перенести на слот</button>
                    <button className="btn btn-secondary btn-sm" onClick={() => onToWaitlist(p)} title="Пацієнт чекатиме на вільне вікно">⏳ В лист очікування</button>
                    <button className="btn btn-secondary btn-sm" style={{ color: "#4da3ff" }} onClick={() => onRecall(p)}>↩ Передзвонити</button>
                    <button className="btn btn-secondary btn-sm" style={{ color: "var(--red)" }} onClick={() => onRefuse(p)}>✕ Відмова</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface CallListBoardProps {
  clinicId: string;
  rooms?: RoomOpt[];
  clinicName?: string;
  adminName?: string;
  adminRole?: string;
  roleKey?: string;
}

export default function CallListBoard({ clinicId, rooms, clinicName, adminName, adminRole, roleKey = "admin" }: CallListBoardProps) {
  const tomorrow = useMemo(() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); return d; }, []);
  const [date, setDate] = useState(tomorrow);
  const [entries, setEntries] = useState<CallEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [reschedFor, setReschedFor] = useState<CallEntry | null>(null);
  const [editStudiesFor, setEditStudiesFor] = useState<CallEntry | null>(null);
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [affectedToday, setAffectedToday] = useState<CallEntry[]>([]);
  const [todayScheduled, setTodayScheduled] = useState<CallEntry[]>([]); // для секції «Запізнення»
  const [, setNowTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setNowTick((n) => n + 1), 30000); return () => clearInterval(t); }, []);
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Слот звільнився (відмова) → підходящі кандидати з листа очікування.
  const [wlSuggest, setWlSuggest] = useState<{ slot: FreedSlotInfo; candidates: WaitlistEntry[] } | null>(null);

  // Таймзона клініки (0059). Тримаємо і в стані: від неї залежить, ЯКИЙ день
  // «сьогодні» для секцій «Запізнення» / «постраждалі» — dateKey(new Date())
  // давав день БРАУЗЕРА оператора.
  const [tz, setTz] = useState<string | undefined>(undefined);
  const todayKey = wallDayKey(tz);

  const dayKey = dateKey(date);
  const roomsById = useMemo(() => { const m: Record<string, RoomOpt> = {}; (rooms || []).forEach((r) => { m[r.id] = r; }); return m; }, [rooms]);

  function notify(msg: string, type = "success") {
    setToast({ msg, type });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }

  const reload = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("queue_entries")
      .select("id, patient_name, patient_phone, patient_age, scheduled_time, duration_min, buffer_time_min, status, call_status, priority_level, call_note, studies, doctor, room_id, scheduled_date")
      .eq("clinic_id", clinicId)
      .eq("scheduled_date", dayKey)
      .in("status", ["scheduled", "waiting"])
      .order("scheduled_time", { ascending: true });
    setEntries(data || []);
    setLoading(false);
  }, [clinicId, dayKey]);

  const loadIncidents = useCallback(async () => {
    const supabase = createClient();
    const { data: incs } = await supabase
      .from("incidents")
      .select("id, room_id, reason_label, note, started_at, blocked_until, status")
      .eq("clinic_id", clinicId).in("status", ["active", "planned"]);
    setIncidents(incs || []);
    if (!incs || !incs.length) { setAffectedToday([]); return; }
    const { data: ents } = await supabase
      .from("queue_entries")
      .select("id, patient_name, patient_phone, patient_age, scheduled_time, duration_min, buffer_time_min, status, call_status, priority_level, studies, room_id, scheduled_date")
      .eq("clinic_id", clinicId).gte("scheduled_date", todayKey)
      .in("room_id", incs.map((i) => i.room_id)).in("status", ["scheduled", "waiting"]);
    const byRoom: Record<string, IncidentRow> = {}; incs.forEach((i) => { byRoom[i.room_id] = i; });
    const aff = (ents || []).filter((e) => {
      const inc = e.room_id ? byRoom[e.room_id] : null;
      if (!inc || incidentExpired(inc)) return false;
      return entryInIncidentWindow(e.scheduled_date, e.scheduled_time, inc);
    });
    setAffectedToday(aff);
  }, [clinicId, todayKey]);

  // Записи на СЬОГОДНІ зі статусом scheduled — джерело секції «Запізнення»
  // (обраний день колл-листа за замовчуванням завтра, тому окремий запит).
  const loadTodayScheduled = useCallback(async () => {
    try {
      const supabase = createClient();
      const { data } = await supabase
        .from("queue_entries")
        .select("id, patient_name, patient_phone, patient_age, scheduled_time, duration_min, buffer_time_min, status, call_status, priority_level, studies, doctor, room_id, scheduled_date")
        .eq("clinic_id", clinicId)
        .eq("scheduled_date", todayKey)
        .eq("status", "scheduled")
        .order("scheduled_time", { ascending: true });
      setTodayScheduled(data || []);
    } catch { /* транзієнтний збій — лишаємо попередній список */ }
  }, [clinicId, todayKey]);
  useEffect(() => { loadTodayScheduled(); }, [loadTodayScheduled]);

  // Спинер при первой загрузке/смене клиники; лоадеры снимут его.
  useEffect(() => { setLoading(true); }, [clinicId]);

  // Таймзона клініки → похідні часу рахуються по ній (не по браузеру).
  // Тримаємо і в модульному синглтоні (wallNow() без аргументу), і в стані:
  // від tz залежить todayKey → лоадери «сьогодні» перезапустяться, коли зона прийде.
  useEffect(() => {
    createClient().from("clinics").select("timezone").eq("id", clinicId).single()
      .then(({ data }) => { setClinicTz(data?.timezone ?? null); setTz(data?.timezone ?? undefined); });
  }, [clinicId]);

  // Перезапрос записей при смене дня: realtime-хук слушает только clinicId.
  useEffect(() => { reload(); }, [reload]);

  // TD-3: единый realtime-паттерн.
  useRealtimeRefetch({
    channelName: clinicId ? "calllist-" + clinicId : null,
    subscriptions: [
      { table: "queue_entries", filter: "clinic_id=eq." + clinicId, onChange: () => { reload(); loadIncidents(); loadTodayScheduled(); } },
      { table: "incidents", filter: "clinic_id=eq." + clinicId, onChange: loadIncidents },
    ],
  });

  // Після звільнення слота — запропонувати кандидатів з листа очікування.
  async function suggestWaitlistFor(p: CallEntry) {
    const slot: FreedSlotInfo = { date: p.scheduled_date || dayKey, time: p.scheduled_time, roomId: p.room_id };
    const candidates = await fetchWaitlistCandidates(clinicId, slot, rooms);
    if (candidates.length) setWlSuggest({ slot, candidates });
  }

  /* CAS-промах (аудит H-4): запис уже не в тому стані, який бачить оператор
     колл-листа (пацієнт міг прийти і бути в кабінеті, поки список висів). Показуємо
     причину і перезавантажуємо — мовчки перетирати чужий перехід не можна. */
  function handledStale(res: { ok: boolean; code?: string; error?: string }): boolean {
    if (res.ok || res.code !== "stale") return false;
    notify(res.error || "Стан змінився — оновіть список", "error");
    reload();
    loadIncidents();
    loadTodayScheduled();
    return true;
  }

  async function cancelEntry(p: CallEntry) {
    const res = await cancelQueueEntry(p.id);
    if (!res.ok) {
      if (handledStale(res)) return;
      notify("Помилка: " + res.error, "error");
      return;
    }
    notify("Запис скасовано (відмова)", "success");
    reload(); loadIncidents();
    suggestWaitlistFor(p);
  }

  /* «✕ Відмова» ставить call_status='declined', а це на сервері СКАСОВУЄ запис
     (status → cancelled). Кнопка про це не попереджала — користувач дізнавався з
     тоста постфактум. Тепер деструктивна гілка йде через підтвердження. */
  const [declineAsk, setDeclineAsk] = useState<{ p: CallEntry; mode: "declined" | "cancel" } | null>(null);
  const [declineBusy, setDeclineBusy] = useState(false);
  function setCallGuarded(id: string, call_status: CallStatus) {
    if (call_status !== "declined") { setCall(id, call_status); return; }
    const entry = entries.find((e) => e.id === id) || null;
    if (entry) setDeclineAsk({ p: entry, mode: "declined" });
  }

  async function setCall(id: string, call_status: CallStatus) {
    // Відмова = скасування запису (як на дошці черги); оптимістично локально.
    const entry = entries.find((e) => e.id === id) || null;
    const patch = call_status === "declined" ? { call_status, status: "cancelled" } : { call_status };
    setEntries((es) => es.map((e) => (e.id === id ? { ...e, ...patch } : e)));
    const res = await setQueueEntryCall(id, call_status);
    if (!res.ok) {
      // «Відмова» скасовує запис — сервер відхилить її, якщо пацієнт уже в кабінеті.
      if (handledStale(res)) return;
      notify("Помилка: " + res.error, "error");
      reload();
      return;
    }
    if (call_status === "declined") {
      notify("Пацієнт відмовився — запис скасовано", "info");
      if (entry) suggestWaitlistFor(entry);
    }
    reload();
  }
  async function setNote(id: string, call_note: string) {
    setEntries((es) => es.map((e) => (e.id === id ? { ...e, call_note } : e)));
    const res = await setCallNote(id, call_note);
    if (!res.ok) notify("Помилка збереження нотатки: " + res.error, "error");
  }
  /* «✓ Всіх підтверджено» — масова НЕОЧЕВИДНА дія. Було три проблеми:
     1) підтверджувала ВСІХ за день, ігноруючи активний фільтр/пошук (оператор
        відфільтрував «Не відповідає» — а підтвердились і ті, кому не дзвонили);
     2) без підтвердження — один клік, скасувати нічим;
     3) рапортувала успіх навіть коли RLS не оновила жодного рядка.
     Тепер: діємо рівно на видимий (відфільтрований) список, повз уже
     підтверджених, через ConfirmDialog, і показуємо реальну кількість. */
  const [confirmAllAsk, setConfirmAllAsk] = useState(false);
  const [confirmAllBusy, setConfirmAllBusy] = useState(false);

  async function doConfirmAll(ids: string[]) {
    if (!ids.length) return;
    setConfirmAllBusy(true);
    const res = await confirmAllCalls(ids);
    setConfirmAllBusy(false);
    setConfirmAllAsk(false);
    if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
    if (res.updated === 0) { notify("Жодного запису не оновлено — перевірте доступ і оновіть сторінку", "error"); reload(); return; }
    notify(res.updated === 1 ? "Пацієнта підтверджено" : `Підтверджено пацієнтів: ${res.updated}`, "success");
    reload();
  }

  async function doReschedule({ roomId, date: d, time, dur, buffer, reason }: { roomId: string; date: Date; time: string; dur: number; buffer: number; reason: string }) {
    const p = reschedFor;
    if (!p) return;
    const [hh, mm] = time.split(":").map(Number);
    const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm).toISOString();
    const res = await rescheduleQueueEntry({ id: p.id, roomId, scheduledDate: dateKey(d), scheduledTime: time, scheduledAt: at, durationMin: dur, bufferTimeMin: buffer, callStatus: "confirmed", reason });
    if (!res.ok) {
      if (res.code === "slot_taken") { notify("Слот щойно зайняли — оберіть інший", "error"); return; }
      if (res.code === "past" || res.code === "off_schedule") { notify(res.error, "error"); return; }
      if (res.code === "stale") { setReschedFor(null); handledStale(res); return; }
      setReschedFor(null);
      const msg = res.code === "incident" ? "Кабінет у простої — оберіть інший слот" : res.code === "slot_unavailable" ? "Слот зайнятий — оберіть інший" : "Помилка переносу: " + res.error;
      notify(msg, "error");
      return;
    }
    setReschedFor(null);
    notify("Перенесено · підтверджено", "success");
    reload();
  }
  async function doEditStudies(arr: { type: string; region: string; dur: number }[], meta: { dur: number; buffer?: number }) {
    const p = editStudiesFor;
    if (!p) return;
    const res = await editQueueEntryStudies(p.id, arr as Json, (meta && meta.dur) || p.duration_min || 30, meta?.buffer);
    setEditStudiesFor(null);
    if (!res.ok) {
      if (handledStale(res)) return;
      notify("Помилка: " + res.error, "error");
      return;
    }
    notify("Дослідження оновлено", "success");
    reload();
  }

  function exportCsv() {
    const head = ["Час", "Пацієнт", "Телефон", "Процедура", "Кабінет", "Статус", "Нотатка"];
    const rows = entries.map((e) => [e.scheduled_time, e.patient_name, e.patient_phone || "", procLabel(e), (e.room_id ? roomsById[e.room_id] : undefined)?.name || "", (CL_META[e.call_status || "not_called"]).label, (e.call_note || "").replace(/[\n;]/g, " ")]);
    const csv = [head, ...rows].map((r) => r.map((c) => '"' + String(c ?? "").replace(/"/g, '""') + '"').join(";")).join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "call-list-" + dayKey + ".csv"; a.click();
    URL.revokeObjectURL(url);
    notify("Колл-лист експортовано у CSV", "info");
  }

  const counts: Record<string, number> = { total: entries.length, not_called: 0, confirmed: 0, no_answer: 0, to_recall: 0, declined: 0 };
  entries.forEach((e) => { const s = e.call_status || "not_called"; if (counts[s] != null) counts[s]++; });
  const pct = (n: number) => (counts.total ? Math.round((n / counts.total) * 100) : 0);
  const stats = [
    { lab: "Всього записів", val: counts.total, pct: 100, color: "var(--text-faint)", cls: "" },
    { lab: "Підтверджено", val: counts.confirmed, pct: pct(counts.confirmed), color: "var(--green)", cls: "green" },
    { lab: "Не відповідає", val: counts.no_answer, pct: pct(counts.no_answer), color: "var(--orange)", cls: "orange" },
    { lab: "Передзвонити", val: counts.to_recall, pct: pct(counts.to_recall), color: "#4da3ff", cls: "blue" },
  ];
  const statColor: Record<string, string> = { "": "var(--text)", green: "var(--green)", orange: "var(--orange)", blue: "#4da3ff" };
  const tabs = [
    { key: "all", label: "Всі", ct: counts.total },
    { key: "not_called", label: "Ще не дзвонили", ct: counts.not_called },
    { key: "to_recall", label: "Передзвонити", ct: counts.to_recall },
    { key: "no_answer", label: "Не відповідає", ct: counts.no_answer },
    { key: "confirmed", label: "Підтверджено", ct: counts.confirmed },
  ];

  const filtered = entries.filter((p) => {
    if (filter !== "all" && (p.call_status || "not_called") !== filter) return false;
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      if (!((p.patient_name || "").toLowerCase().includes(q) || (p.patient_phone || "").includes(q) || procLabel(p).toLowerCase().includes(q))) return false;
    }
    return true;
  }).sort((a, b) => {
    const pa = CALL_ORDER[a.call_status || "not_called"] ?? 9, pb = CALL_ORDER[b.call_status || "not_called"] ?? 9;
    if (pa !== pb) return pa - pb;
    return String(a.scheduled_time).localeCompare(String(b.scheduled_time));
  });

  // Масове підтвердження діє на ВИДИМИЙ список (фільтр + пошук), повз уже підтверджених.
  const isNarrowed = filter !== "all" || query.trim().length > 0;
  const confirmTargets = filtered.filter((p) => (p.call_status || "not_called") !== "confirmed");

  return (
    <div className="app">
      <Sidebar clinicName={clinicName} adminName={adminName} adminRole={adminRole} roleKey={roleKey} rooms={rooms} activeNav="calls" />
      <div className="main">
        <header className="topbar">
          <div className="tb-title">
            <span className="tic">☎</span>
            <div>
              <h1>Колл-лист</h1>
              <div className="date">Записи на {fmtFull(date)} · <LiveClock /></div>
            </div>
          </div>
          <div className="tb-right">
            <input className="inp tabular" type="date" value={dayKey} onChange={(e) => { const [y, m, d] = e.target.value.split("-").map(Number); setDate(new Date(y, m - 1, d)); }} style={{ width: 150 }} />
            <button className="btn btn-secondary" onClick={exportCsv}>↧ Експорт</button>
            <button className="btn btn-primary" disabled={loading || confirmTargets.length === 0} onClick={() => setConfirmAllAsk(true)}
              title={isNarrowed ? "Підтвердить лише тих, кого видно за поточним фільтром" : "Підтвердить усіх непідтверджених за цей день"}>
              ✓ Всіх підтверджено{confirmTargets.length ? ` (${confirmTargets.length})` : ""}
            </button>
          </div>
        </header>
        <div className="content-full">
          <div className="page-max">
            {(() => {
              // День «сьогодні» — за настінним часом клініки (той самий, за яким
              // вибрано todayScheduled), інакше isLate рахував би не той день.
              const [ty, tm, td] = todayKey.split("-").map(Number);
              const t0 = new Date(ty, (tm || 1) - 1, td || 1);
              const lateList = todayScheduled.filter((e) => isLate(e.status, t0, e.scheduled_time, e.buffer_time_min));
              return (
                <LateCallSection late={lateList} roomsById={roomsById}
                  onReschedule={(p) => setReschedFor(p)}
                  onRecall={(p) => setCall(p.id, "to_recall")}
                  onToWaitlist={async (p) => {
                    const res = await addEntryToWaitlist(p.id);
                    if (!res.ok) { notify(res.code === "duplicate" ? "Пацієнт уже в листі очікування" : "Помилка: " + res.error, res.code === "duplicate" ? "info" : "error"); return; }
                    // Слот звільняється: запис — «Не відбулося» (термінальний підсумок запізнення).
                    // expectedFrom='scheduled' (CAS): пацієнт міг прийти, поки список висів
                    // — тоді статус не перетираємо, а показуємо, що стан змінився.
                    const upd = await setQueueEntryStatus(p.id, "not_held", "scheduled");
                    if (!upd.ok) notify(
                      upd.code === "stale"
                        ? "Додано до листа, але пацієнт уже не «Заплановано» — перевірте чергу"
                        : "Додано до листа, але статус не оновлено: " + upd.error,
                      "error");
                    else notify("Запізнення: додано до листа очікування, запис — «Не відбулося»", "success");
                    reload(); loadTodayScheduled();
                  }}
                  onRefuse={(p) => setDeclineAsk({ p, mode: "cancel" })} />
              );
            })()}
            {incidents.map((inc) => (
              <IncidentCallSection key={inc.id} incident={inc}
                roomName={roomsById[inc.room_id]?.name || "Апарат"}
                affected={affectedToday.filter((a) => a.room_id === inc.room_id)}
                onReschedule={(p) => setReschedFor(p)}
                onRecall={(p) => setCall(p.id, "to_recall")}
                onRefuse={(p) => setDeclineAsk({ p, mode: "cancel" })} />
            ))}
            <div className="info-banner">
              <span className="ib-ic">🤖</span>
              <span className="ib-txt"><b>Обдзвін напередодні</b> — зателефонуйте кожному пацієнту, що записаний на цей день, і зафіксуйте статус. Статус миттєво синхронізується з чергою.</span>
            </div>

            <div className="cl-stats">
              {stats.map((s) => (
                <div className="cl-stat" key={s.lab}>
                  <div className="lab">{s.lab}</div>
                  <div className="val tabular" style={{ color: statColor[s.cls] }}>{loading ? "—" : s.val}</div>
                  <div className="mini-bar"><div className="mini-fill" style={{ width: s.pct + "%", background: s.color }} /></div>
                </div>
              ))}
            </div>

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

            <div className="clhead">
              <div /><div>Час</div><div>Пацієнт</div><div>Телефон</div><div>Процедура</div>
              <div>Кабінет</div><div>Статус</div><div>Нотатка</div><div style={{ textAlign: "right" }}>Дії</div>
            </div>
            {loading ? (
              <div className="empty"><div className="et">Завантаження…</div></div>
            ) : filtered.length === 0 ? (
              <div className="empty"><div className="ei">☎</div><div className="et">Немає записів</div><div className="es">{entries.length === 0 ? "На цей день записів немає" : "Змініть фільтр або пошук"}</div></div>
            ) : (
              <div className="clrows">
                {filtered.map((p) => (
                  <CallRow key={p.id} p={p} roomName={(p.room_id ? roomsById[p.room_id] : undefined)?.name || "—"} roomModel={(p.room_id ? roomsById[p.room_id] : undefined)?.apparatus_model || ""} dateShort={shortDate(date)}
                    expanded={expandedId === p.id} onToggle={(id) => setExpandedId((x) => (x === id ? null : id))}
                    onSet={setCallGuarded} onNote={setNote} onReschedule={(pt) => setReschedFor(pt)} onEditStudies={(pt) => setEditStudiesFor(pt)} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {reschedFor && (
        <RescheduleModal patient={reschedFor} rooms={rooms} clinicId={clinicId} incidents={incidents} onClose={() => setReschedFor(null)} onConfirm={doReschedule} />
      )}
      {editStudiesFor && (
        <StudyEditModal patient={editStudiesFor} scheduledDate={dayKey} rooms={rooms} onClose={() => setEditStudiesFor(null)} onConfirm={doEditStudies} />
      )}

      {declineAsk && (
        <ConfirmDialog
          title="Скасувати запис пацієнта?"
          text={<>«Відмова» скасовує запис <b>{declineAsk.p.patient_name}</b> о <b>{declineAsk.p.scheduled_time}</b>: статус стане «Скасовано», слот звільниться. Якщо пацієнт просто не бере слухавку — оберіть «Не відповідає» або «Передзвонити».</>}
          confirmLabel="✕ Так, скасувати запис"
          cancelLabel="Ні, залишити"
          danger
          busy={declineBusy}
          onClose={() => setDeclineAsk(null)}
          onConfirm={async () => {
            const a = declineAsk;
            if (!a) return;
            setDeclineBusy(true);
            if (a.mode === "declined") await setCall(a.p.id, "declined");
            else await cancelEntry(a.p);
            setDeclineBusy(false);
            setDeclineAsk(null);
          }}
        />
      )}

      {confirmAllAsk && (
        <ConfirmDialog
          title="Підтвердити обдзвін масово?"
          text={<>
            Статус «Підтверджено» отримають <b>{confirmTargets.length}</b> {confirmTargets.length === 1 ? "пацієнт" : "пацієнтів"} на <b>{fmtFull(date)}</b>
            {isNarrowed ? <> — <b>лише ті, кого видно за поточним фільтром</b> ({tabs.find((t) => t.key === filter)?.label || "Всі"}{query.trim() ? ` · пошук «${query.trim()}»` : ""}).</> : <> — усі, кому статус ще не проставлено.</>}
            {" "}Дію не можна скасувати однією кнопкою — статус доведеться міняти вручну.
          </>}
          confirmLabel={`✓ Підтвердити (${confirmTargets.length})`}
          cancelLabel="Скасувати"
          busy={confirmAllBusy}
          onClose={() => setConfirmAllAsk(false)}
          onConfirm={() => doConfirmAll(confirmTargets.map((p) => p.id))}
        />
      )}

      {wlSuggest && (
        <WaitlistCandidatesModal clinicId={clinicId} rooms={rooms} incidents={incidents}
          slot={wlSuggest.slot} candidates={wlSuggest.candidates}
          onClose={() => setWlSuggest(null)}
          onBooked={(msg) => { notify(msg, "success"); reload(); }}
          onError={(msg) => notify(msg, "error")} />
      )}

      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "var(--card)", border: "1px solid var(--border-strong)", borderLeft: "4px solid " + (toast.type === "error" ? "var(--red)" : "var(--green)"), borderRadius: 12, padding: "12px 18px", boxShadow: "var(--shadow-pop)", zIndex: 50, fontSize: 13.5 }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
