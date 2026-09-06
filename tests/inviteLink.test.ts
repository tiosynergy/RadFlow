import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  EMPTY_TOKENS, REISSUE_HINT, forgetToken, inviteHint, rememberToken, tokenOf,
  type FreshTokens,
} from "@/lib/inviteLink";

const TOK = "a".repeat(64);
const TOK2 = "b".repeat(64);

function codeOf(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

describe("RF-09 — tokenOf: що взагалі вважаємо токеном", () => {
  it("непорожній рядок — токен", () => expect(tokenOf(TOK)).toBe(TOK));
  it("порожній і пробільний — ні", () => {
    expect(tokenOf("")).toBeNull();
    expect(tokenOf("   ")).toBeNull();
  });
  it("не-рядок — ні (відповідь роута нетипізована)", () => {
    expect(tokenOf(null)).toBeNull();
    expect(tokenOf(undefined)).toBeNull();
    expect(tokenOf(0)).toBeNull();
    expect(tokenOf(false)).toBeNull();
    expect(tokenOf({ token: TOK })).toBeNull();
    expect(tokenOf([TOK])).toBeNull();
  });
});

describe("RF-09 — rememberToken", () => {
  it("кладе токен за ключем профілю", () => {
    expect(rememberToken(EMPTY_TOKENS, "p1", TOK)).toEqual({ p1: TOK });
  });
  it("ВІДСУТНЄ значення НЕ затирає вже відомий токен", () => {
    const m: FreshTokens = { p1: TOK };
    expect(rememberToken(m, "p1", undefined)).toBe(m);
    expect(rememberToken(m, "p1", null)).toBe(m);
    expect(rememberToken(m, "p1", "")).toBe(m);
  });
  it("порожній profileId ігнорується (роут не повернув id)", () => {
    const m: FreshTokens = { p1: TOK };
    expect(rememberToken(m, "", TOK2)).toBe(m);
  });
  it("той самий токен повертає ТУ САМУ посилання (без зайвого рендера)", () => {
    const m: FreshTokens = { p1: TOK };
    expect(rememberToken(m, "p1", TOK)).toBe(m);
  });
  it("новий токен ЗАМІНЮЄ старий: після повторного скидання старе посилання мертве", () => {
    expect(rememberToken({ p1: TOK }, "p1", TOK2)).toEqual({ p1: TOK2 });
  });
  it("не мутує попередню карту", () => {
    const m: FreshTokens = { p1: TOK };
    rememberToken(m, "p2", TOK2);
    expect(m).toEqual({ p1: TOK });
  });
});

describe("RF-09 — forgetToken", () => {
  it("прибирає ключ", () => expect(forgetToken({ p1: TOK, p2: TOK2 }, "p1")).toEqual({ p2: TOK2 }));
  it("невідомий ключ повертає ту саму посилання", () => {
    const m: FreshTokens = { p1: TOK };
    expect(forgetToken(m, "zzz")).toBe(m);
  });
  it("не мутує попередню карту", () => {
    const m: FreshTokens = { p1: TOK };
    forgetToken(m, "p1");
    expect(m).toEqual({ p1: TOK });
  });
});

describe("RF-09 — inviteHint: три стани, а не два", () => {
  it("пароль задано → нічого не показуємо, навіть якщо токен ще в карті", () => {
    expect(inviteHint(true, { p1: TOK }, "p1")).toEqual({ kind: "none" });
  });
  it("пароль не задано + токен на руках → посилання", () => {
    expect(inviteHint(false, { p1: TOK }, "p1")).toEqual({ kind: "link", token: TOK });
  });
  it("пароль не задано + токена немає → підказка «перевидати», а НЕ порожнеча", () => {
    expect(inviteHint(false, EMPTY_TOKENS, "p1")).toEqual({ kind: "reissue" });
  });
  it("токен ЧУЖОГО профілю не підтягується", () => {
    expect(inviteHint(false, { p2: TOK }, "p1")).toEqual({ kind: "reissue" });
  });
  it("порожній/невідомий profileId → «перевидати», а не падіння", () => {
    expect(inviteHint(false, { p1: TOK }, null)).toEqual({ kind: "reissue" });
    expect(inviteHint(false, { p1: TOK }, undefined)).toEqual({ kind: "reissue" });
    expect(inviteHint(false, { p1: TOK }, "")).toEqual({ kind: "reissue" });
  });
  it("password_set може прийти null/undefined (тип у ReferrerProfile необовʼязковий)", () => {
    expect(inviteHint(null, { p1: TOK }, "p1")).toEqual({ kind: "link", token: TOK });
    expect(inviteHint(undefined, EMPTY_TOKENS, "p1")).toEqual({ kind: "reissue" });
  });
  it("сміття в карті не стає посиланням", () => {
    expect(inviteHint(false, { p1: "" } as FreshTokens, "p1")).toEqual({ kind: "reissue" });
  });
});

describe("RF-09 — текст підказки один на два екрани", () => {
  it("згадує «Скинути пароль» і те, що старе посилання перестане діяти", () => {
    expect(REISSUE_HINT).toContain("Скинути пароль");
    expect(REISSUE_HINT).toContain("перестане діяти");
  });
});

/* ⚠️ ГОЛОВНИЙ ПІН ПАКЕТА, і він лексичний навмисно.
   Після міграції 0178 клієнтська роль не має права SELECT на
   `profiles.invite_token`: PostgREST відповість 42501 на ВЕСЬ запит, а не на
   колонку — список персоналу чи направників стане порожнім. Ніякий юніт цього
   не зловить: у проєкті немає DOM-тестів і немає живої БД у vitest. Тому
   стережемо саме ТЕКСТ запиту.
   Свідома межа: перевірка по імені колонки в рядку `.select(...)`. Динамічно
   зібраний перелік колонок вона не побачить — але такого в цих екранах немає
   і бути не повинно (окремий пін нижче). */
describe("RF-09 — жоден клієнтський select не просить invite_token", () => {
  const CLIENT_FILES = [
    "components/StaffManager.tsx",
    "components/ReferrersManager.tsx",
  ];

  for (const rel of CLIENT_FILES) {
    /* ⚠️ Тут стояв ще один тест — «у select-рядках немає invite_token», що
       вимагав рівно `from("profiles").select("…літерал…")`. Знято свідомо:
       стенд (позиція T3) показав, що він ЧЕРВОНІВ на доброякісний рефактор —
       винесення переліку колонок в іменовану константу. Сторож, який
       червоніє на нормальну правку, буде знятий разом із користю (урок 0141).
       Перевірка нижче суворіша й приймає обидві форми, тож нічого не втрачено. */

    /* ⚠️ Друга редакція. Перша вимагала літеральності лише для тих запитів,
       де `.select(` стоїть ВПРИТУЛ до `from("profiles")` — і ревʼю Б це
       пробило: `const q = supabase.from("profiles"); q.select("id,
       invite_token")` пін не бачить, а страхувальний `length > 0` вдоволений
       СТАРИМ, чистим запитом. Тому рахуємо ОБИДВА боки: скільки в файлі
       звертань до таблиці — стільки й має бути перевірених літеральних
       select-ів. Розрив між `from` і `select` одразу дає розбіжність.
       ⚠️ Іменована константа (`const COLS = "id, login…"; .select(COLS)`) —
       доброякісний рефактор, і пін мусить його ПРИЙМАТИ, інакше почервоніє на
       нормальній правці й буде знятий (урок 0141). Тому літерал шукаємо або
       на місці, або за іменем константи. */
    it(`${rel}: КОЖЕН запит до profiles має перевірений перелік колонок`, () => {
      const code = codeOf(rel);
      const froms = (code.match(/from\("profiles"\)/g) || []).length;
      expect(froms, "жодного звертання до profiles не знайдено — пін осліп").toBeGreaterThan(0);

      const checked = [...code.matchAll(/from\("profiles"\)\s*\.select\(\s*([A-Za-z_$][\w$]*|"[^"]*")/g)]
        .map((m) => m[1]);
      expect(checked.length, `звертань до profiles ${froms}, а перевірених select-ів ${checked.length}: якийсь запит зібрано в обхід піна`).toBe(froms);

      for (const c of checked) {
        // або рядковий літерал на місці, або іменована константа-літерал у цьому ж файлі
        const cols = c.startsWith('"')
          ? c.slice(1, -1)
          : (code.match(new RegExp(`const\\s+${c}\\s*=\\s*"([^"]*)"`)) || [])[1];
        expect(cols, `перелік колонок для select(${c}) не є рядковим літералом`).toBeTypeOf("string");
        expect(cols).not.toContain("invite_token");
      }
    });

    /* ⚠️ Третя редакція, і кожна попередня була пробита.
       (1) «є десь у файлі `rememberToken(` і `data.invite_token`» — пробито
           стендом (B4): прибирання ОДНОГО з двох викликів лишало обидва рядки.
       (2) «рівно 2 виклики» — пробито ревʼю Б: у `ReferrersManager` шляхів
           видачі ВИЯВИЛОСЬ ТРИ (`invite`, `resetPassword`, `reinvite`), і
           жорстке число блокувало саму ПОЧИНКУ третього.
       Тепер пін іменує ОБРОБНИКИ поіменно: кожен, хто отримує відповідь роута
       видачі, мусить покласти токен у карту. Зникне обробник — тест скаже
       «не знайдено», а не промовчить. */
    const HANDLERS: Record<string, string[]> = {
      "components/StaffManager.tsx": ["createAccount", "resetPassword"],
      "components/ReferrersManager.tsx": ["invite", "resetPassword", "reinvite"],
    };
    it(`${rel}: токен кладуть у карту в КОЖНОМУ обробнику видачі`, () => {
      const code = codeOf(rel);
      for (const fn of HANDLERS[rel]) {
        const at = code.indexOf(`async function ${fn}(`);
        expect(at, `обробник ${fn} не знайдено — пін осліп`).toBeGreaterThan(-1);
        const end = code.indexOf("\n  }", at);
        expect(end, `кінець ${fn} не знайдено — пін осліп`).toBeGreaterThan(at);
        const body = code.slice(at, end);
        expect(body, `${fn} не кладе токен із відповіді роута в карту`)
          .toMatch(/rememberToken\(\s*m\s*,\s*[^,]+,\s*data\.invite_token\s*\)/);
      }
      // «invite_token» як ПОЛЕ рядка списку більше не існує
      expect(code).not.toMatch(/\.referrer\.invite_token/);
      expect(code).not.toMatch(/\br\.invite_token\b/);
    });

    /* ⚠️ Знахідка ревʼю Б (M-1): карту можна ОБНУЛЯТИ в `reload()` — і дефект
       повертається цілком (посилання зникає через секунду після видачі, бо
       `reload()` смикається на кожен фокус вкладки), а всі піни вище лишаються
       зеленими. Тому єдине місце, де карті дозволено бути порожньою, — це
       ініціалізація стану. */
    it(`${rel}: карту токенів не обнуляють ніде, крім useState`, () => {
      const code = codeOf(rel);
      expect(code).toContain("useState<FreshTokens>(EMPTY_TOKENS)");
      const resets = code.match(/setFreshTokens\(\s*EMPTY_TOKENS\s*\)/g) || [];
      expect(resets.length, "карту токенів скидають викликом setFreshTokens(EMPTY_TOKENS) — reload() затре свіже посилання").toBe(0);
    });

    /* ⚠️ Знахідка ревʼю Б (M-3): шар РЕНДЕРУ не був запінений узагалі —
       підказку можна прибрати з JSX, лишивши константу імпортованою, і 28
       тестів лишались зеленими. Пінимо саме вузол: гілка `reissue` є, і
       `REISSUE_HINT` стоїть ДИТИНОЮ елемента, а не в атрибуті `title`. */
    it(`${rel}: підказку «перевидати» справді МАЛЮЮТЬ`, () => {
      const code = codeOf(rel);
      const branches = code.match(/hint\.kind === "reissue"/g) || [];
      expect(branches.length, "гілки reissue в рендері немає").toBe(1);
      expect(code, "REISSUE_HINT не є дитиною вузла (атрибут title не рахується)")
        .toMatch(/>\s*\{REISSUE_HINT\}\s*</);
    });
  }

  /* ⚠️ Пін саме у ВІДПОВІДІ роута. Перша редакція шукала `referrer_id:
     referrerId` будь-де у файлі — і стенд (позиція B6) її пробив: той самий
     текст є в `insert` у `referral_access`, тож прибирання поля з відповіді
     лишало тест зеленим. */
  it("роут запрошення направника повертає referrer_id — інакше карті нема ключа", () => {
    const code = codeOf("app/api/referrers/invite/route.ts");
    const resp = code.match(/return NextResponse\.json\(\{[^}]*\}\);\s*\}\s*$/);
    expect(resp, "фінальний NextResponse.json роута не знайдено — пін осліп").not.toBeNull();
    expect(resp![0]).toContain("referrer_id: referrerId");
    expect(resp![0]).toContain("invite_token: inviteToken");
  });

  it("CeoManager НЕ чіпаємо: він бере токен через security-definer RPC, а не з таблиці", () => {
    const code = codeOf("components/CeoManager.tsx");
    expect(code).toContain("ceo_list_for_clinic");
    expect(code).not.toMatch(/from\("profiles"\)/);
  });
});
