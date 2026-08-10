"use client";

/* ===== Пошук дослідження за назвою — спільний для всіх форм запису =====
   Інпут + випадний список: від 4 символів (STUDY_SEARCH_MIN) показує позиції
   прайсу з тривалістю, ЦІНОЮ і, якщо форма мультицентрова, назвою центру та
   кабінета-власника. Вибір віддає StudySearchHit у onPick — форма сама
   підставляє центр/кабінет/тип/область (у кожної свій state і свої скидання).

   Селекти «Тип/Область» лишаються як були: пошук — швидкий спосіб їх заповнити,
   а не заміна (рішення власника, пакет «пошук досліджень»). */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { searchStudies, STUDY_SEARCH_MIN, STUDY_SEARCH_LIMIT, type StudySearchHit, type StudySearchOpts, type StudySearchSource } from "@/lib/studySearch";
import { fmtUah, modalityLabel } from "@/lib/studies";

interface StudySearchBoxProps {
  sources: ReadonlyArray<StudySearchSource>;
  onPick: (hit: StudySearchHit) => void;
  /** Назва центру в підказці (мультицентровий портал направника). */
  clinicNameOf?: (clinicId: string) => string | undefined;
  /** Назва кабінета-власника room-owned послуги. */
  roomNameOf?: (roomId: string) => string | undefined;
  modalities?: StudySearchOpts["modalities"];
  allow?: StudySearchOpts["allow"];
  placeholder?: string;
}

export default function StudySearchBox({ sources, onPick, clinicNameOf, roomNameOf, modalities, allow, placeholder }: StudySearchBoxProps) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId(); // два бокси на сторінці (доска + модалка) не мають ділити id

  /* ⚠️ useMemo тут фактично no-op: усі форми передають sources літералом/.map,
     тож посилання нове на кожен рендер. Це УСВІДОМЛЕНО: саме тому allow (живе
     замикання форми — грант, кабінети, кроки кейса) ніколи не застаріває. При
     q < STUDY_SEARCH_MIN searchStudies виходить одразу, тож ціна нульова.
     НЕ мемоізуйте sources у батьках, не прибравши цей коментар: отримаєте
     stale-closure по allow. */
  const hits = useMemo(
    () => searchStudies(sources, q, { modalities, allow }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- див. коментар вище
    [sources, q, modalities]
  );
  const short = q.trim().length > 0 && q.trim().length < STUDY_SEARCH_MIN;

  // Клік поза боксом закриває список (без таймер-хаків на blur: вони гублять
  // клік по пункту, якщо він приходить пізніше за setTimeout).
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  useEffect(() => { setIdx(0); }, [q]);
  // Стрілки мають ДОСКРОЛЮВАТИ список (12 хітів > видимих ~6): без цього
  // активний пункт їде за нижню кромку .ssb-drop (overflow-y: auto).
  useEffect(() => {
    if (!open) return;
    document.getElementById(listId + "-o" + idx)?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- скрол лише за активним індексом
  }, [idx, open]);

  function pick(h: StudySearchHit) {
    onPick(h);
    setQ("");
    setOpen(false);
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || hits.length === 0) {
      if (e.key === "Escape") { setQ(""); setOpen(false); }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, hits.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const h = hits[idx]; if (h) pick(h); }
    else if (e.key === "Escape") { setQ(""); setOpen(false); }
  }

  return (
    <div className="ssb" ref={rootRef}>
      <input
        className="inp"
        type="text"
        role="combobox"
        aria-expanded={open && hits.length > 0}
        aria-controls={listId}
        aria-activedescendant={open && hits[idx] ? listId + "-o" + idx : undefined}
        aria-autocomplete="list"
        value={q}
        placeholder={placeholder || "Пошук дослідження за назвою…"}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
      />
      {open && q.trim().length > 0 && (
        <div className="ssb-drop" role="listbox" id={listId}>
          {short && <div className="ssb-empty" role="presentation">введіть від {STUDY_SEARCH_MIN} символів…</div>}
          {!short && hits.length === 0 && <div className="ssb-empty" role="presentation">нічого не знайдено</div>}
          {hits.map((h, i) => {
            const clinic = clinicNameOf?.(h.clinicId);
            const room = h.roomId ? roomNameOf?.(h.roomId) : undefined;
            const meta = [
              modalityLabel(h.type),
              h.dur == null ? "час не задано" : h.dur + " хв",
              h.price > 0 ? fmtUah(h.price) : "ціну не задано", // 0 = «не задано», канон 0107
              clinic,
              room ? "кабінет: " + room : undefined,
              /* Статична позиція (модальність без каталогу): ціна з базового
                 довідника, НЕ з прайсу центру — без пометки направник називав
                 би пацієнту чужу цифру (ревʼю р.2, M-2). */
              h.legacy ? "базовий довідник — орієнтовно" : undefined,
            ].filter(Boolean).join(" · ");
            return (
              <button
                type="button"
                key={h.clinicId + "|" + (h.roomId || "") + "|" + h.label + "|" + i}
                id={listId + "-o" + i}
                className={"ssb-item" + (i === idx ? " on" : "")}
                role="option"
                aria-selected={i === idx}
                onMouseEnter={() => setIdx(i)}
                onClick={() => pick(h)}
              >
                <span className="ssb-name">{h.label}</span>
                <span className="ssb-meta">{meta}</span>
              </button>
            );
          })}
          {hits.length >= STUDY_SEARCH_LIMIT && (
            <div className="ssb-empty" role="presentation">показані перші {STUDY_SEARCH_LIMIT} — уточніть запит</div>
          )}
        </div>
      )}
    </div>
  );
}
