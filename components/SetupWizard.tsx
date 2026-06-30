"use client";

/* ===== RadFlow — Setup Wizard (Майстер налаштування) =====
   Портовано з прототипу wizard-app.jsx + wizard-steps.jsx.
   Дані префілляться з Supabase і зберігаються при «Запустити кабінет». */

import { useState, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Json, TablesInsert } from "@/supabase/types";
import CitySelect from "@/components/CitySelect";
import StaffManager from "@/components/StaffManager";
import ReferrersManager from "@/components/ReferrersManager";
import CeoManager from "@/components/CeoManager";
import { formatPhoneUA, isValidPhoneUA } from "@/lib/phone";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";
import "@/styles/prototype/radflow-wizard.css";

type Toast = { id: number; msg: string; type: string; out?: boolean };
type DayHours = { start: string; end: string; lunch: boolean; lunchS: string; lunchE: string };
type EquipItem = {
  id: number | string;
  type: string; desc: string; room: string;
  days: number[];
  start: string; end: string; lunch: boolean; lunchS: string; lunchE: string;
  perDay: boolean; dayHours: DayHours[];
  roomId?: string;
};
type WizardData = {
  clinic: string; city: string; address: string; phones: string[]; emails: string[];
  adminName: string; adminEmail: string; aPhones: string[]; aEmails: string[]; equip: EquipItem[];
};
type WizardInitial = Partial<{
  clinic: string; city: string; address: string; phones: string[]; emails: string[];
  adminName: string; adminEmail: string; adminPhone: string; equip: EquipItem[];
}>;

/* ---------- Toasts ---------- */
function Toasts({ toasts }: { toasts: Toast[] }) {
  const icons: Record<string, string> = { success: "✓", error: "✕", info: "ℹ", warning: "⚠" };
  return (
    <div className="toast-wrap">
      {toasts.map((t) => (
        <div className={"toast " + t.type + (t.out ? " out" : "")} key={t.id}>
          <span className="ti">{icons[t.type]}</span>
          <span className="tmsg">{t.msg}</span>
        </div>
      ))}
    </div>
  );
}
function useToasts(): [Toast[], (msg: string, type?: string) => void] {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  function push(msg: string, type = "success") {
    const id = ++seq.current;
    setToasts((ts) => [...ts, { id, msg, type }]);
    setTimeout(() => setToasts((ts) => ts.map((t) => (t.id === id ? { ...t, out: true } : t))), 3400);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 3700);
  }
  return [toasts, push];
}

const Req = () => <span className="req" title="Обов'язкове поле">*</span>;

/* Список телефонів / email-ів */
function ContactList({ label, items, setItems, type, ph, required }: {
  label: string;
  items: string[];
  setItems: Dispatch<SetStateAction<string[]>>;
  type?: string;
  ph?: string;
  required?: boolean;
}) {
  const isPhone = type !== "email";
  const noun = isPhone ? "телефон" : "email";
  const upd = (i: number, v: string) => setItems((a) => a.map((x, j) => (j === i ? v : x)));
  const add = () => setItems((a) => [...a, ""]);
  const del = (i: number) => setItems((a) => (a.length > 1 ? a.filter((_, j) => j !== i) : [""]));
  const empty = required && items.every((x) => x.trim() === "");
  return (
    <div className="fld">
      <span className="fld-lab">{label}{required && <Req />}</span>
      {items.map((v, i) => {
        const badPhone = isPhone && v.trim() !== "" && !isValidPhoneUA(v);
        return (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
          <input className={"inp" + ((empty && i === 0) || badPhone ? " invalid" : "")} type={isPhone ? "tel" : "email"} inputMode={isPhone ? "tel" : undefined} placeholder={ph} value={v}
            onChange={(e) => upd(i, isPhone ? formatPhoneUA(e.target.value) : e.target.value)} />
          <button className="mini-icon" type="button" title={"Видалити " + noun} onClick={() => del(i)}>✕</button>
        </div>
        );
      })}
      <button className="btn btn-secondary btn-sm add-btn" type="button" onClick={add}>＋ Додати {noun}</button>
    </div>
  );
}

