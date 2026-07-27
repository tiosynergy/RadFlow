import Link from "next/link";

// Кастомна 404 у темі RadFlow (замість дефолтної білої сторінки Next.js).
// var()+fallback — щоб виглядало коректно навіть якщо змінні теми не підвантажились.
export default function NotFound() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        padding: 24,
        textAlign: "center",
        background: "var(--bg, #1c1c1e)",
        color: "var(--text, #f2f2f7)",
      }}
    >
      <div style={{ fontSize: "4rem", fontWeight: 800, lineHeight: 1, color: "var(--blue, #0a84ff)" }}>404</div>
      <div style={{ fontSize: "1.125rem", fontWeight: 600 }}>Сторінку не знайдено</div>
      <div style={{ maxWidth: 440, color: "var(--text-muted, #8e8e93)" }}>
        Такої сторінки немає або її переміщено. Поверніться до дошки черги.
      </div>
      <Link
        href="/queue"
        style={{
          marginTop: 8,
          padding: "10px 18px",
          borderRadius: 8,
          fontWeight: 600,
          textDecoration: "none",
          color: "#fff",
          background: "var(--blue, #0a84ff)",
        }}
      >
        ← До дошки черги
      </Link>
    </div>
  );
}
