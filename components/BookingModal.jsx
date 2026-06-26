"use client";

/* ===== RadFlow — Новий запис (повна модалка) =====
   Портовано з queue-app.jsx (NewBookingModal + BookingCalendar + DobField).
   Кабінети беруться з БД (rooms), зайняті слоти — з Supabase (queue_entries).
   Графік: фіксовані робочі години 08:00–18:00 (override-логіка прототипу поки опущена). */

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import AddDoctorModal from "@/components/AddDoctorModal";
import { roomScheduleFor } from "@/lib/schedule";
import { incidentEffectiveEnd } from "@/lib/incidents";
import { MRT_REGIONS, CT_REGIONS, CONTRAST_SURCHARGE, CONTRAST_DUR, regionsFor, studyLabel, studyPrice } from "@/lib/studies";

/* Довідник областей дослідження — у @/lib/studies (єдине джерело). */

/* ── Дати ── */
const WK_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
const MONTHS_NOM = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const MONTHS_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
export function today0() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
export function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function dowMon(d) { return (d.getDay() + 6) % 7; }
export function fmtShort(d) { return d.getDate() + " " + MONTHS_GEN[d.getMonth()]; }
function dateKey(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }

/* ── Слоти часу ──
   ОБМЕЖЕННЯ (за дизайном): сітка фіксована з кроком BK_STEP від початку графіка,
   тож слоти НЕ вирівнюються по фактичному завершенню попередньої процедури
   нечітної тривалості (напр. після 08:00–08:45 наступний слот — 09:00, а 08:45–09:00
   лишається невикористаним). Прийнятно для МVP; за потреби — режим «впритул»
   (генерувати слоти від кінця попереднього запису). */
