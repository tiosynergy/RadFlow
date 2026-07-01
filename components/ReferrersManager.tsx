"use client";

/* ===== RadFlow — Лікарі-направники (адмін, крос-клінічна модель) =====
   Доступ направника до центру = referral_access. Адмін центру:
   • запрошує направника (логін/ПІБ/телефон обовʼязкові, email — ні);
   • обирає, до яких КАБІНЕТІВ центру направник має доступ;
   • підтверджує/відхиляє запити направників; відкликає доступ. */

import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";
import Sidebar from "@/components/Sidebar";
import LiveClock from "@/components/LiveClock";
import PhoneInput from "@/components/PhoneInput";
import HelpTip from "@/components/HelpTip";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";

type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null };
type ReferrerProfile = { id?: string; login?: string | null; full_name?: string | null; phone?: string | null; note?: string | null; password_set?: boolean; invite_token?: string | null };
type AccessRow = { access_id: string; referrer_id: string; status: string; policy: string | null; room_ids: string[] | null; note: string | null; referrer: ReferrerProfile };
type InviteForm = { login: string; full_name: string; email: string; phone: string; note: string; policy: string; room_ids: string[] };
type EditForm = { policy: string; room_ids: string[]; note: string };
type LoginSug = { id: string; login: string | null; full_name: string | null };
type StrKey = "login" | "full_name" | "email" | "phone" | "note" | "policy";
type ApiResult = { ok: boolean; data: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

function modalityLabel(m: string) { return m === "MRI" ? "МРТ" : m === "CT" ? "КТ" : "Інше"; }

const ACCESS_ST: Record<string, { label: string; cls: string }> = {
  active: { label: "Активний", cls: "green" },
  pending_clinic: { label: "Запит на доступ", cls: "yellow" },
  pending_referrer: { label: "Запрошено — очікує лікаря", cls: "blue" },
  revoked: { label: "Відкликано", cls: "gray" },
  declined: { label: "Відхилено", cls: "gray" },
};

async function postJSON(url: string, body: unknown): Promise<ApiResult> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  } catch { return { ok: false, data: { error: "Помилка зʼєднання із сервером" } }; }
}

interface ReferrersManagerProps {
  clinicId: string;
  rooms?: RoomOpt[];
  clinicName?: string;
  adminName?: string;
  embedded?: boolean;
}

