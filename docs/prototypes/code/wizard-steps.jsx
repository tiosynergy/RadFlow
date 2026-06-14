/* ===== RadFlow — Setup Wizard step screens ===== */
const { useState: wUseState, useEffect: wUseEffect } = React;

/* ---------- Step 1: Registration ---------- */
function StepRegister() {
  return (
    <div className="fade-in">
      <h1 className="wiz-h">Профіль клініки</h1>
      <p className="wiz-hsub">Базові дані медичного центру та обліковий запис адміністратора. Тут можна вносити зміни та коригування у будь-який час.</p>

      <div className="info-banner" style={{ marginTop: 24 }}>
        <span className="ib-ic" style={{ color: "var(--green)" }}>✓</span>
        <span className="ib-txt"><b>Email підтверджено.</b> Обліковий запис активовано — можна продовжувати налаштування.</span>
      </div>

      <div className="form-card" style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 16 }}>
        <label className="fld">
          <span className="fld-lab">Назва клініки</span>
          <input className="inp" defaultValue="МЦ «Медика»" />
        </label>
        <div className="fld-row">
          <label className="fld"><span className="fld-lab">Місто</span><input className="inp" defaultValue="Київ" /></label>
          <label className="fld"><span className="fld-lab">Телефон</span><input className="inp" defaultValue="+38 044 555 12 00" /></label>
        </div>
        <label className="fld">
          <span className="fld-lab">Email адміністратора</span>
          <input className="inp" defaultValue="o.melnyk@medika.ua" />
        </label>
      </div>
    </div>
  );
}

/* ---------- Step 2: Price list (AI parsing) ---------- */
const PARSED = [
  { name: "МРТ головного мозку без контрасту", dur: 60, price: 2400, conf: "ok" },
  { name: "МРТ головного мозку з контрастом", dur: 75, price: 3600, conf: "ok" },
  { name: "МРТ хребта (1 відділ)", dur: 45, price: 2100, conf: "ok" },
  { name: "МРТ колінного суглоба", dur: 30, price: 1800, conf: "ok" },
  { name: "КТ органів грудної клітки", dur: 20, price: 1500, conf: "ok" },
  { name: "КТ черевної порожнини з контр.", dur: 40, price: 2800, conf: "warn" },
  { name: "КТ голови", dur: 15, price: 1200, conf: "ok" },
  { name: "МРТ органів малого таза", dur: 50, price: 2600, conf: "warn" },
  { name: "КТ нирок та сечовив. шляхів", dur: 25, price: 1700, conf: "ok" },
];
const PROC_STEPS = ["Завантажуємо файл…", "Розпізнаємо структуру…", "Витягуємо послуги…", "Перевіряємо ціни…"];

