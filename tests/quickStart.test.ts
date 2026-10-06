/**
 * ШВИДКИЙ СТАРТ (с82) — правила перших кроків і сторожі на їхніх споживачах.
 *
 * ЩО ТРИМАЄ ЦЕЙ ФАЙЛ:
 *  • lib/quickStart — чисті функції: стартовий шлях ролі (fail-closed на дошку),
 *    тексти привітання, валідація кроків «Центр»/«Кабінети», `?section=` лише з
 *    дозволеного переліку;
 *  • lib/tzCanonical — список зон CLINIC_TIMEZONES дорівнює списку CHECK
 *    `clinics_timezone_chk` з накатаної 0202 (читається з файлу міграції, а не
 *    переписаний): роз'їдуться — select знову пропонуватиме зону, яку база
 *    відкине;
 *  • структурні піни на компоненти (компонентних тестів у проєкті немає):
 *    RegisterPage шле clinic_name/full_name і веде в /setup лише при сесії;
 *    SetupWizard фіксує режим при монтуванні, пише configured_at ОСТАННІМ,
 *    посилання чеклиста ведуть лише на anchor-и WIZ_NAV; роут set-password
 *    відкриває сесію ПІСЛЯ зміни пароля клієнтом СЕСІЇ і не віддає шлях
 *    редіректу; SetPasswordPage рахує шлях із ролі сам.
 *
 * ЧОГО НЕ ТРИМАЄ: що сесія справді лягає в cookie (це робить @supabase/ssr у
 * Route Handler — живий прогон), і що кроки виглядають так, як задумано.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  startPathForRole, roleLabel, welcomeFor, pluralUk,
  QS_STEPS, qsStepIndex, qsProgress, qsCenterMissing, qsRoomsMissing, missingText, sectionFromSearch,
} from "@/lib/quickStart";
import { CLINIC_TIMEZONES, DEFAULT_CLINIC_TZ, isClinicTz, clinicTzOrDefault } from "@/lib/tzCanonical";
import { isValidPhoneUA } from "@/lib/phone";
import { codeOf } from "./helpers/codeOf";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const src = (p: string) => codeOf(read(p)).replace(/\s+/g, " ");

/* ===================== lib/quickStart — чисті правила ===================== */

describe("startPathForRole — єдине місце «роль → стартовий екран»", () => {
  it.each([
    ["admin", "/queue"], ["registrar", "/queue"], ["radiologist", "/radiologist"],
    ["referrer", "/referral"], ["ceo", "/ceo"],
  ])("%s → %s (ті самі шляхи, на які розводить /queue)", (role, path) => {
    expect(startPathForRole(role)).toBe(path);
  });
  it("невідома роль, null і сміття — на дошку (вона сама розводить і сама відмовляє)", () => {
    for (const r of [null, undefined, "", "superadmin", "/etc/passwd", "https://evil"]) expect(startPathForRole(r)).toBe("/queue");
  });
  it("повертає лише один із чотирьох внутрішніх шляхів — ніколи вхідне значення", () => {
    const allowed = new Set(["/queue", "/radiologist", "/referral", "/ceo"]);
    for (const r of ["admin", "x", "/ceo?x=1", "//evil.example"]) expect(allowed.has(startPathForRole(r))).toBe(true);
  });
});

describe("roleLabel / pluralUk", () => {
  it("пʼять ролей названі українською, невідома — «Користувач»", () => {
    expect(roleLabel("registrar")).toBe("Реєстратор");
    expect(roleLabel("referrer")).toBe("Лікар-направник");
    expect(roleLabel("nope")).toBe("Користувач");
  });
  it("форми слова: 1/21 — один, 2–4/22 — кілька, 5–20/11–14/0 — багато", () => {
    const f = (n: number) => pluralUk(n, "кабінет", "кабінети", "кабінетів");
    expect([1, 21, 101].map(f)).toEqual(["кабінет", "кабінет", "кабінет"]);
    expect([2, 3, 4, 22].map(f)).toEqual(["кабінети", "кабінети", "кабінети", "кабінети"]);
    expect([0, 5, 11, 12, 14, 20, 111].map(f)).toEqual(Array(7).fill("кабінетів"));
  });
});

