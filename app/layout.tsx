import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RadFlow",
  description:
    "Інтелектуальне управління чергою для центрів променевої діагностики (МРТ/КТ).",
};

/* Next вставляє такий viewport і за замовчуванням, але тут він зафіксований
   СВІДОМО: без `maximum-scale` і без `user-scalable=no` — заборона зуму
   порушує WCAG 1.4.4. Явний запис страхує від того, що колись їх додадуть
   «щоб не смикався інпут на iOS». */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="uk" suppressHydrationWarning>
      <body>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var d=localStorage.getItem('rf-density');var ok=d==='compact'||d==='comfortable'||d==='spacious';document.documentElement.setAttribute('data-density',ok?d:'comfortable');}catch(e){document.documentElement.setAttribute('data-density','comfortable');}})();",
          }}
        />
        {children}
      </body>
    </html>
  );
}
