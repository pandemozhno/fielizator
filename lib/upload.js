'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

/* ============================================================
 *                          Errors
 * ============================================================ */

class UploadError extends Error {
  constructor(message, code = 'UPLOAD_ERROR', status = 400) {
    super(message);
    this.name = 'UploadError';
    this.code = code;
    this.status = status;
  }
}

/* ============================================================
 *                         Constants
 * ============================================================ */

const DATA_URL_RE = /^data:([^;,]*)((?:;[^,]*)*),(.*)$/s;
const BASE64_RE = /^[A-Za-z0-9+/=\s]+$/;
const WRITE_HWM = 64 * 1024;

const EXT_MAP = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
  'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg',
  'application/pdf': '.pdf', 'text/plain': '.txt',
  'application/json': '.json', 'application/zip': '.zip',
  'video/mp4': '.mp4', 'audio/mpeg': '.mp3',
};

// Сигнатуры для sniffMimetype
const MAGIC = [
  { mime: 'image/png',  ext: '.png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', ext: '.jpg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif',  ext: '.gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', ext: '.webp', bytes: [0x52, 0x49, 0x46, 0x46] },
  { mime: 'application/pdf', ext: '.pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  { mime: 'application/zip', ext: '.zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { mime: 'audio/mpeg', ext: '.mp3', bytes: [0x49, 0x44, 0x33] },
];

/* ============================================================
 *                          Helpers
 * ============================================================ */

function parseDataUrl(str) {
  const m = str.match(DATA_URL_RE);
  if (!m) return null;
  const mimetype = m[1] || 'application/octet-stream';
  const isBase64 = /;base64/i.test(m[2] || '');
  try {
    const data = isBase64
      ? Buffer.from(m[3], 'base64')
      : Buffer.from(decodeURIComponent(m[3]), 'utf8');
    return { data, mimetype };
  } catch (_) {
    return null;
  }
}

function guessExt(mimetype) {
  return EXT_MAP[mimetype] || '';
}

function sniffMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 3) return null;
  for (const sig of MAGIC) {
    if (buf.length < sig.bytes.length) continue;
    let ok = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (buf[i] !== sig.bytes[i]) { ok = false; break; }
    }
    if (ok) return { mimetype: sig.mime, ext: sig.ext };
  }
  return null;
}

function isByteArray(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  const n = Math.min(arr.length, 64);
  for (let i = 0; i < n; i++) {
    const v = arr[i];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 255) {
      return false;
    }
  }
  return true;
}

function tryExtractFile(value, fieldName, allowPlainBase64) {
  // 1. Голый массив байт
  if (isByteArray(value)) {
    return {
      data: Buffer.from(value),
      mimetype: 'application/octet-stream',
      originalname: fieldName,
    };
  }

  // 2. Строка: data URL или чистая base64
  if (typeof value === 'string') {
    const du = parseDataUrl(value);
    if (du) {
      return {
        data: du.data,
        mimetype: du.mimetype,
        originalname: fieldName + guessExt(du.mimetype),
      };
    }
    if (allowPlainBase64 && value.length > 0 && BASE64_RE.test(value)) {
      const cleaned = value.replace(/\s/g, '');
      if (cleaned.length % 4 === 0) {
        return {
          data: Buffer.from(cleaned, 'base64'),
          mimetype: 'application/octet-stream',
          originalname: fieldName,
        };
      }
    }
    return null;
  }

  // 3. Объект { data, name?, encoding?, mimetype? }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const raw = value.data;
    let data = null;

    if (Buffer.isBuffer(raw)) {
      data = raw;
    } else if (isByteArray(raw)) {
      data = Buffer.from(raw);
    } else if (typeof raw === 'string') {
      const enc = (value.encoding || 'base64').toLowerCase();
      if (enc === 'base64') data = Buffer.from(raw, 'base64');
      else if (enc === 'utf8' || enc === 'utf-8') data = Buffer.from(raw, 'utf8');
      else if (enc === 'hex') data = Buffer.from(raw, 'hex');
      else if (enc === 'latin1' || enc === 'binary') data = Buffer.from(raw, 'latin1');
      else data = Buffer.from(raw, enc);
    } else {
      return null;
    }

    const mimetype =
      value.mimetype || value.contentType || 'application/octet-stream';
    const originalname =
      value.name || value.filename || fieldName + guessExt(mimetype);
    return { data, mimetype, originalname };
  }

  return null;
}

