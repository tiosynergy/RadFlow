/**
 * Поле «Лікар-направник» у картці пацієнта: коли СМІЄМО переписати направника.
 *
 * ЧОМУ. Помилки тут симетричні й обидві невидимі оператору:
 *   • зайвий патч рве звʼязок (`referrer_id = null`) — запис зникає з порталу
 *     направника, і відновити його може лише адмін. Це інцидент с31: правка
 *     ПІБ ПАЦІЄНТА перезбирала направника пошуком по рядку і клала null через
 *     подвійний пробіл в імені;
 *   • пропущений патч лишає в записі СТАРЕ імʼя лікаря, яке оператор щойно
 *     виправив у довіднику (дефект с43, гілка `docDirty`).
 *
 * ЩО ЧИМ ТРИМАЄТЬСЯ, чесно. Регресію с31/с43 сторожать СТАТИЧНІ перевірки
 * нижче: винос у `lib/` був переносом, поведінки не міняв, тож поведінкові
 * тести на момент написання зелені і до, і після. Їхня роль — зафіксувати
 * контракт, який доти не був покритий узагалі, щоб наступна правка правила
 * впала тут, а не на проді.
 *
 * Компонентних тестів у проєкті немає (vitest у `environment: "node"`,
 * `vitest.config.ts` — лише чиста логіка `lib/*`), тому правило й живе в
 * `lib/referrerField.ts`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { KEEP_KEY, shouldPatchReferrer, referrerPatchFor, type ReferrerFieldState } from "../lib/referrerField";
import { codeOf } from "./helpers/codeOf";

const base: ReferrerFieldState = {
  lockDoctor: false, refUnresolved: false, docKey: "", origDocKey: "", docDirty: false,
};
const st = (p: Partial<ReferrerFieldState>): ReferrerFieldState => ({ ...base, ...p });

/* Сторож мусить читати КОД, а не коментарі: у компоненті лишились пояснення,
   де дослівно згадані ті самі вирази, яких у коді бути не повинно.
   Реалізація — спільна (с46): межі поведінки описані в tests/codeOf.test.ts. */
const modalSrc = codeOf(readFileSync(resolve(process.cwd(), "components/PatientEditModal.tsx"), "utf8"));

describe("shouldPatchReferrer", () => {
  it("порожнє поле, нічого не рухали → патча немає (найчастіший стан прода)", () => {
    expect(shouldPatchReferrer(base)).toBe(false);
  });

  it("поле не рухали → патча НЕМАЄ (регрес с31: правка ПІБ пацієнта не чіпає направника)", () => {
    expect(shouldPatchReferrer(st({ docKey: "r-42", origDocKey: "r-42" }))).toBe(false);
  });

  it("оператор обрав іншого → патч", () => {
    expect(shouldPatchReferrer(st({ docKey: "r-7", origDocKey: "r-42" }))).toBe(true);
  });

  it("оператор очистив поле → патч (очищення теж рух)", () => {
    expect(shouldPatchReferrer(st({ docKey: "", origDocKey: "r-42" }))).toBe(true);
  });

  it("виправлено імʼя ПОТОЧНОГО лікаря довідника → патч, хоч ключ не рухався (регрес с43)", () => {
    expect(shouldPatchReferrer(st({ docKey: "d-9", origDocKey: "d-9", docDirty: true }))).toBe(true);
  });

  it("той самий лікар БЕЗ правки імені → патча немає (docDirty обовʼязковий, а не декоративний)", () => {
    expect(shouldPatchReferrer(st({ docKey: "d-9", origDocKey: "d-9" }))).toBe(false);
  });

  it("запис внесено направником → патча немає НАВІТЬ із docDirty", () => {
    expect(shouldPatchReferrer(st({ lockDoctor: true, docKey: "d-9", origDocKey: "d-1", docDirty: true }))).toBe(false);
  });

  it("картка направника недоступна цій ролі → патча немає НАВІТЬ із docDirty (fail-closed)", () => {
    expect(shouldPatchReferrer(st({ refUnresolved: true, docKey: "d-9", origDocKey: "d-1", docDirty: true }))).toBe(false);
  });

  it("«залишити як є» → патча немає ні за рухом ключа, ні за docDirty", () => {
    // Друга пара — досяжний стан; перша нижче в UI недосяжна (пункт KEEP рендериться,
    // лише якщо картка ВІДКРИЛАСЬ у ньому), і закріплена як контракт функції.
    expect(shouldPatchReferrer(st({ docKey: KEEP_KEY, origDocKey: KEEP_KEY, docDirty: true }))).toBe(false);
    expect(shouldPatchReferrer(st({ docKey: KEEP_KEY, origDocKey: "" }))).toBe(false);
  });

  it("вихід із «залишити як є» на реального лікаря → патч", () => {
    expect(shouldPatchReferrer(st({ docKey: "d-9", origDocKey: KEEP_KEY }))).toBe(true);
  });
});

