# RadFlow

**Интеллектуальное управление очередью для центров лучевой диагностики (МРТ/КТ).**
Multi-tenant SaaS: запись пациентов, доска очереди в реальном времени, кабинет радиолога,
обзвон, инциденты (поломка/ТО), портал направляющих врачей с межклиничным доступом и дашборд руководителя.

> Полное описание функций, ролей и сценариев — в [`docs/PRODUCT_OVERVIEW.md`](docs/PRODUCT_OVERVIEW.md).
> Текущий аудит и список дефектов — в [`docs/audit/FULL_AUDIT_2026-06-25.md`](docs/audit/FULL_AUDIT_2026-06-25.md).

## Технический стек

| Слой | Технология |
|------|-----------|
| Фронтенд + бэкенд | Next.js 15 (App Router) + React 19 + TypeScript + Tailwind |
| База, авторизация, файлы | Supabase (PostgreSQL + RLS) |
| Реальное время | Supabase Realtime (с авторизованным сокетом + поллинг-подстраховка) |
| Привилегированные операции | Supabase service-role в серверных API-роутах |
| Хостинг | Vercel (авто-деплой из `main`) |
| Планируется (Stage 2) | n8n Cloud (AI-перепланирование), Resend (email), Sentry (мониторинг) |

## Реализованные модули (Stage 1 MVP)

Все экраны работают на реальных данных Supabase (не мок).

| Маршрут | Роль | Назначение |
|---------|------|-----------|
| `/register` | — | Регистрация клиники (создаёт администратора + tenant) |
| `/login` | все | Вход по **логину или email** + паролю |
| `/set-password` | приглашённые | Установка пароля по приглашению |
| `/setup` | admin | Мастер настройки клиники (профиль + кабинеты с графиком) |
| `/queue` (и `/`) | admin/registrar | **Доска очереди** — главный экран: слоты по графику, статусы в один клик, инциденты, CITO, realtime |
| `/radiologist` | radiologist/admin | **Кабинет радиолога** — «Моя черга» по назначенным кабинетам, таймер, вызов следующего |
| `/call-list` | admin/registrar | **Call List** — обзвон на дату, статусы звонков, заметки, CSV, обзвон через простой |
| `/ceo` | admin/ceo | **CEO Dashboard** — KPI, загрузка, доход, недельный график, топ-процедур |
| `/referral` | referrer | **Портал направляющего** — создание направлений, «Мои направления», «Мои центры» (доступ) |
| `/referrers` | admin | Управление направителями (приглашение, доступ к кабинетам) |
| `/staff` | admin | Управление радиологами (создание, кабинеты, пароль) |

Роли: `admin`, `radiologist`, `registrar`, `referrer`, `ceo`. Маршрутизация по роли — в `middleware.ts` и на серверных страницах.

## Локальный запуск

```bash
npm install      # установить зависимости (один раз)
npm run dev      # http://localhost:3000
```

Для работы нужны переменные окружения (`.env.local`): URL и ключи Supabase
(`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`).
Шаблон — в `.env.example`. Без переменных middleware пропускает запросы (dev-режим до подключения Supabase).

## База данных

Схема и политики управляются миграциями в `supabase/migrations/` (на текущий момент `0001`–`0037`).
Применять по порядку в Supabase → SQL Editor. Подробно о схеме, ограничениях и RLS — в
[`docs/PRODUCT_OVERVIEW.md`](docs/PRODUCT_OVERVIEW.md) (раздел «Модель данных»).

Ключевые инварианты (на уровне БД):

- запрет двойного бронирования по времени (триггер `check_no_overlap` + advisory-lock);
- один пациент `in_progress` на кабинет (частичный unique-индекс);
- один активный инцидент на кабинет; запрет записи в окно простоя.

## Деплой на Vercel

1. `.env.example` → переменные окружения в Vercel (Production/Preview/Development).
2. Импортируйте репозиторий на vercel.com → Vercel определит Next.js.
3. Каждый `git push` в `main` пересобирает прод автоматически.
4. Новые миграции БД применяются вручную в Supabase → SQL Editor.

## Безопасность

- **Ключи только в окружении** (`.env.local` / Vercel Env). Секреты не коммитятся.
- **RLS включён на каждой таблице** с `clinic_id` — данные одной клиники недоступны другой.
- Привилегированные операции (создание аккаунтов, выдача доступа) идут через серверные
  API-роуты, которые сами проверяют роль перед использованием service-role.
- ⚠️ **Известные блокеры до продакшена** (см. аудит §2): переработать установку пароля на
  одноразовые invite-токены и закрыть энумерацию аккаунтов через `email_for_login`.

## Структура

```
.
├─ app/                     # Next.js App Router (страницы + API-роуты)
│  ├─ queue/ radiologist/ ceo/ call-list/ referral/ referrers/ staff/ setup/
│  ├─ login/ register/ set-password/ auth/callback/
│  └─ api/                  # staff, referrers/invite, referral/access, account/set-password
├─ components/              # React-компоненты экранов и модалок (.jsx)
├─ lib/                     # бизнес-логика (queueStatus, incidents, schedule, studies) + supabase/*
├─ supabase/migrations/     # 0001–0031 (схема, RLS, триггеры, RPC)
├─ middleware.ts            # сессия + защита маршрутов + роутинг по роли
├─ docs/                    # документация (PRODUCT_OVERVIEW, аудиты, прототипы, планы)
└─ next.config.mjs · tsconfig.json · tailwind.config.ts · package.json
```

## Дальнейшие шаги (Stage 2+)

SMS/email-уведомления пациентам · AI-перепланирование при инцидентах (n8n) · биллинг ·
интеграции PACS/RIS · мобильная версия · углублённая аналитика.
