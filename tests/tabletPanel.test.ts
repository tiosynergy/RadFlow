/* ===== с79 — Н-11 (права панель на ≤1240 px), Н-12 (вертикальні відступи .topbar),
   Н-13 (≤480 px: «☰» не закриває заголовок шапки) =====
   Н-11. `@media (max-width: 1240px) { .rpanel { display: none } }` стояло ВИЩЕ
   базового `.rpanel { … display: flex … }` з тією ж специфічністю і програвало.
   Рішення власника (с79) — НЕ ховати, а зробити панель другим рядком під
   списком: `1fr fit-content(40%)`, панель зі своєю прокруткою.
   Н-12. У `.topbar` пізніший `padding: 0 22px` обнуляв `padding-top/bottom: 4px`
   того ж правила; у compact верх кільця фокуса «＋ Новий запис» був на y ≈ −3.7.
   Н-13. На ≤480 px правила щільності (0,2,1) перебивали мобільне
   `.topbar { padding-left: 3.5rem }` (0,1,0), і фіксована «☰» лягала на заголовок.

   Як перевіряємо — маленький КАСКАД, а не пошук підрядка:
   • CSS чотирьох файлів розбирається на правила з медіа-умовою і порядком;
     ⚠️ коментарі вирізаються ДО розбору — пін, який може задовольнити коментар,
     — неправда;
   • селектори звіряються з МОДЕЛЛЮ оболонки (теги, класи, атрибути, предки,
     попередні сусіди — див. shell() і тест «модель звірена з TSX»), тож
     `aside:not(.sidebar)`, `[class="rpanel"]`, `.content-wrap > aside` рахуються
     так само, як їх рахує браузер; псевдоелемент (`::-webkit-scrollbar`) не бере
     сам елемент;
   • контексти — усі межі медіа-умов із файлів (b−1, b, b+1) × щільність ×
     тип вказівника × prefers-reduced-motion;
   • шорткати розгортаються (padding/-block/-inline, border*, inset*, overflow,
     overscroll-behavior, grid, grid-template, grid-area/-row/-column, логічні
     розміри, `all`), значення нормалізуються (`minmax(0,1fr)` = `minmax(0, 1fr)`).
   Чого розбір не розуміє, про те ПАДАЄ з назвою, а не мовчить: селектор, що
   «може» взяти ціль (стан :hover, структурні псевдокласи, :has) і оголошує
   пінену властивість; `!important` на ній; медіа-ознака, одиниця (лише px) чи
   at-правило, яких немає в розборі.

   Замір у Chromium (реальні файли CSS, скелети /queue, /radiologist та інших
   екранів) — у звіті с79; ці тести його НЕ замінюють, вони тримають правила
   від тихого повернення. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/* Порядок — як у документі: /queue вантажить radflow.css → radflow-screens.css,
   /radiologist ще й radiologist.css. radflow-wizard.css імпортує лише SetupWizard,
   але Next не вивантажує CSS при клієнтському переході: після /setup → /queue він
   лишається в документі, причому ПІЗНІШЕ за стилі дошки — тому він тут останнім. */
const FILES = ["styles/prototype/radflow.css", "styles/prototype/radflow-screens.css", "styles/prototype/radiologist.css", "styles/prototype/radflow-wizard.css"];

type Tri = 0 | 1 | 2; // ні / можливо / так
const AND = (a: Tri, b: Tri): Tri => (a === 0 || b === 0 ? 0 : a === 1 || b === 1 ? 1 : 2);
const OR = (a: Tri, b: Tri): Tri => (a === 2 || b === 2 ? 2 : a === 1 || b === 1 ? 1 : 0);
type Spec = [number, number, number];
const cmpSpec = (a: Spec, b: Spec) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const addSpec = (a: Spec, b: Spec): Spec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const maxSpec = (xs: Spec[]): Spec => xs.reduce((m, s) => (cmpSpec(s, m) > 0 ? s : m), [0, 0, 0] as Spec);

/* ---------- розбір CSS ---------- */

type Decl = { prop: string; value: string; important: boolean };
type Rule = { sels: Complex[]; selText: string; decls: Decl[]; media: string | null; order: number; file: string };

/** Ділить рядок за роздільником верхнього рівня (поза дужками й лапками). */
function splitTop(s: string, sep: (ch: string) => boolean): string[] {
  const out: string[] = [];
  let depth = 0, q: string | null = null, cur = "";
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (depth === 0 && sep(ch)) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Нормалізація значення: регістр, пробіли навколо ком і дужок. */
const canon = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ").replace(/\s*,\s*/g, ",").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");

