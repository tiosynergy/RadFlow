// Макети екранів RadFlow для інструкції користувача.
// Справжній CSS проєкту + ВИГАДАНІ пацієнти (жодного ПІІ з прода).
// Виносками (.cal) підписані місця, про які говорить текст інструкції.
import { chromium } from "playwright";
import fs from "node:fs";

import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");   // корінь репозиторію
const css = ["radflow.css", "radflow-screens.css", "radflow-wizard.css", "radiologist.css"]
  .map((f) => fs.readFileSync(`${ROOT}/styles/prototype/${f}`, "utf8")).join("\n");

const OUT = path.join(HERE, "shots");           // .gitignore — у репозиторій не йдуть
fs.mkdirSync(OUT, { recursive: true });

const shell = (inner, w) => `<!doctype html><html lang="uk"><head><meta charset="utf-8"><style>
${css}
html,body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,-apple-system,system-ui,sans-serif}
.shot{width:${w}px;padding:18px 18px 18px 46px;background:var(--bg);position:relative}
.cal{position:absolute;width:22px;height:22px;border-radius:50%;background:#0a84ff;color:#fff;font:700 12px/22px Inter,system-ui,sans-serif;text-align:center;box-shadow:0 0 0 3px rgba(10,132,255,.25);z-index:9}
</style></head><body><div class="shot">${inner}</div></body></html>`;

const cal = (n, top, left) => `<span class="cal" style="top:${top}px;left:${left}px">${n}</span>`;

/* ───────── 1. Дошка черги ───────── */
const stat = (lab, val, cls, sub, active) =>
  `<div class="stat${active ? " active clickable" : " clickable"}"><div class="lab">${lab}</div><div class="val ${cls}">${val}</div><div class="sub">${sub}</div></div>`;

const qrow = ({ time, dur, date, prio, name, phone, age, ref, proc, kind, room, model, mod, status, cls, icon, dot, extra = "" }) => `
<div class="qrow-item ${cls}">
  <div class="qrow">
    <div class="q-time tabular">${time}<div class="td">${dur} хв</div><div class="td" style="margin-top:2px;color:var(--text-muted)">${date}</div></div>
    <div class="q-pat">
      <div class="nm">${prio ? `<span class="prio-tag ${prio.tone}">${prio.short}</span>` : ""}<span style="text-decoration:underline dotted;text-underline-offset:3px">${name}</span></div>
      <div class="det" style="display:flex;flex-direction:column;gap:1px">
        <span style="white-space:nowrap">Тел. ${phone}</span><span>${age}</span><span>Напр.: ${ref}</span>
      </div>
    </div>
    <div class="q-proc"><div class="pp">${proc}</div><div class="du">${kind}</div></div>
    <div class="q-room">
      <span style="flex-shrink:0;font-size:0.625rem;font-weight:700;padding:2px 6px;border-radius:5px;line-height:1.4;background:${mod === "КТ" ? "var(--orange-bg)" : "var(--blue-bg)"};color:${mod === "КТ" ? "var(--orange)" : "var(--blue-text)"}">${mod}</span>
      <b>${room}</b><span style="font-size:0.6875rem;color:var(--text-muted)">${model}</span>
    </div>
    <div class="q-status-cell"><span class="badge ${cls === "in_progress" ? "blue" : icon === "✓" ? "green" : icon === "✕" ? "red" : cls === "waiting" ? "yellow" : "gray"}">${dot ? `<span class="pulse-dot" style="width:6px;height:6px"></span>` : `<span style="margin-right:3px">${icon}</span>`}${status}</span>${extra}</div>
    <div class="q-chev">›</div>
  </div>
</div>`;

