/**
 * Майстер `/setup`: знімок «збереженого» і перерахунок dirty.
 *
 * ЧОМУ. Майстер визначає dirty порівнянням JSON поточних даних зі знімком
 * останнього збереження. Після першого «Зберегти» нові кабінети отримують
 * db-id, і батько віддає їх у форму через `setEquip` — ЗАПЛАНОВАНЕ оновлення.
 * Знімок же писався рядком нижче, зі СТАРИХ даних: React застосовував
 * оновлення, ефект форми звітував новими — і dirty спалахував true без жодної
 * правки оператора. «Вийти» питало про незбережені зміни одразу після
 * успішного збереження (легасі; знахідка ревʼю с43, полагоджено с44).
 *
 * ДЗЕРКАЛЬНИЙ дефект того ж місця: голий `setDirty(false)` оголошував
 * збереженими правки, які оператор набрав ПОКИ тривало збереження (поля, на
 * відміну від кнопок, не блокуються) — кнопка «Зберегти» гасла, «Вийти» не
 * питало, а набраний текст лишався в полі.
 *
 * Компонент тут не тестується (vitest у `environment: "node"`, конвенція
 * `vitest.config.ts` — лише чиста логіка `lib/*`), тому обидва правила винесені
 * в `lib/setupWizard.ts` і покриті поведінково, а статичні перевірки нижче
 * сторожать лише те, що компонент справді кличе саме їх і в правильному
 * порядку.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  applyAssignedRoomIds, savedSnapshot, dirtyAfterSave, type RoomIdAssignment,
} from "../lib/setupWizard";

type Row = { id: number | string; type: string; room?: string; roomId?: string };
const row = (id: number | string, type: string, roomId?: string): Row =>
  (roomId ? { id, type, roomId } : { id, type });

/* Сторож мусить читати КОД, а не коментарі: слово `JSON.stringify(d)` живе в
   SetupWizard.tsx саме в поясненні до того, чому його там більше немає. */
const codeOf = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

const wizardSrc = codeOf(readFileSync(resolve(process.cwd(), "components/SetupWizard.tsx"), "utf8"));

