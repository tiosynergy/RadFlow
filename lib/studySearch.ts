/* ===== RadFlow — пошук дослідження за назвою (форми запису) =====
   ЄДИНА точка правила «інтуїтивний пошук по каталогу»: від STUDY_SEARCH_MIN
   символів, слова запиту шукаються ВСІ (AND по підрядках, як nameMatches
   універсального пошуку — «мрт колінного» і «колінного мрт» дають те саме;
   стемінгу немає, тож «коліно» НЕ знайде «колінного»), з підказкою центру,
   кабінета-власника і ЦІНИ ще до вибору.

   Джерело — ті самі рядки `services`, що їдуть у buildCatalog() (0107/0121):
   пошук не має власного уявлення про каталог, він лише індексує назви. Тому
   room-owned послуга (0121) несе roomId кабінета-власника — форма, що підставляє
   результат, зобовʼязана привʼязати запис до цього кабінета, інакше область не
   зрезолвиться (`regionsFor` без roomId бачить лише базові).

   ⚠️ СТАТИЧНИЙ ФОЛБЭК — як у buildCatalog: модальність, якої в каталозі центру
   немає ЗОВСІМ (жодного рядка — ні базового, ні кабінетного), прозоро віддає
   статичний довідник lib/studies. Без цього пошук був би мертвим у центрах, що
   ще не заповнили прайс, і — гірше — БРЕХАВ би направнику в кросцентровій
   видачі: «центр Б не робить МРТ мозку», хоча форма центру Б це дослідження
   пропонує (спіймано ревʼю пакета, M-2). Наявність хоч одного рядка модальності
   (навіть неактивного чи кабінетного) вимикає статику для ВСІЄЇ модальності
   цього центру — миттєве наближення room-контекстного isConfigured, достатнє
   для підказки: істина завжди у формі.

   ⚠️ Ціна в результаті — БАЗОВА ціна позиції прайсу; `0` = «ціну не задано»
   (канон 0107/CeoDashboard/ServicesEditor), UI такий нуль не друкує.
   Переозначення по кабінету (service_room_overrides, 0108) свідомо не
   застосовуються: на момент пошуку кабінет міг бути ще не обраний, а після
   підстановки форма однаково перераховує «Орієнтовну вартість» через
   buildCatalog з overrides. Підказка — орієнтир, форма — істина.

   RLS робить пошук грантово-чесним сам: після 0139 направник у servicesByClinic
   просто НЕ отримує послуг кабінетів поза грантом (плюс форми додатково
   фільтрують через opts.allow — вимкнені кабінети, модальності центру тощо). */

import type { ServiceLike } from "@/lib/catalog";
import {
  modalityCode,
  isContrastName,
  regionsFor as staticRegionsFor,
  BOOKABLE_MODALITIES,
  type ModalityCode,
} from "@/lib/studies";
import { normSearchText } from "@/lib/searchText";

/** Мінімальна довжина запиту (у НОРМАЛІЗОВАНИХ символах) — вимога продукту. */
export const STUDY_SEARCH_MIN = 4;
/** Стеля результатів за замовчуванням: дропдаун, а не сторінка видачі. */
export const STUDY_SEARCH_LIMIT = 12;

export interface StudySearchHit {
  clinicId: string;
  /** Кабінет-власник для room-owned послуги (0121); null = базова послуга центру. */
  roomId: string | null;
  /** Код модальності enum public.modality (MRI/CT/US/…). */
  type: ModalityCode;
  /** Назва послуги = майбутній studies[].region. */
  label: string;
  /** Каталожна тривалість; null = «час не задано» (0117, ручний ввід). */
  dur: number | null;
  /** Базова ціна позиції; 0 = «ціну не задано» — UI не друкує (канон 0107). */
  price: number;
  /** Контрастна позиція (за назвою, isContrastName) — довідкове поле підказки.
      Прапорець studies[].contrast форми беруть НЕ звідси, а з regionInfo
      ОБРАНОЇ позиції після підстановки (істина завжди у формі). Для статики
      завжди false (там контраст — модифікатор чекбоксом). */
  isContrast: boolean;
  /** true = позиція зі СТАТИЧНОГО довідника (модальність без каталогу). */
  legacy?: boolean;
}

