import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RadFlow",
  description:
    "Інтелектуальне управління чергою для центрів променевої діагностики (МРТ/КТ).",
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
