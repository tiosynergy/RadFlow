"use client";

/* ===== RadFlow — Referral Portal (портал лікарів-направників) =====
   Зовнішній портал: «Нове направлення» (форма + вибір слота) і «Мої направлення»
   (список своїх направлень + деталі + перезапис). Направлення = queue_entries з
   doctor = ПІБ лікаря. На реальних даних Supabase, schedule-aware. */

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import RescheduleModal from "@/components/RescheduleModal";
import { roomScheduleFor } from "@/lib/schedule";
import { regionsFor, studyPrice } from "@/lib/studies";
import "@/styles/prototype/radflow.css";

/* Довідник областей дослідження — у @/lib/studies (єдине джерело). */
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

const ST = {
  scheduled: { label: "Очікує", cls: "gray" },
  waiting: { label: "В роботі", cls: "blue" },
  in_progress: { label: "В роботі", cls: "blue" },
  done: { label: "Виконано", cls: "green" },
  no_show: { label: "Не відбулося", cls: "red" },
  cancelled: { label: "Скасовано", cls: "gray" },
};
const FILTERS = [
  { key: "all", label: "Усі" },
  { key: "scheduled", label: "Очікує" },
  { key: "active", label: "В роботі" },
  { key: "done", label: "Виконано" },
  { key: "no_show", label: "Не відбулося" },
];