function StepPriceList({ toast }) {
  const [tab, setTab] = wUseState("file");
  const [phase, setPhase] = wUseState("upload"); // upload | processing | results
  const [status, setStatus] = wUseState(PROC_STEPS[0]);
  const [rows, setRows] = wUseState(PARSED);

  function startParse() {
    setPhase("processing");
    let i = 0;
    setStatus(PROC_STEPS[0]);
    const int = setInterval(() => {
      i++;
      if (i < PROC_STEPS.length) setStatus(PROC_STEPS[i]);
      else { clearInterval(int); setPhase("results"); toast("AI розпізнав 24 послуги · 2 потребують перевірки", "success"); }
    }, 650);
  }

  return (
    <div className="fade-in">
      <h1 className="wiz-h">Завантажте ваш прайс-лист</h1>
      <p className="wiz-hsub">AI автоматично розпізнає назви послуг, тривалість і ціни з вашого файлу. Перевірте та збережіть.</p>

      <div className="seg">
        {[["file","Файл"],["url","URL сайту"],["manual","Вручну"]].map(([k,l]) => (
          <button key={k} className={"seg-tab" + (tab===k?" active":"")} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab === "file" && phase === "upload" && (
        <div className="upload-zone" onClick={startParse}>
          <div className="upload-ic">☁</div>
          <div className="upload-title">Перетягніть файл або натисніть для вибору</div>
          <div className="upload-sub">Excel, Word, PDF · до 10 МБ</div>
          <div className="fmt-tags">{["XLSX","CSV","PDF","DOCX"].map(t => <span key={t} className="fmt-tag">{t}</span>)}</div>
        </div>
      )}
      {tab === "file" && phase === "processing" && (
        <div className="proc-card">
          <div className="spinner"></div>
          <div className="proc-title">🤖 AI аналізує прайс-лист…</div>
          <div className="proc-status">{status}</div>
        </div>
      )}
      {tab === "file" && phase === "results" && (
        <>
          <div className="res-summary">
            <div className="res-count">Результати AI-парсингу <span className="muted">· знайдено {rows.length + 15} послуг</span></div>
            <button className="btn btn-ghost btn-sm" onClick={() => setRows(r => [...r, { name: "Нова послуга", dur: 30, price: 0, conf: "warn" }])}>＋ Додати рядок</button>
          </div>
          <table className="rtable">
            <thead><tr><th>Назва послуги</th><th style={{width:90}}>Хв</th><th style={{width:110}}>Ціна, ₴</th><th style={{width:120}}>AI</th><th style={{width:40}}></th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className={r.conf === "warn" ? "warn" : ""}>
                  <td><input className="rcell" defaultValue={r.name} /></td>
                  <td><input className="rcell tabular" defaultValue={r.dur} /></td>
                  <td><input className="rcell tabular" defaultValue={r.price} /></td>
                  <td>{r.conf === "ok" ? <span className="conf ok">✓ OK</span> : <span className="conf warn">⚠ Перевір</span>}</td>
                  <td><button className="mini-icon" style={{width:28,height:28}} title="Видалити" onClick={() => setRows(rs => rs.filter((_,j) => j!==i))}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {tab === "url" && (
        <div className="form-card" style={{ marginTop: 4 }}>
          <label className="fld"><span className="fld-lab">URL сторінки з прайсом</span>
            <input className="inp" placeholder="https://medika.ua/price" /></label>
          <div className="info-banner" style={{ margin: "16px 0 0" }}>
            <span className="ib-ic">🤖</span>
            <span className="ib-txt">AI відкриє сторінку, знайде таблицю цін і автоматично імпортує послуги.</span>
          </div>
        </div>
      )}
      {tab === "manual" && (
        <div className="proc-card" style={{ padding: "40px 24px" }}>
          <div style={{ fontSize: 30, color: "var(--text-muted)" }}>✎</div>
          <div className="proc-title" style={{ marginTop: 10 }}>Додавання послуг вручну</div>
          <div className="proc-status">Натисніть «Додати рядок», щоб почати заповнення таблиці послуг.</div>
        </div>
      )}

      <div style={{ textAlign: "center", marginTop: 22 }}>
        <a href="#" className="tel" onClick={(e)=>{e.preventDefault(); toast("Можна додати прайс пізніше у Налаштуваннях","info");}} style={{ fontSize: 13 }}>Пропустити — додам пізніше →</a>
      </div>
    </div>
  );
}

/* ---------- Step 3: Equipment ---------- */
function StepEquipment({ toast }) {
  const [list, setList] = wUseState([
    { id: 1, emoji: "🩻", name: "МРТ 1.5T", model: "Siemens Avanto", room: "Кабінет №1", count: 8, blocked: false },
    { id: 2, emoji: "🩻", name: "КТ 64-зрізів", model: "GE Optima", room: "Кабінет №2", count: 4, blocked: false },
    { id: 3, emoji: "🩻", name: "МРТ 3.0T", model: "Philips Ingenia", room: "Кабінет №3", count: 0, blocked: true, reason: "Технічне обслуговування" },
  ]);
  return (
    <div className="fade-in">
      <h1 className="wiz-h">Обладнання та кабінети</h1>
      <p className="wiz-hsub">Додайте апарати МРТ/КТ та призначте їм кабінети. Це визначає доступні слоти для запису.</p>
      <div className="equip-grid" style={{ marginTop: 24 }}>
        {list.map((e) => (
          <div key={e.id} className={"equip-card" + (e.blocked ? " blocked" : "")}>
            <div className="equip-badge">
              {e.blocked ? <span className="badge red">🔒 Заблоковано</span> : <span className="badge green"><span className="bdot"></span>Активний</span>}
            </div>
            <div className={"equip-tile " + (e.name.startsWith("МРТ") ? "mrt" : "ct")}>{e.name.startsWith("МРТ") ? "МРТ" : "КТ"}</div>
            <div className="equip-name">{e.name}</div>
            <div className="equip-model">{e.model}</div>
            <div className="equip-room">⌂ {e.room}</div>
            {e.blocked && <div className="equip-reason">Причина: {e.reason}</div>}
            <div className="equip-foot">
              <span className="equip-count">Записів сьогодні: {e.count}</span>
              {e.blocked
                ? <button className="btn btn-green btn-sm" onClick={() => { setList(l => l.map(x => x.id===e.id?{...x,blocked:false,count:0}:x)); toast("Апарат розблоковано","success"); }}>Розблокувати</button>
                : <button className="btn btn-ghost btn-sm" style={{ color: "var(--red)" }} onClick={() => { setList(l => l.filter(x => x.id!==e.id)); toast("Апарат видалено","warning"); }}>Видалити</button>}
            </div>
          </div>
        ))}
        <button className="equip-card equip-add" onClick={() => { setList(l => [...l, { id: Date.now(), emoji: "🩻", name: "Новий апарат", model: "—", room: "Кабінет №" + (l.length+1), count: 0, blocked: false }]); toast("Апарат додано","success"); }}>
          <span className="plus">＋</span>
          <span>Додати апарат</span>
        </button>
      </div>
    </div>
  );
}

/* ---------- Step 4: Schedule ---------- */
const TEMPLATES = [
  { id: "t1", label: "Пн–Пт 8:00–18:00", days: [1,1,1,1,1,0,0] },
  { id: "t2", label: "Пн–Сб 8:00–20:00", days: [1,1,1,1,1,1,0] },
  { id: "t3", label: "Пн–Нд 9:00–17:00", days: [1,1,1,1,1,1,1] },
];
function StepSchedule() {
  const [tmpl, setTmpl] = wUseState("t1");
  const [days, setDays] = wUseState([1,1,1,1,1,0,0]);
  const dnames = ["Пн","Вт","Ср","Чт","Пт","Сб","Нд"];
  const hours = ["08","09","10","11","12","13","14","15","16","17"];
  function applyTmpl(t) { setTmpl(t.id); setDays(t.days); }
  function toggleDay(i) { setDays(d => d.map((v,j) => j===i ? (v?0:1) : v)); setTmpl(""); }
  return (
    <div className="fade-in">
      <h1 className="wiz-h">Розклад роботи</h1>
      <p className="wiz-hsub">Робочі години та дні центру. Слоти для запису формуються лише в робочий час.</p>

      <div className="sec-label" style={{ marginTop: 22 }}>Шаблон</div>
      <div className="tmpl-pills">
        {TEMPLATES.map(t => <button key={t.id} className={"pill" + (tmpl===t.id?" active":"")} onClick={() => applyTmpl(t)}>{t.label}</button>)}
        <button className={"pill" + (tmpl===""?" active":"")} onClick={() => setTmpl("")}>Власний</button>
      </div>

      <div className="fld-row" style={{ maxWidth: 360, marginBottom: 6 }}>
        <label className="fld"><span className="fld-lab">Початок</span><input className="inp tabular" defaultValue="08:00" /></label>
        <label className="fld"><span className="fld-lab">Кінець</span><input className="inp tabular" defaultValue="18:00" /></label>
      </div>

      <div className="sec-label" style={{ marginTop: 18 }}>Робочі дні</div>
      <div className="day-toggles">
        {dnames.map((d,i) => <button key={d} className={"day-toggle" + (days[i]?" on":"")} onClick={() => toggleDay(i)}>{d}</button>)}
      </div>

      <div className="sched-grid">
        <div className="sched-cell head"></div>
        {dnames.map(d => <div key={d} className="sched-cell head">{d}</div>)}
        {hours.map(h => (
          <React.Fragment key={h}>
            <div className="sched-cell label">{h}:00</div>
            {days.map((on,di) => {
              const lunch = h === "13";
              const cls = !on ? "off" : lunch ? "lunch" : "work";
              return <div key={di} className={"sched-cell " + cls}></div>;
            })}
          </React.Fragment>
        ))}
      </div>
      <div className="sched-legend">
        <span className="lg"><span className="sw" style={{ background: "var(--blue-bg)" }}></span>Робочий час</span>
        <span className="lg"><span className="sw" style={{ background: "var(--gray-badge-bg)" }}></span>Перерва</span>
        <span className="lg"><span className="sw" style={{ background: "var(--bg-elevated)" }}></span>Поза графіком</span>
      </div>
    </div>
  );
}

/* ---------- Step 5: Go Live ---------- */
function StepGoLive({ toast }) {
  const [launched, setLaunched] = wUseState(false);
  const checks = [
    { t: "Прайс-лист", s: "24 послуги збережено", done: true },
    { t: "Обладнання", s: "2 апарати, 2 кабінети", done: true },
    { t: "Розклад", s: "Пн–Пт 8:00–18:00", done: true },
    { t: "Персонал", s: "1 запрошення очікує підтвердження", done: false },
  ];
  function launch() { setLaunched(true); toast("🎉 Кабінет активовано!", "success"); }

  if (launched) {
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
  return (
    <div className="fade-in">
      <h1 className="wiz-h">Готовність до запуску</h1>
      <p className="wiz-hsub">Фінальна перевірка перед активацією кабінету.</p>
      <div className="check-list" style={{ marginTop: 24 }}>
        {checks.map((c) => (
          <div className="check-item" key={c.t}>
            <span className={"check-ic " + (c.done ? "done" : "pending")}>{c.done ? "✓" : "◷"}</span>
            <div className="check-txt"><div className="check-title">{c.t}</div><div className="check-sub">{c.s}</div></div>
            <span className="badge" style={{ background: c.done ? "var(--green-bg)" : "var(--orange-bg)", color: c.done ? "var(--green)" : "var(--orange)" }}>{c.done ? "Готово" : "Очікує"}</span>
          </div>
        ))}
      </div>
      <div className="golive">
        <div className="rocket">🚀</div>
        <div className="golive-h">Ваш кабінет готовий!</div>
        <div className="golive-sub">Можна запускати навіть із незавершеними запрошеннями — їх можна підтвердити пізніше.</div>
        <button className="btn btn-green" style={{ marginTop: 20, padding: "13px 28px", fontSize: 15 }} onClick={launch}>🚀 Запустити кабінет</button>
      </div>
    </div>
  );
}

function Confetti() {
  const colors = ["#0a84ff","#30d158","#ff9f0a","#ff453a","#7b5cff","#ffd60a"];
  const bits = Array.from({ length: 70 }, (_, i) => ({
    left: Math.random()*100, color: colors[i%colors.length],
    delay: Math.random()*0.6, dur: 1.6 + Math.random()*1.4,
  }));
  return (
    <div className="confetti">
      {bits.map((b,i) => <i key={i} style={{ left: b.left+"vw", background: b.color, animationDuration: b.dur+"s", animationDelay: b.delay+"s" }}></i>)}
    </div>
  );
}

Object.assign(window, { StepRegister, StepPriceList, StepEquipment, StepSchedule, StepGoLive });
