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
      /* Ревʼю А с59 (пакет 38): пін на ЛІТЕРАЛ обходиться `setFreshTokens({})`
         чи `setFreshTokens(() => EMPTY_TOKENS)` у reload(). Тому додатково: у
         тілі reload() — жодного setFreshTokens, а всі оновлення — функціональні. */
      const at = code.indexOf("const reload = useCallback(");
      const end = code.indexOf("}, [clinicId]);", at);
      expect(at, "reload не знайдено — пін осліп").toBeGreaterThan(-1);
      expect(end, "кінець reload не знайдено — пін осліп").toBeGreaterThan(at);
      expect(code.slice(at, end), "reload() чіпає карту токенів").not.toMatch(/setFreshTokens\(/);
      const calls = code.match(/setFreshTokens\([^;\n]*/g) || [];
      expect(calls.length, "жодного оновлення карти — пін осліп").toBeGreaterThan(0);
      for (const c of calls) expect(c, "карту оновлюють не через (m) => …").toMatch(/^setFreshTokens\(\s*\(m\)\s*=>/);
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

  /* ⚠️ Пакет 37 лишив CeoManager «як є», бо він читає список через
     security-definer RPC. Пакет 38 (0179) закрив саме цей канал (RF-09b): RPC
     більше не віддає токен нікому, і екран мусить жити за тим самим правилом,
     що й два інші, — токен лише з відповіді роута видачі. */
  it("CeoManager: список — через RPC, до profiles напряму не ходить", () => {
    const code = codeOf("components/CeoManager.tsx");
    expect(code).toContain("ceo_list_for_clinic");
    expect(code).not.toMatch(/from\("profiles"\)/);
  });
});

/* ⚠️ Ревʼю А (с59): піни нижче першої редакції були ПО ПРИСУТНОСТІ, а не по
   місцю — закоментований виклик, виклик у гілці помилки перед `return`, або
   `return null` перед вузлом підказки лишали все зеленим. Тому: (1) коментарі
   стрипаються ДО матчу; (2) виклик шукається у ВІКНІ успішного шляху, а не
   будь-де в обробнику; (3) між гілкою `reissue` і вузлом не сміє стояти ані
   `return`, ані `hidden`. Названа межа: це все ще текст, не DOM (Р4). */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const bodyOf = (code: string, fn: string) => {
  const at = code.indexOf(`async function ${fn}(`);
  expect(at, `обробник ${fn} не знайдено — пін осліп`).toBeGreaterThan(-1);
  const end = code.indexOf("\n  }", at);
  expect(end, `кінець ${fn} не знайдено — пін осліп`).toBeGreaterThan(at);
  return code.slice(at, end);
};

describe("RF-09b — CeoManager живе за тим самим правилом, що й два інші екрани", () => {
  const rel = "components/CeoManager.tsx";

  it("токен кладуть у карту в КОЖНОМУ обробнику видачі (grant, resetPassword) — на УСПІШНОМУ шляху", () => {
    const code = stripComments(codeOf(rel));
    /* grant: вікно між `setForm(EMPTY)` (перший рядок після перевірки res.ok)
       і `reload()` — виклик у гілці `if (!res.ok)` сюди не потрапляє. Ключ
       карти — саме `ceo_id` з відповіді: інший ключ (login, created_account)
       дасть карту, з якої inviteHint ніколи нічого не візьме. */
    const g = bodyOf(code, "grant");
    const gWin = g.slice(g.indexOf("setForm(EMPTY)"), g.indexOf("reload()"));
    expect(gWin.length, "вікно успішного шляху grant не знайдено — пін осліп").toBeGreaterThan(20);
    expect(gWin).toMatch(/setFreshTokens\(\s*\(m\)\s*=>\s*rememberToken\(\s*m\s*,\s*data\.ceo_id\s*,\s*data\.invite_token\s*\)\s*\)/);
    /* resetPassword: від оптимістичного `setCeos(` (перший рядок ПІСЛЯ гілки
       помилки) до фінального notify */
    const r = bodyOf(code, "resetPassword");
    const rWin = r.slice(r.indexOf("setCeos("), r.lastIndexOf("notify("));
    expect(rWin.length, "вікно успішного шляху resetPassword не знайдено — пін осліп").toBeGreaterThan(20);
    expect(rWin).toMatch(/setFreshTokens\(\s*\(m\)\s*=>\s*rememberToken\(\s*m\s*,\s*id\s*,\s*data\.invite_token\s*\)\s*\)/);
    expect(rWin).not.toMatch(/if\s*\(\s*false\s*\)/);
  });

  it("«invite_token» як поле рядка списку більше не існує — тип Ceo без нього", () => {
    const code = codeOf(rel);
    expect(code).not.toMatch(/\br\.invite_token\b/);
    const typeDecl = code.match(/type Ceo = \{[\s\S]*?\};/);
    expect(typeDecl, "тип Ceo не знайдено — пін осліп").not.toBeNull();
    expect(typeDecl![0]).not.toContain("invite_token");
  });

  it("карту токенів не обнуляють ніде, крім useState — і reload() її НЕ ЧІПАЄ", () => {
    const code = stripComments(codeOf(rel));
    expect(code).toContain("useState<FreshTokens>(EMPTY_TOKENS)");
    /* Ревʼю А/Б: пін на літерал `EMPTY_TOKENS` обходився `setFreshTokens({})`
       чи `setFreshTokens(() => EMPTY_TOKENS)`. Тому: у тілі reload() — ЖОДНОГО
       setFreshTokens, а поза ним — лише функціональні оновлення карти. */
    const at = code.indexOf("const reload = useCallback(");
    const end = code.indexOf("}, [clinicId]);", at);
    expect(at, "reload не знайдено — пін осліп").toBeGreaterThan(-1);
    expect(end, "кінець reload не знайдено — пін осліп").toBeGreaterThan(at);
    expect(code.slice(at, end)).not.toMatch(/setFreshTokens\(/);
    const calls = code.match(/setFreshTokens\([^;\n]*/g) || [];
    expect(calls.length, "жодного оновлення карти — пін осліп").toBeGreaterThan(0);
    for (const c of calls) expect(c, "карту оновлюють не через (m) => …").toMatch(/^setFreshTokens\(\s*\(m\)\s*=>/);
  });

  it("підказку «перевидати» справді МАЛЮЮТЬ, і «Скопіювати» бере токен з hint, а не з рядка", () => {
    const code = stripComments(codeOf(rel));
    const branches = code.match(/hint\.kind === "reissue"/g) || [];
    expect(branches.length, "гілки reissue в рендері немає").toBe(1);
    /* Вузол — між гілкою і `}` її блоку: без `return null`, без `hidden`,
       текст — ДИТИНА елемента, і для CEO-only це саме REISSUE_HINT. */
    const at = code.indexOf('hint.kind === "reissue"');
    const block = code.slice(at, code.indexOf("\n                  }", at));
    expect(block, "між гілкою reissue і вузлом стоїть return/hidden").not.toMatch(/return\s+null|hidden/);
    expect(block, "REISSUE_HINT не є дитиною вузла (атрибут title не рахується)")
      .toMatch(/>\s*\{r\.role === "ceo" \? REISSUE_HINT : FOREIGN_ROLE_HINT\}\s*</);
    expect(code).toMatch(/copyLink\(hint\.token\)/);
  });

  it("крос-рольовий без пароля НЕ отримує поради «Скинути пароль» (роут відповів би 403)", () => {
    const code = codeOf(rel);
    expect(code).toMatch(/const FOREIGN_ROLE_HINT =\s*"[^"]*адміністратор того центру[^"]*"/);
    expect(code).not.toMatch(/FOREIGN_ROLE_HINT =\s*"[^"]*Скинути пароль/);
    // і тост після grant розгалужений за роллю з відповіді
    const g = stripComments(bodyOf(codeOf(rel), "grant"));
    expect(g).toMatch(/data\.role === "ceo"/);
    expect(g).toMatch(/адміністратор його центру/);
  });

  it("токен забувають там, де сервер його гасить: set / revoke / delete", () => {
    const code = stripComments(codeOf(rel));
    for (const fn of ["submitPassword", "revoke", "deleteCeo"]) {
      const body = bodyOf(code, fn);
      // після гілки помилки (`if (!res.ok)`) і ДО notify — на успішному шляху
      const win = body.slice(body.indexOf("if (!res.ok)"), body.lastIndexOf("notify("));
      expect(win, `${fn} не забуває токен на успішному шляху`).toMatch(/setFreshTokens\(\s*\(m\)\s*=>\s*forgetToken\(/);
    }
  });

  /* Пін у ВІДПОВІДІ роута (урок B6 пакета 37): `ceo_id` — ключ карти на
     екрані; без нього токен нового акаунта нема куди покласти. Поведінка
     самого роута (RF-09d) — у tests/ceoGrantRoute.test.ts, не тут. */
  it("роут /api/ceo/grant повертає ceo_id та invite_token у фінальній відповіді", () => {
    const code = codeOf("app/api/ceo/grant/route.ts");
    const resp = code.match(/return NextResponse\.json\(\{[^}]*\}\);\s*\}\s*$/);
    expect(resp, "фінальний NextResponse.json роута не знайдено — пін осліп").not.toBeNull();
    expect(resp![0]).toContain("ceo_id: ceoId");
    expect(resp![0]).toContain("invite_token: inviteToken");
  });
});