function parseCss(files: string[]): Rule[] {
  const rules: Rule[] = [];
  let order = 0;
  for (const file of files) {
    const src = read(file).replace(/\/\*[\s\S]*?\*\//g, "");
    if (src.includes("\\")) throw new Error(`${file}: екранування в CSS розбір не підтримує — розширте пін`);
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
        if (/^@media\b/.test(prelude)) {
          if (media) throw new Error(`${file}: вкладений @media — розширте розбір`);
          walk(open + 1, end, prelude.slice(6).trim());
        } else if (/^@(-webkit-)?keyframes\b/.test(prelude)) {
          // кадри анімацій — не правила елементів
        } else if (prelude.startsWith("@")) {
          throw new Error(`${file}: at-правило «${prelude.slice(0, 40)}» розбір не знає — розширте пін`);
        } else {
          const decls = splitTop(src.slice(open + 1, end), (c) => c === ";").map((d) => {
            const i = d.indexOf(":");
            if (i < 0) return null;
            const raw = d.slice(i + 1).trim();
            return { prop: d.slice(0, i).trim().toLowerCase(), value: raw.replace(/\s*!\s*important$/i, ""), important: /!\s*important$/i.test(raw) };
          }).filter((d): d is Decl => !!d && !!d.prop);
          rules.push({ sels: splitTop(prelude, (c) => c === ",").map((s) => parseComplex(s.trim())), selText: prelude.replace(/\s+/g, " "), decls, media, order: order++, file });
        }
        k = end + 1;
      }
    };
    walk(0, src.length, null);
  }
  return rules;
}

/* ---------- селектори ---------- */

type Attr = { name: string; op: string | null; value: string; ci: boolean };
type Pseudo = { name: string; args: Complex[] | null; raw: string | null };
type Compound = { type: string | null; id: string | null; classes: string[]; attrs: Attr[]; pseudos: Pseudo[]; pseudoEl: boolean };
type Complex = { parts: { comb: string; c: Compound }[]; text: string; spec: Spec };

const IDENT = /^-?[_a-zA-Z -￿][-_a-zA-Z0-9 -￿]*/;
const LIST_PSEUDO = new Set(["not", "is", "where", "matches", "-webkit-any", "has"]);
const LEGACY_PSEUDO_EL = new Set(["before", "after", "first-line", "first-letter"]);

function parseCompound(s: string, whole: string): Compound {
  const c: Compound = { type: null, id: null, classes: [], attrs: [], pseudos: [], pseudoEl: false };
  let i = 0;
  const ident = () => { const m = s.slice(i).match(IDENT); if (!m) throw new Error(`селектор «${whole}»: не розібрано «${s.slice(i)}»`); i += m[0].length; return m[0]; };
  const group = (open: string, closeCh: string) => { // від open до відповідної закривної, з урахуванням вкладеності
    let d = 0, q: string | null = null;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (q) { if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; continue; }
      if (ch === open) d++;
      else if (ch === closeCh && --d === 0) { const inner = s.slice(i + 1, j); i = j + 1; return inner; }
    }
    throw new Error(`селектор «${whole}»: незакрита «${open}»`);
  };
  if (s[i] === "*") { c.type = "*"; i++; } else if (IDENT.test(s)) c.type = ident().toLowerCase();
  while (i < s.length) {
    const ch = s[i];
    if (ch === ".") { i++; c.classes.push(ident()); }
    else if (ch === "#") { i++; c.id = ident(); }
    else if (ch === "[") {
      const inner = group("[", "]").trim();
      const m = inner.match(/^([-\w]+)\s*(?:([~|^$*]?=)\s*("([^"]*)"|'([^']*)'|[^\s\]]+)\s*([is])?)?$/i);
      if (!m) throw new Error(`селектор «${whole}»: атрибут «${inner}» не розібрано`);
      c.attrs.push({ name: m[1].toLowerCase(), op: m[2] || null, value: m[4] ?? m[5] ?? m[3] ?? "", ci: (m[6] || "").toLowerCase() === "i" });
    } else if (ch === ":") {
      const el = s[i + 1] === ":";
      i += el ? 2 : 1;
      const name = ident().toLowerCase();
      const args = s[i] === "(" ? group("(", ")") : null;
      if (el || LEGACY_PSEUDO_EL.has(name)) c.pseudoEl = true;
      else c.pseudos.push({ name, args: args !== null && LIST_PSEUDO.has(name) ? splitTop(args, (x) => x === ",").map((a) => parseComplex(a.trim())) : null, raw: args });
    } else throw new Error(`селектор «${whole}»: не розібрано «${s.slice(i)}»`);
  }
  return c;
}

