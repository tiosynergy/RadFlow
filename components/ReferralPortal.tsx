"use client";

/* ===== RadFlow — Referral Portal 2.0 (крос-клінічний портал направників) =====
   Глобальний направник працює з кількома центрами через referral_access.
   Вкладки: «Нове направлення», «Мої направлення», «Мої центри».
   Зайнятість слотів — через знеособлений RPC room_busy_slots (без PII). */

import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";
import LiveClock from "@/components/LiveClock";
import CeoDashboardLink from "@/components/CeoDashboardLink";
import PatientEditModal from "@/components/PatientEditModal";
import PhoneInput from "@/components/PhoneInput";
import CitySelect from "@/components/CitySelect";
import RescheduleModal from "@/components/RescheduleModal";
import ReferrerBoard from "@/components/ReferrerBoard";
import ReferrerSidebar from "@/components/ReferrerSidebar";
import { createReferralBooking, rescheduleQueueEntry, cancelQueueEntry, editQueueEntryStudies } from "@/app/queue/actions";
import StudyEditModal from "@/components/StudyEditModal";
import WaitlistModal, { type WaitlistFormOut } from "@/components/WaitlistModal";
import ConfirmDialog from "@/components/ConfirmDialog";
import { addWaitlistEntry, setWaitlistStatus, setWaitlistPriority, updateWaitlistEntry } from "@/app/waitlist/actions";
import { WAITLIST_STATUS_META, desiredWindowText, compareWaitlist } from "@/lib/waitlist";
import { isLate, LATE_META } from "@/lib/queueStatus";
import type { WaitlistEntry } from "@/supabase/types";
import { roomScheduleFor, roomBreaksFor, overlapsBreak, type DayOverride } from "@/lib/schedule";
import { slotBlockedByIncidents, type IncidentLike } from "@/lib/incidents";
import { regionsFor, studyPrice, studyLabel, diffStudies, studiesChanged, studyText, CONTRAST_DUR, CONTRAST_SURCHARGE, BUFFER_DEFAULT, BUFFER_OPTIONS, normBuffer } from "@/lib/studies";
import { PRIORITY_OPTIONS, PRIORITY_META, type PatientPriority } from "@/lib/priority";
import { DobField, BookingCalendar, fmtShort, today0, sameDay } from "@/components/BookingModal";
import type { Json } from "@/supabase/types";
import "@/styles/prototype/radflow.css";

type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null };
type Center = { clinicId: string; name: string; city: string | null; status: string; policy?: string | null; room_ids?: string[] | null; accessId?: string | null; timezone?: string | null };
type Referral = {
  id: string; clinic_id: string; created_by: string | null; referrer_id: string | null; patient_name: string | null; patient_phone: string | null; patient_age: number | null;
  scheduled_date: string | null; scheduled_time: string | null; duration_min: number | null; buffer_time_min: number | null; status: string; call_status: string | null;
  priority_level: PatientPriority | null; studies: Json; studies_original: Json | null; studies_changed_by: string | null; contraindications: boolean; doctor: string | null; note: string | null; indication: string | null; room_id: string | null; reschedule_origin: Json | null;
};
type StudyOut = { type: string; region: string; contrast?: boolean; dur: number; price: number | null };
type ExtraStudy = { type: string; region: string; dur: number };
type BusySlot = { scheduled_time: string; duration_min: number; buffer_time_min: number | null };
type SearchClinic = { id: string; name: string; city: string | null; modalities: string[] };
type CenterCardData = {
  name?: string; city?: string | null; policy?: string | null; note?: string | null;
  admins?: Array<{ full_name?: string | null; phone?: string | null; email?: string | null }>;
  rooms?: RoomOpt[];
};
type ApiResult = { ok: boolean; data: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

function pad(n: number) { return String(n).padStart(2, "0"); }
function toMin(t: string | null | undefined) { const p = String(t || "").split(":"); return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0); }
function fmt(m: number) { return pad(Math.floor(m / 60)) + ":" + pad(m % 60); }
function dateVal(d: Date) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function calcAge(dob: string | null | undefined) { if (!dob) return null; return Math.floor((Date.now() - new Date(dob).getTime()) / (365.25 * 24 * 3600 * 1000)); }
function modalityLabel(m: string) { return m === "MRI" ? "МРТ" : m === "CT" ? "КТ" : "Інше"; }
function procLabel(e: { studies?: unknown; note?: string | null }) {
  const s = Array.isArray(e.studies) ? (e.studies as Array<{ type?: string; region?: string }>) : [];
  if (s.length) return s.map((x) => (x.type || "") + (x.region ? " · " + x.region : "")).join(" + ");
  return e.note || "—";
}
function centerLabel(c?: { name: string; city?: string | null } | null) { return c ? c.name + (c.city ? " · " + c.city : "") : "—"; }
/** Derived «Запізнення» для направлення (та сама формула, що на дошці). */
function refIsLate(r: { status: string; scheduled_date: string | null; scheduled_time: string | null; buffer_time_min: number | null }): boolean {
  if (!r.scheduled_date) return false;
  return isLate(r.status, new Date(r.scheduled_date + "T00:00:00"), r.scheduled_time, r.buffer_time_min);
}

const ST: Record<string, { label: string; cls: string }> = {
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
const ACCESS_ST: Record<string, { label: string; cls: string }> = {
  active: { label: "Активний", cls: "green" },
  pending_clinic: { label: "Очікує підтвердження центру", cls: "yellow" },
  pending_referrer: { label: "Запрошення центру", cls: "blue" },
  revoked: { label: "Відкликано", cls: "gray" },
  declined: { label: "Відхилено", cls: "gray" },
};

async function postJSON(url: string, body: unknown): Promise<ApiResult> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  } catch { return { ok: false, data: { error: "Помилка зʼєднання із сервером" } }; }
}

/* ---------- Вкладка «Нове направлення» ---------- */
interface NewReferralProps {
  activeCenters: Center[];
  roomsByClinic: Record<string, RoomOpt[]>;
  doctorName: string;
  doctorId: string;
  onCreated: (nm: string | null, err?: string) => void;
}

