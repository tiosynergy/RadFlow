"use client";

/* ===== RadFlow — бічна панель (Sidebar) =====
   Портовано з rf-shell.jsx. Кабінети — з БД, клініка/адмін — з props.
   Деякі операції (Колл-лист, Інцидент, Кабінет радіолога) — окремі етапи (disabled). */

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

function modalityLabel(m) { return m === "MRI" ? "МРТ" : m === "CT" ? "КТ" : "Інше"; }
function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "RF";
  return (parts[0][0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
}

export default function Sidebar({ clinicName, adminName, adminRole, rooms, activeRoom = "all", activeNav, onSelectRoom, onNew, incidentCount = 0, onBreakdown }) {
  const router = useRouter();

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const soon = (label) => (
    <span key={label} className="sb-item" title="Незабаром" style={{ opacity: 0.45, cursor: "not-allowed" }}>
      <span className="ic">·</span>
      <span className="sb-item-lab">{label}</span>
    </span>
  );

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
          <div className="sb-label">Операції</div>
          <button type="button" onClick={() => onNew && onNew()} className="sb-item" style={{ width: "100%", textAlign: "left", background: "none", cursor: "pointer" }}>
            <span className="ic">＋</span>
            <span className="sb-item-lab">Новий запис</span>
          </button>
          <a href="/call-list" className={"sb-item" + (activeNav === "calls" ? " active" : "")}><span className="ic">☎</span><span className="sb-item-lab">Колл-лист</span></a>
          <button type="button" onClick={() => onBreakdown && onBreakdown()} className="sb-item" style={{ width: "100%", textAlign: "left", background: "none", cursor: "pointer" }}>
            <span className="ic">⚠</span>
            <span className="sb-item-lab">Інцидент</span>
            {incidentCount ? <span className="sb-badge sb-badge-red">{incidentCount}</span> : null}
          </button>
          {soon("Лікар-направляч")}
          <a href="/setup" className="sb-item"><span className="ic">₴</span><span className="sb-item-lab">Прайс-лист / Налаштування</span></a>
        </div>
      </nav>

      <div className="sb-settings">
        <a href="/queue" className={"sb-item" + (activeNav === "queue" ? " active" : "")}><span className="ic">▦</span><span className="sb-item-lab">Дошка черги</span></a>
        <a href="/radiologist" className={"sb-item" + (activeNav === "rad" ? " active" : "")}><span className="ic">🩺</span><span className="sb-item-lab">Кабінет радіолога</span></a>
        <a href="/ceo" className={"sb-item" + (activeNav === "ceo" ? " active" : "")}><span className="ic">📊</span><span className="sb-item-lab">Дашборд CEO</span></a>
        <a href="/staff" className={"sb-item" + (activeNav === "staff" ? " active" : "")}><span className="ic">👥</span><span className="sb-item-lab">Радіологи та доступи</span></a>
        <a href="/referrers" className={"sb-item" + (activeNav === "referrers" ? " active" : "")}><span className="ic">🩺</span><span className="sb-item-lab">Лікарі-направники</span></a>
        <a href="/referral" className={"sb-item" + (activeNav === "ref" ? " active" : "")}><span className="ic">📨</span><span className="sb-item-lab">Портал направлень</span></a>
        <a href="/setup" className="sb-item"><span className="ic">⚙</span><span className="sb-item-lab">Майстер налаштування</span></a>
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
