"use client";

/* ===== RadFlow — Referral Portal 2.0 (крос-клінічний портал направників) =====
   Глобальний направник працює з кількома центрами через referral_access.
   Вкладки: «Нове направлення» (вибір центру → кабінет → слот), «Мої направлення»
   (крос-клінічний список + перезапис + скасування), «Мої центри» (керування
   доступом: запит/прийняття/відхилення/відкликання).
   Зайнятість слотів — через знеособлений RPC room_busy_slots (без PII).
   Realtime — один канал за created_by на всі центри. */

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import LiveClock from "@/components/LiveClock";
import PatientEditModal from "@/components/PatientEditModal";
import RescheduleModal from "@/components/RescheduleModal";
import { roomScheduleFor } from "@/lib/schedule";
import { slotBlockedByIncidents } from "@/lib/incidents";
import { regionsFor, studyPrice, diffStudies, studiesChanged, studyText } from "@/lib/studies";
import "@/styles/prototype/radflow.css";

function pad(n) { return String(n).padStart(2, "0"); }
function toMin(t) { const p = String(t || "").split(":"); return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0); }
function fmt(m) { return pad(Math.floor(m / 60)) + ":" + pad(m % 60); }
function dateVal(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function calcAge(dob) { if (!dob) return null; return Math.floor((Date.now() - new Date(dob).getTime()) / (365.25 * 24 * 3600 * 1000)); }
function modalityLabel(m) { return m === "MRI" ? "МРТ" : m === "CT" ? "КТ" : "Інше"; }
function procLabel(e) {
  const s = Array.isArray(e.studies) ? e.studies : [];
  if (s.length) return s.map((x) => (x.type || "") + (x.region ? " · " + x.region : "")).join(" + ");
  return e.note || "—";
}
function centerLabel(c) { return c ? c.name + (c.city ? " · " + c.city : "") : "—"; }

const ST = {
  scheduled: { label: "Очікує", cls: "gray" },
  waiting: { label: "В роботі", cls: "blue" },
  in_progress: { label: "В роботі", cls: "blue" },
  done: { label: "Виконано", cls: "green" },
  no_show: { label: "Не відбулося", cls: "red" },
  not_held: { label: "Не відбулося", cls: "gray" },
  cancelled: { label: "Скасовано", cls: "gray" },
};
const FILTERS = [
  { key: "all", label: "Усі" },
  { key: "scheduled", label: "Очікує" },
  { key: "active", label: "В роботі" },
  { key: "done", label: "Виконано" },
  { key: "no_show", label: "Не відбулося" },
];
const ACCESS_ST = {
  active: { label: "Активний", cls: "green" },
  pending_clinic: { label: "Очікує підтвердження центру", cls: "yellow" },
  pending_referrer: { label: "Запрошення центру", cls: "blue" },
  revoked: { label: "Відкликано", cls: "gray" },
  declined: { label: "Відхилено", cls: "gray" },
};

async function postJSON(url, body) {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  } catch { return { ok: false, data: { error: "Помилка зʼєднання із сервером" } }; }
}