const queueBoard = `
<div class="stats">
  ${stat("Всього сьогодні", "18", "white", "записів", false)}
  ${stat("В черзі", "7", "gray", "записані", false)}
  ${stat("Очікують", "3", "yellow", "прийшли", true)}
  ${stat("В кабінеті", "1", "blue", "зараз", false)}
  ${stat("Виконано", "6", "green", "процедур", false)}
  ${stat("Запізнення", "1", "red", "понад буфер", false)}
</div>
<div class="qhead"><div>Час</div><div>Пацієнт</div><div>Процедура</div><div>Кабінет</div><div>Статус</div><div></div></div>
<div class="qrows">
  ${qrow({ time: "09:00", dur: 30, date: "24.09", prio: { tone: "red", short: "CITO" }, name: "Петренко Ірина Олегівна", phone: "+380 67 123 45 67", age: "41 р., 62 кг", ref: "Коваль С. П.", proc: "МРТ головного мозку", kind: "МРТ · 1.5Т", room: "Кабінет 1", model: "Siemens Avanto", mod: "МРТ", status: "В кабінеті", cls: "in_progress", dot: true })}
  ${qrow({ time: "09:40", dur: 20, date: "24.09", prio: { tone: "orange", short: "Терміново" }, name: "Бондаренко Олег Ігорович", phone: "+380 50 222 11 33", age: "56 р.", ref: "Левченко А. М.", proc: "КТ органів грудної клітки з контрастом", kind: "КТ · 64 зрізи", room: "Кабінет 2", model: "GE Revolution", mod: "КТ", status: "Очікує", cls: "waiting", icon: "◔" })}
  ${qrow({ time: "10:10", dur: 30, date: "24.09", name: "Мельник Ганна Василівна", phone: "+380 63 777 88 99", age: "33 р.", ref: "Коваль С. П.", proc: "МРТ шийного відділу хребта", kind: "МРТ · 1.5Т", room: "Кабінет 1", model: "Siemens Avanto", mod: "МРТ", status: "В черзі", cls: "scheduled", icon: "○" })}
  ${qrow({ time: "08:30", dur: 25, date: "24.09", name: "Шевченко Павло Миколайович", phone: "+380 96 555 44 22", age: "62 р.", ref: "Левченко А. М.", proc: "КТ черевної порожнини", kind: "КТ · 64 зрізи", room: "Кабінет 2", model: "GE Revolution", mod: "КТ", status: "Виконано", cls: "done", icon: "✓" })}
</div>
${cal(1, 44, 10)}${cal(2, 172, 10)}${cal(3, 295, 10)}${cal(4, 410, 10)}${cal(5, 525, 10)}`;

/* ───────── 2. Розкритий рядок: степпер і дії ───────── */
const circle = (label, color, state) => {
  const bg = state === "done" ? color : state === "cur" ? color : "var(--card-2)";
  const bd = state === "todo" ? "var(--border-strong)" : color;
  const fg = state === "todo" ? "var(--text-faint)" : "#1c1c1e";
  return `<div style="display:flex;flex-direction:column;align-items:center;width:84px">
    <div style="width:30px;height:30px;border-radius:50%;background:${bg};border:2px solid ${bd};color:${fg};display:flex;align-items:center;justify-content:center;font-size:0.8125rem;font-weight:700">${state === "done" ? "✓" : state === "cur" ? "●" : ""}</div>
    <span style="margin-top:8px;font-size:0.75rem;text-align:center;color:${state === "cur" ? "var(--text)" : state === "done" ? "var(--text-secondary)" : "var(--text-faint)"};font-weight:${state === "cur" ? 600 : 500}">${label}</span>
  </div>`;
};

