/* ===== RadFlow — Radiologist workspace data ===== */

window.RAD_PROFILE = {
  name: "Левчук Андрій Миколайович",
  role: "Радіолог",
  cabinets: ["r1", "r2", "r3", "r4"], // кабінети, авторизовані Адміністратором для цього радіолога
  initials: "ЛА",
};

/* ===== Контроль доступу до обладнання (Equipment Access Control) =====
   Межа доступу радіолога. У продакшені це серверний запит до Supabase з RLS:
     SELECT cabinet_id FROM radiologist_cabinets WHERE radiologist_id = auth.uid()
   У прототипі джерело — RAD_PROFILE.cabinets, видані Адміністратором.
   ВАЖЛИВО: будь-яка вибірка пацієнтів радіолога ОБОВ'ЯЗКОВО проходить через цей
   список — радіолог не може побачити жодного кабінету поза ним. */
window.getAuthorizedCabinets = function () {
  const ids = (window.RAD_PROFILE && window.RAD_PROFILE.cabinets) || [];
  // повертаємо лише реально існуючі кабінети з даними обладнання
  return ids.filter((id) => window.RF_ROOMS && window.RF_ROOMS[id]);
};

/* Пацієнти радіолога: спільна черга, відфільтрована СУВОРО за авторизованими кабінетами.
   Це єдина точка входу даних для сторінки радіолога — гарантує, що дослідження
   неавторизованого обладнання ніколи не потраплять у вибірку. */
window.getRadiologistQueue = function () {
  const allowed = window.getAuthorizedCabinets();
  const src = window.getQueuePatients ? window.getQueuePatients() : (window.RF_PATIENTS || []).map((p) => ({ ...p }));
  return src.filter((p) => allowed.includes(p.room));
};

// Приоритеты приведены в соответствие с главной очередью Администратора:
// статуса «Терміновий» (urgent) немає — лишаються тільки плановий і наскрізний CITO.
window.RAD_PRIORITY = {
  planned: { label: "Плановий", cls: "gray" },
  cito:    { label: "CITO", cls: "red" },
};

/* Клінічний контекст за пацієнтом (показання, направник, контраст, регіон) */
window.RAD_CLINICAL = {
  1:  { docId: 2, priority: "planned", region: "Колінний суглоб, права нога", contrast: false, indication: "Біль та обмеження рухливості після травми. Підозра на пошкодження меніска.", weight: 78 },
  3:  { docId: 1, priority: "planned", region: "Хребет, поперековий відділ", contrast: false, indication: "Хронічний біль у попереку, іррадіація в ліву ногу. Виключити грижу диска.", weight: 64 },
  5:  { docId: 3, priority: "planned", region: "Головний мозок", contrast: true, indication: "Контроль після терапії. Динаміка вогнища.", weight: 70 },
  6:  { docId: 1, priority: "planned", region: "Головний мозок", contrast: false, indication: "Тривалі головні болі, епізоди запаморочення. Виключити органічну патологію.", weight: 82 },
  7:  { docId: 3, priority: "cito", region: "Черевна порожнина", contrast: true, indication: "Гострий біль у правому підребер'ї. Підозра на об'ємний процес.", weight: 59 },
  8:  { docId: 2, priority: "planned", region: "Плечовий суглоб, ліве плече", contrast: false, indication: "Обмеження відведення руки, підозра на розрив ротаторної манжети.", weight: 71 },
  10: { docId: 1, priority: "planned", region: "Черевна порожнина", contrast: false, indication: "Скринінг, дискомфорт у животі.", weight: 88 },
  12: { docId: 3, priority: "planned", region: "Головний мозок", contrast: false, indication: "Післяопераційний контроль.", weight: 75 },
  14: { docId: 2, priority: "planned", region: "Колінний суглоб, ліва нога", contrast: false, indication: "Спортивна травма, біль при навантаженні.", weight: 69 },
  15: { docId: 1, priority: "cito", region: "Головний мозок", contrast: false, indication: "Гостра неврологічна симптоматика. Виключити ГПМК.", weight: 80 },
  16: { docId: 1, priority: "planned", region: "Хребет, шийний відділ", contrast: false, indication: "Болі в шиї, оніміння пальців рук.", weight: 62 },
  17: { docId: 2, priority: "planned", region: "Колінний суглоб", contrast: false, indication: "Контроль після консервативного лікування.", weight: 73 },
  // КТ
  2:  { docId: 3, priority: "planned", region: "Органи грудної клітки", contrast: false, indication: "Скринінг, кашель понад 3 тижні.", weight: 90 },
  4:  { docId: 1, priority: "planned", region: "Голова", contrast: false, indication: "Травма голови, виключити внутрішньочерепну гематому.", weight: 85 },
  9:  { docId: 3, priority: "planned", region: "Органи грудної клітки", contrast: false, indication: "Контроль вузлика у легені.", weight: 66 },
  11: { docId: 1, priority: "planned", region: "Нирки та сечовивідні шляхи", contrast: false, indication: "Підозра на конкременти.", weight: 77 },
  13: { docId: 3, priority: "planned", region: "Органи грудної клітки", contrast: true, indication: "Підозра на ТЕЛА.", weight: 81 },
  19: { docId: 3, priority: "planned", region: "Органи грудної клітки", contrast: false, indication: "Профогляд.", weight: 79 },
  20: { docId: 1, priority: "planned", region: "Голова", contrast: false, indication: "Головні болі.", weight: 58 },
  21: { docId: 1, priority: "planned", region: "Черевна порожнина", contrast: false, indication: "Біль у животі.", weight: 84 },
  23: { docId: 3, priority: "planned", region: "Органи грудної клітки", contrast: false, indication: "Скринінг.", weight: 72 },
};

