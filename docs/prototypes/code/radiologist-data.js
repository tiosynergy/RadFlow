/* ===== RadFlow — Radiologist workspace data ===== */

window.RAD_PROFILE = {
  name: "Левчук Андрій Миколайович",
  role: "Радіолог",
  spec: "МРТ / КТ діагностика",
  cabinets: ["r1", "r2", "r3", "r4"], // кабінети, авторизовані Адміністратором для цього радіолога
  initials: "ЛА",
};

window.RAD_PRIORITY = {
  planned: { label: "Плановий", cls: "gray" },
  urgent:  { label: "Терміновий", cls: "orange" },
  cito:    { label: "CITO", cls: "red" },
};

/* Клінічний контекст за пацієнтом (показання, направник, контраст, регіон) */
window.RAD_CLINICAL = {
  1:  { docId: 2, priority: "planned", region: "Колінний суглоб, права нога", contrast: false, indication: "Біль та обмеження рухливості після травми. Підозра на пошкодження меніска.", weight: 78 },
  3:  { docId: 1, priority: "planned", region: "Хребет, поперековий відділ", contrast: false, indication: "Хронічний біль у попереку, іррадіація в ліву ногу. Виключити грижу диска.", weight: 64 },
  5:  { docId: 3, priority: "urgent", region: "Головний мозок", contrast: true, indication: "Контроль після терапії. Динаміка вогнища.", weight: 70 },
  6:  { docId: 1, priority: "urgent", region: "Головний мозок", contrast: false, indication: "Тривалі головні болі, епізоди запаморочення. Виключити органічну патологію.", weight: 82 },
  7:  { docId: 3, priority: "cito", region: "Черевна порожнина", contrast: true, indication: "Гострий біль у правому підребер'ї. Підозра на об'ємний процес.", weight: 59 },
  8:  { docId: 2, priority: "planned", region: "Плечовий суглоб, ліве плече", contrast: false, indication: "Обмеження відведення руки, підозра на розрив ротаторної манжети.", weight: 71 },
  10: { docId: 1, priority: "planned", region: "Черевна порожнина", contrast: false, indication: "Скринінг, дискомфорт у животі.", weight: 88 },
  12: { docId: 3, priority: "urgent", region: "Головний мозок", contrast: false, indication: "Післяопераційний контроль.", weight: 75 },
  14: { docId: 2, priority: "planned", region: "Колінний суглоб, ліва нога", contrast: false, indication: "Спортивна травма, біль при навантаженні.", weight: 69 },
  15: { docId: 1, priority: "cito", region: "Головний мозок", contrast: false, indication: "Гостра неврологічна симптоматика. Виключити ГПМК.", weight: 80 },
  16: { docId: 1, priority: "planned", region: "Хребет, шийний відділ", contrast: false, indication: "Болі в шиї, оніміння пальців рук.", weight: 62 },
  17: { docId: 2, priority: "planned", region: "Колінний суглоб", contrast: false, indication: "Контроль після консервативного лікування.", weight: 73 },
  // КТ
  2:  { docId: 3, priority: "planned", region: "Органи грудної клітки", contrast: false, indication: "Скринінг, кашель понад 3 тижні.", weight: 90 },
  4:  { docId: 1, priority: "urgent", region: "Голова", contrast: false, indication: "Травма голови, виключити внутрішньочерепну гематому.", weight: 85 },
  9:  { docId: 3, priority: "planned", region: "Органи грудної клітки", contrast: false, indication: "Контроль вузлика у легені.", weight: 66 },
  11: { docId: 1, priority: "planned", region: "Нирки та сечовивідні шляхи", contrast: false, indication: "Підозра на конкременти.", weight: 77 },
  13: { docId: 3, priority: "urgent", region: "Органи грудної клітки", contrast: true, indication: "Підозра на ТЕЛА.", weight: 81 },
  19: { docId: 3, priority: "planned", region: "Органи грудної клітки", contrast: false, indication: "Профогляд.", weight: 79 },
  20: { docId: 1, priority: "planned", region: "Голова", contrast: false, indication: "Головні болі.", weight: 58 },
  21: { docId: 1, priority: "planned", region: "Черевна порожнина", contrast: false, indication: "Біль у животі.", weight: 84 },
  23: { docId: 3, priority: "planned", region: "Органи грудної клітки", contrast: false, indication: "Скринінг.", weight: 72 },
};