function defaultFilename(originalname) {
  const ext = path.extname(originalname || '');
  return Date.now().toString(36) + '-' + crypto.randomBytes(8).toString('hex') + ext;
}

/** Полностью читает поток с ограничением по размеру. */
function readBody(stream, maxSize) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;

    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      fn(arg);
    };

    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxSize) {
        finish(reject, new UploadError(
          `JSON body too large (> ${maxSize} bytes)`,
          'LIMIT_BODY_SIZE', 413,
        ));
        stream.destroy();
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => finish(resolve, Buffer.concat(chunks)));
    stream.on('error', (e) => finish(reject, e));
    stream.on('aborted', () => finish(reject, new UploadError(
      'Request aborted', 'REQUEST_ABORTED', 499,
    )));
  });
}

/* ============================================================
 *                          Upload
 * ============================================================ */

class Upload {
  constructor(options = {}) {
    this._dest       = options.dest || 'uploads';
    this._maxSize    = options.limits?.fileSize || 50 * 1024 * 1024;
    this._maxCount   = options.limits?.files || 20;
    this._filenameFn = options.filename || null;
    this._jsonLimit  = options.jsonBodyLimit || null;
    this._fileFilter = options.fileFilter || null;
    this._sniff      = !!options.sniffMimetype;
  }

  _clone(patch) {
    const c = Object.create(Upload.prototype);
    Object.assign(c, this);
    Object.assign(c, patch);
    return c;
  }

  /* ---------- chainable options ---------- */

  to(dir)            { return this._clone({ _dest: dir }); }
  filename(fn)       { return this._clone({ _filenameFn: fn }); }
  fileFilter(fn)     { return this._clone({ _fileFilter: fn }); }
  jsonLimit(bytes)   { return this._clone({ _jsonLimit: bytes }); }
  sniffMimetype(on = true) { return this._clone({ _sniff: !!on }); }

  limits(opts = {}) {
    return this._clone({
      _maxSize:  opts.fileSize ?? this._maxSize,
      _maxCount: opts.files    ?? this._maxCount,
    });
  }

  /* ---------- middleware factories ---------- */

  single(field)            { return this._middleware({ mode: 'single', field }); }
  array(field, maxCount=10){ return this._middleware({ mode: 'array', field, maxCount }); }
  any()                    { return this._middleware({ mode: 'any', maxCount: this._maxCount }); }
  none()                   { return this._middleware({ mode: 'none' }); }
  fields(defs)             { return this._middleware({ mode: 'fields', defs }); }

  /* ============================================================
   *                       Middleware
   * ============================================================ */

  _middleware(spec) {
    const self = this;

    return async function uploadMiddleware(req, _res, next) {
      const written = new Set();
      const cleanup = async () => {
        if (written.size === 0) return;
        await Promise.all(
          [...written].map((p) => fsp.unlink(p).catch(() => {})),
        );
        written.clear();
      };

      try {
        const dest = typeof self._dest === 'function'
          ? self._dest(req)
          : self._dest;
        if (!dest) throw new UploadError('upload: destination not set');

        const ct = (req.headers['content-type'] || '').toLowerCase();

        if (ct.startsWith('multipart/form-data')) {
          const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
          if (!m) throw new UploadError('Multipart: boundary not found');
          await fsp.mkdir(dest, { recursive: true });

          const parser = new MultipartParser(m[1] || m[2]);
          const { fields, files } = await parser.parse(req, {
            dest, written, spec, self,
          });

          req.body = fields;
          assignResult(req, spec, files);
        } else if (ct.includes('json')) {
          await fsp.mkdir(dest, { recursive: true });
          await self._handleJson(req, dest, spec, written);
        } else {
          return next(); // нет файлов — ничего не делаем
        }

        next();
      } catch (err) {
        await cleanup();
        next(err);
      }
    };
  }