const openRow = `
<div class="qrow-item waiting open">
  <div class="qrow">
    <div class="q-time tabular">09:40<div class="td">20 хв</div><div class="td" style="margin-top:2px;color:var(--text-muted)">24.09</div></div>
    <div class="q-pat"><div class="nm"><span class="prio-tag orange">Терміново</span><span style="text-decoration:underline dotted;text-underline-offset:3px">Бондаренко Олег Ігорович</span></div>
      <div class="det"><span>Тел. +380 50 222 11 33 · 56 р. · Напр.: Левченко А. М.</span></div></div>
    <div class="q-proc"><div class="pp">КТ органів грудної клітки з контрастом</div><div class="du">КТ · 64 зрізи</div></div>
    <div class="q-room"><span style="font-size:0.625rem;font-weight:700;padding:2px 6px;border-radius:5px;background:var(--orange-bg);color:var(--orange)">КТ</span><b>Кабінет 2</b><span style="font-size:0.6875rem;color:var(--text-muted)">GE Revolution</span></div>
    <div class="q-status-cell"><span class="badge yellow"><span style="margin-right:3px">◔</span>Очікує</span></div>
    <div class="q-chev open">›</div>
  </div>
  <div class="qrow-detail-wrap" style="grid-template-rows:1fr"><div class="qrow-detail-inner"><div class="qrow-detail">
    <div style="position:relative;padding:2px 32px 4px;max-width:62%">
      <div style="position:absolute;top:17px;left:56px;right:56px;height:2px;background:var(--border)"></div>
      <div style="position:relative;display:flex;justify-content:space-between">
        ${circle("В черзі", "#aeaeb2", "done")}${circle("Очікує", "#ffd60a", "cur")}${circle("В кабінеті", "#6db4ff", "todo")}${circle("Виконано", "#30d158", "todo")}
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;padding:4px 0;flex-wrap:wrap">
      <button style="display:inline-flex;align-items:center;gap:6px;padding:9px 16px;border-radius:10px;font-size:0.84375rem;font-weight:600;border:1px solid var(--blue-line);background:var(--blue);color:#fff">▶ Викликати в кабінет</button>
      <button class="btn btn-secondary btn-sm">🩻 Дослідження</button>
      <button class="btn btn-secondary btn-sm">🗓 Перенести</button>
      <button class="btn btn-secondary btn-sm">✎ Дані пацієнта</button>
      <button class="btn btn-secondary btn-sm">⏳ В лист очікування</button>
      <button class="btn btn-secondary btn-sm qd-act-red">✕ Скасувати запис</button>
    </div>
    <div style="display:flex;gap:6px;align-items:center;font-size:0.75rem;color:var(--text-muted);padding-top:2px">
      <span class="badge gray"><span style="margin-right:3px">○</span>Не дзвонили</span>
      <span>Дзвінок-підтвердження · змінюється в Колл-листі</span>
    </div>
  </div></div></div>
</div>
${cal(1, 55, 10)}${cal(2, 150, 10)}${cal(3, 212, 10)}${cal(4, 262, 10)}`;

/* ───────── 3. Сітка слотів ───────── */
const blk = (h, m, states = {}) => {
  const lab = String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
  const cells = [0, 5, 10, 15, 20, 25].map((x) => {
    const v = String(m + x).padStart(2, "0");
    const st = states[m + x] || "";
    return `<button class="slot ${st}" ${st.includes("busy") || st.includes("brk") ? "disabled" : ""}>${v}</button>`;
  }).join("");
  return `<div class="slot-blk"><span class="slot-blk-lab">${lab}</span><div class="slot-blk-cells">${cells}</div></div>`;
};
const slotGrid = `
<div style="max-width:620px">
  <div class="fld"><span class="fld-lab">Сітка дня · крок 5 хв</span>
    <div class="slot-picker"><div class="slot-grid4">
      ${blk(8, 0, { 10: "taken busy", 15: "taken busy", 20: "taken busybuf" })}
      ${blk(8, 30)}${blk(9, 0, { 0: "sel" })}${blk(9, 30)}${blk(10, 0)}
      ${blk(10, 30)}${blk(11, 0)}${blk(11, 30, { 30: "taken brk", 35: "taken brk", 40: "taken brk", 45: "taken brk", 50: "taken brk", 55: "taken brk" })}${blk(12, 0, { 0: "taken brk", 5: "taken brk", 10: "taken brk", 15: "taken brk", 20: "taken brk", 25: "taken brk" })}${blk(12, 30)}
      ${blk(13, 0)}${blk(13, 30)}${blk(14, 0, { 20: "tight", 25: "tight" })}${blk(14, 30)}${blk(15, 0)}
    </div></div>
  </div>
  <div class="bk-slot-legend" style="margin-top:10px">
    <span><span class="lg-dot free"></span>вільно</span>
    <span><span class="lg-dot busy"></span>дослідження</span>
    <span><span class="lg-dot busybuf"></span>буфер</span>
    <span><span class="lg-dot brk"></span>перерва</span>
    <span><span class="lg-dot tight"></span>не вміщується</span>
  </div>
</div>
${cal(1, 58, 10)}${cal(2, 120, 10)}${cal(3, 230, 10)}${cal(4, 342, 10)}`;

