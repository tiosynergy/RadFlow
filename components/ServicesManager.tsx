"use client";

/* ===== RadFlow — Сторінка каталогу послуг (/services, admin) =====
   Stage 2. Тонка оболонка (сайдбар + топбар) навколо спільного ядра
   ServicesEditor (те саме ядро вбудовано в крок Майстра «Послуги та прайс»).
   Дані — SSR-пропи (services + service_room_overrides); мутації всередині
   ServicesEditor через Server Actions. */

import Sidebar from "@/components/Sidebar";
import LiveClock from "@/components/LiveClock";
import ServicesEditor from "@/components/ServicesEditor";
import { setClinicTz, wallToday0 } from "@/lib/incidents";
import type { Tables } from "@/supabase/types";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";

type ServiceRow = Tables<"services">;
type SroRow = Tables<"service_room_overrides">;
type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null };

const WK = ["Неділя", "Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця", "Субота"];
const MON_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
function fmtFull(d: Date) { return WK[d.getDay()] + ", " + d.getDate() + " " + MON_GEN[d.getMonth()] + " " + d.getFullYear(); }

interface Props {
  clinicId: string;
  clinicTz: string;
  initialServices: ServiceRow[];
  roomOverrides?: SroRow[];
  rooms?: RoomOpt[];
  clinicName?: string;
  adminName?: string;
}

export default function ServicesManager({ clinicId, clinicTz, initialServices, roomOverrides, rooms, clinicName, adminName }: Props) {
  if (typeof window !== "undefined") setClinicTz(clinicTz);
  return (
    <div className="app">
      <Sidebar clinicName={clinicName} adminName={adminName} adminRole="Адміністратор" roleKey="admin"
        rooms={rooms} activeNav="services" />
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
            <ServicesEditor clinicId={clinicId} services={initialServices} rooms={rooms} roomOverrides={roomOverrides} />
          </div>
        </div>
      </div>
    </div>
  );
}
