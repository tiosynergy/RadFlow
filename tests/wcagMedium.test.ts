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
    ["components/SearchScreen.tsx", /<span role="img" title="Повʼязано з кейсом" aria-label="Повʼязано з кейсом"/],
  ])("%s: гліф статусу — role=\"img\"", (file, re) => {
    expect(read(file)).toMatch(re);
  });
  it("ReferrerBoard: статус дзвінка з видимим текстом — ТЕКСТ (не role=\"img\"), контекст — прихованим префіксом", () => {
    const s = read("components/ReferrerBoard.tsx");
    expect(s).toContain('<span aria-hidden="true">{call.icon}</span><span className="rf-vh">Статус дзвінка: </span>{call.label}');
    expect(s).not.toMatch(/role="img"[^>]*aria-label=\{"Статус дзвінка: "/);
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
    expect(s).toContain('aria-required={true} aria-invalid={miss.dur && durEdit !== "" ? true : undefined}');
    expect(s).toContain('<div className="bk-gender-row" role="group" aria-label={"Стать" + (softPatient ? "" : " (обовʼязково)")}>');
    // підказка тривалості стоїть усередині <label> і вже входить в імʼя — describedby читався б двічі (ревʼю с75)
    expect(s).not.toContain("durHintId");
  });
  it.each(["components/BookingModal.tsx", "components/WaitlistModal.tsx", "components/ReferralPortal.tsx"])("%s: сегмент «Тип» — група з іменем «Тип дослідження (обовʼязково)»", (file) => {
    expect(read(file)).toContain('role="group" aria-label="Тип дослідження (обовʼязково)"');
  });
  it("SetupWizard: логін — підказка ПОЗА <label> (сусід поля), label через htmlFor; CitySelect — поза <label> (ревʼю с75)", () => {
    const s = read("components/SetupWizard.tsx");
    expect(s).toContain('<label className="fld-lab" htmlFor="sw-login">Логін для входу <Req /></label>');
    expect(s).toMatch(/<input id="sw-login" className=\{"inp" \+ \(loginOk \? "" : " invalid"\)\}/);
    expect(s).toContain('<label className="fld-lab" htmlFor="sw-city">Місто <Req /></label>');
    expect(s).toContain('<CitySelect id="sw-city" value={city} onChange={setCity} required />');
    expect(s).not.toMatch(/<label[^>]*>[^<]*<span className="fld-lab">Місто/);
    expect(read("components/ReferralPortal.tsx")).toContain('<label className="fld-lab" htmlFor="rp-center-city">Місто</label><CitySelect id="rp-center-city"');
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

/* ---- M-C/M-D: модалки поза контрактом (W-9), статуси (W-12), combobox міста (W-13) ---- */

describe("W-9 — кожна модалка йде через useModalA11y (role=dialog, пастка, Esc, повернення фокуса)", () => {
  it("BaseDialog: хук + role=\"dialog\" aria-modal aria-labelledby на заголовок; busy глушить закриття", () => {
    const s = read("components/BaseDialog.tsx");
    expect(s).toMatch(/useModalA11y<HTMLDivElement>\(\(\) => \{ if \(!busy\) onClose\(\); \}\)/);
    expect(s).toMatch(/role="dialog" aria-modal="true" aria-labelledby=\{titleId\}/);
    expect(s).toContain('<div className="dlg-title" id={titleId}>{title}</div>');
    expect(s).toContain('<div className="overlay" onClick={() => { if (!busy) onClose(); }}>');
  });
  it.each([
    ["components/StaffManager.tsx", /<BaseDialog title="Задати пароль" maxWidth=\{380\} busy=\{pwModal\.busy\} onClose=\{\(\) => setPwModal\(null\)\}>/],
    ["components/CeoManager.tsx", /<BaseDialog title="Задати пароль" maxWidth=\{380\} busy=\{pwModal\.busy\} onClose=\{\(\) => setPwModal\(null\)\}>/],
    ["components/SetupWizard.tsx", /<BaseDialog title="Незбережені зміни" maxWidth=\{420\} busy=\{saving\} onClose=\{\(\) => setExitAsk\(false\)\}>/],
    ["components/DangerZone.tsx", /<BaseDialog title=\{<>Видалити «\{clinicName\}»\?<\/>\} maxWidth=\{480\} busy=\{busy\} onClose=\{close\}>/],
  ])("%s: діалог на BaseDialog", (file, re) => {
    expect(read(file)).toMatch(re);
  });
  it("у components/ немає рукописного <div className=\"overlay\"> у файлі без useModalA11y", () => {
    const offenders: string[] = [];
    for (const f of components()) {
      const s = read("components/" + f);
      if (/className="overlay/.test(s) && !/useModalA11y\s*(<[^>]*>)?\s*\(/.test(s)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
  it("кожен .dialog під оверлеєм має role=\"dialog\" (крім вбудованої форми порталу, яка не модалка)", () => {
    const offenders: string[] = [];
    for (const f of components()) {
      const s = read("components/" + f);
      const re = /<div className="dialog[^"]*"[^>]*>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) {
        const tag = s.slice(m.index, s.indexOf(">", m.index) + 1);
        if (/role="dialog"/.test(tag)) continue;
        if (f === "ReferralPortal.tsx" && /bk-dialog/.test(tag)) continue;
        // BaseDialog: role стоїть на наступному рядку того ж тега.
        if (f === "BaseDialog.tsx" && /role="dialog" aria-modal="true"/.test(s.slice(m.index, m.index + 400))) continue;
        offenders.push(f + ":" + lineOf(s, m.index));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("W-12 — повідомлення про стан озвучуються (постійні live-регіони)", () => {
  it("Toast: два постійні регіони — status/polite і alert/assertive; роль не міняється на льоту", () => {
    const s = read("components/Toast.tsx");
    expect(s).toContain('<div role="status" aria-live="polite" aria-atomic="true" style={REGION_STYLE}>');
    expect(s).toContain('<div role="alert" aria-live="assertive" aria-atomic="true" style={REGION_STYLE}>');
    expect(s).toContain("{shown && !isError && <ToastCard");
    expect(s).toContain("{shown && isError && <ToastCard");
    expect(s).not.toMatch(/role=\{isError \? "alert" : "status"\}/);
  });
  it("SetupWizard: спільний <Toast> замість власного стека .toast-wrap (ревʼю с75: утримання, ✕, 6 с для помилок)", () => {
    const s = read("components/SetupWizard.tsx");
    expect(s).toContain('<Toast toast={toast} onDismiss={dismissToast} />');
    expect(s).toContain('import Toast, { type ToastData } from "@/components/Toast";');
    expect(s).not.toContain('className="toast-wrap"');
    expect(s).toMatch(/timer\.current = setTimeout\(\(\) => setToast\(null\), kind === "error" \? 6000 : 3000\);/);
  });
  it("WaitlistBoard: Toast без другої обгортки role=\"status\"", () => {
    const s = read("components/WaitlistBoard.tsx");
    expect(s).not.toMatch(/<div role="status" aria-live="polite">\s*<Toast/);
    expect(s).toContain("<Toast toast={toast} onDismiss={() => setToast(null)} />");
  });
  it("SearchScreen: стан пошуку — прихований role=\"status\" з усіма пʼятьма станами", () => {
    const s = read("components/SearchScreen.tsx");
    const i = s.indexOf('<div className="rf-vh" role="status" aria-live="polite">');
    expect(i).toBeGreaterThan(-1);
    const block = s.slice(i, s.indexOf("</div>", i));
    for (const t of ['"Виконуємо пошук…"', '"Пошук не виконано: " + st.msg', "st.msg", '"Нічого не знайдено"', '"Знайдено записів: " + st.items.length']) expect(block).toContain(t);
  });
  it("StudySearchBox: статус списку — прихований live-регіон поза listbox", () => {
    const s = read("components/StudySearchBox.tsx");
    expect(s).toContain('<div className="rf-vh" role="status" aria-live="polite">{statusText}</div>');
    expect(s).toMatch(/const statusText = !dropOpen \? ""\s*: short \? "введіть від " \+ STUDY_SEARCH_MIN \+ " символів…"\s*: hits\.length === 0 \? "нічого не знайдено"/);
    expect(s.indexOf('role="status"')).toBeLessThan(s.indexOf('role="listbox"'));
  });
});

describe("W-13 — CitySelect: патерн combobox, як у StudySearchBox", () => {
  it("input: role=combobox, aria-expanded, aria-controls на listbox, aria-activedescendant, aria-required/aria-invalid", () => {
    const s = read("components/CitySelect.tsx");
    expect(s).toMatch(/role="combobox"\s+aria-expanded=\{listOpen\}\s+aria-controls=\{listId\}\s+aria-autocomplete="list"\s+aria-activedescendant=\{listOpen && active >= 0 \? optId\(active\) : undefined\}\s+aria-required=\{required \|\| undefined\}\s+aria-invalid=\{invalid && has \? true : undefined\}/);
    expect(s).toContain('<ul className="city-list" role="listbox" id={listId}>');
    expect(s).toMatch(/<li\s+key=\{h\.id\}\s+id=\{optId\(i\)\}\s+role="option"\s+aria-selected=\{i === active\}/);
    expect(s).toContain('<div className="rf-vh" role="status" aria-live="polite">{statusText}</div>');
    expect(s).not.toContain("aria-label={placeholder}");   // імʼя дає обгортка <label> («Місто *»)
  });
});

/* ---- M-E/M-F: контраст червоного (W-4), тост і Ctrl+Z (W-11), сітка слотів (W-5) ---- */

describe("W-4 — червоний як текст лише через --red-text; --danger/--accent визначені", () => {
  it("токени в :root", () => {
    const css = read("styles/prototype/radflow.css");
    expect(css).toMatch(/--red-text: #ff918a;/);
    expect(css).toMatch(/--danger: #d62f26;/);
    expect(css).toMatch(/--danger-hover: #c22a21;/);
    expect(css).toMatch(/--accent: var\(--blue-line\);/);
  });
  it(".btn-danger — на --danger (білий 4.89), а не на --red (3.41)", () => {
    const css = read("styles/prototype/radflow.css");
    expect(css).toContain(".btn-danger { background: var(--danger); color: #fff; }");
    expect(css).toContain(".btn-danger:hover { background: var(--danger-hover); }");
  });
  it.each([
    ["styles/prototype/radflow.css", [".fld-lab:has(.req), .sec-label:has(.req), .bk-section-label:has(.req) { color: var(--red-text); }", ".badge.red { background: var(--red-bg); color: var(--red-text); }", ".qd-act-red { color: var(--red-text); }", ".bk-miss-lab { color: var(--red-text) !important; }"]],
    ["styles/prototype/radflow-wizard.css", [".eq-break-err { flex-basis: 100%; font-size: 0.6875rem; color: var(--red-text);", ".field-err { color: var(--red-text);"]],
    ["components/register.css", [".reg-root .err { font-size: 0.75rem; color: var(--red-text);"]],
    ["styles/prototype/radflow-screens.css", [".cl-status.red { color: var(--red-text); }"]],
  ])("%s: ключові ролі тексту на --red-text", (file, needles) => {
    const css = read(file);
    for (const n of needles) expect(css).toContain(n);
  });
  it("у CSS немає `color: var(--red)` і літералу #ff8c84 (лінт contrast-audit дублює це в CI)", () => {
    for (const f of ["styles/prototype/radflow.css", "styles/prototype/radflow-screens.css", "styles/prototype/radflow-wizard.css", "styles/prototype/radiologist.css", "components/register.css"]) {
      const css = read(f).replace(/\/\*[\s\S]*?\*\//g, "");
      expect(css, f).not.toMatch(/(?<![-\w])color:\s*var\(--red\)/);
      expect(css, f).not.toMatch(/#ff8c84/);
    }
  });
  it("TSX: фолбеків var(--danger, #…) / var(--accent, #…) немає; DangerZone і CaseModal — на токенах", () => {
    for (const f of components()) expect(read("components/" + f), f).not.toMatch(/var\(--(danger|accent),\s*#/);
    expect(read("components/DangerZone.tsx")).toContain('style={{ background: "var(--danger)", color: "#fff" }}');
    expect(read("components/DangerZone.tsx")).toContain('borderColor: "var(--red)", color: "var(--red-text)"');
    expect(read("components/QueueBoard.tsx")).toContain('<span className="rct-sum" style={{ background: "var(--danger)", color: "#fff"');
  });
  it("contrast-audit.mjs рахує червоні пари і лінтить color: var(--red) у CSS і TSX", () => {
    const s = read("scripts/contrast-audit.mjs");
    expect(s).toContain('const RED_TEXT = "#ff918a";');
    expect(s).toContain('const DANGER = "#d62f26";');
    expect(s).toMatch(/check\(`--red-text \$\{RED_TEXT\} на \$\{n\} \$\{s\}`, ratio\(RED_TEXT, s\), 4\.5\)/);
    expect(s).toMatch(/check\(`#fff на --danger \$\{DANGER\}`, ratio\(WHITE, DANGER\), 4\.5\)/);
    expect(s).toContain("if (COLOR_RED.test(body)) {");
    expect(s).toContain("if (redAsColor(clean)) lintFail(");
    expect(s).toContain("if (TSX_FALLBACK.test(clean)) lintFail(");
  });
});

describe("W-11 — відкат не тікає: тост тримається під курсором/фокусом, Ctrl+Z, помилка входу до правки", () => {
  it("Toast: показує останній тост, поки його тримають; дія/✕ гасять одразу; після відпускання — грація", () => {
    const s = read("components/Toast.tsx");
    expect(s).toContain("const shown = toast ?? (held ? last : null);");
    expect(s).toMatch(/onMouseEnter: hold, onMouseLeave: release,\s*onFocus: \(e: React\.FocusEvent<HTMLDivElement>\) => \{[\s\S]*?hold\(\);\s*\},/);
    expect(s).toMatch(/onBlur: \(e: React\.FocusEvent<HTMLDivElement>\) => \{ if \(!e\.currentTarget\.contains\(e\.relatedTarget as Node \| null\)\) release\(\); \}/);
    expect(s).toContain("const dismiss = () => { restoreFocus(); setLast(null); setHeld(false); onDismiss?.(); };");
    // ревʼю с75: фокус повертається туди, звідки прийшов; утримання без курсора/фокуса скидається; однаковий текст двічі — перемонтування
    expect(s).toMatch(/if \(c && c\.contains\(document\.activeElement\) && from && from\.isConnected\) from\.focus\(\);/);
    expect(s).toMatch(/if \(!c \|\| \(!c\.matches\(":hover"\) && !c\.contains\(document\.activeElement\)\)\) setHeld\(false\);/);
    expect(s.match(/<ToastCard key=\{seqRef\.current\}/g)?.length).toBe(2);
    expect(s).toContain('<kbd aria-hidden="true"');
    expect(s).toContain("const RELEASE_GRACE_MS = 1000;");
    expect(s).toMatch(/releaseTimer\.current = setTimeout\(\(\) => setHeld\(false\), RELEASE_GRACE_MS\)/);
    expect(s).toContain('aria-keyshortcuts={toast.action.hotkey ? toast.action.hotkey.replace(/Ctrl/i, "Control") : undefined}');
    expect(s).toContain("{toast.action.hotkey && <kbd");
  });
  it.each([
    ["components/QueueBoard.tsx", /const UNDO_HOTKEY_MS = 30_000;/],
    ["components/QueueBoard.tsx", /undoRef\.current = action \? \{ run: action\.onAction, what: msg, born, until: Date\.now\(\) \+ UNDO_HOTKEY_MS \} : null;/],
    ["components/QueueBoard.tsx", /async function setStatus\([^)]*\): Promise<boolean> \{\s*\/\/[^\n]*\n\s*undoRef\.current = null;/],
    ["components/QueueBoard.tsx", /async function setCall\(p: QEntry, call_status: string\) \{\s*undoRef\.current = null;/],
    ["components/QueueBoard.tsx", /hotkey: "Ctrl\+Z", onAction: \(\) => \{ if \(scopeRef\.current !== born\) return; undoRef\.current = null; action\.onAction\(\); \}/],
    ["components/QueueBoard.tsx", /if \(\(e\.ctrlKey \|\| e\.metaKey\) && !e\.altKey && !e\.shiftKey && e\.code === "KeyZ" && !typing && !anyModalOpen\) \{\s*const u = undoRef\.current;\s*if \(!u \|\| Date\.now\(\) > u\.until \|\| scopeRef\.current !== u\.born\) return;\s*e\.preventDefault\(\);\s*undoRef\.current = null;\s*u\.run\(\);\s*notifyRef\.current\("Відмінено: " \+ u\.what, "info"\);\s*return;\s*\}/],
    ["components/WaitlistBoard.tsx", /const UNDO_HOTKEY_MS = 30_000;/],
    ["components/WaitlistBoard.tsx", /undoRef\.current = action \? \{ run: action\.onAction, until: Date\.now\(\) \+ UNDO_HOTKEY_MS \} : null;/],
    ["components/WaitlistBoard.tsx", /modalOpenRef\.current = !!\(editFor \|\| bookFor \|\| confirmRemove\);/],
    ["components/WaitlistBoard.tsx", /if \(modalOpenRef\.current\) return;\s*const u = undoRef\.current;/],
    ["components/WaitlistBoard.tsx", /if \(!\(e\.ctrlKey \|\| e\.metaKey\) \|\| e\.altKey \|\| e\.shiftKey \|\| e\.code !== "KeyZ"\) return;\s*const t = e\.target as HTMLElement \| null;\s*if \(t && \(t\.isContentEditable \|\| \/\^\(INPUT\|TEXTAREA\|SELECT\)\$\/\.test\(t\.tagName\)\)\) return;/],
  ])("%s: Ctrl+Z поза полем вводу повторює дію з тосту (%s)", (file, re) => {
    expect(read(file)).toMatch(re);
  });
  it("тости з відкатом досі живуть 6 с (таймер не чіпали) — тримає лише Toast", () => {
    expect(read("components/QueueBoard.tsx")).toContain('toastTimer.current = setTimeout(() => setToast(null), (type === "error" || action) ? 6000 : 3000);');
    expect(read("components/WaitlistBoard.tsx")).toContain("toastTimer.current = setTimeout(() => setToast(null), action ? 6000 : 3000);");
  });
  it("LoginPage: помилка входу без таймера, гасне при правці поля; текст лише поки видно", () => {
    const s = read("components/LoginPage.tsx");
    expect(s).not.toMatch(/setTimeout\(\(\) => setToast/);
    expect(s).toContain("setToast((t) => (t.show ? { ...t, show: false } : t));");
    expect(s).toContain('{toast.show && <div key={toast.seq}><div className="tt">{toast.title}</div><div className="td">{toast.msg}</div></div>}');
    expect(s).toContain("setToast((t) => ({ show: true, title, msg, seq: t.seq + 1 }));");
  });
});

describe("W-5 — сітка слотів: listbox з опціями, roving tabindex, комірки ≥24px", () => {
  it("SlotPicker: role=option + aria-selected + tabIndex за tabStop; блок — group; стрілки/Home/End", () => {
    const s = read("components/SlotPicker.tsx");
    expect(s).toContain('role="option" aria-selected={value === s} tabIndex={s === tabStop ? 0 : -1} data-slot={s}');
    expect(s).toContain('<div className="slot-blk" key={bl.key} role="group" aria-label={slotFmt(bl.startMin)}>');
    expect(s).toContain('<div className="slot-blk-cells" role="presentation">');
    expect(s).toMatch(/role="listbox" aria-label="Вільні слоти \(крок 5 хв\)" aria-describedby=\{helpId\} ref=\{gridRef\} onKeyDown=\{onGridKey\}/);
    expect(s).toContain('aria-label={label.includes(s) ? label : s + " — " + label}');
    expect(s).toContain('<div className={hint ? "slot-hint" : "rf-vh"} role="status" aria-live="polite">');
    expect(s).toMatch(/const tabStop = \(value && allSubs\.includes\(value\) && focusable\(value\)\) \? value\s*: allSubs\.find\(\(s\) => isFree\(stateOf\(s\)\)\) \?\? allSubs\.find\(focusable\) \?\? "";/);
    for (const k of ['"ArrowLeft"', '"ArrowRight"', '"ArrowUp"', '"ArrowDown"', '"Home"', '"End"']) expect(s).toContain(k);
    expect(s).toContain('querySelectorAll<HTMLButtonElement>("button.slot:not([disabled])")');
  });
  it("CSS: блоки по ≥160px (2 у колонці 372, 3 у 620) і на миші, шрифт комірки 11px (0.6875rem), стеля висоти збережена", () => {
    const css = read("styles/prototype/radflow.css");
    expect(css).toMatch(/\.slot-grid4 \{ display: grid; grid-template-columns: repeat\(auto-fill, minmax\(160px, 1fr\)\); gap: 9px 7px; max-height: max\(340px, min\(470px, 46vh\)\);/);
    expect(css).toContain(".slot-blk-cells .slot { padding: 5px 0; font-size: 0.6875rem; border-radius: 4px; min-width: 0; }");
    expect(css).not.toMatch(/\.slot-blk-cells \.slot \{[^}]*font-size: 0\.5625rem/);
  });
});

/* ---- Ревʼю с75 (дві лінзи: доступність і регресії) — піни на виправлення ---- */

describe("Ревʼю с75 — токени й контраст", () => {
  it("register.css: кожен var(--x) зі сторінок входу/реєстрації/пароля оголошений у .reg-root (radflow.css там не вантажиться)", () => {
    const css = read("components/register.css");
    const block = css.slice(css.indexOf(".reg-root {"), css.indexOf("}", css.indexOf(".reg-root {")));
    const declared = new Set([...block.matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = new Set<string>();
    for (const f of ["components/register.css", "components/LoginPage.tsx", "components/RegisterPage.tsx", "components/SetPasswordPage.tsx"]) {
      for (const m of read(f).matchAll(/var\(--([a-z0-9-]+)/g)) used.add(m[1]);
    }
    const missing = [...used].filter((v) => !declared.has(v) && v !== "font");
    expect(missing).toEqual([]);
    for (const t of ["red-text", "danger", "danger-hover", "accent"]) expect(declared.has(t), t).toBe(true);
  });
  it("білий текст на --red не лишився (заливка під білий — --danger); «СТОП» на білому — --danger", () => {
    const css = read("styles/prototype/radflow.css").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].trim().replace(/\s+/g, " "), body = m[2];
      if (sel === ".rf-dot") continue;   // тексту в крапці немає; .rf-dot-num перебиває колір
      if (/(?<![-\w])color\s*:\s*#fff\b/i.test(body)) expect(body, sel).not.toMatch(/background(-color)?\s*:\s*var\(\s*--red\s*\)/);
    }
    expect(css).toContain(".sb-emergency.on .sb-badge-red { background: #fff; color: var(--danger); }");
    expect(css).toContain(".prio-tag.red { color: #fff; background: var(--danger); }");
  });
  it("contrast-audit.mjs: лінт «білий на --red», «--red/--red-text на білому», пара --danger на #fff", () => {
    const s = read("scripts/contrast-audit.mjs");
    expect(s).toContain("if (WHITE_TEXT.test(body) && BG_RED.test(body) && !WHITE_ON_RED_OK.has(sel)) {");
    expect(s).toMatch(/check\(`--danger \$\{DANGER\} на #fff \(\.sb-emergency\.on \.sb-badge-red\)`, ratio\(DANGER, WHITE\), 4\.5\)/);
    expect(s).toContain("if (COLOR_DANGER.test(body) && !BG_WHITE.test(body)) {");
  });
});

describe("Ревʼю с75 — поведінка нових елементів", () => {
  it("BaseDialog: початковий фокус — у перше поле вмісту (ефект ПІСЛЯ хука), інакше ✕", () => {
    const s = read("components/BaseDialog.tsx");
    const hook = s.indexOf("useModalA11y<HTMLDivElement>(");
    const eff = s.indexOf('querySelector<HTMLElement>("input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled])")');
    expect(hook).toBeGreaterThan(-1);
    expect(eff).toBeGreaterThan(hook);
    expect(s).toContain("if (field) field.focus();");
  });
  it.each(["components/StaffManager.tsx", "components/CeoManager.tsx"])("%s: submitPassword — гард busy, try/finally скидає busy при обриві мережі", (file) => {
    const s = read(file);
    const i = s.indexOf("async function submitPassword()");
    const body = s.slice(i, s.indexOf("\n  }\n", i));
    expect(body).toContain("if (pwModal.busy) return;");
    expect(body).toMatch(/try \{[\s\S]*fetch\("\/api\/staff\/password"[\s\S]*\} catch \{[\s\S]*notify\("Не вдалося звʼязатися із сервером\. Спробуйте ще раз\.", "error"\);[\s\S]*\} finally \{\s*setPwModal\(\(m\) => \(m \? \{ \.\.\.m, busy: false \} : m\)\);\s*\}/);
  });
  it("CitySelect: live-статус — за результатом пошуку (idle/pending/done), не за відкритістю списку", () => {
    const s = read("components/CitySelect.tsx");
    expect(s).toContain('const [search, setSearch] = useState<"idle" | "pending" | "done">("idle");');
    expect(s).toMatch(/const statusText = search !== "done" \? ""\s*: hits\.length > 0 \? "знайдено: " \+ hits\.length/);
    expect(s).toMatch(/setHits\(\(data as CityHit\[\]\) \|\| \[\]\);\s*setSearch\("done"\);/);
    expect(s).not.toContain("listOpen ? \"знайдено");
  });
  it("DangerZone: після успіху текст — role=status, отримує фокус (тригер зник)", () => {
    const s = read("components/DangerZone.tsx");
    expect(s).toContain('<p ref={doneRef} tabIndex={-1} role="status"');
    expect(s).toContain("useEffect(() => { if (done) doneRef.current?.focus(); }, [done]);");
  });
});

describe("W-8 (доповнення ревʼю с75) — кнопка з самим прихованим гліфом теж мусить мати імʼя", () => {
  it("<button …><span aria-hidden=\"true\">✕</span></button> без aria-label — немає", () => {
    const offenders: string[] = [];
    for (const f of components()) {
      const s = read("components/" + f);
      const re = /<button\b([^>]*)>\s*<span aria-hidden="true">[^<]*<\/span>\s*<\/button>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) if (!/aria-label/.test(m[1])) offenders.push(f + ":" + lineOf(s, m.index));
    }
    expect(offenders).toEqual([]);
  });
});