function NewReferral({ activeCenters, roomsByClinic, doctorName, doctorId, onCreated }: NewReferralProps) {
  const [centerId, setCenterId] = useState(() => (activeCenters.length === 1 ? activeCenters[0].clinicId : ""));
  const [name, setName] = useState("");
  const [dob, setDob] = useState("");
  const [gender, setGender] = useState("");
  const [weight, setWeight] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [studyType, setStudyType] = useState("МРТ");
  const [region, setRegion] = useState("");
  const [contrast, setContrast] = useState(false);
  const [buffer, setBuffer] = useState<number>(BUFFER_DEFAULT);
  const [hasContra, setHasContra] = useState(false);
  const [priority, setPriority] = useState<PatientPriority | "">("");
  const [comment, setComment] = useState("");
  const [extraStudies, setExtraStudies] = useState<ExtraStudy[]>([]);
  const [bookDate, setBookDate] = useState(() => { const d = today0(); d.setDate(d.getDate() + 1); return d; });
  const [roomId, setRoomId] = useState<string | null>(null);
  const [time, setTime] = useState("");
  const [dayEntries, setDayEntries] = useState<BusySlot[]>([]);
  const [override, setOverride] = useState<DayOverride | null>(null);
  const [roomSchedule, setRoomSchedule] = useState<unknown>(null); // rooms.schedule обраного кабінету (для перерв)
  const [incidents, setIncidents] = useState<IncidentLike[]>([]);
  const [busy, setBusy] = useState(false);

  const date = dateVal(bookDate);
  const modality = studyType === "КТ" ? "CT" : "MRI";
  const primaryKind = studyType;
  const selCenter = activeCenters.find((c) => c.clinicId === centerId) || null;
  const allRooms = roomsByClinic[centerId] || [];
  const allowedRoomIds = selCenter && Array.isArray(selCenter.room_ids) && selCenter.room_ids.length ? selCenter.room_ids : null;
  const rooms = allowedRoomIds ? allRooms.filter((r) => allowedRoomIds.includes(r.id)) : allRooms;
  const hasMRI = rooms.some((r) => r.modality === "MRI");
  const hasCT = rooms.some((r) => r.modality === "CT");
  const modAllowed = (code: string) => (code === "MRI" ? hasMRI : code === "CT" ? hasCT : false);
  const roomsOfType = rooms.filter((r) => r.modality === modality);
  const room = roomsOfType.find((r) => r.id === roomId) || null;

  const allRegions = regionsFor(studyType);
  const regions = contrast ? allRegions.filter((r) => r.contrast) : allRegions;
  const regionObj = regions.find((r) => r.label === region);
  const contrastSuffix = contrast ? " з контрастом" : "";
  const computedDur = regionObj ? regionObj.dur + (contrast ? CONTRAST_DUR : 0) : (studyType === "КТ" ? 20 : 45);
  const price = regionObj ? regionObj.price + (contrast ? CONTRAST_SURCHARGE : 0) : null;
  const fmtPrice = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₴";

  const [durEdit, setDurEdit] = useState("");
  useEffect(() => { if (region) setDurEdit(String(computedDur)); }, [region, contrast, studyType]); // eslint-disable-line
  const dur = Math.max(5, parseInt(durEdit, 10) || computedDur);
  const durCustom = region && parseInt(durEdit, 10) && parseInt(durEdit, 10) !== computedDur;

  const exRegions = (t: string) => regionsFor(t);
  const exDur = (t: string, reg: string) => { const o = exRegions(t).find((r) => r.label === reg); return o ? o.dur : (t === "КТ" ? 20 : 45); };
  function changeType(t: string) {
    setStudyType(t); setRegion(""); setContrast(false); setTime("");
    setExtraStudies((a) => a.map((s) => (s.type === t ? s : { ...s, type: t, region: "", dur: exDur(t, "") })));
  }
  function toggleContrast(v: boolean) {
    setContrast(v);
    if (v && region && !allRegions.some((r) => r.label === region && r.contrast)) { setRegion(""); setTime(""); }
  }

  const exPatch = (i: number, p: Partial<ExtraStudy>) => setExtraStudies((a) => a.map((r, idx) => (idx === i ? { ...r, ...p } : r)));
  const exSetRegion = (i: number, reg: string) => { const r = extraStudies[i]; exPatch(i, { region: reg, dur: exDur(r.type, reg) }); };
  const exSetDur = (i: number, v: string) => exPatch(i, { dur: Math.max(5, parseInt(v, 10) || 0) });
  const exAdd = () => setExtraStudies((a) => [...a, { type: primaryKind, region: "", dur: exDur(primaryKind, "") }]);
  const exRemove = (i: number) => setExtraStudies((a) => a.filter((_, idx) => idx !== i));
  const validExtra = extraStudies.filter((s) => s.region);

  const primaryStudy: StudyOut | null = region ? { type: primaryKind, region, contrast: contrast === true, dur, price: studyPrice(primaryKind, region, contrast) } : null;
  const allStudies: StudyOut[] = (primaryStudy ? [primaryStudy] : []).concat(validExtra.map((s) => ({ type: s.type, region: s.region, dur: Number(s.dur) || 0, price: studyPrice(s.type, s.region, false) })));
  const procLabelTxt = region ? `${primaryKind} · ${region}${contrastSuffix}` : primaryKind;
  const combinedLabel = allStudies.length ? allStudies.map(studyLabel).join(" + ") : procLabelTxt;
  const slotDur = dur + validExtra.reduce((s, x) => s + (Number(x.dur) || 0), 0);

  function calcAgeLocal(d: string) { const a = calcAge(d); return a == null || a < 0 ? 0 : a; }

  useEffect(() => {
    if (!modAllowed(studyType === "КТ" ? "CT" : "MRI")) {
      if (modAllowed("MRI")) setStudyType("МРТ"); else if (modAllowed("CT")) setStudyType("КТ");
      setRegion(""); setContrast(false); setTime("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerId]);

  useEffect(() => {
    setRoomId((prev) => (roomsOfType.some((r) => r.id === prev) ? prev : (roomsOfType.length === 1 ? roomsOfType[0].id : null)));
    setTime("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerId, studyType]);

  const loadDay = useCallback(async () => {
    const supabase = createClient();
    if (centerId) {
      const ov = await supabase.from("schedule_overrides").select("all_closed, label, rooms").eq("clinic_id", centerId).eq("override_date", date).maybeSingle();
      setOverride((ov.data as unknown as DayOverride) || null);
      const inc = await supabase.from("incidents").select("room_id, started_at, blocked_until, status, auto_unblock").eq("clinic_id", centerId).in("status", ["active", "planned"]);
      setIncidents(inc.data || []);
    }
    if (!roomId) { setDayEntries([]); setRoomSchedule(null); return; }
    const roomRes = await supabase.from("rooms").select("schedule").eq("id", roomId).maybeSingle();
    setRoomSchedule((roomRes.data as { schedule?: unknown } | null)?.schedule ?? null);
    const { data } = await supabase.rpc("room_busy_slots", { p_room: roomId, p_date: date });
    setDayEntries(data || []);
  }, [centerId, roomId, date]);

  useEffect(() => { (async () => { await loadDay(); })(); }, [loadDay]);
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "visible") loadDay(); };
    document.addEventListener("visibilitychange", onVis); window.addEventListener("focus", onVis);
    return () => { document.removeEventListener("visibilitychange", onVis); window.removeEventListener("focus", onVis); };
  }, [loadDay]);

  const dateObj = new Date(date + "T00:00:00");
  const roomSched = roomScheduleFor(dateObj, roomId || "", override);
  const schedStart = toMin(roomSched.start), schedEnd = toMin(roomSched.end);
  const busySlots = (dayEntries || []).filter((e) => e.scheduled_time).map((e) => ({ s: toMin(e.scheduled_time), e: toMin(e.scheduled_time) + (e.duration_min || 30) + (e.buffer_time_min ?? BUFFER_DEFAULT) }));
  const roomBreaks = roomBreaksFor(dateObj, roomSchedule); // перерви кабінету на цю дату
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const isBookToday = sameDay(bookDate, today0());
  const slots: string[] = []; { const s0 = Math.ceil(schedStart / 30) * 30; for (let m = s0; m < schedEnd; m += 30) slots.push(fmt(m)); }
  function slotState(slot: string) {
    // b — кінець дослідження (має вміститись у графік); bBlock — з буфером (перетин з іншими).
    const a = toMin(slot), b = a + slotDur, bBlock = a + slotDur + buffer;
    if (roomSched.closed) return "closed";
    const slotMs = Date.UTC(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), Math.floor(a / 60), a % 60);
    if (slotBlockedByIncidents(incidents, roomId || "", slotMs)) return "blocked";
    if (a < schedStart || a >= schedEnd) return "offhours";
    if (b > schedEnd) return "tight";
    if (overlapsBreak(a, slotDur, roomBreaks)) return "break"; // блок перетинає перерву
    if (isBookToday && a < nowMin) return "past";
    if (busySlots.some((x) => a >= x.s && a < x.e)) return "busy";
    if (busySlots.some((x) => a < x.e && x.s < bBlock)) return "tight";
    return "free";
  }
  function nextApptAfter(slot: string) {
    const s = toMin(slot);
    const after = busySlots.filter((x) => x.s >= s).sort((a, b) => a.s - b.s)[0];
    return after ? fmt(after.s) : null;
  }
  const freeCount = slots.filter((s) => slotState(s) === "free").length;
  const busyList = busySlots.slice().sort((a, b) => a.s - b.s);

  const miss: Record<string, boolean> = { center: !centerId, name: !name.trim(), dob: !dob, gender: !gender, phone: !phone.trim(), priority: !priority, region: !region, room: !roomId, time: !time };
  const MISS_LABELS: Record<string, string> = { center: "Центр", name: "ПІБ", dob: "Дата народження", gender: "Стать", phone: "Телефон", priority: "Пріоритет", region: "Область дослідження", room: "Кабінет", time: "Слот часу" };
  const missingList = Object.keys(MISS_LABELS).filter((k) => miss[k]).map((k) => MISS_LABELS[k]);
  const timeBad = time ? slotState(time) !== "free" : false;
  const valid = centerId && missingList.length === 0 && roomId && !timeBad && !roomSched.closed;

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    const [hh, mm] = time.split(":").map(Number);
    const at = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), hh, mm).toISOString();
    // Server Action: серверна перевірка доступу направника + пред-перевірка слота + insert.
    const res = await createReferralBooking({
      clinicId: centerId, roomId: roomId as string,
      name: name.trim(), phone: phone.trim() || null, email: email.trim() || null,
      dob: dob || null, sex: gender || null, age: calcAgeLocal(dob), weight: weight ? +weight : null,
      hasContra: !!hasContra, priorityLevel: priority || undefined, studies: allStudies as Json,
      doctorName, note: comment.trim() || null, durationMin: slotDur, bufferTimeMin: buffer,
      scheduledDate: date, scheduledTime: time, scheduledAt: at,
    });
    setBusy(false);
    if (!res.ok) {
      const msg = (res.code === "slot_taken" || res.code === "slot_unavailable") ? "Слот щойно зайняли — оновіть сторінку й оберіть інший час"
        : res.code === "incident" ? "Кабінет у простої (ремонт/ТО) у цей час — оберіть інший слот або день"
        : res.code === "forbidden" ? "Немає доступу до цього центру/кабінету" : res.error;
      onCreated(null, msg);
      return;
    }
    setName(""); setDob(""); setGender(""); setWeight(""); setPhone(""); setEmail(""); setRegion(""); setContrast(false); setHasContra(false); setPriority(""); setComment(""); setExtraStudies([]); setTime("");
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
    <div style={{ maxWidth: 880, margin: "0 auto" }}>
      <div className="dialog bk-dialog" style={{ margin: 0, maxHeight: "none", overflow: "visible" }}>
        <div className="bk-grid">
          <div className="bk-col bk-col-left">
            <div className="bk-section-label" style={{ marginTop: 0 }}>Центр</div>
            <label className="fld">
              <span className={"fld-lab" + (miss.center ? " bk-miss-lab" : "")}>Куди направляємо <span className="req">*</span></span>
              <select className="inp" value={centerId} onChange={(e) => { setCenterId(e.target.value); setTime(""); }}>
                <option value="">— Оберіть центр —</option>
                {activeCenters.map((c) => <option key={c.clinicId} value={c.clinicId}>{centerLabel(c)}</option>)}
              </select>
            </label>

            <div className="bk-section-label">Пацієнт</div>

            <label className="fld">
              <span className={"fld-lab" + (miss.name ? " bk-miss-lab" : "")}>ПІБ <span className="req">*</span></span>
              <input className="inp" placeholder="Прізвище Ім'я По батькові" value={name} onChange={(e) => setName(e.target.value)} />
            </label>

            <div className="fld-row">
              <div className="fld" style={{ flex: "0 0 150px" }}>
                <span className={"fld-lab" + (miss.dob ? " bk-miss-lab" : "")}>Дата народження <span className="req">*</span></span>
                <DobField value={dob} onChange={setDob} invalid={miss.dob} />
              </div>
              <div className="fld" style={{ flex: "0 0 auto" }}>
                <span className={"fld-lab" + (miss.gender ? " bk-miss-lab" : "")}>Стать <span className="req">*</span></span>
                <div className="bk-gender-row">
                  <button className={"bk-gender-btn" + (gender === "М" ? " active" : "")} onClick={() => setGender("М")} title="Чоловіча">♂</button>
                  <button className={"bk-gender-btn" + (gender === "Ж" ? " active" : "")} onClick={() => setGender("Ж")} title="Жіноча">♀</button>
                </div>
              </div>
              <div className="fld" style={{ flex: "0 0 52px" }}>
                <span className="fld-lab">Вік</span>
                <div className="inp bk-age" title="Розраховано з дати народження">{dob ? calcAgeLocal(dob) : "—"}</div>
              </div>
              <label className="fld" style={{ flex: "0 0 60px" }}>
                <span className="fld-lab">Вага</span>
                <input className="inp" placeholder="кг" value={weight} onChange={(e) => setWeight(e.target.value.replace(/\D/g, ""))} />
              </label>
            </div>

            <div className="fld-row">
              <label className="fld">
                <span className={"fld-lab" + (miss.phone ? " bk-miss-lab" : "")}>Телефон <span className="req">*</span></span>
                <PhoneInput value={phone} onChange={setPhone} />
              </label>
              <label className="fld">
                <span className="fld-lab">Email</span>
                <input className="inp" type="email" placeholder="patient@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              </label>
            </div>

            <div className="bk-section-label">Дослідження</div>

            <div className="fld-row" style={{ alignItems: "flex-end" }}>
              <div className="fld" style={{ flex: "0 0 130px" }}>
                <span className="fld-lab">Тип <span className="req">*</span></span>
                <div className="bk-seg">
                  {modAllowed("MRI") && <button className={"bk-seg-btn" + (studyType === "МРТ" ? " active mrt" : "")} onClick={() => changeType("МРТ")}>МРТ</button>}
                  {modAllowed("CT") && <button className={"bk-seg-btn" + (studyType === "КТ" ? " active ct" : "")} onClick={() => changeType("КТ")}>КТ</button>}
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
                </div>
              </div>
            </div>

            <div className="fld">
              <span className={"fld-lab" + (miss.priority ? " bk-miss-lab" : "")}>Пріоритет пацієнта <span className="req">*</span></span>
              <div className="prio-seg" role="radiogroup" aria-label="Пріоритет пацієнта">
                {PRIORITY_OPTIONS.map((pv) => {
                  const m = PRIORITY_META[pv];
                  return (
                    <button key={pv} type="button" role="radio" aria-checked={priority === pv}
                      className={"prio-seg-btn " + m.tone + (priority === pv ? " active" : "")}
                      onClick={() => setPriority(pv)} title={m.desc}>
                      {m.short}
                    </button>
                  );
                })}
              </div>
              <span className="bk-time-state none">{priority ? PRIORITY_META[priority as PatientPriority].desc : "оберіть пріоритет — впливає на порядок у черзі"}</span>
            </div>

            <div className="fld-row" style={{ alignItems: "flex-start" }}>
              <label className="fld" style={{ flex: "1 1 auto" }}>
                <span className={"fld-lab" + (miss.region ? " bk-miss-lab" : "")}>Область дослідження <span className="req">*</span></span>
                <select className="inp" value={region} onChange={(e) => { setRegion(e.target.value); setTime(""); }}>
                  <option value="">— Оберіть область —</option>
                  {regions.map((r) => (
                    <option key={r.label} value={r.label}>{r.label}{contrastSuffix} · {r.dur + (contrast ? CONTRAST_DUR : 0)} хв</option>
                  ))}
                </select>
              </label>
              <label className="fld" style={{ flex: "0 0 108px" }}>
                <span className="fld-lab">Тривалість <span className="req">*</span></span>
                <div className="bk-dur-row">
                  <input className="inp bk-dur-input" type="number" min="5" step="5" placeholder="—"
                    value={durEdit} onChange={(e) => setDurEdit(e.target.value.replace(/\D/g, ""))} disabled={!region} />
                  <span className="bk-dur-unit">хв</span>
                </div>
                <span className={"bk-time-state " + (durCustom ? "busy" : "none")}>
                  {!region ? "оберіть область" : durCustom ? `↺ за замовч. ${computedDur} хв` : "за тривалістю області"}
                </span>
              </label>
              <label className="fld" style={{ flex: "0 0 96px" }}>
                <span className="fld-lab">Буфер</span>
                <select className="inp" value={buffer} onChange={(e) => setBuffer(Number(e.target.value))} title="Час на переукладку/дезінфекцію після дослідження">
                  {BUFFER_OPTIONS.map((b) => <option key={b} value={b}>{b} хв</option>)}
                </select>
                <span className="bk-time-state none">після дослідження</span>
              </label>
            </div>

            {price != null && (
              <div className="ctx-hint blue" style={{ marginBottom: 6 }}>Орієнтовна вартість: {fmtPrice(price)}</div>
            )}

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

            <label className="fld" style={{ flex: 1 }}>
              <span className="fld-lab">Примітки</span>
              <textarea className="inp bk-notes" placeholder="Клінічне питання, показання, що шукаємо, особливі вимоги…" value={comment} onChange={(e) => setComment(e.target.value)} />
            </label>
          </div>

          <div className="bk-col bk-col-right">
            <div className="bk-sched-head">
              <span className="bk-sched-spark">✦</span>
              <span className="bk-sched-title">Розклад</span>
              <span className={"bk-sched-mod " + (modality === "MRI" ? "mrt" : "ct")}>{studyType}</span>
              <span className="bk-sched-sync"><span className="pulse-dot" style={{ background: "var(--green)", width: 6, height: 6 }} /> синхр. з чергою</span>
            </div>

            <div className="fld">
              <span className={"fld-lab" + (miss.room ? " bk-miss-lab" : "")}>Кабінет <span className="req">*</span></span>
              {roomsOfType.length === 0 ? (
                <div className="ctx-hint red">У цьому центрі немає кабінету типу {studyType}.</div>
              ) : (
                <>
                  <div className="bk-room-chips">
                    {roomsOfType.map((r) => (
                      <button key={r.id} className={"bk-room-chip" + (roomId === r.id ? " active" : "") + (r.modality === "MRI" ? " mrt" : " ct")}
                        onClick={() => { setRoomId(r.id); setTime(""); }} title={r.name + (r.apparatus_model ? " · " + r.apparatus_model : "")}>
                        <span className="bk-room-chip-name">{r.name}</span>
                        {r.apparatus_model && <span className="bk-room-chip-model">{r.apparatus_model}</span>}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            <BookingCalendar value={bookDate} onPick={(d) => { setBookDate(d); setTime(""); }} />

            <div className="fld">
              <div className="bk-slots-head">
                <span className={"fld-lab" + (miss.time ? " bk-miss-lab" : "")} style={{ margin: 0 }}>Вільні слоти · {fmtShort(bookDate)} {miss.time ? "— оберіть час *" : ""}</span>
                <span className="bk-free-count">блок {slotDur} хв{allStudies.length > 1 ? ` (${allStudies.length} досл.)` : ""} + {buffer} буфер · {freeCount} вільних</span>
              </div>
              {roomSched.closed && <div className="ctx-hint red" style={{ marginBottom: 10 }}>🚫 {room ? room.name : "Кабінет"} не працює {fmtShort(bookDate)}{override && override.label ? " · " + override.label : ""}. Оберіть інший день або кабінет.</div>}
              {!roomSched.closed && roomSched.custom && <div className="ctx-hint blue" style={{ marginBottom: 10 }}>🕐 Особливий графік {fmtShort(bookDate)}: {roomSched.start}–{roomSched.end}.</div>}
              {!roomSched.closed && slots.some((s) => slotState(s) === "blocked") && <div className="ctx-hint red" style={{ marginBottom: 10 }}>🔧 {room ? room.name : "Кабінет"} на ремонті/ТО у частині дня. Оберіть вільний слот або інший день.</div>}
              <div className={"bk-slot-grid" + (miss.time ? " bk-miss-slots" : "")}>
                {slots.map((s) => {
                  const st = slotState(s);
                  const title = st === "busy" ? "Зайнято"
                    : st === "blocked" ? "Кабінет на ремонті/ТО"
                    : st === "break" ? "Перерва в роботі кабінету"
                    : st === "tight" ? `Не вміщується: блок ${slotDur} хв перетне ${nextApptAfter(s) ? "запис о " + nextApptAfter(s) : "кінець графіка (" + fmt(schedEnd) + ")"}`
                    : st === "past" ? "Час минув"
                    : `Вільно · ${s}–${fmt(toMin(s) + slotDur)}`;
                  return (
                    <button key={s} className={"slot" + (time === s ? " sel" : "") + (st !== "free" ? " taken" : "") + (st === "tight" ? " tight" : "") + ((st === "busy" || st === "blocked" || st === "break") ? " busy" : "")}
                      disabled={st !== "free"} onClick={() => setTime(s)} title={title}>{s}</button>
                  );
                })}
              </div>
              {busyList.length > 0 && (
                <div className="bk-busy-list">
                  <span className="bk-busy-lab">Зайнятий час:</span>
                  {busyList.map((b, i) => <span className="bk-busy-chip" key={i}>{fmt(b.s)}–{fmt(b.e)}</span>)}
                </div>
              )}
              <div className="bk-slot-legend">
                <span><span className="lg-dot free" />вільно</span>
                <span><span className="lg-dot tight" />не вміщується</span>
                <span><span className="lg-dot busy" />зайнято</span>
              </div>
              {time && (() => {
                const s = toMin(time), e = s + slotDur, eBlock = s + slotDur + buffer;
                const slotMs = Date.UTC(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), Math.floor(s / 60), s % 60);
                const blocked = slotBlockedByIncidents(incidents, roomId || "", slotMs);
                const conflict = busySlots.find((b) => s < b.e && b.s < eBlock);
                return (
                  <div className={"bk-slot-confirm " + (blocked || conflict ? "bad" : "ok")}>
                    {blocked ? <>⚠ Кабінет на ремонті/ТО у цей час — оберіть інший слот або день</>
                      : conflict ? <>⚠ Перетин із записом {fmt(conflict.s)}–{fmt(conflict.e)} — оберіть інший слот</>
                      : <>✓ Слот вільний. Запис: <b>{time}–{fmt(e)}</b> ({slotDur} хв){buffer > 0 ? <> + буфер {buffer} хв (до {fmt(eBlock)})</> : null}.</>}
                  </div>
                );
              })()}
            </div>
          </div>
        </div>

        <div className="dlg-foot">
          {valid
            ? <span className="bk-summary">{name.split(" ").slice(0, 2).join(" ")} · {allStudies.length > 1 ? allStudies.length + " досл." : primaryKind} · {room ? room.name : ""} · {fmtShort(bookDate)} {time}–{fmt(toMin(time) + slotDur)}</span>
            : <span className="bk-missing">{missingList.map((m, i) => <span className="bk-miss-chip" key={i}>{m}</span>)}</span>}
          <button className="btn btn-primary" disabled={!valid || busy} onClick={submit}>
            {busy ? "Відправляємо…" : "Відправити направлення"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* «Мої направлення» → тепер компонент ReferrerBoard (доска-черга як у адміна).
   Стара карткова версія (MyReferrals) видалена. */

/* ---------- Розгорнута картка центру ---------- */
function CenterDetails({ data, loading }: { data?: CenterCardData | null; loading: boolean }) {
  const panel = { background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", padding: 16, margin: "4px 0 8px" };
  if (loading) return <div style={panel}><div style={{ color: "var(--text-muted)", fontSize: 13 }}>Завантаження…</div></div>;
  if (!data) return <div style={panel}><div style={{ color: "var(--text-muted)", fontSize: 13 }}>Не вдалося завантажити деталі центру.</div></div>;
  const admins = Array.isArray(data.admins) ? data.admins : [];
  const rooms = Array.isArray(data.rooms) ? data.rooms : [];
  const realEmail = (e?: string | null) => e && !/@referrer\.radflow\.local$/i.test(e);
  const lbl = { color: "var(--text-muted)", fontSize: 11.5, textTransform: "uppercase" as const, letterSpacing: ".04em", margin: "0 0 8px" };
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
interface MyCentersProps {
  centers: Center[];
  canManage: boolean;
  onChanged: () => void;
  notify: (msg: string, type?: string) => void;
}

function MyCenters({ centers, canManage, onChanged, notify }: MyCentersProps) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchClinic[]>([]);
  const [searching, setSearching] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, CenterCardData>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);

  function toggleExpand(c: Center) {
    if (!c.accessId) return;
    setExpandedId((id) => (id === c.accessId ? null : c.accessId!));
  }

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
      if (!error && data) setDetails((d) => ({ ...d, [expandedId]: data as unknown as CenterCardData }));
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

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) { setResults([]); setSearching(false); return; }
    let active2 = true;
    setSearching(true);
    const t = setTimeout(async () => {
      const supabase = createClient();
      const { data } = await supabase.rpc("search_clinics", { q: query });
      if (!active2) return;
      setResults((data || []).filter((c) => !knownIds.has(c.id)));
      setSearching(false);
    }, 250);
    return () => { active2 = false; clearTimeout(t); };
  }, [q, knownIds]);

  async function sendRequest(clinicId: string) {
    setBusyId(clinicId);
    const { ok, data } = await postJSON("/api/referral/access/request", { clinic_id: clinicId });
    setBusyId(null);
    if (!ok) { notify(data.error || "Помилка", "error"); return; }
    notify("Запит надіслано — очікуйте підтвердження центру", "success");
    setResults((rs) => rs.filter((r) => r.id !== clinicId));
    onChanged();
  }

  async function decide(accessId: string, decision: string) {
    setBusyId(accessId);
    const { ok, data } = await postJSON("/api/referral/access/decide", { access_id: accessId, decision });
    setBusyId(null);
    if (!ok) { notify(data.error || "Помилка", "error"); return; }
    notify(decision === "approve" ? "Запрошення прийнято" : decision === "revoke" ? "Доступ відкликано" : "Відхилено", "success");
    onChanged();
  }

  const card = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: 18, marginBottom: 14 };
  function Row({ c, children, onClick, expandable, expanded }: { c: Center; children?: ReactNode; onClick?: () => void; expandable?: boolean; expanded?: boolean }) {
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
            <input className="inp" placeholder="Почніть вводити назву або місто центру…" value={q} autoComplete="off" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") search(); }} />
            <button className="btn btn-secondary" onClick={search} disabled={searching || q.trim().length < 2}>{searching ? "Пошук…" : "Знайти"}</button>
          </div>
          {q.trim().length >= 2 && (
            <div style={{ marginTop: 10 }}>
              {results.length === 0 ? (
                <div style={{ fontSize: 12.5, color: "var(--text-muted)", padding: "8px 0" }}>{searching ? "Шукаємо…" : "Нічого не знайдено. Уточніть назву або місто."}</div>
              ) : results.map((r) => (
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
                <button className="btn btn-primary btn-sm" disabled={busyId === c.accessId} onClick={(e) => { e.stopPropagation(); decide(c.accessId!, "approve"); }}>Прийняти</button>
                <button className="btn btn-secondary btn-sm" disabled={busyId === c.accessId} onClick={(e) => { e.stopPropagation(); if (window.confirm("Відхилити запрошення центру «" + c.name + "»?\n\nВи зможете надіслати запит на доступ пізніше вручну.")) decide(c.accessId!, "decline"); }}>Відхилити</button>
              </Row>
              {expandedId === c.accessId && <CenterDetails data={details[c.accessId!]} loading={loadingId === c.accessId && !details[c.accessId!]} />}
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
                {canManage && c.accessId && <button className="btn btn-secondary btn-sm qd-act-red" disabled={busyId === c.accessId} onClick={(e) => { e.stopPropagation(); if (window.confirm("Відкликати доступ до «" + c.name + "»? Створені направлення лишаться у центрі, нові ви створювати не зможете.")) decide(c.accessId!, "revoke"); }}>Відкликати</button>}
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

/* Текстове поле, що росте вниз у міру набору (авто-висота),
   але не більше maxRows видимих рядків — далі зʼявляється прокрутка. */
function AutoTextarea({ value, onChange, placeholder, className = "inp", maxRows = 5 }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string; maxRows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 20;
    const padT = parseFloat(cs.paddingTop) || 0;
    const padB = parseFloat(cs.paddingBottom) || 0;
    const borderT = parseFloat(cs.borderTopWidth) || 0;
    const borderB = parseFloat(cs.borderBottomWidth) || 0;
    // box-sizing: border-box → у height входять padding і border.
    const extra = padT + padB + borderT + borderB;
    const max = line * maxRows + extra;
    const full = el.scrollHeight + borderT + borderB;
    el.style.height = Math.min(full, max) + "px";
    el.style.overflowY = full > max ? "auto" : "hidden";
  }, [value, maxRows]);
  return (
    <textarea
      ref={ref}
      className={className}
      placeholder={placeholder}
      rows={1}
      style={{ resize: "none", overflow: "hidden" }}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/* ---------- Вкладка «Мій профіль» (направник редагує власні дані) ---------- */
function MyProfile({ doctorId, notify, onSaved }: { doctorId: string; notify: (m: string, t?: string) => void; onSaved: () => void }) {
  const [form, setForm] = useState({ login: "", full_name: "", phone: "", note: "", city: "", email: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      const supabase = createClient();
      const [{ data: p }, { data: priv }] = await Promise.all([
        supabase.from("profiles").select("login, full_name, phone, note, city").eq("id", doctorId).maybeSingle(),
        supabase.from("referrer_private").select("email").eq("referrer_id", doctorId).maybeSingle(),
      ]);
      if (!active) return;
      setForm({ login: p?.login || "", full_name: p?.full_name || "", phone: p?.phone || "", note: p?.note || "", city: p?.city || "", email: priv?.email || "" });
      setLoading(false);
    })();
    return () => { active = false; };
  }, [doctorId]);

  async function save() {
    if (!form.login.trim()) { notify("Вкажіть логін", "error"); return; }
    if (!form.full_name.trim()) { notify("Вкажіть ПІБ", "error"); return; }
    setSaving(true);
    try {
      const res = await fetch("/api/referral/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { notify(data.error || "Помилка", "error"); setSaving(false); return; }
      notify("Профіль збережено", "success");
      onSaved();
    } catch { notify("Помилка зʼєднання із сервером", "error"); }
    setSaving(false);
  }

  const card = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: 20, maxWidth: 640, margin: "0 auto" };
  const reqMark = <span style={{ color: "var(--red)" }}> *</span>;
  if (loading) return <div className="empty"><div className="et">Завантаження профілю…</div></div>;
  return (
    <div style={card}>
      <div className="bk-section-label" style={{ marginTop: 0 }}>Мій профіль</div>
      <div className="fld-row">
        <label className="fld" style={{ flex: 1 }}><span className="fld-lab" style={{ color: "var(--red)" }}>Логін{reqMark}</span><input className="inp" value={form.login} onChange={(e) => setForm((f) => ({ ...f, login: e.target.value }))} /></label>
        <label className="fld" style={{ flex: 1 }}><span className="fld-lab" style={{ color: "var(--red)" }}>ПІБ{reqMark}</span><input className="inp" placeholder="Прізвище Імʼя По батькові" value={form.full_name} onChange={(e) => setForm((f) => ({ ...f, full_name: e.target.value }))} /></label>
      </div>
      <div className="fld-row">
        <label className="fld" style={{ flex: 1 }}><span className="fld-lab" style={{ color: "var(--red)" }}>Телефон{reqMark}</span><PhoneInput required value={form.phone} onChange={(v) => setForm((f) => ({ ...f, phone: v }))} /></label>
        <label className="fld" style={{ flex: 1 }}><span className="fld-lab" style={{ color: "var(--red)" }}>Email (для відновлення доступу){reqMark}</span><input className="inp" type="email" placeholder="name@example.com" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} /></label>
      </div>
      <div className="fld-row" style={{ alignItems: "flex-start" }}>
        <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Місто</span><CitySelect value={form.city} onChange={(v) => setForm((f) => ({ ...f, city: v }))} /></label>
        <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Примітки</span><AutoTextarea placeholder="напр. спеціалізація (необовʼязково)" value={form.note} onChange={(v) => setForm((f) => ({ ...f, note: v }))} /></label>
      </div>
      <div className="hint-blue">🔒 <b>Email бачите лише ви</b> — він потрібен для відновлення доступу й не видимий центрам. Логін, ПІБ, телефон, місто і примітки видно центрам, до яких ви підключені.</div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
        <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? "Зберігаємо…" : "Зберегти"}</button>
      </div>
    </div>
  );
}

/* ── Лист очікування направника: власні пацієнти в усіх авторизованих центрах ── */
function MyWaitlist({ entries, centersById, onOpenAdd, onEdit, onCancel, onRestore, onPriority }: {
  entries: WaitlistEntry[];
  centersById: Record<string, Center>;
  onOpenAdd: () => void;
  onEdit: (e: WaitlistEntry) => void;
  onCancel: (e: WaitlistEntry) => void;
  onRestore: (e: WaitlistEntry) => void;
  onPriority: (e: WaitlistEntry, v: PatientPriority) => void;
}) {
  const waiting = entries.filter((e) => e.status === "waiting").sort(compareWaitlist);
  const rest = entries.filter((e) => e.status !== "waiting").sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  const list = [...waiting, ...rest];
  return (
    <div style={{ maxWidth: 1040, margin: "0 auto", display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="info-banner">
        <span className="ib-ic">⏳</span>
        <span className="ib-txt"><b>Лист очікування</b> — ваші пацієнти, що чекають на вільне вікно в центрі. Коли слот звільниться, центр запише пацієнта — статус зміниться на «Записано».</span>
        <button className="btn btn-primary btn-sm" style={{ flexShrink: 0 }} onClick={onOpenAdd}>＋ Додати пацієнта</button>
      </div>
      {list.length === 0 ? (
        <div className="empty"><div className="ei">⏳</div><div className="et">Лист порожній</div><div className="es">Додайте пацієнта, що чекає на вільне вікно</div></div>
      ) : (
        list.map((p) => {
          const m = PRIORITY_META[p.priority_level];
          const st = WAITLIST_STATUS_META[p.status];
          const center = centersById[p.clinic_id];
          return (
            <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 12, background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", padding: "10px 14px", opacity: p.status === "waiting" ? 1 : 0.72 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  {p.status !== "waiting" && <span className="badge">{st.label}</span>}
                  {p.priority_level !== "planned" && p.status === "waiting" && <span className={"prio-tag " + m.tone}>{m.short}</span>}
                  {p.status === "waiting" ? (
                    <span onClick={() => onEdit(p)} title="Редагувати дані пацієнта та дослідження"
                      style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", cursor: "pointer", textDecorationLine: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 3 }}>{p.patient_name}</span>
                  ) : (
                    <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.patient_name}</span>
                  )}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>
                  {centerLabel(center)} · {procLabel(p)} · {desiredWindowText(p)}
                </div>
              </div>
              {p.status === "waiting" && (
                <div className="prio-seg" role="radiogroup" aria-label="Пріоритет пацієнта" style={{ flexShrink: 0 }}>
                  {PRIORITY_OPTIONS.map((pv) => {
                    const pm = PRIORITY_META[pv];
                    return (
                      <button key={pv} type="button" role="radio" aria-checked={p.priority_level === pv}
                        className={"prio-seg-btn " + pm.tone + (p.priority_level === pv ? " active" : "")}
                        title={pm.desc} onClick={() => onPriority(p, pv)}>
                        {pm.short}
                      </button>
                    );
                  })}
                </div>
              )}
              {p.status === "waiting" && (
                <button className="btn btn-secondary btn-sm" style={{ flexShrink: 0 }} title="Редагувати пацієнта/дослідження/вікно" onClick={() => onEdit(p)}>✎ Редагувати</button>
              )}
              {p.status === "waiting"
                ? <button className="btn btn-secondary btn-sm" style={{ color: "var(--red)", flexShrink: 0 }} onClick={() => onCancel(p)}>✕ Зняти</button>
                : (p.status === "cancelled" || p.status === "expired")
                  ? <button className="btn btn-secondary btn-sm" style={{ flexShrink: 0 }} onClick={() => onRestore(p)}>↩ Повернути</button>
                  : null}
            </div>
          );
        })
      )}
    </div>
  );
}

interface ReferralPortalProps {
  role: string;
  centers: Center[];
  roomsByClinic: Record<string, RoomOpt[]>;
  doctorName: string;
  doctorId: string;
}

export default function ReferralPortal({ role, centers, roomsByClinic, doctorName, doctorId }: ReferralPortalProps) {
  const router = useRouter();
  const canManage = role === "referrer";
  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const activeCenters = useMemo(() => centers.filter((c) => c.status === "active"), [centers]);
  const centersById = useMemo(() => { const m: Record<string, Center> = {}; centers.forEach((c) => { m[c.clinicId] = c; }); return m; }, [centers]);
  const pendingInvites = centers.filter((c) => c.status === "pending_referrer").length;

  const [tab, setTab] = useState(() => (activeCenters.length === 0 ? "centers" : "new"));
  // Швидкий фільтр з сайдбару: клік по центру/кабінету → доска «Мої направлення».
  const [boardFocus, setBoardFocus] = useState<{ clinicId: string; roomId: string; nonce: number } | null>(null);
  const [editPatientFor, setEditPatientFor] = useState<Referral | null>(null);
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [reschedFor, setReschedFor] = useState<Referral | null>(null);
  const [editStudiesFor, setEditStudiesFor] = useState<Referral | null>(null);
  const [wlEntries, setWlEntries] = useState<WaitlistEntry[]>([]);
  const [wlAddOpen, setWlAddOpen] = useState(false);
  const [wlEditFor, setWlEditFor] = useState<WaitlistEntry | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function notify(msg: string, type = "success") { setToast({ msg, type }); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), 3200); }

  const reload = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("queue_entries")
      .select("id, clinic_id, created_by, referrer_id, patient_name, patient_phone, patient_age, scheduled_date, scheduled_time, duration_min, buffer_time_min, status, call_status, priority_level, studies, studies_original, studies_changed_by, contraindications, doctor, note, indication, room_id, reschedule_origin")
      .eq("referrer_id", doctorId)
      .order("scheduled_date", { ascending: false }).order("scheduled_time", { ascending: true });
    setReferrals(data || []);
  }, [doctorId]);

  // Лист очікування: RLS показує направнику лише власні рядки (created_by).
  const reloadWaitlist = useCallback(async () => {
    try {
      const supabase = createClient();
      const { data } = await supabase
        .from("waitlist_entries")
        .select("*")
        .eq("created_by", doctorId)
        .order("created_at", { ascending: true });
      setWlEntries(data || []);
    } catch { /* транзієнтний Failed to fetch — ігноруємо */ }
  }, [doctorId]);
  useEffect(() => { reloadWaitlist(); }, [reloadWaitlist]);

  // TD-3: единый realtime-хук.
  useRealtimeRefetch({
    channelName: doctorId ? "ref-" + doctorId : null,
    subscriptions: [
      { table: "queue_entries", filter: "referrer_id=eq." + doctorId, onChange: reload },
      { table: "waitlist_entries", filter: "created_by=eq." + doctorId, onChange: reloadWaitlist },
      { table: "referral_access", filter: "referrer_id=eq." + doctorId, onChange: () => router.refresh() },
    ],
  });

  async function wlAdd(w: WaitlistFormOut) {
    const res = await addWaitlistEntry({
      clinicId: w.clinicId, name: w.name, phone: w.phone, email: w.email, dob: w.dob, sex: w.sex, age: w.age, weight: w.weight,
      priorityLevel: w.priorityLevel, studies: w.studies, durationMin: w.durationMin, bufferTimeMin: w.bufferTimeMin,
      desiredDateFrom: w.desiredDateFrom, desiredDateTo: w.desiredDateTo,
      desiredTimeFrom: w.desiredTimeFrom, desiredTimeTo: w.desiredTimeTo, note: w.note,
    });
    if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
    setWlAddOpen(false);
    notify("Додано до листа очікування: " + w.name, "success");
    reloadWaitlist();
  }
  async function wlEditSave(w: WaitlistFormOut) {
    const p = wlEditFor;
    if (!p) return;
    const res = await updateWaitlistEntry(p.id, {
      patient_name: w.name, patient_phone: w.phone, patient_email: w.email,
      patient_dob: w.dob, patient_sex: w.sex, patient_age: w.age, patient_weight: w.weight,
      studies: w.studies, duration_min: w.durationMin, buffer_time_min: w.bufferTimeMin,
      desired_date_from: w.desiredDateFrom, desired_date_to: w.desiredDateTo,
      desired_time_from: w.desiredTimeFrom, desired_time_to: w.desiredTimeTo,
      note: w.note,
    });
    if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
    setWlEditFor(null);
    notify("Запис листа оновлено", "success");
    reloadWaitlist();
  }

  const [wlConfirmRemove, setWlConfirmRemove] = useState<WaitlistEntry | null>(null);
  async function wlCancel(e: WaitlistEntry) {
    const res = await setWaitlistStatus(e.id, "cancelled");
    if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
    notify("Знято з листа очікування", "info"); reloadWaitlist();
  }
  async function wlRestore(e: WaitlistEntry) {
    const res = await setWaitlistStatus(e.id, "waiting");
    if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
    notify("Повернено в очікування", "success"); reloadWaitlist();
  }
  async function wlPrio(e: WaitlistEntry, v: PatientPriority) {
    if (e.priority_level === v) return;
    setWlEntries((es) => es.map((x) => (x.id === e.id ? { ...x, priority_level: v } : x)));
    const res = await setWaitlistPriority(e.id, v);
    if (!res.ok) { notify("Помилка: " + res.error, "error"); reloadWaitlist(); }
  }

  async function doReschedule({ roomId, date, time, dur, buffer, reason }: { roomId: string; date: Date; time: string; dur: number; buffer: number; reason: string }) {
    const p = reschedFor; if (!p) return;
    const [hh, mm] = time.split(":").map(Number);
    const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hh, mm).toISOString();
    const res = await rescheduleQueueEntry({ id: p.id, roomId, scheduledDate: dateVal(date), scheduledTime: time, scheduledAt: at, durationMin: dur, bufferTimeMin: buffer, reason });
    if (!res.ok) {
      if (res.code === "slot_taken") { notify("Слот щойно зайняли — оберіть інший", "error"); return; }
      setReschedFor(null);
      notify(res.code === "incident" ? "Кабінет у простої — оберіть інший слот" : res.code === "slot_unavailable" ? "Слот зайнятий — оберіть інший" : "Помилка: " + res.error, "error");
      return;
    }
    setReschedFor(null);
    notify("Перенесено", "success"); reload();
  }

  async function doCancel(entry: Referral) {
    if (!entry) return;
    const res = await cancelQueueEntry(entry.id);
    if (!res.ok) { notify("Помилка скасування: " + res.error, "error"); return; }
    notify("Направлення скасовано", "success"); reload();
  }

  async function doEditStudies(arr: { type: string; region: string; dur: number }[], meta: { dur: number; buffer: number }) {
    const p = editStudiesFor;
    if (!p) return;
    const res = await editQueueEntryStudies(p.id, arr as unknown as Json, meta.dur || p.duration_min || 30, meta.buffer);
    setEditStudiesFor(null);
    if (!res.ok) { notify("Помилка збереження досліджень: " + res.error, "error"); return; }
    notify("Дослідження оновлено", "success"); reload();
  }

  function onCentersChanged() { router.refresh(); }

  const reschedRooms = reschedFor ? (roomsByClinic[reschedFor.clinic_id] || []) : [];
  const TAB_META: Record<string, { t: string; i: string }> = {
    new: { t: "Нове направлення", i: "＋" }, mine: { t: "Мої направлення", i: "▦" },
    waitlist: { t: "Лист очікування", i: "⏳" }, centers: { t: "Мої центри", i: "🏥" }, profile: { t: "Мій профіль", i: "👤" },
  };
  const tabMeta = TAB_META[tab] || TAB_META.new;

  return (
    <div className="app">
      <ReferrerSidebar centers={activeCenters} roomsByClinic={roomsByClinic} doctorName={doctorName}
        activeTab={tab}
        onNav={(key) => { if (key === "mine") setBoardFocus({ clinicId: "all", roomId: "all", nonce: Date.now() }); setTab(key); }}
        onSelectRoom={(clinicId, roomId) => { setBoardFocus({ clinicId, roomId, nonce: Date.now() }); setTab("mine"); }}
        activeClinic={tab === "mine" ? boardFocus?.clinicId : undefined}
        activeRoom={tab === "mine" ? boardFocus?.roomId : undefined}
        counts={{ mine: referrals.length, waitlist: wlEntries.filter((e) => e.status === "waiting").length, pendingInvites }}
        canManage={canManage} onSignOut={signOut} />
      <div className="main">
        <header className="topbar">
          <div className="tb-title">
            <span className="tic">{tabMeta.i}</span>
            <div><h1>{tabMeta.t}</h1></div>
          </div>
          <div className="tb-right">
            <span style={{ fontSize: 13, color: "var(--text-secondary)" }}><LiveClock /></span>
            <CeoDashboardLink />
          </div>
        </header>
        <div className="content" style={{ flex: 1 }}>
        {tab === "new" && (
          <NewReferral activeCenters={activeCenters} roomsByClinic={roomsByClinic} doctorName={doctorName} doctorId={doctorId}
            onCreated={(nm, err) => { if (err) notify("Помилка: " + err, "error"); else { notify("Направлення відправлено: " + nm, "success"); reload(); setTab("mine"); } }} />
        )}
        {tab === "mine" && (
          <ReferrerBoard referrals={referrals} activeCenters={activeCenters} centersById={centersById} roomsByClinic={roomsByClinic} doctorId={doctorId}
            focus={boardFocus}
            onReschedule={(r) => setReschedFor(r)} onCancel={doCancel} onEditPatient={(r) => setEditPatientFor(r)} onEditStudies={(r) => setEditStudiesFor(r)} />
        )}
        {tab === "waitlist" && (
          <MyWaitlist entries={wlEntries} centersById={centersById} onOpenAdd={() => setWlAddOpen(true)}
            onEdit={(e) => setWlEditFor(e)} onCancel={(e) => setWlConfirmRemove(e)} onRestore={wlRestore} onPriority={wlPrio} />
        )}
        {tab === "centers" && (
          <MyCenters centers={centers} canManage={canManage} onChanged={onCentersChanged} notify={notify} />
        )}
        {tab === "profile" && canManage && (
          <MyProfile doctorId={doctorId} notify={notify} onSaved={() => router.refresh()} />
        )}
        </div>
      </div>

      {reschedFor && (
        <RescheduleModal patient={reschedFor} rooms={reschedRooms} clinicId={reschedFor.clinic_id} onClose={() => setReschedFor(null)} onConfirm={doReschedule} />
      )}
      {editStudiesFor && (
        <StudyEditModal patient={editStudiesFor} scheduledDate={editStudiesFor.scheduled_date} rooms={roomsByClinic[editStudiesFor.clinic_id] || []} clinicId={editStudiesFor.clinic_id} onClose={() => setEditStudiesFor(null)} onConfirm={doEditStudies} />
      )}
      {wlAddOpen && (
        <WaitlistModal centers={activeCenters.map((c) => ({ clinicId: c.clinicId, name: centerLabel(c) }))}
          onClose={() => setWlAddOpen(false)} onSave={wlAdd} />
      )}
      {wlEditFor && (
        <WaitlistModal initial={wlEditFor} onClose={() => setWlEditFor(null)} onSave={wlEditSave} />
      )}
      {wlConfirmRemove && (
        <ConfirmDialog title="Зняти з листа очікування"
          text={<>Зняти <b style={{ color: "var(--text)" }}>{wlConfirmRemove.patient_name}</b> з листа очікування? Запис можна буде повернути.</>}
          confirmLabel="Зняти з листа" danger
          onConfirm={async () => { const p = wlConfirmRemove; setWlConfirmRemove(null); await wlCancel(p); }}
          onClose={() => setWlConfirmRemove(null)} />
      )}
      {editPatientFor && (
        <PatientEditModal entryId={editPatientFor.id} canEditPriority onClose={() => setEditPatientFor(null)} onSaved={reload} />
      )}
      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "var(--card)", border: "1px solid var(--border-strong)", borderLeft: "4px solid " + (toast.type === "error" ? "var(--red)" : "var(--green)"), borderRadius: 12, padding: "12px 18px", boxShadow: "var(--shadow-pop)", zIndex: 50, fontSize: 13.5 }}>{toast.msg}</div>
      )}
    </div>
  );
}
