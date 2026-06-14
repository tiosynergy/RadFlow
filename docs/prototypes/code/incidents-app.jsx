/* ===== RadFlow — Incident Management ===== */
const { useState, useMemo } = React;

const EQUIPMENT = [
  { id: "mrt15", kind: "МРТ", name: "МРТ 1.5T", model: "Siemens Avanto", room: "Кабінет №1", count: 8, blocked: false },
  { id: "ct64",  kind: "КТ",  name: "КТ 64-зрізів", model: "GE Optima", room: "Кабінет №2", count: 4, blocked: false },
  { id: "mrt30", kind: "МРТ", name: "МРТ 3.0T", model: "Philips Ingenia", room: "Кабінет №3", count: 0, blocked: true, reason: "Технічне обслуговування" },
];

const AFFECTED = [
  { time: "11:30", name: "Сидоренко Наталія Володимирівна", proc: "МРТ плечового суглоба" },
  { time: "12:45", name: "Кравчук Дмитро Олександрович", proc: "МРТ черевної порожнини" },
  { time: "14:10", name: "Савченко Богдан Юрійович", proc: "МРТ головного мозку" },
  { time: "15:30", name: "Захарченко Артем Ігорович", proc: "МРТ колінного суглоба" },
];

const LOG = [
  { color: "red",    time: "30 травня, 09:42", title: "Заблоковано МРТ 3.0T (Кабінет №3)", sub: "Причина: Технічне обслуговування · Адміністратор: Оксана Мельник" },
  { color: "orange", time: "30 травня, 09:43", title: "Масове перенесення — 6 записів", sub: "Smart Scheduler перерозподілив пацієнтів на Кабінет №1 · 0 конфліктів" },
  { color: "yellow", time: "30 травня, 10:05", title: "Неявка — Шевченко Людмила", sub: "МРТ головного мозку з контрастом · слот звільнено" },
  { color: "green",  time: "29 травня, 17:20", title: "Розблоковано КТ 64-зрізів (Кабінет №2)", sub: "ТО завершено · апарат повернуто в роботу" },
  { color: "blue",   time: "29 травня, 14:10", title: "Колл-лист WF-05 сформовано", sub: "12 записів на 30 травня · надіслано адміністратору" },
];

/* ---------- Tab 1: Block equipment ---------- */
function TabBlock({ toast }) {
  const [equip, setEquip] = useState(EQUIPMENT.map((e) => ({ ...e })));
  const [blocking, setBlocking] = useState(null); // equipment being blocked
  const [success, setSuccess] = useState(null);

  function confirmBlock(e, mode) {
    setEquip((l) => l.map((x) => x.id === e.id ? { ...x, blocked: true, count: 0, reason: "Технічна несправність" } : x));
    setBlocking(null);
    setSuccess({ count: AFFECTED.length, mode });
    toast(`${e.name} заблоковано · Smart Scheduler запущено`, "warning");
  }

  return (
    <div className="fade-in">
      <div className="info-banner orange">
        <span className="ib-ic">⚠</span>
        <span className="ib-txt">Блокування апарату призупиняє нові записи та запускає процес автоматичного перерозподілу пацієнтів.</span>
      </div>
      <div className="sec-label">Оберіть апарат для блокування:</div>
      <div className="equip-grid">
        {equip.map((e) => (
          <div key={e.id} className={"equip-card" + (e.blocked ? " blocked" : " selectable")}
            onClick={() => !e.blocked && setBlocking(e)}>
            <div className="equip-badge">
              {e.blocked ? <span className="badge red">🔒 Заблоковано</span> : <span className="badge green"><span className="bdot"></span>Активний</span>}
            </div>
            <div className={"equip-tile " + (e.kind === "МРТ" ? "mrt" : "ct")}>{e.kind}</div>
            <div className="equip-name">{e.name}</div>
            <div className="equip-model">{e.model}</div>
            <div className="equip-room">⌂ {e.room}</div>
            {e.blocked && <div className="equip-reason">Причина: {e.reason}</div>}
            <div className="equip-foot">
              <span className="equip-count">Записів сьогодні: {e.count}</span>
              {e.blocked
                ? <button className="btn btn-green btn-sm" onClick={(ev) => { ev.stopPropagation(); setEquip(l => l.map(x => x.id===e.id?{...x,blocked:false}:x)); toast("Апарат розблоковано","success"); }}>Розблокувати</button>
                : <span className="badge orange" style={{ background: "transparent", color: "var(--text-faint)" }}>Натисніть, щоб заблокувати →</span>}
            </div>
          </div>
        ))}
      </div>
      {blocking && <BlockModal equip={blocking} onClose={() => setBlocking(null)} onConfirm={confirmBlock} />}
      {success && <SchedulerSuccessModal info={success} onClose={() => setSuccess(null)} />}
    </div>
  );
}