/* Шаблони протоколу за типом */
window.RAD_TEMPLATES = {
  "МРТ головного мозку": {
    description: "На серії МР-томограм головного мозку у трьох проекціях, Т1- та Т2-зважених зображеннях: серединні структури не зміщені. Шлуночкова система не розширена, симетрична. Субарахноїдальні простори не змінені. Вогнищевих змін речовини мозку не виявлено.",
    conclusion: "МР-картина без вогнищевої та об'ємної патології головного мозку.",
  },
  "МРТ хребта": {
    description: "На серії МР-томограм хребта: фізіологічний лордоз збережений. Висота тіл хребців не знижена. Сигнал від кісткового мозку не змінений. Міжхребцеві диски звичайної висоти та інтенсивності сигналу.",
    conclusion: "МР-ознаки початкових дегенеративно-дистрофічних змін. Без ознак компресії.",
  },
  "МРТ суглоба": {
    description: "На серії МР-томограм суглоба: кісткові структури без травматичних змін. Суглобовий хрящ збережений. Зв'язковий апарат цілісний. Випіт у порожнині суглоба не визначається.",
    conclusion: "МР-картина без гострої травматичної патології.",
  },
  "КТ грудної клітки": {
    description: "На серії КТ органів грудної клітки: легеневий малюнок не посилений. Вогнищевих та інфільтративних змін у легенях не виявлено. Корені структурні. Середостіння не розширене. Вільної рідини у плевральних порожнинах немає.",
    conclusion: "КТ-картина без патологічних змін органів грудної клітки.",
  },
  "КТ голови": {
    description: "На серії КТ головного мозку: серединні структури не зміщені. Шлуночкова система симетрична, не розширена. Вогнищевих змін щільності речовини мозку не виявлено. Кістки склепіння та основи черепа без травматичних ушкоджень.",
    conclusion: "КТ-картина без гострої патології головного мозку.",
  },
  "КТ черевної порожнини": {
    description: "На серії КТ органів черевної порожнини: печінка, селезінка, підшлункова залоза, нирки звичайних розмірів та структури. Вільної рідини не виявлено. Лімфовузли не збільшені.",
    conclusion: "КТ-картина без об'ємної патології органів черевної порожнини.",
  },
};

window.radTemplateFor = function (proc) {
  const p = (proc || "").toLowerCase();
  if (p.includes("мрт") && p.includes("мозк")) return "МРТ головного мозку";
  if (p.includes("мрт") && p.includes("хреб")) return "МРТ хребта";
  if (p.includes("мрт") && p.includes("суглоб")) return "МРТ суглоба";
  if (p.includes("кт") && (p.includes("грудн"))) return "КТ грудної клітки";
  if (p.includes("кт") && (p.includes("голов") || p.includes("голови"))) return "КТ голови";
  if (p.includes("кт") && p.includes("черевн")) return "КТ черевної порожнини";
  return null;
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
};
/* Пацієнти з накладеними статусами зі сховища (для синхронізації) */
window.getQueuePatients = function () {
  const store = window.getStudyStore();
  return window.RF_PATIENTS.map((p) => {
    const s = store[p.id];
    return s && s.status ? Object.assign({}, p, { status: s.status }) : Object.assign({}, p);
  });
};
window.studyType = function (proc) { return (proc || "").trim().toUpperCase().indexOf("КТ") === 0 ? "КТ" : "МРТ"; };

/* ===== Kanban board helpers ===== */
// Час очікування (хв) для пацієнтів у черзі — кольорове кодування: <30 зел, 30-60 жовт, >60 черв
window.RAD_WAIT = { 8: 42, 9: 8, 10: 25, 11: 67, 12: 15, 13: 50, 14: 5, 16: 38, 17: 72, 20: 18, 21: 55, 23: 33 };

window.radWaitMin = function (p) {
  if (p.status === "waiting") return window.RAD_WAIT[p.id] != null ? window.RAD_WAIT[p.id] : 12;
  return 0;
};
window.radWaitColor = function (min) { return min > 60 ? "red" : min >= 30 ? "yellow" : "green"; };

window.radGender = function (name) {
  const last = (name || "").trim().split(/\s+/).pop() || "";
  if (/(вна|чна)$/.test(last)) return { code: "Ж", label: "Жін." };
  return { code: "Ч", label: "Чол." };
};
window.radAccession = function (id) { return "RF-2026-" + String(id).padStart(4, "0"); };

// Колонки канбану (фази роботи радіолога)
window.RAD_COLUMNS = [
  { key: "waiting", label: "Очікує", cls: "gray", icon: "◷" },
  { key: "cabinet", label: "Сканування", cls: "blue", icon: "▶" },
  { key: "ready", label: "Готово до опису", cls: "purple", icon: "✎" },
  { key: "done", label: "Виконано", cls: "green", icon: "✓" },
];
window.radPhase = function (p) {
  const s = window.getStudyStore()[p.id] || {};
  if (s.phase) return s.phase;
  if (p.status === "done") return "done";
  if (p.status === "cabinet") return "cabinet";
  return "waiting";
};
window.radPhaseToStatus = function (phase) {
  if (phase === "done") return "done";
  if (phase === "cabinet" || phase === "ready") return "cabinet";
  return "waiting";
};

/* ===== CITO — наскрізне термінове сповіщення по всьому RadFlow ===== */
window.isCito = function (id) { return ((window.RAD_CLINICAL[id] || {}).priority === "cito"); };
window.getCitoPatients = function (list) {
  const src = list || (window.getQueuePatients ? window.getQueuePatients() : window.RF_PATIENTS.map((p) => ({ ...p })));
  return src.filter((p) => window.isCito(p.id) && (p.status === "waiting" || p.status === "cabinet"));
};
