# fielizator

file upload middleware for Express. Supports `multipart/form-data` and `application/json` (data URLs, base64, byte arrays, and `Buffer`).

dependency busboy

```js
const upload = require('filelizator');

app.post('/avatar',
  upload.to('uploads/avatars').single('file'),
  (req, res) => res.json({ file: req.file }),
);
```

---

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [API](#api)
  - [Chainable methods](#chainable-methods)
  - [Middleware factories](#middleware-factories)
- [Request formats](#request-formats)
  - [multipart/form-data](#multipartform-data)
  - [application/json](#applicationjson)
- [File object](#file-object)
- [Errors](#errors)
- [Examples](#examples)
- [Limitations](#limitations)
- [License](#license)

---

## Features

- 🚫 **Zero dependencies** — own streaming multipart parser.
- 🔀 **Two body formats** — `multipart/form-data` and `application/json`.
- 📦 **5 ways to send a file in JSON**: data URL, plain base64, `{data,name}` object, byte array, `Buffer`.
- ⚡ **Streaming** — multipart files are written straight to disk, no in-memory buffering.
- 🎯 **Fluent API**: `upload.to('dir').limits({...}).single('file')`.
- 🧹 **Auto-cleanup** — partially written files are removed on error.
- 🛡️ **Limits**, `fileFilter`, and MIME sniffing by signature.
- 🔒 **Immutable API** — `upload.to('a')` never mutates the base instance.
- 🧩 Works alongside `express.json()` — reuses an already-parsed body.

---

## Requirements

- **Node.js ≥ 14** (uses `fs.promises`, `??`, `?.`).
- **Express 4 or 5**.

---

## Installation

### From npm

```bash
npm install fielizator
```

With yarn:

```bash
yarn add fielizator
```

With pnpm:

```bash
pnpm add fielizator
```

Then import it in your code:

```js
const express = require('express');
const upload = require('fielizator');

const app = express();
```

ESM:

```js
import express from 'express';
import upload from 'fielizator';
```

TypeScript — types are bundled, no extra `@types/*` package needed:

```ts
import express from 'express';
import upload from 'fielizator';
```

### From source (git)

```bash
git clone https://github.com/pandemozhno/filizator.git
cd fielizator
npm install
```

Or copy `index.js` manually into your project and `require('./index.js')`.

---

## Quick start

```js
const express = require('express');
const upload = require('fielizator');

const app = express();

// Single file
app.post('/avatar',
  upload.to('uploads/avatars').single('file'),
  (req, res) => res.json({ file: req.file }),
);

// Multiple files
app.post('/photos',
  upload.to('uploads/photos').array('photos', 5),
  (req, res) => res.json({ files: req.files }),
);

// Dynamic destination
app.post('/user-upload',
  upload.to((req) => `uploads/users/${req.user?.id ?? 'anon'}`).single('file'),
  (req, res) => res.json({ file: req.file }),
);

// Error handler
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

### Chainable methods

Every method returns a **new** instance — the base `upload` object is never mutated.

#### `.to(dir)`

Destination folder. A string or a function `(req) => string`.

```js
upload.to('uploads/avatars')
upload.to((req) => `uploads/${req.user.id}`)
```

The folder is created recursively if it doesn't exist.

#### `.limits({ fileSize, files })`

- `fileSize` — maximum size of a single file in bytes (default `50 * 1024 * 1024`).
- `files` — maximum number of files (default `20`).

```js
upload.limits({ fileSize: 5 * 1024 * 1024, files: 3 })
```

#### `.filename(fn)`

Filename generator. Receives `{ originalname }`, returns a string.

```js
upload.filename(({ originalname }) => `${Date.now()}-${originalname}`)
```

Default: `timestamp-randomHex + ext`.

#### `.fileFilter(fn)`

File filter. `(req, file) => boolean | Promise<boolean>`. Returning `false` raises `LIMIT_UNEXPECTED_FILE`.

> In multipart mode `req === null` because the parser runs before the middleware is invoked.

```js
upload.fileFilter((req, file) => file.mimetype.startsWith('image/'))
```

#### `.sniffMimetype(on = true)`

Detects MIME by file signature. Supports PNG, JPEG, GIF, WEBP, PDF, ZIP, MP3. If the filename has no extension, one is appended.

```js
upload.sniffMimetype()
```

#### `.jsonLimit(bytes)`

Explicit JSON body size limit. Defaults to `fileSize × files × 2` (min 1 MB).

```js
upload.jsonLimit(50 * 1024 * 1024)
```

---

### Middleware factories

Each returns a regular Express middleware `(req, res, next)`.

#### `.single(field)`

One file in `req.file`.

```js
app.post('/upload', upload.to('uploads').single('file'), handler);
// req.file = { fieldname, originalname, ... } | null
```

#### `.array(field, maxCount = 10)`

Array of files (same field name) in `req.files`.

```js
app.post('/upload', upload.to('uploads').array('photos', 5), handler);
// req.files = [ { ... }, { ... } ]
```

#### `.any()`

Any files in `req.files`.

```js
app.post('/upload', upload.to('uploads').any(), handler);
```

#### `.none()`

Accepts **only** text fields. Files produce an error.

```js
app.post('/comments', upload.to('uploads').none(), handler);
// req.body  = { text: '...' }
// req.file  === undefined
// req.files === undefined
```

#### `.fields([{ name, maxCount }, ...])`

Different fields — `req.files` becomes an object keyed by field name.

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

## Request formats

### multipart/form-data

Classic form upload. Files are streamed directly to disk.

```bash
curl -F "file=@photo.png" http://localhost:3000/upload
```

Notes:

- `filename*=` (RFC 5987) is supported — UTF-8 filenames work.
- Text fields end up in `req.body`.
- Repeated fields are collected into an array.

---

### application/json

The body is a JSON object. A field declared in `.single(field)` / `.array(field)` / `.fields(...)` is extracted as a file and removed from `req.body`. In `.any()` mode, files are detected by shape and regular values stay in `req.body`.

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

#### 2. Object with metadata

```json
{
  "title": "Report",
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
// req.body.title        === 'Report'
// req.body.file         === undefined
```

Supported `encoding` values: `base64` (default), `utf8`, `hex`, `latin1`.

#### 3. Plain base64

Only for fields declared explicitly via `.single` / `.array` / `.fields`.

```json
{ "file": "iVBORw0KGgoAAAANSUhEUg..." }
```

```js
app.post('/upload', upload.to('uploads').single('file'), handler);
```

#### 4. Byte array

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

#### 5. Byte array inside an object

```json
{
  "file": {
    "name": "cat.png",
    "mimetype": "image/png",
    "data": [137, 80, 78, 71, 13, 10, 26, 10]
  }
}
```

#### 6. Multiple files

Array of byte arrays:

```json
{
  "photos": [
    [137, 80, 78, 71],
    [71, 73, 70, 56, 57, 97]
  ]
}
```

Mixed array:

```json
{
  "photos": [
    [137, 80, 78, 71],
    "data:image/jpeg;base64,/9j/4AAQ...",
    { "name": "b.gif", "data": [71, 73, 70, 56] }
  ]
}
```

Both work with `.array('photos', 10)` or `.any()`.

---

## File object

```ts
{
  fieldname: string;      // form field name
  originalname: string;   // original filename
  filename: string;       // final filename (from .filename() or default)
  path: string;           // full disk path
  destination: string;    // destination folder
  mimetype: string;       // MIME type
  size: number;           // size in bytes
}
```

---

## Errors

All errors are instances of `UploadError`:

```ts
class UploadError extends Error {
  code: string;    // LIMIT_FILE_SIZE, LIMIT_FILE_COUNT, ...
  status: number;  // HTTP status
}
```

| `code`                  | `status` | When                                          |
| ----------------------- | -------- | --------------------------------------------- |
| `LIMIT_FILE_SIZE`       | 413      | File exceeds `limits.fileSize`                |
| `LIMIT_FILE_COUNT`      | 413      | More files than `maxCount`                    |
| `LIMIT_BODY_SIZE`       | 413      | JSON body exceeds `jsonLimit`                 |
| `LIMIT_UNEXPECTED_FILE` | 400      | File rejected by `fileFilter`                 |
| `REQUEST_ABORTED`       | 499      | Client aborted the request                    |
| `UPLOAD_ERROR`          | 400      | Any other error (invalid JSON, non-file field)|

On any error **all files already written for that request are removed**.

Example handler:

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

## Examples

### Avatar with MIME check

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

### Multiple documents with metadata

```js
app.post('/docs',
  upload.to('uploads/docs').array('docs', 5),
  (req, res) => res.json({
    files: req.files,
    meta: req.body, // remaining form fields
  }),
);
```

### Upload into a user-specific folder

```js
const auth = (req, res, next) => { req.user = { id: 42 }; next(); };

app.post('/me/upload',
  auth,
  upload.to((req) => `uploads/users/${req.user.id}`).single('file'),
  (req, res) => res.json({ file: req.file }),
);
```

### Text fields only (no files)

```js
app.post('/comments',
  upload.to('uploads').none(),
  (req, res) => res.json({ body: req.body }),
);
```

### Base64 upload via JSON

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

### Byte array upload via JSON

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
// req.file.filename ends with .png
```

---

## Limitations

- JSON files are buffered entirely in memory (base64 / byte arrays are parsed as strings / arrays). For large files use `multipart/form-data`.
- The multipart parser does not support `Content-Transfer-Encoding: base64/quoted-printable` inside parts, nor nested `multipart/mixed`.
- In `.fileFilter` for multipart, `req === null` (the parser runs before the middleware is invoked).
- In `.any()` mode, nested JSON objects are not traversed deeply — only one level.
- When used together with `express.json()`, remember to raise its limit:

  ```js
  app.use(express.json({ limit: '100mb' }));
  ```

- `.filename()` and `.fileFilter()` do not protect against `..` in a filename, but `path.basename()` in the parser strips directories automatically.

---

## License

[MIT](./LICENSE)
