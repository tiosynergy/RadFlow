/* ===== с79 — Н-11 (права панель на ≤1240 px) і Н-12 (вертикальні відступи .topbar) =====
   Н-11. `@media (max-width: 1240px) { .rpanel { display: none } }` стояло ВИЩЕ
   базового `.rpanel { … display: flex … }` з тією ж специфічністю і програвало:
   на екранах ≤1240 px панель вилазила під списком випадковою смугою. Рішення
   власника (с79) — НЕ ховати, а зробити панель другим рядком під списком:
   календар, завантаженість, обдзвін, переноси й скасовані лишаються на планшеті
   біля апарата.
   Н-12. У `.topbar` окремі `padding-top/bottom: 4px` перебивав пізніший у тому ж
   правилі `padding: 0 22px`, а правила щільності ставили `padding: 0 14px/30px`:
   вертикаль 0, і в компактній щільності верх кільця фокуса «＋ Новий запис»
   виходив за верх екрана (y ≈ −3.7, WCAG 2.4.7).

   Піни — НЕ пошук підрядка, а маленький каскад: CSS розбирається на правила
   (з медіа-умовою й порядком), для кожного контексту (ширина × щільність ×
   тип вказівника) вибирається переможець за специфічністю, а за рівної — за
   порядком. Саме так програвало старе правило, тож саме так його й ловимо.
   ⚠️ Коментарі вирізаються ДО розбору: пін, який може задовольнити коментар, —
   неправда (у коментарях ці властивості згадано навмисно).
   ⚠️ Селектор, що бере цільовий елемент, але якого розбір не розуміє
   (`.content-wrap > .rpanel`, `.rpanel:hover`, …), валить тест із назвою —
   мовчки пропустити його означало б рахувати каскад без нього.

   Замір у Chromium (реальні файли CSS, скелет /queue і /radiologist, 13 вікон ×
   3 щільності) — у звіті с79; ці тести його НЕ замінюють, вони тримають
   правило від тихого повернення. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* Порядок — як на сторінці: /queue вантажить radflow.css → radflow-screens.css,
   /radiologist ще й radiologist.css. Правило з пізнішого файла б'є рівне раннє. */
const FILES = ["styles/prototype/radflow.css", "styles/prototype/radflow-screens.css", "styles/prototype/radiologist.css"];

type Decl = [prop: string, value: string, important: boolean];
type Rule = { sels: string[]; decls: Decl[]; media: string | null; order: number; file: string };
type Ctx = { w: number; density: "compact" | "comfortable" | "spacious"; coarse: boolean };

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

function parseDecls(body: string): Decl[] {
  const out: Decl[] = [];
  let depth = 0, cur = "";
  for (const ch of body + ";") {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === ";" && depth === 0) {
      const i = cur.indexOf(":");
      if (i > 0) {
        const raw = cur.slice(i + 1).trim();
        const important = /!\s*important$/i.test(raw);
        out.push([cur.slice(0, i).trim().toLowerCase(), raw.replace(/\s*!\s*important$/i, "").replace(/\s+/g, " "), important]);
      }
      cur = "";
    } else cur += ch;
  }
  return out;
}

function parseCss(files: string[]): Rule[] {
  const rules: Rule[] = [];
  let order = 0;
  for (const file of files) {
    const src = stripComments(readFileSync(join(process.cwd(), file), "utf8"));
    const close = (open: number) => {
      let d = 0;
      for (let j = open; j < src.length; j++) {
        if (src[j] === "{") d++;
        else if (src[j] === "}" && --d === 0) return j;
      }
      throw new Error(`${file}: незбалансовані дужки від позиції ${open}`);
    };
    const walk = (from: number, to: number, media: string | null) => {
      let k = from;
      for (;;) {
        const open = src.indexOf("{", k);
        if (open < 0 || open >= to) return;
        const prelude = src.slice(k, open).trim();
        const end = close(open);
        if (prelude.startsWith("@media")) {
          if (media) throw new Error(`${file}: вкладений @media — розширте розбір`);
          walk(open + 1, end, prelude.slice(6).trim());
        } else if (prelude.startsWith("@keyframes")) {
          // кадри анімацій — не правила елементів
        } else if (prelude.startsWith("@")) {
          throw new Error(`${file}: невідоме at-правило «${prelude.slice(0, 40)}» — розширте розбір`);
        } else {
          rules.push({ sels: prelude.split(",").map((s) => s.trim().replace(/\s+/g, " ")), decls: parseDecls(src.slice(open + 1, end)), media, order: order++, file });
        }
        k = end + 1;
      }
    };
    walk(0, src.length, null);
  }
  return rules;
}

