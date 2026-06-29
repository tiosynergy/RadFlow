"use client";

/* ===== RadFlow — бічна панель (Sidebar) =====
   Портовано з rf-shell.jsx. Кабінети — з БД, клініка/адмін — з props.
   Деякі операції (Колл-лист, Інцидент, Кабінет радіолога) — окремі етапи (disabled). */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { signOutAndRedirect } from "@/lib/auth";

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
  onNew?: () => void;
  incidentCount?: number;
  onBreakdown?: () => void;
}

function modalityLabel(m: string): string {
  return m === "MRI" ? "МРТ" : m === "CT" ? "КТ" : "Інше";
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
  activeRoom = "all",
  activeNav,
  onSelectRoom,
  onNew,
  incidentCount = 0,
  onBreakdown,
}: SidebarProps) {
  const router = useRouter();
  const isAdmin = roleKey === "admin";
  const isCeo = roleKey === "ceo";

  // Крос-рольовий CEO серед НЕ-адмінів (напр. реєстратор з грантом ceo_access)
  // бачить посилання на дашборд. На сторінці адміна прямого посилання немає —
  // керування центрами адмін відкриває з Майстра налаштувань.
  const [hasCeoGrant, setHasCeoGrant] = useState(false);
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
    <aside className="sidebar">
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
              className={"sb-cab" + (activeRoom === r.id ? " active" : "")} style={{ width: "100%", textAlign: "left", border: "none", cursor: "pointer" }}>
              <span className={"sb-cab-tile " + (r.modality === "MRI" ? "mrt" : "ct")}>{modalityLabel(r.modality)}</span>
              <span className="sb-cab-meta">
                <span className="sb-cab-name">{r.name}</span>
                <span className="sb-cab-model">{r.apparatus_model || ""}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="sb-section">
          <div className="sb-label">Швидкі дії</div>
          <a href="/queue" className={"sb-item" + (activeNav === "queue" ? " active" : "")}><span className="ic">▦</span><span className="sb-item-lab">Дошка черги</span></a>
          <button type="button" onClick={() => onNew && onNew()} className="sb-item" style={{ width: "100%", textAlign: "left", background: "none", cursor: "pointer" }}>
            <span className="ic">＋</span>
            <span className="sb-item-lab">Новий запис</span>
          </button>
          <a href="/call-list" className={"sb-item" + (activeNav === "calls" ? " active" : "")}><span className="ic">☎</span><span className="sb-item-lab">Колл-лист</span></a>
          {isAdmin && <a href="/referral" className={"sb-item" + (activeNav === "ref" ? " active" : "")}><span className="ic">📨</span><span className="sb-item-lab">Портал направлень</span></a>}
          <button type="button" onClick={() => onBreakdown && onBreakdown()} className="sb-item" style={{ width: "100%", textAlign: "left", background: "none", cursor: "pointer" }}>
            <span className="ic">⚠</span>
            <span className="sb-item-lab">Інциденти</span>
            {incidentCount ? <span className="sb-badge sb-badge-red">{incidentCount}</span> : null}
          </button>
        </div>
      </nav>

      <div className="sb-settings">
        {showCeoLink && <a href="/ceo" className={"sb-item" + (activeNav === "ceo" ? " active" : "")}><span className="ic">📊</span><span className="sb-item-lab">Дашборд CEO</span></a>}
        {isAdmin && <a href="/setup" className="sb-item"><span className="ic">⚙</span><span className="sb-item-lab">Майстер налаштування</span></a>}
      </div>

      <div className="sb-user">
        <div className="avatar" style={{ background: "linear-gradient(135deg,#0a84ff,#7b5cff)" }}>{initials(adminName)}</div>
        <div className="meta">
          <div className="nm">{adminName || "Користувач"}</div>
          <div className="rl">{adminRole || "Адміністратор"}</div>
        </div>
        <button className="icon-btn" title="Вийти" onClick={signOut}>⏻</button>
      </div>
    </aside>
  );
}
