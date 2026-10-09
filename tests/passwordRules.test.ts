/* ===== Межа пароля 72 БАЙТИ — одна на всі форми (с85, Н-27(з)) =====

   Що стережемо. GoTrue відхиляє пароль довший за 72 байти UTF-8
   (`checkPasswordStrength`: Go `len(password) > 72`), а схема `zPassword`
   пропускає 200 символів. До с85 це знав лише роут «Змінити пароль» оператора;
   решта форм доходила до GoTrue й отримувала відмову вже після своїх записів.

   Тут: (1) сама арифметика межі — на кирилиці, де символ ≠ байт; (2) правило
   поля нового пароля — ПОВЕДІНКОЮ, бо воно тепер функція; (3) СКАНЕР, а не
   список: кожен API-роут, що бере `zPassword`, мусить звірити довжину в байтах
   РАНІШЕ за першу ВИДИМУ в тілі POST побічну дію — це евристика (дію, сховану в
   допоміжну функцію поза POST, сканер не бачить; ревʼю с85, лінза B), справжні
   сторожі — поведінкові тести роутів; (4) форми реєстрації й встановлення пароля
   беруть правило зі спільного модуля. Діалоги адміна «Задати пароль»
   (StaffManager, CeoManager) власної перевірки не мають: відмову роуту
   (той самий текст) вони показують у тості — це межа, а не недогляд. */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  PASSWORD_LIMIT_HINT, PASSWORD_MAX_BYTES, PASSWORD_RULE, PASSWORD_TOO_LONG,
  passwordBytes, passwordFieldError, passwordTooLong,
} from "@/lib/passwordRules";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
/** Код без коментарів: пін, який задовольняє коментар, — брехня (урок с69). */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

describe("passwordBytes / passwordTooLong — межа рахується в БАЙТАХ, як у bcrypt", () => {
  it("латиниця: 72 символи — можна, 73 — ні", () => {
    expect(passwordTooLong("a".repeat(72))).toBe(false);
    expect(passwordTooLong("a".repeat(73))).toBe(true);
  });
  it("кирилиця — 2 байти на літеру: 36 літер — межа, 37 — уже задовго", () => {
    expect(passwordBytes("я".repeat(36))).toBe(72);
    expect(passwordTooLong("я".repeat(36))).toBe(false);
    expect(passwordTooLong("я".repeat(37))).toBe(true);
    /* Головне: 37 символів ≪ 200 зі схеми, тобто zPassword такий пароль пропускає. */
    expect("я".repeat(37).length).toBeLessThan(200);
  });
  it("змішаний і чотирибайтовий символ (емодзі) рахуються за UTF-8, а не за .length", () => {
    expect(passwordBytes("Пароль1!")).toBe(6 * 2 + 2);
    expect(passwordBytes("😀")).toBe(4);
    expect("😀".length).toBe(2); // UTF-16: саме тому .length тут не годиться
    expect(passwordTooLong("😀".repeat(18))).toBe(false); // 72 байти
    expect(passwordTooLong("😀".repeat(18) + "a")).toBe(true);
  });
  it("константа і тексти кажуть одне число", () => {
    expect(PASSWORD_MAX_BYTES).toBe(72);
    expect(PASSWORD_LIMIT_HINT).toMatch(/^до 72 байтів/);
    expect(PASSWORD_LIMIT_HINT).toMatch(/≈36 — кирилицею/);
    expect(PASSWORD_TOO_LONG).toBe(`Пароль задовгий: ${PASSWORD_LIMIT_HINT}`);
  });
});

/* Ревʼю с85 (лінза B): правило поля жило двома однаковими виразами в RegisterPage і
   SetPasswordPage, а перший варіант тесту пінив ТЕКСТ виразу (переформатування ламало
   пін, недосяжний код його задовольняв). Тепер правило — функція, перевірка — поведінкою. */
describe("passwordFieldError — правило поля нового пароля", () => {
  it("складність: коротко, без великої літери, без цифри — правило; усе на місці — порожньо", () => {
    expect(passwordFieldError("Abc1234")).toBe(PASSWORD_RULE);
    expect(passwordFieldError("abcdefg1")).toBe(PASSWORD_RULE);
    expect(passwordFieldError("Abcdefgh")).toBe(PASSWORD_RULE);
    expect(passwordFieldError("Пароль12")).toBe("");
    expect(passwordFieldError("Ґанок123"), "«Ґ» — велика літера української абетки").toBe("");
  });
  it("межа сервера входу — після складності, рівно на 72 байтах", () => {
    expect(passwordFieldError("Я1" + "a".repeat(69))).toBe(""); // 2 + 1 + 69 = 72
    expect(passwordFieldError("Я1" + "a".repeat(70))).toBe(PASSWORD_TOO_LONG); // 73
    expect(passwordFieldError("Я1" + "я".repeat(34) + "a")).toBe(""); // 3 + 68 + 1 = 72
    expect(passwordFieldError("Я1" + "я".repeat(35))).toBe(PASSWORD_TOO_LONG); // 73
  });
  it("слабкий І задовгий — спершу правило складності (воно пояснює більше)", () => {
    expect(passwordFieldError("я".repeat(40))).toBe(PASSWORD_RULE);
  });
});

