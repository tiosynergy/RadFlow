/**
 * СЕРВЕРНА ПОВЕРХНЯ АВТОРИЗАЦІЇ — Ф6, пакет 2 (с55).
 *
 * ЧОГО ЦЕ СТОСУЄТЬСЯ. Пакет 1 закрив СТОРІНКИ (`page.tsx`). Але дані лежать не
 * там: до них ходять 49 `route.ts`, 48 server actions і 111 SECURITY DEFINER
 * функцій. У пакеті 1 ця поверхня була НАЗВАНОЮ межею — тут вона закривається.
 *
 * ЩО ВИМІРЯНО (03.09.2026, читанням і запитом до прода, а не сканером):
 *   • ліки ВЖЕ Є і вони одні на всіх: `requireRole()` у `lib/apiAuth.ts`, і в
 *     його шапці прямо сказано, заради чого — «риск был в РЕГРЕССЕ нового
 *     роута». Машинний канал має свій: `requireIntegrationKey()` (fail-closed,
 *     скоупи, два незалежні rate-limit) і `requireFhirKey()` поверх нього;
 *   • з 49 роутів: 22 через `requireRole`, 15 через ключ, 4 через `CRON_SECRET`,
 *     8 — pre-auth за побудовою (вхід, встановлення пароля за одноразовим
 *     токеном, OAuth-callback, розлогін, CapabilityStatement) і одна надгробна
 *     заглушка 410. Кожен із восьми ПРОЧИТАНИЙ, не вгаданий;
 *   • усі 48 server actions ходять через `createClient()` — клієнт СЕСІЇ, тобто
 *     їх стереже RLS плюс локальний хелпер або SECURITY DEFINER RPC з власним
 *     гардом. Жоден не бере service-role;
 *   • з 111 SECURITY DEFINER функцій без перевірки викликача і при цьому
 *     доступних ролі `authenticated` — РІВНО ДВІ (`search_cities`,
 *     `search_clinics`), обидві віддають публічний довідник для форми
 *     реєстрації. `anon` не має EXECUTE на жодну.
 *
 * ⚠️ ЧОГО НЕ БУЛО. Сторожа на все це не було НІЯКОГО. Новий роут, який смикне
 * `createAdminClient()` повз `requireRole`, обходить RLS без перевірки ролі —
 * і жоден тест не сказав би ні слова. Це дослівно клас Ф6-1 поверхом нижче.
 *
 * ⚠️ НАЗВАНА МЕЖА. 64 RLS-політики — фактичний гейт для найбільшої поверхні
 * (48 actions) — у цьому файлі НЕ перевіряються: вони живуть у БД, а не в
 * дереві. Це пакет 3, а не пропуск.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { codeOf } from "./helpers/codeOf";

const src = (p: string) => codeOf(readFileSync(resolve(process.cwd(), p), "utf8")).replace(/\s+/g, " ");

function walk(dir: string, acc: string[], pred: (n: string) => boolean): string[] {
  for (const e of readdirSync(resolve(process.cwd(), dir), { withFileTypes: true })) {
    if (e.isDirectory()) walk(`${dir}/${e.name}`, acc, pred);
    else if (pred(e.name)) acc.push(`${dir}/${e.name}`);
  }
  return acc;
}

const ROUTES = walk("app", [], (n) => n === "route.ts" || n === "route.tsx").sort();
const pathOf = (f: string) => f.replace(/^app/, "").replace(/\/route\.tsx?$/, "") || "/";

/* Три гейти — і всі три реальні в дереві. Четвертого немає: якщо зʼявиться,
   роут спершу почервоніє тут, і його доведеться НАЗВАТИ, а не додати мовчки. */