/* ---------- Вкладка «Нове направлення» ---------- */
function NewReferral({ activeCenters, roomsByClinic, doctorName, doctorId, onCreated }) {
  const [centerId, setCenterId] = useState(() => (activeCenters[0] ? activeCenters[0].clinicId : ""));
  const [name, setName] = useState("");
  const [dob, setDob] = useState("");
  const [phone, setPhone] = useState("");
  const [studyType, setStudyType] = useState("МРТ");
  const [region, setRegion] = useState("");
  const [comment, setComment] = useState("");
  const [date, setDate] = useState(() => { const d = new Date(); d.setDate(d.getDate() + 1); return dateVal(d); });
  const [roomId, setRoomId] = useState(null);
  const [time, setTime] = useState("");
  const [dayEntries, setDayEntries] = useState([]);
  const [override, setOverride] = useState(null);
  const [incidents, setIncidents] = useState([]);
  const [busy, setBusy] = useState(false);

  const modality = studyType === "КТ" ? "CT" : "MRI";
  const selCenter = activeCenters.find((c) => c.clinicId === centerId) || null;
  const allRooms = roomsByClinic[centerId] || [];
  const allowedRoomIds = selCenter && Array.isArray(selCenter.room_ids) && selCenter.room_ids.length ? selCenter.room_ids : null; // null = усі
  const rooms = allowedRoomIds ? allRooms.filter((r) => allowedRoomIds.includes(r.id)) : allRooms;
  const hasMRI = rooms.some((r) => r.modality === "MRI");
  const hasCT = rooms.some((r) => r.modality === "CT");
  const modAllowed = (code) => (code === "MRI" ? hasMRI : code === "CT" ? hasCT : false);
  const roomsOfType = rooms.filter((r) => r.modality === modality);
  const room = roomsOfType.find((r) => r.id === roomId) || null;
  const regions = regionsFor(studyType);
  const regionObj = regions.find((r) => r.label === region);
  const dur = regionObj ? regionObj.dur : (studyType === "КТ" ? 20 : 45);

  // Якщо центр обмежує модальності — переключаємо тип на дозволений.
  useEffect(() => {
    if (!modAllowed(studyType === "КТ" ? "CT" : "MRI")) {
      if (modAllowed("MRI")) setStudyType("МРТ"); else if (modAllowed("CT")) setStudyType("КТ");
      setRegion(""); setTime("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerId]);

  // Дефолтний кабінет при зміні центру/модальності.
  useEffect(() => {
    setRoomId((prev) => (roomsOfType.some((r) => r.id === prev) ? prev : (roomsOfType[0] ? roomsOfType[0].id : null)));
    setTime("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerId, studyType]);

  const loadDay = useCallback(async () => {
    const supabase = createClient();
    if (centerId) {
      const ov = await supabase.from("schedule_overrides").select("all_closed, label, rooms").eq("clinic_id", centerId).eq("override_date", date).maybeSingle();
      setOverride(ov.data || null);
      const inc = await supabase.from("incidents").select("room_id, started_at, blocked_until, status, auto_unblock").eq("clinic_id", centerId).in("status", ["active", "planned"]);
      setIncidents(inc.data || []);
    }
    if (!roomId) { setDayEntries([]); return; }
    // Знеособлена зайнятість через RPC (без ПІБ/телефонів інших пацієнтів).
    const { data } = await supabase.rpc("room_busy_slots", { p_room: roomId, p_date: date });
    setDayEntries(data || []);
  }, [centerId, roomId, date]);

  useEffect(() => { let live = true; (async () => { await loadDay(); })(); return () => { live = false; }; }, [loadDay]);
  // Підстраховка: оновити зайнятість при поверненні на вкладку.
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "visible") loadDay(); };
    document.addEventListener("visibilitychange", onVis); window.addEventListener("focus", onVis);
    return () => { document.removeEventListener("visibilitychange", onVis); window.removeEventListener("focus", onVis); };
  }, [loadDay]);

  const dateObj = new Date(date + "T00:00:00");
  const roomSched = roomScheduleFor(dateObj, roomId, override);
  const schedStart = toMin(roomSched.start), schedEnd = toMin(roomSched.end);
  const busySlots = (dayEntries || []).filter((e) => e.scheduled_time).map((e) => ({ s: toMin(e.scheduled_time), e: toMin(e.scheduled_time) + (e.duration_min || 30) }));
  const slots = []; { const s0 = Math.ceil(schedStart / 30) * 30; for (let m = s0; m < schedEnd; m += 30) slots.push(fmt(m)); }
  function slotState(slot) {
    const a = toMin(slot), b = a + dur;
    if (roomSched.closed) return "closed";
    const slotMs = Date.UTC(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), Math.floor(a / 60), a % 60);
    if (slotBlockedByIncidents(incidents, roomId, slotMs)) return "blocked";
    if (a < schedStart || a >= schedEnd) return "offhours";
    if (b > schedEnd) return "tight";
    if (busySlots.some((x) => a >= x.s && a < x.e)) return "busy";
    if (busySlots.some((x) => a < x.e && x.s < b)) return "tight";
    return "free";
  }
  const valid = centerId && name.trim() && dob && phone.trim() && region && time && roomId && !roomSched.closed && slotState(time) === "free";

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    const supabase = createClient();
    const [hh, mm] = time.split(":").map(Number);
    const at = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), hh, mm).toISOString();
    // Повторна перевірка зайнятості через RPC (слот могли зайняти, поки відкрита форма).
    const startMin2 = hh * 60 + mm, endMin2 = startMin2 + (dur || 30);
    const { data: clash } = await supabase.rpc("room_busy_slots", { p_room: roomId, p_date: date });
    if ((clash || []).some((q) => {
      const qs = toMin(q.scheduled_time);
      return qs < endMin2 && startMin2 < qs + (q.duration_min || 30);
    })) { setBusy(false); onCreated(null, "Слот щойно зайняли — оновіть сторінку й оберіть інший час"); return; }
    const studiesArr = [{ type: studyType, region, contrast: false, dur, price: studyPrice(studyType, region, false) }];
    const { error } = await supabase.from("queue_entries").insert({
      clinic_id: centerId, room_id: roomId, patient_name: name.trim(), patient_phone: phone.trim(),
      patient_dob: dob, patient_age: calcAge(dob),
      studies: studiesArr, studies_original: studiesArr, duration_min: dur,
      scheduled_date: date, scheduled_time: time, scheduled_at: at,
      status: "scheduled", call_status: "not_called", doctor: doctorName, created_by: doctorId, referrer_id: doctorId, indication: comment.trim() || null,
    });
    setBusy(false);
    if (error) { onCreated(null, /incident/i.test(error.message) ? "Кабінет у простої (ремонт/ТО) у цей час — оберіть інший слот або день" : /overlap|exclusion/i.test(error.message) ? "Слот щойно зайняли — оновіть сторінку й оберіть інший час" : error.message); return; }
    setName(""); setDob(""); setPhone(""); setRegion(""); setComment(""); setTime("");
    onCreated(name.trim());
  }

  if (activeCenters.length === 0) {
    return (
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <div className="empty"><div className="ei">🏥</div><div className="et">Немає авторизованих центрів</div><div className="es">Додайте центр у вкладці «Мої центри» — після підтвердження зможете створювати направлення.</div></div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: 24 }}>
        <div className="bk-section-label" style={{ marginTop: 0 }}>Центр</div>
        <label className="fld">
          <span className="fld-lab">Куди направляємо *</span>
          <select className="inp" value={centerId} onChange={(e) => { setCenterId(e.target.value); setTime(""); }}>
            {activeCenters.map((c) => <option key={c.clinicId} value={c.clinicId}>{centerLabel(c)}</option>)}
          </select>
        </label>

        <div className="bk-section-label">Пацієнт</div>
        <label className="fld"><span className="fld-lab">ПІБ *</span><input className="inp" placeholder="Прізвище Ім'я По батькові" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <div className="fld-row">
          <label className="fld"><span className="fld-lab">Дата народження *</span><input className="inp tabular" type="date" max={dateVal(new Date())} value={dob} onChange={(e) => setDob(e.target.value)} /></label>
          <label className="fld"><span className="fld-lab">Телефон *</span><input className="inp" type="tel" placeholder="+38 0__ ___ __ __" value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
        </div>

        <div className="bk-section-label" style={{ marginTop: 8 }}>Дослідження</div>
        <div className="fld-row" style={{ alignItems: "flex-end" }}>
          <div className="fld" style={{ flex: "0 0 130px" }}>
            <span className="fld-lab">Тип *</span>
            <div className="bk-seg">
              {modAllowed("MRI") && <button className={"bk-seg-btn" + (studyType === "МРТ" ? " active mrt" : "")} onClick={() => { setStudyType("МРТ"); setRegion(""); setTime(""); }}>МРТ</button>}
              {modAllowed("CT") && <button className={"bk-seg-btn" + (studyType === "КТ" ? " active ct" : "")} onClick={() => { setStudyType("КТ"); setRegion(""); setTime(""); }}>КТ</button>}
            </div>
          </div>
          <label className="fld" style={{ flex: 1 }}>
            <span className="fld-lab">Область дослідження *</span>
            <select className="inp" value={region} onChange={(e) => { setRegion(e.target.value); setTime(""); }}>
              <option value="">— Оберіть область —</option>
              {regions.map((r) => <option key={r.label} value={r.label}>{r.label} · {r.dur} хв</option>)}
            </select>
          </label>
        </div>
        <label className="fld"><span className="fld-lab">Клінічне питання / коментар</span><textarea className="inp" rows={2} placeholder="Показання, що шукаємо, особливості…" value={comment} onChange={(e) => setComment(e.target.value)} /></label>

        <div className="bk-section-label" style={{ marginTop: 8 }}>Запис у кабінет</div>
        {roomsOfType.length === 0 ? (
          <div className="ctx-hint red">У цьому центрі немає кабінету типу {studyType}.</div>
        ) : (
          <>
            {roomsOfType.length > 1 && (
              <div className="bd-rooms" style={{ marginBottom: 10 }}>
                {roomsOfType.map((r) => (
                  <button key={r.id} className={"bd-room" + (roomId === r.id ? " active" : "")} onClick={() => { setRoomId(r.id); setTime(""); }} title={r.name + (r.apparatus_model ? " · " + r.apparatus_model : "")}>
                    <span className={"bd-room-kind " + (r.modality === "MRI" ? "mrt" : "ct")}>{modalityLabel(r.modality)}</span>
                    <span className="bd-room-meta"><span className="bd-room-name">{r.name}</span><span className="bd-room-model">{r.apparatus_model || ""}</span></span>
                  </button>
                ))}
              </div>
            )}
            <div className="fld-row">
              <label className="fld" style={{ maxWidth: 180 }}><span className="fld-lab">Дата</span><input className="inp tabular" type="date" min={dateVal(new Date())} value={date} onChange={(e) => { setDate(e.target.value); setTime(""); }} /></label>
              <div className="fld"><span className="fld-lab">Кабінет</span><div className="inp" style={{ display: "flex", alignItems: "center" }}>{room ? room.name + " · " + modalityLabel(room.modality) : "—"}</div></div>
            </div>
            {roomSched.closed && <div className="ctx-hint red" style={{ marginBottom: 10 }}>🚫 {room ? room.name : "Кабінет"} не працює {date}{override && override.label ? " · " + override.label : ""}.</div>}
            {!roomSched.closed && slots.some((s) => slotState(s) === "blocked") && <div className="ctx-hint red" style={{ marginBottom: 10 }}>🔧 {room ? room.name : "Кабінет"} на ремонті/ТО у частині дня. Оберіть вільний слот або інший день.</div>}
            <div className="fld">
              <span className="fld-lab">Вільні слоти · блок {dur} хв</span>
              <div className="bk-slot-grid">
                {slots.map((s) => {
                  const stt = slotState(s);
                  return <button key={s} className={"slot" + (time === s ? " sel" : "") + (stt !== "free" ? " taken" : "") + ((stt === "busy" || stt === "blocked") ? " busy" : "") + (stt === "tight" ? " tight" : "")} disabled={stt !== "free"} onClick={() => setTime(s)} title={stt === "free" ? "Вільно" : stt === "blocked" ? "Кабінет на ремонті/ТО" : "Недоступно"}>{s}</button>;
                })}
              </div>
              <div className="bk-slot-legend"><span><span className="lg-dot free" />вільно</span><span><span className="lg-dot busy" />зайнято</span></div>
            </div>
          </>
        )}

        <button className="btn btn-primary btn-lg" style={{ width: "100%", justifyContent: "center", marginTop: 8 }} disabled={!valid || busy} onClick={submit}>
          {busy ? "Відправляємо…" : "Відправити направлення"}
        </button>
      </div>
    </div>
  );
}