function compoundSpec(c: Compound): Spec {
  let s: Spec = [c.id ? 1 : 0, c.classes.length + c.attrs.length, c.type && c.type !== "*" ? 1 : 0];
  if (c.pseudoEl) s = addSpec(s, [0, 0, 1]);
  for (const p of c.pseudos) {
    if (p.name === "where") continue;
    s = addSpec(s, p.args ? maxSpec(p.args.map((a) => a.spec)) : [0, 1, 0]);
  }
  return s;
}

function parseComplex(text: string): Complex {
  // Комбінатори — лише на верхньому рівні: `~=` в атрибуті й `2n+1` у :nth-child — усередині дужок.
  const parts: { comb: string; c: Compound }[] = [];
  let cur = "", pending: string | null = null, depth = 0, q: string | null = null;
  const flush = () => { if (!cur) return; parts.push({ comb: parts.length ? pending ?? " " : " ", c: parseCompound(cur, text) }); cur = ""; pending = null; };
  for (const ch of text) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (depth === 0 && /\s/.test(ch)) { if (cur) { flush(); pending = " "; } continue; }
    if (depth === 0 && (ch === ">" || ch === "+" || ch === "~")) { flush(); pending = ch; continue; }
    cur += ch;
  }
  flush();
  if (!parts.length) throw new Error(`порожній селектор у «${text}»`);
  return { parts, text, spec: parts.reduce((s, p) => addSpec(s, compoundSpec(p.c)), [0, 0, 0] as Spec) };
}

/* ---------- модель оболонки (див. тест «модель звірена з TSX») ---------- */

type El = { tag: string; id: string | null; cls: string[]; attrs: Record<string, string>; parent: El | null; prev: El[] };
type Density = "compact" | "comfortable" | "spacious";

function shell(density: Density) {
  const el = (tag: string, cls: string[], attrs: Record<string, string>, parent: El | null, prev: El[], id: string | null = null): El => ({ tag, id, cls, attrs, parent, prev });
  const html = el("html", [], { lang: "uk", "data-density": density }, null, []);
  const head = el("head", [], {}, html, []);
  const body = el("body", [], {}, html, [head]);
  const script = el("script", [], {}, body, []);
  const app = el("div", ["app"], {}, body, [script]);
  const nav = el("button", ["rf-navtoggle"], { type: "button", "aria-label": "Відкрити меню", "aria-expanded": "false", "aria-controls": "rf-nav" }, app, []);
  const scrim = el("div", ["rf-nav-scrim"], { "aria-hidden": "true" }, app, [nav]);
  const sidebar = el("aside", ["sidebar"], {}, app, [scrim, nav], "rf-nav");
  const main = el("div", ["main"], {}, app, [sidebar, scrim, nav]);
  const topbar = el("header", ["topbar"], {}, main, []);
  const wrap = el("div", ["content-wrap"], {}, main, [topbar]);
  const content = el("div", ["content"], {}, wrap, []);
  const rpanel = el("aside", ["rpanel"], {}, wrap, [content]);
  return { "content-wrap": wrap, content, rpanel, topbar, "rf-navtoggle": nav } as Record<string, El>;
}

function attrOf(el: El, name: string): string | undefined {
  if (name === "class") return el.cls.length ? el.cls.join(" ") : undefined;
  if (name === "id") return el.id ?? undefined;
  return el.attrs[name];
}

function matchAttr(a: Attr, el: El): Tri {
  let v = attrOf(el, a.name);
  if (v === undefined) return 0;
  if (!a.op) return 2;
  let w = a.value;
  if (a.ci) { v = v.toLowerCase(); w = w.toLowerCase(); }
  const ok = a.op === "=" ? v === w : a.op === "~=" ? v.split(/\s+/).includes(w) : a.op === "|=" ? v === w || v.startsWith(w + "-")
    : a.op === "^=" ? w !== "" && v.startsWith(w) : a.op === "$=" ? w !== "" && v.endsWith(w) : w !== "" && v.includes(w);
  return ok ? 2 : 0;
}

function matchCompound(c: Compound, el: El): Tri {
  if (c.pseudoEl) return 0;                                   // стилізує псевдоелемент, а не сам елемент
  if (c.type && c.type !== "*" && c.type !== el.tag) return 0;
  if (c.id && c.id !== el.id) return 0;
  for (const k of c.classes) if (!el.cls.includes(k)) return 0;
  let r: Tri = 2;
  for (const a of c.attrs) if ((r = AND(r, matchAttr(a, el))) === 0) return 0;
  for (const p of c.pseudos) {
    let t: Tri;
    if (p.name === "root") t = el.tag === "html" ? 2 : 0;
    else if (p.name === "not" && p.args) { const any = p.args.reduce<Tri>((m, a) => OR(m, matchComplex(a, el)), 0); t = any === 2 ? 0 : any === 0 ? 2 : 1; }
    else if (p.name === "has") t = 1;
    else if (p.args) t = p.args.reduce<Tri>((m, a) => OR(m, matchComplex(a, el)), 0);   // :is / :where / :matches
    else t = 1;                                               // стан (:hover, :focus…) чи структура (:first-child…) — «можливо»
    if ((r = AND(r, t)) === 0) return 0;
  }
  return r;
}

