/* ===== RadFlow — Call List data (записи на завтра) ===== */
// status: 'pending' | 'confirmed' | 'noanswer' | 'callback' | 'refused'
window.CL_TOMORROW = "Записи на завтра · субота, 31 травня 2026";

window.CL_STATUS = {
  pending:   { label: "Ще не дзвонили", cls: "gray",   icon: "○" },
  confirmed: { label: "Підтверджено",   cls: "green",  icon: "✓" },
  noanswer:  { label: "Не відповідає",  cls: "orange", icon: "✗" },
  callback:  { label: "Передзвонити",   cls: "blue",   icon: "↩" },
  refused:   { label: "Відмова",        cls: "red",    icon: "✕" },
};

window.CL_PATIENTS = [
  { id: 1,  time: "08:00", name: "Коваль Тетяна Миколаївна",      age: 47, phone: "+38 067 412 33 90", proc: "МРТ головного мозку",          room: "Кабінет №1", status: "confirmed", note: "Прийде з направленням" },
  { id: 2,  time: "08:40", name: "Романюк Ігор Васильович",       age: 61, phone: "+38 050 778 21 04", proc: "КТ грудної клітки",            room: "Кабінет №2", status: "confirmed", note: "" },
  { id: 3,  time: "09:20", name: "Левченко Оксана Петрівна",      age: 38, phone: "+38 063 200 55 17", proc: "МРТ хребта",                   room: "Кабінет №1", status: "noanswer",  note: "Двічі не відповіла" },
  { id: 4,  time: "10:00", name: "Дорошенко Павло Андрійович",    age: 54, phone: "+38 097 631 88 42", proc: "КТ черевної порожнини",        room: "Кабінет №2", status: "callback",  note: "Передзвонити після 14:00" },
  { id: 5,  time: "10:45", name: "Гриценко Алла Сергіївна",       age: 29, phone: "+38 066 145 90 23", proc: "МРТ колінного суглоба",        room: "Кабінет №1", status: "pending",   note: "" },
  { id: 6,  time: "11:30", name: "Бойко Максим Олегович",         age: 33, phone: "+38 073 902 14 66", proc: "КТ голови",                    room: "Кабінет №2", status: "confirmed", note: "" },
  { id: 7,  time: "12:10", name: "Марченко Світлана Ігорівна",    age: 45, phone: "+38 095 327 70 11", proc: "МРТ плечового суглоба",        room: "Кабінет №1", status: "noanswer",  note: "" },
  { id: 8,  time: "13:00", name: "Ткачук Володимир Петрович",     age: 58, phone: "+38 050 419 02 88", proc: "КТ нирок",                     room: "Кабінет №2", status: "pending",   note: "" },
  { id: 9,  time: "13:50", name: "Савчук Ірина Олександрівна",    age: 41, phone: "+38 067 853 41 29", proc: "МРТ органів малого таза",      room: "Кабінет №1", status: "callback",  note: "Уточнити контраст" },
  { id: 10, time: "14:30", name: "Кравець Андрій Миколайович",    age: 50, phone: "+38 063 712 60 05", proc: "КТ грудної клітки з контр.",   room: "Кабінет №2", status: "confirmed", note: "" },
  { id: 11, time: "15:15", name: "Поліщук Наталія Вікторівна",    age: 36, phone: "+38 097 248 33 71", proc: "МРТ головного мозку з контр.", room: "Кабінет №1", status: "noanswer",  note: "" },
  { id: 12, time: "16:00", name: "Лебідь Дмитро Сергійович",      age: 63, phone: "+38 066 590 17 84", proc: "КТ хребта",                    room: "Кабінет №2", status: "pending",   note: "" },
];

/* Спільне збереження статусів між сторінками (колл-лист ↔ дошка) */
window.CL_STORAGE_KEY = "rf_calllist_status_v1";
window.getCallStatuses = function () {
  try { return JSON.parse(localStorage.getItem(window.CL_STORAGE_KEY)) || {}; }
  catch (e) { return {}; }
};
window.saveCallStatus = function (id, status) {
  const m = window.getCallStatuses();
  m[id] = status;
  localStorage.setItem(window.CL_STORAGE_KEY, JSON.stringify(m));
};
window.getCallList = function () {
  const stored = window.getCallStatuses();
  return window.CL_PATIENTS.map((p) => ({ ...p, status: stored[p.id] || p.status }));
};
window.clStudyType = function (proc) { return proc.trim().toUpperCase().indexOf("КТ") === 0 ? "КТ" : "МРТ"; };