/* ---------- Вкладка «Мої направлення» ---------- */
function MyReferrals({ referrals, centersById, onReschedule, onCancel, onEditPatient }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [centerFilter, setCenterFilter] = useState("all");
  const [selected, setSelected] = useState(null);

  const centerOptions = useMemo(() => {
    const ids = Array.from(new Set(referrals.map((r) => r.clinic_id)));
    return ids.map((id) => ({ id, label: centerLabel(centersById[id]) }));
  }, [referrals, centersById]);

  const filtered = referrals.filter((r) => {
    if (filter === "active") { if (!["waiting", "in_progress"].includes(r.status)) return false; }
    else if (filter !== "all" && r.status !== filter) return false;
    if (centerFilter !== "all" && r.clinic_id !== centerFilter) return false;
    if (query.trim()) { const q = query.trim().toLowerCase(); if (!((r.patient_name || "").toLowerCase().includes(q) || procLabel(r).toLowerCase().includes(q))) return false; }
    return true;
  });

  const canCancel = (r) => ["scheduled", "waiting"].includes(r.status);

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", display: "flex", gap: 16 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="qctrl" style={{ marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
          <div className="pills">
            {FILTERS.map((f) => <button key={f.key} className={"pill" + (filter === f.key ? " active" : "")} onClick={() => setFilter(f.key)}>{f.label}</button>)}
          </div>
          {centerOptions.length > 1 && (
            <select className="inp" style={{ maxWidth: 220, height: 32, padding: "2px 8px" }} value={centerFilter} onChange={(e) => setCenterFilter(e.target.value)}>
              <option value="all">Усі центри</option>
              {centerOptions.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          )}
          <div className="spacer" />
          <div className="search"><span className="si">⌕</span><input placeholder="Пошук пацієнта…" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
        </div>
        {filtered.length === 0 ? (
          <div className="empty"><div className="ei">📄</div><div className="et">Направлень немає</div><div className="es">Створіть направлення у вкладці «Нове направлення»</div></div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {filtered.map((r) => {
              const m = ST[r.status] || ST.scheduled;
              return (
                <div key={r.id} onClick={() => setSelected(r)} style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 14px", background: "var(--card)", border: "1px solid " + (selected && selected.id === r.id ? "var(--blue)" : "var(--border)"), borderRadius: "var(--r-md)", cursor: "pointer" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{canCancel(r) ? <span onClick={(e) => { e.stopPropagation(); onEditPatient && onEditPatient(r); }} style={{ cursor: "pointer", textDecorationLine: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 3 }} title="Редагувати дані пацієнта">{r.patient_name}</span> : r.patient_name}</div>
                    <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{procLabel(r)} · <span style={{ color: "var(--text-secondary)" }}>🏥 {centerLabel(centersById[r.clinic_id])}</span>{studiesChanged(r.studies_original, r.studies) && <span style={{ color: "var(--orange)", marginLeft: 6 }}>✎ змінено клінікою</span>}</div>
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{r.scheduled_date} · {r.scheduled_time}</div>
                  <span className={"badge " + m.cls}>{m.label}</span>
                  <button className="btn btn-secondary btn-sm" onClick={(e) => { e.stopPropagation(); setSelected(r); }}>Деталі</button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {selected && (() => {
        const sel = referrals.find((x) => x.id === selected.id) || selected; // живі дані (realtime/полінг)
        const m = ST[sel.status] || ST.scheduled;
        const sdiff = diffStudies(sel.studies_original, sel.studies);
        const changed = studiesChanged(sel.studies_original, sel.studies);
        return (
          <aside style={{ width: 320, flexShrink: 0, background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: 18, alignSelf: "flex-start" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <span style={{ fontSize: 15, fontWeight: 700 }}>Деталі направлення</span>
              <button className="icon-btn" onClick={() => setSelected(null)}>✕</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", rowGap: 10, columnGap: 10, fontSize: 13 }}>
              <span style={{ color: "var(--text-muted)" }}>Пацієнт</span><span>{sel.patient_name}</span>
              <span style={{ color: "var(--text-muted)" }}>Телефон</span><span>{sel.patient_phone || "—"}</span>
              <span style={{ color: "var(--text-muted)" }}>Центр</span><span>{centerLabel(centersById[sel.clinic_id])}</span>
              <span style={{ color: "var(--text-muted)" }}>Дослідження{changed && <span style={{ color: "var(--orange)" }}> · змінено</span>}</span>
              <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {sdiff.map((d, i) => (
                  <span key={i} style={{ color: d.state === "added" ? "var(--green)" : d.state === "removed" ? "var(--red)" : "var(--text)", textDecoration: d.state === "removed" ? "line-through" : "none" }}>
                    {d.state === "added" ? "＋ " : d.state === "removed" ? "－ " : ""}{studyText(d.s)}
                  </span>
                ))}
              </span>
              <span style={{ color: "var(--text-muted)" }}>Дата · час</span><span>{sel.scheduled_date} · {sel.scheduled_time}{sel.duration_min ? " · " + sel.duration_min + " хв" : ""}</span>
              <span style={{ color: "var(--text-muted)" }}>Статус</span><span><span className={"badge " + m.cls}>{m.label}</span></span>
              {sel.indication && <><span style={{ color: "var(--text-muted)" }}>Питання</span><span>{sel.indication}</span></>}
              {sel.status === "no_show" && sel.note && <><span style={{ color: "var(--red)" }}>Причина</span><span>{sel.note}</span></>}
            </div>
            {changed && <div className="ctx-hint" style={{ marginTop: 10, fontSize: 12 }}>Центр скоригував перелік досліджень. <span style={{ color: "var(--green)" }}>Зелені</span> — додані, <span style={{ color: "var(--red)", textDecoration: "line-through" }}>закреслені</span> — прибрані.</div>}
            {sel.status !== "done" && sel.status !== "cancelled" && sel.status !== "no_show" && (
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button className="btn btn-primary btn-sm" style={{ flex: 1, justifyContent: "center" }} onClick={() => onReschedule(sel)}>🗓 Перезаписати</button>
                {canCancel(sel) && (
                  <button className="btn btn-secondary btn-sm qd-act-red" style={{ justifyContent: "center" }} onClick={() => { onCancel(sel); setSelected(null); }}>Скасувати</button>
                )}
              </div>
            )}
            {!canCancel(sel) && sel.status === "in_progress" && (
              <div className="ctx-hint blue" style={{ marginTop: 10, fontSize: 12 }}>Дослідження вже почалося — скасування лише через центр.</div>
            )}
          </aside>
        );
      })()}
    </div>
  );
}

/* ---------- Розгорнута картка центру (деталі + контакти адміна + обладнання) ---------- */
function CenterDetails({ data, loading }) {
  const panel = { background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", padding: 16, margin: "4px 0 8px" };
  if (loading) return <div style={panel}><div style={{ color: "var(--text-muted)", fontSize: 13 }}>Завантаження…</div></div>;
  if (!data) return <div style={panel}><div style={{ color: "var(--text-muted)", fontSize: 13 }}>Не вдалося завантажити деталі центру.</div></div>;
  const admins = Array.isArray(data.admins) ? data.admins : [];
  const rooms = Array.isArray(data.rooms) ? data.rooms : [];
  const realEmail = (e) => e && !/@referrer\.radflow\.local$/i.test(e);
  const lbl = { color: "var(--text-muted)", fontSize: 11.5, textTransform: "uppercase", letterSpacing: ".04em", margin: "0 0 8px" };
  return (
    <div style={panel}>
      <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", rowGap: 8, columnGap: 10, fontSize: 13, marginBottom: 16 }}>
        <span style={{ color: "var(--text-muted)" }}>Центр</span><span style={{ fontWeight: 600 }}>{data.name}</span>
        <span style={{ color: "var(--text-muted)" }}>Місто</span><span>{data.city || "—"}</span>
        <span style={{ color: "var(--text-muted)" }}>Режим бронювання</span><span>{data.policy === "confirm" ? "з підтвердженням оператора" : "пряма черга (одразу в чергу)"}</span>
        {data.note ? <><span style={{ color: "var(--text-muted)" }}>Примітка</span><span>{data.note}</span></> : null}
      </div>

      <div style={lbl}>Адміністратор центру</div>
      {admins.length === 0 ? (
        <div style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 16 }}>Контакти не вказані.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
          {admins.map((a, i) => {
            const phone = a.phone || "";
            const email = realEmail(a.email) ? a.email : "";
            return (
              <div key={i} style={{ fontSize: 13 }}>
                <div style={{ fontWeight: 600 }}>{a.full_name || "Адміністратор"}</div>
                <div style={{ color: "var(--text-secondary)", display: "flex", gap: 16, flexWrap: "wrap", marginTop: 3 }}>
                  {phone ? <a href={"tel:" + phone} style={{ color: "var(--blue)", textDecoration: "none" }}>📞 {phone}</a> : null}
                  {email ? <a href={"mailto:" + email} style={{ color: "var(--blue)", textDecoration: "none" }}>✉ {email}</a> : null}
                  {!phone && !email ? <span style={{ color: "var(--text-muted)" }}>контакти не вказані</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={lbl}>Доступне обладнання для вас</div>
      {rooms.length === 0 ? (
        <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Кабінети не вказані.</div>
      ) : (
        <div className="bd-rooms">
          {rooms.map((r) => (
            <div key={r.id} className="bd-room" style={{ cursor: "default" }} title={r.name + (r.apparatus_model ? " · " + r.apparatus_model : "")}>
              <span className={"bd-room-kind " + (r.modality === "MRI" ? "mrt" : "ct")}>{modalityLabel(r.modality)}</span>
              <span className="bd-room-meta"><span className="bd-room-name">{r.name}</span><span className="bd-room-model">{r.apparatus_model || ""}</span></span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Вкладка «Мої центри» ---------- */
function MyCenters({ centers, canManage, onChanged, notify }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);   // accessId розгорнутої картки
  const [details, setDetails] = useState({});           // кеш деталей за accessId
  const [loadingId, setLoadingId] = useState(null);

  function toggleExpand(c) {
    if (!c.accessId) return;
    setExpandedId((id) => (id === c.accessId ? null : c.accessId));
  }

  // Деталі розгорнутої картки тягнемо реактивно: при відкритті І при будь-якій
  // зміні гранту (room_ids/policy/status) — щоб «Доступне обладнання для вас»
  // оновлювалося миттєво без перезавантаження сторінки. Звʼязок direct→props:
  // realtime на referral_access у батьку викликає router.refresh() → оновлює
  // centers → змінюється підпис нижче → ефект перезапитує RPC.
  const expandedCenter = centers.find((c) => c.accessId === expandedId) || null;
  const expandedSig = expandedCenter ? JSON.stringify([expandedCenter.status, expandedCenter.policy, expandedCenter.room_ids]) : "";
  useEffect(() => {
    if (!expandedId) return;
    let cancelled = false;
    (async () => {
      setLoadingId(expandedId);
      const supabase = createClient();
      const { data, error } = await supabase.rpc("referral_center_card", { p_access_id: expandedId });
      if (cancelled) return;
      setLoadingId((id) => (id === expandedId ? null : id));
      if (!error && data) setDetails((d) => ({ ...d, [expandedId]: data }));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedId, expandedSig]);

  const knownIds = useMemo(() => new Set(centers.map((c) => c.clinicId)), [centers]);
  const invites = centers.filter((c) => c.status === "pending_referrer");
  const active = centers.filter((c) => c.status === "active");
  const awaiting = centers.filter((c) => c.status === "pending_clinic");
  const history = centers.filter((c) => c.status === "revoked" || c.status === "declined");

  async function search() {
    setSearching(true);
    const supabase = createClient();
    const { data } = await supabase.rpc("search_clinics", { q: q.trim() });
    setResults((data || []).filter((c) => !knownIds.has(c.id)));
    setSearching(false);
  }

  async function sendRequest(clinicId) {
    setBusyId(clinicId);
    const { ok, data } = await postJSON("/api/referral/access/request", { clinic_id: clinicId });
    setBusyId(null);
    if (!ok) { notify(data.error || "Помилка", "error"); return; }
    notify("Запит надіслано — очікуйте підтвердження центру", "success");
    setResults((rs) => rs.filter((r) => r.id !== clinicId));
    onChanged();
  }

  async function decide(accessId, decision) {
    setBusyId(accessId);
    const { ok, data } = await postJSON("/api/referral/access/decide", { access_id: accessId, decision });
    setBusyId(null);
    if (!ok) { notify(data.error || "Помилка", "error"); return; }
    notify(decision === "approve" ? "Запрошення прийнято" : decision === "revoke" ? "Доступ відкликано" : "Відхилено", "success");
    onChanged();
  }

  const card = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: 18, marginBottom: 14 };
  function Row({ c, children, onClick, expandable, expanded }) {
    const m = ACCESS_ST[c.status] || ACCESS_ST.active;
    return (
      <div onClick={onClick} title={expandable ? (expanded ? "Згорнути" : "Натисніть, щоб переглянути деталі центру") : undefined} style={{ padding: "12px 0", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", cursor: onClick ? "pointer" : "default" }}>
        {expandable && <span style={{ color: "var(--text-muted)", fontSize: 13, width: 12, flexShrink: 0, display: "inline-block", transition: "transform .15s", transform: expanded ? "rotate(90deg)" : "none" }}>▸</span>}
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{c.name}</div>
          <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{c.city || "—"}{c.status === "active" ? " · режим: " + (c.policy === "confirm" ? "з підтвердженням" : "пряма черга") : ""}</div>
        </div>
        <span className={"badge " + m.cls}>{m.label}</span>
        {children}
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 820, margin: "0 auto" }}>
      {canManage && (
        <div style={card}>
          <div className="bk-section-label" style={{ marginTop: 0 }}>Додати центр</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input className="inp" placeholder="Назва або місто центру…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") search(); }} />
            <button className="btn btn-secondary" onClick={search} disabled={searching}>{searching ? "Пошук…" : "Знайти"}</button>
          </div>
          {results.length > 0 && (
            <div style={{ marginTop: 10 }}>
              {results.map((r) => (
                <div key={r.id} style={{ padding: "10px 0", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>{r.name}</div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{r.city || "—"}{Array.isArray(r.modalities) && r.modalities.length ? " · " + r.modalities.map(modalityLabel).join(", ") : ""}</div>
                  </div>
                  <button className="btn btn-primary btn-sm" disabled={busyId === r.id} onClick={() => sendRequest(r.id)}>{busyId === r.id ? "…" : "Надіслати запит"}</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {invites.length > 0 && (
        <div style={card}>
          <div className="bk-section-label" style={{ marginTop: 0 }}>Запрошення центрів ({invites.length})</div>
          {invites.map((c) => (
            <div key={c.accessId}>
              <Row c={c} expandable expanded={expandedId === c.accessId} onClick={() => toggleExpand(c)}>
                <button className="btn btn-primary btn-sm" disabled={busyId === c.accessId} onClick={(e) => { e.stopPropagation(); decide(c.accessId, "approve"); }}>Прийняти</button>
                <button className="btn btn-secondary btn-sm" disabled={busyId === c.accessId} onClick={(e) => { e.stopPropagation(); if (window.confirm("Відхилити запрошення центру «" + c.name + "»?\n\nВи зможете надіслати запит на доступ пізніше вручну.")) decide(c.accessId, "decline"); }}>Відхилити</button>
              </Row>
              {expandedId === c.accessId && <CenterDetails data={details[c.accessId]} loading={loadingId === c.accessId && !details[c.accessId]} />}
            </div>
          ))}
        </div>
      )}

      <div style={card}>
        <div className="bk-section-label" style={{ marginTop: 0 }}>Активні центри ({active.length})</div>
        {active.length === 0 ? <div style={{ color: "var(--text-muted)", padding: 8, fontSize: 13 }}>Поки немає активних центрів.</div>
          : active.map((c) => (
            <div key={c.accessId || c.clinicId}>
              <Row c={c} expandable={!!c.accessId} expanded={expandedId === c.accessId} onClick={c.accessId ? () => toggleExpand(c) : undefined}>
                {canManage && c.accessId && <button className="btn btn-secondary btn-sm qd-act-red" disabled={busyId === c.accessId} onClick={(e) => { e.stopPropagation(); if (window.confirm("Відкликати доступ до «" + c.name + "»? Створені направлення лишаться у центрі, нові ви створювати не зможете.")) decide(c.accessId, "revoke"); }}>Відкликати</button>}
              </Row>
              {c.accessId && expandedId === c.accessId && <CenterDetails data={details[c.accessId]} loading={loadingId === c.accessId && !details[c.accessId]} />}
            </div>
          ))}
      </div>

      {awaiting.length > 0 && (
        <div style={card}>
          <div className="bk-section-label" style={{ marginTop: 0 }}>Очікують підтвердження ({awaiting.length})</div>
          {awaiting.map((c) => <Row key={c.accessId} c={c} />)}
        </div>
      )}

      {history.length > 0 && (
        <div style={card}>
          <div className="bk-section-label" style={{ marginTop: 0 }}>Історія</div>
          {history.map((c) => (
            <Row key={c.accessId} c={c}>
              {canManage && <button className="btn btn-secondary btn-sm" disabled={busyId === c.clinicId} onClick={() => sendRequest(c.clinicId)}>{busyId === c.clinicId ? "…" : "Надіслати запит знову"}</button>}
            </Row>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ReferralPortal({ role, centers, roomsByClinic, doctorName, doctorId }) {
  const router = useRouter();
  const canManage = role === "referrer";
  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const activeCenters = useMemo(() => centers.filter((c) => c.status === "active"), [centers]);
  const centersById = useMemo(() => { const m = {}; centers.forEach((c) => { m[c.clinicId] = c; }); return m; }, [centers]);
  const pendingInvites = centers.filter((c) => c.status === "pending_referrer").length;

  const [tab, setTab] = useState(() => (activeCenters.length === 0 ? "centers" : "new"));
  const [editPatientFor, setEditPatientFor] = useState(null);
  const [referrals, setReferrals] = useState([]);
  const [reschedFor, setReschedFor] = useState(null);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  function notify(msg, type = "success") { setToast({ msg, type }); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), 3200); }

  const reload = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("queue_entries")
      .select("id, clinic_id, patient_name, patient_phone, patient_age, scheduled_date, scheduled_time, duration_min, status, studies, studies_original, doctor, note, indication, room_id")
      .eq("referrer_id", doctorId)
      .order("scheduled_date", { ascending: false }).order("scheduled_time", { ascending: true });
    setReferrals(data || []);
  }, [doctorId]);

  useEffect(() => {
    const supabase = createClient();
    let channel; let cancelled = false;
    (async () => {
      try { const { data: { session } } = await supabase.auth.getSession(); if (session?.access_token) supabase.realtime.setAuth(session.access_token); } catch { /* ignore */ }
      if (cancelled) return;
      reload();
      channel = supabase.channel("ref-" + doctorId)
        .on("postgres_changes", { event: "*", schema: "public", table: "queue_entries", filter: "referrer_id=eq." + doctorId }, () => reload())
        // Зміни доступу до центрів (центр підтвердив/відхилив/відкликав) → перезавантажуємо серверні пропси.
        .on("postgres_changes", { event: "*", schema: "public", table: "referral_access", filter: "referrer_id=eq." + doctorId }, () => router.refresh())
        .subscribe();
    })();
    const onVis = () => { if (document.visibilityState === "visible") { reload(); router.refresh(); } };
    document.addEventListener("visibilitychange", onVis); window.addEventListener("focus", onVis);
    const t = setInterval(reload, 12000);
    return () => { cancelled = true; document.removeEventListener("visibilitychange", onVis); window.removeEventListener("focus", onVis); clearInterval(t); if (channel) supabase.removeChannel(channel); };
  }, [doctorId, reload, router]);

  async function doReschedule({ roomId, date, time, dur }) {
    const p = reschedFor; if (!p) return;
    const supabase = createClient();
    const [hh, mm] = time.split(":").map(Number);
    const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hh, mm).toISOString();
    const { error } = await supabase.from("queue_entries").update({ room_id: roomId, scheduled_date: date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()), scheduled_time: time, scheduled_at: at, duration_min: dur, status: "scheduled", call_status: "not_called" }).eq("id", p.id);
    setReschedFor(null);
    if (error) { notify("Помилка: " + error.message, "error"); return; }
    notify("Перенесено", "success"); reload();
  }

  async function doCancel(entry) {
    if (!entry) return;
    const supabase = createClient();
    const { error } = await supabase.from("queue_entries").update({ status: "cancelled" }).eq("id", entry.id);
    if (error) { notify("Помилка скасування: " + error.message, "error"); return; }
    notify("Направлення скасовано", "success"); reload();
  }

  function onCentersChanged() { router.refresh(); }

  const reschedRooms = reschedFor ? (roomsByClinic[reschedFor.clinic_id] || []) : [];

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font)" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 28px", borderBottom: "1px solid var(--border)", background: "var(--bg-elevated)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 19, fontWeight: 700, color: "var(--blue)" }}>
          <span style={{ width: 9, height: 9, borderRadius: "50%", background: "var(--blue)", boxShadow: "0 0 10px var(--blue)" }} />
          Referral RadFlow
          <span style={{ fontSize: 13, fontWeight: 400, color: "var(--text-muted)" }}>· {activeCenters.length} {activeCenters.length === 1 ? "центр" : "центрів"}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}><LiveClock /></span>
          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>🩺 {doctorName}</span>
          <button className="btn btn-secondary btn-sm" onClick={signOut} title="Вийти з акаунта">Вийти</button>
        </div>
      </header>

      <div style={{ display: "flex", gap: 4, padding: "16px 28px 0", maxWidth: 1040, margin: "0 auto" }}>
        <button className={"pill" + (tab === "new" ? " active" : "")} onClick={() => setTab("new")}>Нове направлення</button>
        <button className={"pill" + (tab === "mine" ? " active" : "")} onClick={() => setTab("mine")}>Мої направлення <span className="ct">({referrals.length})</span></button>
        <button className={"pill" + (tab === "centers" ? " active" : "")} onClick={() => setTab("centers")}>Мої центри{pendingInvites > 0 ? <span className="ct" style={{ background: "var(--blue)", color: "#fff" }}>{pendingInvites}</span> : null}</button>
      </div>

      <div style={{ padding: "20px 28px 50px" }}>
        {tab === "new" && (
          <NewReferral activeCenters={activeCenters} roomsByClinic={roomsByClinic} doctorName={doctorName} doctorId={doctorId}
            onCreated={(nm, err) => { if (err) notify("Помилка: " + err, "error"); else { notify("Направлення відправлено: " + nm, "success"); reload(); setTab("mine"); } }} />
        )}
        {tab === "mine" && (
          <MyReferrals referrals={referrals} centersById={centersById} onReschedule={(r) => setReschedFor(r)} onCancel={doCancel} onEditPatient={(r) => setEditPatientFor(r)} />
        )}
        {tab === "centers" && (
          <MyCenters centers={centers} canManage={canManage} onChanged={onCentersChanged} notify={notify} />
        )}
      </div>

      {reschedFor && (
        <RescheduleModal patient={reschedFor} rooms={reschedRooms} clinicId={reschedFor.clinic_id} onClose={() => setReschedFor(null)} onConfirm={doReschedule} />
      )}
      {editPatientFor && (
        <PatientEditModal entryId={editPatientFor.id} onClose={() => setEditPatientFor(null)} onSaved={reload} />
      )}
      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "var(--card)", border: "1px solid var(--border-strong)", borderLeft: "4px solid " + (toast.type === "error" ? "var(--red)" : "var(--green)"), borderRadius: 12, padding: "12px 18px", boxShadow: "var(--shadow-pop)", zIndex: 50, fontSize: 13.5 }}>{toast.msg}</div>
      )}
    </div>
  );
}
