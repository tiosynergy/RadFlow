/* ===== RadFlow — User Flows v2.1 document renderer ===== */
const root = document.getElementById("doc");

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

/* ---- Cover ---- */
const m = window.UF_META;
const cover = el("header", "cover");
cover.innerHTML = `
  <div class="cover-top">
    <div class="brand"><span class="brand-dot"></span>RadFlow</div>
    <div class="cover-ver">${m.version}</div>
  </div>
  <h1 class="cover-h1">User Flows — оновлена документація</h1>
  <p class="cover-sub">Сценарії користувача ролі «Адміністратор реєстратури», узгоджені з фактично побудованим прототипом RadFlow.</p>
  <div class="cover-meta">
    <span>${m.base}</span>
    <span>${m.date}</span>
  </div>
  <div class="cover-note"><b>Принцип:</b> ${m.principle}</div>
  <div class="cover-note scope"><b>Обсяг:</b> ${m.scope}</div>
`;
root.appendChild(cover);

/* ---- Section helper ---- */
function section(num, title, sub) {
  const s = el("section", "sec");
  s.appendChild(el("div", "sec-head", `<span class="sec-num">${num}</span><div><h2 class="sec-title">${title}</h2>${sub ? `<div class="sec-sub">${sub}</div>` : ""}</div>`));
  root.appendChild(s);
  return s;
}

/* ---- 1. Зміни ---- */
const s1 = section("01", "Легенда змін", "Що змінилося від документа v2.0 до фактичного прототипу v2.2");
const ctab = el("div", "change-list");
window.UF_CHANGES.forEach((c) => {
  const row = el("div", "change-row");
  row.innerHTML = `
    <div class="change-tag">${c.tag}</div>
    <div class="change-cols">
      <div class="change-was"><span class="cw-lab">Було (v2.0)</span>${c.was}</div>
      <div class="change-arrow">→</div>
      <div class="change-now"><span class="cn-lab">Стало (v2.2)</span>${c.now}</div>
    </div>`;
  ctab.appendChild(row);
});
s1.appendChild(ctab);

/* ---- 2. IA map ---- */
const s2 = section("02", "Карта інтерфейсу (IA)", "Структура навігації в сайдбарі побудованого прототипу");
const iaWrap = el("div", "ia-wrap");
window.UF_IA.forEach((g) => {
  const col = el("div", "ia-col");
  col.innerHTML = `<div class="ia-group">${g.group}</div>`;
  const list = el("div", "ia-items");
  g.items.forEach((it) => list.appendChild(el("div", "ia-item", it)));
  col.appendChild(list);
  col.appendChild(el("div", "ia-note", g.note));
  iaWrap.appendChild(col);
});
s2.appendChild(iaWrap);

/* ---- 3. Status model ---- */
const s3 = section("03", "Модель статусів", "Кольорова семантика статусів пацієнта (Supabase Realtime)");
const stWrap = el("div", "status-wrap");
window.UF_STATUS.forEach((st) => {
  const c = el("div", "status-card");
  c.innerHTML = `
    <div class="status-top"><span class="status-dot ${st.color}"></span><span class="status-label">${st.label}</span></div>
    <div class="status-en">${st.en}</div>
    <div class="status-desc">${st.desc}</div>`;
  stWrap.appendChild(c);
});
s3.appendChild(stWrap);

/* ---- 4. Flows ---- */
const s4 = section("04", "Сценарії користувача — Адміністратор та Радіолог", "Фактичні UserFlow, перевірені у прототипі");
window.UF_FLOWS.forEach((f) => {
  const card = el("article", "flow");
  // header
  card.appendChild(el("div", "flow-head", `
    <span class="flow-ic">${f.icon}</span>
    <div class="flow-h-meta">
      <div class="flow-id">${f.id}</div>
      <h3 class="flow-title">${f.title}</h3>
    </div>`));
  card.appendChild(el("div", "flow-trigger", `<span class="ft-lab">Тригер</span>${f.trigger}`));
  // chips diagram
  const chips = el("div", "flow-chips");
  f.chips.forEach((ch, i) => {
    chips.appendChild(el("span", "flow-chip", ch));
    if (i < f.chips.length - 1) chips.appendChild(el("span", "flow-chip-arrow", "→"));
  });
  card.appendChild(chips);
  // steps table
  const table = el("div", "flow-table");
  table.appendChild(el("div", "ft-row ft-h", `<div>#</div><div>Дія</div><div>Що бачить / робить</div><div>Результат</div>`));
  f.steps.forEach((st) => {
    table.appendChild(el("div", "ft-row", `<div class="ft-num">${st[0]}</div><div class="ft-act">${st[1]}</div><div class="ft-see">${st[2]}</div><div class="ft-res">${st[3]}</div>`));
  });
  card.appendChild(table);
  if (f.note) card.appendChild(el("div", "flow-note", `<span class="fn-ic">⚡</span>${f.note}`));
  s4.appendChild(card);
});

/* ---- 5. Other roles ---- */
const s5 = section("05", "Інші ролі", "Без змін на цьому етапі — узгоджено з v2.0, реалізація Stage 2");
const orWrap = el("div", "or-wrap");
window.UF_OTHER_ROLES.forEach((r) => {
  const c = el("div", "or-card");
  c.innerHTML = `<div class="or-role">${r.role}</div><div class="or-flow">${r.flow}</div><div class="or-status">${r.status}</div>`;
  orWrap.appendChild(c);
});
s5.appendChild(orWrap);

/* ---- Footer ---- */
const foot = el("footer", "doc-foot");
foot.innerHTML = `RadFlow · User Flows v2.2 (As-Built) · ${m.date} · Документ узгоджено з прототипом (radflow-queue-board / call-list / setup-wizard / incidents / radiologist)`;
root.appendChild(foot);
