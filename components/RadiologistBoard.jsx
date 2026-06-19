"use client";

/* ===== RadFlow — Кабінет радіолога =====
   Портовано з radiologist-app.jsx. Радіолог бачить чергу авторизованих кабінетів,
   виставляє статус дослідження (queue_entries.status — синхронно з дошкою через
   Realtime) і пише нотатки (radiologist_note). Перенос/редактор — лише в адміна. */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { needsClarification, CLARIFY_META } from "@/lib/queueStatus";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";
import "@/styles/prototype/radiologist.css";

const WK = ["Неділя", "Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця", "Субота"];
const WK_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
const MON_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
const MON_NOM = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function today0() { return startOfDay(new Date()); }
function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function dowMon(d) { return (d.getDay() + 6) % 7; }
function fmtFull(d) { return WK[d.getDay()] + ", " + d.getDate() + " " + MON_GEN[d.getMonth()] + " " + d.getFullYear(); }
function dateKey(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function modalityLabel(m) { return m === "MRI" ? "МРТ" : m === "CT" ? "КТ" : "Інше"; }
function procLabel(e) {
  const s = Array.isArray(e.studies) ? e.studies : [];
  if (s.length) return s.map((x) => (x.type || "") + (x.region ? " · " + x.region : "") + (x.contrast ? " з контрастом" : "")).join(" + ");
  return e.note || "—";
}
function regionOf(e) {
  const s = Array.isArray(e.studies) ? e.studies : [];
  return s.map((x) => x.region).filter(Boolean).join(", ");
}
function genderLabel(e) {
  if (e.patient_sex === "Ж") return "Жін."; if (e.patient_sex === "М") return "Чол.";
  const last = (e.patient_name || "").trim().split(/\s+/).pop() || "";
  return /(вна|чна)$/.test(last) ? "Жін." : "Чол.";
}
function fmtTimer(sec) {
  const m = Math.floor(sec / 60), s = sec % 60, h = Math.floor(m / 60);
  if (h) return h + ":" + String(m % 60).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  return m + ":" + String(s).padStart(2, "0");
}

const ST = {
  scheduled: { label: "В черзі", cls: "gray" },
  waiting: { label: "Очікує", cls: "yellow" },
  in_progress: { label: "В кабінеті", cls: "blue", dot: true },
  done: { label: "Виконано", cls: "green" },
  no_show: { label: "Неявка", cls: "red" },
  not_held: { label: "Не відбулося", cls: "orange" },
  cancelled: { label: "Скасовано", cls: "gray" },
};
const RAD_STATUSES = [
  { key: "scheduled", label: "В черзі", cls: "gray" },
  { key: "waiting", label: "Очікує", cls: "yellow" },
  { key: "in_progress", label: "В кабінеті", cls: "blue" },
  { key: "done", label: "Виконано", cls: "green" },
  { key: "no_show", label: "Не відбулось", cls: "red" },
];
const FLOW = { in_progress: 0, waiting: 1, scheduled: 2, done: 3, no_show: 4 };
const CL_META = {
  not_called: { label: "Не дзвонили", cls: "gray", icon: "○" },
  confirmed: { label: "Підтверджено", cls: "green", icon: "✓" },
  no_answer: { label: "Не відповідає", cls: "orange", icon: "✗" },
  to_recall: { label: "Передзвонити", cls: "blue", icon: "↩" },
  declined: { label: "Відмова", cls: "red", icon: "✕" },
};
const STAT_ITEMS = [
  { key: "all", lab: "Всього", sub: "досліджень", cls: "white" },
  { key: "scheduled", lab: "В черзі", sub: "записані", cls: "gray" },
  { key: "waiting", lab: "Очікують", sub: "прийшли", cls: "yellow" },
  { key: "in_progress", lab: "В кабінеті", sub: "зараз", cls: "blue" },
  { key: "done", lab: "Виконано", sub: "досліджень", cls: "green" },
  { key: "no_show", lab: "Не відбулось", sub: "неявка", cls: "red" },
];

function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  return <span className="rad-clock tabular">🕐 {now.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>;
}
function LiveTimer({ enteredAt, children }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const sec = enteredAt ? Math.max(0, Math.floor((now - new Date(enteredAt).getTime()) / 1000)) : 0;
  return children(sec);
}

function StatsBar({ counts, filter, setFilter }) {
  return (
    <div className="stats">
      {STAT_ITEMS.map((s) => (
        <div key={s.key} className={"stat clickable" + (filter === s.key ? " active" : "")} role="button" tabIndex={0} onClick={() => setFilter(s.key)}>
          <div className="lab">{s.lab}</div>
          <div className={"val tabular " + s.cls}>{s.key === "all" ? counts.total : counts[s.key]}</div>
          <div className="sub">{s.sub}</div>
        </div>
      ))}
    </div>
  );
}

function Info({ label, value, wide }) {
  return (
    <div className={"pd-info" + (wide ? " wide" : "")}>
      <span className="pd-info-lab">{label}</span>
      <span className="pd-info-val">{value}</span>
    </div>
  );
}

function PatientDetail({ p, roomName, roomModel, date, readOnly, onStatus, onSaveNote }) {
  const meta = ST[p.status] || ST.scheduled;
  const [note, setNote] = useState(p.radiologist_note || "");
  useEffect(() => { setNote(p.radiologist_note || ""); }, [p.id, p.radiologist_note]);
  const cs = p.call_status || "not_called";
  const cm = CL_META[cs];
  return (
    <div className="pd">
      <div className="pd-grid">
        <Info label="Процедура" value={procLabel(p)} wide />
        <Info label="Кабінет / Апарат" value={roomName + (roomModel ? " · " + roomModel : "")} />
        {date && <Info label="Дата" value={fmtFull(date)} />}
        <Info label="Час · Тривалість" value={p.scheduled_time + " · " + p.duration_min + " хв"} />
        <Info label="Контраст" value={p.has_contrast ? "З контрастом" : "Без контрасту"} />
        <Info label="Вага пацієнта" value={p.patient_weight != null ? p.patient_weight + " кг" : "—"} />
        <Info label="Протипоказання" value={p.contraindications ? <span className="badge red">є</span> : "немає"} />
        <Info label="Дзвінок-підтвердження" value={<span className={"qd-call " + cm.cls} title="Лише перегляд — керує адмін/колл-лист">{cm.icon} {cm.label}</span>} />
        <Info label="Лікар-направник" value={p.doctor || "—"} wide />
        {p.indication && <Info label="Показання" value={p.indication} wide />}
        {p.note && <Info label="Примітка запису" value={p.note} wide />}
      </div>

      {!readOnly && (
        <div className="pd-status-ctrl">
          <span className="pd-field-lab">Статус дослідження</span>
          <div className="status-seg">
            {RAD_STATUSES.map((s) => {
              const lockDone = s.key === "done" && p.status !== "in_progress";
              return (
                <button key={s.key} disabled={lockDone}
                  className={"ss-btn " + s.cls + (p.status === s.key ? " active" : "") + (lockDone ? " locked" : "")}
                  title={lockDone ? "«Виконано» доступне лише коли пацієнт у кабінеті" : ""}
                  onClick={() => { if (!lockDone) onStatus(p.id, s.key); }}>
                  <span className={"ss-dot " + s.cls} />{s.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {!readOnly && p.status === "in_progress" && (
        <div className="pd-timer-card">
          <LiveTimer enteredAt={p.in_progress_at || p.updated_at}>{(sec) => {
            const over = sec > (p.duration_min || 30) * 60;
            return <span className={"pd-timer tabular" + (over ? " over" : "")}>◷ {fmtTimer(sec)} <span className="pd-timer-lab">{over ? "перевищено час" : "у кабінеті"}</span></span>;
          }}</LiveTimer>
        </div>
      )}

      <div className="pd-notes">
        <span className="pd-field-lab">Примітки радіолога {!readOnly && <span className="pd-autosave">· автозбереження</span>}</span>
        <textarea className="pd-textarea" rows={3} placeholder={readOnly ? "—" : "Внутрішня нотатка (видно команді)…"} value={note} disabled={readOnly}
          onChange={(e) => setNote(e.target.value)} onBlur={(e) => onSaveNote(p.id, e.target.value)} />
      </div>
    </div>
  );
}

function RadQueueRow({ p, roomName, roomModel, roomKind, date, expanded, onToggle, readOnly, onStatus, onSaveNote }) {
  const meta = needsClarification(p.status, date, p.scheduled_time) ? CLARIFY_META : (ST[p.status] || ST.scheduled);
  return (
    <div className={"qrow-item " + p.status + (expanded ? " open" : "")} data-qrow={p.id}>
      <div className="qrow" role="button" tabIndex={0} onClick={() => onToggle(p.id)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(p.id); } }}>
        <div className="q-time tabular">{p.scheduled_time}<div className="td">{p.duration_min} хв</div></div>
        <div className="q-pat">
          <div className="nm">{p.cito && <span className="cito-tag">CITO</span>}{p.patient_name}</div>
          <div className="det">{p.patient_age != null ? p.patient_age + " р. · " : ""}{genderLabel(p)}</div>
        </div>
        <div className="q-proc">
          <div className="pp">{procLabel(p)}</div>
          <div className="du">{roomKind}{regionOf(p) ? " · " + regionOf(p) : ""}</div>
        </div>
        <div className="q-room"><b>{roomName}</b>{roomModel}</div>
        <div className="rqrow-status">
          <span className={"badge " + meta.cls} title={meta.title}>{meta.dot && <span className="pulse-dot" style={{ width: 6, height: 6 }} />}{meta.label}</span>
        </div>
        <span className={"q-chev" + (expanded ? " open" : "")} aria-hidden>›</span>
      </div>
      <div className="qrow-detail-wrap">
        <div className="qrow-detail-inner">
          <div className="qrow-detail">
            <PatientDetail p={p} roomName={roomName} roomModel={roomModel} date={date} readOnly={readOnly} onStatus={onStatus} onSaveNote={onSaveNote} />
          </div>
        </div>
      </div>
    </div>
  );
}

function MiniCalendar({ selectedDate, onSelectDate }) {
  const today = today0();
  const [viewMonth, setViewMonth] = useState(() => new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1));
  const shift = (n) => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));
  const y = viewMonth.getFullYear(), mo = viewMonth.getMonth();
  const first = new Date(y, mo, 1);
  const days = new Date(y, mo + 1, 0).getDate();
  const startIdx = dowMon(first);
  const cells = [];
  for (let i = 0; i < startIdx; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  return (
    <div className="bk-cal">
      <div className="cal-head">
        <span className="cal-month">{MON_NOM[mo]} {y}</span>
        <div className="cal-nav">
          <button className="mini-icon" style={{ width: 24, height: 24 }} onClick={() => shift(-1)}>‹</button>
          <button className="mini-icon" style={{ width: 24, height: 24 }} onClick={() => shift(1)}>›</button>
        </div>
      </div>
      <div className="cal-grid">
        {WK_SHORT.map((d) => <div className="cal-dow" key={d}>{d}</div>)}
        {cells.map((d, i) => {
          if (d === null) return <div className="cal-day empty-day" key={"e" + i} />;
          const cd = new Date(y, mo, d);
          const isToday = sameDay(cd, today);
          const isSel = sameDay(cd, selectedDate);
          const isSunday = cd.getDay() === 0;
          return (
            <button key={d} className={"cal-day" + (isToday ? " today" : "") + (isSel && !isToday ? " selected" : "") + (isSunday ? " holiday" : "")} onClick={() => onSelectDate(startOfDay(cd))}>{d}</button>
          );
        })}
      </div>
    </div>
  );
}

function RadSidebar({ rooms, roomFilter, setRoomFilter, counts, adminName }) {
  const router = useRouter();
  const single = (rooms || []).length === 1;
  const initials = (() => { const p = String(adminName || "").trim().split(/\s+/); return ((p[0] || "Р")[0] + (p[1] ? p[1][0] : "")).toUpperCase(); })();
  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }
  return (
    <aside className="sidebar">
      <div className="sb-head">
        <a href="/queue" className="sb-logo"><span className="dot" />RadFlow</a>
        <div className="sb-sub">Радіолог · робоче місце</div>
      </div>
      <nav className="sb-nav">
        <div className="sb-section">
          <div className="sb-label">Авторизовані кабінети</div>
          {!single && (
            <button className={"sb-cab sb-cab-btn" + (roomFilter === "all" ? " active" : "")} style={{ width: "100%", textAlign: "left", border: "none", cursor: "pointer" }} onClick={() => setRoomFilter("all")}>
              <span className="sb-cab-tile" style={{ background: "var(--card-hover)", color: "var(--text-secondary)" }}>▦</span>
              <span className="sb-cab-meta"><span className="sb-cab-name">Усі кабінети</span><span className="sb-cab-model">{(rooms || []).length} апаратів · {counts.total} у черзі</span></span>
            </button>
          )}
          {(rooms || []).map((r) => (
            <button key={r.id} className={"sb-cab sb-cab-btn" + (roomFilter === r.id ? " active" : "")} style={{ width: "100%", textAlign: "left", border: "none", cursor: "pointer" }} onClick={() => setRoomFilter(r.id)}>
              <span className={"sb-cab-tile " + (r.modality === "MRI" ? "mrt" : "ct")}>{modalityLabel(r.modality)}</span>
              <span className="sb-cab-meta"><span className="sb-cab-name">{r.name}</span><span className="sb-cab-model">{r.apparatus_model || ""}</span></span>
            </button>
          ))}
        </div>
        <div className="sb-section">
          <div className="sb-label">Перейти</div>
          <a href="/queue" className="sb-item"><span className="ic">▦</span><span className="sb-item-lab">Дошка черги</span></a>
          <a href="/radiologist" className="sb-item"><span className="ic">⌂</span><span className="sb-item-lab">Моя черга</span></a>
        </div>
      </nav>
      <div className="sb-user">
        <div className="avatar" style={{ background: "linear-gradient(135deg,#30d158,#1a7a36)" }}>{initials}</div>
        <div className="meta"><div className="nm">{adminName || "Радіолог"}</div><div className="rl">Радіолог</div></div>
        <button onClick={signOut} title="Вийти з акаунта" aria-label="Вийти"
          style={{ marginLeft: "auto", background: "transparent", border: "1px solid var(--border-strong)", color: "var(--text-secondary)", borderRadius: 8, padding: "6px 10px", fontSize: 12.5, cursor: "pointer" }}>
          Вийти
        </button>
      </div>
    </aside>
  );
}

export default function RadiologistBoard({ clinicId, rooms, adminName }) {
  const single = (rooms || []).length === 1;
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [roomFilter, setRoomFilter] = useState(single ? (rooms[0] || {}).id || "all" : "all");
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [expandedRow, setExpandedRow] = useState(null);
  const [selectedDate, setSelectedDate] = useState(() => today0());
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const today = today0();
  const isToday = sameDay(selectedDate, today);
  const isPast = selectedDate < today;
  const readOnly = isPast;
  const dayKey = dateKey(selectedDate);
  const roomsById = useMemo(() => { const m = {}; (rooms || []).forEach((r) => { m[r.id] = r; }); return m; }, [rooms]);

  function notify(msg, type = "success") {
    setToast({ msg, type });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }

  const roomIds = useMemo(() => (rooms || []).map((r) => r.id), [rooms]);

  const reload = useCallback(async () => {
    const supabase = createClient();
    let q = supabase
      .from("queue_entries")
      .select("id, patient_name, patient_phone, patient_age, patient_sex, patient_weight, scheduled_time, duration_min, status, call_status, studies, has_contrast, contraindications, cito, doctor, note, radiologist_note, indication, room_id, updated_at, in_progress_at")
      .eq("clinic_id", clinicId)
      .eq("scheduled_date", dayKey)
      .neq("status", "cancelled");
    if (roomIds.length) q = q.in("room_id", roomIds); // доступ лише до авторизованих кабінетів
    const { data } = await q.order("scheduled_time", { ascending: true });
    setEntries(data || []);
    setLoading(false);
  }, [clinicId, dayKey, roomIds]);

  useEffect(() => {
    setLoading(true);
    reload();
    const supabase = createClient();
    const channel = supabase
      .channel("rad-" + clinicId)
      .on("postgres_changes", { event: "*", schema: "public", table: "queue_entries", filter: "clinic_id=eq." + clinicId }, () => reload())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [clinicId, reload]);

  async function setStatus(id, status) {
    const cur = entries.find((e) => e.id === id);
    if (status === "done" && cur && cur.status !== "in_progress") { notify("«Виконано» можна лише для пацієнта в кабінеті", "error"); return; }
    const supabase = createClient();
    const nowIso = new Date().toISOString();
    // Момент входу в кабінет фіксуємо окремо (синхронно з дошкою — для коректного таймера).
    const patch = status === "in_progress" ? { status, in_progress_at: nowIso } : { status };
    const { error } = await supabase.from("queue_entries").update(patch).eq("id", id);
    if (error) {
      let msg;
      if (status === "in_progress" && /in_progress|duplicate|23505/i.test(error.message)) msg = "У кабінеті вже є пацієнт — спершу завершіть поточного";
      else if (/incident/i.test(error.message)) msg = "Кабінет у простої (поломка/ТО) — дію заблоковано";
      else if (/overlap|exclusion/i.test(error.message)) msg = "Слот недоступний — перенесіть пацієнта";
      else msg = "Помилка: " + error.message;
      notify(msg, "error"); return;
    }
    setEntries((es) => es.map((e) => (e.id === id ? { ...e, ...patch, updated_at: nowIso } : e)));
    reload();
  }
  async function saveNote(id, radiologist_note) {
    const supabase = createClient();
    await supabase.from("queue_entries").update({ radiologist_note }).eq("id", id);
    setEntries((es) => es.map((e) => (e.id === id ? { ...e, radiologist_note } : e)));
  }

  const scoped = roomFilter === "all" ? entries : entries.filter((e) => e.room_id === roomFilter);
  const counts = { total: scoped.length, scheduled: 0, waiting: 0, in_progress: 0, done: 0, no_show: 0 };
  scoped.forEach((e) => { if (counts[e.status] != null) counts[e.status]++; });
  const cito = scoped.filter((e) => e.cito && (e.status === "waiting" || e.status === "in_progress"));

  const filtered = scoped.filter((p) => {
    if (filter !== "all" && p.status !== filter) return false;
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      if (!((p.patient_name || "").toLowerCase().includes(q) || procLabel(p).toLowerCase().includes(q) || (p.patient_phone || "").includes(q))) return false;
    }
    return true;
  }).sort((a, b) => {
    const d = (FLOW[a.status] ?? 9) - (FLOW[b.status] ?? 9);
    if (d !== 0) return d;
    return (a.scheduled_time || "").localeCompare(b.scheduled_time || "");
  });

  return (
    <div className="app">
      <RadSidebar rooms={rooms} roomFilter={roomFilter} setRoomFilter={setRoomFilter} counts={counts} adminName={adminName} />
      <div className="main">
        <header className="topbar">
          <div className="tb-title">
            <span className="tic">🩺</span>
            <div><h1>Кабінет радіолога</h1><div className="date">{adminName} · Радіолог</div></div>
          </div>
          <div className="tb-right">
            <span className="rad-date">{fmtFull(selectedDate)}</span>
            <LiveClock />
            <span className="rt-pill"><span className="pulse-dot" style={{ background: "var(--green)", width: 7, height: 7 }} />Real-time</span>
            <span className="rad-counter">Опрацьовано: <b>{counts.done}</b> / {counts.total}</span>
          </div>
        </header>
        <div className="content-wrap">
          <div className="content">
            {!isToday && (
              <div className="day-banner" style={{ marginBottom: 14 }}>
                <span className="db-ic">{isPast ? "🗂" : "📅"}</span>
                <div className="db-meta">
                  <div className="db-title">{fmtFull(selectedDate)}</div>
                  <div className="db-sub">{counts.total === 0 ? "Записів немає" : (isPast ? "Архів — день завершено · лише перегляд" : "Заплановані дослідження") + " · " + counts.total + " записів"}</div>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => setSelectedDate(today0())}>← Сьогодні</button>
              </div>
            )}

            <StatsBar counts={counts} filter={filter} setFilter={setFilter} />

            {cito.length > 0 && (
              <div className="inc-banner fade-in" style={{ borderColor: "var(--red)" }}>
                <span className="inc-banner-ic">🔴</span>
                <div className="inc-banner-txt">
                  <div className="inc-banner-title">Термінові (CITO): {cito.length}</div>
                  <div className="inc-banner-sub">{cito.slice(0, 3).map((e) => e.patient_name.split(" ").slice(0, 2).join(" ")).join(" · ")}</div>
                </div>
              </div>
            )}

            <div className="qctrl">
              <div className="spacer" />
              <div className="search"><span className="si">⌕</span>
                <input placeholder="Пошук пацієнта…" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
            </div>

            {loading ? (
              <div className="empty"><div className="et">Завантаження…</div></div>
            ) : filtered.length === 0 ? (
              <div className="empty"><div className="ei">⌕</div><div className="et">Нічого не знайдено</div><div className="es">Змініть фільтр, кабінет або пошук</div></div>
            ) : (
              <>
                <div className="qhead">
                  <div>Час</div><div>Пацієнт</div><div>Дослідження</div><div>Кабінет</div><div>Статус</div><div />
                </div>
                <div className="qrows">
                  {filtered.map((p) => {
                    const r = roomsById[p.room_id] || {};
                    return (
                      <RadQueueRow key={p.id} p={p} roomName={r.name || "—"} roomModel={r.apparatus_model || ""} roomKind={modalityLabel(r.modality)}
                        date={selectedDate} expanded={expandedRow === p.id} onToggle={(id) => setExpandedRow((x) => (x === id ? null : id))}
                        readOnly={readOnly} onStatus={setStatus} onSaveNote={saveNote} />
                    );
                  })}
                </div>
              </>
            )}
          </div>
          <aside className="rpanel">
            <MiniCalendar selectedDate={selectedDate} onSelectDate={setSelectedDate} />
          </aside>
        </div>
      </div>

      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "var(--card)", border: "1px solid var(--border-strong)", borderLeft: "4px solid " + (toast.type === "error" ? "var(--red)" : "var(--green)"), borderRadius: 12, padding: "12px 18px", boxShadow: "var(--shadow-pop)", zIndex: 50, fontSize: 13.5 }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