/* ---------- Вкладка «Нове направлення» ---------- */
function NewReferral({ clinicId, rooms, doctorName, doctorId, onCreated }) {
  const [name, setName] = useState("");
  const [dob, setDob] = useState("");
  const [phone, setPhone] = useState("");
  const [studyType, setStudyType] = useState("МРТ");
  const [region, setRegion] = useState("");
  const [comment, setComment] = useState("");
  const [date, setDate] = useState(() => { const d = new Date(); d.setDate(d.getDate() + 1); return dateVal(d); });
  const [time, setTime] = useState("");
  const [dayEntries, setDayEntries] = useState([]);
  const [override, setOverride] = useState(null);
  const [busy, setBusy] = useState(false);

  const modality = studyType === "КТ" ? "CT" : "MRI";
  const roomsOfType = (rooms || []).filter((r) => r.modality === modality);
  const room = roomsOfType[0] || null;
  const roomId = room ? room.id : null;
  const regions = regionsFor(studyType);
  const regionObj = regions.find((r) => r.label === region);
  const dur = regionObj ? regionObj.dur : (studyType === "КТ" ? 20 : 45);

  useEffect(() => {
    let cancel = false;
    (async () => {
      const supabase = createClient();
      if (clinicId) {
        const ov = await supabase.from("schedule_overrides").select("all_closed, label, rooms").eq("clinic_id", clinicId).eq("override_date", date).maybeSingle();
        if (!cancel) setOverride(ov.data || null);
      }
      if (!roomId) { setDayEntries([]); return; }
      const { data } = await supabase.from("queue_entries").select("scheduled_time, duration_min, status").eq("room_id", roomId).eq("scheduled_date", date).neq("status", "cancelled").neq("status", "no_show");
      if (!cancel) setDayEntries(data || []);
    })();
    return () => { cancel = true; };
  }, [roomId, date, clinicId]);

  const dateObj = new Date(date + "T00:00:00");
  const roomSched = roomScheduleFor(dateObj, roomId, override);
  const schedStart = toMin(roomSched.start), schedEnd = toMin(roomSched.end);
  const busySlots = dayEntries.filter((e) => e.scheduled_time).map((e) => ({ s: toMin(e.scheduled_time), e: toMin(e.scheduled_time) + (e.duration_min || 30) }));
  const slots = []; for (let m = 8 * 60; m < 18 * 60; m += 30) slots.push(fmt(m));
  function slotState(slot) {
    const a = toMin(slot), b = a + dur;
    if (roomSched.closed) return "closed";
    if (a < schedStart || a >= schedEnd) return "offhours";
    if (b > schedEnd) return "tight";
    if (busySlots.some((x) => a >= x.s && a < x.e)) return "busy";
    if (busySlots.some((x) => a < x.e && x.s < b)) return "tight";
    return "free";
  }
  const valid = name.trim() && dob && phone.trim() && region && time && roomId && !roomSched.closed && slotState(time) === "free";

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    const supabase = createClient();
    const [hh, mm] = time.split(":").map(Number);
    const at = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), hh, mm).toISOString();
    // повторна перевірка слота перед вставкою (його могли зайняти, поки відкрита форма)
    const startMin2 = hh * 60 + mm, endMin2 = startMin2 + (dur || 30);
    const { data: clash } = await supabase
      .from("queue_entries").select("scheduled_time, duration_min")
      .eq("room_id", roomId).eq("scheduled_date", date)
      .neq("status", "cancelled").neq("status", "no_show");
    if ((clash || []).some((q) => {
      const [qh, qm] = String(q.scheduled_time || "0:0").split(":").map(Number);
      const qs = (qh || 0) * 60 + (qm || 0);
      return qs < endMin2 && startMin2 < qs + (q.duration_min || 30);
    })) { setBusy(false); onCreated(null, "Слот щойно зайняли — оновіть сторінку й оберіть інший час"); return; }
    const { error } = await supabase.from("queue_entries").insert({
      clinic_id: clinicId, room_id: roomId, patient_name: name.trim(), patient_phone: phone.trim(),
      patient_dob: dob, patient_age: calcAge(dob),
      studies: [{ type: studyType, region, contrast: false, dur, price: studyPrice(studyType, region, false) }], duration_min: dur,
      scheduled_date: date, scheduled_time: time, scheduled_at: at,
      status: "scheduled", call_status: "not_called", doctor: doctorName, created_by: doctorId, indication: comment.trim() || null,
    });
    setBusy(false);
    if (error) { onCreated(null, /overlap|exclusion/i.test(error.message) ? "Слот щойно зайняли — оновіть сторінку й оберіть інший час" : error.message); return; }
    setName(""); setDob(""); setPhone(""); setRegion(""); setComment(""); setTime("");
    onCreated(name.trim());
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: 24 }}>
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
              <button className={"bk-seg-btn" + (studyType === "МРТ" ? " active mrt" : "")} onClick={() => { setStudyType("МРТ"); setRegion(""); setTime(""); }}>МРТ</button>
              <button className={"bk-seg-btn" + (studyType === "КТ" ? " active ct" : "")} onClick={() => { setStudyType("КТ"); setRegion(""); setTime(""); }}>КТ</button>
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

        <div className="bk-section-label" style={{ marginTop: 8 }}>Запис у клініку</div>
        {!room ? (
          <div className="ctx-hint red">У клініці немає кабінету типу {studyType}.</div>
        ) : (
          <>
            <div className="fld-row">
              <label className="fld" style={{ maxWidth: 180 }}><span className="fld-lab">Дата</span><input className="inp tabular" type="date" min={dateVal(new Date())} value={date} onChange={(e) => { setDate(e.target.value); setTime(""); }} /></label>
              <div className="fld"><span className="fld-lab">Кабінет</span><div className="inp" style={{ display: "flex", alignItems: "center" }}>{room.name} · {modalityLabel(room.modality)}</div></div>
            </div>
            {roomSched.closed && <div className="ctx-hint red" style={{ marginBottom: 10 }}>🚫 {room.name} не працює {date}{override && override.label ? " · " + override.label : ""}.</div>}
            <div className="fld">
              <span className="fld-lab">Вільні слоти · блок {dur} хв</span>
              <div className="bk-slot-grid">
                {slots.map((s) => {
                  const stt = slotState(s);
                  return <button key={s} className={"slot" + (time === s ? " sel" : "") + (stt !== "free" ? " taken" : "") + (stt === "busy" ? " busy" : "") + (stt === "tight" ? " tight" : "")} disabled={stt !== "free"} onClick={() => setTime(s)} title={stt === "free" ? "Вільно" : "Недоступно"}>{s}</button>;
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
function MyReferrals({ referrals, onReschedule }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState(null);

  const filtered = referrals.filter((r) => {
    if (filter === "active") { if (!["waiting", "in_progress"].includes(r.status)) return false; }
    else if (filter !== "all" && r.status !== filter) return false;
    if (query.trim()) { const q = query.trim().toLowerCase(); if (!((r.patient_name || "").toLowerCase().includes(q) || procLabel(r).toLowerCase().includes(q))) return false; }
    return true;
  });

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", display: "flex", gap: 16 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="qctrl" style={{ marginBottom: 12 }}>
          <div className="pills">
            {FILTERS.map((f) => <button key={f.key} className={"pill" + (filter === f.key ? " active" : "")} onClick={() => setFilter(f.key)}>{f.label}</button>)}
          </div>
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
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{r.patient_name}</div>
                    <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{procLabel(r)}</div>
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
        const m = ST[selected.status] || ST.scheduled;
        return (
          <aside style={{ width: 320, flexShrink: 0, background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: 18, alignSelf: "flex-start" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <span style={{ fontSize: 15, fontWeight: 700 }}>Деталі направлення</span>
              <button className="icon-btn" onClick={() => setSelected(null)}>✕</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", rowGap: 10, columnGap: 10, fontSize: 13 }}>
              <span style={{ color: "var(--text-muted)" }}>Пацієнт</span><span>{selected.patient_name}</span>
              <span style={{ color: "var(--text-muted)" }}>Телефон</span><span>{selected.patient_phone || "—"}</span>
              <span style={{ color: "var(--text-muted)" }}>Дослідження</span><span>{procLabel(selected)}</span>
              <span style={{ color: "var(--text-muted)" }}>Дата · час</span><span>{selected.scheduled_date} · {selected.scheduled_time}</span>
              <span style={{ color: "var(--text-muted)" }}>Статус</span><span><span className={"badge " + m.cls}>{m.label}</span></span>
              {selected.indication && <><span style={{ color: "var(--text-muted)" }}>Питання</span><span>{selected.indication}</span></>}
              {selected.status === "no_show" && selected.note && <><span style={{ color: "var(--red)" }}>Причина</span><span>{selected.note}</span></>}
            </div>
            {selected.status !== "done" && selected.status !== "cancelled" && (
              <button className="btn btn-primary btn-sm" style={{ width: "100%", justifyContent: "center", marginTop: 16 }} onClick={() => onReschedule(selected)}>🗓 Перезаписати</button>
            )}
          </aside>
        );
      })()}
    </div>
  );
}

export default function ReferralPortal({ clinicId, rooms, clinicName, doctorName, doctorId }) {
  const router = useRouter();
  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }
  const [tab, setTab] = useState("new");
  const [referrals, setReferrals] = useState([]);
  const [reschedFor, setReschedFor] = useState(null);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  function notify(msg, type = "success") { setToast({ msg, type }); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), 3200); }

  const reload = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("queue_entries")
      .select("id, patient_name, patient_phone, patient_age, scheduled_date, scheduled_time, duration_min, status, studies, doctor, note, indication, room_id")
      .eq("clinic_id", clinicId).eq("created_by", doctorId)
      .order("scheduled_date", { ascending: false }).order("scheduled_time", { ascending: true });
    setReferrals(data || []);
  }, [clinicId, doctorId]);

  useEffect(() => {
    reload();
    const supabase = createClient();
    const channel = supabase.channel("ref-" + clinicId).on("postgres_changes", { event: "*", schema: "public", table: "queue_entries", filter: "clinic_id=eq." + clinicId }, () => reload()).subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [clinicId, reload]);

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

  const recent = referrals.slice(0, 5);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font)" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 28px", borderBottom: "1px solid var(--border)", background: "var(--bg-elevated)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 19, fontWeight: 700, color: "var(--blue)" }}>
          <span style={{ width: 9, height: 9, borderRadius: "50%", background: "var(--blue)", boxShadow: "0 0 10px var(--blue)" }} />
          Referral RadFlow
          <span style={{ fontSize: 13, fontWeight: 400, color: "var(--text-muted)" }}>· {clinicName}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>🩺 {doctorName}</span>
          <button className="btn btn-secondary btn-sm" onClick={signOut} title="Вийти з акаунта">Вийти</button>
        </div>
      </header>

      <div style={{ display: "flex", gap: 4, padding: "16px 28px 0", maxWidth: 1040, margin: "0 auto" }}>
        <button className={"pill" + (tab === "new" ? " active" : "")} onClick={() => setTab("new")}>Нове направлення</button>
        <button className={"pill" + (tab === "mine" ? " active" : "")} onClick={() => setTab("mine")}>Мої направлення <span className="ct">({referrals.length})</span></button>
      </div>

      <div style={{ padding: "20px 28px 50px" }}>
        {tab === "new" ? (
          <>
            <NewReferral clinicId={clinicId} rooms={rooms} doctorName={doctorName} doctorId={doctorId} onCreated={(nm, err) => { if (err) notify("Помилка: " + err, "error"); else { notify("Направлення відправлено: " + nm, "success"); reload(); setTab("mine"); } }} />
            {recent.length > 0 && (
              <div style={{ maxWidth: 720, margin: "20px auto 0" }}>
                <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 8 }}>Останні направлення</div>
                {recent.map((r) => {
                  const m = ST[r.status] || ST.scheduled;
                  return (
                    <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", marginBottom: 6, fontSize: 13 }}>
                      <span style={{ flex: 1 }}>{r.patient_name} · <span style={{ color: "var(--text-muted)" }}>{procLabel(r)}</span></span>
                      <span style={{ color: "var(--text-muted)" }}>{r.scheduled_date} {r.scheduled_time}</span>
                      <span className={"badge " + m.cls}>{m.label}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          <MyReferrals referrals={referrals} onReschedule={(r) => setReschedFor(r)} />
        )}
      </div>

      {reschedFor && (
        <RescheduleModal patient={reschedFor} rooms={rooms} clinicId={clinicId} onClose={() => setReschedFor(null)} onConfirm={doReschedule} />
      )}
      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "var(--card)", border: "1px solid var(--border-strong)", borderLeft: "4px solid " + (toast.type === "error" ? "var(--red)" : "var(--green)"), borderRadius: 12, padding: "12px 18px", boxShadow: "var(--shadow-pop)", zIndex: 50, fontSize: 13.5 }}>{toast.msg}</div>
      )}
    </div>
  );
}
