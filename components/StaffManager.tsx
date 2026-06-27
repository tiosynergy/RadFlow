"use client";

/* ===== RadFlow — Радіологи та доступи (адмін) =====
   Адміністратор створює акаунт радіолога вручну (логін, ПІБ, телефон, email,
   примітка) + призначає кабінети. Пароль радіолог задає сам на /set-password;
   адміністратор може скинути або задати пароль. Доступ до кабінетів — будь-коли. */

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import Sidebar from "@/components/Sidebar";
import LiveClock from "@/components/LiveClock";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";

type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null };
type StaffForm = { login: string; full_name: string; email: string; phone: string; note: string };
type Radiologist = {
  id: string; login: string | null; full_name: string | null; email: string | null;
  phone: string | null; note: string | null; password_set: boolean; invite_token: string | null;
};
type RadRoom = { profile_id: string; room_id: string };
type PwModal = { id: string; val: string; busy: boolean };

function modalityLabel(m: string) { return m === "MRI" ? "МРТ" : m === "CT" ? "КТ" : "Інше"; }
const EMPTY: StaffForm = { login: "", full_name: "", email: "", phone: "", note: "" };

interface StaffManagerProps {
  clinicId: string;
  rooms?: RoomOpt[];
  clinicName?: string;
  adminName?: string;
}