function BlockModal({ equip, onClose, onConfirm }) {
  const [reason, setReason] = useState("tech");
  const [mode, setMode] = useState("auto");
  const reasons = [
    { k: "tech", emoji: "🔧", t: "Технічна несправність" },
    { k: "maint", emoji: "⚙️", t: "Планове ТО" },
    { k: "other", emoji: "📝", t: "Інше" },
  ];
  return (
    <div className="overlay" onMouseDown={(e) => e.target.classList.contains("overlay") && onClose()}>
      <div className="dialog fade-in" style={{ maxWidth: 560 }}>
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic" style={{ background: "var(--red-bg)", color: "var(--red)" }}>🔒</span>Блокування апарату</div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="dlg-body">
          <div className="ctx-hint red" style={{ fontSize: 13 }}>⚠ Нові записи на <b>{equip.name} — {equip.model} ({equip.room})</b> будуть заблоковані. Існуючі записи потребуватимуть перерозподілу.</div>

          <div className="fld">
            <span className="fld-lab">Причина блокування</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              {reasons.map((r) => (
                <button key={r.k} className={"res-opt" + (reason === r.k ? " sel red" : "")} onClick={() => setReason(r.k)} style={{ padding: "11px 13px" }}>
                  <span className="res-ic" style={{ width: 34, height: 34, fontSize: 16, background: "var(--card-2)" }}>{r.emoji}</span>
                  <span className="res-txt"><span className="res-title" style={{ fontSize: 14 }}>{r.t}</span></span>
                  <span className={"res-radio" + (reason === r.k ? " on red" : "")}></span>
                </button>
              ))}
            </div>
          </div>

          <div className="fld-row">
            <label className="fld"><span className="fld-lab">Заблокувати з</span><input className="inp tabular" defaultValue="30.05.2026 09:42" /></label>
            <label className="fld" style={{ maxWidth: 170 }}><span className="fld-lab">Тривалість</span>
              <select className="inp"><option>До розблокування</option><option>2 години</option><option>1 день</option></select></label>
          </div>

          <div className="fld">
            <span className="fld-lab">Записи, що потребують перенесення ({AFFECTED.length})</span>
            <div className="affected-list" style={{ maxHeight: 150, marginTop: 0 }}>
              {AFFECTED.map((a, i) => (
                <div className="affected-row" key={i}>
                  <span className="at">{a.time}</span><span className="an">{a.name}</span>
                  <span className="as" style={{ color: "var(--orange)" }}>Потребує перенесення</span>
                </div>
              ))}
            </div>
          </div>

          <div className="fld">
            <span className="fld-lab">Перерозподіл</span>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <button className={"res-opt" + (mode === "auto" ? " sel red" : "")} onClick={() => setMode("auto")} style={{ flexDirection: "column", alignItems: "flex-start", gap: 6, padding: "13px" }}>
                <span style={{ fontSize: 18 }}>🤖</span>
                <span className="res-title" style={{ fontSize: 13.5 }}>Автоматично</span>
                <span className="res-sub">Smart Scheduler</span>
              </button>
              <button className={"res-opt" + (mode === "manual" ? " sel red" : "")} onClick={() => setMode("manual")} style={{ flexDirection: "column", alignItems: "flex-start", gap: 6, padding: "13px" }}>
                <span style={{ fontSize: 18 }}>✋</span>
                <span className="res-title" style={{ fontSize: 13.5 }}>Вручну</span>
                <span className="res-sub">Ви обираєте слоти</span>
              </button>
            </div>
          </div>
        </div>
        <div className="dlg-foot">
          <button className="btn btn-ghost" onClick={onClose}>Скасувати</button>
          <button className="btn btn-danger" onClick={() => onConfirm(equip, mode)}>🔒 Заблокувати апарат</button>
        </div>
      </div>
    </div>
  );
}

