/* ===== RadFlow — Incident Management ===== */
const { useState, useMemo, useEffect } = React;

/* Обладнання = реальні кабінети RadFlow (RF_ROOMS). Стан «заблоковано»
   більше НЕ хардкодиться — він похідний від активного інциденту (rf_incident_v1),
   тож за замовчуванням жоден апарат не заблоковано. */
const RF_DAY_END_MIN = 17 * 60 + 30;
function incNowMin() {
  const n = new Date(); let m = Math.round((n.getHours() * 60 + n.getMinutes()) / 5) * 5;
  if (m < 8 * 60) m = 8 * 60; if (m > RF_DAY_END_MIN) m = RF_DAY_END_MIN; return m;
}
function incDateVal(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

const LOG = [
  { color: "red",    time: "30 травня, 09:42", title: "Заблоковано МРТ 3.0T (Кабінет №3)", sub: "Причина: Технічне обслуговування · Адміністратор: Оксана Мельник" },
  { color: "orange", time: "30 травня, 09:43", title: "Масове перенесення — 6 записів", sub: "Smart Scheduler перерозподілив пацієнтів на Кабінет №1 · 0 конфліктів" },
  { color: "yellow", time: "30 травня, 10:05", title: "Неявка — Шевченко Людмила", sub: "МРТ головного мозку з контрастом · слот звільнено" },
  { color: "green",  time: "29 травня, 17:20", title: "Розблоковано КТ 64-зрізів (Кабінет №2)", sub: "ТО завершено · апарат повернуто в роботу" },
  { color: "blue",   time: "29 травня, 14:10", title: "Колл-лист WF-05 сформовано", sub: "12 записів на 30 травня · надіслано адміністратору" },
];

/* ---------- Tab 1: Block equipment (єдине джерело — rf_incident_v1) ---------- */
function useIncidents() {
  const [list, setList] = useState(() => (window.getIncidents ? window.getIncidents() : []));
  useEffect(() => {
    function refresh(e) { if (e && e.type === "storage" && e.key && e.key !== window.RF_INC_KEY) return; setList(window.getIncidents ? window.getIncidents() : []); }
    window.addEventListener("storage", refresh);
    window.addEventListener("rf-incident-sync", refresh);
    return () => { window.removeEventListener("storage", refresh); window.removeEventListener("rf-incident-sync", refresh); };
  }, []);
  return [list, setList];
}

function TabBlock({ toast }) {
  const rooms = window.RF_ROOMS || {};
  const roomKeys = Object.keys(rooms);
  const [incList] = useIncidents();
  const [blocking, setBlocking] = useState(null); // { roomKey } або { existing }
  const [success, setSuccess] = useState(null);

  // активна черга сьогодні — для підрахунку записів на апарат
  const queue = (window.getQueuePatients ? window.getQueuePatients() : (window.RF_PATIENTS || []));
  const activeCount = (rk) => queue.filter((p) => p.room === rk && p.status !== "done" && p.status !== "noshow").length;
  const incFor = (rk) => incList.filter((i) => i.roomKey === rk)[0] || null;

  // Модалка передає вже зібраний інцидент (rfBuildIncident: сьогодні + наперед).
  function confirmBlock(incident, isEdit) {
    window.upsertIncident(incident);
    setBlocking(null);
    if (isEdit) {
      toast(`Інцидент оновлено · ${incident.machineName} · ${window.rfIncPending(incident)} на обдзвін`, "info");
    } else {
      setSuccess(incident);
      toast(`${incident.machineName} заблоковано · колл-лист: ${incident.patients.length} на обдзвін`, "warning");
    }
  }
  function unblock(roomKey) { if (window.removeIncident) window.removeIncident(roomKey); toast(`${(rooms[roomKey] || {}).name || "Апарат"} розблоковано · інцидент завершено`, "success"); }

  return (
    <div className="fade-in">
      <div className="info-banner orange">
        <span className="ib-ic">⚠</span>
        <span className="ib-txt">Блокування апарату призупиняє нові записи та автоматично формує колл-лист пацієнтів із простою для перезапису. Можна заблокувати кілька апаратів одночасно.</span>
      </div>

      {incList.map((inc) => (
        <div className="active-inc" key={inc.roomKey}>
          <div className="active-inc-head">
            <span className="badge red">🔒 {inc.machineName} заблоковано</span>
            <span className="active-inc-meta">{inc.reasonLabel} · простій {inc.windowLabel || (inc.fromLabel + "–" + inc.toLabel)}</span>
            <button className="btn btn-secondary btn-sm" style={{ marginLeft: "auto" }} onClick={() => setBlocking({ existing: inc })}>✏ Редагувати</button>
            <button className="btn btn-green btn-sm" onClick={() => unblock(inc.roomKey)}>🔓 Розблокувати</button>
          </div>
          <div className="sec-label" style={{ marginTop: 4 }}>На обдзвін для перезапису: {window.rfIncPending(inc)} із {inc.patients.length}</div>
          <div className="affected-list" style={{ maxHeight: 200, marginTop: 0 }}>
            {inc.patients.length === 0
              ? <div className="affected-row"><span className="an">У періоді простою активних записів не було</span></div>
              : inc.patients.map((p) => {
                  const m = (window.RF_INC_STATUS || {})[p.callStatus || "pending"] || { label: "" };
                  return (
                    <div className="affected-row" key={p.id}>
                      <span className="at">{!p.isToday && <span className="bd-aff-day">{p.dayLabel}</span>}{p.time}</span><span className="an">{p.name} · <span style={{ color: "var(--text-muted)" }}>{p.proc}</span></span>
                      <span className="as" style={{ color: p.callStatus === "rescheduled" ? "var(--green)" : p.callStatus === "refused" ? "var(--red)" : "var(--orange)" }}>{m.label}</span>
                    </div>
                  );
                })}
          </div>
          <a href="radflow-call-list.html" className="btn btn-secondary btn-sm" style={{ marginTop: 10 }}>Відкрити колл-лист →</a>
        </div>
      ))}

      <div className="sec-label">{incList.length ? "Заблокувати ще апарат:" : "Оберіть апарат для блокування:"}</div>
      <div className="equip-grid">
        {roomKeys.map((k) => {
          const r = rooms[k];
          const inc = incFor(k);
          const blocked = !!inc;
          return (
            <div key={k} className={"equip-card" + (blocked ? " blocked" : " selectable")}
              onClick={() => !blocked && setBlocking({ roomKey: k })}>
              <div className="equip-badge">
                {blocked ? <span className="badge red">🔒 Заблоковано</span> : <span className="badge green"><span className="bdot"></span>Активний</span>}
              </div>
              <div className={"equip-tile " + (r.kind === "МРТ" ? "mrt" : "ct")}>{r.kind}</div>
              <div className="equip-name">{r.name}</div>
              <div className="equip-model">{r.model}</div>
              {blocked && <div className="equip-reason">Причина: {inc.reasonLabel}</div>}
              <div className="equip-foot">
                <span className="equip-count">Активних записів: {blocked ? 0 : activeCount(k)}</span>
                {blocked
                  ? <button className="btn btn-green btn-sm" onClick={(ev) => { ev.stopPropagation(); unblock(k); }}>Розблокувати</button>
                  : <span className="badge orange" style={{ background: "transparent", color: "var(--text-faint)" }}>Натисніть, щоб заблокувати →</span>}
              </div>
            </div>
          );
        })}
      </div>
      {blocking && <BlockModal init={blocking} onClose={() => setBlocking(null)} onConfirm={(incident) => confirmBlock(incident, !!blocking.existing)} />}
      {success && <SchedulerSuccessModal incident={success} onClose={() => setSuccess(null)} />}
    </div>
  );
}

function BlockModal({ init, onClose, onConfirm }) {
  const rooms = window.RF_ROOMS;
  const roomKeys = Object.keys(rooms);
  const ed = (init && init.existing) ? init.existing : null;
  const reasons = [
    { k: "tech", emoji: "🔧", t: "Поломка обладнання", label: "Поломка обладнання", rk: "breakdown" },
    { k: "maint", emoji: "⚙️", t: "Планове ТО", label: "Планове ТО", rk: "maintenance" },
    { k: "other", emoji: "📝", t: "Інше", label: "Інше", rk: "other" },
  ];
  const RKMAP = { breakdown: "tech", maintenance: "maint", other: "other" };
  const [roomKey, setRoomKey] = useState(ed ? ed.roomKey : ((init && init.roomKey) || roomKeys[0]));
  const [reason, setReason] = useState(ed ? (RKMAP[ed.reason] || "tech") : "tech");
  const [durKey, setDurKey] = useState(ed ? ed.durKey : "");
  const [startTime, setStartTime] = useState(ed ? ed.fromLabel : window.rfMinToTime(incNowMin()));
  const [restoreDate, setRestoreDate] = useState(ed && ed.restoreDate ? ed.restoreDate : incDateVal(window.rfAddDays(window.rfToday(), 1)));
  const reasonObj = reasons.find((r) => r.k === reason);
  const room = rooms[roomKey];
  const fromMin = window.rfTimeToMin(startTime);
  const minRestore = incDateVal(window.rfAddDays(window.rfToday(), 1));
  const DURATIONS = [
    { k: "1h", label: "1 година" }, { k: "2h", label: "2 години" }, { k: "4h", label: "4 години" },
    { k: "eod", label: "До кінця дня" }, { k: "restore", label: "До відновлення" },
  ];
  const inc = useMemo(
    () => (durKey ? window.rfBuildIncident(roomKey, reasonObj.rk, reasonObj.label, fromMin, durKey, restoreDate) : null),
    [roomKey, reason, durKey, fromMin, restoreDate]
  );
  const affected = inc ? inc.patients : [];
  const todayCount = affected.filter((p) => p.isToday).length;
  const futureCount = affected.length - todayCount;
  const valid = roomKey && durKey && (durKey !== "restore" || restoreDate);

  function confirm() {
    let built = window.rfBuildIncident(roomKey, reasonObj.rk, reasonObj.label, fromMin, durKey, restoreDate);
    if (ed) built = window.rfMergeIncidentStatuses(built, ed);
    onConfirm(built);
  }

  return (
    <div className="overlay">
      <div className="dialog fade-in" style={{ maxWidth: 600 }}>
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic" style={{ background: "var(--red-bg)", color: "var(--red)" }}>🔒</span>{ed ? "Редагувати інцидент" : "Блокування апарату"}</div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="dlg-body">
          <div className="ctx-hint red" style={{ fontSize: 13 }}>⚠ Нові записи на <b>{room.name} — {room.model}</b> буде призупинено. Пацієнти з простою автоматично потраплять у колл-лист на перезапис{ed ? " (статуси вже обдзвонених зберігаються)" : ""}.</div>

          <div className="fld">
            <span className="fld-lab">Апарат *</span>
            <div className="bd-rooms">
              {roomKeys.map((k) => {
                const r = rooms[k];
                return (
                  <button key={k} className={"bd-room" + (roomKey === k ? " active" : "")} onClick={() => setRoomKey(k)} title={r.name + " · " + r.model}>
                    <span className={"bd-room-kind " + (r.kind === "МРТ" ? "mrt" : "ct")}>{r.kind}</span>
                    <span className="bd-room-meta"><span className="bd-room-name">{r.name}</span><span className="bd-room-model">{r.model}</span></span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="fld">
            <span className="fld-lab">Причина блокування *</span>
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
            <label className="fld" style={{ maxWidth: 160 }}><span className="fld-lab">Початок простою</span>
              <input className="inp tabular" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} /></label>
            <div className="fld"><span className="fld-lab">Тривалість простою *</span>
              <div className="bd-durs">
                {DURATIONS.map((d) => (
                  <button key={d.k} className={"bd-chip" + (durKey === d.k ? " active" : "")} onClick={() => setDurKey(d.k)}>{d.label}</button>
                ))}
              </div>
            </div>
          </div>

          {durKey === "restore" && (
            <label className="fld">
              <span className="fld-lab">Очікувана дата відновлення * <span style={{ color: "var(--text-faint)", fontWeight: 400 }}>— записи наперед до цієї дати теж підуть на обдзвін</span></span>
              <input className="inp tabular" type="date" min={minRestore} value={restoreDate} onChange={(e) => setRestoreDate(e.target.value)} style={{ maxWidth: 200 }} />
            </label>
          )}

          <div className="fld">
            <span className="fld-lab">{durKey
              ? (durKey === "restore"
                  ? `На обдзвін: ${todayCount} сьогодні${futureCount ? " + " + futureCount + " наперед" : ""} = ${affected.length}`
                  : (inc.openEnded ? `Записи на апараті — усі незавершені (${affected.length})` : `Записи у вікні ${inc.fromLabel}–${inc.toLabel} (${affected.length})`))
              : "Оберіть тривалість, щоб побачити постраждалих"}</span>
            {durKey && (
              <div className="affected-list" style={{ maxHeight: 180, marginTop: 0 }}>
                {affected.length === 0
                  ? <div className="affected-row"><span className="an" style={{ color: "var(--green)" }}>✓ Активних записів немає</span></div>
                  : affected.map((a) => (
                      <div className="affected-row" key={a.id}>
                        <span className="at">{!a.isToday && <span className="bd-aff-day">{a.dayLabel}</span>}{a.time}</span><span className="an">{a.name} · <span style={{ color: "var(--text-muted)" }}>{a.proc}</span></span>
                        <span className="as" style={{ color: "var(--orange)" }}>→ обдзвін</span>
                      </div>
                    ))}
              </div>
            )}
          </div>
        </div>
        <div className="dlg-foot">
          <button className="btn btn-ghost" onClick={onClose}>Скасувати</button>
          <button className="btn btn-danger" disabled={!valid} onClick={confirm}>{ed ? "💾 Зберегти зміни" : "🔒 Заблокувати та сформувати обдзвін"}</button>
        </div>
      </div>
    </div>
  );
}

function SchedulerSuccessModal({ incident, onClose }) {
  const n = incident.patients.length;
  return (
    <div className="overlay">
      <div className="dialog fade-in" style={{ maxWidth: 440, textAlign: "center" }}>
        <div className="dlg-body" style={{ padding: "32px 26px 22px", gap: 16 }}>
          <div style={{ fontSize: 46 }}>🔧</div>
          <div style={{ fontSize: 19, fontWeight: 700 }}>{incident.machineName} заблоковано</div>
          <div style={{ fontSize: 13.5, color: "var(--text-secondary)" }}>{incident.reasonLabel} · простій {incident.windowLabel || (incident.fromLabel + "–" + incident.toLabel)}</div>
          <div className="summary-box" style={{ textAlign: "left" }}>
            <div className="summary-row"><span className="sk">Записів у вікні простою</span><span className="sv">{n}</span></div>
            <div className="summary-row"><span className="sk">Сформовано колл-лист</span><span className="sv" style={{ color: "var(--orange)" }}>{n} на обдзвін</span></div>
            <div className="summary-row"><span className="sk">Realtime-оновлення</span><span className="sv" style={{ color: "var(--green)" }}>✓ надіслано</span></div>
          </div>
          <div className="info-banner" style={{ margin: 0, textAlign: "left" }}>
            <span className="ib-ic" style={{ color: "var(--green)" }}>✓</span>
            <span className="ib-txt">Дошка черги, колл-лист і всі ролі отримали Realtime-оновлення.</span>
          </div>
        </div>
        <div className="dlg-foot" style={{ justifyContent: "center", gap: 10 }}>
          <a href="radflow-call-list.html" className="btn btn-secondary">☎ До колл-листа</a>
          <a href="radflow-queue-board.html" className="btn btn-green" style={{ justifyContent: "center" }}>До Дошки черги →</a>
        </div>
      </div>
    </div>
  );
}

/* ---------- Tab 2: Mass reschedule ---------- */
const RESCHED_ROWS = [
  { id: "rs1", time: "11:30", name: "Сидоренко Наталія", proc: "МРТ плечового суглоба", ok: true },
  { id: "rs2", time: "12:45", name: "Кравчук Дмитро", proc: "МРТ черевної порожнини", ok: true },
  { id: "rs3", time: "14:10", name: "Савченко Богдан", proc: "МРТ головного мозку", ok: true },
  { id: "rs4", time: "15:30", name: "Захарченко Артем", proc: "МРТ колінного суглоба", ok: false },
  { id: "rs5", time: "16:00", name: "Поліщук Вікторія", proc: "КТ нирок", ok: true },
  { id: "rs6", time: "16:45", name: "Мельник Олена", proc: "КТ грудної клітки", ok: false },
];

function TabReschedule({ toast }) {
  const [src, setSrc] = useState("");
  const [tgt, setTgt] = useState("");
  const ready = src && tgt;
  const rows = RESCHED_ROWS;
  /* К-02: вирішення конфлікту ПРЯМО тут — підбираємо слот вручну, не йдучи нікуди.
     resolved[id] = { roomName, date, time } для тих, кому вже підібрали слот. */
  const [resolved, setResolved] = useState({});
  const [resched, setResched] = useState(null); // конфліктний рядок, якому підбираємо слот
  const [done, setDone] = useState(false);

  const conflictRows = rows.filter((r) => !r.ok);
  const openConflicts = conflictRows.filter((r) => !resolved[r.id]).length;
  const autoCount = rows.length - conflictRows.length;

  function resolveSlot(row, slot) {
    setResolved((m) => ({ ...m, [row.id]: { roomName: slot.roomName, date: slot.date, time: slot.time, dur: slot.dur } }));
    if (window.addBookingRecord) window.addBookingRecord({ id: Date.now(), date: slot.date, time: slot.time, name: row.name, age: 40, phone: "", proc: row.proc, dur: slot.dur, room: slot.roomKey, status: "queued", call: "pending" });
    setResched(null);
    toast(`${row.name.split(" ").slice(0, 2).join(" ")} — слот підібрано: ${slot.roomName} · ${slot.date} ${slot.time}`, "success");
  }

  function reset() { setSrc(""); setTgt(""); setResolved({}); setDone(false); }

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
            <div className="summary-row"><span className="sk">Конфліктних слотів</span><span className="sv" style={{ color: openConflicts ? "var(--red)" : "var(--green)" }}>{openConflicts}</span></div>
            <div className="summary-row"><span className="sk">Автоматично перенесе</span><span className="sv" style={{ color: "var(--green)" }}>{autoCount + (conflictRows.length - openConflicts)}</span></div>
          </div>
          <div className="affected-list">
            {rows.map((r) => {
              const fixed = resolved[r.id];
              return (
                <div className="affected-row" key={r.id} style={!r.ok && !fixed ? { background: "var(--red-bg)" } : null}>
                  <span className="at">{r.time}</span>
                  <span className="an">{r.name} · <span style={{ color: "var(--text-muted)" }}>{r.proc}</span></span>
                  {r.ok ? (
                    <span className="as ok">✓ Вільний слот</span>
                  ) : fixed ? (
                    <span className="as ok" title={fixed.roomName + " · " + fixed.date + " " + fixed.time}>✓ Слот підібрано · {fixed.time}</span>
                  ) : (
                    <button className="btn btn-primary btn-sm" style={{ flexShrink: 0 }} onClick={() => setResched(r)}>🗓 Підібрати слот вручну</button>
                  )}
                </div>
              );
            })}
          </div>
          {openConflicts > 0 && (
            <div className="info-banner orange" style={{ marginTop: 14 }}>
              <span className="ib-ic">⚠</span>
              <span className="ib-txt">{openConflicts} {openConflicts === 1 ? "запис не вміщується" : "записи(-ів) не вміщуються"} в обраний день. Підберіть слот вручну для кожного — кнопка «🗓 Підібрати слот вручну» праворуч від рядка.</span>
            </div>
          )}
          {done && openConflicts === 0 && (
            <div className="info-banner" style={{ marginTop: 14, borderColor: "var(--green)" }}>
              <span className="ib-ic" style={{ color: "var(--green)" }}>✓</span>
              <span className="ib-txt">Усі {rows.length} записів перенесено — конфліктів не лишилось.</span>
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 }}>
            <button className="btn btn-ghost" onClick={reset}>Скинути</button>
            <button className="btn btn-danger" disabled={done && openConflicts === 0}
              onClick={() => {
                setDone(true);
                if (openConflicts > 0) toast(`Перенесено ${autoCount + (conflictRows.length - openConflicts)} записів · лишилось ${openConflicts} конфліктних — підберіть слот вручну нижче`, "warning");
                else toast(`Усі ${rows.length} записів перенесено · 0 конфліктів`, "success");
              }}>
              {openConflicts > 0 ? `Перенести всі (${openConflicts} конфліктних лишиться)` : "Перенести всі записи"}
            </button>
          </div>
        </div>
      )}
      {resched && <RescheduleModal patient={{ name: resched.name, proc: resched.proc }} onClose={() => setResched(null)} onConfirm={(slot) => resolveSlot(resched, slot)} />}
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
