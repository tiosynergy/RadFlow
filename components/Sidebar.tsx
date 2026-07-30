"use client";

/* ===== RadFlow — бічна панель (Sidebar) =====
   Портовано з rf-shell.jsx. Кабінети — з БД, клініка/адмін — з props.
   Деякі операції (Колл-лист, Інцидент, Кабінет радіолога) — окремі етапи (disabled). */

import { useCallback, useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";
import { signOutAndRedirect } from "@/lib/auth";
import DensityControl from "@/components/DensityToggle";
import NavDrawer from "@/components/NavDrawer";
import SoundToggle from "@/components/SoundToggle";
import { modalityShort, modalityKind } from "@/lib/studies";

type SidebarRoom = {
  id: string;
  modality: string;
  name: string;
  apparatus_model?: string | null;
};

interface SidebarProps {
  clinicName?: string;
  adminName?: string;
  adminRole?: string;
  roleKey?: string;
  rooms?: SidebarRoom[];
  activeRoom?: string;
  activeNav?: string;
  onSelectRoom?: (id: string) => void;
  /** Підпис під назвою кабінету замість моделі апарата — для вимкнених
   *  кабінетів-залишків («вимкнено · 3 записи»). Повертає null для звичайних. */
  roomNoteOf?: (roomId: string) => string | null;
  onNew?: () => void;
  onSlotsOverview?: () => void;
  incidentCount?: number;
  onBreakdown?: () => void;
  onEmergency?: () => void;
  emergencyActive?: boolean;
  stoppedRoomIds?: string[]; // кабінети з активним простоєм (аварія/поломка) — підсвічуються червоним
}

function initials(name?: string | null): string {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "RF";
  return (parts[0][0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
}

export default function Sidebar({
  clinicName,
  adminName,
  adminRole,
  roleKey = "admin",
  rooms,
  roomNoteOf,
  activeRoom = "all",
  activeNav,
  onSelectRoom,
  onNew,
  onSlotsOverview,
  incidentCount = 0,
  onBreakdown,
  onEmergency,
  emergencyActive = false,
  stoppedRoomIds = [],
}: SidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const isAdmin = roleKey === "admin";
  const isCeo = roleKey === "ceo";

  // Крос-рольовий CEO серед НЕ-адмінів (напр. реєстратор з грантом ceo_access)
  // бачить посилання на дашборд. На сторінці адміна прямого посилання немає —
  // керування центрами адмін відкриває з Майстра налаштувань.
  const [hasCeoGrant, setHasCeoGrant] = useState(false);
  // Лічильник листа очікування (RLS сам обмежує видимість клінікою користувача).
  // Live: realtime-підписка на waitlist_entries (без фільтра — RLS віддає лише
  // видимі рядки), щоб бейдж не розходився зі списком після додавання/зняття.
  const [waitCount, setWaitCount] = useState(0);
  const loadWaitCount = useCallback(async () => {
    try {
      const supabase = createClient();
      const { count } = await supabase
        .from("waitlist_entries")
        .select("id", { count: "exact", head: true })
        .eq("status", "waiting");
      setWaitCount(count ?? 0);
    } catch { /* транзієнтний збій мережі — лишаємо попереднє значення */ }
  }, []);
  useEffect(() => { loadWaitCount(); }, [loadWaitCount]);
  useRealtimeRefetch({
    channelName: "sb-waitlist-badge",
    subscriptions: [{ table: "waitlist_entries", onChange: loadWaitCount }],
  });
  useEffect(() => {
    if (isAdmin || isCeo) return; // адмін — не показуємо; ceo й так на /ceo
    let active = true;
    (async () => {
      try {
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user || !active) return;
        const { data } = await supabase
          .from("ceo_access").select("clinic_id").eq("ceo_id", user.id).eq("status", "active").limit(1);
        if (active && (data?.length ?? 0) > 0) setHasCeoGrant(true);
      } catch { /* ignore */ }
    })();
    return () => { active = false; };
  }, [isAdmin, isCeo]);
  const showCeoLink = isCeo || hasCeoGrant;

  async function signOut() {
    await signOutAndRedirect(router);
  }

  return (
    <NavDrawer label="кабінети та швидкі дії">
      <div className="sb-head">
        <a href="/queue" className="sb-logo"><span className="dot" />RadFlow</a>
        <div className="sb-sub">{adminRole || "Адміністратор"}{clinicName ? " • " + clinicName : ""}</div>
      </div>

      <nav className="sb-nav">
        <div className="sb-section">
          <div className="sb-label">Кабінети</div>
          <button type="button" onClick={() => onSelectRoom && onSelectRoom("all")}
            className={"sb-item sb-cab-all" + (activeRoom === "all" ? " active" : "")} style={{ width: "100%", textAlign: "left", background: "none", cursor: "pointer" }}>
            <span className="ic">▦</span>
            <span className="sb-item-lab">Усі кабінети</span>
            <span className="sb-cab-count">{(rooms || []).length}</span>
          </button>
          {(rooms || []).map((r) => (
            <button type="button" key={r.id} onClick={() => onSelectRoom && onSelectRoom(r.id)}
              className={"sb-cab" + (activeRoom === r.id ? " active" : "") + (stoppedRoomIds.includes(r.id) ? " stopped" : "")}
              title={stoppedRoomIds.includes(r.id) ? "Кабінет зупинено (простій)" : undefined}
              style={{ width: "100%", textAlign: "left", border: "none", cursor: "pointer" }}>
              <span className={"sb-cab-tile " + modalityKind(r.modality)}>{modalityShort(r.modality)}</span>
              <span className="sb-cab-meta">
                <span className="sb-cab-name">{stoppedRoomIds.includes(r.id) ? "🛑 " : ""}{r.name}</span>
                {/* У вимкненого кабінету-залишку замість моделі апарата — причина,
                    чому він досі тут: «вимкнено · 3 записи». Модель у цей момент
                    менш важлива за те, що в кабінеті лишились люди. */}
                <span className="sb-cab-model">{roomNoteOf?.(r.id) || r.apparatus_model || ""}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="sb-section">
          {/* H4-3: дії-кнопки рендеряться лише коли батько передав хендлер. «Новий
              запис»/«Інциденти» раніше показувались на КОЖНІЙ сторінці (колл-лист,
              лист очікування, налаштування), але onNew/onBreakdown передає лише
              дошка черги — на решті це був клік у нікуди. Тепер — як onSlotsOverview
              /onEmergency: немає хендлера → немає пункту (не показуємо dead actions). */}
          <div className="sb-label">Швидкі дії</div>
          <a href="/queue" className={"sb-item" + (activeNav === "queue" ? " active" : "")}><span className="ic">▦</span><span className="sb-item-lab">Дошка черги</span></a>
          {isAdmin && onSlotsOverview && <button type="button" onClick={onSlotsOverview} className="sb-item" style={{ width: "100%", textAlign: "left", background: "none", cursor: "pointer" }}>
            <span className="ic">◫</span><span className="sb-item-lab">Зайнятість кабінету</span>
          </button>}
          {onNew && <button type="button" onClick={() => onNew()} className="sb-item" style={{ width: "100%", textAlign: "left", background: "none", cursor: "pointer" }}>
            <span className="ic">＋</span>
            <span className="sb-item-lab">Новий запис</span>
          </button>}
          <a href="/call-list" className={"sb-item" + (activeNav === "calls" ? " active" : "")}><span className="ic">☎</span><span className="sb-item-lab">Колл-лист</span></a>
          <a href="/waitlist" className={"sb-item" + (activeNav === "waitlist" ? " active" : "")}>
            <span className="ic">⏳</span>
            <span className="sb-item-lab">Лист очікування</span>
            {waitCount ? <span className="sb-badge">{waitCount}</span> : null}
          </a>
          {/* ?from= — щоб портал знав, куди повернути адміна. Значення звіряється
              зі списком маршрутів на сервері (lib/portalBack), тож підроблений
              параметр в адресному рядку просто дає /queue. */}
          {isAdmin && <a href={"/referral?from=" + encodeURIComponent(pathname || "/queue")} className={"sb-item" + (activeNav === "ref" ? " active" : "")}><span className="ic">📨</span><span className="sb-item-lab">Портал направлень</span></a>}
          {onBreakdown && <button type="button" onClick={() => onBreakdown()} className="sb-item" style={{ width: "100%", textAlign: "left", background: "none", cursor: "pointer" }}>
            <span className="ic">⚠</span>
            <span className="sb-item-lab">Інциденти</span>
            {incidentCount ? <span className="sb-badge sb-badge-red">{incidentCount}</span> : null}
          </button>}
          {onEmergency && (
            <button type="button" onClick={() => onEmergency()} aria-pressed={emergencyActive}
              className={"sb-item sb-emergency" + (emergencyActive ? " on" : "")} style={{ width: "100%", textAlign: "left", cursor: "pointer" }}
              title={emergencyActive ? "Аварія активна — відкрити, щоб відновити роботу" : "Аварійно зупинити роботу кабінетів"}>
              <span className="ic">🛑</span>
              <span className="sb-item-lab">Аварійна зупинка</span>
              {emergencyActive && <span className="sb-badge sb-badge-red">СТОП</span>}
            </button>
          )}
        </div>
      </nav>

      <div className="sb-settings">
        {showCeoLink && <a href="/ceo" className={"sb-item" + (activeNav === "ceo" ? " active" : "")}><span className="ic">📊</span><span className="sb-item-lab">Дашборд CEO</span></a>}
        {isAdmin && <a href="/setup" className="sb-item"><span className="ic">⚙</span><span className="sb-item-lab">Майстер налаштування</span></a>}
        {/* Звукові сповіщення отримують admin/registrar; CEO — ні (і перемикач не бачить). */}
        {!isCeo && <SoundToggle />}
        <div className="sb-density-box"><DensityControl /></div>
      </div>

      <div className="sb-user">
        <div className="avatar" style={{ background: "linear-gradient(135deg,#0a84ff,#7b5cff)" }}>{initials(adminName)}</div>
        <div className="meta">
          <div className="nm">{adminName || "Користувач"}</div>
          <div className="rl">{adminRole || "Адміністратор"}</div>
        </div>
        <button className="icon-btn" title="Вийти" onClick={signOut}>⏻</button>
      </div>
    </NavDrawer>
  );
}