export default function ReferrersManager({ clinicId, rooms, clinicName, adminName, embedded = false }: ReferrersManagerProps) {
  const allRoomIds = (rooms || []).map((r) => r.id);
  const roomById: Record<string, RoomOpt> = {}; (rooms || []).forEach((r) => { roomById[r.id] = r; });
  const emptyForm = (): InviteForm => ({ login: "", full_name: "", email: "", phone: "", note: "", policy: "direct", room_ids: allRoomIds });

  const [rows, setRows] = useState<AccessRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<InviteForm>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);
  const [origin, setOrigin] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({ policy: "direct", room_ids: [], note: "" });
  const [savingEdit, setSavingEdit] = useState(false);
  const [loginSug, setLoginSug] = useState<LoginSug[]>([]);
  const [sugOpen, setSugOpen] = useState(false);
  const [existingPicked, setExistingPicked] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { setOrigin(window.location.origin); }, []);

  // Автодоповнення логіну: шукаємо вже існуючих у RadFlow направників (RPC).
  useEffect(() => {
    const q = form.login.trim();
    if (existingPicked || q.length < 2) { setLoginSug([]); return; }
    let active = true;
    const t = setTimeout(async () => {
      const supabase = createClient();
      const { data } = await supabase.rpc("search_referrers", { q });
      if (active) setLoginSug(data || []);
    }, 250);
    return () => { active = false; clearTimeout(t); };
  }, [form.login, existingPicked]);

  function pickReferrer(s: LoginSug) {
    setForm((f) => ({ ...f, login: s.login || "", full_name: s.full_name || "" }));
    setExistingPicked(true);
    setSugOpen(false);
    setLoginSug([]);
  }

  function notify(msg: string, type = "success") { setToast({ msg, type }); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), 4500); }
  async function copyLink(tok: string) {
    const link = (origin || window.location.origin) + "/set-password?token=" + encodeURIComponent(tok);
    try { await navigator.clipboard.writeText(link); notify("Посилання для входу скопійовано", "success"); }
    catch { notify(link, "info"); }
  }
  function setF(k: StrKey, v: string) { setForm((f) => ({ ...f, [k]: v })); }
  function toggleRoom(id: string) { setForm((f) => ({ ...f, room_ids: f.room_ids.includes(id) ? f.room_ids.filter((x) => x !== id) : [...f.room_ids, id] })); }

  function roomsLabel(room_ids: string[] | null) {
    if (!room_ids || room_ids.length === 0) return "усі кабінети";
    return room_ids.map((id) => {
      const rm = roomById[id];
      if (!rm) return "?";
      return rm.name + (rm.apparatus_model ? " (" + rm.apparatus_model + ")" : "");
    }).join(", ");
  }

  const reload = useCallback(async () => {
    const supabase = createClient();
    const { data: access } = await supabase
      .from("referral_access")
      .select("id, referrer_id, status, policy, room_ids, note, created_at")
      .eq("clinic_id", clinicId)
      .order("created_at", { ascending: false });
    const list = access || [];
    const ids = Array.from(new Set(list.map((a) => a.referrer_id)));
    const profById: Record<string, ReferrerProfile> = {};
    if (ids.length) {
      const { data: profs } = await supabase.from("profiles").select("id, login, full_name, phone, note, password_set, invite_token").in("id", ids);
      (profs || []).forEach((p) => { profById[p.id] = p; });
    }
    setRows(list.map((a) => ({ access_id: a.id, referrer_id: a.referrer_id, status: a.status, policy: a.policy, room_ids: a.room_ids, note: a.note, referrer: profById[a.referrer_id] || {} })));
    setLoading(false);
  }, [clinicId]);

  // Realtime (TD-3 — единый хук).
  useRealtimeRefetch({
    channelName: clinicId ? "ref-access-" + clinicId : null,
    subscriptions: [
      { table: "referral_access", filter: "clinic_id=eq." + clinicId, onChange: reload },
    ],
  });

  async function invite() {
    if (!form.login.trim()) { notify("Вкажіть логін направника", "error"); return; }
    if (!existingPicked && (!form.full_name.trim() || !form.phone.trim())) { notify("Для нового направника вкажіть ПІБ і телефон", "error"); return; }
    setBusy(true);
    const room_ids = (form.room_ids.length === 0 || form.room_ids.length === allRoomIds.length) ? null : form.room_ids;
    const { ok, data } = await postJSON("/api/referrers/invite", { ...form, room_ids });
    setBusy(false);
    if (!ok) { notify(data.error || "Помилка", "error"); return; }
    setForm(emptyForm());
    setExistingPicked(false);
    if (data.status === "active") {
      notify("Доступ активовано (лікар уже надсилав запит)", "success");
    } else if (data.created_account) {
      notify("Акаунт створено. Скопіюйте посилання для входу в картці направника нижче і передайте лікарю.", "info");
    } else {
      notify("Запрошення надіслано. Лікар прийме його у вкладці «Мої центри».", "success");
    }
    reload();
  }

  async function resetPassword(r: AccessRow) {
    const name = r.referrer.full_name || r.referrer.login || "лікаря";
    if (!window.confirm(`Скинути пароль для «${name}»?\n\nПоточний пароль перестане діяти. Лікар задасть новий за посиланням (зʼявиться у картці нижче — скопіюйте й передайте йому).`)) return;
    setBusyId(r.access_id);
    const { ok, data } = await postJSON("/api/staff/password", { userId: r.referrer_id, action: "reset" });
    setBusyId(null);
    if (!ok) { notify(data.error || "Помилка", "error"); return; }
    setRows((rs) => rs.map((x) => (x.referrer_id === r.referrer_id ? { ...x, referrer: { ...x.referrer, password_set: false, invite_token: data.invite_token } } : x)));
    notify("Пароль скинуто — скопіюйте нове посилання для входу й передайте лікарю", "success");
  }

  async function decide(accessId: string, decision: string) {
    setBusyId(accessId);
    const { ok, data } = await postJSON("/api/referral/access/decide", { access_id: accessId, decision });
    setBusyId(null);
    if (!ok) { notify(data.error || "Помилка", "error"); return; }
    notify(decision === "approve" ? "Доступ підтверджено" : decision === "revoke" ? "Доступ відкликано" : "Запит відхилено", "success");
    reload();
  }

  async function reinvite(r: AccessRow) {
    setBusyId(r.access_id);
    const { ok, data } = await postJSON("/api/referrers/invite", {
      login: r.referrer.login || "",
      full_name: r.referrer.full_name || "",
      phone: r.referrer.phone || "",
      email: "",
      note: r.note || "",
      policy: r.policy || "direct",
      room_ids: r.room_ids || null,
    });
    setBusyId(null);
    if (!ok) { notify(data.error || "Помилка", "error"); return; }
    notify("Запрошення надіслано повторно — очікує підтвердження лікаря", "success");
    reload();
  }

  function startEdit(r: AccessRow) {
    setEditingId(r.access_id);
    setEditForm({ policy: r.policy || "direct", room_ids: (r.room_ids && r.room_ids.length ? r.room_ids : allRoomIds), note: r.note || "" });
  }
  function toggleEditRoom(id: string) { setEditForm((f) => ({ ...f, room_ids: f.room_ids.includes(id) ? f.room_ids.filter((x) => x !== id) : [...f.room_ids, id] })); }
  async function saveEdit() {
    setSavingEdit(true);
    const room_ids = (editForm.room_ids.length === 0 || editForm.room_ids.length === allRoomIds.length) ? null : editForm.room_ids;
    const { ok, data } = await postJSON("/api/referral/access/decide", { access_id: editingId, decision: "update", policy: editForm.policy, room_ids, note: editForm.note });
    setSavingEdit(false);
    if (!ok) { notify(data.error || "Помилка", "error"); return; }
    notify("Налаштування збережено", "success");
    setEditingId(null);
    reload();
  }

  const requests = rows.filter((r) => r.status === "pending_clinic");
  const active = rows.filter((r) => r.status === "active");
  const invited = rows.filter((r) => r.status === "pending_referrer");
  const history = rows.filter((r) => r.status === "revoked" || r.status === "declined");

  const card = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: 20, marginBottom: 16 };
  const req = <span style={{ color: "var(--red)" }}> *</span>;

  function Row({ r, children, onClick, expandable, expanded }: { r: AccessRow; children?: ReactNode; onClick?: () => void; expandable?: boolean; expanded?: boolean }) {
    const m = ACCESS_ST[r.status] || ACCESS_ST.active;
    const name = r.referrer.full_name || r.referrer.login || "Лікар";
    return (
      <div onClick={onClick} title={expandable ? (expanded ? "Згорнути налаштування" : "Натисніть, щоб змінити налаштування") : undefined} style={{ padding: "14px 0", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", cursor: onClick ? "pointer" : "default" }}>
        {expandable && <span style={{ color: "var(--text-muted)", fontSize: 13, width: 12, flexShrink: 0, display: "inline-block", transition: "transform .15s", transform: expanded ? "rotate(90deg)" : "none" }}>▸</span>}
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{name}</div>
          <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{r.referrer.login ? "@" + r.referrer.login : ""}{r.referrer.phone ? " · " + r.referrer.phone : ""}</div>
          {r.referrer.note && <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }} title="Примітка лікаря (редагує сам направник)">📝 {r.referrer.note}</div>}
          {r.note && <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>{r.note}</div>}
          {r.status === "active" && <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>Режим: {r.policy === "confirm" ? "з підтвердженням оператора" : "пряма черга"} · Кабінети: {roomsLabel(r.room_ids)}</div>}
          {!r.referrer.password_set && r.referrer.invite_token && (
            <div style={{ fontSize: 12, marginTop: 4, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ color: "var(--text-muted)" }}>🔗 Посилання для входу:</span>
              <code style={{ fontSize: 11.5, color: "var(--text-secondary)", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>/set-password?token=…</code>
              <button className="btn btn-secondary btn-sm" onClick={(e) => { e.stopPropagation(); copyLink(r.referrer.invite_token as string); }}>Скопіювати</button>
            </div>
          )}
        </div>
        <span className={"badge " + m.cls}>{m.label}</span>
        {children}
      </div>
    );
  }

  return (
    <div className={embedded ? "setup-embed" : "app"}>
      {!embedded && <Sidebar clinicName={clinicName} adminName={adminName} adminRole="Адміністратор" roleKey="admin" rooms={rooms} activeNav="referrers" />}
      <div className={embedded ? "setup-embed-main" : "main"}>
        {!embedded && (
          <header className="topbar">
            <div className="tb-title">
              <span className="tic">🩺</span>
              <div><h1>Лікарі-направники</h1><div className="date">{clinicName} · <LiveClock /></div></div>
            </div>
          </header>
        )}

        <div className={embedded ? undefined : "content"} style={embedded ? undefined : { overflowY: "auto", padding: "22px", maxWidth: 900 }}>
          {/* Запросити лікаря */}
          <div style={card}>
            <div className="bk-section-label" style={{ marginTop: 0 }}>Запросити лікаря-направника</div>
            <div className="fld-row">
              <label className="fld" style={{ flex: 1, position: "relative" }}>
                <span className="fld-lab" style={{ color: "var(--red)" }}>Логін{req}</span>
                <input className="inp" placeholder="логін направника" value={form.login} autoComplete="off"
                  onChange={(e) => { setF("login", e.target.value); setExistingPicked(false); setSugOpen(true); }}
                  onFocus={() => setSugOpen(true)}
                  onBlur={() => setTimeout(() => setSugOpen(false), 150)} />
                {sugOpen && !existingPicked && loginSug.length > 0 && (
                  <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 30, background: "var(--card)", border: "1px solid var(--border-strong)", borderRadius: "var(--r-md)", marginTop: 4, boxShadow: "var(--shadow-pop)", overflow: "hidden" }}>
                    {loginSug.map((s) => (
                      <button type="button" key={s.id} onMouseDown={(e) => { e.preventDefault(); pickReferrer(s); }}
                        style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", background: "transparent", border: "none", borderTop: "1px solid var(--border)", cursor: "pointer", color: "var(--text)" }}>
                        <span style={{ fontWeight: 600, fontSize: 13 }}>@{s.login}</span>
                        {s.full_name ? <span style={{ color: "var(--text-muted)", fontSize: 12.5 }}> · {s.full_name}</span> : null}
                      </button>
                    ))}
                  </div>
                )}
              </label>
              <label className="fld" style={{ flex: 1 }}><span className="fld-lab" style={{ color: existingPicked ? "var(--text-muted)" : "var(--red)" }}>ПІБ{existingPicked ? "" : req}</span><input className="inp" placeholder="Прізвище Імʼя По батькові" value={form.full_name} readOnly={existingPicked} style={existingPicked ? { opacity: 0.6 } : undefined} onChange={(e) => setF("full_name", e.target.value)} /></label>
            </div>
            {existingPicked && (
              <div className="hint-blue" style={{ marginTop: 0 }}>Лікар <b>@{form.login}</b> уже зареєстрований у RadFlow. ПІБ, телефон і пароль уже є — повторно вводити не треба. Він підтвердить запрошення у вкладці «Мої центри». <span style={{ color: "var(--blue)", cursor: "pointer" }} onClick={() => { setExistingPicked(false); setForm((f) => ({ ...f, login: "", full_name: "" })); }}>Скинути</span></div>
            )}
            {!existingPicked && (
              <div className="fld-row">
                <label className="fld" style={{ flex: 1 }}><span className="fld-lab" style={{ color: "var(--red)" }}>Телефон{req}</span><PhoneInput required value={form.phone} onChange={(v) => setF("phone", v)} /></label>
                <span className="fld-spacer" style={{ flex: 1 }} />
              </div>
            )}
            <div className="fld-row">
              <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Режим бронювання <HelpTip label="Режим бронювання направника" text={<><b>Пряма черга</b> — направлення направника одразу потрапляє в чергу. <b>З підтвердженням оператора</b> — спершу реєстратор підтверджує запис, і лише тоді він стає в чергу.</>} /></span>
                <select className="inp" value={form.policy} onChange={(e) => setF("policy", e.target.value)}>
                  <option value="direct">Пряма черга (одразу в чергу)</option>
                  <option value="confirm">З підтвердженням оператора</option>
                </select>
              </label>
              <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Примітка</span><input className="inp" placeholder="напр. спеціалізація" value={form.note} onChange={(e) => setF("note", e.target.value)} /></label>
            </div>
            <div className="fld">
              <span className="fld-lab">Доступні кабінети</span>
              {(rooms || []).length === 0 ? (
                <div className="ctx-hint" style={{ fontSize: 12.5 }}>У центрі ще немає кабінетів — додайте їх у Майстрі налаштування.</div>
              ) : (
                <div className="bd-rooms">
                  {(rooms || []).map((r) => {
                    const on = form.room_ids.includes(r.id);
                    return (
                      <button type="button" key={r.id} className="bd-room" onClick={() => toggleRoom(r.id)} title={on ? "Доступний — натисніть, щоб прибрати" : "Недоступний — натисніть, щоб додати"}
                        style={{ padding: "5px 9px", gap: 8, borderColor: on ? "var(--green)" : undefined, background: on ? "var(--green-bg)" : undefined }}>
                        <span className={"bd-room-kind " + (r.modality === "MRI" ? "mrt" : "ct")} style={{ width: 26, height: 26, fontSize: 10 }}>{modalityLabel(r.modality)}</span>
                        <span className="bd-room-meta"><span className="bd-room-name">{r.name}</span><span className="bd-room-model">{r.apparatus_model || ""}</span></span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
              <button className="btn btn-primary" disabled={busy} onClick={invite}>{busy ? "Надсилаємо…" : "Запросити"}</button>
            </div>
            <div className="hint-blue">Якщо акаунта ще немає — створимо глобальний акаунт направника. Пароль лікар задасть <b>самостійно за посиланням</b> (зʼявиться у картці направника нижче — скопіюйте кнопкою й передайте йому). Вхід — за логіном. <b>Email лікар вкаже сам</b> у своєму профілі (для відновлення доступу) — він не видимий центрам.</div>
          </div>

          {/* Запити на доступ */}
          {requests.length > 0 && (
            <div style={card}>
              <div className="bk-section-label" style={{ marginTop: 0 }}>Запити на доступ ({requests.length})</div>
              {requests.map((r) => (
                <Row key={r.access_id} r={r}>
                  <button className="btn btn-primary btn-sm" disabled={busyId === r.access_id} onClick={() => decide(r.access_id, "approve")}>Підтвердити</button>
                  <button className="btn btn-secondary btn-sm" disabled={busyId === r.access_id} onClick={() => decide(r.access_id, "decline")}>Відхилити</button>
                </Row>
              ))}
            </div>
          )}

          {/* Активні */}
          <div style={card}>
            <div className="bk-section-label" style={{ marginTop: 0 }}>Активні направники ({active.length})</div>
            {loading ? <div style={{ color: "var(--text-muted)", padding: 8 }}>Завантаження…</div>
              : active.length === 0 ? <div style={{ color: "var(--text-muted)", padding: 8, fontSize: 13 }}>Поки немає активних направників. Запросіть лікаря вище.</div>
              : active.map((r) => (
                <div key={r.access_id}>
                  <Row r={r} expandable expanded={editingId === r.access_id} onClick={() => (editingId === r.access_id ? setEditingId(null) : startEdit(r))}>
                    {r.referrer.password_set && r.referrer.id && (
                      <button className="btn btn-secondary btn-sm" disabled={busyId === r.access_id} onClick={(e) => { e.stopPropagation(); resetPassword(r); }} title="Скинути пароль — лікар задасть новий за посиланням">Скинути пароль</button>
                    )}
                    <button className="btn btn-secondary btn-sm qd-act-red" disabled={busyId === r.access_id} onClick={(e) => { e.stopPropagation(); if (window.confirm("Відкликати доступ для «" + (r.referrer.full_name || r.referrer.login) + "»?\n\nСтворені ним направлення лишаться. Нові він створювати не зможе.")) decide(r.access_id, "revoke"); }}>Відкликати доступ</button>
                  </Row>
                  {editingId === r.access_id && (
                    <div style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", padding: 16, margin: "4px 0 8px" }}>
                      <div className="ctx-hint" style={{ fontSize: 12, marginBottom: 10 }}>Дані направника (ПІБ, телефон, примітки) лікар редагує сам у своєму профілі. Тут — лише налаштування доступу до вашого центру.</div>
                      <div className="fld-row">
                        <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Режим бронювання <HelpTip label="Режим бронювання направника" text={<><b>Пряма черга</b> — направлення направника одразу потрапляє в чергу. <b>З підтвердженням оператора</b> — спершу реєстратор підтверджує запис, і лише тоді він стає в чергу.</>} /></span>
                          <select className="inp" value={editForm.policy} onChange={(e) => setEditForm((f) => ({ ...f, policy: e.target.value }))}>
                            <option value="direct">Пряма черга (одразу в чергу)</option>
                            <option value="confirm">З підтвердженням оператора</option>
                          </select>
                        </label>
                        <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Примітка</span><input className="inp" value={editForm.note} onChange={(e) => setEditForm((f) => ({ ...f, note: e.target.value }))} /></label>
                      </div>
                      <div className="fld">
                        <span className="fld-lab">Доступні кабінети</span>
                        {(rooms || []).length === 0 ? <div className="ctx-hint" style={{ fontSize: 12.5 }}>У центрі немає кабінетів.</div> : (
                          <div className="bd-rooms">
                            {(rooms || []).map((rm) => {
                              const on = editForm.room_ids.includes(rm.id);
                              return (
                                <button type="button" key={rm.id} className="bd-room" onClick={() => toggleEditRoom(rm.id)} title={on ? "Доступний — натисніть, щоб прибрати" : "Недоступний — натисніть, щоб додати"}
                                  style={{ padding: "5px 9px", gap: 8, borderColor: on ? "var(--green)" : undefined, background: on ? "var(--green-bg)" : undefined }}>
                                  <span className={"bd-room-kind " + (rm.modality === "MRI" ? "mrt" : "ct")} style={{ width: 26, height: 26, fontSize: 10 }}>{modalityLabel(rm.modality)}</span>
                                  <span className="bd-room-meta"><span className="bd-room-name">{rm.name}</span><span className="bd-room-model">{rm.apparatus_model || ""}</span></span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => setEditingId(null)}>Скасувати</button>
                        <button className="btn btn-primary btn-sm" disabled={savingEdit} onClick={saveEdit}>{savingEdit ? "Зберігаємо…" : "Зберегти"}</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
          </div>

          {/* Запрошені (очікують лікаря) */}
          {invited.length > 0 && (
            <div style={card}>
              <div className="bk-section-label" style={{ marginTop: 0 }}>Запрошені — очікують прийняття ({invited.length})</div>
              {invited.map((r) => <Row key={r.access_id} r={r} />)}
            </div>
          )}

          {/* Історія */}
          {history.length > 0 && (
            <div style={card}>
              <div className="bk-section-label" style={{ marginTop: 0 }}>Історія</div>
              {history.map((r) => (
                <Row key={r.access_id} r={r}>
                  <button className="btn btn-secondary btn-sm" disabled={busyId === r.access_id} onClick={() => reinvite(r)}>{busyId === r.access_id ? "…" : "Запросити знову"}</button>
                </Row>
              ))}
            </div>
          )}
        </div>
      </div>

      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "var(--card)", border: "1px solid var(--border-strong)", borderLeft: "4px solid " + (toast.type === "error" ? "var(--red)" : "var(--green)"), borderRadius: 12, padding: "12px 18px", boxShadow: "var(--shadow-pop)", zIndex: 50, fontSize: 13.5, maxWidth: 460 }}>{toast.msg}</div>
      )}
    </div>
  );
}
