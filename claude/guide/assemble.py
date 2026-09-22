#!/usr/bin/env python3
"""Складання автономної інструкції користувача RadFlow.

Джерела — три частини поруч із цим файлом; зображення — або свіжі макети
з ./shots/*.opt.png (їх малює guide-shots.mjs, потрібен Playwright), або,
якщо теки shots немає, ті самі картинки, вже вбудовані в попередню збірку
docs/USER_GUIDE.html. Завдяки другому шляху правка тексту не вимагає
браузера: досить `python claude/guide/assemble.py`.

Редагувати треба частини, а не зібраний HTML — його перезаписує ця збірка.
"""
import base64, pathlib, re, sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent                      # корінь репозиторію
SHOTS = HERE / "shots"
OUT = ROOT / "docs" / "USER_GUIDE.html"

CAPTIONS = {
    "wizard":      "Майстер налаштування: кроки ліворуч, поля кроку — праворуч.",
    "queue":       "Дошка черги: лічильники дня згори, записи — списком нижче.",
    "queue-open":  "Розкритий рядок черги: шлях запису й дії, доступні на поточному кроці.",
    "slots":       "Сітка вільного часу: півгодинні блоки з пʼятихвилинних клітинок.",
    "calllist":    "Колл-лист: список на обдзвін і кнопки статусу дзвінка.",
    "waitlist":    "Лист очікування: пріоритет задає порядок пропозицій.",
    "radiologist": "Робоче місце радіолога: картки його кабінетів — зайнятого й вільного.",
    "ceo":         "Дашборд керівника: показники, динаміка за тиждень, завантаженість.",
}

# Картинки з попередньої збірки — запасний шлях, коли shots/ немає.
prev = {}
if OUT.exists():
    for m in re.finditer(r'data-shot="([a-z-]+)"[^>]*>\s*<img[^>]*src="data:image/png;base64,([^"]+)"',
                         OUT.read_text(encoding="utf-8")):
        prev[m.group(1)] = m.group(2)

doc = "\n".join((HERE / f"part{i}.html").read_text(encoding="utf-8") for i in (1, 2, 3))

used = []

def embed(m):
    key = m.group(1)
    src = SHOTS / f"{key}.opt.png"
    if src.exists():
        b64, how = base64.b64encode(src.read_bytes()).decode("ascii"), "shots"
    elif key in prev:
        b64, how = prev[key], "попередня збірка"
    else:
        sys.exit(f"немає ні {src}, ні картинки «{key}» у {OUT}")
    used.append((key, len(b64) * 3 // 4, how))
    cap = CAPTIONS[key]
    return (f'<figure data-shot="{key}">\n<img alt="{cap}" src="data:image/png;base64,{b64}">\n'
            f'<figcaption>{cap}</figcaption>\n</figure>')

doc = re.sub(r"\{\{IMG:([a-z-]+)\}\}", embed, doc)

left = re.findall(r"\{\{IMG:[a-z-]+\}\}", doc)
if left:
    sys.exit(f"незамінені плейсхолдери: {left}")

# Таблиці загортаємо в прокручуваний контейнер — на вузькому екрані
# чотириколонкова таблиця інакше розпирає всю сторінку.
wrapped = 0
def wrap_table(m):
    global wrapped
    wrapped += 1
    return '<div class="tw">\n' + m.group(0) + '\n</div>'
doc = re.sub(r"<table>.*?</table>", wrap_table, doc, flags=re.S)

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(doc, encoding="utf-8")

print("вбудовано зображень: %d, таблиць загорнуто: %d" % (len(used), wrapped))
for k, s, how in used:
    print("  %-12s %6.1f KB  (%s)" % (k, s / 1024, how))
print("розмір файла: %.2f MB → %s" % (OUT.stat().st_size / 1024 / 1024, OUT))
