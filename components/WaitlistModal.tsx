"use client";

/* ===== RadFlow — Додати до листа очікування =====
   Форма без вибору слота: пацієнт + дослідження + пріоритет + бажане вікно
   (діапазон дат, час доби). Використовується адміном/реєстратором (/waitlist)
   і направником (портал). Збереження — через Server Action (батько). */

import { useState } from "react";
import PhoneInput from "@/components/PhoneInput";
import { DobField } from "@/components/BookingModal";
import { MRT_REGIONS, CT_REGIONS, CONTRAST_SURCHARGE, CONTRAST_DUR, BUFFER_DEFAULT, BUFFER_OPTIONS, regionsFor, studyPrice } from "@/lib/studies";
import { PRIORITY_OPTIONS, PRIORITY_META, type PatientPriority } from "@/lib/priority";
import { TIME_PRESETS } from "@/lib/waitlist";
import { useModalA11y } from "@/lib/useModalA11y";

type ExtraStudy = { type: string; region: string; dur: number };
type StudyOut = { type: string; region: string; contrast?: boolean; dur: number; price: number | null };

export type WaitlistFormOut = {
  clinicId?: string; // при виборі центру (портал направника)
  name: string;
  phone: string;
  email: string | null;
  dob: string | null;
  sex: string | null;
  age: number | null;
  weight: number | null;
  priorityLevel: PatientPriority;
  studies: StudyOut[];
  durationMin: number;
  bufferTimeMin: number;
  desiredDateFrom: string | null;
  desiredDateTo: string | null;
  desiredTimeFrom: string | null;
  desiredTimeTo: string | null;
  note: string | null;
};

function calcAge(d: string): number | null {
  if (!d) return null;
  const b = new Date(d);
  if (isNaN(b.getTime())) return null;
  const n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  const m = n.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && n.getDate() < b.getDate())) a--;
  return a < 0 ? 0 : a;
}