export default function StaffManager({ clinicId, rooms, clinicName, adminName }: StaffManagerProps) {
  const [radiologists, setRadiologists] = useState<Radiologist[]>([]);
  const [radRooms, setRadRooms] = useState<RadRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<StaffForm>(EMPTY);
  const [formRooms, setFormRooms] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);
  const [origin, setOrigin] = useState("");
  const [pwModal, setPwModal] = useState<PwModal | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const roomsById = useMemo(() => { const m: Record<string, RoomOpt> = {}; (rooms || []).forEach((r) => { m[r.id] = r; }); return m; }, [rooms]);
  void roomsById;

  useEffect(() => { setOrigin(window.location.origin); }, []);

  function notify(msg: string, type = "success") { setToast({ msg, type }); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), 4000); }
  function setF(k: keyof StaffForm, v: string) { setForm((f) => ({ ...f, [k]: v })); }
  async function copyLink(tok: string) {
    const link = (origin || window.location.origin) + "/set-password?token=" + encodeURIComponent(tok);
    try { await navigator.clipboard.writeText(link); notify("Посилання для входу скопійовано", "success"); }
    catch { notify(link, "info"); }
  }

  const reload = useCallback(async () => {
    const supabase = createClient();
    const [{ data: profs }, { data: rr }] = await Promise.all([
      supabase.from("profiles").select("id, login, full_name, email, phone, note, password_set, invite_token").eq("clinic_id", clinicId).eq("role", "radiologist").order("full_name"),
      supabase.from("radiologist_rooms").select("profile_id, room_id").eq("clinic_id", clinicId),
    ]);
    setRadiologists(profs || []);
    setRadRooms(rr || []);
    setLoading(false);
  }, [clinicId]);

  useEffect(() => { reload(); }, [reload]);

  // Оновлюємо список при поверненні на вкладку.
  useEffect(() => {
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [reload]);

  const hasRoom = (profileId: string, roomId: string) => radRooms.some((x) => x.profile_id === profileId && x.room_id === roomId);

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
      notify("Радіолога створено. Скопіюйте посилання для встановлення пароля в його картці нижче і передайте йому.", "success");
      reload();
    } catch { notify("Помилка зʼєднання із сервером", "error"); }
    setBusy(false);
  }

  async function resetPassword(profileId: string, label: string | null) {
    if (!window.confirm(`Скинути пароль для «${label}»?\n\nПоточний пароль перестане діяти. Користувач задасть новий на /set-password за своїм логіном.`)) return;
    const res = await fetch("/api/staff/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: profileId, action: "reset" }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { notify(data.error || "Помилка", "error"); return; }
    setRadiologists((rs) => rs.map((r) => (r.id === profileId ? { ...r, password_set: false } : r)));
    notify("Пароль скинуто — користувач задасть новий на /set-password", "info");
  }
  function setPassword(profileId: string) { setPwModal({ id: profileId, val: "", busy: false }); }
  async function submitPassword() {
    if (!pwModal || pwModal.val.length < 8) { notify("Пароль мінімум 8 символів", "error"); return; }
    setPwModal((m) => (m ? { ...m, busy: true } : m));
    const res = await fetch("/api/staff/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: pwModal.id, action: "set", password: pwModal.val }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { notify(data.error || "Помилка", "error"); setPwModal((m) => (m ? { ...m, busy: false } : m)); return; }
    setRadiologists((rs) => rs.map((r) => (r.id === pwModal.id ? { ...r, password_set: true } : r)));
    notify("Пароль встановлено", "success");
    setPwModal(null);
  }
  async function deleteRadiologist(profileId: string, label: string | null) {
    if (!window.confirm(`Видалити акаунт радіолога «${label}» назавжди?\n\nБудуть видалені: обліковий запис, профіль і доступи до кабінетів. Записи пацієнтів залишаться. Дію не можна скасувати.`)) return;
    const supabase = createClient();
    const { error } = await supabase.rpc("delete_clinic_member", { target: profileId });
    if (error) { notify("Помилка: " + error.message, "error"); return; }
    setRadiologists((rs) => rs.filter((r) => r.id !== profileId));
    setRadRooms((rr) => rr.filter((x) => x.profile_id !== profileId));
    notify("Акаунт радіолога видалено", "info");
  }
  async function toggleRoom(profileId: string, roomId: string) {
    const adding = !hasRoom(profileId, roomId);
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
      <Sidebar clinicName={clinicName} adminName={adminName} adminRole="Адміністратор" roleKey="admin" rooms={rooms} activeNav="staff" />
      <div className="main">
        <header className="topbar">
          <div className="tb-title">
            <span className="tic">👥</span>
            <div><h1>Радіологи та доступи</h1><div className="date">{clinicName} · <LiveClock /></div></div>
          </div>
        </header>

        <div className="content" style={{ overflowY: "auto", padding: "22px", maxWidth: 900 }}>
          {/* Додати радіолога */}
          <div style={card}>
            <div className="bk-section-label" style={{ marginTop: 0 }}>Додати радіолога</div>
            <div className="fld-row">
              <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Логін <span className="req">*</span></span><input className="inp" placeholder="логін для входу" value={form.login} onChange={(e) => setF("login", e.target.value)} /></label>
              <label className="fld" style={{ flex: 1 }}><span className="fld-lab">ПІБ <span className="req">*</span></span><input className="inp" placeholder="Прізвище Імʼя По батькові" value={form.full_name} onChange={(e) => setF("full_name", e.target.value)} /></label>
            </div>
            <div className="fld-row">
              <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Email <span className="req">*</span></span><input className="inp" type="email" placeholder="radiologist@clinic.ua" value={form.email} onChange={(e) => setF("email", e.target.value)} /></label>
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
            </div>
            <div className="hint-blue">Пароль не задається тут: після створення скопіюйте в картці радіолога <b>персональне посилання</b> й передайте йому — він встановить пароль сам. Забув пароль — натисніть «Скинути», зʼявиться нове посилання.</div>
          </div>

          {/* Радіологи */}
          <div style={card}>
            <div className="bk-section-label" style={{ marginTop: 0 }}>Радіологи клініки ({radiologists.length})</div>
            {loading ? (
              <div style={{ color: "var(--text-muted)", padding: 8 }}>Завантаження…</div>
            ) : radiologists.length === 0 ? (
              <div style={{ color: "var(--text-muted)", padding: 8, fontSize: 13 }}>Поки немає радіологів. Додайте їх вище.</div>
            ) : radiologists.map((r) => (
              <div key={r.id} style={{ padding: "14px 0", borderTop: "1px solid var(--border)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{r.full_name || r.login || r.email}</div>
                    <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                      {r.login ? "@" + r.login + " · " : ""}{r.email}{r.phone ? " · " + r.phone : ""}
                    </div>
                    {r.note && <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>{r.note}</div>}
                  </div>
                  <span className={"badge " + (r.password_set ? "green" : "yellow")}>{r.password_set ? "🔒 Пароль встановлено" : "Пароль не задано"}</span>
                  <button className="btn btn-secondary btn-sm" title="Користувач задасть пароль наново" onClick={() => resetPassword(r.id, r.full_name || r.login)}>Скинути пароль</button>
                  <button className="btn btn-secondary btn-sm" title="Задати пароль вручну" onClick={() => setPassword(r.id)}>Задати пароль</button>
                  <button className="btn btn-secondary btn-sm qd-act-red" title="Видалити акаунт назавжди" onClick={() => deleteRadiologist(r.id, r.full_name || r.login)}>🗑</button>
                </div>
                {!r.password_set && r.invite_token && (
                  <div style={{ fontSize: 12, marginTop: 8, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span style={{ color: "var(--text-muted)" }}>🔗 Посилання для встановлення пароля:</span>
                    <code style={{ fontSize: 11.5, color: "var(--text-secondary)", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>/set-password?token=…</code>
                    <button className="btn btn-secondary btn-sm" onClick={() => copyLink(r.invite_token as string)}>Скопіювати</button>
                  </div>
                )}
                <div style={{ marginTop: 10 }}>
                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Доступ до кабінетів:</span>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
                    {(rooms || []).map((rm) => {
                      const on = hasRoom(r.id, rm.id);
                      return (
                        <button key={rm.id} type="button" onClick={() => toggleRoom(r.id, rm.id)}
                          className={"btn btn-sm " + (on ? "btn-primary" : "btn-secondary")}>
                          {on ? "✓ " : ""}{rm.name} · {modalityLabel(rm.modality)}
                        </button>
                      );
                    })}
                    {(rooms || []).length === 0 && <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>Немає кабінетів.</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {pwModal && (
        <div className="overlay" onClick={() => !pwModal.busy && setPwModal(null)}>
          <div className="dialog fade-in" style={{ maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
            <div className="dlg-head"><div className="dlg-title">Задати пароль</div><button className="icon-btn" onClick={() => setPwModal(null)}>✕</button></div>
            <div className="dlg-body">
              <label className="fld" style={{ marginBottom: 0 }}><span className="fld-lab">Новий пароль (мінімум 8 символів)</span>
                <input className="inp" type="password" autoFocus value={pwModal.val}
                  onChange={(e) => setPwModal((m) => (m ? { ...m, val: e.target.value } : m))}
                  onKeyDown={(e) => { if (e.key === "Enter") submitPassword(); }} placeholder="Пароль" />
              </label>
            </div>
            <div className="dlg-foot" style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => setPwModal(null)}>Скасувати</button>
              <button className="btn btn-primary" disabled={pwModal.busy || pwModal.val.length < 8} onClick={submitPassword}>{pwModal.busy ? "Зберігаємо…" : "Встановити"}</button>
            </div>
          </div>
        </div>
      )}
      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "var(--card)", border: "1px solid var(--border-strong)", borderLeft: "4px solid " + (toast.type === "error" ? "var(--red)" : "var(--green)"), borderRadius: 12, padding: "12px 18px", boxShadow: "var(--shadow-pop)", zIndex: 50, fontSize: 13.5, maxWidth: 440 }}>{toast.msg}</div>
      )}
    </div>
  );
}
