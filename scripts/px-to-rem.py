#!/usr/bin/env python3
"""RadFlow — разовая конвертация кеглей px → rem (сессия 14, WCAG 1.4.4).

Трогает ТОЛЬКО размеры шрифта:
  * CSS  — объявления `font-size: Npx`;
  * TSX  — инлайновые `fontSize: N` (React дописывает "px" к числу).
Всё остальное (высоты, отступы, ширины, media-queries) не трогаем: они
масштабируются зумом браузера и к 1.4.4 отношения не имеют.

База — 16px (дефолт браузера). Значения кратны 0.5px, поэтому N/16 всегда
конечная двоичная дробь: 12.5/16 = 0.78125 ровно, без потери в округлении.
"""
import re
import sys
from pathlib import Path

BASE = 16.0
ROOT = Path(__file__).resolve().parent.parent

CSS_FILES = [
    "styles/prototype/radflow.css",
    "styles/prototype/radflow-screens.css",
    "styles/prototype/radflow-wizard.css",
    "styles/prototype/radiologist.css",
    "components/register.css",
]


def rem(px: str) -> str:
    val = float(px) / BASE
    s = f"{val:.6f}".rstrip("0").rstrip(".")
    return (s or "0") + "rem"


def convert_css(text: str) -> tuple[str, int]:
    n = 0

    def sub(m: re.Match) -> str:
        nonlocal n
        n += 1
        return f"font-size: {rem(m.group(1))}"

    return re.sub(r"font-size:\s*([\d.]+)px", sub, text), n


def convert_tsx(text: str) -> tuple[str, int]:
    n = 0

    def sub(m: re.Match) -> str:
        nonlocal n
        n += 1
        return f'fontSize: "{rem(m.group(1))}"'

    # Только числовой литерал: `fontSize: 12.5` / `fontSize: 12`.
    # Выражения (`fontSize: big ? 14 : 12`) не трогаем — их нет, проверено.
    return re.sub(r"fontSize:\s*(\d+(?:\.\d+)?)(?=\s*[,}\n])", sub, text), n


def main() -> int:
    total = 0
    for rel in CSS_FILES:
        p = ROOT / rel
        src = p.read_text(encoding="utf-8")
        out, n = convert_css(src)
        if n:
            p.write_text(out, encoding="utf-8")
        print(f"{rel}: {n} font-size")
        total += n

    for p in sorted(list((ROOT / "app").rglob("*.tsx")) + list((ROOT / "components").rglob("*.tsx"))):
        src = p.read_text(encoding="utf-8")
        out, n = convert_tsx(src)
        if n:
            p.write_text(out, encoding="utf-8")
            print(f"{p.relative_to(ROOT)}: {n} fontSize")
            total += n

    print(f"ВСЕГО: {total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
