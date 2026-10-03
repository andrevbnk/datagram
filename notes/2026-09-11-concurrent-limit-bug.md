# Datagram: зависший лимит concurrent jobs (баг бэкенда)

**Дата:** 2026-09-11
**Tenant:** `1d7e6627-5417-4bab-a324-46f9d7482eaf` (slug `ourwar-frmy5`)
**План:** professional (лимит concurrent = 10)

## Симптом

`POST /api/public/v1/tasks` стабильно возвращает:

```
422 {"error":"Tenant '1d7e6627-5417-4bab-a324-46f9d7482eaf' has exceeded the Maximum concurrent jobs limit (10) reached.."}
```

## Что проверено

- `GET /api/public/v1/tasks?limit=100` → 38 задач, **все `completed`**, ни одной `pending/queued/running/active`.
- `GET /api/v1/jobs` (админский API) → 20 задач, **все `status:3` (completed), `stage:4`, `progressPercent:100`**. Ни одной активной.
- `GET /api/public/v1/me` → `concurrent: {limit: 10}` — счётчик активных не отдаётся.
- Создание через админский `POST /api/v1/jobs` работает (201), отмена `POST /jobs/{id}/cancel` работает (204).
- Публичный `POST /tasks` при этом продолжает отдавать 422.

## Вывод

Все задачи завершены, но счётчик «concurrent jobs» на бэкенде не освободился (застрял на 10). Похоже на баг: completed-задачи не возвращают слоты в пул.

## Запрос в поддержку

Просьба сбросить счётчик concurrent jobs для тенанта `1d7e6627-5417-4bab-a324-46f9d7482eaf` (или исправить освобождение слотов при завершении задач). Все 20 jobs в статусе completed, активных нет, но лимит 10 считается исчерпанным.