const EQ_DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
const DEF_DAY: DayHours = { start: "08:00", end: "18:00", lunch: false, lunchS: "13:00", lunchE: "14:00" };
function mkSched(): Omit<EquipItem, "id" | "type" | "desc" | "room" | "roomId"> {
  return { days: [1, 1, 1, 1, 1, 0, 0], ...DEF_DAY, perDay: false, dayHours: Array.from({ length: 7 }, () => ({ ...DEF_DAY })) };
}

/* Пункти бічної навігації майстра (кружки без нумерації).
   Профіль / Адміністратор / Обладнання / Прайс — секції цього екрана (anchor);
   Радіологи / Направники / Керівники — окремі сторінки керування (href). */
const WIZ_NAV: { label: string; desc: string; anchor?: string; href?: string }[] = [
  { label: "Профіль клініки", desc: "Назва та контакти центру", anchor: "sec-clinic" },
  { label: "Адміністратор", desc: "Обліковий запис адміна", anchor: "sec-admin" },
  { label: "Обладнання та кабінети", desc: "Апарати та розклад", anchor: "sec-equip" },
  { label: "Послуги та прайс", desc: "Незабаром", anchor: "sec-price" },
  { label: "Радіологи та доступи", desc: "Керування персоналом", anchor: "sec-staff" },
  { label: "Лікарі-направники", desc: "Направники центру", anchor: "sec-referrers" },
  { label: "Керівники (CEO)", desc: "Аналітичний доступ", anchor: "sec-ceo" },
];
// Секції, що належать майстру первинного налаштування (з кнопкою «Запустити кабінет»).
const FORM_SECTIONS = ["sec-clinic", "sec-admin", "sec-equip", "sec-price"];

