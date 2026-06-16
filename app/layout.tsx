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
    <html lang="uk">
      <body>{children}</body>
    </html>
  );
}
