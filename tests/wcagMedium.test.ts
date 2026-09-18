/* ===== WCAG Medium (с75, після вердикту; Р74-5) — статичні піни по вихідниках =====
   Джерело: docs/audit/WCAG-static-2026-09-15.md §2 (W-4…W-13, W-24, W-25) і план
   docs/audit/PLAN-wcag-medium-2026-09-18.md. Стиль той самий, що в wcagHigh.test.ts:
   кожен пін — точний предикат по коду, а не toContain фрагмента; мутація, що
   знімає атрибут, має червонити рівно свій тест.

   Живу перевірку з NVDA (кроки §4 чек-листа) ці тести НЕ замінюють — вони
   тримають лише те, що можна перевірити без вух. */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const components = () => readdirSync(join(process.cwd(), "components")).filter((f) => f.endsWith(".tsx"));

describe("W-6 — стан перемикачів озвучується (aria-pressed / aria-expanded / aria-current)", () => {
  it.each([
    ["components/BookingModal.tsx", 2],
    ["components/WaitlistModal.tsx", 2],
    ["components/ReferralPortal.tsx", 2],
  ])("%s: кнопки статі ♂/♀ мають aria-pressed і імʼя", (file, n) => {
    const src = read(file);
    expect(src.match(/className=\{"bk-gender-btn"[^>]*aria-pressed=\{gender === "[МЖ]"\}[^>]*aria-label="(Чоловіча|Жіноча)"/g)?.length).toBe(n);
  });
  it.each([
    "components/BookingModal.tsx",
    "components/WaitlistModal.tsx",
    "components/ReferralPortal.tsx",
    "components/StudyEditModal.tsx",
  ])("%s: сегмент типу модальності — aria-pressed + aria-label={modalityLabel(code)}", (file) => {
    const src = read(file);
    expect(src).toMatch(/className=\{"bk-seg-btn" \+ \([^\n]*? === [^\n]*? \? " active " \+ modalityKind\(code\) : ""\)\} aria-pressed=\{[^}]+\} aria-label=\{modalityLabel\(code\)\}/);
  });
  it("ScheduleEditModal: режим дня — три aria-pressed", () => {
    expect(read("components/ScheduleEditModal.tsx").match(/aria-pressed=\{st\.mode === "(open|custom|closed)"\}/g)?.length).toBe(3);
  });
  it.each([
    ["components/CallListBoard.tsx", /className=\{"pill" \+ \(filter === t\.key \? " active" : ""\)\} aria-pressed=\{filter === t\.key\}/],
    ["components/WaitlistBoard.tsx", /className=\{"pill" \+ \(filter === t\.key \? " active" : ""\)\} aria-pressed=\{filter === t\.key\}/],
    ["components/ReferrerBoard.tsx", /aria-pressed=\{centerId === c\.clinicId\}/],
    ["components/CeoDashboard.tsx", /aria-pressed=\{period === p\.k\}/],
    ["components/Sidebar.tsx", /aria-pressed=\{activeRoom === r\.id\}/],
    ["components/QueueBoard.tsx", /role="button" tabIndex=\{0\} aria-pressed=\{filter === s\.key\}/],
    ["components/RadiologistBoard.tsx", /role="button" tabIndex=\{0\} aria-pressed=\{filter === s\.key\}/],
  ])("%s: фільтр/період/кабінет — aria-pressed", (file, re) => {
    expect(read(file)).toMatch(re);
  });
  it.each([
    ["components/QueueBoard.tsx", /<div className="qrow" role="button" tabIndex=\{0\} aria-expanded=\{expanded\}/],
    ["components/RadiologistBoard.tsx", /<div className="qrow" role="button" tabIndex=\{0\} aria-expanded=\{expanded\}/],
    ["components/ReferrerBoard.tsx", /<div className="qrow qrow-ref" role="button" tabIndex=\{0\} aria-expanded=\{expanded\}/],
  ])("%s: рядок-акордеон каже «розгорнуто/згорнуто»", (file, re) => {
    expect(read(file)).toMatch(re);
  });
  it("Sidebar: активний пункт навігації — aria-current=\"page\" на кожному з семи посилань", () => {
    const src = read("components/Sidebar.tsx");
    const links = src.match(/className=\{"sb-item" \+ \(activeNav === "[a-z]+" \? " active" : ""\)\}/g) || [];
    expect(links.length).toBe(7);
    expect(src.match(/aria-current=\{activeNav === "[a-z]+" \? "page" : undefined\}/g)?.length).toBe(7);
  });
  it("обидва міні-календарі: вибраний день — aria-current=\"date\"", () => {
    expect(read("components/MiniCalendar.tsx")).toContain('aria-current={isSel ? "date" : undefined}');
    expect(read("components/RadiologistBoard.tsx")).toContain('aria-current={isSel ? "date" : undefined}');
  });
});

