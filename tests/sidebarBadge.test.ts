/**
 * U-60 — «нуль» і «не знаємо» не мають виглядати однаково.
 *
 * ⚠️ ЗАМІР ПРОТИ ДОКА: док називав ОДНЕ місце (бейдж листа в сайдбарі
 * направника), на дереві їх ТРИ — там же «Мої направлення» і `waitCount` у
 * сайдбарі персоналу. Тому правило знімає ВЛАСТИВІСТЬ, а піни нижче тримають
 * усі три місця вживання.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { codeOf } from "./helpers/codeOf";
import { badgeOf, loadStatusOf } from "@/lib/sidebarBadge";

const read = (p: string) => codeOf(readFileSync(resolve(process.cwd(), p), "utf8"));
const refSidebar = read("components/ReferrerSidebar.tsx");
const portal = read("components/ReferralPortal.tsx");
const sidebar = read("components/Sidebar.tsx");

describe("U-60 — три стани замість двох", () => {
  it("ЦЕНТРАЛЬНА ВЛАСТИВІСТЬ: збій і нуль не дають однакового вигляду", () => {
    /* Мутація, заради якої тест існує: повернути `badgeOf` до двох станів
       (`failed` → hidden) — і обидві сторони знову зійдуться. */
    expect(badgeOf("failed", 0)).not.toEqual(badgeOf("ready", 0));
  });

  it("нуль ховається — це прийнятий вигляд «нікого немає», не дефект", () => {
    expect(badgeOf("ready", 0)).toEqual({ kind: "hidden" });
  });

  it("є що показати — показуємо число", () => {
    expect(badgeOf("ready", 3)).toEqual({ kind: "count", value: 3 });
  });

  it("збій — «не знаємо», і значення при цьому не показуємо", () => {
    expect(badgeOf("failed", 0)).toEqual({ kind: "unknown" });
    expect(badgeOf("failed", 5)).toEqual({ kind: "unknown" });
  });

  it("поки вантажимо — нічого, щоб бейдж не блимав прочерком", () => {
    expect(badgeOf("loading", 0)).toEqual({ kind: "hidden" });
    expect(badgeOf("loading", 7)).toEqual({ kind: "hidden" });
  });
});

describe("U-60 — коли значенню можна вірити", () => {
  it("хоч раз прочиталось — 'ready' НАВІТЬ якщо остання спроба впала (контракт F4-9)", () => {
    /* Застаріле число корисніше за прочерк: саме так поводиться `waitCount`
       у сайдбарі персоналу з часів F4-9, і правка U-60 це не скасовує. */
    expect(loadStatusOf(true, true)).toBe("ready");
    expect(loadStatusOf(true, false)).toBe("ready");
  });

  it("не читалось жодного разу і спроба впала — 'failed'", () => {
    expect(loadStatusOf(false, true)).toBe("failed");
  });

  it("не читалось і ще не падало — 'loading'", () => {
    expect(loadStatusOf(false, false)).toBe("loading");
  });

  it("СКЛАДЕНЕ ПРАВИЛО: перший збій дає прочерк, наступний — лишає число", () => {
    /* Рівно та пара, що розводить дефект і контракт. */
    expect(badgeOf(loadStatusOf(false, true), 0)).toEqual({ kind: "unknown" });
    expect(badgeOf(loadStatusOf(true, true), 4)).toEqual({ kind: "count", value: 4 });
  });
});

