"use client";

/* ===== RadFlow — Персонал і доступи (адмін) =====
   Адміністратор створює акаунти ПЕРСОНАЛУ ЦЕНТРУ: радіолог або РЕЄСТРАТОР
   (логін, ПІБ, телефон, email, примітка). Кабінети призначаються лише радіологу.
   Пароль користувач задає сам на /set-password; адмін може скинути або задати.

   Реєстратор довго був «мертвою» роллю: enum, маршрути і RLS (0073) для нього були,
   а створити акаунт не було чим — уся реєстратура працювала під адміном, тобто з
   правами на кабінети, прайс і таймзону центру. */

import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from "react";
import Toast from "@/components/Toast";
import ConfirmDialog from "@/components/ConfirmDialog";
import { createClient } from "@/lib/supabase/client";
import Sidebar from "@/components/Sidebar";
import LiveClock from "@/components/LiveClock";
import PhoneInput from "@/components/PhoneInput";
import { normalizeLogin, isValidLogin, LOGIN_HINT } from "@/lib/login";
import { modalityLabel } from "@/lib/studies";
import { bookableRooms, isRoomBookable, visibleRooms, ROOM_OFF_LABEL } from "@/lib/rooms";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";

type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null; active?: boolean | null };
/* Персонал центру: радіолог або РЕЄСТРАТОР. Реєстратор довго був «мертвою» роллю —
   enum, маршрути (/queue, /call-list, /waitlist) і RLS (0073) для нього були, а
   створити акаунт не було чим: /api/staff хардкодив radiologist. Уся реєстратура
   через це працювала під адміном — тобто з правами на кабінети, прайс і TZ центру. */
type StaffRole = "radiologist" | "registrar";
type StaffForm = { login: string; full_name: string; email: string; phone: string; note: string };
type Radiologist = {
  id: string; login: string | null; full_name: string | null; email: string | null;
  contact_email: string | null;   // 0124: справжня пошта радіолога (email — службовий)
  phone: string | null; note: string | null; password_set: boolean; invite_token: string | null;
  role: StaffRole;
};
type RadRoom = { profile_id: string; room_id: string };
type PwModal = { id: string; val: string; busy: boolean };
/* Сесія 14: редагування картки. Логіна й адреси входу тут НЕМАЄ свідомо —
   логін міняється окремим роутом (/api/account/login), а email — це адреса
   входу в auth.users, і правити її разом із профілем неатомарно (див.
   коментар у app/api/staff/route.ts). */
type EditFields = { full_name: string; phone: string; contact_email: string; note: string };
/* `initial` — знімок значень на момент відкриття форми. Зберігаємо ЛИШЕ те, що
   відрізняється від нього: інакше форма, відкрита до `reload()` (він спрацьовує
   на кожен фокус вкладки), відправляла б назад свою застарілу копію і мовчки
   затирала правку, зроблену в іншій вкладці — рівно ту втрату контактної пошти,
   заради якої ручку й робили. */
type EditForm = EditFields & { id: string; busy: boolean; initial: EditFields };

const ROLE_LABEL: Record<StaffRole, string> = { radiologist: "Радіолог", registrar: "Реєстратор" };
const EMPTY: StaffForm = { login: "", full_name: "", email: "", phone: "", note: "" };

interface StaffManagerProps {
  clinicId: string;
  rooms?: RoomOpt[];
  clinicName?: string;
  adminName?: string;
  embedded?: boolean;
}

