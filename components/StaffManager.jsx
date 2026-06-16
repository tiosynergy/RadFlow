"use client";

/* ===== RadFlow — Радіологи та доступи (адмін) =====
   Адміністратор створює акаунт радіолога вручну (логін, ПІБ, телефон, email,
   примітка) + призначає кабінети. Пароль радіолог задає сам на /set-password;
   адміністратор може скинути або задати пароль. Доступ до кабінетів — будь-коли. */

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import Sidebar from "@/components/Sidebar";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";

function modalityLabel(m) { return m === "MRI" ? "МРТ" : m === "CT" ? "КТ" : "Інше"; }
const EMPTY = { login: "", full_name: "", email: "", phone: "", note: "" };

export default function StaffManager({ clinicId, rooms, clinicName, adminName }) {
  const [radiologists, setRadiologists] = useState([]);
  const [radRooms, setRadRooms] = useState([]);     // [{profile_id, room_id}]
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY);
  const [formRooms, setFormRooms] = useState([]);    // cabinet ids for new account
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const roomsById = useMemo(() => { const m = {}; (rooms || []).forEach((r) => { m[r.id] = r; }); return m; }, [rooms]);

  function notify(msg, type = "success") { setToast({ msg, type }); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), 4000); }
  function setF(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  const reload = useCallback(async () => {
    const supabase = createClient();
    const [{ data: profs }, { data: rr }] = await Promise.all([
      supabase.from("profiles").select("id, login, full_name, email, phone, note, password_set").eq("clinic_id", clinicId).eq("role", "radiologist").order("full_name"),
      supabase.from("radiologist_rooms").select("profile_id, room_id").eq("clinic_id", clinicId),
    ]);
    setRadiologists(profs || []);
    setRadRooms(rr || []);
    setLoading(false);
  }, [clinicId]);

  useEffect(() => { reload(); }, [reload]);

  // Оновлюємо список при поверненні на вкладку — щоб бейдж пароля / доступи
  // не «застигали» після дій в інших вкладках (напр. /set-password).
  useEffect(() => {
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [reload]);

  const hasRoom = (profileId, roomId) => radRooms.some((x) => x.profile_id === profileId && x.room_id === roomId);

  async function createAccount() {
    if (!form.login.trim() || !form.full_name.trim() || !form.email.trim()) { notify("Заповніть логін, ПІБ та email", "error"); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/staff", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "radiologist", ...form, room_ids: formRooms }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { notify(data.error || "Помилка створення", "error"); setBusy(false); return; }
      setForm(EMPTY); setFormRooms([]);
      notify("Радіолога створено. Передайте йому логін — пароль він задасть на /set-password.", "success");
      reload();
    } catch { notify("Помилка зʼєднання із сервером", "error"); }
    setBusy(false);
  }

  async function resetPassword(profileId, label) {
    if (!window.confirm(`Скинути пароль для «${label}»?\n\nПоточний пароль перестане діяти. Користувач задасть новий на /set-password за своїм логіном.`)) return;
    const res = await fetch("/api/staff/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: profileId, action: "reset" }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { notify(data.error || "Помилка", "error"); return; }
    setRadiologists((rs) => rs.map((r) => (r.id === profileId ? { ...r, password_set: false } : r)));
    notify("Пароль скинуто — користувач задасть новий на /set-password", "info");
  }
  async function setPassword(profileId) {
    const pw = window.prompt("Новий пароль (мінімум 8 символів):");
    if (pw == null) return;
    if (pw.length < 8) { notify("Пароль мінімум 8 символів", "error"); return; }
    const res = await fetch("/api/staff/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: profileId, action: "set", password: pw }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { notify(data.error || "Помилка", "error"); return; }
    setRadiologists((rs) => rs.map((r) => (r.id === profileId ? { ...r, password_set: true } : r)));
    notify("Пароль встановлено", "success");
  }
  async function deleteRadiologist(profileId, label) {
    if (!window.confirm(`Видалити акаунт радіолога «${label}» назавжди?\n\nБудуть видалені: обліковий запис, профіль і доступи до кабінетів. Записи пацієнтів залишаться. Дію не можна скасувати.`)) return;
    const supabase = createClient();
    const { error } = await supabase.rpc("delete_clinic_member", { target: profileId });
    if (error) { notify("Помилка: " + error.message, "error"); return; }
    setRadiologists((rs) => rs.filter((r) => r.id !== profileId));
    setRadRooms((rr) => rr.filter((x) => x.profile_id !== profileId));
    notify("Акаунт радіолога видалено", "info");
  }
  async function toggleRoom(profileId, roomId) {
    const adding = !hasRoom(profileId, roomId);
    // Призначення кабінетів — через серверний роут (service-role + перевірка адміна
    // на сервері). Так запис не залежить від активної сесії в браузері.
    try {
      const res = await fetch("/api/staff/rooms", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId, roomId, action: adding ? "add" : "remove" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { notify(data.error || "Помилка зміни доступу", "error"); return; }
      setRadRooms((rr) =>
        adding ? [...rr, { profile_id: profileId, room_id: roomId }]
               : rr.filter((x) => !(x.profile_id === profileId && x.room_id === roomId))
      );
    } catch { notify("Помилка зʼєднання із сервером", "error"); }
  }

  const card = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: 20, marginBottom: 16 };

  return (
    <div className="app">
      <Sidebar clinicName={clinicName} adminName={adminName} adminRole="Адміністратор" rooms={rooms} activeNav="staff" />
      <div className="main">
        <header className="topbar">
          <div className="tb-title">
            <span className="tic">👥</span>
            <div><h1>Радіологи та доступи</h1><div className="date">{clinicName}</div></div>
          </div>
        </header>

        <div className="content" style={{ overflowY: "auto", padding: "22px", maxWidth: 900 }}>
          {/* Додати радіолога */}
          <div style={card}>
            <div className="bk-section-label" style={{ marginTop: 0 }}>Додати радіолога</div>
            <div className="fld-row">
              <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Логін *</span><input className="inp" placeholder="логін для входу" value={form.login} onChange={(e) => setF("login", e.target.value)} /></label>
              <label className="fld" style={{ flex: 1 }}><span className="fld-lab">ПІБ *</span><input className="inp" placeholder="Прізвище Імʼя По батькові" value={form.full_name} onChange={(e) => setF("full_name", e.target.value)} /></label>
            </div>
            <div className="fld-row">
              <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Email *</span><input className="inp" type="email" placeholder="radiologist@clinic.ua" value={form.email} onChange={(e) => setF("email", e.target.value)} /></label>
              <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Телефон</span><input className="inp" type="tel" placeholder="+380 XX XXX XX XX" value={form.phone} onChange={(e) => setF("phone", e.target.value)} /></label>
            </div>
            <label className="fld"><span className="fld-lab">Пароль</span><input className="inp" placeholder="Порожній — користувач задасть сам на /set-password" disabled /></label>
            <label className="fld"><span className="fld-lab">Примітка</span><input className="inp" placeholder="Коротка примітка (необовʼязково)" value={form.note} onChange={(e) => setF("note", e.target.value)} /></label>
            <div className="fld">
              <span className="fld-lab">Доступ до кабінетів</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {(rooms || []).map((r) => {
                  const on = formRooms.includes(r.id);
                  return (
                    <button key={r.id} type="button" onClick={() => setFormRooms((s) => (on ? s.filter((x) => x !== r.id) : [...s, r.id]))}
                      className={"btn btn-sm " + (on ? "btn-primary" : "btn-secondary")}>
                      {on ? "✓ " : ""}{r.name} · {modalityLabel(r.modality)}
                    </button>
                  );
                })}
                {(rooms || []).length === 0 && <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>Спершу додайте кабінети в Майстрі.</span>}
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
              <button className="btn btn-primary" disabled={busy} onClick={createAccount}>{busy ? "Створюємо…" : "Створити акаунт"}</button>
       