  /* ============================================================
   *                          JSON
   * ============================================================ */

  async _handleJson(req, dest, spec, written) {
    const body = await this._getJsonBody(req, spec.maxCount);

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new UploadError('upload: JSON body must be an object');
    }

    const save = (f, fieldname) =>
      this._saveFile(f, fieldname, dest, req, written);

    const { mode, field, maxCount = this._maxCount, defs } = spec;

    if (mode === 'none') {
      req.body = body;
      req.file = undefined;
      req.files = undefined;
      return;
    }

    if (mode === 'single') {
      if (!(field in body)) {
        req.body = body;
        req.file = null;
        return;
      }
      const f = tryExtractFile(body[field], field, true);
      if (!f) throw new UploadError(`upload: field "${field}" is not a valid file`);
      req.file = await save(f, field);
      req.files = undefined;
      delete body[field];
      req.body = body;
      return;
    }

    if (mode === 'array') {
      if (!(field in body)) {
        req.body = body;
        req.files = [];
        return;
      }
      let values = body[field];
      if (isByteArray(values)) values = [values];   // один файл
      if (!Array.isArray(values)) {
        throw new UploadError(`upload: field "${field}" must be an array`);
      }
      if (values.length > maxCount) {
        throw new UploadError(
          `upload: too many files (${values.length} > ${maxCount})`,
          'LIMIT_FILE_COUNT', 413,
        );
      }
      const saved = [];
      for (const v of values) {
        const f = tryExtractFile(v, field, true);
        if (!f) throw new UploadError(`upload: invalid file in "${field}"`);
        saved.push(await save(f, field));
      }
      req.files = saved;
      req.file = undefined;
      delete body[field];
      req.body = body;
      return;
    }

    if (mode === 'fields') {
      req.files = {};
      for (const { name, maxCount: mc = 1 } of defs) {
        if (!(name in body)) continue;
        const raw = body[name];
        const arr = Array.isArray(raw) ? raw : [raw];
        if (arr.length > mc) {
          throw new UploadError(
            `upload: too many files for "${name}" (${arr.length} > ${mc})`,
            'LIMIT_FILE_COUNT', 413,
          );
        }
        const saved = [];
        for (const v of arr) {
          const f = tryExtractFile(v, name, true);
          if (!f) throw new UploadError(`upload: invalid file in "${name}"`);
          saved.push(await save(f, name));
        }
        req.files[name] = saved;
        delete body[name];
      }
      req.file = undefined;
      req.body = body;
      return;
    }

