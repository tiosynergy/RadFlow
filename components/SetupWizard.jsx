"use client";

/* ===== RadFlow — Setup Wizard (Майстер налаштування) =====
   Портовано з прототипу wizard-app.jsx + wizard-steps.jsx.
   Дані префілляться з Supabase і зберігаються при «Запустити кабінет». */

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";
import "@/styles/prototype/radflow-wizard.css";

/* ---------- Toasts ---------- */
function Toasts({ toasts }) {
  const icons = { success: "✓", error: "✕", info: "ℹ", warning: "⚠" };
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
function useToasts() {
  const [toasts, setToasts] = useState([]);
  const seq = useRef(0);
  function push(msg, type = "success") {
    const id = ++seq.current;
    setToasts((ts) => [...ts, { id, msg, type }]);
    setTimeout(() => setToasts((ts) => ts.map((t) => (t.id === id ? { ...t, out: true } : t))), 3400);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 3700);
  }
  return [toasts, push];
}

const Req = () => <span className="req" title="Обов'язкове поле">*</span>;

/* Список телефонів / email-ів */
function ContactList({ label, items, setItems, type, ph, required }) {
  const noun = type === "email" ? "email" : "телефон";
  const upd = (i, v) => setItems((a) => a.map((x, j) => (j === i ? v : x)));
  const add = () => setItems((a) => [...a, ""]);
  const del = (i) => setItems((a) => (a.length > 1 ? a.filter((_, j) => j !== i) : [""]));
  const empty = required && items.every((x) => x.trim() === "");
  return (
    <div className="fld">
      <span className="fld-lab">{label}{required && <Req />}</span>
      {items.map((v, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
          <input className={"inp" + (empty && i === 0 ? " invalid" : "")} type={type === "email" ? "email" : "text"} placeholder={ph} value={v} onChange={(e) => upd(i, e.target.value)} />
          <button className="mini-icon" type="button" title={"Видалити " + noun} onClick={() => del(i)}>✕</button>
        </div>
      ))}
      <button className="btn btn-secondary btn-sm add-btn" type="button" onClick={add}>＋ Додати {noun}</button>
    </div>
  );
}

const EQ_DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
const DEF_DAY = { start: "08:00", end: "18:00", lunch: false, lunchS: "13:00", lunchE: "14:00" };
function mkSched() {
  return { days: [1, 1, 1, 1, 1, 0, 0], ...DEF_DAY, perDay: false, dayHours: Array.from({ length: 7 }, () => ({ ...DEF_DAY })) };
}

