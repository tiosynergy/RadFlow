/* с80 (Н-16) — чисті функції CSV колл-листа (lib/callListExport.ts).
 *
 * Що тут пінимо: підписи статусу дзвінка і назву процедури бачать і оператор
 * (CallListBoard), і файл (роут /api/call-list/export) — з ОДНОГО джерела.
 * До с80 у дошці жили свої копії (`CL_META` з літералами і локальний
 * `procLabel`), і файл будувався з них у браузері. Поведінку роуту стереже
 * tests/callListExportRoute.test.ts. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { codeOf } from "./helpers/codeOf";
import {
  CALL_LIST_EXPORT_HEAD,
  CALL_LIST_STATUSES,
  CALL_STATUS_LABELS,
  callListExportFileName,
  callListExportRows,
  callListProcLabel,
  callStatusLabel,
  compareCallListOrder,
  type CallListExportEntry,
} from "@/lib/callListExport";

const board = codeOf(readFileSync(resolve(process.cwd(), "components/CallListBoard.tsx"), "utf8"));

const e = (over: Partial<CallListExportEntry>): CallListExportEntry => ({
  id: "x", clinic_id: "c", scheduled_date: "2026-09-26", scheduled_time: "09:00", patient_name: "П",
  patient_phone: null, studies: [], note: null, room_id: null, call_status: null, call_note: null, ...over,
});

describe("підписи статусу дзвінка — одне джерело для дошки й файлу", () => {
  it("пʼять підписів дослівно ті, що були на дошці до с80", () => {
    expect(CALL_STATUS_LABELS).toEqual({
      not_called: "Ще не дзвонили",
      confirmed: "Підтверджено",
      no_answer: "Не відповідає",
      to_recall: "Передзвонити",
      declined: "Відмова",
    });
  });

  it("CL_META дошки бере підпис із CALL_STATUS_LABELS для КОЖНОГО статусу (жодного літерала)", () => {
    for (const k of Object.keys(CALL_STATUS_LABELS)) {
      expect(board).toMatch(new RegExp(`${k}: \\{ label: CALL_STATUS_LABELS\\.${k}, `));
    }
    expect(board).not.toMatch(/\{ label: "(Ще не дзвонили|Підтверджено|Не відповідає|Передзвонити|Відмова)"/);
  });

  it("порожній / невідомий статус — «Ще не дзвонили», як `call_status || \"not_called\"` на дошці", () => {
    expect(callStatusLabel(null)).toBe("Ще не дзвонили");
    expect(callStatusLabel(undefined)).toBe("Ще не дзвонили");
    expect(callStatusLabel("")).toBe("Ще не дзвонили");
    expect(callStatusLabel("щось-нове")).toBe("Ще не дзвонили");
    expect(callStatusLabel("declined")).toBe("Відмова");
  });
});

describe("назва процедури — одна функція", () => {
  it("дошка імпортує callListProcLabel, власної копії procLabel немає", () => {
    expect(board).toMatch(/callListProcLabel as procLabel,/);
    expect(board).not.toMatch(/function procLabel\(/);
  });

  it("контраст — суфікс лише там, де назва сама його не каже; без досліджень — примітка або «—»", () => {
    expect(callListProcLabel({ studies: [{ type: "МРТ", region: "Коліно" }] })).toBe("МРТ · Коліно");
    expect(callListProcLabel({ studies: [{ type: "МРТ", region: "Голова", contrast: true }] })).toBe("МРТ · Голова з контрастом");
    expect(callListProcLabel({ studies: [{ type: "КТ", region: "Контраст ОГК", contrast: true }] })).toBe("КТ · Контраст ОГК");
    expect(callListProcLabel({ studies: [{ type: "МРТ" }, { type: "КТ", region: "ОГК" }] })).toBe("МРТ + КТ · ОГК");
    expect(callListProcLabel({ studies: [], note: "Консультація" })).toBe("Консультація");
    expect(callListProcLabel({ studies: null, note: null })).toBe("—");
  });
});

describe("рядки, порядок, імʼя файлу", () => {
  it("заголовок і колонки — як до с80; дата — першою колонкою", () => {
    expect([...CALL_LIST_EXPORT_HEAD]).toEqual(["Дата", "Час", "Пацієнт", "Телефон", "Процедура", "Кабінет", "Статус", "Нотатка"]);
    const rows = callListExportRows(
      [e({ patient_phone: "+380", room_id: "R", call_status: "to_recall", call_note: "н", studies: [{ type: "МРТ", region: "Коліно" }] })],
      (id) => (id === "R" ? "МРТ-1" : "?")
    );
    expect(rows).toEqual([["2026-09-26", "09:00", "П", "+380", "МРТ · Коліно", "МРТ-1", "Передзвонити", "н"]]);
  });

  it("без кабінету — порожньо, а не «?» резолвера; null-поля — порожні рядки", () => {
    const rows = callListExportRows([e({ scheduled_date: null, scheduled_time: null, patient_name: null })], () => "?");
    expect(rows[0]).toEqual(["", "", "", "", "—", "", "Ще не дзвонили", ""]);
  });

  it("порядок: за часом, рівні — за id, без часу — у кінці (як order(scheduled_time) дошки)", () => {
    const list = [
      e({ id: "b", scheduled_time: "09:00" }),
      e({ id: "z", scheduled_time: null }),
      e({ id: "a", scheduled_time: "09:00" }),
      e({ id: "c", scheduled_time: "08:30" }),
      e({ id: "y", scheduled_time: null }),
    ];
    expect([...list].sort(compareCallListOrder).map((x) => x.id)).toEqual(["c", "a", "b", "y", "z"]);
  });

  it("статуси обдзвону — ті самі, що в reload дошки", () => {
    expect([...CALL_LIST_STATUSES]).toEqual(["scheduled", "waiting"]);
    expect(board).toMatch(/\.in\("status", \["scheduled", "waiting"\]\)/);
  });

  it("імʼя файлу — ASCII з дня", () => {
    expect(callListExportFileName("2026-09-26")).toBe("call-list-2026-09-26.csv");
  });
});
