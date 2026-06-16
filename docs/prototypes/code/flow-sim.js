/* =====================================================================
   RadFlow — Симулятор потоку пацієнтів у реальному часі (Patient Flow)
   ---------------------------------------------------------------------
   Призначення:
     • «Оживлює» прототип: пацієнти автоматично рухаються чергою
       В черзі → Очікує → В кабінеті → Виконано (зрідка — Не відбулось),
       а дзвінки колл-листа поступово підтверджуються.
     • Усі зміни пишуться у СПІЛЬНІ сховища (rf_study_store_v1,
       rf_calllist_status_v1) і розсилаються подіями, тож дошка
       адміністратора, кабінет радіолога та колл-лист оновлюються
       синхронно в реальному часі (між вкладками — 'storage',
       у межах вкладки — 'rf-study-sync' / 'rf-call-sync').

   Координація між вкладками:
     • Lead-lock через localStorage('rf_sim_leader'): рушій крутиться лише
       в одній вкладці-лідері; решта вкладок — споживачі (просто бачать
       зміни). Якщо лідер закрито, інша вкладка перехоплює керування.

   Залежності (підключати ПІСЛЯ): queue-data.js, call-list-data.js,
     radiologist-data.js. Підключати ДО *-app.jsx не обов'язково
     (рушій самодостатній і стартує сам).
   ===================================================================== */
(function () {
  "use strict";
  if (typeof window === "undefined") return;

  var TICK_MS = 12000;          // крок симуляції (у 3 рази повільніше)
  var CABINET_DWELL_MS = 36000; // прискорений «час у кабінеті» до завершення (у 3 рази повільніше)
  var NOSHOW_PROB = 0.10;       // ймовірність неявки для запису, що «приходить»
  var LEADER_KEY = "rf_sim_leader";
  var ON_KEY = "rf_sim_on";

  var myId = "sim_" + Math.random().toString(36).slice(2);
  var entryAt = {};             // id → час входу в кабінет (пам'ять лідера)
  var timer = null;

  var cito = (typeof window.isCito === "function") ? window.isCito : function () { return false; };

  function isOn() {
    var v = localStorage.getItem(ON_KEY);
    return v === null ? true : v === "1";
  }
  function setOn(on) {
    localStorage.setItem(ON_KEY, on ? "1" : "0");
    try { window.dispatchEvent(new CustomEvent("rf-sim-toggle", { detail: { on: !!on } })); } catch (e) {}
    if (on) start();
  }

  /* Перехоплення лідерства: claim, якщо лок порожній/застарілий/наш. */
  function claimLeader() {
    var now = Date.now(), o = null;
    try { o = JSON.parse(localStorage.getItem(LEADER_KEY)); } catch (e) {}
    if (!o || (now - o.ts) > TICK_MS * 2.5 || o.id === myId) {
      try { localStorage.setItem(LEADER_KEY, JSON.stringify({ id: myId, ts: now })); } catch (e) {}
      return true;
    }
    return false;
  }

  function roomKeys() { return Object.keys(window.RF_ROOMS || {}); }

  /* Один крок симуляції — максимум одна зміна статусу за тик. */
  function step() {
    var canQueue = window.getQueuePatients && window.saveStudy && window.RF_ROOMS;
    if (canQueue) {
      var list = window.getQueuePatients();
      var now = Date.now();

      // 1) завершити пацієнта, що достатньо пробув у кабінеті
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        if (p.status === "cabinet") {
          if (!entryAt[p.id]) entryAt[p.id] = now - Math.floor(Math.random() * CABINET_DWELL_MS);
          if ((now - entryAt[p.id]) >= CABINET_DWELL_MS) {
            window.saveStudy(p.id, { status: "done", phase: "done" });
            delete entryAt[p.id];
            return true;
          }
        }
      }

      // 2) викликати «Очікує» у вільний кабінет (CITO — поза чергою, далі за часом)
      var rks = roomKeys();
      for (var r = 0; r < rks.length; r++) {
        var rk = rks[r];
        var inRoom = list.filter(function (x) { return x.room === rk; });
        var busy = inRoom.some(function (x) { return x.status === "cabinet"; });
        if (busy) continue;
        var waiting = inRoom.filter(function (x) { return x.status === "waiting"; })
          .sort(function (a, b) { return (cito(b.id) - cito(a.id)) || a.time.localeCompare(b.time); });
        if (waiting.length) {
          window.saveStudy(waiting[0].id, { status: "cabinet", phase: "cabinet" });
          entryAt[waiting[0].id] = now;
          return true;
        }
      }

      // 3) запис «приходить»: В черзі → Очікує (зрідка → Не відбулось)
      var queued = list.filter(function (x) { return x.status === "queued"; })
        .sort(function (a, b) { return a.time.localeCompare(b.time); });
      if (queued.length) {
        var q = queued[0];
        if (Math.random() < NOSHOW_PROB) window.saveStudy(q.id, { status: "noshow", phase: "waiting" });
        else window.saveStudy(q.id, { status: "waiting", phase: "waiting" });
        return true;
      }
    }

    // 4) поступове підтвердження дзвінків колл-листа
    if (window.getCallList && window.saveCallStatus) {
      var cl = window.getCallList().filter(function (x) { return x.status !== "confirmed" && x.status !== "refused"; });
      if (cl.length) { window.saveCallStatus(cl[0].id, "confirmed"); return true; }
    }

    // 5) усе термінальне → перезапуск циклу для безперервного демо
    if (canQueue) reset();
    return false;
  }

  /* Перезавантаження спільних сховищ до вихідного демо-стану. */
  function reset() {
    try {
      if (window.RAD_STORE_KEY && window.RF_PATIENTS) {
        var study = {};
        window.RF_PATIENTS.forEach(function (p) {
          study[p.id] = { status: p.status, phase: p.status === "noshow" ? "waiting" : p.status };
        });
        localStorage.setItem(window.RAD_STORE_KEY, JSON.stringify(study));
      }
      if (window.CL_STORAGE_KEY) {
        // очищаємо статуси дзвінків → колл-лист повертається до базових значень
        // моделювання (getDayPatients). Не сіємо CL_PATIENTS, щоб не перетерти
        // id сьогоднішніх пацієнтів у спільному сховищі.
        localStorage.setItem(window.CL_STORAGE_KEY, JSON.stringify({}));
      }
      Object.keys(entryAt).forEach(function (k) { delete entryAt[k]; });
      try { window.dispatchEvent(new CustomEvent("rf-study-sync", { detail: { reset: true } })); } catch (e) {}
      try { window.dispatchEvent(new CustomEvent("rf-call-sync", { detail: { reset: true } })); } catch (e) {}
    } catch (e) {}
  }

  function tick() {
    if (!isOn()) return;
    if (!claimLeader()) return; // керує інша вкладка-лідер
    try { step(); } catch (e) { /* демо-режим: помилки кроку не валять рушій */ }
  }

  function start() { if (!timer) timer = setInterval(tick, TICK_MS); }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  window.RFSim = { start: start, stop: stop, isOn: isOn, setOn: setOn, reset: reset, step: step, _id: myId };

  // автозапуск
  if (isOn()) start();
})();
