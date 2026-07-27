"use client";

/* ===== RadFlow — ReferrerSidebar =====
   Лівий сайдбар порталу направника (як у адміністратора): секція «Мої центри»
   з доступним обладнанням по кожному центру + навігація «Швидкі дії»
   (перемикає вкладки порталу через onNav). */

import DensityControl from "@/components/DensityToggle";
import { modalityShort, modalityKind } from "@/lib/studies";

type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null };
type Center = { clinicId: string; name: string; city: string | null; status: string; policy?: string | null; room_ids?: string[] | null; accessId?: string | null };

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
  /** Швидкий фільтр доски «Мої направлення»: клік по центру (roomId="all") або кабінету. */
  onSelectRoom?: (clinicId: string, roomId: string) => void;
  activeClinic?: string;
  activeRoom?: string;
  counts: { mine: number; waitlist: number; pendingInvites: number };
  canManage: boolean;
  onSignOut: () => void;
  /* Адмін відкрив портал з свого робочого місця (Sidebar → «Портал направлень»).
     Портал підміняє ВЕСЬ чром: адмінський сайдбар зникає, і без цієї кнопки
     єдиним виходом лишався ⏻ — тобто повний вихід із системи. */
  backHref?: string | null;
  backLabel?: string | null;
}

export default function ReferrerSidebar({ centers, roomsByClinic, doctorName, activeTab, onNav, onSelectRoom, activeClinic, activeRoom, counts, canManage, onSignOut, backHref = null, backLabel = null }: Props) {
  const isPreview = !!backHref;   // адмін дивиться портал, а не працює в ньому
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
        {/* Клікабельний логотип — те, що адмін пробує першим: у власному
            сайдбарі (Sidebar.tsx) він теж веде на робоче місце. */}
        {isPreview
          ? <a href={backHref!} className="sb-logo" title={"Повернутися: " + (backLabel || "мій центр")}><span className="dot" />Referral RadFlow</a>
          : <span className="sb-logo"><span className="dot" />Referral RadFlow</span>}
        {/* Підпис ролі був жорстко «Лікар-направник» — адмін бачив чуже звання
            і не розумів, чи він досі під своїм акаунтом. */}
        <div className="sb-sub">{isPreview ? "Перегляд порталу" : "Лікар-направник"}{doctorName ? " • " + doctorName : ""}</div>
      </div>

      <nav className="sb-nav">
        <div className="sb-section">
          <div className="sb-label">Мої центри</div>
          {centers.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "4px 10px" }}>Немає активних центрів</div>
          ) : centers.map((c) => {
            const all = roomsByClinic[c.clinicId] || [];
            // Показуємо лише ДОЗВОЛЕНІ кабінети (room_ids). null/порожньо = усі
            // кабінети центру — так само, як фільтрує форма запису й БД-гейт
            // auth_referrer_can_book_room. Раніше показувались усі → рассинхрон.
            const allowed = Array.isArray(c.room_ids) && c.room_ids.length ? c.room_ids : null;
            const rooms = allowed ? all.filter((r) => allowed.includes(r.id)) : all;
            const centerActive = activeClinic === c.clinicId && activeRoom === "all";
            return (
              <div key={c.clinicId} style={{ marginBottom: 8 }}>
                <button type="button" onClick={() => onSelectRoom && onSelectRoom(c.clinicId, "all")}
                  className={"sb-cab-all" + (centerActive ? " active" : "")}
                  style={{ width: "100%", textAlign: "left", background: "none", border: "none", cursor: onSelectRoom ? "pointer" : "default", fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", padding: "4px 10px 2px" }}
                  title={c.city ? c.name + " · " + c.city : c.name}>{c.name}</button>
                {rooms.length === 0 ? (
                  <div style={{ fontSize: 11.5, color: "var(--text-faint)", padding: "0 10px 2px" }}>обладнання не вказано</div>
                ) : rooms.map((r) => (
                  <button type="button" key={r.id} onClick={() => onSelectRoom && onSelectRoom(c.clinicId, r.id)}
                    className={"sb-cab" + (activeClinic === c.clinicId && activeRoom === r.id ? " active" : "")}
                    style={{ width: "100%", textAlign: "left", border: "none", cursor: onSelectRoom ? "pointer" : "default" }}
                    title={r.name + (r.apparatus_model ? " · " + r.apparatus_model : "")}>
                    <span className={"sb-cab-tile " + modalityKind(r.modality)}>{modalityShort(r.modality)}</span>
                    <span className="sb-cab-meta">
                      <span className="sb-cab-name">{r.name}</span>
                      <span className="sb-cab-model">{r.apparatus_model || ""}</span>
                    </span>
                  </button>
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
        {isPreview && (
          <a href={backHref!} className="sb-item sb-back" title={"Повернутися до робочого місця: " + (backLabel || "мій центр")}>
            <span className="ic" aria-hidden>←</span>
            <span className="sb-item-lab">Повернутися: {backLabel || "мій центр"}</span>
          </a>
        )}
        <div className="sb-density-box"><DensityControl /></div>
      </div>

      <div className="sb-user">
        <div className="avatar" style={{ background: "linear-gradient(135deg,#0a84ff,#7b5cff)" }}>{initials(doctorName)}</div>
        <div className="meta">
          <div className="nm">{doctorName || "Направник"}</div>
          <div className="rl">{isPreview ? "Адміністратор" : "Лікар-направник"}</div>
        </div>
        {/* Для адміна уточнюємо, що це ВИХІД ІЗ СИСТЕМИ, а не з порталу:
            поруч стоїть кнопка повернення, і переплутати їх коштує сесії. */}
        <button className="icon-btn" title={isPreview ? "Вийти з системи (щоб просто закрити портал — «Повернутися»)" : "Вийти"} onClick={onSignOut}>⏻</button>
      </div>
    </aside>
  );
}
