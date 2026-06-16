/* ===== RadFlow — Setup Wizard step screens ===== */
const { useState: wUseState, useEffect: wUseEffect } = React;

const Req = () => <span className="req" title="Обов'язкове поле">*</span>;

/* Список телефонів / email-ів: ✕ прибирає рядок, останній — лише очищає (мінімум одне поле) */
function ContactList({ label, items, setItems, type, ph, required }) {
  const noun = type === "email" ? "email" : "телефон";
  const upd = (i, v) => setItems((a) => a.map((x, j) => j === i ? v : x));
  const add = () => setItems((a) => [...a, ""]);
  const del = (i) => setItems((a) => a.length > 1 ? a.filter((_, j) => j !== i) : [""]);
  /* для обов'язкового списку перший рядок підсвічуємо, доки немає жодного значення */
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

/* ---------- Step 1: Registration ---------- */
function StepRegister({ report }) {
  /* Медичний центр */
  const [clinic, setClinic] = wUseState("МЦ «Медика»");
  const [city, setCity] = wUseState("Київ");
  const [address, setAddress] = wUseState("вул. Хрещатик, 22, 01001 Київ");
  const [phones, setPhones] = wUseState(["+38 044 555 12 00"]);
  const [emails, setEmails] = wUseState(["info@medika.ua"]);
  /* Адміністратор */
  const [adminName, setAdminName] = wUseState("Мельник Олена Петрівна");
  const [adminEmail, setAdminEmail] = wUseState("o.melnyk@medika.ua");
  const [aPhones, setAPhones] = wUseState(["+38 067 000 00 00"]);
  const [aEmails, setAEmails] = wUseState(["o.melnyk@gmail.com"]);
  /* розклад за замовчуванням — як у RadFlow: Пн–Пт 8:00–18:00, без перерви.
     perDay=false → один час на всі дні (як зараз). perDay=true → свій час на кожен день.
     dayHours завжди тримає 7 записів (по індексу дня), щоб не губити правки при перемиканні. */
  const DEF_DAY = { start: "08:00", end: "18:00", lunch: false, lunchS: "13:00", lunchE: "14:00" };
  function mkSched() {
    return { days: [1, 1, 1, 1, 1, 0, 0], ...DEF_DAY, perDay: false, dayHours: Array.from({ length: 7 }, () => ({ ...DEF_DAY })) };
  }
  const [equip, setEquip] = wUseState([
    { id: 1, type: "МРТ", desc: "Siemens Avanto 1.5T", room: "Кабінет №1", ...mkSched() },
    { id: 2, type: "КТ", desc: "GE Optima 64-зрізів", room: "Кабінет №2", ...mkSched() },
  ]);

  /* F1 — крок валідний лише коли заповнені обов'язкові поля та є хоча б один апарат */
  wUseEffect(() => {
    const adminPhoneOk = aPhones.some((p) => p.trim() !== "");
    report(1, clinic.trim() !== "" && city.trim() !== "" && adminName.trim() !== "" && adminPhoneOk && equip.length > 0);
  }, [clinic, city, adminName, aPhones, equip]);

  function setEq(i, k, v) { setEquip((a) => a.map((x, j) => j === i ? { ...x, [k]: v } : x)); }
  function toggleEqDay(i, d) { setEquip((a) => a.map((x, j) => j === i ? { ...x, days: x.days.map((v, k) => k === d ? (v ? 0 : 1) : v) } : x)); }
  /* правка часу окремого дня (тільки в режимі perDay) */
  function setEqDay(i, di, k, v) {
    setEquip((a) => a.map((x, j) => j === i ? { ...x, dayHours: x.dayHours.map((dh, k2) => k2 === di ? { ...dh, [k]: v } : dh) } : x));
  }
  /* перемикач «свій час для кожного дня». При вмиканні — засіваємо кожен день спільним часом,
     тож початково час для всіх днів однаковий, як і зараз. */
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
  const EQ_DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];

  return (
    <div className="fade-in">
      <h1 className="wiz-h">Профіль клініки</h1>
      <p className="wiz-hsub">Базові дані центру та обліковий запис адміністратора.</p>

      <div className="info-banner" style={{ marginTop: 16 }}>
        <span className="ib-ic" style={{ color: "var(--green)" }}>✓</span>
        <span className="ib-txt"><b>Email підтверджено.</b> Обліковий запис активовано.</span>
      </div>

      {/* СЕКЦІЯ 1 — Медичний центр (спершу) */}
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

      {/* СЕКЦІЯ 2 — Адміністратор (власні контакти) */}
      <div className="sec-label" style={{ marginTop: 20 }}>Адміністратор</div>
      <div className="form-card reg-card">
        <div className="fld-row">
          <label className="fld">
            <span className="fld-lab">ПІБ адміністратора <Req /></span>
            <input className={"inp" + (adminName.trim() ? "" : " invalid")} placeholder="Прізвище Ім'я По батькові" value={adminName} onChange={(e) => setAdminName(e.target.value)} />
          </label>
          <label className="fld">
            <span className="fld-lab">Email для входу <Req /></span>
            <input className="inp" type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} />
            <span className="fld-hint">Логін · роль: Адміністратор</span>
          </label>
        </div>
        <div className="contacts-grid">
          <ContactList label="Телефони" items={aPhones} setItems={setAPhones} ph="+38 0__ ___ __ __" required />
          <ContactList label="Email-и" items={aEmails} setItems={setAEmails} type="email" ph="name@example.com" />
        </div>
      </div>

      {/* Обладнання та кабінети — у кожного апарата власний розклад роботи */}
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

              {/* Спільний час для всіх днів (за замовчуванням) */}
              {!e.perDay && (<>
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
              </>)}

              {/* Окремий час на кожен робочий день */}
              {e.perDay && (
                <div className="eq-perday-list">
                  {e.days.some((d) => d) ? EQ_DAYS.map((d, di) => e.days[di] ? (
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
                  ) : null) : (
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

/* ---------- Launch success screen ---------- */
function LaunchSuccess() {
  return (
    <div className="fade-in">
      <Confetti />
      <div className="golive">
        <div className="rocket">🎉</div>
        <div className="golive-h" style={{ color: "var(--green)" }}>Кабінет активовано!</div>
        <div className="golive-sub">RadFlow готовий приймати записи. Realtime-синхронізація увімкнена для всіх ролей.</div>
        <a href="radflow-queue-board.html" className="btn btn-green" style={{ marginTop: 22, display: "inline-flex" }}>Перейти до Дошки черги →</a>
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
      {bits.map((b, i) => <i key={i} style={{ left: b.left + "vw", background: b.color, animationDuration: b.dur + "s", animationDelay: b.delay + "s" }}></i>)}
    </div>
  );
}

Object.assign(window, { StepRegister, LaunchSuccess });