export interface StudySearchSource {
  clinicId: string;
  services: ServiceLike[] | null | undefined;
}

export interface StudySearchOpts {
  limit?: number;
  /** Дозволені коди модальностей (наприклад, кабінет StudyEditModal фіксує одну). */
  modalities?: readonly string[];
  /** Додатковий фільтр форми (грант, вимкнені кабінети, доступні модальності центру). */
  allow?: (hit: StudySearchHit) => boolean;
}

/** true, якщо ВСІ слова запиту входять у нормалізовану назву (AND — канон
    текстового пошуку продукту, lib/searchText.nameMatches). */
function nameHasAll(name: string, tokens: readonly string[]): boolean {
  for (const t of tokens) if (!name.includes(t)) return false;
  return true;
}

/** Пошук по назві. Порядок: спершу назви, що ПОЧИНАЮТЬСЯ з першого слова
    запиту, далі за назвою; порядок центрів — як передані sources. Запит
    коротший за STUDY_SEARCH_MIN → завжди []. Вимкнені позиції (active=false)
    не пропонуються — як і в селектах форм. Дублі назв база↔кабінет лишаються
    ОБОМА результатами (канон 0121 Q4: «показувати обидві»). */
export function searchStudies(
  sources: ReadonlyArray<StudySearchSource>,
  query: string,
  opts?: StudySearchOpts
): StudySearchHit[] {
  const q = normSearchText(query);
  if (q.length < STUDY_SEARCH_MIN) return [];
  const tokens = q.split(" ").filter(Boolean);
  if (!tokens.length) return [];
  const limit = Math.max(1, opts?.limit ?? STUDY_SEARCH_LIMIT);
  const mods = opts?.modalities;

  const starts: StudySearchHit[] = [];
  const rest: StudySearchHit[] = [];
  const push = (hit: StudySearchHit, name: string) => {
    if (opts?.allow && !opts.allow(hit)) return;
    (name.startsWith(tokens[0]) ? starts : rest).push(hit);
  };

  for (const src of sources) {
    if (!src) continue;
    const rows = Array.isArray(src.services) ? src.services : [];
    const present = new Set<string>(); // модальності, що МАЮТЬ хоч один рядок каталогу
    for (const s of rows) if (s) present.add(modalityCode(s.modality));

    for (const s of rows) {
      if (!s || s.active === false) continue;
      const code = modalityCode(s.modality);
      if (code === "OTHER") continue; // немає форм запису (канон lib/catalog)
      if (mods && !mods.includes(code)) continue;
      const name = normSearchText(s.name);
      if (!nameHasAll(name, tokens)) continue;
      push({
        clinicId: src.clinicId,
        roomId: s.room_id ?? null,
        type: code,
        label: s.name,
        dur: s.duration_min ?? null,
        price: s.price,
        isContrast: isContrastName(s.name),
      }, name);
    }

    // Статичний фолбэк для модальностей БЕЗ каталогу (див. шапку).
    for (const code of BOOKABLE_MODALITIES) {
      if (present.has(code)) continue;
      if (mods && !mods.includes(code)) continue;
      for (const r of staticRegionsFor(code)) {
        const name = normSearchText(r.label);
        if (!nameHasAll(name, tokens)) continue;
        push({
          clinicId: src.clinicId,
          roomId: null,
          type: code,
          label: r.label,
          dur: r.dur,
          price: r.price,
          isContrast: false,
          legacy: true,
        }, name);
      }
    }
  }
  const byLabel = (a: StudySearchHit, b: StudySearchHit) => a.label.localeCompare(b.label, "uk");
  starts.sort(byLabel); rest.sort(byLabel);
  return starts.concat(rest).slice(0, limit);
}