describe("U-60 — усі ТРИ місця вживання, а не одне назване доком", () => {
  it("зелена лінія: три файли прочитані і це справді вони", () => {
    expect(refSidebar).toMatch(/export default function ReferrerSidebar\(/);
    expect(portal).toMatch(/counts=\{\{/);
    expect(sidebar).toMatch(/const \[waitCount, setWaitCount\] = useState\(0\);/);
  });

  it("сайдбар направника малює саме три стани, і «не знаємо» — тихим сірим", () => {
    expect(refSidebar).toMatch(/it\.badge\?\.kind === "unknown"/);
    expect(refSidebar).toMatch(/className="sb-badge dim"/);
    expect(refSidebar).toMatch(/it\.badge\?\.kind === "count"/);
    /* ⚠️ Текст погоджений із власником до того, як поїхав (продуктова правка),
       тому пінується дослівно. Пін на ДРУГИЙ сайдбар живе у своєму тесті —
       інакше мутація в одному файлі червонила б тест, названий по іншому, і
       «назви сторожа, що впав» перестало б працювати. */
    expect(refSidebar).toMatch(/title="Не вдалося завантажити"/);
  });

  it("портал розводить ОБИДВА свої лічильники — і лист, і направлення", () => {
    expect(portal).toMatch(/mine: badgeOf\(loadStatusOf\(listOk, listErr\), referrals\.length\)/);
    /* ⚠️ Пін дописано до КІНЦЯ виразу (ревʼю А): обірваний на `wlErr)` він
       лишався зеленим на підміні самого значення — бейдж почав би рахувати
       вже не тих, хто чекає. */
    expect(portal).toMatch(
      /waitlist: badgeOf\(loadStatusOf\(wlOk, wlErr\), wlEntries\.filter\(\(e\) => e\.status === "waiting"\)\.length\)/
    );
  });

  it("прапорець успіху не плутається з прапорцем «спроба скінчилась»", () => {
    /* ⚠️ Тонкий бік: `wlLoaded` вмикається і на збої, тому бейдж мусить
       спиратись на `wlOk`. Мутація «замінити wlOk на wlLoaded» лишила б усі
       поведінкові тести зеленими — ловить саме цей пін. */
    expect(portal, "бейдж знову рахується з прапорця «спроба скінчилась»")
      .not.toMatch(/badgeOf\(loadStatusOf\(wlLoaded/);
    /* ⚠️ Пінуємо МІСЦЕ, а не наявність (ревʼю А). Найреалістичніша правка —
       перенести `set*Ok(true)` вище гілки помилки або в `finally` («перше
       завантаження завершилось», для скелетона): виклик на місці, пін
       наявності зелений, а U-60 повертається одразу в трьох місцях. Тому
       вимагаємо, щоб прапорець успіху стояв ПІСЛЯ виходу по помилці. */
    expect(portal, "setListOk піднявся вище гілки помилки")
      .toMatch(/if \(error\) \{ setListErr\(true\); return; \}[\s\S]{0,400}?setListOk\(true\);/);
    expect(portal, "setWlOk піднявся вище гілки помилки")
      .toMatch(/if \(error\) \{ setWlErr\(true\); setWlLoaded\(true\); return; \}[\s\S]{0,400}?setWlOk\(true\);/);
    expect(sidebar, "setWaitOk піднявся вище гілки помилки")
      .toMatch(/if \(error \|\| count == null\) \{ setWaitErr\(true\); return; \}[\s\S]{0,300}?setWaitOk\(true\);/);
    /* ⚠️ І КІЛЬКІСТЬ, бо самого порядку мало: другий виклик, доданий ВИЩЕ
       гілки помилки, лишає пін порядку зеленим (нижній нікуди не подівся), а
       поведінку ламає повністю. */
    expect((portal.match(/setListOk\(true\);/g) || []).length, "setListOk виставляють ще десь").toBe(1);
    expect((portal.match(/setWlOk\(true\);/g) || []).length, "setWlOk виставляють ще десь").toBe(1);
    expect((sidebar.match(/setWaitOk\(true\);/g) || []).length, "setWaitOk виставляють ще десь").toBe(1);
  });

  it("сайдбар персоналу теж розведений, і falsy-гейта більше немає", () => {
    expect(sidebar).toMatch(/const waitBadge = badgeOf\(loadStatusOf\(waitOk, waitErr\), waitCount\);/);
    expect(sidebar).toMatch(/waitBadge\.kind === "unknown"/);
    expect(sidebar).toMatch(/title="Не вдалося завантажити"/);
    expect(sidebar, "повернувся старий двостанний гейт")
      .not.toMatch(/\{waitCount \? <span className="sb-badge">/);
  });

  it("збій читання лічильника більше не мовчить — і порожній count теж збій", () => {
    /* ⚠️ `count == null` при `error === null` — живий дефект, знайдений ревʼю
       с58, а не мутація: `head: true` бере число з заголовка, і якщо він не
       розібрався, `count ?? 0` писав у бейдж довірений нуль. */
    expect(sidebar).toMatch(/if \(error \|\| count == null\) \{ setWaitErr\(true\); return; \}/);
    expect(sidebar, "повернувся `count ?? 0` — «не знаємо» знову стало нулем")
      .not.toMatch(/setWaitCount\(count \?\? 0\)/);
    expect(sidebar).toMatch(/setWaitOk\(true\);/);
  });

  it("сірий прочерк не може зависнути назавжди", () => {
    /* ⚠️ Дефект, який СТВОРИЛА ця правка (ревʼю Б): при порожньому `clinicIds`
       каналу немає, а `useRealtimeRefetch` виходить по `if (!channelName)
       return;` ДО того, як навісить слухач видимості. До U-60 висіло старе
       число, після — висів би прочерк до перезавантаження сторінки. */
    expect(sidebar).toMatch(/if \(clinicIds\.length \|\| typeof document === "undefined"\) return;/);
    expect(sidebar).toMatch(/document\.addEventListener\("visibilitychange", onVis\);/);
    expect(sidebar).toMatch(/document\.removeEventListener\("visibilitychange", onVis\);/);
  });
});
