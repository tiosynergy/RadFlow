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

/* ---- M-B: підписи полів (W-7) і помилки форм (W-10) ---- */

/** Усі теги <input …> файлу: текст атрибутів і позиція. Сканує з урахуванням
    фігурних дужок JSX, бо `onChange={(e) => …}` містить «>», і наївний [^>]*
    обрізав би тег посередині. */
function inputTags(raw: string): { attrs: string; index: number }[] {
  // Блокові коментарі — у порожні рядки тієї ж довжини: «<input type="date">» у
  // поясненні (RescheduleModal, ScheduleEditModal) — не поле; номери рядків збережено.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  const out: { attrs: string; index: number }[] = [];
  const re = /<input\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + 6, depth = 0, q: string | null = null;
    for (; i < src.length; i++) {
      const c = src[i];
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === "`") { q = c; continue; }
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    out.push({ attrs: src.slice(m.index + 6, i), index: m.index });
  }
  return out;
}
const insideLabel = (src: string, idx: number) => {
  const before = src.slice(0, idx);
  return (before.match(/<label\b/g) || []).length > (before.match(/<\/label>/g) || []).length;
};
const lineOf = (src: string, idx: number) => src.slice(0, idx).split("\n").length;

describe("W-7 — у кожного поля є імʼя (label / aria-label), а не лише placeholder", () => {
  it("кожен <input type=\"time\"|\"date\"> у components/ має aria-label, id (для htmlFor) або стоїть усередині <label>", () => {
    const offenders: string[] = [];
    for (const f of components()) {
      const s = read("components/" + f);
      for (const t of inputTags(s)) {
        if (!/type="(time|date)"/.test(t.attrs)) continue;
        if (/aria-label/.test(t.attrs) || /\bid=/.test(t.attrs) || insideLabel(s, t.index)) continue;
        offenders.push(f + ":" + lineOf(s, t.index));
      }
    }
    expect(offenders).toEqual([]);
  });
  it("жодного <input> лише з placeholder без імені (aria-label / id / <label>)", () => {
    const offenders: string[] = [];
    for (const f of components()) {
      const s = read("components/" + f);
      for (const t of inputTags(s)) {
        if (!/placeholder=/.test(t.attrs)) continue;
        // {...inputProps("email", …)} у сторінках входу розгортає id, на який дивиться <label htmlFor>.
        if (/aria-label/.test(t.attrs) || /\bid=/.test(t.attrs) || /\.\.\.inputProps\(/.test(t.attrs) || insideLabel(s, t.index)) continue;
        offenders.push(f + ":" + lineOf(s, t.index));
      }
    }
    expect(offenders).toEqual([]);
  });
  it.each([
    ["components/QueueBoard.tsx", 'aria-label="Пошук пацієнта в черзі"'],
    ["components/RadiologistBoard.tsx", 'aria-label="Пошук пацієнта в черзі"'],
    ["components/WaitlistBoard.tsx", 'aria-label="Пошук у листі очікування"'],
    ["components/CallListBoard.tsx", 'aria-label="Пошук у колл-листі"'],
    ["components/CallListBoard.tsx", 'aria-label="День обдзвону"'],
    ["components/CallListBoard.tsx", 'className="note-input" placeholder="Нотатка…" aria-label={"Нотатка до дзвінка — " + p.patient_name}'],
    ["components/BookingModal.tsx", '<select className="inp" aria-label="Лікар-направник"'],
    ["components/BookingModal.tsx", 'aria-label="Дата народження (дд.мм.рррр)"'],
  ])("%s: %s", (file, needle) => {
    expect(read(file)).toContain(needle);
  });
  it("SetupWizard: усі 8 полів часу названі з кабінетом/обладнанням (і днем — у режимі «свій час»)", () => {
    const s = read("components/SetupWizard.tsx");
    const tags = inputTags(s).filter((t) => /type="time"/.test(t.attrs));
    expect(tags.length).toBe(8);
    for (const t of tags) expect(t.attrs, "SetupWizard:" + lineOf(s, t.index)).toMatch(/aria-label=\{"(Початок роботи|Кінець роботи|Перерва " \+ \(bi \+ 1\) \+ ", (початок|кінець))[^}]*\(e\.room \|\| e\.type \|\| "обладнання " \+ \(i \+ 1\)\)\}/);
    expect(tags.filter((t) => /" \+ d \+ " — "/.test(t.attrs)).length).toBe(4);
  });
  it("ScheduleEditModal: чотири поля часу названі з кабінетом", () => {
    const s = read("components/ScheduleEditModal.tsx");
    expect(s.match(/aria-label=\{"(Початок роботи|Кінець роботи|Перерва " \+ \(i \+ 1\) \+ ", (початок|кінець)) — " \+ r\.name\}/g)?.length).toBe(4);
  });
  it.each(["components/BookingModal.tsx", "components/ReferralPortal.tsx", "components/WaitlistModal.tsx"])("%s: рядки додаткових досліджень — область і тривалість названі з номером", (file) => {
    const s = read(file);
    expect(s).toContain('aria-label={"Додаткове дослідження " + (i + 1) + " — область"}');
    expect(s).toContain('aria-label={"Додаткове дослідження " + (i + 1) + " — тривалість, хв"}');
  });
  it("DangerZone: поле підтвердження звʼязане з підписом через htmlFor/id", () => {
    const s = read("components/DangerZone.tsx");
    expect(s).toContain('htmlFor="dz-confirm-name"');
    expect(s).toContain('id="dz-confirm-name"');
  });
});

describe("W-10 — обовʼязковість і помилки полів передаються атрибутами", () => {
  it("BookingModal: обовʼязкові поля — aria-required (ПІБ, дата народження, телефон, пріоритет, область, тривалість)", () => {
    const s = read("components/BookingModal.tsx");
    expect(s).toContain('placeholder="Прізвище Ім\'я По батькові" aria-required={!softPatient || undefined}');
    expect(s).toContain('<DobField value={dob} onChange={setDob} invalid={miss.dob} required={!softPatient} />');
    expect(s).toContain('<PhoneInput value={phone} onChange={setPhone} required={!softPatient} />');
    expect(s).toContain('aria-label="Пріоритет пацієнта" aria-required={moveMode ? undefined : true}');
    expect(s).toContain('<select className="inp" aria-required={true} value={region}');
    expect(s).toContain('aria-required={true} aria-invalid={miss.dur ? true : undefined} aria-describedby={durHintId}');
    expect(s).toContain('<div className="bk-gender-row" role="group" aria-label={"Стать" + (softPatient ? "" : " (обовʼязково)")}>');
  });
  it("DobField: aria-required із пропа, aria-invalid лише при справжній помилці, текст помилки — id + role=\"alert\" і describedby", () => {
    const s = read("components/BookingModal.tsx");
    expect(s).toContain('aria-required={required || undefined} aria-invalid={err ? true : undefined} aria-describedby={err ? errId : undefined}');
    expect(s).toContain('{err && <span className="bk-dob-err" id={errId} role="alert">⚠ {err}</span>}');
  });
  it("PhoneInput: aria-required із пропа; aria-invalid — лише коли є введення", () => {
    const s = read("components/PhoneInput.tsx");
    expect(s).toContain("aria-required={required || undefined}");
    expect(s).toContain("aria-invalid={invalid && has ? true : undefined}");
  });
  it("BookingModal: підсумок «Залишилось» має id, чипи розділені прихованими комами, усі 4 кнопки збереження описані ним", () => {
    const s = read("components/BookingModal.tsx");
    expect(s).toContain('<span className="bk-missing" id={missId}>{missingList.map((m, i) => <span className="bk-miss-chip" key={i}>{m}{i < missingList.length - 1 && <span className="rf-vh">, </span>}</span>)}</span>');
    expect(s.match(/aria-describedby=\{valid \? undefined : missId\}/g)?.length).toBe(4);
  });
  it.each(["components/BookingModal.tsx", "components/ReferralPortal.tsx", "components/WaitlistModal.tsx"])("%s: тривалість додаткового дослідження < 5 хв — aria-invalid", (file) => {
    expect(read(file)).toContain('aria-invalid={r.region && (Number(r.dur) || 0) < 5 ? true : undefined}');
  });
  it("SetupWizard: кожен текст помилки .eq-break-err має id, і кожне поле пари описує його через aria-describedby", () => {
    const s = read("components/SetupWizard.tsx");
    const errSpans = s.match(/<span className="eq-break-err"[^>]*>/g) || [];
    expect(errSpans.length).toBe(4);
    for (const sp of errSpans) expect(sp).toMatch(/ id=\{(hErrId|errId|dhErrId)\}/);
    expect(s.match(/aria-describedby=\{hErr \? hErrId : undefined\}/g)?.length).toBe(2);
    expect(s.match(/aria-describedby=\{dhErr \? dhErrId : undefined\}/g)?.length).toBe(2);
    expect(s.match(/aria-describedby=\{err \? errId : undefined\}/g)?.length).toBe(4);
    expect(s.match(/aria-invalid=\{(hErr|dhErr|err) \? true : undefined\}/g)?.length).toBe(8);
  });
  it("SetupWizard: логін — aria-invalid + describedby на підказку; назва клініки й ПІБ адміністратора — aria-required; контакти — імʼя, обовʼязковість, помилка", () => {
    const s = read("components/SetupWizard.tsx");
    expect(s).toContain('aria-required={true} aria-invalid={loginOk ? undefined : true} aria-describedby="sw-login-hint"');
    expect(s).toContain('<span className="fld-hint" id="sw-login-hint">');
    expect(s).toContain('(clinic.trim() ? "" : " invalid")} aria-required={true}');
    expect(s).toContain('(adminName.trim() ? "" : " invalid")} aria-required={true}');
    expect(s).toContain('aria-label={label + (items.length > 1 ? " " + (i + 1) : "")} aria-required={required && i === 0 ? true : undefined} aria-invalid={badPhone ? true : undefined}');
  });
  it("ScheduleEditModal: перерви з помилкою — aria-invalid на обох полях", () => {
    expect(read("components/ScheduleEditModal.tsx").match(/aria-invalid=\{bad \? true : undefined\}/g)?.length).toBe(2);
  });
});