describe("applyAssignedRoomIds", () => {
  it("підмішує виданий id у рядок за локальним id", () => {
    const out = applyAssignedRoomIds([row(1, "МРТ"), row(2, "КТ")], [{ localId: 2, roomId: "db-2" }]);
    expect(out[0].roomId).toBeUndefined();
    expect(out[1].roomId).toBe("db-2");
  });

  it("зіставляє числовий лічильник форми з рядковим localId і навпаки", () => {
    expect(applyAssignedRoomIds([row(7, "МРТ")], [{ localId: "7", roomId: "db-7" }])[0].roomId).toBe("db-7");
    expect(applyAssignedRoomIds([row("7", "МРТ")], [{ localId: 7, roomId: "db-7" }])[0].roomId).toBe("db-7");
  });

  it("НЕ перезаписує вже виданий db-id — це була б підміна кабінету", () => {
    const out = applyAssignedRoomIds([row(1, "МРТ", "db-old")], [{ localId: 1, roomId: "db-new" }]);
    expect(out[0].roomId).toBe("db-old");
  });

  it("НЕ мутує вхід: збіг дає КОПІЮ рядка, оригінал лишається без roomId", () => {
    const src = row(1, "МРТ");
    const equip = [src];
    const out = applyAssignedRoomIds(equip, [{ localId: 1, roomId: "db-1" }]);
    expect(out).not.toBe(equip);        // новий масив — інакше React не побачить зміни стану
    expect(out[0]).not.toBe(src);       // новий обʼєкт
    expect(src.roomId).toBeUndefined(); // вхід цілий: d.equip і стейт форми — ті самі обʼєкти
  });

  it("порожній assigned повертає ТОЙ САМИЙ масив (реальна гілка знімка, коли нових кабінетів не було)", () => {
    const equip = [row(1, "МРТ")];
    expect(applyAssignedRoomIds(equip, [])).toBe(equip);
  });

  it("рядок без збігу лишається тим самим обʼєктом (React не перемальовує зайве)", () => {
    const keep = row(1, "МРТ");
    const out = applyAssignedRoomIds([keep, row(2, "КТ")], [{ localId: 2, roomId: "db-2" }]);
    expect(out[0]).toBe(keep);
  });

  it("localId, якому в формі рядка вже немає (видалили під час збереження), нічого не псує", () => {
    const out = applyAssignedRoomIds([row(1, "МРТ")], [{ localId: 99, roomId: "db-99" }]);
    expect(out[0].roomId).toBeUndefined();
  });

  it("порядок рядків зберігається", () => {
    const out = applyAssignedRoomIds([row(1, "МРТ"), row(2, "КТ"), row(3, "УЗД")],
      [{ localId: 3, roomId: "db-3" }, { localId: 1, roomId: "db-1" }]);
    expect(out.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it("ідемпотентна: повторний виклик із тим самим assigned нічого не міняє", () => {
    const once = applyAssignedRoomIds([row(1, "МРТ")], [{ localId: 1, roomId: "db-1" }]);
    expect(JSON.stringify(applyAssignedRoomIds(once, [{ localId: 1, roomId: "db-1" }]))).toBe(JSON.stringify(once));
  });
});

describe("savedSnapshot + dirtyAfterSave (регрес с44)", () => {
  const equipAtSave = [row(1, "МРТ"), row(2, "КТ", "db-2")];   // рядок 1 новий, рядок 2 уже в БД
  const assigned: RoomIdAssignment[] = [{ localId: 1, roomId: "db-1" }];
  const d = { clinic: "Медіком", city: "Київ", equip: equipAtSave };
  /** Стан форми після того, як setEquip застосував видані id. */
  const afterAssign = { ...d, equip: applyAssignedRoomIds(d.equip, assigned) };

  it("нічого не правили → dirty=false", () => {
    expect(dirtyAfterSave(afterAssign, savedSnapshot(d, assigned), assigned)).toBe(false);
  });

  it("знімок БЕЗ виданих id (як писав save() до с44) → фантомний dirty", () => {
    expect(dirtyAfterSave(afterAssign, JSON.stringify(d), assigned)).toBe(true);
  });

  it("правка, набрана ПОКИ тривало збереження, лишається брудною", () => {
    const edited = { ...afterAssign, equip: [{ ...afterAssign.equip[0], room: "Кабінет 1А" }, afterAssign.equip[1]] };
    expect(dirtyAfterSave(edited, savedSnapshot(d, assigned), assigned)).toBe(true);
  });

  it("канал у форму обірвано (handed = []) → id немає ні у формі, ні в знімку, dirty не залипає", () => {
    expect(dirtyAfterSave(d, savedSnapshot(d, []), [])).toBe(false);
  });

  it("знімок із id, яких форма НЕ отримала → вічний dirty; саме тому в save() передається handed, а не assigned", () => {
    expect(dirtyAfterSave(d, savedSnapshot(d, assigned), [])).toBe(true);
  });

  it("форми ще немає → не брудно (незбережені зміни з порожнечі не вигадуємо)", () => {
    expect(dirtyAfterSave(null, savedSnapshot(d, assigned), assigned)).toBe(false);
  });

  it("знімок несе ВСІ поля форми, не лише equip", () => {
    const renamed = { ...afterAssign, clinic: "Інша назва" };
    expect(dirtyAfterSave(renamed, savedSnapshot(d, assigned), assigned)).toBe(true);
  });
});

/* Статичний сторож. Чисті функції нічого не гарантують, якщо компонент їх не
   кличе — або кличе не тим і не в тому порядку. Сторожимо ЛАНЦЮГ цілком:
   без `assigned.push` або без передачі у форму знімок вироджується назад, і
   перевірка одного рядка цього б не помітила (ревʼю с44, р.2). */
describe("SetupWizard.tsx — ланцюг «insert → форма → знімок → dirty»", () => {
  it("правила беруться з lib, а не оголошені локально в компоненті", () => {
    expect(wizardSrc).toMatch(/import\s*\{[^}]*applyAssignedRoomIds[^}]*savedSnapshot[^}]*dirtyAfterSave[^}]*\}\s*from\s*"@\/lib\/setupWizard"/);
  });

  it("видані id збираються в insert-гілці", () => {
    expect(wizardSrc).toMatch(/assigned\.push\(\{\s*localId:\s*e\.id,\s*roomId:\s*ins\.id\s*,?\s*\}\)/);
  });

  it("батько віддає їх у форму — без цього канал проти багу с33 обірваний", () => {
    expect(wizardSrc).toMatch(/assigned\.length\s*\?\s*assignRoomIdsRef\.current\s*:\s*null/);
    expect(wizardSrc).toMatch(/handOver\?\.\(assigned\)/);
    expect(wizardSrc).toMatch(/const\s+handed\s*=\s*handOver\s*\?\s*assigned\s*:\s*\[\]/);
  });

  it("форма підмішує id спільною функцією, а не власним map", () => {
    expect(wizardSrc).toMatch(/setEquip\(\(a\)\s*=>\s*applyAssignedRoomIds\(a,\s*assigned\)\)/);
  });

  it("знімок і dirty будуються функціями lib, причому dirty — проти ЖИВИХ даних", () => {
    expect(wizardSrc).toMatch(/savedRef\.current\s*=\s*savedSnapshot\(d,\s*handed\)/);
    expect(wizardSrc).toMatch(/dirtyAfterSave\(dataRef\.current,\s*savedRef\.current,\s*handed\)/);
    expect(wizardSrc).not.toMatch(/savedRef\.current\s*=\s*JSON\.stringify/);
  });

  it("оператору кажуть, якщо правки під час збереження лишились незбереженими", () => {
    expect(wizardSrc).toMatch(/if\s*\(stillDirty\)\s*push\(/);
  });

  it("порядок ланцюга: спершу збір id, потім передача у форму, потім знімок", () => {
    const iPush = wizardSrc.indexOf("assigned.push(");
    const iHand = wizardSrc.indexOf("assigned.length ? assignRoomIdsRef.current");
    const iSnap = wizardSrc.indexOf("savedRef.current = savedSnapshot(");
    expect(iPush, "assigned.push не знайдено — сторож застарів").toBeGreaterThan(-1);
    expect(iHand, "передача id у форму мусить бути ПІСЛЯ їх збору").toBeGreaterThan(iPush);
    expect(iSnap, "знімок мусить бути ПІСЛЯ передачі id у форму").toBeGreaterThan(iHand);
  });
});