/* ---------- Крок 1: Профіль клініки ---------- */
function StepRegister({ report, onData, initial, active }: { report: (k: number, ok: boolean) => void; onData: (d: WizardData) => void; initial: WizardInitial; active: string }) {
  const [clinic, setClinic] = useState(initial.clinic || "");
  const [city, setCity] = useState(initial.city || "");
  const [address, setAddress] = useState(initial.address || "");
  const [phones, setPhones] = useState<string[]>(initial.phones && initial.phones.length ? initial.phones : [""]);
  const [emails, setEmails] = useState<string[]>(initial.emails && initial.emails.length ? initial.emails : [""]);

  const [adminName, setAdminName] = useState(initial.adminName || "");
  const [adminEmail, setAdminEmail] = useState(initial.adminEmail || "");
  const [aPhones, setAPhones] = useState<string[]>([initial.adminPhone || ""]);
  const [aEmails, setAEmails] = useState<string[]>([""]);

  const [equip, setEquip] = useState<EquipItem[]>(
    initial.equip && initial.equip.length
      ? initial.equip
      : [{ id: 1, type: "МРТ", desc: "", room: "Кабінет №1", ...mkSched() }]
  );

  useEffect(() => {
    const adminPhoneOk = aPhones.some((p) => p.trim() !== "");
    const ok = clinic.trim() !== "" && city.trim() !== "" && adminName.trim() !== "" && adminPhoneOk && equip.length > 0;
    report(1, !!ok);
    onData({ clinic, city, address, phones, emails, adminName, adminEmail, aPhones, aEmails, equip });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinic, city, address, phones, emails, adminName, adminEmail, aPhones, aEmails, equip]);

  function setEq(i: number, k: string, v: string | boolean) { setEquip((a) => a.map((x, j) => (j === i ? { ...x, [k]: v } : x))); }
  function toggleEqDay(i: number, d: number) { setEquip((a) => a.map((x, j) => (j === i ? { ...x, days: x.days.map((v, k) => (k === d ? (v ? 0 : 1) : v)) } : x))); }
  function setEqDay(i: number, di: number, k: string, v: string | boolean) {
    setEquip((a) => a.map((x, j) => (j === i ? { ...x, dayHours: x.dayHours.map((dh, k2) => (k2 === di ? { ...dh, [k]: v } : dh)) } : x)));
  }
  function toggleEqPerDay(i: number, on: boolean) {
    setEquip((a) => a.map((x, j) => {
      if (j !== i) return x;
      if (!on) return { ...x, perDay: false };
      const seed = { start: x.start, end: x.end, lunch: x.lunch, lunchS: x.lunchS, lunchE: x.lunchE };
      return { ...x, perDay: true, dayHours: Array.from({ length: 7 }, () => ({ ...seed })) };
    }));
  }
  function addEq() { setEquip((a) => [...a, { id: Date.now(), type: "МРТ", desc: "", room: "", ...mkSched() }]); }
  function delEq(i: number) { setEquip((a) => a.filter((_, j) => j !== i)); }

  return (
    <div className="fade-in">
      {active === "sec-clinic" && (<>
      <h1 className="wiz-h">Профіль клініки</h1>
      <p className="wiz-hsub">Базові дані центру.</p>

      <div className="info-banner" style={{ marginTop: 16 }}>
        <span className="ib-ic" style={{ color: "var(--green)" }}>✓</span>
        <span className="ib-txt"><b>Email підтверджено.</b> Обліковий запис активовано.</span>
      </div>

      <div className="sec-label" style={{ marginTop: 16 }}>Медичний центр</div>
      <div className="form-card reg-card">
        <div className="fld-row">
          <label className="fld"><span className="fld-lab">Назва клініки <Req /></span>
            <input className={"inp" + (clinic.trim() ? "" : " invalid")} value={clinic} onChange={(e) => setClinic(e.target.value)} /></label>
          <span className="fld-spacer" />
        </div>
        <div className="fld-row">
          <label className="fld"><span className="fld-lab">Місто <Req /></span>
            <CitySelect value={city} onChange={setCity} required /></label>
          <label className="fld" style={{ flex: 2 }}><span className="fld-lab">Адреса</span>
            <input className="inp" placeholder="вул., будинок, поверх, індекс" value={address} onChange={(e) => setAddress(e.target.value)} /></label>
        </div>
        <div className="contacts-grid">
          <ContactList label="Телефони" items={phones} setItems={setPhones} ph="+38 0__ ___ __ __" />
          <ContactList label="Email-и" items={emails} setItems={setEmails} type="email" ph="name@clinic.ua" />
        </div>
      </div>

      </>)}

      {active === "sec-admin" && (<>
      <h1 className="wiz-h">Адміністратор</h1>
      <p className="wiz-hsub">Обліковий запис адміністратора центру.</p>
      <div className="form-card reg-card" style={{ marginTop: 16 }}>
        <div className="fld-row">
          <label className="fld">
            <span className="fld-lab">ПІБ адміністратора <Req /></span>
            <input className={"inp" + (adminName.trim() ? "" : " invalid")} placeholder="Прізвище Ім'я По батькові" value={adminName} onChange={(e) => setAdminName(e.target.value)} />
          </label>
          <label className="fld">
            <span className="fld-lab">Email для входу <Req /></span>
            <input className="inp" type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} readOnly />
            <span className="fld-hint">Логін · роль: Адміністратор</span>
          </label>
        </div>
        <div className="contacts-grid">
          <ContactList label="Телефони" items={aPhones} setItems={setAPhones} ph="+38 0__ ___ __ __" required />
          <ContactList label="Email-и" items={aEmails} setItems={setAEmails} type="email" ph="name@example.com" />
        </div>
      </div>

      </>)}

      {active === "sec-equip" && (<>
      <h1 className="wiz-h">Обладнання та кабінети <Req /></h1>
      <p className="wiz-hsub">Апарати центру та їхній графік роботи.</p>
      <div className="form-card" style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
        {equip.map((e, i) => (
          <div key={e.id} className="equip-block">
            <button className="mini-icon equip-block-del" type="button" title="Видалити обладнання" onClick={() => delEq(i)} disabled={equip.length <= 1}>✕</button>
            <div className="equip-info">
              <div className="equip-info-row">
                <select className="inp equip-type" value={e.type} onChange={(ev) => setEq(i, "type", ev.target.value)}>
                  <option value="МРТ">МРТ</option>
                  <option value="КТ">КТ</option>
                  <option value="Інше">Інше</option>
                </select>
                <input className="inp equip-room2" placeholder="Кабінет / №" value={e.room} onChange={(ev) => setEq(i, "room", ev.target.value)} />
              </div>
              <input className="inp" placeholder="Модель / опис обладнання" value={e.desc} onChange={(ev) => setEq(i, "desc", ev.target.value)} />
            </div>
            <div className="equip-sched">
              <span className="equip-sched-lab">Розклад роботи</span>
              <div className="eq-days">
                {EQ_DAYS.map((d, di) => (
                  <button key={d} type="button" className={"eq-day" + (e.days[di] ? " on" : "")} title={d} onClick={() => toggleEqDay(i, di)}>{d}</button>
                ))}
              </div>

              <label className="eq-perday-lab">
                <input type="checkbox" checked={e.perDay} onChange={(ev) => toggleEqPerDay(i, ev.target.checked)} />
                Свій час для кожного дня
              </label>

              {!e.perDay && (
                <>
                  <div className="eq-hours">
                    <input className="inp tabular eq-time" type="time" value={e.start} onChange={(ev) => setEq(i, "start", ev.target.value)} />
                    <span className="eq-dash">–</span>
                    <input className="inp tabular eq-time" type="time" value={e.end} onChange={(ev) => setEq(i, "end", ev.target.value)} />
                  </div>
                  <label className="eq-break-lab">
                    <input type="checkbox" checked={e.lunch} onChange={(ev) => setEq(i, "lunch", ev.target.checked)} />
                    Перерва
                  </label>
                  {e.lunch && (
                    <div className="eq-hours">
                      <input className="inp tabular eq-time" type="time" value={e.lunchS} onChange={(ev) => setEq(i, "lunchS", ev.target.value)} />
                      <span className="eq-dash">–</span>
                      <input className="inp tabular eq-time" type="time" value={e.lunchE} onChange={(ev) => setEq(i, "lunchE", ev.target.value)} />
                    </div>
                  )}
                </>
              )}

              {e.perDay && (
                <div className="eq-perday-list">
                  {e.days.some((d) => d) ? (
                    EQ_DAYS.map((d, di) => (e.days[di] ? (
                      <div key={d} className="eq-perday-row">
                        <span className="eq-perday-day">{d}</span>
                        <div className="eq-perday-fields">
                          <div className="eq-hours">
                            <input className="inp tabular eq-time" type="time" value={e.dayHours[di].start} onChange={(ev) => setEqDay(i, di, "start", ev.target.value)} />
                            <span className="eq-dash">–</span>
                            <input className="inp tabular eq-time" type="time" value={e.dayHours[di].end} onChange={(ev) => setEqDay(i, di, "end", ev.target.value)} />
                          </div>
                          <label className="eq-break-lab">
                            <input type="checkbox" checked={e.dayHours[di].lunch} onChange={(ev) => setEqDay(i, di, "lunch", ev.target.checked)} />
                            Перерва
                          </label>
                          {e.dayHours[di].lunch && (
                            <div className="eq-hours">
                              <input className="inp tabular eq-time" type="time" value={e.dayHours[di].lunchS} onChange={(ev) => setEqDay(i, di, "lunchS", ev.target.value)} />
                              <span className="eq-dash">–</span>
                              <input className="inp tabular eq-time" type="time" value={e.dayHours[di].lunchE} onChange={(ev) => setEqDay(i, di, "lunchE", ev.target.value)} />
                            </div>
                          )}
                        </div>
                      </div>
                    ) : null))
                  ) : (
                    <div className="eq-perday-empty">Оберіть робочі дні вище.</div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
        <button className="btn btn-secondary btn-sm add-btn" type="button" onClick={addEq}>＋ Додати обладнання</button>
      </div>

      </>)}

      {active === "sec-price" && (<>
      <h1 className="wiz-h">Послуги та прайс</h1>
      <div className="form-card" style={{ marginTop: 16 }}>
        <div className="info-banner">
          <span className="ib-ic" style={{ color: "var(--blue)" }}>🛠</span>
          <span className="ib-txt"><b>Незабаром.</b> Тут зʼявиться керування переліком послуг і цінами центру — з привʼязкою до модальності та кабінетів.</span>
        </div>
      </div>
      </>)}
    </div>
  );
}

/* ---------- Майстер (контейнер) ---------- */
type SetupRoom = { id: string; modality: string; name: string; apparatus_model?: string | null };

export default function SetupWizard({ clinicId, userId, initial, rooms = [], clinicName, adminName }: { clinicId: string; userId: string; initial: WizardInitial; rooms?: SetupRoom[]; clinicName?: string; adminName?: string }) {
  const router = useRouter();
  const [activeSection, setActiveSection] = useState("sec-clinic");
  const [saving, setSaving] = useState(false);
  const [valid, setValid] = useState<Record<number, boolean>>({});
  const [dirty, setDirty] = useState(false);
  const [exitAsk, setExitAsk] = useState(false);
  const [toasts, push] = useToasts();
  const dataRef = useRef<WizardData | null>(null);
  const savedRef = useRef<string | null>(null); // знімок збережених даних форми

  function report(k: number, ok: boolean) { setValid((v) => (v[k] === ok ? v : { ...v, [k]: ok })); }
  function onData(d: WizardData) {
    dataRef.current = d;
    const snap = JSON.stringify(d);
    if (savedRef.current === null) { savedRef.current = snap; return; } // базовий знімок при першому завантаженні
    setDirty(snap !== savedRef.current);
  }

  async function save(): Promise<boolean> {
    const d = dataRef.current;
    if (!d || saving) return false;
    setSaving(true);
    const clean = (a: string[]) => a.map((x) => x.trim()).filter(Boolean);
    try {
      const supabase = createClient();

      const { error: ce } = await supabase
        .from("clinics")
        .update({
          name: d.clinic.trim(),
          city: d.city.trim() || null,
          address: d.address.trim() || null,
          phones: clean(d.phones),
          emails: clean(d.emails),
          configured_at: new Date().toISOString(),
        })
        .eq("id", clinicId);
      if (ce) throw ce;

      const { error: pe } = await supabase
        .from("profiles")
        .update({
          full_name: d.adminName.trim() || null,
          phone: (d.aPhones.find((p) => p.trim()) || "").trim() || null,
        })
        .eq("id", userId);
      if (pe) throw pe;

      // Кабінети: оновлюємо наявні за id, додаємо нові, видаляємо лише прибрані.
      const roomFields = (e: EquipItem): TablesInsert<"rooms"> => ({
        clinic_id: clinicId,
        name: (e.room || e.type).trim(),
        modality: e.type === "МРТ" ? "MRI" : e.type === "КТ" ? "CT" : "OTHER",
        apparatus_model: e.desc.trim() || null,
        schedule: {
          days: e.days, start: e.start, end: e.end,
          lunch: e.lunch, lunchS: e.lunchS, lunchE: e.lunchE,
          perDay: e.perDay, dayHours: e.dayHours,
        } as Json,
      });
      const keepIds: string[] = [];
      for (const e of d.equip) {
        if (e.roomId) {
          const { error: ue } = await supabase.from("rooms").update(roomFields(e)).eq("id", e.roomId);
          if (ue) throw ue;
          keepIds.push(e.roomId);
        } else {
          const { data: ins, error: ie } = await supabase.from("rooms").insert(roomFields(e)).select("id").single();
          if (ie) throw ie;
          if (ins) keepIds.push(ins.id);
        }
      }
      // Прибрані в майстрі кабінети — видаляємо точково за id.
      const { data: existingRooms } = await supabase.from("rooms").select("id").eq("clinic_id", clinicId);
      const removed = (existingRooms || []).map((r) => r.id).filter((id) => !keepIds.includes(id));
      for (const id of removed) {
        const { error: de } = await supabase.from("rooms").delete().eq("id", id);
        if (de) throw de;
      }

      savedRef.current = JSON.stringify(d);
      setDirty(false);
      push("Зміни збережено", "success");
      setSaving(false);
      return true;
    } catch (e) {
      push("Помилка збереження: " + ((e as { message?: string })?.message || String(e)), "error");
      setSaving(false);
      return false;
    }
  }

  function exitSetup() {
    if (saving) return;
    if (dirty) { setExitAsk(true); return; }
    router.push("/queue");
  }
  async function saveAndExit() {
    const ok = await save();
    setExitAsk(false);
    if (ok) router.push("/queue");
  }

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="wiz">
      <aside className="wiz-side">
        <div className="wiz-head">
          <span className="wiz-logo"><span className="dot" />RadFlow</span>
          <div className="wiz-sub">Налаштування та профіль кабінету</div>
        </div>
        <div className="wiz-steps">
          {WIZ_NAV.map((s) => {
            const on = activeSection === s.anchor;
            return (
              <button key={s.label} type="button" className={"wstep" + (on ? " done" : "")} title={s.desc}
                aria-current={on ? "true" : undefined} onClick={() => setActiveSection(s.anchor as string)}
                style={{ width: "100%", textAlign: "left", background: on ? "var(--card-hover)" : "none", border: "none", font: "inherit", cursor: "pointer" }}>
                <span className="wstep-num" aria-hidden />
                <span className="wstep-txt">
                  <span className="wstep-title">{s.label}</span>
                  <span className="wstep-desc">{s.desc}</span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="wiz-foot">
          <div className="wiz-prog-lab">
            <span>Майстер налаштувань</span>
            <a href="mailto:support@radflow.ua?subject=Допомога%20з%20налаштуванням" title="Написати в підтримку">Підтримка</a>
          </div>
          <a className="wiz-exit" onClick={signOut} style={{ cursor: "pointer" }} title="Вийти з акаунта">⏻ Вийти з акаунта</a>
        </div>
      </aside>

      <div className="wiz-main">
        <div className="wiz-main-inner">
          {(
            <>
              {/* Кожне вікно налаштувань — окремо; перемикається кружками зліва */}
              <div style={{ display: FORM_SECTIONS.includes(activeSection) ? "block" : "none" }}>
                <StepRegister report={report} onData={onData} initial={initial} active={activeSection} />
              </div>

              <div className="fade-in" style={{ display: activeSection === "sec-staff" ? "block" : "none" }}>
                <h1 className="wiz-h">Радіологи та доступи</h1>
                <StaffManager embedded clinicId={clinicId} rooms={rooms} clinicName={clinicName} adminName={adminName} />
              </div>

              <div className="fade-in" style={{ display: activeSection === "sec-referrers" ? "block" : "none" }}>
                <h1 className="wiz-h">Лікарі-направники</h1>
                <ReferrersManager embedded clinicId={clinicId} rooms={rooms} clinicName={clinicName} adminName={adminName} />
              </div>

              <div className="fade-in" style={{ display: activeSection === "sec-ceo" ? "block" : "none" }}>
                <h1 className="wiz-h">Керівники (CEO)</h1>
                <CeoManager embedded clinicId={clinicId} clinicName={clinicName} adminName={adminName} />
              </div>
            </>
          )}
        </div>

        <div className="wiz-bar">
          <div className="wiz-bar-inner">
            <div className="wiz-bar-right" style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
              {FORM_SECTIONS.includes(activeSection) && (
                <span className="wiz-cta-wrap" title={valid[1] ? undefined : "Заповніть назву клініки, місто, ПІБ і телефон адміністратора та хоча б один апарат"}>
                  <button className="btn btn-green" onClick={save} disabled={!valid[1] || saving}>
                    {saving ? "Зберігаємо…" : "Зберегти"}
                  </button>
                </span>
              )}
              <button className="btn btn-secondary" onClick={exitSetup} disabled={saving}>Вийти</button>
            </div>
          </div>
        </div>
      </div>

      {exitAsk && (
        <div className="overlay" onClick={() => !saving && setExitAsk(false)}>
          <div className="dialog fade-in" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
            <div className="dlg-head"><div className="dlg-title">Незбережені зміни</div><button className="icon-btn" onClick={() => setExitAsk(false)} disabled={saving}>✕</button></div>
            <div className="dlg-body">У налаштуваннях є незбережені зміни. Зберегти їх перед виходом?</div>
            <div className="dlg-foot" style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => setExitAsk(false)} disabled={saving}>Скасувати</button>
              <button className="btn btn-secondary" onClick={() => { setExitAsk(false); router.push("/queue"); }} disabled={saving}>Вийти без збереження</button>
              <button className="btn btn-green" onClick={saveAndExit} disabled={saving}>{saving ? "Зберігаємо…" : "Зберегти й вийти"}</button>
            </div>
          </div>
        </div>
      )}
      <Toasts toasts={toasts} />
    </div>
  );
}