/* ===== Спільне сховище досліджень (синхронізація радіолог ↔ адмін) ===== */
window.RAD_STORE_KEY = "rf_study_store_v1";
window.getStudyStore = function () {
  try { return JSON.parse(localStorage.getItem(window.RAD_STORE_KEY)) || {}; }
  catch (e) { return {}; }
};
window.saveStudy = function (id, patch) {
  const s = window.getStudyStore();
  s[id] = Object.assign({}, s[id], patch);
  localStorage.setItem(window.RAD_STORE_KEY, JSON.stringify(s));
  // синхронізація в реальному часі в межах поточної вкладки (storage спрацьовує лише між вкладками)
  try { window.dispatchEvent(new CustomEvent("rf-study-sync", { detail: { id: id } })); } catch (e) {}
};
/* Пацієнти з накладеними статусами зі сховища (для синхронізації) */
window.getQueuePatients = function () {
  const store = window.getStudyStore();
  const apply = (p) => {
    const s = store[p.id];
    let r = s && s.status ? Object.assign({}, p, { status: s.status }) : Object.assign({}, p);
    return window.rfApplyStudies ? window.rfApplyStudies(r) : r;   // накладаємо відредаговані дослідження
  };
  let list = window.RF_PATIENTS.map(apply);
  // вмерджуємо ручні записи на СЬОГОДНІ (rf_bookings_v1) — синхронно для всіх ролей
  if (window.getBookingsForDate && window.rfToday) {
    list = list.concat(window.getBookingsForDate(window.rfToday()).map(apply));
  }
  // ховаємо перенесені/скасовані записи (rf_cancelled_v1)
  if (window.isPatientSuppressed) list = list.filter((p) => !window.isPatientSuppressed(p.id));
  return list;
};
window.radGender = function (name) {
  const last = (name || "").trim().split(/\s+/).pop() || "";
  if (/(вна|чна)$/.test(last)) return { code: "Ж", label: "Жін." };
  return { code: "Ч", label: "Чол." };
};

/* ===== CITO — наскрізне термінове сповіщення по всьому RadFlow ===== */
window.isCito = function (id) { return ((window.RAD_CLINICAL[id] || {}).priority === "cito"); };
window.getCitoPatients = function (list) {
  const src = list || (window.getQueuePatients ? window.getQueuePatients() : window.RF_PATIENTS.map((p) => ({ ...p })));
  return src.filter((p) => window.isCito(p.id) && (p.status === "waiting" || p.status === "cabinet"));
};
