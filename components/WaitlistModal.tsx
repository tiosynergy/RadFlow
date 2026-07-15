"use client";

/* ===== RadFlow — Додати / редагувати запис листа очікування =====
   Форма без вибору слота: пацієнт + дослідження (основне + додаткові) +
   пріоритет + бажане вікно (діапазон дат, час доби). Використовується
   адміном/реєстратором (/waitlist) і направником (портал).
   Режим редагування: prop `initial` (пріоритет і центр НЕ редагуються тут —
   пріоритет змінюється в картці з перевіркою прав, центр незмінний).
   Збереження — через Server Action (батько). */

import { useState } from "react";
import PhoneInput from "@/components/PhoneInput";
import { DobField } from "@/components/BookingModal";
import { CONTRAST_SURCHARGE, CONTRAST_DUR, BUFFER_DEFAULT, BUFFER_OPTIONS, regionsFor, studyPrice, normBuffer, BOOKABLE_MODALITIES, modalityLabel, modalityShort, modalityKind, modalityCode, type Study } from "@/lib/studies";
import { PRIORITY_OPTIONS, PRIORITY_META, type PatientPriority } from "@/lib/priority";
import { TIME_PRESETS, timePresetKey } from "@/lib/waitlist";
import { wallDayKey } from "@/lib/incidents";
import type { WaitlistEntry } from "@/supabase/types";
import { useModalA11y } from "@/lib/useModalA11y";

type ExtraStudy = { type: string; region: string; dur: number };
type StudyOut = { type: string; region: string; contrast?: boolean; dur: number; price: number | null };
type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null };