describe("welcomeFor — привітання після встановлення пароля", () => {
  it("імʼя в заголовку, роль і центр у «хто», шлях — з startPathForRole", () => {
    const w = welcomeFor({ role: "registrar", fullName: " Олена Коваль ", clinicName: "Medicom" });
    expect(w.title).toBe("Готово, Олена Коваль!");
    expect(w.who).toBe("Реєстратор центру «Medicom»");
    expect(w.path).toBe("/queue");
    expect(w.next.length).toBeGreaterThan(0);
  });
  it("без імені й без центру — не пише «Готово, !» і не вигадує центр", () => {
    const w = welcomeFor({ role: "ceo", fullName: "", clinicName: null });
    expect(w.title).toBe("Готово!");
    expect(w.who).toBe("Керівник");
  });
  it("радіолог: 0 кабінетів — пряма порада йти до адміністратора; n — число з правильною формою; null — без цифр", () => {
    expect(welcomeFor({ role: "radiologist", roomsCount: 0 }).next.join(" ")).toMatch(/ще не призначено/);
    // ⚠️ не \b: з кирилицею межа слова в JS не працює (урок с25) — явний lookahead
    expect(welcomeFor({ role: "radiologist", roomsCount: 1 }).next.join(" ")).toMatch(/1 кабінет(?=\s|$)/);
    expect(welcomeFor({ role: "radiologist", roomsCount: 3 }).next.join(" ")).toMatch(/3 кабінети/);
    expect(welcomeFor({ role: "radiologist", roomsCount: null }).next.join(" ")).not.toMatch(/\d/);
    expect(welcomeFor({ role: "radiologist" }).path).toBe("/radiologist");
  });
  it("направник і керівник: центри — 0 / n / невідомо", () => {
    expect(welcomeFor({ role: "referrer", centersCount: 0 }).next.join(" ")).toMatch(/жоден центр/);
    expect(welcomeFor({ role: "referrer", centersCount: 2 }).next.join(" ")).toMatch(/2 центри/);
    expect(welcomeFor({ role: "ceo", centersCount: 5 }).next.join(" ")).toMatch(/5 центрів/);
    expect(welcomeFor({ role: "ceo", centersCount: null }).next.join(" ")).not.toMatch(/\d/);
  });
  it("невідома роль — безпечний текст і дошка", () => {
    const w = welcomeFor({ role: "guest" });
    expect(w.path).toBe("/queue");
    expect(w.cta.length).toBeGreaterThan(0);
  });
  it("усі тексти — українські й без слів «Войти»/«Login» (UI-копірайт проєкту)", () => {
    for (const role of ["admin", "registrar", "radiologist", "referrer", "ceo", "x"]) {
      const w = welcomeFor({ role, roomsCount: 2, centersCount: 2, fullName: "І", clinicName: "Ц" });
      const all = [w.title, w.who, w.cta, ...w.next].join(" ");
      expect(all).not.toMatch(/[ыэъё]/i);     // російські літери — ознака не того копірайту
      expect(all).not.toMatch(/\blogin\b/i);
    }
  });
});