/* ───────── 4. Колл-лист ───────── */
const clrow = (time, name, sub, proc, room, st, cls, icon) => `
<div class="cl-item">
  <div class="cl-row" style="display:grid;grid-template-columns:58px minmax(0,1.6fr) minmax(0,1.8fr) minmax(0,1fr) 124px 132px 28px;gap:12px;align-items:center;padding:11px 14px">
    <div><div class="cl-time">${time}</div><div class="cl-date">24.09</div></div>
    <div class="cl-name">${name}<div class="sub">${sub}</div></div>
    <div class="cl-proc">${proc}</div>
    <div class="cl-room">${room}</div>
    <div style="text-align:center"><span class="badge cl-status ${cls}"><span style="margin-right:3px">${icon}</span>${st}</span></div>
    <div class="cl-actions">
      <button class="btn btn-secondary btn-sm">✓</button>
      <button class="btn btn-secondary btn-sm">☎</button>
      <button class="btn btn-secondary btn-sm">↩</button>
    </div>
    <div class="cl-exp-btn"><span class="cl-chev">›</span></div>
  </div>
</div>`;

const callList = `
<div class="cl-stats" style="max-width:720px">
  <div class="cl-stat"><div class="lab">Всього записів</div><div class="val">14</div><div class="mini-bar"><div class="mini-fill" style="width:100%;background:var(--blue-line)"></div></div></div>
  <div class="cl-stat"><div class="lab">Підтверджено</div><div class="val" style="color:var(--green)">9</div><div class="mini-bar"><div class="mini-fill" style="width:64%;background:var(--green)"></div></div></div>
  <div class="cl-stat"><div class="lab">Не відповідає</div><div class="val" style="color:var(--orange)">3</div><div class="mini-bar"><div class="mini-fill" style="width:21%;background:var(--orange)"></div></div></div>
  <div class="cl-stat"><div class="lab">Відмова</div><div class="val" style="color:var(--red-text)">1</div><div class="mini-bar"><div class="mini-fill" style="width:7%;background:var(--danger)"></div></div></div>
</div>
<div class="qrows" style="margin-top:14px">
  ${clrow("09:00", "Петренко Ірина Олегівна", "+380 67 123 45 67", "МРТ головного мозку", "Кабінет 1", "Підтверджено", "green", "✓")}
  ${clrow("09:40", "Бондаренко Олег Ігорович", "+380 50 222 11 33", "КТ ОГК з контрастом", "Кабінет 2", "Не відповідає", "orange", "…")}
  ${clrow("10:10", "Мельник Ганна Василівна", "+380 63 777 88 99", "МРТ шийного відділу", "Кабінет 1", "Передзвонити", "blue", "↻")}
  ${clrow("11:00", "Шевченко Павло Миколайович", "+380 96 555 44 22", "КТ черевної порожнини", "Кабінет 2", "Не дзвонили", "gray", "○")}
</div>
${cal(1, 60, 10)}${cal(2, 156, 10)}${cal(3, 233, 10)}${cal(4, 387, 10)}`;

/* ───────── 5. Кабінет радіолога ───────── */
const radiologist = `
<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;max-width:760px">
  <div class="rcard">
    <h3>🩻 Кабінет 1 · Siemens Avanto</h3>
    <div style="display:flex;gap:14px;align-items:center">
      <div style="width:86px;height:86px;border-radius:50%;border:5px solid var(--blue-line);display:flex;flex-direction:column;align-items:center;justify-content:center">
        <b style="font-size:1.05rem">12:40</b><span style="font-size:0.625rem;color:var(--text-muted)">з 30 хв</span>
      </div>
      <div style="min-width:0">
        <div style="font-size:0.875rem;font-weight:600">Петренко Ірина Олегівна</div>
        <div style="font-size:0.75rem;color:var(--text-muted);margin-top:3px">МРТ головного мозку · 09:00 · 30 хв</div>
        <div style="margin-top:9px;display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-primary btn-sm">✓ Завершити процедуру</button>
          <button class="btn btn-secondary btn-sm">⋯ Більше дій</button>
        </div>
      </div>
    </div>
  </div>
  <div class="rcard">
    <h3>🩻 Кабінет 3 · Philips Ingenia</h3>
    <div style="font-size:0.8125rem;color:var(--text-muted);padding:8px 0 12px">Кабінет вільний</div>
    <div style="font-size:0.78125rem;color:var(--text-secondary)">Наступний у черзі: <b style="color:var(--text)">Мельник Ганна Василівна</b> · 10:10</div>
    <div style="margin-top:10px"><button class="btn btn-primary btn-sm">▶ Викликати наступного</button></div>
  </div>
</div>
${cal(1, 110, 10)}${cal(2, 2, 250)}${cal(3, 2, 640)}`;