/** Медіа-умова в контексті: ширина вікна і тип вказівника. Невідома ознака → помилка. */
function mediaApplies(media: string | null, ctx: Ctx): boolean {
  if (!media) return true;
  return media.split(/\s+and\s+/).every((part) => {
    const m = part.trim().match(/^\(\s*([a-z-]+)\s*:\s*([^)]+?)\s*\)$/);
    if (!m) throw new Error(`невідома медіа-умова «${media}»`);
    const [, feat, val] = m;
    if (feat === "max-width") return ctx.w <= parseFloat(val);
    if (feat === "min-width") return ctx.w >= parseFloat(val);
    if (feat === "pointer") return (val === "coarse") === ctx.coarse;
    if (feat === "prefers-reduced-motion") return false;
    throw new Error(`невідома медіа-ознака «${feat}» у «${media}»`);
  });
}

/** Чи бере селектор САМ елемент з класом cls у цьому контексті; повертає специфічність.
 *  Розуміємо рівно дві форми: `.cls` і `html[data-density="…"] .cls` (плюс `*`). */
function selects(sel: string, cls: string, ctx: Ctx): Spec | null {
  if (sel === "*") return [0, 0, 0];
  const parts = sel.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
  const last = parts[parts.length - 1];
  if (!new RegExp(`\\.${cls}(?![-\\w])`).test(last)) {
    // `.content-wrap > *`, `.main aside` — беруть елемент оболонки, не називаючи його класу
    if (/^(\*|[a-z]+)(?=$|[:[])/.test(last) && parts.slice(0, -1).some((p) => /\.(app|main|content-wrap)(?![-\w])/.test(p)))
      throw new Error(`селектор «${sel}» може брати елемент оболонки (.${cls}) — розширте пін`);
    return null;                                                            // бере інший елемент
  }
  if (last !== "." + cls) throw new Error(`селектор «${sel}» бере .${cls}, але розбір його не розуміє — розширте пін`);
  const anc = parts.slice(0, -1);
  if (anc.length === 0) return [0, 1, 0];
  const d = anc.length === 1 && anc[0].match(/^html\[data-density="(compact|comfortable|spacious)"\]$/);
  if (!d) throw new Error(`селектор «${sel}» бере .${cls}, але розбір його не розуміє — розширте пін`);
  return d[1] === ctx.density ? [0, 2, 1] : null;
}

const SIDES = ["top", "right", "bottom", "left"] as const;
/** Розгортає шорткати, які стосуються пінів, у довгі властивості. */
function longhands(prop: string, val: string): [string, string][] {
  if (prop === "padding") {
    const v = val.split(" ");
    const [t, r = t, b = t, l = r] = v;
    return [["padding-top", t], ["padding-right", r], ["padding-bottom", b], ["padding-left", l]];
  }
  if (prop === "border") return SIDES.map((s) => [`border-${s}`, val] as [string, string]);
  if (prop === "overflow") { const [x, y = x] = val.split(" "); return [["overflow-x", x], ["overflow-y", y]]; }
  return [[prop, val]];
}

type Spec = [number, number, number];
const cmpSpec = (a: Spec, b: Spec) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Переможець каскаду для властивості елемента .cls у контексті: вища специфічність,
 *  за рівної — пізніша декларація. Правила обходимо в порядку джерела (файли — у
 *  порядку підключення), декларації — в порядку в правилі, тож «пізніша» = та, що
 *  трапилась останньою. ⚠️ Саме «пізніше в ТОМУ Ж правилі» і було вадою Н-12
 *  (`padding: 0 22px` після `padding-top: 4px`) — перша редакція цього резолвера
 *  рахувала переможцем першу декларацію правила, і фальсифікація це зловила. */
function computed(rules: Rule[], cls: string, prop: string, ctx: Ctx): string | undefined {
  let best: { spec: Spec; val: string } | undefined;
  for (const r of rules) {
    if (!mediaApplies(r.media, ctx)) continue;
    let spec: Spec | null = null;
    for (const s of r.sels) {
      const sp = selects(s, cls, ctx);
      if (sp && (!spec || cmpSpec(sp, spec) > 0)) spec = sp;
    }
    if (!spec) continue;
    for (const [p, v, important] of r.decls) for (const [lp, lv] of longhands(p, v)) {
      if (lp !== prop) continue;
      if (important) throw new Error(`${r.file}: «${r.sels.join(", ")} { ${p}: … !important }» — розбір !important не рахує, розширте пін`);
      if (!best || cmpSpec(spec, best.spec) >= 0) best = { spec, val: lv };
    }
  }
  return best?.val;
}

const DENSITIES = ["compact", "comfortable", "spacious"] as const;
const contexts = (widths: number[]): Ctx[] =>
  widths.flatMap((w) => DENSITIES.flatMap((density) => [false, true].map((coarse) => ({ w, density, coarse }))));
const label = (c: Ctx) => `${c.w}px/${c.density}${c.coarse ? "/дотик" : ""}`;

describe("с79 — права панель на планшеті (Н-11) і відступи шапки (Н-12)", () => {
  const rules = parseCss(FILES);

  it("Н-11: на ≤1240 px .rpanel не ховається, а стає другим рядком під списком — і медіа-правило реально перемагає базове (порядок + специфічність)", () => {
    const bad: string[] = [];
    for (const c of contexts([1240, 1200, 1024, 800, 768, 481, 480, 375, 320])) {
      const v = (cls: string, p: string) => computed(rules, cls, p, c);
      const disp = v("rpanel", "display");
      if (disp !== "grid") bad.push(`${label(c)}: .rpanel display = ${disp} (очікується grid — друга рядок, а не display:none і не програш базовому flex)`);
      const cols = v("content-wrap", "grid-template-columns");
      if (cols !== "minmax(0, 1fr)") bad.push(`${label(c)}: .content-wrap columns = ${cols}`);
      const rows = v("content-wrap", "grid-template-rows") ?? "";
      const m = rows.match(/^minmax\(0, 1fr\) fit-content\((\d+(?:\.\d+)?)%\)$/);
      // список — перший рядок і забирає решту; панель — за вмістом, але не вище 45% (список ≥55%)
      if (!m || parseFloat(m[1]) > 45) bad.push(`${label(c)}: .content-wrap rows = «${rows}» (очікується minmax(0, 1fr) fit-content(≤45%))`);
      const gtc = v("rpanel", "grid-template-columns") ?? "";
      if (!/^repeat\(auto-fill, minmax\(min\(100%, \d+(?:\.\d+)?rem\), 1fr\)\)$/.test(gtc)) bad.push(`${label(c)}: .rpanel columns = «${gtc}» (секції колонками в ширину, min(100%, …) — без переповнення)`);
      if (!/^0(px)?$|^none$/.test(v("rpanel", "border-left") ?? "")) bad.push(`${label(c)}: .rpanel border-left = ${v("rpanel", "border-left")} (у рядку — розділювач зверху, не зліва)`);
      if (!/^1px solid /.test(v("rpanel", "border-top") ?? "")) bad.push(`${label(c)}: .rpanel border-top = ${v("rpanel", "border-top")}`);
      // с78: панель прокрутки лишається containing block і не передає прокрутку сторінці
      if (v("rpanel", "position") !== "relative") bad.push(`${label(c)}: .rpanel position = ${v("rpanel", "position")}`);
      if (v("rpanel", "overscroll-behavior-y") !== "contain") bad.push(`${label(c)}: .rpanel overscroll-behavior-y = ${v("rpanel", "overscroll-behavior-y")}`);
      if (v("rpanel", "overflow-y") !== "auto") bad.push(`${label(c)}: .rpanel overflow-y = ${v("rpanel", "overflow-y")}`);
    }
    expect(bad).toEqual([]);
  });

  it("Н-11: на >1240 px розкладка та сама, що до с79 — панель праворуч 320 px, flex-стовпець із лівою межею", () => {
    const bad: string[] = [];
    for (const c of contexts([1920, 1600, 1280, 1241])) {
      const v = (cls: string, p: string) => computed(rules, cls, p, c);
      if (v("content-wrap", "grid-template-columns") !== "1fr 320px") bad.push(`${label(c)}: .content-wrap columns = ${v("content-wrap", "grid-template-columns")}`);
      if (v("content-wrap", "grid-template-rows") !== undefined) bad.push(`${label(c)}: .content-wrap rows = ${v("content-wrap", "grid-template-rows")}`);
      if (v("rpanel", "display") !== "flex") bad.push(`${label(c)}: .rpanel display = ${v("rpanel", "display")}`);
      if (v("rpanel", "flex-direction") !== "column") bad.push(`${label(c)}: .rpanel flex-direction = ${v("rpanel", "flex-direction")}`);
      if (v("rpanel", "border-left") !== "1px solid var(--border)") bad.push(`${label(c)}: .rpanel border-left = ${v("rpanel", "border-left")}`);
    }
    expect(bad).toEqual([]);
  });

  it("Н-12: вертикальний відступ .topbar — 4px у базі, в обох щільностях і на вузьких екранах (кільце фокуса кнопок шапки не виходить за екран)", () => {
    const bad: string[] = [];
    for (const c of contexts([1600, 1240, 800, 480, 375, 320])) {
      for (const p of ["padding-top", "padding-bottom"]) {
        const val = computed(rules, "topbar", p, c);
        if (val !== "4px") bad.push(`${label(c)}: .topbar ${p} = ${val}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
