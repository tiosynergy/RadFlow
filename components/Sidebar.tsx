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
import UnreadDot from "@/components/UnreadDot";
import { UnreadChangesMount, useUnreadChanges } from "@/lib/useUnreadChanges";
import { unreadForNav } from "@/lib/unreadChanges";

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
  /* ⚠️ ОБОВʼЯЗКОВИЙ, БЕЗ ТИПОВОГО ЗНАЧЕННЯ (RF-4, с57). Було `roleKey?: string`
     плюс `roleKey = "admin"` у сигнатурі: екран, який забув передати роль,
     мовчки отримував АДМІНСЬКЕ меню. Виклик без ролі тепер не збирається —
     повнота тримається типом, а не пильністю (той самий прийом, що з `clock`
     у Г1-F). Усі виклики роль передавали й раніше: правка нічого не змінює
     сьогодні і закриває ідіому назавжди. */
  roleKey: string;
  /* ⚠️ ОБОВʼЯЗКОВИЙ, БЕЗ ТИПОВОГО ЗНАЧЕННЯ (U-65, с57) — той самий прийом, що з
     `roleKey`. Це центри, чиї рядки листа очікування цей користувач БАЧИТЬ, і
     рівно з них має отримувати realtime-події для бейджа. Порожній масив — теж
     повноцінна відповідь («центрів немає»), і тоді підписки немає ЗОВСІМ:
     краще застарілий бейдж, ніж підписка без фільтра (див. коментар нижче).
     Масив, а не один id, бо керівник рахує лист по ВСІХ своїх центрах, а
     `postgres_changes` уміє лише одну рівність на підписку — фан-аут по центру
     вже відпрацьований у CeoDashboard. */
  clinicIds: string[];
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
  roleKey,
  clinicIds,
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
  /* Лічильник листа очікування (RLS сам обмежує видимість клінікою користувача).
     Live: realtime-підписка на waitlist_entries, щоб бейдж не розходився зі
     списком після додавання/зняття.
     ⚠️ Коментар тут стверджував «без фільтра — RLS віддає лише видимі рядки».
     Для подій DELETE це неточно: `realtime.apply_rls` політику на них не
     ОБЧИСЛЮЄ (`if not is_rls_enabled or action = 'DELETE' then …`), тож рішення
     «кому доставити» приймає лише фільтр підписки — а його тут немає.
     ⚠️ Але вмісту рядка це НЕ віддає (перевірено в тілі функції на проді,
     U-61): знаючи про діру, вона ріже `old_record` до первинного ключа —
     У ГІЛЦІ DELETE (уточнення с57, U-66: у гілці UPDATE обрізки НЕМАЄ), щойно
     на таблиці ввімкнено RLS —
       and ( not is_rls_enabled or (c).is_pkey )
         -- if RLS enabled, we can't secure deletes so filter to pkey
     RLS увімкнено на всіх 11 таблицях публікації (заміряно), і це стереже
     нічний `invariants_check` (перевірка №3: жодної таблиці public без RLS).
     Отже сюди приїжджає `{id}`, а не ПІБ із телефоном.
     ⚠️ Що лишалось і чому це все-таки був борг: без фільтра сюди прилітав ФАКТ
     і ЧАС кожного видалення рядка листа в УСІЙ базі — крос-тенантний оракул
     ідентифікаторів. ЗАКРИТО в с57 (U-65): підписка йде по одній на КОЖЕН
     видимий центр, з `clinic_id=eq.` — див. нижче. */
  const [waitCount, setWaitCount] = useState(0);
  const loadWaitCount = useCallback(async () => {
    try {
      const supabase = createClient();
      /* ⚠️ `error` ЧИТАЄМО (F4-9). PostgREST не кидає — він повертає {data,
         error}, тож `catch` нижче на збій читання не спрацьовує, і `count ?? 0`
         писав у бейдж НУЛЬ. Коментар обіцяв «лишаємо попереднє значення», а код
         робив протилежне: реєстратор, у якого щойно звільнився слот, бачив «у
         листі нікого» і не відкривав лист. Той самий fail-CLOSED клас, закритий
         в усіх дошках і пропущений тут. */
      const { count, error } = await supabase
        .from("waitlist_entries")
        .select("id", { count: "exact", head: true })
        .eq("status", "waiting");
      if (error) return;   // збій читання ≠ «в листі нікого»
      setWaitCount(count ?? 0);
    } catch { /* транзієнтний збій мережі — лишаємо попереднє значення */ }
  }, []);
  useEffect(() => { loadWaitCount(); }, [loadWaitCount]);
  /* U-65: по підписці на КОЖЕН видимий центр, кожна з `clinic_id=eq.`.
     ⚠️ Чому не один фільтр: `postgres_changes` уміє рівно одну рівність, а
     керівник бачить кілька центрів — той самий фан-аут, що в CeoDashboard,
     і з тим самим СПІЛЬНИМ debounceKey (усі ведуть в один `loadWaitCount`:
     без ключа сплеск у 20 центрах дав би 20 читань підряд).
     ⚠️ `clinicIds` порожній → каналу НЕМАЄ. Це свідомий fail-closed: бейдж
     оновиться на маунті, при поверненні на вкладку і на навігації, а от
     підписки без фільтра — тієї самої, заради якої заведено U-65, — не буде
     ніколи. Краще застарілий лічильник, ніж крос-тенантний оракул.
     ⚠️ Список ЗВУЖУЄ доставку, але нічого не відкриває: що прочитається,
     вирішує RLS (`waitlist_select` + `waitlist_ceo_read`). Помилитись тут
     можна лише в бік СВІЖОСТІ, не конфіденційності. */
  useRealtimeRefetch({
    channelName: clinicIds.length ? "sb-waitlist-badge" : null,
    subscriptions: clinicIds.map((cid) => ({
      table: "waitlist_entries" as const,
      filter: "clinic_id=eq." + cid,
      onChange: loadWaitCount,
      debounceKey: "wait-badge",
    })),
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

  /* Контекстні позначки (0131/0132). Провайдера може не бути (екрани, які
     його ще не змонтували) — тоді контекст порожній і крапок просто немає:
     панель НЕ повинна падати через те, що батько її не обгорнув. */
  const { index: unreadIx } = useUnreadChanges();
  const navUnread = (key: string) => unreadForNav(unreadIx, key);

  async function signOut() {
    await signOutAndRedirect(router);
  }

  return (
    /* Підписка на позначки монтується ТУТ, бо Sidebar є на кожному робочому
       екрані — і саме тому на всіх них крапки живі. Компонент нічого не
       малює: глобального індикатора ТЗ не допускає. */
    <NavDrawer label="кабінети та швидкі дії">
      <UnreadChangesMount />
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
          <a href="/queue" className={"sb-item" + (activeNav === "queue" ? " active" : "")}><span className="ic">▦</span><span className="sb-item-lab">Дошка черги</span><UnreadDot markers={navUnread("queue")} withCount /></a>
          {isAdmin && onSlotsOverview && <button type="button" onClick={onSlotsOverview} className="sb-item" style={{ width: "100%", textAlign: "left", background: "none", cursor: "pointer" }}>
            <span className="ic">◫</span><span className="sb-item-lab">Зайнятість кабінету</span>
          </button>}
          {onNew && <button type="button" onClick={() => onNew()} className="sb-item" style={{ width: "100%", textAlign: "left", background: "none", cursor: "pointer" }}>
            <span className="ic">＋</span>
            <span className="sb-item-lab">Новий запис</span>
          </button>}
          {/* с22: універсальний пошук — історія і майбутні записи всіх ролей. */}
          <a href="/search" className={"sb-item" + (activeNav === "search" ? " active" : "")}><span className="ic">⌕</span><span className="sb-item-lab">Пошук</span></a>
          <a href="/call-list" className={"sb-item" + (activeNav === "calls" ? " active" : "")}><span className="ic">☎</span><span className="sb-item-lab">Колл-лист</span></a>
          <a href="/waitlist" className={"sb-item" + (activeNav === "waitlist" ? " active" : "")}>
            <span className="ic">⏳</span>
            <span className="sb-item-lab">Лист очікування</span>
            <UnreadDot markers={navUnread("waitlist")} withCount />
            {waitCount ? <span className="sb-badge">{waitCount}</span> : null}
          </a>
          {/* ?from= — щоб портал знав, куди повернути адміна. Значення звіряється
              зі списком маршрутів на сервері (lib/portalBack), тож підроблений
              параметр в адресному рядку просто дає /queue. */}
          {isAdmin && <a href={"/referral?from=" + encodeURIComponent(pathname || "/queue")} className={"sb-item" + (activeNav === "ref" ? " active" : "")}><span className="ic">📨</span><span className="sb-item-lab">Портал направлень</span><UnreadDot markers={navUnread("ref")} withCount /></a>}
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
        {/* с25: журнал важливих подій — лише адміністратор (ТЗ §11 / §9). */}
        {isAdmin && <a href="/journal" className={"sb-item" + (activeNav === "journal" ? " active" : "")}><span className="ic">🗒</span><span className="sb-item-lab">Журнал дій</span></a>}
        {/* Крапка «centers» (доступи направників) — доріжка адміна до /referrers
            веде через майстер, прямого пункту в панелі немає (с28): без крапки
            тут позначка про зміну доступу була адміну просто невидимою. */}
        {isAdmin && <a href="/setup" className="sb-item"><span className="ic">⚙</span><span className="sb-item-lab">Майстер налаштування</span><UnreadDot markers={navUnread("centers")} withCount /></a>}
        {/* Звукові сповіщення отримують admin/registrar; CEO — ні (і перемикач не бачить). */}
        {!isCeo && <SoundToggle />}
        <div className="sb-density-box"><DensityControl /></div>
      </div>

      <div className="sb-user">
        <div className="avatar" style={{ background: "linear-gradient(135deg,var(--blue),#6344e0)" }}>{initials(adminName)}</div>
        <div className="meta">
          <div className="nm">{adminName || "Користувач"}</div>
          <div className="rl">{adminRole || "Адміністратор"}</div>
        </div>
        <button className="icon-btn" title="Вийти" onClick={signOut}>⏻</button>
      </div>
    </NavDrawer>
  );
}
