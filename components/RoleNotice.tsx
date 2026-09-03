import SignOutButton from "@/components/SignOutButton";

/**
 * ЕКРАН-ВІДМОВА ДЛЯ РОЛІ, ЯКІЙ РОЗДІЛ НЕ НАЛЕЖИТЬ (Ф6-4, с55).
 *
 * НАВІЩО РЕНДЕР, А НЕ РЕДІРЕКТ. Три дошки (`/queue`, `/call-list`,
 * `/waitlist`) до с55 закривались лише НЕГАТИВНИМ ланцюгом: кожна відомa роль
 * мала свій `redirect`, а роль, якої в ланцюзі немає, просто проходила далі.
 * Відвести таку роль нікуди: свого екрана в неї за побудовою немає, а
 * `redirect("/queue")` із самого `/queue` дав би петлю. Тому закриваючий
 * позитив тут РЕНДЕРИТЬ пояснення — так само, як це вже зроблено на `/setup`.
 *
 * ⚠️ Сьогодні цей екран не бачить НІХТО: усі пʼять ролей ENUM `user_role`
 * розведені ланцюгом вище. Він — запобіжник на день, коли в ENUM зʼявиться
 * шоста роль: без нього вона мовчки отримала б дошку черги і колл-лист із
 * НЕЗВОРОТНИМ масовим «Всіх підтверджено».
 *
 * ⚠️ КНОПКА ВИХОДУ ОБОВʼЯЗКОВА, і це не оформлення. Екран термінальний:
 * посилань із нього немає, а `middleware` жене залогіненого з `/login` назад
 * сюди. Без кнопки людина замкнена в петлі й не має чим із неї вийти —
 * рівно тому вона стоїть і на сусідніх екранах-відмовах у `/radiologist` та
 * `/referral`. (У першій редакції с55 кнопки не було; додана того ж дня.)
 */
export default function RoleNotice({ title, text }: { title: string; text: string }) {
  return (
    <div style={{ minHeight: "100vh", background: "#1c1c1e", color: "#f5f5f7", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "-apple-system, system-ui, sans-serif" }}>
      <div style={{ maxWidth: 460, textAlign: "center", padding: 28, background: "#2c2c2e", border: "1px solid #38383a", borderRadius: 16 }}>
        <div style={{ fontSize: "2.375rem", marginBottom: 12 }}>🔒</div>
        <h1 style={{ fontSize: "1.25rem", fontWeight: 650 }}>{title}</h1>
        <p style={{ fontSize: "0.875rem", color: "#8e8e93", marginTop: 10, lineHeight: 1.5 }}>{text}</p>
        <div style={{ marginTop: 20 }}><SignOutButton /></div>
      </div>
    </div>
  );
}