describe("кроки швидкого старту", () => {
  it("рівно три кроки у фіксованому порядку, прогрес 33/67/100", () => {
    expect(QS_STEPS.map((s) => s.key)).toEqual(["center", "rooms", "done"]);
    expect(qsStepIndex("rooms")).toBe(1);
    expect([qsProgress("center"), qsProgress("rooms"), qsProgress("done")]).toEqual([33, 67, 100]);
  });
  it("«Центр»: назва, місто, ПІБ, телефон — у порядку екрана; пробіли не рахуються", () => {
    expect(qsCenterMissing({ clinic: " ", city: "", adminName: "  ", aPhones: ["", " "] }, isValidPhoneUA))
      .toEqual(["назва центру", "місто", "ПІБ адміністратора", "телефон адміністратора"]);
    expect(qsCenterMissing({ clinic: "Ц", city: "Київ", adminName: "І", aPhones: ["+380 50 123 45 67"] }, isValidPhoneUA)).toEqual([]);
  });
  it("«Центр»: невалідний телефон — окремий пункт (суворіше за хаб, сумісно з ним)", () => {
    expect(qsCenterMissing({ clinic: "Ц", city: "К", adminName: "І", aPhones: ["123"] }, isValidPhoneUA))
      .toEqual(["коректний телефон (+380 XX XXX XX XX)"]);
    // телефон береться перший НЕПОРОЖНІЙ — порожній перший рядок не ховає валідний другий
    expect(qsCenterMissing({ clinic: "Ц", city: "К", adminName: "І", aPhones: ["", "+380501234567"] }, isValidPhoneUA)).toEqual([]);
  });
  it("«Кабінети»: без кабінетів — одне повідомлення; далі — години і перерви окремо", () => {
    expect(qsRoomsMissing(0, false, false)).toEqual(["хоча б один кабінет"]);
    expect(qsRoomsMissing(1, false, true)).toEqual(["коректні години роботи"]);
    expect(qsRoomsMissing(2, true, false)).toEqual(["коректні перерви"]);
    expect(qsRoomsMissing(1, true, true)).toEqual([]);
  });
  it("missingText — «Залишилось: …» або порожньо", () => {
    expect(missingText([])).toBe("");
    expect(missingText(["місто", "ПІБ адміністратора"])).toBe("Залишилось: місто, ПІБ адміністратора");
  });
});

describe("sectionFromSearch — глибоке посилання лише з переліку", () => {
  const ALLOWED = ["sec-clinic", "sec-staff", "sec-gcal"];
  it("дозволене значення — повертається; інше — null", () => {
    expect(sectionFromSearch("?section=sec-staff", ALLOWED)).toBe("sec-staff");
    expect(sectionFromSearch("?section=sec-evil", ALLOWED)).toBeNull();
    expect(sectionFromSearch("?section=", ALLOWED)).toBeNull();
    expect(sectionFromSearch("", ALLOWED)).toBeNull();
    expect(sectionFromSearch("?gcal=abc", ALLOWED)).toBeNull();
  });
  it("регістр і пробіли не «нормалізуються» — дозволений перелік зіставляється дослівно", () => {
    expect(sectionFromSearch("?section=SEC-STAFF", ALLOWED)).toBeNull();
    expect(sectionFromSearch("?section=%20sec-staff", ALLOWED)).toBeNull();
  });
});

/* ===================== lib/tzCanonical — список зон = CHECK ===================== */

describe("CLINIC_TIMEZONES — рівно те, що приймає CHECK clinics_timezone_chk (0202)", () => {
  it("список у коді дорівнює списку в накатаній міграції 0202", () => {
    const mig = read("supabase/migrations/0202_tz_kyiv_no_catalog_scan.sql").replace(/\r/g, "");
    /* Остання `add constraint clinics_timezone_chk check (timezone in (…))` — і є
       чинна. Читаємо її з файлу, а не переписуємо сюди: накатану міграцію не
       редагують, тож цей пін не може протухнути тихо. */
    const m = [...mig.matchAll(/add constraint clinics_timezone_chk\s*\n?\s*check \(timezone in \(([^)]*)\)\)/g)];
    expect(m.length, "у 0202 не знайдено add constraint clinics_timezone_chk").toBeGreaterThan(0);
    const list = m[m.length - 1][1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
    expect([...CLINIC_TIMEZONES]).toEqual(list);
  });
  it("дефолт ринку входить до списку; аліас Europe/Kiev приймається через канон", () => {
    expect(CLINIC_TIMEZONES).toContain(DEFAULT_CLINIC_TZ);
    expect(isClinicTz("Europe/Kiev")).toBe(true);
    expect(isClinicTz("Europe/Kyiv")).toBe(true);
    expect(isClinicTz("UTC")).toBe(true);
    expect(isClinicTz("Europe/Warsaw")).toBe(false);
  });
  it("clinicTzOrDefault: браузерна зона лише зі списку, інакше Europe/Kyiv; аліас — канон", () => {
    expect(clinicTzOrDefault("Europe/Berlin")).toBe("Europe/Kyiv");
    expect(clinicTzOrDefault("Europe/Kiev")).toBe("Europe/Kyiv");
    expect(clinicTzOrDefault("UTC")).toBe("UTC");
    expect(clinicTzOrDefault("")).toBe("Europe/Kyiv");
    expect(clinicTzOrDefault(null)).toBe("Europe/Kyiv");
  });
});