/* ═══════ Сканер роутів: хто бере zPassword, той звіряє байти ДО побічних дій ═══════ */

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p));
    else if (name === "route.ts") out.push(p);
  }
  return out;
}
const ROUTES = routeFiles(resolve(ROOT, "app/api")).map((p) => p.slice(ROOT.length + 1).replace(/\\/g, "/"));
/** Гейти ролі/оператора стоять ПЕРЕД розбором тіла за правилом серверної поверхні
    («service-role ніколи не раніше за гейт»): там вони законні й з переліку знімаються. */
const GATES = ["requireRole(", "requirePlatformOperator("];
/** Побічні дії, після яких відмова за довжиною вже запізнилась: БД, ліміт, GoTrue, журнали.
    Ревʼю с85 (лінза B): перша редакція дивилась лише ПІСЛЯ parseBody і мала короткий
    перелік — перенесений угору ліміт чи читання БД проходили повз сканер. */
const SIDE_EFFECTS = [...GATES, "createAdminClient(", "createClient(", "rateLimitOk(", ".from(", ".rpc(", ".auth.",
  "updateUserById(", "checkCurrentPassword(", "emitImportantEvent(", "platformLog("];

describe("роути з паролем — межа 72 байти перевіряється, і ДО побічних дій", () => {
  const withPassword = ROUTES.filter((r) => /\bzPassword\b/.test(code(r)));

  it("сканер бачить усі три роути, що ставлять пароль (антитавтологія)", () => {
    expect(withPassword.sort()).toEqual([
      "app/api/account/set-password/route.ts",
      "app/api/platform/me/password/route.ts",
      "app/api/staff/password/route.ts",
    ]);
  });

  it("кожен такий роут викликає passwordTooLong", () => {
    const missing = withPassword.filter((r) => !/\bpasswordTooLong\(/.test(code(r)));
    expect(missing, "роут бере zPassword (200 символів), але межу GoTrue в 72 байти не звіряє").toEqual([]);
  });

  it("у межах POST перевірка довжини — після розбору тіла і раніше за будь-яку побічну дію", () => {
    const late: string[] = [];
    for (const r of withPassword) {
      const s = code(r);
      const post = s.indexOf("export async function POST(");
      expect(post, `${r}: немає POST`).toBeGreaterThan(-1);
      const body = s.slice(post);
      const guard = body.indexOf("passwordTooLong(");
      const parse = body.indexOf("parseBody(");
      const early = SIDE_EFFECTS.filter((t) => {
        const i = body.indexOf(t);
        if (i < 0 || (GATES.includes(t) && i < parse)) return false;
        return i < guard;
      });
      if (guard < 0 || guard < parse || early.length) late.push(`${r}: ${early.join(", ") || "немає перевірки після parseBody"}`);
    }
    expect(late, "відмова за довжиною запізнилась: побічна дія вже сталась").toEqual([]);
  });
});

/* ═══════ Клієнтські форми, що ставлять пароль ═══════ */

describe("форми пароля — межу видно ДО відправки", () => {
  /* Реєстрація ставить пароль напряму в GoTrue (signUp): серверного роуту, який би
     переклав відмову, там НЕМАЄ — тож без цієї гілки людина бачила б англійське
     «Password cannot be longer than 72 characters». */
  it("реєстрація і встановлення пароля за посиланням беруть правило поля зі спільного модуля", () => {
    for (const f of ["components/RegisterPage.tsx", "components/SetPasswordPage.tsx"]) {
      const s = code(f);
      expect(s, `${f}: поле пароля перевіряє не passwordFieldError`).toMatch(/\? REQUIRED : passwordFieldError\(v\)/);
      expect(s, `${f}: правило не зі спільного модуля`).toMatch(/import \{ passwordFieldError \} from "@\/lib\/passwordRules"/);
      expect(s, `${f}: власна копія правила складності — вона розійдеться`).not.toMatch(/\[A-ZА-Я/);
    }
  });
  it("консоль оператора бере ту саму межу і підказку, а не власну копію", () => {
    const s = code("components/PlatformConsole.tsx");
    expect(s).toMatch(/if \(passwordTooLong\(next\)\) return `Новий пароль задовгий: \$\{PASSWORD_LIMIT_HINT\}`;/);
  });
  /* Довжину пароля в байтах рахує лише lib/passwordRules.ts. Евристика (ревʼю с85, лінза B,
     Info): ловить ЗВИЧНІ способи — TextEncoder, Buffer.byteLength, Blob — у файлах, що
     працюють із паролем; повноти не обіцяє, справжній сторож — поведінкові тести роутів. */
  it("у файлах із паролем немає власного підрахунку байтів", () => {
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(resolve(ROOT, d))) {
        const p = `${d}/${n}`;
        if (statSync(resolve(ROOT, p)).isDirectory()) { walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(n) || p === "lib/passwordRules.ts") continue;
        const s = code(p);
        if (/password|пароль/i.test(s) && /new TextEncoder\(|Buffer\.byteLength\(|new Blob\(/.test(s)) hits.push(p);
      }
    };
    ["app", "components", "lib"].forEach(walk);
    expect(hits, "друга копія межі пароля — вони розійдуться").toEqual([]);
  });
});
