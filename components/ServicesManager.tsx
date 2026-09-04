"use client";

/* ===== RadFlow — Сторінка каталогу послуг (/services, admin) =====
   Stage 2. Тонка оболонка (сайдбар + топбар) навколо спільного ядра
   ServicesEditor (те саме ядро вбудовано в крок Майстра «Послуги та прайс»).
   Дані — SSR-пропи (services + service_room_overrides); мутації всередині
   ServicesEditor через Server Actions. */

import Sidebar from "@/components/Sidebar";
import LiveClock from "@/components/LiveClock";
import ServicesEditor from "@/components/ServicesEditor";
import { useAckWhenVisible } from "@/lib/useUnreadChanges";
import { setClinicTz, wallToday0 } from "@/lib/incidents";
import { visibleRooms, residualSet, roomOffLabel } from "@/lib/rooms";
import type { Tables } from "@/supabase/types";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";

type ServiceRow = Tables<"services">;
type SroRow = Tables<"service_room_overrides">;
type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null; active?: boolean | null };

const WK = ["Неділя", "Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця", "Субота"];
const MON_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
function fmtFull(d: Date) { return WK[d.getDay()] + ", " + d.getDate() + " " + MON_GEN[d.getMonth()] + " " + d.getFullYear(); }

interface Props {
  clinicId: string;
  clinicTz: string;
  initialServices: ServiceRow[];
  roomOverrides?: SroRow[];
  rooms?: RoomOpt[];
  /** id вимкнених кабінетів, у яких ЩЕ лишились живі записи («кабінети-залишки»).
   *  Вимкнений кабінет ховаємо зі списків, але поки в ньому щось є — він спливає
   *  назад із підписом «вимкнено · N записів». Див. lib/rooms.ts. */
  residualRoomIds?: string[];
  /** Скільки саме лишилось у кожному такому кабінеті — для підпису. */
  residualRoomCounts?: Record<string, number>;
  clinicName?: string;
  adminName?: string;
}

export default function ServicesManager({ clinicId, clinicTz, initialServices, roomOverrides, rooms, residualRoomIds, residualRoomCounts, clinicName, adminName }: Props) {
  if (typeof window !== "undefined") setClinicTz(clinicTz);

  /* Каталог приходить SSR-пропами і рендериться ЦІЛИМ — тож відкриття
     сторінки і є показ актуального каталогу: підтверджуємо поверхню
     services (агрегатні позначки по кабінетах, ревʼю р2 H-3new). Це НЕ
     порушує правило про пагіновані списки: тут пагінації немає. */
  useAckWhenVisible({ kind: "surface", surface: "services" }, true);

  /* Списки кабінетів на цьому екрані — активні + вимкнені із залишками. Сюди ж
     іде вибір «Кабінети (власний прайс)» у ServicesEditor: заводити окремий прайс
     виведеному з експлуатації кабінету немає сенсу. Рядок service_room_overrides
     при цьому нікуди не дінеться — він просто не редагується звідси; повний
     перелік кабінетів лишається в Майстрі налаштувань (/setup). */
  const residual = residualSet(residualRoomIds);
  const visRooms = visibleRooms(rooms, residual);
  const offNote = (roomId: string): string | null => {
    const r = (rooms || []).find((x) => x.id === roomId);
    return r && r.active === false ? roomOffLabel(residualRoomCounts?.[roomId]) : null;
  };

  return (
    <div className="app">
      <Sidebar clinicName={clinicName} adminName={adminName} adminRole="Адміністратор" roleKey="admin"
        clinicIds={clinicId ? [clinicId] : []} rooms={visRooms} roomNoteOf={offNote} activeNav="services" />
      <div className="main">
        <header className="topbar">
          <div className="tb-title">
            <span className="tic">₴</span>
            <div>
              <h1>Послуги та ціни</h1>
              <div className="date">{fmtFull(wallToday0(clinicTz))} · <LiveClock tz={clinicTz} /></div>
            </div>
          </div>
        </header>
        <div className="content-full">
          <div className="page-max">
            <ServicesEditor clinicId={clinicId} services={initialServices} rooms={visRooms} roomOverrides={roomOverrides} />
          </div>
        </div>
      </div>
    </div>
  );
}