export type WaitlistFormOut = {
  clinicId?: string; // при виборі центру (портал направника)
  roomId: string | null; // опційна жорстка прив'язка до кабінету (null = будь-який)
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

/* «Сьогодні» — доба КЛІНІКИ. Зону передаємо ЯВНО пропом clinicTz (дошки персоналу),
   бо покладатися на singleton у мультиклінічних екранах не можна (HANDOVER §6.1).
   Портал направника центр обирає всередині модалки — там clinicTz не передаємо, і
   лишається фолбек на singleton/браузер (як і було). */
function todayKey(tz?: string | null): string { return wallDayKey(tz || undefined); }

interface WaitlistModalProps {
  /** Портал направника: обовʼязковий вибір центру (active referral_access). */
  centers?: { clinicId: string; name: string }[];
  /** Кабінети центру — вмикають опційний селектор жорсткої прив'язки (адмін-флоу). */
  rooms?: RoomOpt[];
  /** Режим редагування наявного рядка листа. */
  initial?: WaitlistEntry | null;
  /** TZ центру (дошки персоналу передають явно; портал направника — ні). */
  clinicTz?: string | null;
  onClose: () => void;
  onSave: (w: WaitlistFormOut) => void | Promise<void>;
}

export default function WaitlistModal({ centers, rooms, initial, clinicTz, onClose, onSave }: WaitlistModalProps) {
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  const isEdit = !!initial;
  const todayStr = todayKey(clinicTz);   // «сьогодні» клініки — для дефолту й гарду прошлого
  const initStudies: Study[] = Array.isArray(initial?.studies) ? (initial!.studies as Study[]) : [];
  const initPrimary = initStudies[0] || null;
  const needCenter = !isEdit && Array.isArray(centers) && centers.length > 0;
  const [centerId, setCenterId] = useState(() => (needCenter && centers!.length === 1 ? centers![0].clinicId : ""));
  const [name, setName] = useState(initial?.patient_name || "");
  const [phone, setPhone] = useState(initial?.patient_phone || "");
  const [email, setEmail] = useState(initial?.patient_email || "");
  const [dob, setDob] = useState(initial?.patient_dob || "");
  const [gender, setGender] = useState(initial?.patient_sex || "");
  const [weight, setWeight] = useState(initial?.patient_weight != null ? String(initial.patient_weight) : "");
  const [studyType, setStudyType] = useState<string>(initPrimary ? modalityCode(initPrimary.type) : "MRI");
  const [region, setRegion] = useState(initPrimary?.region || "");
  const [contrast, setContrast] = useState(initPrimary?.contrast === true);
  const [buffer, setBuffer] = useState<number>(initial ? normBuffer(initial.buffer_time_min) : BUFFER_DEFAULT);
  const [priority, setPriority] = useState<PatientPriority | "">(initial?.priority_level || "");
  const [roomId, setRoomId] = useState<string>(initial?.room_id || "");
  const [dateFrom, setDateFrom] = useState(initial ? (initial.desired_date_from || "") : todayStr);
  const [dateTo, setDateTo] = useState(initial?.desired_date_to || "");
  const [timeKey, setTimeKey] = useState(() => (initial ? timePresetKey(initial.desired_time_from, initial.desired_time_to) : "any"));
  const [note, setNote] = useState(initial?.note || "");
  const [saving, setSaving] = useState(false);

  // Лист очікування не привʼязаний до кабінету, тож пропонуємо всі модальності, на
  // які можна записати (портал направника кабінетів не передає взагалі).
  const availableModalities = BOOKABLE_MODALITIES;
  const allRegions = regionsFor(studyType);
  const regions = contrast ? allRegions.filter((r) => r.contrast) : allRegions;
  const primaryKind = modalityLabel(studyType);
  // Кабінети поточної модальності — для опційної жорсткої прив'язки (адмін-флоу).
  const roomOptions = (rooms || []).filter((r) => r.modality === studyType);
  const contrastSuffix = contrast ? " з контрастом" : "";
  const regionObj = regions.find((r) => r.label === region);
  const computedDur = regionObj ? regionObj.dur + (contrast ? CONTRAST_DUR : 0) : (allRegions[0]?.dur ?? 20);
  const price = regionObj ? regionObj.price + (contrast ? CONTRAST_SURCHARGE : 0) : null;
  const fmtPrice = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₴";

  const exDur = (t: string, reg: string) => { const o = regionsFor(t).find((r) => r.label === reg); return o ? o.dur : (regionsFor(t)[0]?.dur ?? 20); };
  const [extraStudies, setExtraStudies] = useState<ExtraStudy[]>(() =>
    initStudies.slice(1).filter((s) => s?.region).map((s) => ({
      type: modalityLabel(s.type),
      region: s.region as string,
      dur: Number(s.dur) || exDur(modalityLabel(s.type), s.region as string),
    }))
  );
  const exPatch = (i: number, p: Partial<ExtraStudy>) => setExtraStudies((a) => a.map((r, idx) => (idx === i ? { ...r, ...p } : r)));
  const exSetRegion = (i: number, reg: string) => { const r = extraStudies[i]; exPatch(i, { region: reg, dur: exDur(r.type, reg) }); };
  const exSetDur = (i: number, v: string) => exPatch(i, { dur: Math.max(5, parseInt(v, 10) || 0) });
  const exAdd = () => setExtraStudies((a) => [...a, { type: primaryKind, region: "", dur: exDur(primaryKind, "") }]);
  const exRemove = (i: number) => setExtraStudies((a) => a.filter((_, idx) => idx !== i));
  const validExtra = extraStudies.filter((s) => s.region);

  function changeType(code: string) {
    setStudyType(code); setRegion(""); setContrast(false); setRoomId(""); // прив'язка до кабінету скидається зі зміною модальності
    const k = modalityLabel(code);
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
  /* Вікно ЦІЛКОМ у минулому → пацієнт вічно висить у «Очікують»: жоден майбутній
     слот не потрапить у [from, to]. Стягуюча умова саме на КІНЕЦЬ вікна: відкрите
     «по» (порожнє) завжди має майбутнє, тож не блокуємо. `min=` на інпутах — лише
     підказка (атрибут не блокує ручний/клавіатурний ввід — урок past-slot 0063),
     тому справжній гард тут, у valid. */
  const pastWindow = !!(dateTo && dateTo < todayStr);
  const valid = missingList.length === 0 && !badRange && !pastWindow;

  async function handleSave() {
    if (!valid || saving) return;
    setSaving(true);
    try {
      const preset = TIME_PRESETS.find((p) => p.key === timeKey) || TIME_PRESETS[0];
      await onSave({
        clinicId: needCenter ? centerId : undefined,
        roomId: roomId || null,
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
          <div className="dlg-title"><span className="tic">{isEdit ? "✎" : "⏳"}</span>{isEdit ? "Редагувати запис листа" : "До листа очікування"}</div>
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
              <input className="inp" placeholder="кг" value={weight}
                onChange={(e) => { const w = e.target.value.replace(/\D/g, "").slice(0, 3); setWeight(w && +w > 400 ? "400" : w); }} />
            </label>
          </div>

          <div className="bk-section-label">Дослідження</div>
          <div className="fld-row" style={{ alignItems: "flex-end" }}>
            <div className="fld" style={{ flex: "0 0 auto" }}>
              <span className="fld-lab">Тип <span className="req">*</span></span>
              <div className="bk-seg" style={{ flexWrap: "wrap" }}>
                {availableModalities.map((code) => (
                  <button key={code} className={"bk-seg-btn" + (studyType === code ? " active " + modalityKind(code) : "")} onClick={() => changeType(code)} title={modalityLabel(code)}>{modalityShort(code)}</button>
                ))}
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
          {/* Додаткові дослідження (тип = тип основного, як у формі запису) */}
          <div className="fld">
            {extraStudies.length > 0 && (
              <div className="bk-study-table">
                <div className="bk-study-head"><span>Тип</span><span>Область дослідження</span><span>Трив.</span><span /></div>
                {extraStudies.map((r, i) => {
                  const regs = regionsFor(r.type);
                  return (
                    <div className="bk-study-row" key={i}>
                      <div className="bk-seg bk-seg-sm st-seg-locked" title="Тип = тип основного дослідження">
                        <button className={"bk-seg-btn active " + modalityKind(studyType)} disabled>{modalityShort(studyType)}</button>
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

          {price != null && <div className="ctx-hint blue">Орієнтовна вартість: {fmtPrice(price)} · блок {totalDur || computedDur} хв</div>}

          {!isEdit && (
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
          )}

          <div className="bk-section-label">Бажане вікно (для підбору слота)</div>
          <div className="fld-row">
            <label className="fld">
              <span className="fld-lab">Готовий з</span>
              <input className="inp tabular" type="date" min={todayStr} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </label>
            <label className="fld">
              <span className="fld-lab">по (включно)</span>
              <input className="inp tabular" type="date" min={todayStr} value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </label>
            <label className="fld">
              <span className="fld-lab">Час доби</span>
              <select className="inp" value={timeKey} onChange={(e) => setTimeKey(e.target.value)}>
                {TIME_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </label>
          </div>
          {badRange && <div className="ctx-hint red">Дата «по» раніша за дату «з» — виправте діапазон.</div>}
          {pastWindow && <div className="ctx-hint red">Кінець бажаного вікна вже минув — оберіть майбутню дату, інакше пацієнт не потрапить у підбір.</div>}

          {roomOptions.length > 0 && (
            <label className="fld">
              <span className="fld-lab">Кабінет (необовʼязково)</span>
              <select className="inp" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
                <option value="">Будь-який кабінет ({primaryKind})</option>
                {roomOptions.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}{r.apparatus_model ? " · " + r.apparatus_model : ""}</option>
                ))}
              </select>
            </label>
          )}

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
          <button className="btn btn-primary" disabled={!valid || saving} onClick={handleSave}>{saving ? "Збереження…" : isEdit ? "Зберегти зміни" : "Додати до листа"}</button>
        </div>
      </div>
    </div>
  );
}