    // any
    const saved = [];
    for (const key of Object.keys(body)) {
      const value = body[key];

      if (isByteArray(value)) {
        const f = tryExtractFile(value, key, false);
        if (f) {
          saved.push(await save(f, key));
          delete body[key];
        }
        continue;
      }

      if (Array.isArray(value)) {
        const allByteArrays = value.length > 0 && value.every(isByteArray);
        if (allByteArrays) {
          for (const v of value) {
            const f = tryExtractFile(v, key, false);
            if (f) saved.push(await save(f, key));
          }
          delete body[key];
          continue;
        }
        const kept = [];
        for (const v of value) {
          const f = tryExtractFile(v, key, false);
          if (f) saved.push(await save(f, key));
          else kept.push(v);
        }
        if (kept.length === 0) delete body[key];
        else body[key] = kept;
        continue;
      }

      const f = tryExtractFile(value, key, false);
      if (f) {
        saved.push(await save(f, key));
        delete body[key];
      }
    }
    req.files = saved;
    req.file = undefined;
    req.body = body;
  }

  async _getJsonBody(req, maxCount) {
    // body-parser (express.json) уже прочитал поток?
    if (req.readableEnded || req._body === true) {
      return req.body ?? {};
    }
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)
        && Object.keys(req.body).length > 0) {
      return req.body;
    }

    const limit = this._jsonLimit
      || Math.max(this._maxSize * Math.max(maxCount || 1, 1) * 2, 1024 * 1024);

    const raw = await readBody(req, limit);
    if (raw.length === 0) return {};

    try {
      return JSON.parse(raw.toString('utf8'));
    } catch (e) {
      throw new UploadError('upload: invalid JSON — ' + e.message);
    }
  }

  /* ============================================================
   *                       Save file
   * ============================================================ */

  async _saveFile({ data, mimetype, originalname }, fieldname, dest, req, written) {
    if (data.length > this._maxSize) {
      throw new UploadError(
        `File too large (${data.length} > ${this._maxSize})`,
        'LIMIT_FILE_SIZE', 413,
      );
    }

    // MIME по сигнатуре (если включено)
    if (this._sniff) {
      const sniffed = sniffMime(data);
      if (sniffed) {
        mimetype = sniffed.mimetype;
        if (!path.extname(originalname)) {
          originalname = originalname + sniffed.ext;
        }
      }
    }

    const file = {
      fieldname,
      originalname,
      mimetype,
      size: data.length,
    };

    if (this._fileFilter) {
      const ok = await Promise.resolve(this._fileFilter(req, file));
      if (!ok) {
        throw new UploadError(
          `File "${originalname}" rejected by filter`,
          'LIMIT_UNEXPECTED_FILE', 400,
        );
      }
    }

    const filename = this._filenameFn
      ? this._filenameFn({ originalname })
      : defaultFilename(originalname);

    const filepath = path.join(dest, filename);
    written.add(filepath);

    await fsp.writeFile(filepath, data);

    return {
      ...file,
      filename,
      path: filepath,
      destination: dest,
    };
  }
}

/* ============================================================
 *            Раскладка файлов по req.file / req.files
 * ============================================================ */

function assignResult(req, spec, files) {
  const { mode } = spec;
  if (mode === 'none') {
    req.file = undefined;
    req.files = undefined;
  } else if (mode === 'single') {
    req.file = files[0] || null;
    req.files = undefined;
  } else if (mode === 'array' || mode === 'any') {
    req.files = files;
    req.file = undefined;
  } else if (mode === 'fields') {
    const grouped = {};
    for (const f of files) {
      (grouped[f.fieldname] ||= []).push(f);
    }
    req.files = grouped;
    req.file = undefined;
  }
}

/* ============================================================
 *                Multipart form-data parser
 * ============================================================ */

class MultipartParser {
  constructor(boundary) {
    this.boundary = Buffer.from('--' + boundary);
  }