/* ===================== структурні піни на споживачів ===================== */

describe("RegisterPage — назва центру і ПІБ їдуть у metadata; в майстер — лише з сесією", () => {
  const s = src("components/RegisterPage.tsx");
  it("signUp шле clinic_name і full_name із ПОЛІВ форми, а не з логіна", () => {
    expect(s).toMatch(/clinic_name: values\.clinic\.trim\(\)\.replace\(\/\\s\+\/g, " "\)/);
    expect(s).toMatch(/full_name: values\.fullName\.trim\(\)\.replace\(\/\\s\+\/g, " "\)/);
    expect(s).not.toMatch(/clinic_name: normalizeLogin/);
  });
  it("обоє полів — обовʼязкові й у переліку валідації", () => {
    expect(s).toMatch(/const FIELDS = \["clinic", "fullName", "login", "email", "phone", "password", "password2"\]/);
    expect(s).toMatch(/case "clinic": return !v\.trim\(\) \? REQUIRED/);
    expect(s).toMatch(/case "fullName": return !v\.trim\(\) \? REQUIRED/);
  });
  it("«Налаштувати центр →» веде в /setup ЛИШЕ коли signUp видав сесію; інакше — вхід", () => {
    expect(s).toMatch(/return \{ ok: true, session: !!data\?\.session \};/);
    expect(s).toMatch(/setSuccess\(!!res\.session\);/);
    expect(s).toMatch(/\{success \? \(<> [^]*?<a className="btn" href="\/setup">Налаштувати центр →<\/a> <\/>\) : \(<> [^]*?<a className="btn" href="\/login">Перейти до входу<\/a>/);
  });
});

describe("SetupWizard — режим швидкого старту", () => {
  const s = src("components/SetupWizard.tsx");
  /* Гілка швидкого старту — від `if (quickMode) { const stepIx` до return хаба.
     Якір навмисно довший за `if (quickMode) {`: та сама умова стоїть і в onData. */
  const quickShell = (code: string) => {
    const a = code.indexOf("if (quickMode) { const stepIx = qsStepIndex(qsStep);");
    const b = code.indexOf('return ( <div className="wiz"> <UnreadChangesMount /> <aside className="wiz-side"> <div className="wiz-head"> <span className="wiz-logo"><span className="dot" />RadFlow</span> <div className="wiz-sub">{clinicName ||');
    expect(a, "гілка швидкого старту не знайдена").toBeGreaterThan(-1);
    expect(b, "return хаба не знайдений").toBeGreaterThan(a);
    return code.slice(a, b);
  };
  it("правила — з lib/quickStart, а не оголошені локально", () => {
    expect(s).toMatch(/import \{ QS_STEPS, qsStepIndex, qsProgress, qsCenterMissing, qsRoomsMissing, missingText, sectionFromSearch, type QsStep \} from "@\/lib\/quickStart";/);
    expect(s).toMatch(/const center = qsCenterMissing\(d, isValidPhoneUA\);/);
    expect(s).toMatch(/qsRoomsMissing\(d\.equip\.length, equipHoursValid\(d\.equip\), equipBreaksValid\(d\.equip\)\)/);
  });
  it("режим фіксується ПРИ МОНТУВАННІ (useState(firstRun)), а не читається з пропа на кожному рендері", () => {
    expect(s).toMatch(/const \[quickMode\] = useState\(firstRun\);/);
    expect(s).not.toMatch(/if \(firstRun\) \{/);
  });
  it("порядок записів у save(): профіль → кабінети → клініка з configured_at ОСТАННЬОЮ", () => {
    const iProfile = s.indexOf('await supabase .from("profiles") .update({ full_name: d.adminName.trim()');
    const iRooms = s.indexOf('await supabase.from("rooms").insert(roomFields(e))');
    const iClinic = s.indexOf('await supabase .from("clinics") .update({ name: d.clinic.trim(),');
    const iConfigured = s.indexOf("configured_at: new Date().toISOString(),");
    for (const [n, i] of Object.entries({ iProfile, iRooms, iClinic, iConfigured })) expect(i, `${n} не знайдено — пін застарів`).toBeGreaterThan(-1);
    expect(iProfile).toBeLessThan(iRooms);
    expect(iRooms).toBeLessThan(iClinic);
    expect(iConfigured).toBeGreaterThan(iClinic);
    expect(s.match(/configured_at: new Date\(\)\.toISOString\(\),/g)?.length, "configured_at пишеться рівно в одному місці").toBe(1);
  });
  it("«Готово» — лише після успішного save(); «Запустити» і діалог графіка йдуть через launch()", () => {
    expect(s).toMatch(/async function launch\(skipSchedWarn = false\) \{ const ok = await save\(skipSchedWarn\); if \(ok\) setQsStep\("done"\); return ok; \}/);
    expect(s).toMatch(/onClick=\{\(\) => launch\(\)\}/);
    // у швидкому режимі підтвердження «Записи поза новим графіком» теж веде через launch(true), не save(true)
    const quick = quickShell(s);
    expect(quick.length).toBeGreaterThan(1000);
    expect(quick).toMatch(/onConfirm=\{\(\) => \{ setSchedWarnAsk\(null\); launch\(true\); \}\}/);
    expect(quick).not.toMatch(/save\(true\)/);
  });
  it("кнопки «Далі»/«Запустити» вимкнені рівно за qsMissing і описані підказкою «Залишилось»", () => {
    expect(s).toMatch(/disabled=\{!centerOk\} onClick=\{\(\) => setQsStep\("rooms"\)\}>Далі →<\/button>/);
    expect(s).toMatch(/disabled=\{!roomsOk \|\| !centerOk \|\| saving\} aria-busy=\{saving\} onClick=\{\(\) => launch\(\)\}>/);
    expect(s).toMatch(/<span className="fld-hint qs-missing" id="qs-missing" role="status" aria-live="polite">/);
    expect(s.match(/aria-describedby=\{(centerOk|roomsOk) \? undefined : "qs-missing"\}/g)?.length).toBe(2);
  });
  it("посилання чеклиста «Готово» — лише на anchor-и WIZ_NAV; ?section= читається через sectionFromSearch з того ж переліку", () => {
    const raw = read("components/SetupWizard.tsx");
    const anchors = [...raw.matchAll(/anchor: "([^"]+)"/g)].map((m) => m[1]);
    expect(anchors.length).toBeGreaterThanOrEqual(9);
    // кортежі чеклиста: [anchor, title, sub] — FORM_SECTIONS сюди не підпадає (там рядки без заголовка/підпису)
    const links = [...raw.matchAll(/\["(sec-[a-z]+)", "[^"]+", "[^"]+"\]/g)].map((m) => m[1]);
    expect(links.length).toBe(4);
    for (const l of links) expect(anchors, `чеклист веде на секцію ${l}, якої немає у WIZ_NAV`).toContain(l);
    expect(s).toMatch(/const SECTION_ANCHORS: readonly string\[\] = WIZ_NAV\.map\(\(s\) => s\.anchor as string\);/);
    expect(s).toMatch(/const sec = sectionFromSearch\(window\.location\.search, SECTION_ANCHORS\); if \(sec\) setActiveSection\(sec\);/);
    expect(s).toMatch(/href=\{`\/setup\?section=\$\{anchor\}`\}/);
  });
  it("у швидкому старті немає «Вийти» на дошку (петля Ф6-5) — лише вихід з акаунта; форма живе весь час", () => {
    const quick = quickShell(s);
    expect(quick).toMatch(/<SignOutButton \/>/);
    expect(quick).not.toMatch(/router\.push\("\/queue"\)/);
    expect(quick).toMatch(/<div style=\{\{ display: launched \? "none" : "block" \}\}> <StepRegister/);
  });
  it("фокус на заголовок кроку — селектор залежить від кроку (форма після запуску схована)", () => {
    expect(s).toMatch(/querySelector<HTMLElement>\(qsStep === "done" \? "h1\.golive-h" : "h1\.qs-h"\)/);
    expect(s.match(/className="wiz-h qs-h" tabIndex=\{-1\}/g)?.length).toBe(2);
    expect(s).toMatch(/className="golive-h qs-h" tabIndex=\{-1\}/);
  });
  it("select часового поясу — лише зони CHECK; згорнутий вигляд не ховає помилку перерв збереженого кабінету", () => {
    expect(s).toMatch(/function tzList\(\): string\[\] \{ return \[\.\.\.CLINIC_TIMEZONES\]; \}/);
    expect(s).toMatch(/\{\(!quickRooms \|\| e\.breaks\.length > 0\) && \( <div className="eq-breaks">/);
  });
});

describe("app/setup/page.tsx — firstRun з тієї самої ознаки, що робочі екрани", () => {
  const s = src("app/setup/page.tsx");
  it("configured_at читається разом із клінікою і передається у майстер як firstRun", () => {
    expect(s).toMatch(/clinics\(name, city, address, phones, emails, timezone, configured_at,/);
    expect(s).toMatch(/const firstRun = !!clinic && !clinic\.configured_at;/);
    expect(s).toMatch(/firstRun=\{firstRun\}/);
  });
});

describe("/api/account/set-password — автовхід ПІСЛЯ зміни пароля, без шляху у відповіді", () => {
  const raw = read("app/api/account/set-password/route.ts");
  const s = src("app/api/account/set-password/route.ts");
  it("привітання й сесія — після успішного updateUserById і після клейму токена", () => {
    const iClaim = s.indexOf('.update({ password_set: true, invite_token: null })');
    const iPw = s.indexOf("admin.auth.admin.updateUserById(claimed.id as string, { password })");
    const iWelcome = s.indexOf("const welcome = await welcomeAfterSetPassword(admin, claimed.id as string, password);");
    expect(iClaim).toBeGreaterThan(-1); expect(iPw).toBeGreaterThan(iClaim); expect(iWelcome).toBeGreaterThan(iPw);
    // відмова GoTrue (uErr) повертає 400 ДО привітання — автовходу з невстановленим паролем немає
    const iUErr = s.indexOf("if (uErr) {");
    expect(iUErr).toBeGreaterThan(iPw); expect(iUErr).toBeLessThan(iWelcome);
  });
  it("сесію відкриває клієнт СЕСІЇ (cookie), адреса — з auth.users; service-role сесій не видає", () => {
    expect(s).toMatch(/const session = await createClient\(\); const \{ error: sErr \} = await session\.auth\.signInWithPassword\(\{ email, password \}\);/);
    expect(s).toMatch(/await admin\.auth\.admin\.getUserById\(userId\)/);
    expect(s).not.toMatch(/admin\.auth\.signInWithPassword/);
  });
  it("у відповіді — роль і лічильники, але НЕ шлях/редірект (клієнт рахує шлях сам)", () => {
    expect(raw).toMatch(/type WelcomePayload = \{[^}]*signedIn: boolean;[^}]*role: string \| null;[^}]*clinic_name: string \| null;[^}]*rooms_count: number \| null;[^}]*centers_count: number \| null;[^}]*\};/s);
    expect(raw).not.toMatch(/type WelcomePayload = \{[^}]*(path|redirect|start|url)\b/s);
    expect(s).toMatch(/return NextResponse\.json\(\{ ok: true, \.\.\.welcome \}\);/);
  });
  it("усе best-effort: збій привітання/автовходу не ламає успіх (try/catch + logError), лічильники — head:true", () => {
    expect(s).toMatch(/async function welcomeAfterSetPassword\([^)]*\): Promise<WelcomePayload> \{ const out: WelcomePayload = \{ signedIn: false,[^}]*\}; try \{/);
    expect(s).toMatch(/\} catch \(e\) \{ logError\(\{ event: "set_password\.welcome_failed"/);
    expect(s).toMatch(/if \(sErr\) logError\(\{ event: "set_password\.autologin_failed"/);
    expect(s.match(/\{ count: "exact", head: true \}/g)?.length).toBe(3);
  });
  it("піни inviteTtl не зрушені: invite_issued_at рівно 4 рази, TTL до клейму", () => {
    expect(s.match(/invite_issued_at/g)).toHaveLength(4);
  });
});

describe("SetPasswordPage — шлях лише з ролі; без сесії — вхід", () => {
  const s = src("components/SetPasswordPage.tsx");
  it("welcomeFor із ролі й лічильників відповіді; шлях з відповіді НЕ читається", () => {
    expect(s).toMatch(/import \{ welcomeFor, type Welcome \} from "@\/lib\/quickStart";/);
    expect(s).toMatch(/role: typeof data\?\.role === "string" \? data\.role : null,/);
    expect(s).not.toMatch(/data\??\.(path|start|redirect|url)\b/);
    expect(s).toMatch(/<a className="btn" href=\{success\.welcome\.path\}>\{success\.welcome\.cta\}<\/a>/);
  });
  it("signedIn — лише строге === true; без сесії — «Перейти до входу»", () => {
    expect(s).toMatch(/signedIn: data\?\.signedIn === true,/);
    expect(s).toMatch(/<div className="sub">Тепер увійдіть за своїм логіном і паролем\.<\/div> <a className="btn" href="\/login">Перейти до входу<\/a>/);
  });
  it("register.css: нові класи не тягнуть незадекларованих токенів (пін wcagMedium «var(--x) оголошено в .reg-root» діє на них теж)", () => {
    const css = read("components/register.css");
    expect(css).toMatch(/\.reg-root \.success \.next \{/);
    expect(css).toMatch(/\.reg-root \.success \.next li::before \{ content: "→";/);
  });
});

describe("radflow-wizard.css — блок швидкого старту", () => {
  const css = read("styles/prototype/radflow-wizard.css");
  it("класи .qs-* є; ракета і прогрес без руху для prefers-reduced-motion (2.3.3)", () => {
    for (const c of [".qs-steps", ".qs-step", ".qs-step-btn", ".qs-tz", ".qs-missing", ".qs-bar-right", ".qs-check-link", ".qs-done-actions"]) {
      expect(css, `немає правила ${c}`).toContain(c + " {");
    }
    const rm = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(rm).toMatch(/\.rocket \{ animation: none; \}/);
    expect(rm).toMatch(/\.wiz-prog-fill \{ transition: none; \}/);
  });
  it("коментарі не закриваються достроково (урок цього ж пакета: «*/» усередині тексту)", () => {
    // Після зняття коментарів у файлі не має лишитись рядків без «{» чи «}», що схожі на прозу
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const prose = stripped.split("\n").filter((l) => /[а-яіїє]/i.test(l) && !/[{}]/.test(l) && !/content:/.test(l));
    expect(prose, "рядок прози опинився поза коментарем — коментар закрився на «*/» усередині тексту").toEqual([]);
  });
});