function SchedulerSuccessModal({ info, onClose }) {
  return (
    <div className="overlay" onMouseDown={(e) => e.target.classList.contains("overlay") && onClose()}>
      <div className="dialog fade-in" style={{ maxWidth: 440, textAlign: "center" }}>
        <div className="dlg-body" style={{ padding: "32px 26px 22px", gap: 16 }}>
          <div style={{ fontSize: 46 }}>⚡</div>
          <div style={{ fontSize: 19, fontWeight: 700 }}>Smart Scheduler перерозподілив записи</div>
          <div style={{ fontSize: 13.5, color: "var(--text-secondary)" }}>{info.count} записів автоматично перенесено на Кабінет №1 (МРТ 1.5T).</div>
          <div className="summary-box" style={{ textAlign: "left" }}>
            <div className="summary-row"><span className="sk">Перенесено автоматично</span><span className="sv" style={{ color: "var(--green)" }}>{info.count} ✓</span></div>
            <div className="summary-row"><span className="sk">Потребують уваги</span><span className="sv">0</span></div>
            <div className="summary-row"><span className="sk">Realtime-оновлення</span><span className="sv" style={{ color: "var(--green)" }}>✓ надіслано</span></div>
          </div>
          <div className="info-banner" style={{ margin: 0, textAlign: "left" }}>
            <span className="ib-ic" style={{ color: "var(--green)" }}>✓</span>
            <span className="ib-txt">Усі ролі (Admin, Radiologist, CEO, Лікар) отримали Realtime-push.</span>
          </div>
        </div>
        <div className="dlg-foot" style={{ justifyContent: "center" }}>
          <a href="radflow-queue-board.html" className="btn btn-green" style={{ minWidth: 220, justifyContent: "center" }}>Повернутися до Дошки черги</a>
        </div>
      </div>
    </div>
  );
}

