"use client";

/* ===== RadFlow — Лікарі-направники (адмін, крос-клінічна модель) =====
   Доступ направника до центру = referral_access. Адмін центру:
   • запрошує направника (логін/ПІБ/телефон обовʼязкові, email — ні);
   • обирає, до яких КАБІНЕТІВ центру направник має доступ;
   • підтверджує/відхиляє запити направників; відкликає доступ. */

import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import Toast from "@/components/Toast";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";
import Sidebar from "@/components/Sidebar";
import LiveClock from "@/components/LiveClock";
import PhoneInput from "@/components/PhoneInput";
import HelpTip from "@/components/HelpTip";
import { modalityShort, modalityKind } from "@/lib/studies";
import { bookableRooms, isRoomBookable, visibleRooms, ROOM_OFF_LABEL } from "@/lib/rooms";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";

type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null; active?: boolean | null };
type ReferrerProfile = { id?: string; login?: string | null; full_name?: string | null; phone?: string | null; note?: string | null; password_set?: boolean; invite_token?: string | null };
type AccessRow = { access_id: string; referrer_id: string; status: string; policy: string | null; room_ids: string[] | null; note: string | null; referrer: ReferrerProfile };
type InviteForm = { login: string; full_name: string; email: string; phone: string; note: string; policy: string; room_ids: string[] };
type EditForm = { policy: string; room_ids: string[]; note: string };
type LoginSug = { id: string; login: string | null; full_name: string | null };
type StrKey = "login" | "full_name" | "email" | "phone" | "note" | "policy";
type ApiResult = { ok: boolean; data: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

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
  /* allRoomIds / roomById — ПОВНИЙ перелік, включно з вимкненими кабінетами, і
     саме таким має лишитись: на ньому тримаються sanitizeRooms і isAllRooms. Якби
     вимкнені звідси зникли, sanitizeRooms вичищав би їх із уже виданого гранта, і
     перше ж збереження картки ТИХО забирало б у направника доступ, який ніхто не
     знімав (а відновити його після повернення кабінету в стрій — нізвідки).
     Фільтруємо лише ЧИПИ вибору — див. newAccessRooms / accessRoomsFor. */
  const allRoomIds = (rooms || []).map((r) => r.id);
  const roomById: Record<string, RoomOpt> = {}; (rooms || []).forEach((r) => { roomById[r.id] = r; });

  /* Видати НОВИЙ доступ можна лише в кабінет, що працює. Побічний ефект: поки в
     центрі є вимкнений кабінет, новий грант зберігається ЯВНИМ списком, а не null
     («усі кабінети») — бо «усі» мовчки включало б і виведений з експлуатації
     апарат, і направник отримав би його назад разом із поверненням у стрій.
     Коли вимкнених кабінетів немає (звичайний випадок) — поведінка не змінюється. */
  const newAccessRooms = bookableRooms(rooms);
  /** Чипи для вже виданого гранта: активні + вимкнені з переданого списку.
   *
   *  ⚠️ Список вимкнених сюди йде ЗАМОРОЖЕНИЙ на момент відкриття картки
   *  (`editOffIds`), а НЕ поточний `editForm.room_ids` (ревʼю с17, Low). З
   *  поточним виходив глухий кут: клік по приглушеному чипу прибирав кабінет із
   *  room_ids, після чого цей самий чип зникав зі списку — і повернути доступ у
   *  тій самій формі було нічим, лише «Скасувати» й відкрити картку заново.
   *  Із замороженим списком чип лишається на місці до збереження, тож клік
   *  оборотний. Видати доступ у вимкнений кабінет, якого в гранті НЕ БУЛО,
   *  це так само не дозволяє: у заморожений список він не потрапить.
   *
   *  Третій доданок — поточний `editForm.room_ids` (ревʼю с18b, N3): кабінет могли
   *  вимкнути в майстрі, поки картка відкрита (він змонтований поруч, і збереження
   *  там робить router.refresh), — без нього чип зник би цілком, разом із самою
   *  можливістю зняти доступ. Інваріант тримається по індукції: `room_ids` стартує
   *  з гранта й поповнюється лише кліком по вже відрисованому чипу. */
  const accessRoomsFor = (frozenOffIds: string[]): RoomOpt[] =>
    (rooms || []).filter((r) => isRoomBookable(r) || frozenOffIds.includes(r.id) || editForm.room_ids.includes(r.id));

  const emptyForm = (): InviteForm => ({ login: "", full_name: "", email: "", phone: "", note: "", policy: "direct", room_ids: newAccessRooms.map((r) => r.id) });

  const [rows, setRows] = useState<AccessRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<InviteForm>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);
  const [origin, setOrigin] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({ policy: "direct", room_ids: [], note: "" });
  /** Вимкнені кабінети, що були в гранті на момент відкриття картки. Заморожені
   *  до закриття форми, щоб чип не зникав із першого кліку — див. accessRoomsFor. */
  const [editOffIds, setEditOffIds] = useState<string[]>([]);
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

  /* Санітизація room_ids гранта: лишаємо тільки кабінети, які зараз є в центрі.
     У старих грантах осідали id видалених кабінетів (у списку — «?»), і при
     збереженні вони поверталися в БД. Заодно вбиває дублі. */
  const sanitizeRooms = (ids: string[] | null | undefined): string[] =>
    Array.from(new Set((ids || []).filter((id) => !!roomById[id])));
  /* «Усі кабінети» (null у БД) визначаємо ПО СКЛАДУ, а не по довжині масиву:
     якщо в гранті лежали 3 протухлі id, а в центрі теж 3 кабінети — перевірка
     на довжину вважала це «усі кабінети» й ТИХО РОЗШИРЮВАЛА доступ при збереженні. */
  const isAllRooms = (ids: string[]) => allRoomIds.length > 0 && allRoomIds.every((id) => ids.includes(id));
  /* Повертає room_ids для API або null = «усі кабінети». ПОРОЖНІЙ вибір — це НЕ
     «усі»: раніше «зняти всі галочки» відкривало доступ до всіх кабінетів
     (прямо протилежне наміру). Тепер порожній вибір — помилка (див. guardRooms). */
  const roomIdsForSave = (ids: string[]): string[] | null => {
    const clean = sanitizeRooms(ids);
    return isAllRooms(clean) ? null : clean;
  };
  /* Перед збереженням: кабінети мають бути завантажені (інакше sanitizeRooms
     вичистить усе й ми запишемо «усі кабінети») і хоча б один має бути обраний. */
  function guardRooms(ids: string[]): boolean {
    if (allRoomIds.length === 0) { notify("Кабінети центру не завантажились — оновіть сторінку", "error"); return false; }
    if (sanitizeRooms(ids).length === 0) { notify("Оберіть хоча б один кабінет", "error"); return false; }
    return true;
  }

  function roomsLabel(room_ids: string[] | null) {
    if (!room_ids || room_ids.length === 0) return "усі кабінети";
    const known = sanitizeRooms(room_ids);
    const lost = room_ids.length - known.length; // id кабінетів, яких уже немає в центрі
    const names = known.map((id) => {
      const rm = roomById[id];
      return rm.name + (rm.apparatus_model ? " (" + rm.apparatus_model + ")" : "");
    });
    if (!known.length) return lost ? "кабінетів немає (" + lost + " видалено)" : "усі кабінети";
    return names.join(", ") + (lost ? " · " + lost + " видалено" : "");
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
    if (!guardRooms(form.room_ids)) return;
    setBusy(true);
    const room_ids = roomIdsForSave(form.room_ids);
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
    /* Не шлемо сирий масив із БД: у старих грантах там є id видалених кабінетів —
       сервер тепер відповість 400. Санітизуємо; якщо не лишилось жодного живого
       кабінету — просимо адміна обрати кабінети явно (мовчки перетворювати на
       null = «усі кабінети» не можна). */
    const clean = r.room_ids && r.room_ids.length ? sanitizeRooms(r.room_ids) : null;
    if (r.room_ids && r.room_ids.length && (!clean || clean.length === 0)) {
      notify("У цього гранта не лишилось жодного кабінету — оберіть кабінети", "error");
      startEdit(r);
      return;
    }
    setBusyId(r.access_id);
    const { ok, data } = await postJSON("/api/referrers/invite", {
      login: r.referrer.login || "",
      full_name: r.referrer.full_name || "",
      phone: r.referrer.phone || "",
      email: "",
      note: r.note || "",
      policy: r.policy || "direct",
      room_ids: clean && isAllRooms(clean) ? null : clean,
    });
    setBusyId(null);
    if (!ok) { notify(data.error || "Помилка", "error"); return; }
    notify("Запрошення надіслано повторно — очікує підтвердження лікаря", "success");
    reload();
  }

  function startEdit(r: AccessRow) {
    setEditingId(r.access_id);
    // Протухлі id відсікаємо ще на відкритті — інакше просте «Зберегти» повертало б їх у БД.
    const clean = sanitizeRooms(r.room_ids);
    const initialRooms = (r.room_ids && r.room_ids.length ? clean : allRoomIds);
    setEditForm({ policy: r.policy || "direct", room_ids: initialRooms, note: r.note || "" });
    // Заморожуємо вимкнені кабінети гранта — див. accessRoomsFor.
    setEditOffIds(initialRooms.filter((id) => roomById[id] && !isRoomBookable(roomById[id])));
  }
  function toggleEditRoom(id: string) { setEditForm((f) => ({ ...f, room_ids: f.room_ids.includes(id) ? f.room_ids.filter((x) => x !== id) : [...f.room_ids, id] })); }
  async function saveEdit() {
    if (!guardRooms(editForm.room_ids)) return;
    setSavingEdit(true);
    const room_ids = roomIdsForSave(editForm.room_ids);
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
        {expandable && <span style={{ color: "var(--text-muted)", fontSize: "0.8125rem", width: 12, flexShrink: 0, display: "inline-block", transition: "transform .15s", transform: expanded ? "rotate(90deg)" : "none" }}>▸</span>}
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontWeight: 600, fontSize: "0.875rem" }}>{name}</div>
          <div style={{ fontSize: "0.78125rem", color: "var(--text-muted)" }}>{r.referrer.login ? "@" + r.referrer.login : ""}{r.referrer.phone ? " · " + r.referrer.phone : ""}</div>
          {r.referrer.note && <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: 2 }} title="Примітка лікаря (редагує сам направник)">📝 {r.referrer.note}</div>}
          {r.note && <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: 2 }}>{r.note}</div>}
          {r.status === "active" && (() => {
            // Грант без жодного живого кабінету: направник фактично не може ані
            // записувати, ані редагувати свої записи в центрі — це треба бачити.
            const dead = !!(r.room_ids && r.room_ids.length && sanitizeRooms(r.room_ids).length === 0);
            return (
              <div style={{ fontSize: "0.75rem", color: dead ? "var(--red)" : "var(--text-secondary)", marginTop: 2 }}>
                Режим: {r.policy === "confirm" ? "з підтвердженням оператора" : "пряма черга"} · Кабінети: {roomsLabel(r.room_ids)}
                {dead && <span title="Дозволені кабінети видалено — направник не може записувати. Оберіть кабінети заново."> — ⚠ доступ не працює</span>}
              </div>
            );
          })()}
          {!r.referrer.password_set && r.referrer.invite_token && (
            <div style={{ fontSize: "0.75rem", marginTop: 4, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ color: "var(--text-muted)" }}>🔗 Посилання для входу:</span>
              <code style={{ fontSize: "0.71875rem", color: "var(--text-secondary)", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>/set-password?token=…</code>
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
      {/* Сайдбар — робочий список кабінетів, тож вимкнені звідси ховаємо. Залишки
          на цій сторінці не рахуємо (їх нема звідки взяти без tz центру), тому
          спрацьовує документований fail-closed із lib/rooms.ts: без residual
          видимими лишаються активні. На гранти це не впливає — вони вище. */}
      {!embedded && <Sidebar clinicName={clinicName} adminName={adminName} adminRole="Адміністратор" roleKey="admin" rooms={visibleRooms(rooms)} activeNav="referrers" />}
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
                        <span style={{ fontWeight: 600, fontSize: "0.8125rem" }}>@{s.login}</span>
                        {s.full_name ? <span style={{ color: "var(--text-muted)", fontSize: "0.78125rem" }}> · {s.full_name}</span> : null}
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
              {newAccessRooms.length === 0 ? (
                <div className="ctx-hint" style={{ fontSize: "0.78125rem" }}>
                  {(rooms || []).length === 0
                    ? "У центрі ще немає кабінетів — додайте їх у Майстрі налаштування."
                    : "Усі кабінети центру вимкнено — надати доступ немає до чого."}
                </div>
              ) : (
                <div className="bd-rooms">
                  {/* Новий доступ — лише в активні кабінети (див. newAccessRooms). */}
                  {newAccessRooms.map((r) => {
                    const on = form.room_ids.includes(r.id);
                    return (
                      <button type="button" key={r.id} className="bd-room" onClick={() => toggleRoom(r.id)} title={on ? "Доступний — натисніть, щоб прибрати" : "Недоступний — натисніть, щоб додати"}
                        style={{ padding: "5px 9px", gap: 8, borderColor: on ? "var(--green)" : undefined, background: on ? "var(--green-bg)" : undefined }}>
                        <span className={"bd-room-kind " + modalityKind(r.modality)} style={{ width: 26, height: 26, fontSize: "0.625rem" }}>{modalityShort(r.modality)}</span>
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
              : active.length === 0 ? <div style={{ color: "var(--text-muted)", padding: 8, fontSize: "0.8125rem" }}>Поки немає активних направників. Запросіть лікаря вище.</div>
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
                      <div className="ctx-hint" style={{ fontSize: "0.75rem", marginBottom: 10 }}>Дані направника (ПІБ, телефон, примітки) лікар редагує сам у своєму профілі. Тут — лише налаштування доступу до вашого центру.</div>
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
                        {accessRoomsFor(editOffIds).length === 0 ? <div className="ctx-hint" style={{ fontSize: "0.78125rem" }}>У центрі немає кабінетів.</div> : (
                          <div className="bd-rooms">
                            {accessRoomsFor(editOffIds).map((rm) => {
                              /* Вимкнений кабінет тут може бути лише тоді, коли він був
                                 у гранті на момент відкриття картки (editOffIds). Знімати
                                 й повертати доступ можна вільно до «Зберегти»; видати його
                                 в кабінет, якого в гранті не було, — не можна, такий чип
                                 у список просто не потрапляє. */
                              const on = editForm.room_ids.includes(rm.id);
                              const off = !isRoomBookable(rm);
                              return (
                                /* aria-pressed: стан «доступ виданий» тут несуть лише колір
                                   рамки й заливка, тобто для скрінрідера його не існувало
                                   (4.1.2 + 1.4.1). Конвенція проєкту — DensityToggle, Sidebar. */
                                <button type="button" key={rm.id} aria-pressed={on} className={"bd-room" + (off ? " bd-room-off" : "")} onClick={() => toggleEditRoom(rm.id)}
                                  title={off
                                    ? `Кабінет ${ROOM_OFF_LABEL}. ` + (on ? "Доступ можна зняти; після збереження повернути його не вийде, поки кабінет не ввімкнуть." : "Доступ знято — повернеться, якщо натиснути ще раз до збереження.")
                                    : (on ? "Доступний — натисніть, щоб прибрати" : "Недоступний — натисніть, щоб додати")}
                                  style={{ padding: "5px 9px", gap: 8, borderColor: on ? "var(--green)" : undefined, background: on ? "var(--green-bg)" : undefined }}>
                                  <span className={"bd-room-kind " + modalityKind(rm.modality)} style={{ width: 26, height: 26, fontSize: "0.625rem" }}>{modalityShort(rm.modality)}</span>
                                  <span className="bd-room-meta"><span className="bd-room-name">{rm.name}</span><span className="bd-room-model">{off ? `кабінет ${ROOM_OFF_LABEL}` : (rm.apparatus_model || "")}</span></span>
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

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