describe("W-8 — кнопки-гліфи мають імʼя з дією і обʼєктом", () => {
  it("жодної <button> із самим гліфом у вмісті без aria-label (евристика статики 15.09)", () => {
    const offenders: string[] = [];
    for (const f of components()) {
      const s = read("components/" + f);
      const re = /<button\b([^>]*)>\s*([^\w\s<>{}Ѐ-ӿ]{1,2})\s*<\/button>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) if (!/aria-label/.test(m[1])) offenders.push(f + ":" + s.slice(0, m.index).split("\n").length + " " + m[2]);
    }
    expect(offenders).toEqual([]);
  });
  it.each([
    ["components/CallListBoard.tsx", /aria-label=\{"Підтвердити — " \+ p\.patient_name\}/],
    ["components/CallListBoard.tsx", /aria-label=\{"Не відповідає — " \+ p\.patient_name\}/],
    ["components/CallListBoard.tsx", /aria-label=\{"Передзвонити — " \+ p\.patient_name\}/],
    ["components/CallListBoard.tsx", /aria-label=\{"Скасувати підтвердження — " \+ p\.patient_name\}/],
    ["components/QueueBoard.tsx", /aria-label=\{"Підтверджено — " \+ e\.patient_name\}/],
    ["components/StaffManager.tsx", /aria-label=\{"Видалити акаунт назавжди — " \+ \(r\.full_name \|\| r\.login\)\}/],
    ["components/CeoManager.tsx", /aria-label=\{"Видалити CEO-акаунт назавжди — " \+ \(r\.full_name \|\| r\.login\)\}/],
    ["components/Sidebar.tsx", /aria-label="Вийти з системи"/],
    ["components/ReferrerSidebar.tsx", /aria-label="Вийти з системи"/],
    ["components/ScheduleEditModal.tsx", /aria-label=\{"Прибрати перерву " \+ \(i \+ 1\) \+ " — " \+ r\.name\}/],
  ])("%s: імʼя з обʼєктом (%s)", (file, re) => {
    expect(read(file)).toMatch(re);
  });
  it("степпер статусу на обох дошках: «Крок N — статус», поточний крок — aria-current=\"step\"", () => {
    for (const f of ["components/QueueBoard.tsx", "components/RadiologistBoard.tsx"]) {
      const s = read(f);
      expect(s).toContain('aria-label={"Крок " + (i + 1) + " — " + m.label + (isDone ? " (виконано)" : "")} aria-current={isCur ? "step" : undefined}');
    }
  });
  it("«⋯ Більше дій» радіолога — aria-expanded", () => {
    expect(read("components/RadiologistBoard.tsx")).toMatch(/title="Більше дій" aria-label="Більше дій" aria-expanded=\{moreOpen\}/);
  });
});

describe("W-24 — aria-label на span лише разом із роллю (NVDA 18.09: інакше читає гліф)", () => {
  it("у components/ немає <span …aria-label…> без role=", () => {
    const offenders: string[] = [];
    for (const f of components()) {
      const s = read("components/" + f);
      const re = /<span\b([^>]*)>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) if (/aria-label/.test(m[1]) && !/\brole=/.test(m[1])) offenders.push(f + ":" + s.slice(0, m.index).split("\n").length);
    }
    expect(offenders).toEqual([]);
  });
  it.each([
    ["components/QueueBoard.tsx", /<span role="img" title=\{"Дзвінок: " \+ cm\.label\} aria-label=\{"Дзвінок: " \+ cm\.label\}/],
    ["components/ReferrerBoard.tsx", /<span role="img" title=\{"Дзвінок: " \+ call\.label\} aria-label=\{"Статус дзвінка: " \+ call\.label\}/],
    ["components/SearchScreen.tsx", /<span role="img" title="Повʼязано з кейсом" aria-label="Повʼязано з кейсом"/],
  ])("%s: гліф статусу — role=\"img\"", (file, re) => {
    expect(read(file)).toMatch(re);
  });
});

describe("W-25 — сусідні span не злипаються в мовленні", () => {
  it.each(["components/QueueBoard.tsx", "components/RadiologistBoard.tsx"])("%s: телефон і модель апарата закінчуються прихованою комою", (file) => {
    const s = read(file);
    expect(s).toContain('Тел. {p.patient_phone}<span className="rf-vh">, </span></span>');
    expect(s).toContain('{roomModel}<span className="rf-vh">, </span></span>');
  });
  it("RadiologistBoard: .du ховається від ридера, коли дублює .pp", () => {
    expect(read("components/RadiologistBoard.tsx")).toContain('<div className="du" aria-hidden={(roomKind + (regionOf(p) ? " · " + regionOf(p) : "")) === proc ? true : undefined}>');
  });
});

describe("W-17 — у кожної сторінки своя назва вкладки", () => {
  it("усі app/*/page.tsx експортують metadata.title «… — RadFlow»", () => {
    const pages = readdirSync(join(process.cwd(), "app"), { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "api" && d.name !== "auth" && d.name !== "fhir")
      .map((d) => `app/${d.name}/page.tsx`)
      .filter((p) => { try { readFileSync(join(process.cwd(), p)); return true; } catch { return false; } });
    expect(pages.length).toBeGreaterThanOrEqual(16);
    const titles = new Set<string>();
    for (const p of pages) {
      const m = read(p).match(/export const metadata = \{ title: "([^"]+) — RadFlow" \};/);
      expect(m, p).not.toBeNull();
      titles.add(m![1]);
    }
    expect(titles.size).toBe(pages.length);
  });
});