function matchComplex(x: Complex, el: El, idx = x.parts.length - 1): Tri {
  const here = matchCompound(x.parts[idx].c, el);
  if (here === 0 || idx === 0) return here;
  const comb = x.parts[idx].comb;
  let rest: Tri = 0;
  if (comb === ">") rest = el.parent ? matchComplex(x, el.parent, idx - 1) : 0;
  else if (comb === " ") for (let a = el.parent; a && rest !== 2; a = a.parent) rest = OR(rest, matchComplex(x, a, idx - 1));
  else if (comb === "+") rest = el.prev[0] ? matchComplex(x, el.prev[0], idx - 1) : 0;
  else for (const s of el.prev) rest = OR(rest, matchComplex(x, s, idx - 1)); // "~"
  return AND(here, rest);
}

/* ---------- медіа-умови ---------- */

type Ctx = { w: number; density: Density; coarse: boolean; reduce: boolean };

const px = (v: string, media: string): number => {
  const m = v.trim().match(/^(\d+(?:\.\d+)?)px$/);
  if (!m) throw new Error(`медіа «${media}»: «${v}» — у медіа-умовах пін розуміє лише px`);
  return parseFloat(m[1]);
};
const CMP: Record<string, (a: number, b: number) => boolean> = { "<": (a, b) => a < b, "<=": (a, b) => a <= b, ">": (a, b) => a > b, ">=": (a, b) => a >= b, "=": (a, b) => a === b };
const FLIP: Record<string, string> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "=": "=" };

function featureApplies(f: string, ctx: Ctx, media: string): boolean {
  const inner = f.trim().replace(/^\(\s*|\s*\)$/g, "");
  let m = inner.match(/^(max|min)-width\s*:\s*(.+)$/);
  if (m) return m[1] === "max" ? ctx.w <= px(m[2], media) : ctx.w >= px(m[2], media);
  m = inner.match(/^width\s*(<=|>=|<|>|=)\s*(\S+)$/);                       // (width <= 1240px)
  if (m) return CMP[m[1]](ctx.w, px(m[2], media));
  m = inner.match(/^(\S+)\s*(<=|>=|<|>|=)\s*width$/);                       // (1240px >= width)
  if (m) return CMP[FLIP[m[2]]](ctx.w, px(m[1], media));
  m = inner.match(/^(\S+)\s*(<=|<)\s*width\s*(<=|<)\s*(\S+)$/);             // (481px <= width <= 1240px)
  if (m) return CMP[FLIP[m[2]]](ctx.w, px(m[1], media)) && CMP[m[3]](ctx.w, px(m[4], media));
  m = inner.match(/^(\S+)\s*(>=|>)\s*width\s*(>=|>)\s*(\S+)$/);
  if (m) return CMP[FLIP[m[2]]](ctx.w, px(m[1], media)) && CMP[m[3]](ctx.w, px(m[4], media));
  m = inner.match(/^(any-)?pointer\s*:\s*(coarse|fine|none)$/);
  if (m) return (m[2] === "coarse") === ctx.coarse && m[2] !== "none";
  m = inner.match(/^(any-)?hover\s*:\s*(hover|none)$/);
  if (m) return (m[2] === "none") === ctx.coarse;
  m = inner.match(/^prefers-reduced-motion\s*:\s*(reduce|no-preference)$/);
  if (m) return (m[1] === "reduce") === ctx.reduce;
  throw new Error(`медіа «${media}»: ознаку «${f.trim()}» пін не розуміє — розширте розбір`);
}

function mediaApplies(media: string | null, ctx: Ctx): boolean {
  if (!media) return true;
  return splitTop(media, (c) => c === ",").some((q) => {
    const parts = q.trim().split(/\s+and\s+/i).map((p) => p.trim()).filter(Boolean);
    return parts.every((p) => {
      if (/^(only\s+)?(screen|all)$/i.test(p)) return true;
      if (/^(only\s+)?print$/i.test(p)) return false;
      if (!p.startsWith("(")) throw new Error(`медіа «${media}»: «${p}» пін не розуміє (not / тип носія) — розширте розбір`);
      return featureApplies(p, ctx, media);
    });
  });
}