export default function StaffManager({ clinicId, rooms, clinicName, adminName, embedded = false }: StaffManagerProps) {
  const [radiologists, setRadiologists] = useState<Radiologist[]>([]);
  const [radRooms, setRadRooms] = useState<RadRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<StaffForm>(EMPTY);
  const [formRole, setFormRole] = useState<StaffRole>("radiologist");
  const [formRooms, setFormRooms] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);
  /* Підтвердження деструктивних дій — ConfirmDialog у стилі RadFlow замість
     window.confirm (с28, зауваження власника). */
  const [ask, setAsk] = useState<null | { title: string; text: ReactNode; confirmLabel: string; danger?: boolean; run: () => void }>(null);
  const [origin, setOrigin] = useState("");
  const [pwModal, setPwModal] = useState<PwModal | null>(null);
  const [edit, setEdit] = useState<EditForm | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const roomsById = useMemo(() => { const m: Record<string, RoomOpt> = {}; (rooms || []).forEach((r) => { m[r.id] = r; }); return m; }, [rooms]);

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
      // Персонал центру = радіологи + реєстратори (адмін керує собою сам).
      supabase.from("profiles").select("id, login, full_name, email, contact_email, phone, note, password_set, invite_token, role")
        .eq("clinic_id", clinicId).in("role", ["radiologist", "registrar"]).order("full_name"),
      supabase.from("radiologist_rooms").select("profile_id, room_id").eq("clinic_id", clinicId),
    ]);
    /* .in("role", …) звужує вибірку в БД, але типи Supabase все одно віддають увесь
       enum user_role — тому фільтруємо ще й у TS (це і type guard, і захист від
       несподіваного рядка з БД). */
    setRadiologists(
      (profs || []).filter((p): p is (typeof p & { role: StaffRole }) =>
        p.role === "radiologist" || p.role === "registrar")
    );
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

  /* ===== Вимкнені кабінети в доступах (див. lib/rooms.ts) =====
     Тут працює НЕ правило видимості робочих списків (жодних «залишків» і tz на цій
     сторінці немає), а простіше:
       • ВИДАТИ новий доступ можна лише в кабінет, що працює (bookableRooms) —
         інакше адмін роздавав би права на апарат, у який усе одно не запишеш;
       • доступ, який радіологу ВЖЕ видано, а кабінет потім вимкнули, мовчки
         викидати не можна. Прив'язку відновити нізвідки, і при поверненні
         кабінету в стрій виявилось би, що її хтось стер. Показуємо пунктирним чипом
         із підписом «кабінет вимкнено»: зняти доступ можна, видати в кабінет, якого
         в списку не було, — ні.

     ⚠️ `offShown` — МОНОТОННИЙ слід: сюди потрапляє кожен вимкнений кабінет, доступ
     до якого ми бодай раз бачили виданим, і звідси вже не зникає до перезавантаження
     сторінки (ревʼю с18b). Дві причини:
       1. без нього клік «зняти доступ» був глухим кутом: чип зникав тієї ж миті,
          бо список рахувався з живого radRooms, і повернути доступ було нічим;
       2. просте «заморозити на момент reload» теж не годилось: `rooms` приходить
          пропом і оновлюється БЕЗ reload (майстер налаштувань тримає цей компонент
          змонтованим, вимкнення кабінету там робить router.refresh) — заморожений на
          старті список тоді не містив би щойно вимкненого кабінету, і чип зникав би
          цілком, разом із можливістю зняти доступ.
     Інваріант не тече: у слід нічого не додається, крім реально виданих доступів. */
  const newAccessRooms = useMemo(() => bookableRooms(rooms), [rooms]);
  const [offShown, setOffShown] = useState<Record<string, string[]>>({});
  useEffect(() => {
    setOffShown((prev) => {
      let changed = false;
      const m: Record<string, string[]> = { ...prev };
      for (const x of radRooms) {
        const rm = roomsById[x.room_id];
        if (!rm || isRoomBookable(rm)) continue;
        if ((m[x.profile_id] || []).includes(x.room_id)) continue;
        m[x.profile_id] = [...(m[x.profile_id] || []), x.room_id];
        changed = true;
      }
      return changed ? m : prev;   // без цього кожен прогін ефекту давав би зайвий рендер
    });
  }, [radRooms, roomsById]);
  /** Чипи в картці співробітника: активні + вимкнені, доступ до яких є або щойно був. */
  const accessRoomsFor = (profileId: string): RoomOpt[] =>
    (rooms || []).filter((r) => isRoomBookable(r) || hasRoom(profileId, r.id) || (offShown[profileId] || []).includes(r.id));

  async function createAccount() {
    const loginNorm = normalizeLogin(form.login);
    if (!loginNorm || !form.full_name.trim()) { notify("Заповніть логін і ПІБ", "error"); return; }
    if (!isValidLogin(loginNorm)) { notify(LOGIN_HINT, "error"); return; }
    // Email обовʼязковий лише там, де він і є адресою входу (0124).
    if (formRole !== "radiologist" && !form.email.trim()) { notify("Вкажіть email — реєстратор входить логіном або поштою", "error"); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/staff", {
        method: "POST", headers: { "Content-Type": "application/json" },
        // Кабінети — лише радіологу (реєстратор працює з чергою, не з апаратом).
        body: JSON.stringify({ role: formRole, ...form, login: loginNorm, room_ids: formRole === "radiologist" ? formRooms : [] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { notify(data.error || "Помилка створення", "error"); setBusy(false); return; }
      const createdRole = formRole;
      setForm(EMPTY); setFormRooms([]);
      // warning: акаунт створено, але кабінети не призначились — це треба показати,
      // інакше радіолог мовчки лишиться без жодного кабінету.
      if (data.warning) notify(String(data.warning), "error");
      else notify(`${ROLE_LABEL[createdRole]}а створено. Скопіюйте посилання для встановлення пароля в його картці нижче і передайте йому.`, "success");
      reload();
    } catch { notify("Помилка зʼєднання із сервером", "error"); }
    setBusy(false);
  }

  function startEdit(r: Radiologist) {
    const init: EditFields = {
      full_name: r.full_name || "",
      phone: r.phone || "",
      // Реєстратор контактної пошти не має: у нього справжня пошта — в `email`,
      // і вона ж адреса входу (роут відхилить contact_email для нього).
      contact_email: r.role === "radiologist" ? (r.contact_email || "") : "",
      note: r.note || "",
    };
    setEdit({ id: r.id, ...init, busy: false, initial: init });
  }
  function setE(k: keyof EditFields, v: string) {
    setEdit((e) => (e ? { ...e, [k]: v } : e));
  }
  async function saveEdit(role: StaffRole) {
    if (!edit || edit.busy) return;              // гард подвійного кліка
    if (!edit.full_name.trim()) { notify("ПІБ не може бути порожнім", "error"); return; }

    /* Тіло — тільки змінені поля (справжній PATCH). Роут відсутній ключ
       трактує як «не чіпати колонку». */
    const editId = edit.id;                      // фіксуємо ДО await: поки летить
    const body: Record<string, string> = { userId: editId };  // запит, користувач
    const keys: (keyof EditFields)[] = role === "radiologist"  // може відкрити іншу
      ? ["full_name", "phone", "contact_email", "note"]        // картку
      : ["full_name", "phone", "note"];
    const changed = keys.filter((k) => edit[k] !== edit.initial[k]);
    if (changed.length === 0) { setEdit(null); notify("Змін немає", "info"); return; }
    changed.forEach((k) => { body[k] = edit[k]; });

    setEdit((e) => (e && e.id === editId ? { ...e, busy: true } : e));
    try {
      const res = await fetch("/api/staff", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        notify(data.error || "Помилка збереження", "error");
        setEdit((e) => (e && e.id === editId ? { ...e, busy: false } : e));
        return;
      }
      /* У списку оновлюємо РІВНО ті поля, що пішли на сервер, і в тій самій
         нормалізації (trim / lowercase / «» → NULL): інакше UI показував би
         стан, якого в БД немає. */
      const patched: Partial<Radiologist> = {};
      if (changed.includes("full_name")) patched.full_name = edit.full_name.trim();
      if (changed.includes("phone")) patched.phone = edit.phone.trim() || null;
      if (changed.includes("note")) patched.note = edit.note.trim() || null;
      if (changed.includes("contact_email")) patched.contact_email = edit.contact_email.trim().toLowerCase() || null;
      setRadiologists((rs) => {
        const next = rs.map((r) => (r.id === editId ? { ...r, ...patched } : r));
        // Вибірка йде з .order("full_name") — після перейменування рядок має
        // переїхати, а не лишатись на старому місці до наступного reload().
        return changed.includes("full_name")
          ? next.sort((a, b) => (a.full_name || "").localeCompare(b.full_name || "", "uk"))
          : next;
      });
      setEdit((e) => (e && e.id === editId ? null : e));
      notify("Картку збережено", "success");
    } catch {
      notify("Помилка зʼєднання із сервером", "error");
      setEdit((e) => (e && e.id === editId ? { ...e, busy: false } : e));
    }
  }

  function askResetPassword(profileId: string, label: string | null) {
    setAsk({
      title: `Скинути пароль для «${label}»?`,
      text: "Поточний пароль перестане діяти. Користувач задасть новий на /set-password за своїм логіном.",
      confirmLabel: "Скинути пароль",
      run: () => { void resetPassword(profileId); },
    });
  }
  async function resetPassword(profileId: string) {
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
  function askDeleteRadiologist(profileId: string, label: string | null) {
    setAsk({
      title: `Видалити акаунт радіолога «${label}» назавжди?`,
      text: "Будуть видалені: обліковий запис, профіль і доступи до кабінетів. Записи пацієнтів залишаться. Дію не можна скасувати.",
      confirmLabel: "Видалити",
      danger: true,
      run: () => { void deleteRadiologist(profileId); },
    });
  }
  async function deleteRadiologist(profileId: string) {
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
    <div className={embedded ? "setup-embed" : "app"}>
      {/* Сайдбар — робочий список кабінетів, тож вимкнені звідси ховаємо. Залишки
          на цій сторінці не рахуємо (їх нема звідки взяти без tz центру), тому
          спрацьовує документований fail-closed із lib/rooms.ts: без residual
          видимими лишаються активні. Пацієнта це не зачіпає — тут немає записів. */}
      {!embedded && <Sidebar clinicName={clinicName} adminName={adminName} adminRole="Адміністратор" roleKey="admin" clinicIds={clinicId ? [clinicId] : []} rooms={visibleRooms(rooms)} activeNav="staff" />}
      <div className={embedded ? "setup-embed-main" : "main"}>
        {!embedded && (
          <header className="topbar">
            <div className="tb-title">
              <span className="tic">👥</span>
              <div><h1>Персонал і доступи</h1><div className="date">{clinicName} · <LiveClock /></div></div>
            </div>
          </header>
        )}

        <div className={embedded ? undefined : "content"} style={embedded ? undefined : { overflowY: "auto", padding: "22px", maxWidth: 900 }}>
          {/* Додати співробітника */}
          <div style={card}>
            <div className="bk-section-label" style={{ marginTop: 0 }}>Додати співробітника</div>
            <div className="fld">
              <span className="fld-lab">Роль <span className="req">*</span></span>
              <div style={{ display: "flex", gap: 8 }}>
                {(["radiologist", "registrar"] as StaffRole[]).map((r) => (
                  <button key={r} type="button" onClick={() => setFormRole(r)}
                    className={"btn btn-sm " + (formRole === r ? "btn-primary" : "btn-secondary")}>
                    {ROLE_LABEL[r]}
                  </button>
                ))}
              </div>
              <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 6, display: "block" }}>
                {formRole === "radiologist"
                  ? "Працює з апаратом: своя дошка, статуси досліджень, доступ до призначених кабінетів."
                  : "Реєстратура: черга, обдзвін, лист очікування, графік дня, простої. Кабінети, прайс і налаштування центру — не редагує."}
              </span>
            </div>
            <div className="fld-row">
              <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Логін <span className="req">*</span></span><input className="inp" placeholder="логін для входу" value={form.login} onChange={(e) => setF("login", e.target.value)} /></label>
              <label className="fld" style={{ flex: 1 }}><span className="fld-lab">ПІБ <span className="req">*</span></span><input className="inp" placeholder="Прізвище Імʼя По батькові" value={form.full_name} onChange={(e) => setF("full_name", e.target.value)} /></label>
            </div>
            <div className="fld-row">
              {/* 0124: радіолог входить ЛИШЕ за логіном — адреса входу в нього
                  службова й ВИПАДКОВА (rad.<hex>@…), її генерує сервер.
                  Тут лишається контактна пошта, і вона необовʼязкова. У реєстратора
                  email — справжня адреса входу, тож обовʼязкова. */}
              <label className="fld" style={{ flex: 1 }}>
                <span className="fld-lab">
                  {formRole === "radiologist" ? "Email для звʼязку" : <>Email <span className="req">*</span></>}
                </span>
                <input className="inp" type="email"
                  placeholder={formRole === "radiologist" ? "необовʼязково" : "registrar@clinic.ua"}
                  value={form.email} onChange={(e) => setF("email", e.target.value)} />
                <span className="fld-hint">
                  {formRole === "radiologist"
                    ? "Не для входу: радіолог входить лише логіном і паролем."
                    : "Реєстратор входить логіном або цією поштою."}
                </span>
              </label>
              <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Телефон</span><PhoneInput value={form.phone} onChange={(v) => setF("phone", v)} /></label>
            </div>
            <label className="fld"><span className="fld-lab">Пароль</span><input className="inp" placeholder="Порожній — користувач задасть сам на /set-password" disabled /></label>
            <label className="fld"><span className="fld-lab">Примітка</span><input className="inp" placeholder="Коротка примітка (необовʼязково)" value={form.note} onChange={(e) => setF("note", e.target.value)} /></label>
            {/* Кабінети — лише радіологу: реєстратор працює з чергою, не з апаратом. */}
            {formRole === "radiologist" && (
            <div className="fld">
              <span className="fld-lab">Доступ до кабінетів</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {/* Новий акаунт — лише активні кабінети: доступів «наперед» у
                    виведений з експлуатації апарат не роздаємо. */}
                {newAccessRooms.map((r) => {
                  const on = formRooms.includes(r.id);
                  return (
                    <button key={r.id} type="button" onClick={() => setFormRooms((s) => (on ? s.filter((x) => x !== r.id) : [...s, r.id]))}
                      className={"btn btn-sm " + (on ? "btn-primary" : "btn-secondary")}>
                      {on ? "✓ " : ""}{r.name} · {modalityLabel(r.modality)}
                    </button>
                  );
                })}
                {newAccessRooms.length === 0 && <span style={{ fontSize: "0.78125rem", color: "var(--text-muted)" }}>Спершу додайте кабінети в Майстрі.</span>}
              </div>
            </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
              <button className="btn btn-primary" disabled={busy} onClick={createAccount}>{busy ? "Створюємо…" : "Створити акаунт"}</button>
            </div>
            <div className="hint-blue">Пароль не задається тут: після створення скопіюйте в картці співробітника <b>персональне посилання</b> й передайте йому — він встановить пароль сам. Забув пароль — натисніть «Скинути», зʼявиться нове посилання.</div>
          </div>

          {/* Персонал центру */}
          <div style={card}>
            <div className="bk-section-label" style={{ marginTop: 0 }}>Персонал клініки ({radiologists.length})</div>
            {loading ? (
              <div style={{ color: "var(--text-muted)", padding: 8 }}>Завантаження…</div>
            ) : radiologists.length === 0 ? (
              <div style={{ color: "var(--text-muted)", padding: 8, fontSize: "0.8125rem" }}>Поки немає співробітників. Додайте їх вище.</div>
            ) : radiologists.map((r) => (
              <div key={r.id} style={{ padding: "14px 0", borderTop: "1px solid var(--border)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <div style={{ fontWeight: 600, fontSize: "0.875rem", display: "flex", alignItems: "center", gap: 8 }}>
                      {r.full_name || r.login || r.email}
                      <span className={"badge " + (r.role === "registrar" ? "blue" : "gray")} style={{ fontSize: "0.65625rem" }}>
                        {ROLE_LABEL[r.role]}
                      </span>
                    </div>
                    <div style={{ fontSize: "0.78125rem", color: "var(--text-muted)" }}>
                      {/* 0124: у радіолога profiles.email — СЛУЖБОВА адреса
                          (rad.<hex>@radiologist.radflow.local). Показувати її як
                          пошту означало б підсунути адміну адресу, на яку він
                          напише й ніколи не отримає відповіді. Показуємо
                          контактну, а спосіб входу називаємо прямо. */}
                      {r.login ? "@" + r.login + " · " : ""}
                      {r.role === "radiologist"
                        ? (r.contact_email || "вхід лише за логіном")
                        : r.email}
                      {r.phone ? " · " + r.phone : ""}
                    </div>
                    {r.note && <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: 2 }}>{r.note}</div>}
                  </div>
                  <span className={"badge " + (r.password_set ? "green" : "yellow")}>{r.password_set ? "🔒 Пароль встановлено" : "Пароль не задано"}</span>
                  {/* Поки летить збереження — жоден тогл не активний: інакше
                      відповідь застосувалась би до вже іншої відкритої картки. */}
                  <button className="btn btn-secondary btn-sm" title="Редагувати ПІБ, телефон, пошту для звʼязку та примітку"
                    aria-expanded={edit?.id === r.id} aria-controls={"staff-edit-" + r.id}
                    disabled={!!edit?.busy}
                    onClick={() => (edit?.id === r.id ? setEdit(null) : startEdit(r))}>
                    {edit?.id === r.id ? "Згорнути" : "✏️ Редагувати"}
                  </button>
                  <button className="btn btn-secondary btn-sm" title="Користувач задасть пароль наново" onClick={() => askResetPassword(r.id, r.full_name || r.login)}>Скинути пароль</button>
                  <button className="btn btn-secondary btn-sm" title="Задати пароль вручну" onClick={() => setPassword(r.id)}>Задати пароль</button>
                  <button className="btn btn-secondary btn-sm qd-act-red" title="Видалити акаунт назавжди" onClick={() => askDeleteRadiologist(r.id, r.full_name || r.login)}>🗑</button>
                </div>
                {/* Форма редагування — інлайн, а не модалка: поля прості, а
                    модалка тут вимагала б пастки фокуса й Esc (useModalA11y)
                    поверх уже наявного вікна пароля. */}
                {edit?.id === r.id && (
                  <div id={"staff-edit-" + r.id} role="group" aria-label={"Редагування картки: " + (r.full_name || r.login || "")}
                    style={{ marginTop: 12, padding: 14, background: "var(--bg-soft, var(--card))", border: "1px solid var(--border)", borderRadius: "var(--r-md, 8px)" }}>
                    <div className="fld-row">
                      <label className="fld" style={{ flex: 1 }}>
                        <span className="fld-lab">ПІБ <span className="req">*</span></span>
                        <input className="inp" maxLength={200} value={edit.full_name} onChange={(e) => setE("full_name", e.target.value)} />
                      </label>
                      <label className="fld" style={{ flex: 1 }}>
                        <span className="fld-lab">Телефон</span>
                        <PhoneInput value={edit.phone} onChange={(v) => setE("phone", v)} />
                      </label>
                    </div>
                    <div className="fld-row">
                      {r.role === "radiologist" ? (
                        <label className="fld" style={{ flex: 1 }}>
                          <span className="fld-lab">Email для звʼязку</span>
                          <input className="inp" type="email" placeholder="необовʼязково" maxLength={254}
                            value={edit.contact_email} onChange={(e) => setE("contact_email", e.target.value)} />
                          <span className="fld-hint">Не для входу: радіолог входить лише логіном і паролем. Порожнє поле стирає пошту.</span>
                        </label>
                      ) : (
                        /* readOnly, а НЕ disabled: disabled-поле випадає з
                           таб-порядку, і читач екрана до значення не дістанеться.
                           Обгортка — <label>, інакше в інпута немає доступного
                           імені (WCAG 1.3.1 / 4.1.2). */
                        <label className="fld" style={{ flex: 1 }}>
                          <span className="fld-lab">Email (адреса входу)</span>
                          <input className="inp" value={r.email || ""} readOnly />
                          <span className="fld-hint">Адресу входу тут не змінити — вона живе в акаунті, не в картці.</span>
                        </label>
                      )}
                      <label className="fld" style={{ flex: 1 }}>
                        <span className="fld-lab">Примітка</span>
                        <input className="inp" maxLength={2000} value={edit.note} onChange={(e) => setE("note", e.target.value)} />
                      </label>
                    </div>
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                      <button className="btn btn-ghost btn-sm" disabled={edit.busy} onClick={() => setEdit(null)}>Скасувати</button>
                      <button className="btn btn-primary btn-sm" disabled={edit.busy} aria-busy={edit.busy} onClick={() => saveEdit(r.role)}>
                        {edit.busy ? <><span className="rf-spin" aria-hidden="true" /> Зберігаємо…</> : "Зберегти"}
                      </button>
                    </div>
                    <div className="fld-hint" style={{ marginTop: 6 }}>
                      Логін ({r.login ? "@" + r.login : "—"}) після створення не змінюється: щоб дати
                      співробітнику інший логін, доведеться створити акаунт заново.
                    </div>
                  </div>
                )}
                {!r.password_set && r.invite_token && (
                  <div style={{ fontSize: "0.75rem", marginTop: 8, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span style={{ color: "var(--text-muted)" }}>🔗 Посилання для встановлення пароля:</span>
                    <code style={{ fontSize: "0.71875rem", color: "var(--text-secondary)", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>/set-password?token=…</code>
                    <button className="btn btn-secondary btn-sm" onClick={() => copyLink(r.invite_token as string)}>Скопіювати</button>
                  </div>
                )}
                {/* Кабінети призначаються лише радіологу (/api/staff/rooms це теж вимагає). */}
                {r.role === "radiologist" && (
                <div style={{ marginTop: 10 }}>
                  <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Доступ до кабінетів:</span>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
                    {accessRoomsFor(r.id).map((rm) => {
                      const on = hasRoom(r.id, rm.id);
                      // Чому вимкнений кабінет узагалі тут — див. accessRoomsFor / offShown вище.
                      const off = !isRoomBookable(rm);
                      return (
                        /* Стан «кабінет вимкнено» несуть пунктирна рамка + підпис у самому
                           чипі, а НЕ opacity: прозорість топила дрібний підпис нижче 4.5:1
                           (WCAG 1.4.3) — тобто найгірше читався саме той текст, що пояснює стан.
                           ⚠️ Вимкнений чип лишається btn-secondary навіть при виданому доступі.
                           На btn-primary (синій --blue) підпис 0.6875rem білим дає 3.65:1 —
                           той самий провал 1.4.3, який ми й прибирали. На --card біле дає 12.8:1.
                           Факт доступу несе «✓» і зелена рамка, а не заливка; для скрінрідера —
                           aria-pressed. */
                        <button key={rm.id} type="button" onClick={() => toggleRoom(r.id, rm.id)} aria-pressed={on}
                          className={"btn btn-sm " + (on && !off ? "btn-primary" : "btn-secondary")}
                          style={off ? { borderStyle: "dashed", borderColor: on ? "var(--green)" : "var(--orange)" } : undefined}
                          title={off
                            ? `Кабінет ${ROOM_OFF_LABEL}. Доступ можна зняти; повернути — доки ви не залишили цю сторінку.`
                            : undefined}>
                          {on ? "✓ " : ""}{rm.name} · {modalityLabel(rm.modality)}
                          {off && <span style={{ marginLeft: 6, fontSize: "0.6875rem" }}>· кабінет {ROOM_OFF_LABEL}</span>}
                        </button>
                      );
                    })}
                    {accessRoomsFor(r.id).length === 0 && <span style={{ fontSize: "0.78125rem", color: "var(--text-muted)" }}>Немає кабінетів.</span>}
                  </div>
                </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {pwModal && (
        <div className="overlay" onClick={() => !pwModal.busy && setPwModal(null)}>
          <div className="dialog fade-in" style={{ maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
            <div className="dlg-head"><div className="dlg-title">Задати пароль</div><button className="icon-btn" aria-label="Закрити" onClick={() => setPwModal(null)}>✕</button></div>
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
      {ask && (
        <ConfirmDialog
          title={ask.title}
          text={ask.text}
          confirmLabel={ask.confirmLabel}
          cancelLabel="Скасувати"
          danger={ask.danger}
          onClose={() => setAsk(null)}
          onConfirm={() => { const run = ask.run; setAsk(null); run(); }}
        />
      )}
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