/* ───────── 6. Дашборд керівника ───────── */
const kpi = (lab, val, sub, color) => `
<div class="cl-stat"><div class="lab">${lab}</div><div class="val" style="color:${color}">${val}</div><div class="sub" style="font-size:0.6875rem;color:var(--text-muted)">${sub}</div></div>`;
const ceo = `
<div style="max-width:760px">
  <div style="display:flex;gap:8px;margin-bottom:14px">
    <button class="btn btn-secondary btn-sm">Сьогодні</button>
    <button class="btn btn-primary btn-sm">Цей тиждень</button>
    <button class="btn btn-secondary btn-sm">Цей місяць</button>
    <span style="flex:1"></span>
    <button class="btn btn-secondary btn-sm">⭳ Експортувати CSV</button>
  </div>
  <div class="cl-stats" style="grid-template-columns:repeat(4,1fr)">
    ${kpi("Записи · тиждень", "126", "усі записи", "var(--text)")}
    ${kpi("Виконано", "104", "82,5 % від усіх", "var(--green)")}
    ${kpi("Зрив (неявка + не відбулося)", "14", "11,1 %", "var(--red-text)")}
    ${kpi("Завантаженість", "68 %", "2 апарати · 5 роб. дн.", "var(--blue-text)")}
  </div>
  <div class="rcard" style="margin-top:14px">
    <h3>📊 Дослідження за тиждень</h3>
    <div style="display:flex;align-items:flex-end;gap:14px;height:110px;padding:0 4px">
      ${[62, 78, 55, 90, 70, 34, 0].map((v, i) => `
        <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px">
          <div style="width:100%;height:${Math.max(v, 3)}px;background:var(--blue-line);border-radius:4px 4px 0 0;position:relative">${v > 40 ? `<span style="position:absolute;top:-2px;left:50%;transform:translateX(-50%);width:6px;height:6px;border-radius:50%;background:var(--danger)"></span>` : ""}</div>
          <span style="font-size:0.6875rem;color:var(--text-muted)">${["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"][i]}</span>
        </div>`).join("")}
    </div>
  </div>
</div>
${cal(1, 30, 10)}${cal(2, 105, 10)}${cal(3, 300, 10)}`;

/* ───────── 7. Майстер налаштування ───────── */
const wizard = `
<div style="display:grid;grid-template-columns:230px 1fr;gap:18px;max-width:820px">
  <div class="rcard" style="padding:12px">
    ${[["1", "Профіль клініки", "Назва та контакти центру", false],
       ["2", "Адміністратор", "Обліковий запис адміна", false],
       ["3", "Обладнання та кабінети", "Апарати та розклад", true],
       ["4", "Послуги та прайс", "Каталог послуг і цін центру", false],
       ["5", "Управління чергою", "Політика при затримці", false],
       ["6", "Резервне копіювання", "Аварійна копія", false],
       ["7", "Персонал і доступи", "Радіологи та реєстратори", false]].map(([n, t, s, act]) => `
      <div style="display:flex;gap:10px;align-items:flex-start;padding:8px 6px;border-radius:8px;background:${act ? "var(--card-2)" : "transparent"}">
        <span style="flex:none;width:22px;height:22px;border-radius:50%;background:${act ? "var(--blue)" : "var(--card-2)"};border:1px solid ${act ? "var(--blue-line)" : "var(--border-strong)"};color:${act ? "#fff" : "var(--text-muted)"};font-size:0.6875rem;font-weight:700;display:flex;align-items:center;justify-content:center">${n}</span>
        <span style="min-width:0"><b style="font-size:0.8125rem;color:${act ? "var(--text)" : "var(--text-secondary)"}">${t}</b><span style="display:block;font-size:0.6875rem;color:var(--text-faint);margin-top:2px">${s}</span></span>
      </div>`).join("")}
  </div>
  <div class="rcard">
    <h3>🖥 Обладнання та кабінети</h3>
    <div style="font-size:0.78125rem;color:var(--text-muted);margin:-6px 0 12px">Апарати центру та їхній графік роботи</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="fld"><span class="fld-lab">Кабінет / № — обладнання</span><input class="inp" value="Кабінет 1" readonly></div>
      <div class="fld"><span class="fld-lab">Модель / опис — обладнання</span><input class="inp" value="Siemens Avanto 1.5T" readonly></div>
    </div>
    <div style="display:flex;gap:6px;margin:12px 0 10px;flex-wrap:wrap">
      ${["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"].map((d, i) => `<span class="badge ${i < 6 ? "blue" : "gray"}" style="padding:4px 10px">${d}</span>`).join("")}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
      <div class="fld"><span class="fld-lab">Початок роботи</span><input class="inp" value="08:00" readonly></div>
      <div class="fld"><span class="fld-lab">Кінець роботи</span><input class="inp" value="18:00" readonly></div>
      <div class="fld"><span class="fld-lab">Перерва 1</span><input class="inp" value="13:00 – 14:00" readonly></div>
    </div>
    <div style="margin-top:14px;display:flex;gap:8px">
      <button class="btn btn-primary btn-sm">💾 Зберегти</button>
      <button class="btn btn-secondary btn-sm">＋ Додати обладнання</button>
    </div>
  </div>
</div>
${cal(1, 170, 10)}${cal(2, 2, 300)}${cal(3, 285, 10)}`;