/* ---------- Tab 2: Mass reschedule ---------- */
function TabReschedule({ toast }) {
  const [src, setSrc] = useState("");
  const [tgt, setTgt] = useState("");
  const ready = src && tgt;
  const rows = [
    { time: "11:30", name: "Сидоренко Наталія", proc: "МРТ плечового суглоба", ok: true },
    { time: "12:45", name: "Кравчук Дмитро", proc: "МРТ черевної порожнини", ok: true },
    { time: "14:10", name: "Савченко Богдан", proc: "МРТ головного мозку", ok: true },
    { time: "15:30", name: "Захарченко Артем", proc: "МРТ колінного суглоба", ok: false },
    { time: "16:00", name: "Поліщук Вікторія", proc: "КТ нирок", ok: true },
    { time: "16:45", name: "Мельник Олена", proc: "КТ грудної клітки", ok: false },
  ];
  const conflicts = rows.filter((r) => !r.ok).length;

  return (
    <div className="fade-in">
      <div className="info-banner">
        <span className="ib-ic">🤖</span>
        <span className="ib-txt"><b>Smart Scheduler:</b> оберіть день-джерело та день-ціль — система автоматично підбере вільні слоти й позначить конфлікти.</span>
      </div>
      <div className="form-card">
        <div className="fld-row">
          <label className="fld"><span className="fld-lab">День-джерело (звідки)</span>
            <input className="inp" type="date" value={src} onChange={(e) => setSrc(e.target.value)} /></label>
          <label className="fld"><span className="fld-lab">День-ціль (куди)</span>
            <input className="inp" type="date" value={tgt} onChange={(e) => setTgt(e.target.value)} /></label>
        </div>
        <div className="fld-row" style={{ marginTop: 14 }}>
          <label className="fld"><span className="fld-lab">Кабінет</span>
            <select className="inp"><option>Усі кабінети</option><option>Кабінет №1 — МРТ</option><option>Кабінет №2 — КТ</option></select></label>
          <label className="fld"><span className="fld-lab">Причина</span>
            <select className="inp"><option>Блокування обладнання</option><option>Святковий день</option><option>Інше</option></select></label>
        </div>
      </div>

      {ready && (
        <div className="fade-in" style={{ marginTop: 20 }}>
          <div className="summary-box">
            <div className="summary-row"><span className="sk">З дня → На день</span><span className="sv tabular">{src} → {tgt}</span></div>
            <div className="summary-row"><span className="sk">Записів для перенесення</span><span className="sv" style={{ color: "var(--orange)" }}>{rows.length}</span></div>
            <div className="summary-row"><span className="sk">Конфліктних слотів</span><span className="sv" style={{ color: conflicts ? "var(--red)" : "var(--green)" }}>{conflicts}</span></div>
            <div className="summary-row"><span className="sk">Автоматично перенесе</span><span className="sv" style={{ color: "var(--green)" }}>{rows.length - conflicts}</span></div>
          </div>
          <div className="affected-list">
            {rows.map((r, i) => (
              <div className="affected-row" key={i}>
                <span className="at">{r.time}</span>
                <span className="an">{r.name} · <span style={{ color: "var(--text-muted)" }}>{r.proc}</span></span>
                <span className={"as " + (r.ok ? "ok" : "conflict")}>{r.ok ? "✓ Вільний слот" : "⚠️ Конфлікт"}</span>
              </div>
            ))}
          </div>
          {conflicts > 0 && (
            <div className="info-banner orange" style={{ marginTop: 14 }}>
              <span className="ib-ic">⚠</span>
              <span className="ib-txt">{conflicts} записи не вміщуються в обраний день. Їх буде виділено у список «Потребують уваги».</span>
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 }}>
            <button className="btn btn-ghost" onClick={() => { setSrc(""); setTgt(""); }}>Скинути</button>
            <button className="btn btn-danger" onClick={() => toast(`Перенесено ${rows.length - conflicts} записів · ${conflicts} у списку «Потребують уваги»`, "warning")}>Перенести всі записи</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- Tab 3: Incident log ---------- */
function TabLog() {
  return (
    <div className="fade-in">
      <div className="timeline">
        {LOG.map((e, i) => (
          <div className="tl-item" key={i}>
            <span className={"tl-dot " + e.color}></span>
            <div className="tl-time">{e.time}</div>
            <div className="tl-title">{e.title}</div>
            <div className="tl-sub">{e.sub}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- App ---------- */
function IncApp() {
  const [tab, setTab] = useState("block");
  const [toasts, push] = useToasts();
  const tabs = [
    { k: "block", label: "🔒 Блокування обладнання" },
    { k: "resched", label: "📅 Масове перенесення" },
    { k: "log", label: "🕐 Журнал інцидентів" },
  ];
  return (
    <div className="app">
      <Sidebar active="incidents" />
      <div className="main">
        <PageTopBar
          icon="⚠" title="Управління інцидентами"
          subtitle="Блокування обладнання · Масове перенесення · Неявки"
          actions={<a href="radflow-queue-board.html" className="btn btn-secondary">← До Дошки черги</a>}
        />
        <div className="content-full">
          <div className="page-max">
            <div className="page-tabs">
              {tabs.map((t) => (
                <button key={t.k} className={"page-tab" + (tab === t.k ? " active" : "")} onClick={() => setTab(t.k)}>{t.label}</button>
              ))}
            </div>
            {tab === "block" && <TabBlock toast={push} />}
            {tab === "resched" && <TabReschedule toast={push} />}
            {tab === "log" && <TabLog />}
          </div>
        </div>
      </div>
      <Toasts toasts={toasts} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<IncApp />);