function todayKey(): string {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

interface WaitlistModalProps {
  /** Портал направника: обовʼязковий вибір центру (active referral_access). */
  centers?: { clinicId: string; name: string }[];
  onClose: () => void;
  onSave: (w: WaitlistFormOut) => void | Promise<void>;
}

export default function WaitlistModal({ centers, onClose, onSave }: WaitlistModalProps) {
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  const needCenter = Array.isArray(centers) && centers.length > 0;
  const [centerId, setCenterId] = useState(() => (needCenter && centers!.length === 1 ? centers![0].clinicId : ""));
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [dob, setDob] = useState("");
  const [gender, setGender] = useState("");
  const [weight, setWeight] = useState("");
  const [studyType, setStudyType] = useState("MRT");
  const [region, setRegion] = useState("");
  const [contrast, setContrast] = useState(false);
  const [buffer, setBuffer] = useState<number>(BUFFER_DEFAULT);
  const [priority, setPriority] = useState<PatientPriority | "">("");
  const [dateFrom, setDateFrom] = useState(todayKey());
  const [dateTo, setDateTo] = useState("");
  const [timeKey, setTimeKey] = useState("any");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const allRegions = studyType === "MRT" ? MRT_REGIONS : CT_REGIONS;
  const regions = contrast ? allRegions.filter((r) => r.contrast) : allRegions;
  const primaryKind = studyType === "MRT" ? "МРТ" : "КТ";
  const contrastSuffix = contrast ? " з контрастом" : "";
  const regionObj = regions.find((r) => r.label === region);
  const computedDur = regionObj ? regionObj.dur + (contrast ? CONTRAST_DUR : 0) : (studyType === "MRT" ? 45 : 20);
  const price = regionObj ? regionObj.price + (contrast ? CONTRAST_SURCHARGE : 0) : null;
  const fmtPrice = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₴";

  const [extraStudies, setExtraStudies] = useState<ExtraStudy[]>([]);
  const exDur = (t: string, reg: string) => { const o = regionsFor(t).find((r) => r.label === reg); return o ? o.dur : (t === "КТ" ? 20 : 45); };
  const validExtra = extraStudies.filter((s) => s.region);

  function changeType(t: string) {
    setStudyType(t); setRegion(""); setContrast(false);
    const k = t === "MRT" ? "МРТ" : "КТ";
    setExtraStudies((a) => a.map((s) => (s.type === k ? s : { ...s, type: k, region: "", dur: exDur(k, "") })));
  }
  function toggleContrast(v: boolean) {
    setContrast(v);
    if (v && region && !allRegions.some((r) => r.label === region && r.contrast)) setRegion("");
  }

  const primaryStudy: StudyOut | null = region
    ? { type: primaryKind, region, contrast: contrast === true, dur: computedDur, price: studyPrice(primaryKind, region, contrast) }
    : null;
  const allStudies: StudyOut[] = (primaryStudy ? [primaryStudy] : [])
    .concat(validExtra.map((s) => ({ type: s.type, region: s.region, dur: Number(s.dur) || 0, price: studyPrice(s.type, s.region, false) })));
  const totalDur = allStudies.reduce((s, x) => s + (Number(x.dur) || 0), 0);

  const miss: Record<string, boolean> = { name: !name.trim(), phone: !phone.trim(), priority: !priority, region: !region, center: needCenter && !centerId };
  const MISS_LABELS: Record<string, string> = { name: "ПІБ", phone: "Телефон", priority: "Пріоритет", region: "Область дослідження", center: "Центр" };
  const missingList = Object.keys(MISS_LABELS).filter((k) => miss[k]).map((k) => MISS_LABELS[k]);
  const badRange = !!(dateFrom && dateTo && dateTo < dateFrom);
  const valid = missingList.length === 0 && !badRange;

  async function handleSave() {
    if (!valid || saving) return;
    setSaving(true);
    try {
      const preset = TIME_PRESETS.find((p) => p.key === timeKey) || TIME_PRESETS[0];
      await onSave({
        clinicId: needCenter ? centerId : undefined,
        name: name.trim(),
        phone,
        email: email.trim() || null,
        dob: dob || null,
        sex: gender || null,
        age: dob ? calcAge(dob) : null,
        weight: weight ? +weight : null,
        priorityLevel: priority as PatientPriority,
        studies: allStudies,
        durationMin: totalDur || computedDur,
        bufferTimeMin: buffer,
        desiredDateFrom: dateFrom || null,
        desiredDateTo: dateTo || null,
        desiredTimeFrom: preset.from,
        desiredTimeTo: preset.to,
        note: note.trim() || null,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="overlay">
      <div className="dialog fade-in" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Додати до листа очікування" style={{ maxWidth: 560 }}>
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic">⏳</span>До листа очікування</div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        <div className="dlg-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {needCenter && (
            <label className="fld">
              <span className={"fld-lab" + (miss.center ? " bk-miss-lab" : "")}>Центр <span className="req">*</span></span>
              <select className="inp" value={centerId} onChange={(e) => setCenterId(e.target.value)}>
                <option value="">— Оберіть центр —</option>
                {centers!.map((c) => <option key={c.clinicId} value={c.clinicId}>{c.name}</option>)}
              </select>
            </label>
          )}
          <div className="bk-section-label">Пацієнт</div>
          <label className="fld">
            <span className={"fld-lab" + (miss.name ? " bk-miss-lab" : "")}>ПІБ <span className="req">*</span></span>
            <input className="inp" placeholder="Прізвище Ім'я По батькові" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
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
          <div className="fld-row">
            <div className="fld" style={{ flex: "0 0 150px" }}>
              <span className="fld-lab">Дата народження</span>
              <DobField value={dob} onChange={setDob} />
            </div>
            <div className="fld" style={{ flex: "0 0 auto" }}>
              <span className="fld-lab">Стать</span>
              <div className="bk-gender-row">
                <button className={"bk-gender-btn" + (gender === "М" ? " active" : "")} onClick={() => setGender("М")} title="Чоловіча">♂</button>
                <button className={"bk-gender-btn" + (gender === "Ж" ? " active" : "")} onClick={() => setGender("Ж")} title="Жіноча">♀</button>
              </div>
            </div>
            <label className="fld" style={{ flex: "0 0 60px" }}>
              <span className="fld-lab">Вага</span>
              <input className="inp" placeholder="кг" value={weight} onChange={(e) => setWeight(e.target.value.replace(/\D/g, ""))} />
            </label>
          </div>

          <div className="bk-section-label">Дослідження</div>
          <div className="fld-row" style={{ alignItems: "flex-end" }}>
            <div className="fld" style={{ flex: "0 0 130px" }}>
              <span className="fld-lab">Тип <span className="req">*</span></span>
              <div className="bk-seg">
                <button className={"bk-seg-btn" + (studyType === "MRT" ? " active mrt" : "")} onClick={() => changeType("MRT")}>МРТ</button>
                <button className={"bk-seg-btn" + (studyType === "CT" ? " active ct" : "")} onClick={() => changeType("CT")}>КТ</button>
              </div>
            </div>
            <div className="fld">
              <span className="fld-lab">Параметри</span>
              <label className={"rf-check" + (contrast ? " on" : "")}>
                <input type="checkbox" checked={contrast} onChange={(e) => toggleContrast(e.target.checked)} />
                <span className="rf-box" /><span>Контраст</span>
              </label>
            </div>
            <label className="fld" style={{ flex: "0 0 96px" }}>
              <span className="fld-lab">Буфер</span>
              <select className="inp" value={buffer} onChange={(e) => setBuffer(Number(e.target.value))}>
                {BUFFER_OPTIONS.map((b) => <option key={b} value={b}>{b} хв</option>)}
              </select>
            </label>
          </div>
          <label className="fld">
            <span className={"fld-lab" + (miss.region ? " bk-miss-lab" : "")}>Область дослідження <span className="req">*</span></span>
            <select className="inp" value={region} onChange={(e) => setRegion(e.target.value)}>
              <option value="">— Оберіть область —</option>
              {regions.map((r) => (
                <option key={r.label} value={r.label}>{r.label}{contrastSuffix} · {r.dur + (contrast ? CONTRAST_DUR : 0)} хв</option>
              ))}
            </select>
          </label>
          {price != null && <div className="ctx-hint blue">Орієнтовна вартість: {fmtPrice(price)} · блок {totalDur || computedDur} хв</div>}

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
          </div>

          <div className="bk-section-label">Бажане вікно (для підбору слота)</div>
          <div className="fld-row">
            <label className="fld">
              <span className="fld-lab">Готовий з</span>
              <input className="inp tabular" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </label>
            <label className="fld">
              <span className="fld-lab">по (включно)</span>
              <input className="inp tabular" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </label>
            <label className="fld">
              <span className="fld-lab">Час доби</span>
              <select className="inp" value={timeKey} onChange={(e) => setTimeKey(e.target.value)}>
                {TIME_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </label>
          </div>
          {badRange && <div className="ctx-hint red">Дата «по» раніша за дату «з» — виправте діапазон.</div>}

          <label className="fld">
            <span className="fld-lab">Нотатка</span>
            <textarea className="inp bk-notes" placeholder="Побажання пацієнта, скеровання, коментар…" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>

        <div className="dlg-foot">
          {valid
            ? <span className="bk-summary">{name.split(" ").slice(0, 2).join(" ")} · {primaryKind}{region ? " · " + region : ""}</span>
            : <span className="bk-missing">{missingList.map((m, i) => <span className="bk-miss-chip" key={i}>{m}</span>)}</span>}
          <button className="btn btn-ghost" onClick={onClose}>Скасувати</button>
          <button className="btn btn-primary" disabled={!valid || saving} onClick={handleSave}>{saving ? "Збереження…" : "Додати до листа"}</button>
        </div>
      </div>
    </div>
  );
}