  parse(stream, ctx) {
    const { dest, written, spec, self } = ctx;
    const { mode, field, maxCount = self._maxCount, defs } = spec;
    const destFieldSet = mode === 'fields'
      ? new Set(defs.map((d) => d.name))
      : null;
    const destMaxPerField = mode === 'fields'
      ? new Map(defs.map((d) => [d.name, d.maxCount || 1]))
      : null;

    const boundaryBuf = this.boundary;
    const bodyDelim = Buffer.concat([Buffer.from('\r\n'), boundaryBuf]);
    const maxSize = self._maxSize;

    const fields = {};
    const files = [];

    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      let state = 'preamble';
      let currentHeaders = null;
      let writeStream = null;
      let currentFile = null;
      let currentFilePath = null;
      let fileSize = 0;
      let fieldChunks = null;
      let streamError = null;
      let finished = false;

      const fail = async (err) => {
        if (finished) return;
        finished = true;
        try { if (writeStream) writeStream.destroy(); } catch (_) {}
        if (currentFilePath) {
          try { await fsp.unlink(currentFilePath); } catch (_) {}
          written.delete(currentFilePath);
        }
        reject(err);
      };

      const parseHeaders = (str) => {
        const out = {};
        for (const line of str.split('\r\n')) {
          const i = line.indexOf(':');
          if (i === -1) continue;
          const key = line.slice(0, i).trim().toLowerCase();
          const value = line.slice(i + 1).trim();

          if (key === 'content-disposition') {
            const n = value.match(/\bname="((?:[^"\\]|\\.)*)"/);
            if (n) out.name = n[1];

            // filename*= (RFC 5987)
            const fStar = value.match(/filename\*=([^']*)'[^']*'([^;]+)/i);
            if (fStar) {
              try { out.filename = decodeURIComponent(fStar[2]); }
              catch (_) { out.filename = fStar[2]; }
            } else {
              const f = value.match(/\bfilename="((?:[^"\\]|\\.)*)"/);
              if (f) out.filename = f[1];
            }
          } else if (key === 'content-type') {
            out.contentType = value;
          }
        }
        return out;
      };

      const makeFilename = (original) => {
        if (self._filenameFn) return self._filenameFn({ originalname: original });
        return defaultFilename(original);
      };

      const writeChunk = async (data) => {
        if (!data.length) return;
        if (streamError) throw streamError;

        if (writeStream) {
          if (fileSize + data.length > maxSize) {
            throw new UploadError(
              `File too large (limit ${maxSize})`,
              'LIMIT_FILE_SIZE', 413,
            );
          }
          fileSize += data.length;
          const ok = writeStream.write(data);
          if (!ok) {
            await new Promise((res, rej) => {
              const onDrain = () => { cleanup(); res(); };
              const onErr   = (e) => { cleanup(); rej(e); };
              const cleanup = () => {
                writeStream.removeListener('drain', onDrain);
                writeStream.removeListener('error', onErr);
              };
              writeStream.once('drain', onDrain);
              writeStream.once('error', onErr);
            });
          }
        } else if (fieldChunks) {
          fieldChunks.push(data);
        }
      };

      const endPart = async () => {
        if (writeStream) {
          const ws = writeStream;
          writeStream = null;
          await new Promise((res, rej) =>
            ws.end((err) => (err ? rej(err) : res())),
          );

          if (currentFile) {
            currentFile.size = fileSize;

            const name = currentFile.fieldname;
            const isTarget =
              mode === 'any' ||
              mode === 'array' && name === field ||
              mode === 'single' && name === field ||
              mode === 'fields' && destFieldSet.has(name);

            let accepted = isTarget;
            if (accepted && self._fileFilter) {
              const ok = await Promise.resolve(self._fileFilter(
                null, // req недоступен тут — упростим; см. ниже
                {
                  fieldname: name,
                  originalname: currentFile.originalname,
                  mimetype: currentFile.mimetype,
                  size: fileSize,
                },
              ));
              if (!ok) accepted = false;
            }

            if (accepted) {
              const allowPush =
                mode === 'any' || mode === 'array' || mode === 'fields'
                  ? files.filter((f) => f.fieldname === name).length
                      < (destMaxPerField?.get(name) || maxCount)
                  : files.length === 0;
              if (allowPush) files.push(currentFile);
            }
            currentFile = null;
            currentFilePath = null;
          }
        }

        if (currentHeaders && currentHeaders.name && !currentHeaders.filename) {
          const value = fieldChunks ? Buffer.concat(fieldChunks).toString('utf8') : '';
          const name = currentHeaders.name;
          if (name in fields) {
            if (Array.isArray(fields[name])) fields[name].push(value);
            else fields[name] = [fields[name], value];
          } else {
            fields[name] = value;
          }
        }

        currentHeaders = null;
        fieldChunks = null;
        fileSize = 0;
      };