const gated = (s: string) =>
  /requireRole\(/.test(s) || /requireIntegrationKey\(|requireFhirKey\(/.test(s) || /CRON_SECRET/.test(s);

/* ===== PRE-AUTH: роути, де сесії ще НЕМАЄ за побудовою =====
   Кожен прочитаний очима в с55; причина — не «схоже на службовий», а що саме
   його стереже замість ролі. Виняток без причини — місце, куди тихо додають
   новий незахищений роут. */
const PRE_AUTH: Record<string, string> = {
  "/api/auth/login": "вхід: сесії ще немає. Стереже rate-limit по IP (15/5хв) і по ідентифікатору (8/5хв); service-role потрібен, щоб знайти email за логіном ДО автентифікації",
  "/api/auth/login-available": "перевірка вільності логіна у формі реєстрації: сесії немає; rate-limit по IP і по логіну",
  "/api/account/set-password": "встановлення пароля за ОДНОРАЗОВИМ invite-токеном: сесії немає за побудовою. Стереже форма токена (hex 32-80) плюс rate-limit по IP",
  "/api/clinic/delete-confirm": "підтвердження видалення центру за посиланням з листа: сесії немає. Стереже пара rid(uuid) плюс token(hex 48) з листа",
  "/api/auth/reset": "розлогін і редірект на /login. Даних не читає і не пише — стерегти нічого",
  "/auth/callback": "обмін OAuth-коду на сесію. Даних не читає; сам код і є секрет",
  "/fhir/R4/metadata": "CapabilityStatement — статичний опис фасаду, публічний за R4. У БД не ходить",
  "/api/referrers/update": "надгробок: POST повертає 410. Тіла немає, БД не чіпає",
};

/* Файли, яким дозволено імпортувати service-role поза роутами. Це інфраструктура
   (лімітер, журнал, outbox, самі гейти), а не доступ до даних користувача. */
const ADMIN_IMPORTERS = [
  "lib/apiAuth.ts",
  "lib/importantEvents.server.ts",
  "lib/integrationAuth.ts",
  "lib/outbox.ts",
  "lib/rateLimit.ts",
];

const ACTION_FILES = ["app/queue/actions.ts", "app/services/actions.ts", "app/waitlist/actions.ts"];

describe("серверна поверхня авторизації — роути", () => {
  it("кожен роут або має гейт, або НАЗВАНИЙ як pre-auth із причиною", () => {
    const ungated = ROUTES.filter((f) => !gated(src(f))).map(pathOf).sort();
    expect(ungated, "новий роут без гейта — саме так дані і виходять назовні; або поставте requireRole, або назвіть його в PRE_AUTH разом із тим, що його стереже").toEqual(Object.keys(PRE_AUTH).sort());
    for (const [r, why] of Object.entries(PRE_AUTH)) {
      expect(why.length, `виняток ${r} лишився без причини`).toBeGreaterThan(20);
    }
    /* ⚠️ Причина в інвентарі — це проза; вона могла б розійтися з кодом мовчки.
       Тому додатково: pre-auth роут, який БЕРЕ service-role, мусить мати
       ВИДИМИЙ замінник ролі — токен або ліміт. «Нічого не перевіряємо, бо
       pre-auth» тут не проходить. */
    const weak: string[] = [];
    for (const f of ROUTES) {
      const p = pathOf(f);
      if (!(p in PRE_AUTH)) continue;
      const s = src(f);
      if (!/createAdminClient\(/.test(s)) continue;
      if (!/rateLimitOk\(/.test(s) && !/token/i.test(s)) weak.push(p);
    }
    expect(weak, "pre-auth роут бере service-role і не має ні токена, ні ліміту — це відкритий доступ до даних без сесії").toEqual([]);
  });

  it("PRE_AUTH не описує роута, якого в дереві немає", () => {
    const known = new Set(ROUTES.map(pathOf));
    const ghosts = Object.keys(PRE_AUTH).filter((r) => !known.has(r));
    expect(ghosts, "інвентар pre-auth описує неіснуючий роут — сторож охороняє порожнечу").toEqual([]);
  });

  /* ⚠️ ГОЛОВНА ВЛАСТИВІСТЬ ПАКЕТА. `createAdminClient()` — це service-role:
     RLS під ним НЕ ЗАСТОСОВУЄТЬСЯ взагалі. Шапка `lib/apiAuth.ts` каже, що
     гейт існує саме щоб гарантувати «правильный порядок проверок ДО любого
     createAdminClient()». Тут ця обіцянка перевіряється, а не переказується. */
  it("service-role ніколи не раніше за гейт", () => {
    const late: string[] = [];
    for (const f of ROUTES) {
      const s = src(f);
      const adm = s.indexOf("createAdminClient(");
      if (adm < 0) continue;
      const pos = ["requireRole(", "requireIntegrationKey(", "requireFhirKey(", "CRON_SECRET"]
        .map((g) => s.indexOf(g)).filter((i) => i >= 0);
      if (!pos.length) continue; // pre-auth — покрито тестом вище
      if (Math.min(...pos) > adm) late.push(pathOf(f));
    }
    expect(late, "у роуті service-role береться РАНІШЕ за гейт — перевірка ролі перестала бути умовою доступу до даних").toEqual([]);
  });
});

describe("серверна поверхня авторизації — server actions", () => {
  it("склад файлів із \"use server\" — рівно названий", () => {
    const found = walk("app", [], (n) => /\.tsx?$/.test(n))
      .filter((f) => /^\s*["']use server["']/m.test(codeOf(readFileSync(resolve(process.cwd(), f), "utf8"))))
      .sort();
    expect(found, "зʼявився новий файл server actions — перечитайте, під яким клієнтом він ходить у базу").toEqual(ACTION_FILES);
  });

  /* ⚠️ Модель розділення: actions ходять під СЕСІЄЮ користувача, тому їх
     стереже RLS (плюс локальний хелпер або SECURITY DEFINER RPC з власним
     гардом). Service-role в actions мовчки вимкнув би RLS для найбільшої
     поверхні в проєкті — 48 дій. */
  it("server actions ніколи не беруть service-role", () => {
    const bad = ACTION_FILES.filter((f) => /createAdminClient\(/.test(src(f)));
    expect(bad, "server action узяв service-role — RLS для нього більше не діє, а іншого гейта в actions немає").toEqual([]);
  });

  it("імпорт service-role поза роутами — рівно названий круг", () => {
    const files = walk("app", [], (n) => /\.tsx?$/.test(n))
      .concat(walk("lib", [], (n) => /\.tsx?$/.test(n)))
      .concat(walk("components", [], (n) => /\.tsx?$/.test(n)));
    const importers = files
      .filter((f) => !/route\.tsx?$/.test(f))
      .filter((f) => /from "@\/lib\/supabase\/admin"/.test(src(f)))
      .sort();
    expect(importers, "service-role зʼявився у файлі поза названим кругом інфраструктури — перевірте, хто і за що його викликає").toEqual(ADMIN_IMPORTERS);
  });
});

describe("серверна поверхня авторизації — самі гейти", () => {
  /* Гейт, який можна обійти зсередини, гірший за відсутність гейта: на нього
     покладаються 22 роути. Тому перевіряється ПОРЯДОК кроків і те, що успіх
     повертається РІВНО один раз і в самому кінці. */
  it("requireRole: порядок кроків і єдиний вихід успіху", () => {
    const s = src("lib/apiAuth.ts");
    const at = (needle: string) => {
      const i = s.indexOf(needle);
      expect(i, `у lib/apiAuth.ts зник крок «${needle}»`).toBeGreaterThan(-1);
      return i;
    };
    const user = at("auth.getUser()");
    const profile = at('.from("profiles")');
    const roleChk = at("allowed.includes(me.role)");
    const clinicChk = at("opts?.needClinic && !me.clinic_id");
    expect(user < profile, "профіль беруть раніше за користувача").toBe(true);
    expect(profile < roleChk, "роль перевіряють раніше, ніж узяли профіль").toBe(true);
    expect(roleChk < clinicChk, "перевірка центру виїхала вище за перевірку ролі").toBe(true);
    const oks = s.match(/return \{ ok: true/g) || [];
    expect(oks.length, "у requireRole більше одного виходу «успіх» — гейт можна пройти повз перевірки").toBe(1);
    expect(s.lastIndexOf("return { ok: true"), "успіх повертається ДО перевірок").toBeGreaterThan(clinicChk);
    /* Проміжок навмисно НЕ `[\s\S]*` — це вікно, яке не вміє перестрибнути
       чужий `return`: інакше пін злапав би відмову з іншої гілки. */
    expect(s, "зникла відмова 401 для незалогіненого")
      .toMatch(/if \(!user\) \{(?:(?!return )[\s\S]){0,400}return err\("Не авторизовано", 401\);/);
    expect(s, "зникла відмова 403 для чужої ролі")
      .toMatch(/return err\(opts\?\.forbidden \?\? "Недостатньо прав", 403\);/);
  });

  it("requireIntegrationKey: fail-closed на кожному кроці", () => {
    const s = src("lib/integrationAuth.ts");
    expect(s, "перевірка форми або наявності Bearer-ключа ослаблена")
      .toMatch(/if \(!token \|\| !isIntegrationToken\(token\)\) \{ return deny\(401,/);
    /* ⚠️ Обидва поля відкликання — навмисно. Прибрати `revoked_at !== null`
       означало б пускати ВІДКЛИКАНИЙ ключ, і БД цього не спіймає: інваріант
       0144 стежить за узгодженістю полів, а не за тим, що код їх читає. */
    expect(s, "перевірка відкликання ключа ослаблена — відкликаний ключ пройде")
      .toMatch(/if \(!key \|\| !key\.active \|\| key\.revoked_at !== null\) \{ return deny\(401,/);
    expect(s, "перевірка скоупа ослаблена — ключ пройде на чужий ресурс")
      .toMatch(/if \(!Array\.isArray\(key\.scopes\) \|\| !key\.scopes\.includes\(scope\)\) \{ return deny\(403,/);
    const oks = s.match(/return \{ ok: true,/g) || [];
    expect(oks.length, "у requireIntegrationKey більше одного виходу «успіх»").toBe(1);
    expect(s.lastIndexOf("return { ok: true,"), "успіх повертається ДО перевірки скоупа")
      .toBeGreaterThan(s.indexOf("key.scopes.includes(scope)"));
  });
});
