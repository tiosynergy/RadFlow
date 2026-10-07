/**
 * МАЙСТЕР /setup — РОЗКЛАДКА НА ВУЗЬКИХ ЕКРАНАХ (с83, Н-22(б)).
 *
 * ЩО ТРИМАЄ ЦЕЙ ФАЙЛ (піни на styles/prototype/radflow-wizard.css):
 *  • .wiz-main-inner має ЯВНУ ширину 100 %: у колонковому flex `margin: 0 auto`
 *    вимикає stretch, і без ширини елемент бере fit-content — тобто розпирається
 *    до min-content вмісту (ряд кабінету ≈360 px) і вилазить за колонку. Саме це
 *    с82 бачила як «хаб ширший за вʼюпорт» (на 744 px — 636 px при колонці 440);
 *  • стрічка кроків замість бічної колонки — з 680 px, а не з 480: у смузі
 *    481–680 бічні 304 px лишали формі 97–296 px (замір с83 у Chromium:
 *    зі стрічкою — 453–652 px, переповнення .wiz-main у смузі 0);
 *  • картка кабінету «апарат ‖ розклад» — у стовпець до 980 px: між 681 і 980
 *    колонка має 297–596 px, а ряд із фіксованим розкладом 320 px потребує ≈600
 *    (на 744–860 px поле назви стискалось до 0 px);
 *  • передумова коментаря біля `.wiz { … 1fr }`: .wiz-main лишається scroll
 *    container (overflow-y: auto) — лише тому `1fr` ≡ `minmax(0, 1fr)`.
 *
 * ЧОГО НЕ ТРИМАЄ: самих чисел заміру (їх дає харнес у Chromium, не vitest) і
 * вбудованих менеджерів (прайс, направники) — їхні таблиці ширші за колонку
 * незалежно від цього файлу (межа, названа в PR-доці с83).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const raw = readFileSync(resolve(process.cwd(), "styles/prototype/radflow-wizard.css"), "utf8");
/* Без коментарів: пін на КОД, а не на пояснення поруч (урок сторожів с46). */
const css = raw.replace(/\/\*[\s\S]*?\*\//g, " ");

/** Усі блоки `@media <умова> { … }` у порядку файлу, з дужками по рівнях. */
function mediaBlocks(text: string): Array<{ query: string; body: string; start: number }> {
  const out: Array<{ query: string; body: string; start: number }> = [];
  const re = /@media\s*([^{]+)\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < text.length && depth > 0) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      i++;
    }
    out.push({ query: m[1].trim(), body: text.slice(re.lastIndex, i - 1), start: m.index });
    re.lastIndex = i;
  }
  return out;
}
const blocks = mediaBlocks(css);
const byQuery = (q: string) => blocks.filter((b) => b.query === q);
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

describe("radflow-wizard.css — .wiz-main-inner має явну ширину (пастка fit-content у колонковому flex)", () => {
  it(".wiz-main — scroll container (передумова `1fr` ≡ `minmax(0, 1fr)` для .wiz)", () => {
    expect(css).toMatch(/\.wiz \{ display: grid; grid-template-columns: 304px 1fr; height: 100%; overflow: hidden; position: relative; \}/);
    expect(css).toMatch(/\.wiz-main \{ overflow-y: auto; height: 100%; display: flex; flex-direction: column;/);
  });
  it(".wiz-main-inner { width: 100%; max-width: 720px; margin: 0 auto; … }", () => {
    expect(css).toMatch(/\.wiz-main-inner \{ width: 100%; max-width: 720px; margin: 0 auto; padding: 40px 40px 120px; flex: 1 0 auto; \}/);
    // ніде нижче ширину не перебивають назад на auto/fit-content
    expect(css).not.toMatch(/\.wiz-main-inner \{[^}]*width: (auto|fit-content|max-content|min-content)/);
  });
});

describe("radflow-wizard.css — стрічка кроків із 680 px, не з 480", () => {
  const reflow = byQuery("(max-width: 680px)").filter((b) => /\.wiz\s*\{/.test(b.body));
  it("рівно один блок ≤680 перемикає .wiz на один стовпець, і він стоїть ПІСЛЯ базового .wiz", () => {
    expect(reflow).toHaveLength(1);
    expect(reflow[0].start).toBeGreaterThan(css.indexOf(".wiz { display: grid;"));
    const body = norm(reflow[0].body);
    expect(body).toContain(".wiz { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }");
    expect(body).toContain(".wiz-side { height: auto; min-width: 0; border-right: 0; border-bottom: 1px solid var(--border); overflow: hidden; }");
    expect(body).toContain(".wiz-main { min-width: 0; }");
    // стрічка прокручується всередині себе — сторінка лишається без 2D-прокрутки
    expect(body).toMatch(/\.wiz-steps \{ display: flex; gap: 4px; min-width: 0; overflow-x: auto; overflow-y: hidden;/);
    expect(body).toContain(".wstep-line, .wstep-desc { display: none; }");
    expect(body).toContain(".wiz-main-inner { padding: 20px 14px 96px; }");
  });
  it("жоден блок ≤480 більше не чіпає сітку .wiz / бічну колонку (старий поріг знято, не продубльовано)", () => {
    for (const b of byQuery("(max-width: 480px)")) {
      expect(b.body, "блок ≤480 містить правило .wiz").not.toMatch(/\.wiz\s*\{/);
      expect(b.body, "блок ≤480 містить правило .wiz-side").not.toMatch(/\.wiz-side\s*\{/);
      expect(b.body, "блок ≤480 містить правило .wiz-steps").not.toMatch(/\.wiz-steps\s*\{/);
    }
  });
  it("поля .reg-card у стовпець — як і в с82, з 680 (поріг не поїхав разом зі стрічкою)", () => {
    const card = byQuery("(max-width: 680px)").filter((b) => b.body.includes(".reg-card .fld-row"));
    expect(card).toHaveLength(1);
    expect(norm(card[0].body)).toContain(".reg-card .fld-row { flex-direction: column; }");
  });
});

describe("radflow-wizard.css — картка кабінету у стовпець до 980 px", () => {
  it("правило `.equip-block { flex-direction: column; }` живе в (max-width: 980px) і лише там", () => {
    const col = blocks.filter((b) => /\.equip-block \{ flex-direction: column; \}/.test(b.body));
    expect(col.map((b) => b.query)).toEqual(["(max-width: 980px)"]);
    const body = norm(col[0].body);
    expect(body).toContain(".equip-info { padding-right: 0; }");
    expect(body).toContain(".equip-sched { flex: 1; border-left: 0; padding-left: 0; border-top: 1px solid var(--border); padding-top: 10px; }");
    // базовий ряд: розклад фіксований, ліва половина стискається (min-width: 0) — саме тому потрібен стовпець
    expect(css).toMatch(/\.equip-sched \{ flex: 0 0 320px; min-width: 0;/);
    expect(css).toMatch(/\.equip-info \{ flex: 1; min-width: 0;/);
  });
});
