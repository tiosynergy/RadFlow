/* ===== Пошук: підписи статусів і пріоритетів (с77) =====

   Були константами всередині `components/SearchScreen.tsx`. Експорт у Excel
   (с77) пише ті самі слова у файл — і файл не має розходитися з екраном,
   тож підписи живуть тут, в одному місці для обох. */

export const SEARCH_QUEUE_STATUS_LABEL: Record<string, string> = {
  scheduled: "В черзі", waiting: "Очікує", in_progress: "В кабінеті", done: "Виконано",
  no_show: "Неявка", not_held: "Не відбулося", cancelled: "Скасовано", needs_reschedule: "Потребує переносу",
};

export const SEARCH_WAITLIST_STATUS_LABEL: Record<string, string> = {
  waiting: "Очікує", scheduled: "Записано", cancelled: "Знято", expired: "Прострочено",
};

export const SEARCH_PRIORITY_LABEL: Record<string, string> = { cito: "CITO", urgent: "Терміново", planned: "Планово" };

export const SEARCH_SOURCE_LABEL: Record<"queue" | "waitlist", string> = { queue: "Черга", waitlist: "Лист очікування" };

/** Рядок досліджень — однаково на екрані й у файлі (ревʼю с77: дві копії розійшлися б). */
export function studiesLine(studies: Array<{ type: string | null; region: string | null; contrast: boolean }>): string {
  return studies.map((s) => (s.type || "—") + (s.region ? " · " + s.region : "") + (s.contrast ? " · контраст" : "")).join(" + ");
}