/** Межі з усіх медіа-умов у px: b−1, b, b+1 — між сусідніми межами умови сталі. */
function widthsFrom(rules: Rule[]): number[] {
  const ws = new Set([1920, 1600, 1440, 1366, 1280, 1024, 800, 768, 600, 375, 320]);
  for (const r of rules) for (const m of (r.media || "").matchAll(/(\d+(?:\.\d+)?)px/g)) { const b = Math.round(parseFloat(m[1])); for (const d of [-1, 0, 1]) if (b + d >= 280) ws.add(b + d); }
  return [...ws].sort((a, b) => b - a);
}

/* ---------- властивості: шорткати → довгі ---------- */

const SIDES = ["top", "right", "bottom", "left"] as const;
const BORDER_STYLES = new Set(["none", "hidden", "solid", "dashed", "dotted", "double", "groove", "ridge", "inset", "outset"]);
const fourSides = (v: string): string[] => { const p = splitTop(canon(v), (c) => c === " ").filter(Boolean); const [t, r = t, b = t, l = r] = p; return [t, r, b, l]; };
const twoSides = (v: string): [string, string] => { const p = splitTop(canon(v), (c) => c === " ").filter(Boolean); return [p[0], p[1] ?? p[0]]; };

function borderParts(v: string): { width: string; style: string; color: string } {
  let width = "medium", style = "none"; const color: string[] = [];
  for (const t of splitTop(canon(v), (c) => c === " ").filter(Boolean)) {
    if (/^(\d*\.?\d+(px|rem|em)?|thin|medium|thick)$/.test(t)) width = t;
    else if (BORDER_STYLES.has(t)) style = t;
    else color.push(t);
  }
  return { width, style, color: color.length ? color.join(" ") : "currentcolor" };
}