const BK_START = 8 * 60, BK_END = 18 * 60, BK_STEP = 30;
function toMin(t) { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
function fmtMin(min) { return String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0"); }
function slotsList(startMin = BK_START, endMin = BK_END) {
  const out = [];
  const s0 = Math.ceil(startMin / BK_STEP) * BK_STEP;
  for (let m = s0; m < endMin; m += BK_STEP) out.push(fmtMin(m));
  return out;
}

/* ── Дата народження ── */
function dobFmt(s) { if (!s) return ""; const p = String(s).split("-"); return p.length === 3 ? p[2] + "." + p[1] + "." + p[0] : s; }
function dobMask(raw) {
  const d = String(raw).replace(/\D/g, "").slice(0, 8);
  let out = d.slice(0, 2);
  if (d.length >= 3) out += "." + d.slice(2, 4);
  if (d.length >= 5) out += "." + d.slice(4, 8);
  return out;
}
function parseDob(text) {
  const m = String(text).match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return { ok: false, partial: true };
  const dd = +m[1], mm = +m[2], yyyy = +m[3];
  const t = today0();
  if (mm < 1 || mm > 12) return { ok: false, err: "Некоректний місяць" };
  if (dd < 1 || dd > 31) return { ok: false, err: "Некоректний день" };
  const dt = new Date(yyyy, mm - 1, dd);
  if (dt.getFullYear() !== yyyy || dt.getMonth() !== mm - 1 || dt.getDate() !== dd) return { ok: false, err: "Такої дати не існує" };
  if (dt > t) return { ok: false, err: "Дата в майбутньому" };
  if (yyyy < t.getFullYear() - 120) return { ok: false, err: "Перевірте рік (вік > 120)" };
  return { ok: true, iso: yyyy + "-" + m[2] + "-" + m[1] };
}

export function DobField({ value, onChange, invalid }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(() => dobFmt(value));
  const [err, setErr] = useState("");
  const t = today0();
  const base = value ? new Date(value + "T00:00:00") : new Date(t.getFullYear() - 30, t.getMonth(), 1);
  const [viewMonth, setViewMonth] = useState(() => new Date(base.getFullYear(), base.getMonth(), 1));
  const shift = (n) => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));
  const shiftYear = (n) => setViewMonth((m) => new Date(m.getFullYear() + n, m.getMonth(), 1));

  function onType(raw) {
    const masked = dobMask(raw);
    setText(masked);
    if (masked.length < 10) { setErr(""); onChange(""); return; }
    const res = parseDob(masked);
    if (res.ok) { setErr(""); onChange(res.iso); const d = new Date(res.iso + "T00:00:00"); setViewMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }
    else { setErr(res.err || "Некоректна дата"); onChange(""); }
  }
  function openCal() {
    if (value) { const d = new Date(value + "T00:00:00"); setViewMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }
    setOpen((o) => !o);
  }
  const y = viewMonth.getFullYear(), mo = viewMonth.getMonth();
  const first = new Date(y, mo, 1);
  const days = new Date(y, mo + 1, 0).getDate();
  const startIdx = dowMon(first);
  const label = MONTHS_NOM[mo] + " " + y;
  const sel = value ? new Date(value + "T00:00:00") : null;
  const cells = [];
  for (let i = 0; i < startIdx; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  function pick(d) {
    const cd = new Date(y, mo, d);
    const iso = cd.getFullYear() + "-" + String(cd.getMonth() + 1).padStart(2, "0") + "-" + String(cd.getDate()).padStart(2, "0");
    onChange(iso); setText(dobFmt(iso)); setErr(""); setOpen(false);
  }
  return (
    <div className="bk-dob">
      <div className="bk-dob-field">
        <input className={"inp bk-dob-input" + (err || invalid ? " bk-dob-inv" : "")} type="text" inputMode="numeric"
          placeholder="дд.мм.рррр" value={text} maxLength={10} onChange={(e) => onType(e.target.value)} />
        <button type="button" className={"bk-dob-ic-btn" + (open ? " open" : "")} onClick={openCal} title="Обрати в календарі">🗓</button>
      </div>
      {err && <span className="bk-dob-err">⚠ {err}</span>}
      {open && (
        <>
          <div className="bk-dob-backdrop" onClick={() => setOpen(false)} />
          <div className="bk-dob-pop">
            <div className="cal-head">
              <div className="cal-nav">
                <button type="button" className="mini-icon" style={{ width: 24, height: 24 }} onClick={() => shiftYear(-1)} title="Попередній рік">«</button>
                <button type="button" className="mini-icon" style={{ width: 24, height: 24 }} onClick={() => shift(-1)} title="Попередній місяць">‹</button>
              </div>
              <span className="cal-month">{label}</span>
              <div className="cal-nav">
                <button type="button" className="mini-icon" style={{ width: 24, height: 24 }} onClick={() => shift(1)} title="Наступний місяць">›</button>
                <button type="button" className="mini-icon" style={{ width: 24, height: 24 }} onClick={() => shiftYear(1)} title="Наступний рік">»</button>
              </div>
            </div>
            <div className="cal-grid">
              {WK_SHORT.map((d) => <div className="cal-dow" key={d}>{d}</div>)}
              {cells.map((d, i) => {
                if (d === null) return <div className="cal-day empty-day" key={"e" + i} />;
                const cd = new Date(y, mo, d);
                const isSel = sel && sameDay(cd, sel);
                const isToday = sameDay(cd, t);
                const future = cd > t;
                return (
                  <button type="button" key={d} disabled={future}
                    className={"cal-day" + (isSel ? " selected" : "") + (isToday && !isSel ? " today" : "") + (future ? " muted" : "")}
                    onClick={() => !future && pick(d)}>{d}</button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function BookingCalendar({ value, onPick }) {
  const t = today0();
  const [viewMonth, setViewMonth] = useState(() => new Date(value.getFullYear(), value.getMonth(), 1));
  const shift = (n) => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));
  const y = viewMonth.getFullYear(), mo = viewMonth.getMonth();
  const first = new Date(y, mo, 1);
  const days = new Date(y, mo + 1, 0).getDate();
  const startIdx = dowMon(first);
  const label = MONTHS_NOM[mo] + " " + y;
  const cells = [];
  for (let i = 0; i < startIdx; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  return (
    <div className="bk-cal">
      <div className="cal-head">
        <span className="cal-month">{label}</span>
        <div className="cal-nav">
          <button className="mini-icon" style={{ width: 24, height: 24 }} onClick={() => shift(-1)} title="Попередній місяць">‹</button>
          <button className="mini-icon" style={{ width: 24, height: 24 }} onClick={() => shift(1)} title="Наступний місяць">›</button>
        </div>
      </div>
      <div className="cal-grid">
        {WK_SHORT.map((d) => <div className="cal-dow" key={d}>{d}</div>)}
        {cells.map((d, i) => {
          if (d === null) return <div className="cal-day empty-day" key={"e" + i} />;
          const cd = new Date(y, mo, d);
          const isToday = sameDay(cd, t);
          const isSel = sameDay(cd, value);
          const isSunday = cd.getDay() === 0;
          const isPast = cd < t;
          const disabled = isPast || isSunday;
          return (
            <button className={"cal-day" + (isToday ? " today" : "") + (isSel && !isToday ? " selected" : "") + (disabled ? " muted" : "") + (isSunday && !isPast ? " holiday" : "")}
              key={d} disabled={disabled} onClick={() => !disabled && onPick(cd)}>
              {d}{!disabled && <span className="cdot" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function BookingModal({ rooms, clinicId, incidents = [], onClose, onSave }) {
  const [name, setName] = useState("");
  const [dob, setDob] = useState("");
  const [gender, setGender] = useState("");
  const [weight, setWeight] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [studyType, setStudyType] = useState("MRT");
  const [region, setRegion] = useState("");
  const [contrast, setContrast] = useState(false);
  const [hasContra, setHasContra] = useState(false);
  const [cito, setCito] = useState(false);
  const [notes, setNotes] = useState("");
  const [docs, setDocs] = useState([]);
  const [doctorId, setDoctorId] = useState("");
  const [addDoc, setAddDoc] = useState(false);
  const [override, setOverride] = useState(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      if (!clinicId) return;
      const supabase = createClient();
      // Джерело лікарів-направників = довідник doctors + АКТИВНІ направники центру
      // (referral_access → profiles). Єдиний перелік для всього центру.
      const [docRes, accRes] = await Promise.all([
        supabase.from("doctors").select("id, name, spec, clinic_name, phone").eq("clinic_id", clinicId).order("name"),
        supabase.from("referral_access").select("referrer_id").eq("clinic_id", clinicId).eq("status", "active"),
      ]);
      const list = docRes.data || [];
      const seen = new Set(list.map((d) => (d.name || "").trim()));
      const refIds = Array.from(new Set((accRes.data || []).map((a) => a.referrer_id)));
      if (refIds.length) {
        const { data: profs } = await supabase.from("profiles").select("id, full_name").in("id", refIds);
        (profs || []).forEach((pr) => { const n = (pr.full_name || "").trim(); if (n && !seen.has(n)) { seen.add(n); list.push({ id: "ref:" + pr.id, name: n, spec: "направник" }); } });
      }
      list.sort((a, b) => (a.name || "").localeCompare(b.name || "", "uk"));
      if (!cancel) setDocs(list);
    })();
    return () => { cancel = true; };
  }, [clinicId]);

  const roomsOfType = (t) => (rooms || []).filter((r) => r.modality === (t === "MRT" ? "MRI" : "CT"));
  const [roomId, setRoomId] = useState(() => (roomsOfType("MRT")[0] || (rooms || [])[0] || {}).id || "");
  const [bookDate, setBookDate] = useState(() => today0());
  const [time, setTime] = useState("");
  const [dayEntries, setDayEntries] = useState([]);

  const allRegions = studyType === "MRT" ? MRT_REGIONS : CT_REGIONS;
  const regions = contrast ? allRegions.filter((r) => r.contrast) : allRegions;
  const primaryKind = studyType === "MRT" ? "МРТ" : "КТ";

  function changeType(t) {
    setStudyType(t); setRegion(""); setContrast(false); setTime("");
    const list = roomsOfType(t);
    setRoomId((list[0] || {}).id || "");
    const k = t === "MRT" ? "МРТ" : "КТ";
    setExtraStudies((a) => a.map((s) => (s.type === k ? s : { ...s, type: k, region: "", dur: exDur(k, "") })));
  }
  function toggleContrast(v) {
    setContrast(v);
    if (v && region && !allRegions.some((r) => r.label === region && r.contrast)) { setRegion(""); setTime(""); }
  }
  function calcAge(d) { if (!d) return 0; const b = new Date(d); if (isNaN(b.getTime())) return 0; const n = new Date(); let a = n.getFullYear() - b.getFullYear(); const m = n.getMonth() - b.getMonth(); if (m < 0 || (m === 0 && n.getDate() < b.getDate())) a--; return a < 0 ? 0 : a; }

  const contrastSuffix = contrast ? " з контрастом" : "";
  const procLabel = region ? `${primaryKind} · ${region}${contrastSuffix}` : primaryKind;
  const regionObj = regions.find((r) => r.label === region);
  const computedDur = regionObj ? regionObj.dur + (contrast ? CONTRAST_DUR : 0) : (studyType === "MRT" ? 45 : 20);
  const price = regionObj ? regionObj.price + (contrast ? CONTRAST_SURCHARGE : 0) : null;
  const fmtPrice = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₴";

  const [durEdit, setDurEdit] = useState("");
  useEffect(() => { if (region) setDurEdit(String(computedDur)); }, [region, contrast, studyType]); // eslint-disable-line
  const dur = Math.max(5, parseInt(durEdit, 10) || computedDur);
  const durCustom = region && parseInt(durEdit, 10) && parseInt(durEdit, 10) !== computedDur;

  const [extraStudies, setExtraStudies] = useState([]);
  const exRegions = (t) => regionsFor(t);
  const exDur = (t, reg) => { const o = exRegions(t).find((r) => r.label === reg); return o ? o.dur : (t === "КТ" ? 20 : 45); };
  const exPatch = (i, p) => setExtraStudies((a) => a.map((r, idx) => (idx === i ? { ...r, ...p } : r)));
  const exSetRegion = (i, reg) => { const r = extraStudies[i]; exPatch(i, { region: reg, dur: exDur(r.type, reg) }); };
  const exSetDur = (i, v) => exPatch(i, { dur: Math.max(5, parseInt(v, 10) || 0) });
  const exAdd = () => setExtraStudies((a) => [...a, { type: primaryKind, region: "", dur: exDur(primaryKind, "") }]);
  const exRemove = (i) => setExtraStudies((a) => a.filter((_, idx) => idx !== i));
  const validExtra = extraStudies.filter((s) => s.region);

  const primaryStudy = region ? { type: primaryKind, region, contrast: contrast === true, dur, price: studyPrice(primaryKind, region, contrast) } : null;
  const allStudies = (primaryStudy ? [primaryStudy] : []).concat(validExtra.map((s) => ({ type: s.type, region: s.region, dur: parseInt(s.dur, 10) || 0, price: studyPrice(s.type, s.region, false) })));
  const combinedLabel = allStudies.length ? allStudies.map(studyLabel).join(" + ") : procLabel;
  const slotDur = dur + validExtra.reduce((s, x) => s + (parseInt(x.dur, 10) || 0), 0);

  /* зайняті слоти обраного кабінету на обрану дату — з Supabase */
  useEffect(() => {
    let cancel = false;
    async function load() {
      const supabase = createClient();
      if (clinicId) {
        const ovRes = await supabase.from("schedule_overrides").select("all_closed, label, rooms").eq("clinic_id", clinicId).eq("override_date", dateKey(bookDate)).maybeSingle();
        if (!cancel) setOverride(ovRes.data || null);
      }
      if (!roomId) { setDayEntries([]); return; }
      const { data } = await supabase
        .from("queue_entries")
        .select("scheduled_time, duration_min, patient_name, status")
        .eq("room_id", roomId)
        .eq("scheduled_date", dateKey(bookDate))
        .neq("status", "cancelled")
        .neq("status", "no_show")
        .neq("status", "not_held");
      if (!cancel) setDayEntries(data || []);
    }
    load();
    return () => { cancel = true; };
  }, [roomId, bookDate, clinicId]);

  const roomBusy = dayEntries
    .filter((p) => p.scheduled_time)
    .map((p) => ({ s: toMin(p.scheduled_time), e: toMin(p.scheduled_time) + (p.duration_min || 30), name: p.patient_name }));
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const isBookToday = sameDay(bookDate, today0());
  const roomSched = roomScheduleFor(bookDate, roomId, override);
  const schedStartMin = toMin(roomSched.start), schedEndMin = toMin(roomSched.end);

  // Простій (поломка/ТО) обраного кабінету: слоти у вікні інциденту — недоступні.
  const roomIncidents = (incidents || []).filter((i) => i.room_id === roomId);
  function slotBlockedByIncident(slotMin) {
    if (!roomIncidents.length) return false;
    const base = Date.UTC(bookDate.getFullYear(), bookDate.getMonth(), bookDate.getDate(), Math.floor(slotMin / 60), slotMin % 60);
    return roomIncidents.some((inc) => {
      const start = new Date(inc.started_at).getTime();
      return base >= start && base < incidentEffectiveEnd(inc);
    });
  }

  function slotState(slot) {
    const s = toMin(slot), e = s + slotDur;
    if (roomSched.closed) return "closed";
    if (slotBlockedByIncident(s)) return "blocked";
    if (s < schedStartMin || s >= schedEndMin) return "offhours";
    if (e > schedEndMin) return "tight";
    if (isBookToday && s < nowMin) return "past";
    if (roomBusy.some((b) => s >= b.s && s < b.e)) return "busy";
    if (roomBusy.some((b) => s < b.e && b.s < e)) return "tight";
    return "free";
  }
  function nextApptAfter(slot) {
    const s = toMin(slot);
    const after = roomBusy.filter((b) => b.s >= s).sort((a, b) => a.s - b.s)[0];
    return after ? fmtMin(after.s) : null;
  }
  const slots = slotsList(schedStartMin, schedEndMin);
  const freeCount = slots.filter((s) => slotState(s) === "free").length;
  const busyList = roomBusy.slice().sort((a, b) => a.s - b.s);

  const miss = { name: !name.trim(), dob: !dob, gender: !gender, phone: !phone.trim(), region: !region, time: !time };
  const MISS_LABELS = { name: "ПІБ", dob: "Дата народження", gender: "Стать", phone: "Телефон", region: "Область дослідження", time: "Слот часу" };
  const missingList = Object.keys(MISS_LABELS).filter((k) => miss[k]).map((k) => MISS_LABELS[k]);
  const timeBad = time ? slotState(time) !== "free" : false;
  const room = (rooms || []).find((r) => r.id === roomId) || null;
  const valid = missingList.length === 0 && roomId && !timeBad && !roomSched.closed;

  function handleSave() {
    if (!valid) return;
    onSave({
      name: name.trim(), phone, email: email.trim() || null,
      age: calcAge(dob), dob, weight: weight ? +weight : null, gender,
      proc: combinedLabel, dur: slotDur, studies: allStudies,
      roomId, date: bookDate, time, notes: notes.trim() || null,
      hasContra, cito, doctor: (docs.find((d) => String(d.id) === String(doctorId)) || {}).name || null,
      referrerId: (() => { const sel = docs.find((d) => String(d.id) === String(doctorId)); return sel && String(sel.id).startsWith("ref:") ? String(sel.id).slice(4) : null; })(),
    });
  }

  const roomKeys = roomsOfType(studyType);

  return (
    <>
    <div className="overlay">
      <div className="dialog fade-in bk-dialog">
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic">＋</span>Новий запис</div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        <div className="bk-grid">
          {/* ЛІВА КОЛОНКА */}
          <div className="bk-col bk-col-left">
            <div className="bk-section-label">Пацієнт</div>

            <label className="fld">
              <span className={"fld-lab" + (miss.name ? " bk-miss-lab" : "")}>ПІБ *</span>
              <input className="inp" placeholder="Прізвище Ім'я По батькові" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </label>

            <div className="fld-row">
              <div className="fld" style={{ flex: "0 0 150px" }}>
                <span className={"fld-lab" + (miss.dob ? " bk-miss-lab" : "")}>Дата народження *</span>
                <DobField value={dob} onChange={setDob} invalid={miss.dob} />
              </div>
              <div className="fld" style={{ flex: "0 0 auto" }}>
                <span className={"fld-lab" + (miss.gender ? " bk-miss-lab" : "")}>Стать *</span>
                <div className="bk-gender-row">
                  <button className={"bk-gender-btn" + (gender === "М" ? " active" : "")} onClick={() => setGender("М")} title="Чоловіча">♂</button>
                  <button className={"bk-gender-btn" + (gender === "Ж" ? " active" : "")} onClick={() => setGender("Ж")} title="Жіноча">♀</button>
                </div>
              </div>
              <div className="fld" style={{ flex: "0 0 52px" }}>
                <span className="fld-lab">Вік</span>
                <div className="inp bk-age" title="Розраховано з дати народження">{dob ? calcAge(dob) : "—"}</div>
              </div>
              <label className="fld" style={{ flex: "0 0 60px" }}>
                <span className="fld-lab">Вага</span>
                <input className="inp" placeholder="кг" value={weight} onChange={(e) => setWeight(e.target.value.replace(/\D/g, ""))} />
              </label>
            </div>

            <div className="fld-row">
              <label className="fld">
                <span className={"fld-lab" + (miss.phone ? " bk-miss-lab" : "")}>Телефон *</span>
                <input className="inp" type="tel" placeholder="+38 0__ ___ __ __" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </label>
              <label className="fld">
                <span className="fld-lab">Email</span>
                <input className="inp" type="email" placeholder="patient@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              </label>
            </div>

            <div className="bk-section-label">Дослідження</div>

            <div className="fld-row" style={{ alignItems: "flex-end" }}>
              <div className="fld" style={{ flex: "0 0 130px" }}>
                <span className="fld-lab">Тип *</span>
                <div className="bk-seg">
                  <button className={"bk-seg-btn" + (studyType === "MRT" ? " active mrt" : "")} onClick={() => changeType("MRT")}>МРТ</button>
                  <button className={"bk-seg-btn" + (studyType === "CT" ? " active ct" : "")} onClick={() => changeType("CT")}>КТ</button>
                </div>
              </div>
              <div className="fld">
                <span className="fld-lab">Параметри</span>
                <div className="bk-check-row">
                  <label className={"rf-check" + (contrast ? " on" : "")}>
                    <input type="checkbox" checked={contrast} onChange={(e) => toggleContrast(e.target.checked)} />
                    <span className="rf-box" /><span>Контраст</span>
                  </label>
                  <label className={"rf-check" + (hasContra ? " warn" : "")}>
                    <input type="checkbox" checked={hasContra} onChange={(e) => setHasContra(e.target.checked)} />
                    <span className="rf-box" /><span>Протипоказання</span>
                  </label>
                  <label className={"rf-check" + (cito ? " warn" : "")}>
                    <input type="checkbox" checked={cito} onChange={(e) => setCito(e.target.checked)} />
                    <span className="rf-box" /><span>CITO (терміново)</span>
                  </label>
                </div>
              </div>
            </div>

            <div className="fld-row" style={{ alignItems: "flex-start" }}>
              <label className="fld" style={{ flex: "1 1 auto" }}>
                <span className={"fld-lab" + (miss.region ? " bk-miss-lab" : "")}>Область дослідження *</span>
                <select className="inp" value={region} onChange={(e) => setRegion(e.target.value)}>
                  <option value="">— Оберіть область —</option>
                  {regions.map((r) => (
                    <option key={r.label} value={r.label}>{r.label}{contrastSuffix} · {r.dur + (contrast ? CONTRAST_DUR : 0)} хв</option>
                  ))}
                </select>
              </label>
              <label className="fld" style={{ flex: "0 0 108px" }}>
                <span className="fld-lab">Тривалість *</span>
                <div className="bk-dur-row">
                  <input className="inp bk-dur-input" type="number" min="5" step="5" placeholder="—"
                    value={durEdit} onChange={(e) => setDurEdit(e.target.value.replace(/\D/g, ""))} disabled={!region} />
                  <span className="bk-dur-unit">хв</span>
                </div>
                <span className={"bk-time-state " + (durCustom ? "busy" : "none")}>
                  {!region ? "оберіть область" : durCustom ? `↺ за замовч. ${computedDur} хв` : "за тривалістю області"}
                </span>
              </label>
            </div>

            {price != null && (
              <div className="ctx-hint blue" style={{ marginBottom: 6 }}>Орієнтовна вартість: {fmtPrice(price)}</div>
            )}

            {/* Додаткові дослідження */}
            <div className="fld">
              {extraStudies.length > 0 && (
                <div className="bk-study-table">
                  <div className="bk-study-head"><span>Тип</span><span>Область дослідження</span><span>Трив.</span><span /></div>
                  {extraStudies.map((r, i) => {
                    const regs = exRegions(r.type);
                    return (
                      <div className="bk-study-row" key={i}>
                        <div className="bk-seg bk-seg-sm st-seg-locked" title="Тип = тип основного дослідження">
                          <button className={"bk-seg-btn active " + (primaryKind === "МРТ" ? "mrt" : "ct")} disabled>{primaryKind}</button>
                        </div>
                        <select className="inp" value={r.region} onChange={(e) => exSetRegion(i, e.target.value)}>
                          <option value="">— Оберіть область —</option>
                          {regs.map((x) => <option key={x.label} value={x.label}>{x.label} · {x.dur} хв</option>)}
                        </select>
                        <div className="bk-study-dur"><input className="inp" type="number" min="5" step="5" value={r.dur} onChange={(e) => exSetDur(i, e.target.value)} /><span className="st-dur-u">хв</span></div>
                        <button className="st-row-del" title="Прибрати" onClick={() => exRemove(i)}>✕</button>
                      </div>
                    );
                  })}
                </div>
              )}
              <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: extraStudies.length > 0 ? 8 : 0 }} onClick={exAdd}>＋ Додати дослідження</button>
            </div>

            <div className="fld">
              <span className="fld-lab">Лікар-направник</span>
              <div style={{ display: "flex", gap: 8 }}>
                <select className="inp" value={doctorId} onChange={(e) => setDoctorId(e.target.value)} style={{ flex: 1 }}>
                  <option value="">— Без направлення / самозвернення —</option>
                  {docs.map((d) => <option key={d.id} value={d.id}>{d.name}{d.spec ? " · " + d.spec : ""}</option>)}
                </select>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAddDoc(true)}>＋ Додати</button>
              </div>
            </div>

            <label className="fld" style={{ flex: 1 }}>
              <span className="fld-lab">Примітки</span>
              <textarea className="inp bk-notes" placeholder="Додаткова інформація, скеровання, особливі вимоги…" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
          </div>

          {/* ПРАВА КОЛОНКА — Scheduler */}
          <div className="bk-col bk-col-right">
            <div className="bk-sched-head">
              <span className="bk-sched-spark">✦</span>
              <span className="bk-sched-title">Розклад</span>
              <span className="bk-sched-sync"><span className="pulse-dot" style={{ background: "var(--green)", width: 6, height: 6 }} /> синхр. з чергою</span>
            </div>

            <div className="fld">
              <span className="fld-lab">Кабінет ({studyType === "MRT" ? "МРТ" : "КТ"})</span>
              {roomKeys.length === 0 ? (
                <div className="ctx-hint red">Немає кабінетів типу {studyType === "MRT" ? "МРТ" : "КТ"}. Додайте обладнання в налаштуваннях.</div>
              ) : (
                <>
                  <div className="bk-room-chips">
                    {roomKeys.map((r) => {
                      const num = (String(r.name).match(/№?\s*(\d+)/) || [])[1] || r.name;
                      return (
                        <button key={r.id} className={"bk-room-chip" + (roomId === r.id ? " active" : "") + (studyType === "MRT" ? " mrt" : " ct")}
                          onClick={() => { setRoomId(r.id); setTime(""); }} title={r.name + (r.apparatus_model ? " · " + r.apparatus_model : "")}>
                          №{num}
                        </button>
                      );
                    })}
                  </div>
                  {room && room.apparatus_model && <span className="bk-room-model-line">{room.apparatus_model}</span>}
                </>
              )}
            </div>

            <BookingCalendar value={bookDate} onPick={(d) => { setBookDate(d); setTime(""); }} />

            <div className="fld">
              <div className="bk-slots-head">
                <span className={"fld-lab" + (miss.time ? " bk-miss-lab" : "")} style={{ margin: 0 }}>Вільні слоти · {fmtShort(bookDate)} {miss.time ? "— оберіть час *" : ""}</span>
                <span className="bk-free-count">блок {slotDur} хв{allStudies.length > 1 ? ` (${allStudies.length} досл.)` : ""} · {freeCount} вільних</span>
              </div>
              {roomSched.closed && <div className="ctx-hint red" style={{ marginBottom: 10 }}>🚫 {room ? room.name : "Кабінет"} не працює {fmtShort(bookDate)}{override && override.label ? " · " + override.label : ""}. Оберіть інший день або кабінет.</div>}
              {!roomSched.closed && roomSched.custom && <div className="ctx-hint blue" style={{ marginBottom: 10 }}>🕐 Особливий графік {fmtShort(bookDate)}: {roomSched.start}–{roomSched.end}.</div>}
              {!roomSched.closed && slots.some((s) => slotState(s) === "blocked") && <div className="ctx-hint red" style={{ marginBottom: 10 }}>🔧 {room ? room.name : "Кабінет"} на ремонті/ТО{roomIncidents[0]?.blocked_until ? " до " + new Date(Math.max(...roomIncidents.map((i) => i.blocked_until ? new Date(i.blocked_until).getTime() : 0))).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) : ""}. Оберіть слот після відновлення або інший день/кабінет.</div>}
              <div className={"bk-slot-grid" + (miss.time ? " bk-miss-slots" : "")}>
                {slots.map((s) => {
                  const st = slotState(s);
                  const title = st === "busy" ? "Зайнято"
                    : st === "blocked" ? "Кабінет на ремонті/ТО"
                    : st === "tight" ? `Не вміщується: блок ${slotDur} хв перетне ${nextApptAfter(s) ? "запис о " + nextApptAfter(s) : "кінець графіка (" + fmtMin(schedEndMin) + ")"}`
                    : st === "past" ? "Час минув"
                    : `Вільно · ${s}–${fmtMin(toMin(s) + slotDur)}`;
                  return (
                    <button key={s} className={"slot" + (time === s ? " sel" : "") + (st !== "free" ? " taken" : "") + (st === "tight" ? " tight" : "") + ((st === "busy" || st === "blocked") ? " busy" : "")}
                      disabled={st !== "free"} onClick={() => setTime(s)} title={title}>{s}</button>
                  );
                })}
              </div>
              {busyList.length > 0 && (
                <div className="bk-busy-list">
                  <span className="bk-busy-lab">Зайнятий час:</span>
                  {busyList.map((b, i) => <span className="bk-busy-chip" key={i}>{fmtMin(b.s)}–{fmtMin(b.e)}</span>)}
                </div>
              )}
              <div className="bk-slot-legend">
                <span><span className="lg-dot free" />вільно</span>
                <span><span className="lg-dot tight" />не вміщується</span>
                <span><span className="lg-dot busy" />зайнято</span>
              </div>
              {time && (() => {
                const s = toMin(time), e = s + slotDur;
                const blocked = slotBlockedByIncident(s);
                const conflict = roomBusy.find((b) => s < b.e && b.s < e);
                return (
                  <div className={"bk-slot-confirm " + (blocked || conflict ? "bad" : "ok")}>
                    {blocked ? <>⚠ Кабінет на ремонті/ТО у цей час — оберіть інший слот або день</>
                      : conflict ? <>⚠ Перетин із записом {fmtMin(conflict.s)}–{fmtMin(conflict.e)} — оберіть інший слот</>
                      : <>✓ Слот вільний. Запис: <b>{time}–{fmtMin(e)}</b> ({slotDur} хв).</>}
                  </div>
                );
              })()}
            </div>
          </div>
        </div>

        <div className="dlg-foot">
          {valid
            ? <span className="bk-summary">{name.split(" ").slice(0, 2).join(" ")} · {allStudies.length > 1 ? allStudies.length + " досл." : primaryKind} · {room ? room.name : ""} · {fmtShort(bookDate)} {time}–{fmtMin(toMin(time) + slotDur)}</span>
            : <span className="bk-missing">{missingList.map((m, i) => <span className="bk-miss-chip" key={i}>{m}</span>)}</span>}
          <button className="btn btn-ghost" onClick={onClose}>Скасувати</button>
          <button className="btn btn-primary" disabled={!valid} onClick={handleSave}>Зберегти запис</button>
        </div>
      </div>
    </div>
    {addDoc && (
      <AddDoctorModal existing={docs} onClose={() => setAddDoc(false)} onSave={async (d) => {
        const supabase = createClient();
        const { data, error } = await supabase.from("doctors").insert({ clinic_id: clinicId, name: d.name, spec: d.spec || null, clinic_name: d.clinic || null, phone: d.phone || null }).select("id, name, spec, clinic_name, phone").single();
        if (!error && data) { setDocs((arr) => [...arr, data]); setDoctorId(String(data.id)); }
        setAddDoc(false);
      }} />
    )}
    </>
  );
}