      const processBuffer = async (isFinal) => {
        while (true) {
          if (state === 'preamble') {
            const idx = buffer.indexOf(boundaryBuf);
            if (idx === -1) {
              if (buffer.length > boundaryBuf.length) {
                buffer = buffer.slice(buffer.length - boundaryBuf.length);
              }
              if (isFinal) throw new UploadError('Multipart: no boundary found');
              return;
            }
            buffer = buffer.slice(idx + boundaryBuf.length);
            state = 'afterBoundary';
          }

          if (state === 'afterBoundary') {
            if (buffer.length < 2) {
              if (isFinal) throw new UploadError('Multipart: unexpected end');
              return;
            }
            const two = buffer.slice(0, 2).toString();
            if (two === '--') {
              state = 'done';
              buffer = buffer.slice(2);
            } else if (two === '\r\n') {
              state = 'headers';
              buffer = buffer.slice(2);
            } else {
              throw new UploadError('Multipart: invalid boundary separator');
            }
          }

          if (state === 'headers') {
            const idx = buffer.indexOf('\r\n\r\n');
            if (idx === -1) {
              if (isFinal) throw new UploadError('Multipart: incomplete headers');
              return;
            }
            const headerStr = buffer.slice(0, idx).toString('utf8');
            buffer = buffer.slice(idx + 4);
            currentHeaders = parseHeaders(headerStr);

            const isTarget =
              mode === 'any' || !field || currentHeaders.name === field ||
              (mode === 'fields' && destFieldSet.has(currentHeaders.name));

            const hasFilename =
              'filename' in currentHeaders && currentHeaders.filename !== '';

            if (hasFilename && isTarget) {
              const filename = makeFilename(
                path.basename(currentHeaders.filename),
              );
              currentFilePath = path.join(dest, filename);
              written.add(currentFilePath);

              currentFile = {
                fieldname: currentHeaders.name,
                originalname: currentHeaders.filename,
                filename,
                path: currentFilePath,
                destination: dest,
                mimetype: currentHeaders.contentType || 'application/octet-stream',
                size: 0,
              };

              writeStream = fs.createWriteStream(currentFilePath, {
                highWaterMark: WRITE_HWM,
              });
              writeStream.on('error', (err) => { streamError = err; });
              fileSize = 0;
              fieldChunks = null;
            } else if (!hasFilename) {
              fieldChunks = [];
              writeStream = null;
              currentFile = null;
              currentFilePath = null;
            } else {
              writeStream = null;
              currentFile = null;
              currentFilePath = null;
              fieldChunks = null;
            }
            state = 'body';
          }

          if (state === 'body') {
            const idx = buffer.indexOf(bodyDelim);
            if (idx === -1) {
              const safeLen = buffer.length - bodyDelim.length + 1;
              if (safeLen > 0) {
                await writeChunk(buffer.slice(0, safeLen));
                buffer = buffer.slice(safeLen);
              }
              if (isFinal) await endPart();
              return;
            }
            if (idx > 0) await writeChunk(buffer.slice(0, idx));
            buffer = buffer.slice(idx + bodyDelim.length);
            await endPart();
            state = 'afterBoundary';
          }

          if (state === 'done') return;
        }
      };

      stream.on('data', (chunk) => {
        if (finished) return;
        stream.pause();
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
        processBuffer(false)
          .then(() => { if (!finished) stream.resume(); })
          .catch(fail);
      });

      stream.on('end', () => {
        if (finished) return;
        processBuffer(true)
          .then(() => {
            if (finished) return;
            finished = true;
            resolve({ fields, files });
          })
          .catch(fail);
      });

      stream.on('error', fail);
      stream.on('aborted', () => fail(new UploadError(
        'Request aborted', 'REQUEST_ABORTED', 499,
      )));
    });
  }
}

/* ============================================================
 *                          Export
 * ============================================================ */

module.exports = new Upload();
module.exports.Upload = Upload;
module.exports.UploadError = UploadError;