/* ---------- Крок 1: Профіль клініки ---------- */
function StepRegister({ report, onData, initial }) {
  const [clinic, setClinic] = useState(initial.clinic || "");
  const [city, setCity] = useState(initial.city || "");
  const [address, setAddress] = useState(initial.address || "");
  const [phones, setPhones] = useState(initial.phones && initial.phones.length ? initial.phones : [""]);
  const [emails, setEmails] = useState(initial.emails && initial.emails.length ? initial.emails : [""]);

  const [adminName, setAdminName] = useState(initial.adminName || "");
  const [adminEmail, setAdminEmail] = useState(initial.adminEmail || "");
  const [aPhones, setAPhones] = useState([initial.adminPhone || ""]);
  const [aEmails, setAEmails] = useState([""]);

  const [equip, setEquip] = useState(
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

  function setEq(i, k, v) { setEquip((a) => a.map((x, j) => (j === i ? { ...x, [k]: v } : x))); }
  function toggleEqDay(i, d) { setEquip((a) => a.map((x, j) => (j === i ? { ...x, days: x.days.map((v, k) => (k === d ? (v ? 0 : 1) : v)) } : x))); }
  function setEqDay(i, di, k, v) {
    setEquip((a) => a.map((x, j) => (j === i ? { ...x, dayHours: x.dayHours.map((dh, k2) => (k2 === di ? { ...dh, [k]: v } : dh)) } : x)));
  }
  function toggleEqPerDay(i, on) {
    setEquip((a) => a.map((x, j) => {
      if (j !== i) return x;
      if (!on) return { ...x, perDay: false };
      const seed = { start: x.start, end: x.end, lunch: x.lunch, lunchS: x.lunchS, lunchE: x.lunchE };
      return { ...x, perDay: true, dayHours: Array.from({ length: 7 }, () => ({ ...seed })) };
    }));
  }
  function addEq() { setEquip((a) => [...a, { id: Date.now(), type: "МРТ", desc: "", room: "", ...mkSched() }]); }
  function delEq(i) { setEquip((a) => a.filter((_, j) => j !== i)); }

  return (
    <div className="fade-in">
      <h1 className="wiz-h">Профіль клініки</h1>
      <p className="wiz-hsub">Базові дані центру та обліковий запис адміністратора.</p>

      <div className="info-banner" style={{ marginTop: 16 }}>
        <span className="ib-ic" style={{ color: "var(--green)" }}>✓</span>
        <span className="ib-txt"><b>Email підтверджено.</b> Обліковий запис активовано.</span>
      </div>

      {/* СЕКЦІЯ 1 — Медичний центр */}
      <div className="sec-label" style={{ marginTop: 16 }}>Медичний центр</div>
      <div className="form-card reg-card">
        <div className="fld-row">
          <label className="fld"><span className="fld-lab">Назва клініки <Req /></span>
            <input className={"inp" + (clinic.trim() ? "" : " invalid")} value={clinic} onChange={(e) => setClinic(e.target.value)} /></label>
          <span className="fld-spacer" />
        </div>
        <div className="fld-row">
          <label className="fld"><span className="fld-lab">Місто <Req /></span>
            <input className={"inp" + (city.trim() ? "" : " invalid")} value={city} onChange={(e) => setCity(e.target.value)} /></label>
          <label className="fld" style={{ flex: 2 }}><span className="fld-lab">Адреса</span>
            <input className="inp" placeholder="вул., будинок, поверх, індекс" value={address} onChange={(e) => setAddress(e.target.value)} /></label>
        </div>
        <div className="contacts-grid">
          <ContactList label="Телефони" items={phones} setItems={setPhones} ph="+38 0__ ___ __ __" />
          <ContactList label="Email-и" items={emails} setItems={setEmails} type="email" ph="name@clinic.ua" />
        </div>
      </div>

      {/* СЕКЦІЯ 2 — Адміністратор */}
      <div className="sec-label" style={{ marginTop: 20 }}>Адміністратор</div>
      <div className="form-card reg-card">
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

      {/* Обладнання та кабінети */}
      <div className="sec-label" style={{ marginTop: 20 }}>Обладнання та кабінети <Req /></div>
      <div className="form-card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
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
    </div>
  );
}

/* ---------- Екран успіху ---------- */
function LaunchSuccess() {
  return (
    <div className="fade-in">
      <Confetti />
      <div className="golive">
        <div className="rocket">🎉</div>
        <div className="golive-h" style={{ color: "var(--green)" }}>Кабінет активовано!</div>
        <div className="golive-sub">RadFlow готовий приймати записи. Realtime-синхронізація увімкнена для всіх ролей.</div>
        <a href="/queue" className="btn btn-green" style={{ marginTop: 22, display: "inline-flex" }}>Перейти до дошки черги →</a>
      </div>
    </div>
  );
}
function Confetti() {
  const colors = ["#0a84ff", "#30d158", "#ff9f0a", "#ff453a", "#7b5cff", "#ffd60a"];
  const bits = Array.from({ length: 70 }, (_, i) => ({
    left: Math.random() * 100, color: colors[i % colors.length],
    delay: Math.random() * 0.6, dur: 1.6 + Math.random() * 1.4,
  }));
  return (
    <div className="confetti">
      {bits.map((b, i) => <i key={i} style={{ left: b.left + "vw", background: b.color, animationDuration: b.dur + "s", animationDelay: b.delay + "s" }} />)}
    </div>
  );
}

/* ---------- Майстер (контейнер) ---------- */
export default function SetupWizard({ clinicId, userId, initial }) {
  const router = useRouter();
  const [launched, setLaunched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [valid, setValid] = useState({});
  const [toasts, push] = useToasts();
  const dataRef = useRef(null);

  function report(k, ok) { setValid((v) => (v[k] === ok ? v : { ...v, [k]: ok })); }
  function onData(d) { dataRef.current = d; }

  const STEP = { key: 1, title: "Профіль клініки", desc: "Дані, акаунт, обладнання" };

  async function launch() {
    const d = dataRef.current;
    if (!d || saving) return;
    setSaving(true);
    const clean = (a) => a.map((x) => x.trim()).filter(Boolean);
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

      await supabase.from("rooms").delete().eq("clinic_id", clinicId);
      const rows = d.equip.map((e) => ({
        clinic_id: clinicId,
        name: (e.room || e.type).trim(),
        modality: e.type === "МРТ" ? "MRI" : e.type === "КТ" ? "CT" : "OTHER",
        apparatus_model: e.desc.trim() || null,
        schedule: {
          days: e.days, start: e.start, end: e.end,
          lunch: e.lunch, lunchS: e.lunchS, lunchE: e.lunchE,
          perDay: e.perDay, dayHours: e.dayHours,
        },
      }));
      if (rows.length) {
        const { error: re } = await supabase.from("rooms").insert(rows);
        if (re) throw re;
      }

      setLaunched(true);
      push("🎉 Кабінет активовано!", "success");
    } catch (e) {
      push("Помилка збереження: " + (e?.message || String(e)), "error");
      setSaving(false);
    }
  }

  function saveDraftExit() {
    push("Чернетку збережено — повернетесь будь-коли", "success");
    setTimeout(() => router.push("/queue"), 700);
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
          <div className={"wstep " + (launched ? "done" : "active")}>
            <span className="wstep-num">{launched ? "✓" : STEP.key}</span>
            <span className="wstep-txt">
              <span className="wstep-title">{STEP.title}</span>
              <span className="wstep-desc">{STEP.desc}</span>
            </span>
          </div>
        </div>
        <div className="wiz-foot">
          <div className="wiz-prog-bar"><div className="wiz-prog-fill" style={{ width: (launched ? 100 : 100) + "%" }} /></div>
          <div className="wiz-prog-lab">
            <span>Крок 1 з 1</span>
            <a href="mailto:support@radflow.ua?subject=Допомога%20з%20налаштуванням" title="Написати в підтримку">Підтримка</a>
          </div>
          <a className="wiz-exit" onClick={saveDraftExit} style={{ cursor: "pointer" }} title="Прогрес збережеться, можна продовжити пізніше">⤓ Зберегти чернетку й вийти</a>
          <a className="wiz-exit" onClick={signOut} style={{ cursor: "pointer", marginTop: 6 }} title="Вийти з акаунта">⏻ Вийти з акаунта</a>
        </div>
      </aside>

      <div className="wiz-main">
        <div className="wiz-main-inner">
          {launched ? <LaunchSuccess /> : <StepRegister report={report} onData={onData} initial={initial} />}
        </div>

        {!launched && (
          <div className="wiz-bar">
            <div className="wiz-bar-inner">
              <button className="btn btn-ghost" disabled>← Назад</button>
              <div className="wiz-bar-right">
                <span className="wiz-cta-wrap" title={valid[1] ? undefined : "Заповніть назву клініки, місто, ПІБ і телефон адміністратора та хоча б один апарат"}>
                  <button className="btn btn-green btn-launch" onClick={launch} disabled={!valid[1] || saving}>
                    {saving ? "Зберігаємо…" : "🚀 Запустити кабінет"}
                  </button>
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
      <Toasts toasts={toasts} />
    </div>
  );
}