/* ───────── 8. Лист очікування ───────── */
const wlrow = (name, sub, studies, win, prio, tone, st, stCls) => `
<div class="qrow-item" style="border-left-color:var(--border-strong)">
  <div class="qrow" style="grid-template-columns:minmax(0,1.6fr) minmax(0,1.8fr) minmax(0,1.3fr) 120px 110px 26px">
    <div class="q-pat"><div class="nm">${prio ? `<span class="prio-tag ${tone}">${prio}</span>` : ""}${name}</div><div class="det">${sub}</div></div>
    <div class="q-proc"><div class="pp">${studies}</div><div class="du">30 хв + буфер 5 хв</div></div>
    <div class="q-proc"><div class="pp">${win}</div><div class="du">Бажане вікно</div></div>
    <div><button class="btn btn-primary btn-sm">🗓 Записати</button></div>
    <div class="q-status-cell"><span class="badge ${stCls}">${st}</span></div>
    <div class="q-chev">›</div>
  </div>
</div>`;
const waitlist = `
<div style="display:flex;gap:8px;margin-bottom:12px">
  <button class="btn btn-primary btn-sm">Очікують · 4</button>
  <button class="btn btn-secondary btn-sm">Записані · 11</button>
  <button class="btn btn-secondary btn-sm">Зняті · 2</button>
  <span style="flex:1"></span>
  <button class="btn btn-secondary btn-sm">＋ Додати пацієнта</button>
</div>
<div class="qhead" style="grid-template-columns:minmax(0,1.6fr) minmax(0,1.8fr) minmax(0,1.3fr) 120px 110px 26px"><div>Пацієнт</div><div>Дослідження</div><div>Бажане вікно</div><div></div><div>Статус</div><div></div></div>
<div class="qrows">
  ${wlrow("Ткаченко Марія Петрівна", "+380 67 900 11 22 · 47 р.", "МРТ колінного суглоба", "24–27.09 · Ранок 08–12", "CITO", "red", "В очікуванні", "gray")}
  ${wlrow("Гриценко Андрій Васильович", "+380 50 300 44 55 · 38 р.", "КТ пазух носа", "25–30.09 · Будь-який", "Терміново", "orange", "В очікуванні", "gray")}
  ${wlrow("Лисенко Оксана Юріївна", "+380 63 111 22 33 · 29 р.", "МРТ попереку", "26.09 – 02.10 · Вечір 16–20", "", "", "Записано", "green")}
</div>
${cal(1, 26, 10)}${cal(2, 140, 10)}${cal(3, 240, 10)}${cal(4, 340, 10)}`;

const SHOTS = [
  ["queue", queueBoard, 980],
  ["queue-open", openRow, 980],
  ["slots", slotGrid, 660],
  ["calllist", callList, 1000],
  ["radiologist", radiologist, 800],
  ["ceo", ceo, 800],
  ["wizard", wizard, 860],
  ["waitlist", waitlist, 900],
];

const b = await chromium.launch();
for (const [name, html, w] of SHOTS) {
  const p = await b.newPage({ viewport: { width: w + 60, height: 900 }, deviceScaleFactor: 2 });
  await p.setContent(shell(html, w));
  const el = await p.$(".shot");
  await el.screenshot({ path: `${OUT}/${name}.png` });
  const box = await el.boundingBox();
  console.log(name.padEnd(12), `${Math.round(box.width)}×${Math.round(box.height)}`, (fs.statSync(`${OUT}/${name}.png`).size / 1024).toFixed(0) + " KB");
  await p.close();
}
await b.close();
