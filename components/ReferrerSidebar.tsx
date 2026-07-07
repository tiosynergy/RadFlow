"use client";

/* ===== RadFlow — ReferrerSidebar =====
   Лівий сайдбар порталу направника (як у адміністратора): секція «Мої центри»
   з доступним обладнанням по кожному центру + навігація «Швидкі дії»
   (перемикає вкладки порталу через onNav). */

import DensityControl from "@/components/DensityToggle";

type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null };
type Center = { clinicId: string; name: string; city: string | null; status: string; policy?: string | null; room_ids?: string[] | null; accessId?: string | null };

function modalityLabel(m: string) { return m === "MRI" ? "МРТ" : m === "CT" ? "КТ" : "Інше"; }
function initials(name?: string | null) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "РН";
  return (parts[0][0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
}

interface Props {
  centers: Center[]; // активні центри
  roomsByClinic: Record<string, RoomOpt[]>;
  doctorName: string;
  activeTab: string;
  onNav: (key: string) => void;
  counts: { mine: number; waitlist: number; pendingInvites: number };
  canManage: boolean;
  onSignOut: () => void;
}

export default function ReferrerSidebar({ centers, roomsByClinic, doctorName, activeTab, onNav, counts, canManage, onSignOut }: Props) {
  const nav: Array<{ key: string; label: string; icon: string; badge?: number; badgeBlue?: boolean }> = [
    { key: "new", label: "Нове направлення", icon: "＋" },
    { key: "mine", label: "Мої направлення", icon: "▦", badge: counts.mine },
    { key: "waitlist", label: "Лист очікування", icon: "⏳", badge: counts.waitlist },
    { key: "centers", label: "Мої центри", icon: "🏥", badge: counts.pendingInvites, badgeBlue: true },
    ...(canManage ? [{ key: "profile", label: "Мій профіль", icon: "👤" }] : []),
  ];

  return (
    <aside className="sidebar">
      <div className="sb-head">
        <span className="sb-logo"><span className="dot" />Referral RadFlow</span>
        <div className="sb-sub">Лікар-направник{doctorName ? " • " + doctorName : ""}</div>
      </div>

      <nav className="sb-nav">
        <div className="sb-section">
          <div className="sb-label">Мої центри</div>
          {centers.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "4px 10px" }}>Немає активних центрів</div>
          ) : centers.map((c) => {
            const rooms = roomsByClinic[c.clinicId] || [];
            return (
              <div key={c.clinicId} style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", padding: "4px 10px 2px" }} title={c.city ? c.name + " · " + c.city : c.name}>{c.name}</div>
                {rooms.length === 0 ? (
                  <div style={{ fontSize: 11.5, color: "var(--text-faint)", padding: "0 10px 2px" }}>обладнання не вказано</div>
                ) : rooms.map((r) => (
                  <div key={r.id} className="sb-cab" style={{ cursor: "default" }} title={r.name + (r.apparatus_model ? " · " + r.apparatus_model : "")}>
                    <span className={"sb-cab-tile " + (r.modality === "MRI" ? "mrt" : "ct")}>{modalityLabel(r.modality)}</span>
                    <span className="sb-cab-meta">
                      <span className="sb-cab-name">{r.name}</span>
                      <span className="sb-cab-model">{r.apparatus_model || ""}</span>
                    </span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>

        <div className="sb-section">
          <div className="sb-label">Швидкі дії</div>
          {nav.map((it) => (
            <button key={it.key} type="button" onClick={() => onNav(it.key)}
              className={"sb-item" + (activeTab === it.key ? " active" : "")}
              style={{ width: "100%", textAlign: "left", background: "none", cursor: "pointer" }}>
              <span className="ic">{it.icon}</span>
              <span className="sb-item-lab">{it.label}</span>
              {it.badge ? <span className="sb-badge" style={it.badgeBlue ? { background: "var(--blue)", color: "#fff" } : undefined}>{it.badge}</span> : null}
            </button>
          ))}
        </div>
      </nav>

      <div className="sb-settings">
        <div className="sb-density-box"><DensityControl /></div>
      </div>

      <div className="sb-user">
        <div className="avatar" style={{ background: "linear-gradient(135deg,#0a84ff,#7b5cff)" }}>{initials(doctorName)}</div>
        <div className="meta">
          <div className="nm">{doctorName || "Направник"}</div>
          <div className="rl">Лікар-направник</div>
        </div>
        <button className="icon-btn" title="Вийти" onClick={onSignOut}>⏻</button>
      </div>
    </aside>
  );
}