describe("KEEP_KEY", () => {
  it("не порожній рядок і не лізе в простір реальних ключів", () => {
    expect(KEEP_KEY).not.toBe("");
    expect(KEEP_KEY.startsWith("r-")).toBe(false);
    expect(KEEP_KEY.startsWith("d-")).toBe(false);
  });

  it("до referrerPatchFor не доходить — і не має: там він означав би СТИРАННЯ", () => {
    // Пара звʼязана гейтом: patchFor нічого не знає про «залишити як є» і на
    // невідомому ключі чесно віддає «очистити». Саме тому гейт стоїть перед ним.
    expect(shouldPatchReferrer(st({ docKey: KEEP_KEY, origDocKey: KEEP_KEY }))).toBe(false);
    expect(referrerPatchFor(KEEP_KEY, [{ key: "d-9", name: "Петренко Петро" }]))
      .toEqual({ doctor: null, referrer_id: null });
  });
});

describe("referrerPatchFor", () => {
  const docs = [
    { key: "r-42", name: "Іваненко Іван" },
    { key: "d-9", name: "Петренко Петро" },
  ];

  it("направник із порталом (r-) → імʼя текстом І звʼязок по id", () => {
    expect(referrerPatchFor("r-42", docs)).toEqual({ doctor: "Іваненко Іван", referrer_id: "42" });
  });

  it("лікар довідника (d-) → лише імʼя; звʼязувати нічого, referrer_id = null", () => {
    expect(referrerPatchFor("d-9", docs)).toEqual({ doctor: "Петренко Петро", referrer_id: null });
  });

  it("«— не вказано —» → очистити обидва поля", () => {
    expect(referrerPatchFor("", docs)).toEqual({ doctor: null, referrer_id: null });
  });

  it("ключ, якого немає в списку → очистити, а не вигадати звʼязок", () => {
    expect(referrerPatchFor("r-999", docs)).toEqual({ doctor: null, referrer_id: null });
  });

  it("бере СВІЖЕ імʼя зі списку — саме цим доїжджає правка довідника (с43)", () => {
    const renamed = [{ key: "d-9", name: "Петренко Петро Петрович" }];
    expect(referrerPatchFor("d-9", renamed).doctor).toBe("Петренко Петро Петрович");
  });
});

/* Статичний сторож. Правило корисне лише поки компонент його кличе — І поки
   присвоєння лишається ВСЕРЕДИНІ гейта: винести два рядки назовні (класична
   аварія мержу) означає повернути інцидент с31 цілком, а перевірка самого
   заголовка `if` цього не побачить. Тому вирізаємо блок і сторожимо в ньому. */
describe("PatientEditModal.tsx — правило живе в lib і зветься звідти", () => {
  const at = modalSrc.indexOf("if (shouldPatchReferrer");
  const end = modalSrc.indexOf("const res = await updatePatientDetails", at);
  const gate = at >= 0 && end > at ? modalSrc.slice(at, end) : "";

  it("правило береться з lib, а не оголошене локально в компоненті", () => {
    expect(modalSrc).toMatch(/import\s*\{[^}]*shouldPatchReferrer[^}]*referrerPatchFor[^}]*\}\s*from\s*"@\/lib\/referrerField"/);
  });

  it("гейт отримує ВЕСЬ стан поля, а не підставлені константи", () => {
    // Найдешевший спосіб мовчки вимкнути fail-closed — передати `lockDoctor: false`
    // замість самої змінної. Тому вимагаємо саме скорочену форму (ревʼю с44, р.2).
    expect(at, "гейт не знайдено — сторож застарів").toBeGreaterThan(-1);
    expect(end, "кінець гейта не знайдено — сторож застарів").toBeGreaterThan(at);
    expect(gate).toMatch(/shouldPatchReferrer\(\{\s*lockDoctor,\s*refUnresolved,\s*docKey,\s*origDocKey,\s*docDirty\s*,?\s*\}\)/);
  });

  it("обидва поля патча беруться з referrerPatchFor і присвоюються лише всередині гейта", () => {
    // `patch.referrer_id = null` теж «присвоєння всередині гейта» — і це с31.
    expect(gate).toContain("referrerPatchFor(docKey, docs)");
    expect(gate).toMatch(/patch\.doctor\s*=\s*\w+\.doctor/);
    expect(gate).toMatch(/patch\.referrer_id\s*=\s*\w+\.referrer_id/);
    expect(modalSrc.split("patch.referrer_id").length - 1,
      "друге присвоєння referrer_id поза гейтом = інцидент с31; додаєш гілку — покрий її тестом і онови сторож").toBe(1);
    expect(modalSrc.split("patch.doctor").length - 1).toBe(1);
  });

  it("зміна вибору скидає docDirty — липкий прапорець давав би зайвий патч (ревʼю с43)", () => {
    // Не привʼязуємось до інлайнового onChange: важлива ПАРА, а не її місце.
    expect(modalSrc).toMatch(/setDocKey\([^)]*\);\s*setDocDirty\(false\);/);
  });

  it("правка довідника і піднімає docDirty, і оновлює ІМʼЯ в списку — інакше доїде СТАРЕ", () => {
    // referrerPatchFor бере імʼя з `docs`. Підняти прапорець, але не оновити
    // список — це дефект с43 в повний зріст, при зеленому прогоні (ревʼю р.2).
    const eAt = modalSrc.indexOf("{editDoc && (");
    expect(eAt, "блок editDoc не знайдено — сторож застарів").toBeGreaterThan(-1);
    const editBlock = modalSrc.slice(eAt);
    expect(editBlock).toMatch(/name:\s*row\.name/);
    expect(editBlock).toMatch(/if\s*\(\s*docKey\s*===\s*"d-"\s*\+\s*row\.id\s*\)\s*setDocDirty\(true\)/);
  });
});