/** Довгі властивості, які ставить декларація. Значення — нормалізовані. */
function longhands(prop: string, value: string): [string, string][] {
  const v = canon(value);
  const sides = (pre: string, suf: string, vals: string[], which = SIDES as readonly string[]) => which.map((s, i) => [`${pre}${s}${suf}`, vals[i]] as [string, string]);
  switch (prop) {
    case "padding": return sides("padding-", "", fourSides(value));
    case "padding-block": { const [a, b] = twoSides(value); return [["padding-top", a], ["padding-bottom", b]]; }
    case "padding-inline": { const [a, b] = twoSides(value); return [["padding-left", a], ["padding-right", b]]; }
    case "padding-block-start": return [["padding-top", v]];
    case "padding-block-end": return [["padding-bottom", v]];
    case "padding-inline-start": return [["padding-left", v]];
    case "padding-inline-end": return [["padding-right", v]];
    case "inset": return sides("", "", fourSides(value));
    case "inset-block": { const [a, b] = twoSides(value); return [["top", a], ["bottom", b]]; }
    case "inset-inline": { const [a, b] = twoSides(value); return [["left", a], ["right", b]]; }
    case "inset-block-start": return [["top", v]];
    case "inset-block-end": return [["bottom", v]];
    case "inset-inline-start": return [["left", v]];
    case "inset-inline-end": return [["right", v]];
    case "overflow": { const [x, y] = twoSides(value); return [["overflow-x", x], ["overflow-y", y]]; }
    case "overflow-block": return [["overflow-y", v]];
    case "overflow-inline": return [["overflow-x", v]];
    case "overscroll-behavior": { const [x, y] = twoSides(value); return [["overscroll-behavior-x", x], ["overscroll-behavior-y", y]]; }
    case "overscroll-behavior-block": return [["overscroll-behavior-y", v]];
    case "block-size": return [["height", v]];
    case "min-block-size": return [["min-height", v]];
    case "max-block-size": return [["max-height", v]];
    case "inline-size": return [["width", v]];
    case "min-inline-size": return [["min-width", v]];
    case "max-inline-size": return [["max-width", v]];
    case "grid-area": { const p = splitTop(value, (c) => c === "/").map(canon); return [["grid-row-start", p[0]], ["grid-column-start", p[1] ?? "auto"], ["grid-row-end", p[2] ?? "auto"], ["grid-column-end", p[3] ?? "auto"]]; }
    case "grid-row": { const p = splitTop(value, (c) => c === "/").map(canon); return [["grid-row-start", p[0]], ["grid-row-end", p[1] ?? "auto"]]; }
    case "grid-column": { const p = splitTop(value, (c) => c === "/").map(canon); return [["grid-column-start", p[0]], ["grid-column-end", p[1] ?? "auto"]]; }
    case "grid":
    case "grid-template": {
      // `rows / columns` без рядків областей — розкладаємо; усе інше (області, auto-flow) — позначка,
      // що точно не збіжеться з очікуваним значенням.
      if (v === "none") return [["grid-template-rows", "none"], ["grid-template-columns", "none"]];
      const p = splitTop(value, (c) => c === "/").map(canon);
      if (p.length === 2 && !/["']|auto-flow/.test(value)) return [["grid-template-rows", p[0]], ["grid-template-columns", p[1]]];
      return [["grid-template-rows", `${prop}:${v}`], ["grid-template-columns", `${prop}:${v}`]];
    }
    case "border": { const b = borderParts(value); return SIDES.flatMap((s) => [[`border-${s}-width`, b.width], [`border-${s}-style`, b.style], [`border-${s}-color`, b.color]] as [string, string][]); }
    case "border-width": return sides("border-", "-width", fourSides(value));
    case "border-style": return sides("border-", "-style", fourSides(value));
    case "border-color": return sides("border-", "-color", fourSides(value));
    default: {
      // border-top, border-left-width, border-block-start, border-inline …
      const m = prop.match(/^border-(top|right|bottom|left|block|block-start|block-end|inline|inline-start|inline-end)(?:-(width|style|color))?$/);
      if (m) {
        const map: Record<string, string[]> = { block: ["top", "bottom"], "block-start": ["top"], "block-end": ["bottom"], inline: ["left", "right"], "inline-start": ["left"], "inline-end": ["right"] };
        const ss = map[m[1]] || [m[1]];
        if (m[2]) return ss.map((s) => [`border-${s}-${m[2]}`, v] as [string, string]);
        const b = borderParts(value);
        return ss.flatMap((s) => [[`border-${s}-width`, b.width], [`border-${s}-style`, b.style], [`border-${s}-color`, b.color]] as [string, string][]);
      }
      return [[prop, v]];
    }
  }
}

/* ---------- каскад ---------- */

/** Усе, що питають піни (щоб `all: …` розгорнути саме на них). */
const PINNED = ["display", "flex-direction", "position", "visibility", "order", "height", "min-height", "max-height", "min-width", "left", "top", "right", "bottom",
  "overflow-x", "overflow-y", "overscroll-behavior-y", "grid-template-columns", "grid-template-rows", "grid-row-start", "grid-row-end", "grid-column-start", "grid-column-end",
  "padding-top", "padding-bottom", "padding-left", "padding-right", ...SIDES.flatMap((s) => ["width", "style", "color"].map((k) => `border-${s}-${k}`))];

type Entry = { rule: Rule; value: string; important: boolean };

function buildModel() {
  const rules = parseCss(FILES);
  const byProp = new Map<string, Entry[]>();
  for (const rule of rules) for (const d of rule.decls) {
    const lh: [string, string][] = d.prop === "all" ? PINNED.map((p) => [p, `all:${canon(d.value)}`]) : longhands(d.prop, d.value);
    for (const [p, v] of lh) (byProp.get(p) ?? byProp.set(p, []).get(p)!).push({ rule, value: v, important: d.important });
  }
  const shells = { compact: shell("compact"), comfortable: shell("comfortable"), spacious: shell("spacious") } as Record<Density, Record<string, El>>;
  const matchMemo = new Map<string, { tri: Tri; spec: Spec }>();
  const matchRule = (rule: Rule, target: string, density: Density) => {
    const key = `${rule.order}|${target}|${density}`;
    let m = matchMemo.get(key);
    if (!m) {
      const el = shells[density][target];
      let tri: Tri = 0, spec: Spec = [0, 0, 0];
      for (const s of rule.sels) {
        const t = matchComplex(s, el);
        if (t === 0) continue;
        if (t === 1 && tri !== 2) { tri = 1; if (cmpSpec(s.spec, spec) > 0) spec = s.spec; }
        if (t === 2) { if (tri !== 2 || cmpSpec(s.spec, spec) > 0) spec = s.spec; tri = 2; }
      }
      m = { tri, spec };
      matchMemo.set(key, m);
    }
    return m;
  };
  /** Переможець каскаду: вища специфічність, за рівної — пізніша декларація (обхід — у порядку джерела). */
  const computed = (target: string, prop: string, ctx: Ctx): string | undefined => {
    let best: { spec: Spec; value: string } | undefined;
    for (const e of byProp.get(prop) || []) {
      const m = matchRule(e.rule, target, ctx.density);
      if (m.tri === 0) continue;
      if (!mediaApplies(e.rule.media, ctx)) continue;
      if (m.tri === 1) throw new Error(`${e.rule.file}: «${e.rule.selText}» може брати .${target} (стан/структура) і оголошує ${prop} — розширте пін`);
      if (e.important) throw new Error(`${e.rule.file}: «${e.rule.selText} { ${prop}: … !important }» — розбір !important не рахує, розширте пін`);
      if (!best || cmpSpec(m.spec, best.spec) >= 0) best = { spec: m.spec, value: e.value };
    }
    return best?.value;
  };
  const contexts: Ctx[] = [];
  for (const w of widthsFrom(rules)) for (const density of ["compact", "comfortable", "spacious"] as Density[]) for (const coarse of [false, true]) for (const reduce of [false, true]) contexts.push({ w, density, coarse, reduce });
  return { rules, computed, contexts };
}

let MODEL: ReturnType<typeof buildModel> | null = null;
const model = () => (MODEL ??= buildModel());               // розбір — усередині тестів: збій розбору червонить з назвою тесту
const label = (c: Ctx) => `${c.w}px/${c.density}${c.coarse ? "/дотик" : ""}${c.reduce ? "/reduce" : ""}`;
const toPx = (v: string | undefined, root: number): number => {
  const m = (v ?? "").match(/^(-?\d*\.?\d+)(px|rem)$/);
  if (m) return parseFloat(m[1]) * (m[2] === "rem" ? root : 1);
  if (v === "0") return 0;
  throw new Error(`значення «${v}» пін не переводить у px (лише px/rem)`);
};

/* Панелі оболонки не мають власного місця в сітці, висоти чи зсуву: будь-що з цього
   переставляє рядки (order: -1 кладе панель у рядок 1fr), піднімає мінімум треку
   fit-content (min-height) або зсуває панель поверх списку (inset). */
const MUST_BE_UNSET = ["order", "grid-row-start", "grid-row-end", "grid-column-start", "grid-column-end", "height", "min-height", "top", "right", "bottom", "left", "visibility"];

describe("с79 — права панель на планшеті (Н-11), відступи шапки (Н-12, Н-13)", () => {
  it("Н-11: на ≤1240 px .rpanel — другий рядок під списком (не прихована, не переставлена), .content-wrap — сітка `1fr fit-content(40%)`, панель не вища 40dvh", () => {
    const { computed, contexts } = model();
    const bad: string[] = [];
    for (const c of contexts.filter((x) => x.w <= 1240)) {
      const v = (t: string, p: string) => computed(t, p, c);
      const want = (t: string, p: string, ok: (x: string | undefined) => boolean, what: string) => { const x = v(t, p); if (!ok(x)) bad.push(`${label(c)}: .${t} ${p} = ${x} (${what})`); };
      want("content-wrap", "display", (x) => x === "grid", "grid");
      want("content-wrap", "grid-template-columns", (x) => x === "minmax(0,1fr)", "minmax(0, 1fr)");
      // список — 1fr (= minmax(auto, 1fr)): рядок не стискається нижче підлоги самого списку, і панель
      // не малюється поверх нього (ревʼю с79-р1); панель — за вмістом, стеля рівно 40%
      want("content-wrap", "grid-template-rows", (x) => x === "1fr fit-content(40%)", "1fr fit-content(40%)");
      want("content-wrap", "overflow-y", (x) => x === "hidden", "hidden — у крайніх випадках панель обрізається, а не розпирає сторінку");
      want("rpanel", "display", (x) => x === "grid", "grid — друга рядок, не display:none і не програш базовому flex");
      want("rpanel", "grid-template-columns", (x) => /^repeat\(auto-fill,minmax\(min\(100%,\d+(\.\d+)?rem\),1fr\)\)$/.test(x ?? ""), "секції колонками, min(100%, …) — без переповнення");
      want("rpanel", "max-height", (x) => x === "40dvh", "40dvh — страховка WebKit");
      want("rpanel", "border-left-style", (x) => x === "none" || x === "hidden" || v("rpanel", "border-left-width") === "0", "межі зліва немає");
      want("rpanel", "border-top-width", (x) => x === "1px", "розділювач зверху");
      want("rpanel", "border-top-style", (x) => x === "solid", "розділювач зверху");
      want("rpanel", "border-top-color", (x) => x === "var(--border)", "розділювач зверху");
      // с78: обидві панелі прокрутки — containing block і не передають прокрутку сторінці
      for (const t of ["rpanel", "content"]) {
        want(t, "position", (x) => x === "relative", "relative (с78)");
        want(t, "overscroll-behavior-y", (x) => x === "contain", "contain (с78)");
        want(t, "overflow-y", (x) => x === "auto", "auto — панель прокручується сама");
        for (const p of MUST_BE_UNSET) want(t, p, (x) => x === undefined, "не оголошується");
      }
      want("content", "max-height", (x) => x === undefined, "не оголошується");
    }
    expect(bad).toEqual([]);
  });

  it("Н-11: на >1240 px розкладка та сама, що до с79 — панель праворуч 320 px, flex-стовпець із лівою межею", () => {
    const { computed, contexts } = model();
    const bad: string[] = [];
    for (const c of contexts.filter((x) => x.w > 1240)) {
      const v = (t: string, p: string) => computed(t, p, c);
      const want = (t: string, p: string, ok: (x: string | undefined) => boolean, what: string) => { const x = v(t, p); if (!ok(x)) bad.push(`${label(c)}: .${t} ${p} = ${x} (${what})`); };
      want("content-wrap", "display", (x) => x === "grid", "grid");
      want("content-wrap", "grid-template-columns", (x) => x === "1fr 320px", "1fr 320px");
      want("content-wrap", "grid-template-rows", (x) => x === undefined, "не оголошується");
      want("rpanel", "display", (x) => x === "flex", "flex");
      want("rpanel", "flex-direction", (x) => x === "column", "column");
      want("rpanel", "max-height", (x) => x === undefined, "не оголошується");
      want("rpanel", "border-left-width", (x) => x === "1px", "1px");
      want("rpanel", "border-left-style", (x) => x === "solid", "solid");
      want("rpanel", "border-left-color", (x) => x === "var(--border)", "var(--border)");
      for (const t of ["rpanel", "content"]) {
        want(t, "position", (x) => x === "relative", "relative (с78)");
        want(t, "overflow-y", (x) => x === "auto", "auto");
        for (const p of MUST_BE_UNSET) want(t, p, (x) => x === undefined, "не оголошується");
      }
    }
    expect(bad).toEqual([]);
  });

  it("Н-12: вертикальний відступ .topbar — 4px у базі, у кожній щільності й на кожній ширині (кільце фокуса кнопок шапки не виходить за екран)", () => {
    const { computed, contexts } = model();
    const bad: string[] = [];
    for (const c of contexts) for (const p of ["padding-top", "padding-bottom"]) {
      const x = computed("topbar", p, c);
      if (x !== "4px") bad.push(`${label(c)}: .topbar ${p} = ${x}`);
    }
    expect(bad).toEqual([]);
  });

  it("Н-13: там, де видно «☰» (≤480 px), лівий відступ шапки не менший за її правий край — у кожній щільності, при шрифті 100% і 200%", () => {
    const { computed, contexts } = model();
    const bad: string[] = [];
    let checked = 0;
    for (const c of contexts) {
      const disp = computed("rf-navtoggle", "display", c);
      if (disp === "none") continue;
      checked++;
      if (computed("rf-navtoggle", "position", c) !== "fixed") bad.push(`${label(c)}: «☰» видно, але position = ${computed("rf-navtoggle", "position", c)}`);
      for (const root of [16, 32]) {
        const edge = toPx(computed("rf-navtoggle", "left", c), root) + toPx(computed("rf-navtoggle", "min-width", c), root);
        const pad = toPx(computed("topbar", "padding-left", c), root);
        if (pad < edge) bad.push(`${label(c)}@${root}px: .topbar padding-left ${pad}px < правий край «☰» ${edge}px (${computed("topbar", "padding-left", c)})`);
      }
    }
    expect(checked, "пін нічого не перевірив: «☰» ніде не видно").toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });

  it("модель оболонки звірена з TSX: теги, класи й порядок, на які спираються піни", () => {
    for (const f of ["components/QueueBoard.tsx", "components/RadiologistBoard.tsx"]) {
      const s = read(f);
      const main = s.indexOf('<div className="main">'), top = s.indexOf('<header className="topbar">', main), wrap = s.indexOf('<div className="content-wrap">', top);
      const content = s.indexOf('<div className="content">', wrap), aside = s.indexOf('<aside className="rpanel">', content);
      expect([main, top, wrap, content, aside].every((i) => i >= 0), `${f}: оболонка .main > .topbar + .content-wrap > .content + aside.rpanel`).toBe(true);
      expect(s.slice(main, top).replace(/\s+/g, ""), `${f}: .topbar — перша дитина .main`).toBe('<divclassName="main">');
      expect(s.slice(wrap, content).replace(/\s+/g, ""), `${f}: .content — перша дитина .content-wrap`).toBe('<divclassName="content-wrap">');
    }
    const nav = read("components/NavDrawer.tsx");
    const iToggle = nav.indexOf('className="rf-navtoggle"'), iScrim = nav.indexOf('className={"rf-nav-scrim"'), iAside = nav.indexOf('className={"sidebar"');
    expect(iToggle >= 0 && iToggle < iScrim && iScrim < iAside, "NavDrawer: «☰», скрим, aside.sidebar — у цьому порядку").toBe(true);
    const btn = nav.slice(nav.lastIndexOf("<button", iToggle), nav.indexOf(">", iToggle));
    expect(btn.match(/\b[a-z][-a-zA-Z]*(?==)/g)?.sort()).toEqual(["aria-controls", "aria-expanded", "aria-label", "className", "onClick", "ref", "type"]);
    expect(read("app/layout.tsx")).toMatch(/<html lang="uk"/);
    expect(read("app/layout.tsx")).toContain("document.documentElement.setAttribute('data-density'");
  });
});
