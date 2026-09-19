# upload

Лёгкий middleware для загрузки файлов в Express — **без зависимостей** и **без multer**. Поддерживает `multipart/form-data` и `application/json` (включая data URL, base64, массивы байт и `Buffer`).

```js
const upload = require('./upload');

app.post('/avatar',
  upload.to('uploads/avatars').single('file'),
  (req, res) => res.json({ file: req.file }),
);
```

---

## Содержание

- [Возможности](#возможности)
- [Требования](#требования)
- [Установка](#установка)
- [Быстрый старт](#быстрый-старт)
- [API](#api)
  - [Методы цепочки](#методы-цепочки)
  - [Middleware-фабрики](#middleware-фабрики)
- [Форматы запросов](#форматы-запросов)
  - [multipart/form-data](#multipartform-data)
  - [application/json](#applicationjson)
- [Объект файла](#объект-файла)
- [Ошибки](#ошибки)
- [Примеры](#примеры)
- [Ограничения](#ограничения)
- [Лицензия](#лицензия)

---

## Возможности

- 🚫 **Ноль зависимостей** — собственный streaming-парсер multipart.
- 🔀 **Два формата тела** — `multipart/form-data` и `application/json`.
- 📦 **5 способов передать файл в JSON**: data URL, base64-строка, `{data,name}`, массив байт, `Buffer`.
- ⚡ **Streaming** — файлы из multipart пишутся на диск сразу, без буферизации в памяти.
- 🎯 **Fluent API**: `upload.to('dir').limits({...}).single('file')`.
- 🧹 **Автоочистка** — при ошибке все частично записанные файлы удаляются.
- 🛡️ **Лимиты**, `fileFilter`, sniffing MIME по сигнатуре.
- 🔒 **Иммутабельный API** — `upload.to('a')` не мутирует базовый инстанс.
- 🧩 Совместим с `express.json()` — если body уже прочитан, используем его.

---

## Требования

- **Node.js ≥ 14** (используются `fs.promises`, `??`, `?.`).
- **Express 4 или 5**.

---

## Установка

Модуль не требует npm-пакетов — просто скопируйте `upload.js` в проект:

```
project/
├── upload.js
├── server.js
└── package.json
```

И импортируйте:

```js
const upload = require('./upload');
```

---

## Быстрый старт

```js
const express = require('express');
const upload = require('./upload');

const app = express();

// Один файл
app.post('/avatar',
  upload.to('uploads/avatars').single('file'),
  (req, res) => res.json({ file: req.file }),
);

// Несколько файлов
app.post('/photos',
  upload.to('uploads/photos').array('photos', 5),
  (req, res) => res.json({ files: req.files }),
);

// Динамическая папка
app.post('/user-upload',
  upload.to((req) => `uploads/users/${req.user?.id ?? 'anon'}`).single('file'),
  (req, res) => res.json({ file: req.file }),
);

// Обработчик ошибок
app.use((err, req, res, next) => {
  if (err?.name === 'UploadError') {
    return res.status(err.status).json({ error: err.code, message: err.message });
  }
  next(err);
});

app.listen(3000);
```

---

## API

### Методы цепочки

Все методы возвращают **новый** инстанс — базовый `upload` не меняется.

#### `.to(dir)`

Папка назначения. Может быть строкой или функцией `(req) => string`.

```js
upload.to('uploads/avatars')
upload.to((req) => `uploads/${req.user.id}`)
```

Папка создаётся автоматически (рекурсивно).

#### `.limits({ fileSize, files })`

- `fileSize` — максимальный размер одного файла в байтах (по умолчанию `50 * 1024 * 1024`).
- `files` — максимальное количество файлов (по умолчанию `20`).

```js
upload.limits({ fileSize: 5 * 1024 * 1024, files: 3 })
```

#### `.filename(fn)`

Функция генерации имени файла. Получает `{ originalname }`, возвращает строку.

```js
upload.filename(({ originalname }) => `${Date.now()}-${originalname}`)
```

По умолчанию: `timestamp-randomHex + ext`.

#### `.fileFilter(fn)`

Фильтр файлов. Функция `(req, file) => boolean | Promise<boolean>`. Если `false` — ошибка `LIMIT_UNEXPECTED_FILE`.

> В multipart-режиме `req === null`, потому что парсер работает до передачи управления в middleware.

```js
upload.fileFilter((req, file) => file.mimetype.startsWith('image/'))
```

#### `.sniffMimetype(on = true)`

Определяет MIME по сигнатуре файла. Поддерживаются PNG, JPEG, GIF, WEBP, PDF, ZIP, MP3. Если у имени нет расширения — оно дописывается.

```js
upload.sniffMimetype()
```

#### `.jsonLimit(bytes)`

Явный лимит на размер JSON-тела. По умолчанию `fileSize × files × 2` (минимум 1 МБ).

```js
upload.jsonLimit(50 * 1024 * 1024)
```

---

### Middleware-фабрики

Возвращают обычный express-middleware `(req, res, next)`.

#### `.single(field)`

Один файл в `req.file`.

```js
app.post('/upload', upload.to('uploads').single('file'), handler)
// req.file = { fieldname, originalname, ... } | null
```

#### `.array(field, maxCount = 10)`

Массив файлов (все с одним именем поля) в `req.files`.

```js
app.post('/upload', upload.to('uploads').array('photos', 5), handler)
// req.files = [ { ... }, { ... } ]
```

#### `.any()`

Любые файлы в `req.files`.

```js
app.post('/upload', upload.to('uploads').any(), handler)
```

#### `.none()`

Принимает **только** текстовые поля. Файлы → ошибка.

```js
app.post('/comments', upload.to('uploads').none(), handler)
// req.body  = { text: '...' }
// req.file  === undefined
// req.files === undefined
```

#### `.fields([{ name, maxCount }, ...])`

Разные поля — `req.files` становится объектом.

```js
app.post('/profile',
  upload.to('uploads/profile').fields([
    { name: 'avatar',  maxCount: 1  },
    { name: 'gallery', maxCount: 10 },
  ]),
  (req, res) => res.json({ files: req.files }),
);
// req.files.avatar  = [ ... ]
// req.files.gallery = [ ... ]
```

---

## Форматы запросов

### multipart/form-data

Классическая отправка формы с файлами. Парсер стримит данные сразу на диск.

```bash
curl -F "file=@photo.png" http://localhost:3000/upload
```

Особенности:

- Поддерживается `filename*=` (RFC 5987) — UTF-8 имена.
- Текстовые поля попадают в `req.body`.
- Повторяющиеся поля собираются в массив.

---

### application/json

Тело — JSON-объект. Поле, объявленное в `.single(field)` / `.array(field)` / `.fields(...)`, извлекается как файл и удаляется из `req.body`. В режиме `.any()` файлы распознаются по «похожести» на файл, а обычные значения остаются в `req.body`.

#### 1. Data URL

```json
{
  "file": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg..."
}
```

```js
app.post('/upload', upload.to('uploads').single('file'), handler);
// req.file.mimetype     === 'image/png'
// req.file.originalname === 'file.png'
```

#### 2. Объект с полями

```json
{
  "title": "Отчёт",
  "file": {
    "name": "report.pdf",
    "mimetype": "application/pdf",
    "encoding": "base64",
    "data": "JVBERi0xLjQKJ..."
  }
}
```

```js
// req.file.originalname === 'report.pdf'
// req.file.mimetype     === 'application/pdf'
// req.body.title        === 'Отчёт'
// req.body.file         === undefined
```

Поддерживаемые `encoding`: `base64` (по умолчанию), `utf8`, `hex`, `latin1`.

#### 3. Чистая base64

Только для полей, объявленных явно (`.single` / `.array` / `.fields`).

```json
{ "file": "iVBORw0KGgoAAAANSUhEUg..." }
```

```js
app.post('/upload', upload.to('uploads').single('file'), handler);
```

#### 4. Массив байт

```json
{
  "file": [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]
}
```

```js
app.post('/upload', upload.to('uploads').single('file'), handler);
// req.file.mimetype === 'application/octet-stream'
// req.file.size     === 12
```

#### 5. Массив байт внутри объекта

```json
{
  "file": {
    "name": "cat.png",
    "mimetype": "image/png",
    "data": [137, 80, 78, 71, 13, 10, 26, 10]
  }
}
```

#### 6. Несколько файлов

Массив массивов байт:

```json
{
  "photos": [
    [137, 80, 78, 71],
    [71, 73, 70, 56, 57, 97]
  ]
}
```

Смешанный массив:

```json
{
  "photos": [
    [137, 80, 78, 71],
    "data:image/jpeg;base64,/9j/4AAQ...",
    { "name": "b.gif", "data": [71, 73, 70, 56] }
  ]
}
```

Оба работают через `.array('photos', 10)` или `.any()`.

---

## Объект файла

```ts
{
  fieldname: string;      // имя поля из формы
  originalname: string;   // исходное имя файла
  filename: string;       // итоговое имя (по .filename() или по умолчанию)
  path: string;           // полный путь на диске
  destination: string;    // папка назначения
  mimetype: string;       // MIME-тип
  size: number;           // размер в байтах
}
```

---

## Ошибки

Все ошибки — экземпляры `UploadError`:

```ts
class UploadError extends Error {
  code: string;    // LIMIT_FILE_SIZE, LIMIT_FILE_COUNT, ...
  status: number;  // HTTP-статус
}
```

| `code`                  | `status` | Когда                                |
| ----------------------- | -------- | ------------------------------------ |
| `LIMIT_FILE_SIZE`       | 413      | Файл больше `limits.fileSize`        |
| `LIMIT_FILE_COUNT`      | 413      | Файлов больше `maxCount`             |
| `LIMIT_BODY_SIZE`       | 413      | JSON-тело больше `jsonLimit`         |
| `LIMIT_UNEXPECTED_FILE` | 400      | Файл отклонён `fileFilter`           |
| `REQUEST_ABORTED`       | 499      | Клиент разорвал соединение           |
| `UPLOAD_ERROR`          | 400      | Остальные ошибки (невалидный JSON и т. п.) |

При любой ошибке **все уже записанные файлы этого запроса удаляются**.

Пример обработчика:

```js
app.use((err, req, res, next) => {
  if (err?.name === 'UploadError') {
    return res.status(err.status).json({
      error: err.code,
      message: err.message,
    });
  }
  next(err);
});
```

---

## Примеры

### Аватар с проверкой MIME

```js
app.post('/avatar',
  upload
    .to('uploads/avatars')
    .limits({ fileSize: 5 * 1024 * 1024 })
    .sniffMimetype()
    .fileFilter((req, file) => file.mimetype.startsWith('image/'))
    .single('file'),
  (req, res) => res.json({ file: req.file }),
);
```

### Несколько документов и метаданные

```js
app.post('/docs',
  upload.to('uploads/docs').array('docs', 5),
  (req, res) => res.json({
    files: req.files,
    meta: req.body, // остальные поля из формы
  }),
);
```

### Загрузка в папку пользователя

```js
const auth = (req, res, next) => { req.user = { id: 42 }; next(); };

app.post('/me/upload',
  auth,
  upload.to((req) => `uploads/users/${req.user.id}`).single('file'),
  (req, res) => res.json({ file: req.file }),
);
```

### Только текстовые поля (без файлов)

```js
app.post('/comments',
  upload.to('uploads').none(),
  (req, res) => res.json({ body: req.body }),
);
```

### Загрузка base64 из JSON

```bash
curl -X POST http://localhost:3000/avatar \
  -H "Content-Type: application/json" \
  -d '{"file":"data:image/png;base64,iVBORw0KGgo..."}'
```

```js
app.post('/avatar',
  upload.to('uploads/avatars').sniffMimetype().single('file'),
  (req, res) => res.json({ file: req.file }),
);
```

### Загрузка массива байт из JSON

```bash
curl -X POST http://localhost:3000/avatar \
  -H "Content-Type: application/json" \
  -d '{"file":[137,80,78,71,13,10,26,10]}'
```

```js
app.post('/avatar',
  upload.to('uploads/avatars').sniffMimetype().single('file'),
  (req, res) => res.json({ file: req.file }),
);
// req.file.mimetype === 'image/png'
// req.file.filename оканчивается на .png
```

---

## Ограничения

- JSON-файлы буферизуются в памяти целиком (base64/массив байт парсится как строка/массив). Для больших файлов используйте `multipart/form-data`.
- Парсер multipart не поддерживает `Content-Transfer-Encoding: base64/quoted-printable` внутри частей и вложенный `multipart/mixed`.
- В `.fileFilter` для multipart `req === null` (парсер работает до вызова middleware).
- В режиме `.any()` вложенные в JSON объекты глубоко не обходятся — только один уровень.
- При совместном использовании с `express.json()` не забудьте увеличить его лимит:

  ```js
  app.use(express.json({ limit: '100mb' }));
  ```

- `.filename()` и `.fileFilter()` не защищают от `..` в имени файла, но `path.basename()` в парсере отбрасывает директории автоматически.

---

## Лицензия

MIT
