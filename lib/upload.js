'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const Busboy = require('busboy');

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

const BAD_FIELD_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const DEFAULT_FIELD_SIZE = 1 * 1024 * 1024;   // максимальный размер текстового поля
const DEFAULT_JSON_LIMIT = 10 * 1024 * 1024;  // максимальный размер JSON-тела
const MIN_PLAIN_B64 = 32;

const EXT_MAP = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
  'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg',
  'image/avif': '.avif', 'image/heic': '.heic',
  'application/pdf': '.pdf', 'text/plain': '.txt',
  'application/json': '.json', 'application/zip': '.zip',
  'video/mp4': '.mp4', 'video/quicktime': '.mov',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav',
};

// Сигнатуры для sniffMime
const MAGIC = [
  { mime: 'image/png',  ext: '.png',  bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', ext: '.jpg',  bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif',  ext: '.gif',  bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'application/pdf', ext: '.pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  { mime: 'application/zip', ext: '.zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { mime: 'audio/mpeg', ext: '.mp3',  bytes: [0x49, 0x44, 0x33] },
  // RIFF....WEBP — сигнатура "WEBP" на смещении 8
  { mime: 'image/webp', ext: '.webp', offset: 8,
    bytes: [0x57, 0x45, 0x42, 0x50] },
];

/* ============================================================
 *                          Helpers
 * ============================================================ */

function isBadFieldName(name) {
  return typeof name !== 'string' || name === '' || BAD_FIELD_NAMES.has(name);
}

function safeFilename(name) {
  return String(name)
    .replace(/[\\/]+/g, '_')
    .replace(/\0/g, '')
    .trim() || 'file';
}

function safeJoin(dest, filename) {
  const base = path.resolve(dest);
  const full = path.resolve(base, safeFilename(filename));
  const rel = path.relative(base, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new UploadError('upload: unsafe filename', 'BAD_FILENAME', 400);
  }
  return full;
}

function parseDataUrl(str, maxLen) {
  if (typeof str !== 'string') return null;
  if (maxLen && str.length > maxLen) return null;
  const m = str.match(DATA_URL_RE);
  if (!m) return null;
  const mimetype = m[1] || 'application/octet-stream';
  const isBase64 = /(?:^|;)base64(?:;|$)/i.test(m[2] || '');
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
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  for (const sig of MAGIC) {
    const off = sig.offset || 0;
    if (buf.length < off + sig.bytes.length) continue;
    let ok = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (buf[off + i] !== sig.bytes[i]) { ok = false; break; }
    }
    if (ok) return { mimetype: sig.mime, ext: sig.ext };
  }
  return null;
}

function applySniff(originalname, mimetype, data, sniff) {
  if (!sniff) return { originalname, mimetype };
  const sniffed = sniffMime(data);
  if (!sniffed) return { originalname, mimetype };
  const ext = path.extname(originalname).toLowerCase();
  const newName =
    (ext ? originalname.slice(0, -ext.length) : originalname) + sniffed.ext;
  return { originalname: newName, mimetype: sniffed.mimetype };
}

function isByteArray(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  if (arr.length > 4 * 1024 * 1024) return false;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 255) {
      return false;
    }
  }
  return true;
}

function tryExtractFile(value, fieldName, opts = {}) {
  const allowPlainBase64 = !!opts.allowPlainBase64;
  const maxDataUrl = opts.maxDataUrl || 0;

  if (isByteArray(value)) {
    return {
      data: Buffer.from(value),
      mimetype: 'application/octet-stream',
      originalname: safeFilename(fieldName),
    };
  }

  if (typeof value === 'string') {
    const du = parseDataUrl(value, maxDataUrl);
    if (du) {
      return {
        data: du.data,
        mimetype: du.mimetype,
        originalname: safeFilename(fieldName) + guessExt(du.mimetype),
      };
    }
    if (allowPlainBase64
        && value.length >= MIN_PLAIN_B64
        && BASE64_RE.test(value)) {
      const cleaned = value.replace(/\s/g, '');
      if (cleaned.length % 4 === 0) {
        return {
          data: Buffer.from(cleaned, 'base64'),
          mimetype: 'application/octet-stream',
          originalname: safeFilename(fieldName),
        };
      }
    }
    return null;
  }

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
    const originalname = safeFilename(
      value.name || value.filename || fieldName + guessExt(mimetype),
    );
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
    stream.on('close', () => {
      if (!done && stream.destroyed && !stream.readableEnded) {
        finish(reject, new UploadError('Request aborted', 'REQUEST_ABORTED', 499));
      }
    });
  });
}

/* ============================================================
 *                          Upload
 * ============================================================ */

class Upload {
  constructor(options = {}) {
    this._dest       = options.dest || 'uploads';
    this._maxSize    = options.limits?.fileSize  || 50 * 1024 * 1024;
    this._maxCount   = options.limits?.files     || 20;
    this._fieldSize  = options.limits?.fieldSize || DEFAULT_FIELD_SIZE;
    this._filenameFn = options.filename || null;
    this._jsonLimit  = options.jsonBodyLimit || null;
    this._fileFilter = options.fileFilter || null;
    this._sniff      = !!options.sniffMimetype;
  }

  _clone(patch) {
    const c = Object.create(Upload.prototype);
    c._dest       = patch._dest       ?? this._dest;
    c._maxSize    = patch._maxSize    ?? this._maxSize;
    c._maxCount   = patch._maxCount   ?? this._maxCount;
    c._fieldSize  = patch._fieldSize  ?? this._fieldSize;
    c._filenameFn = patch._filenameFn ?? this._filenameFn;
    c._jsonLimit  = patch._jsonLimit  ?? this._jsonLimit;
    c._fileFilter = patch._fileFilter ?? this._fileFilter;
    c._sniff      = patch._sniff      ?? this._sniff;
    return c;
  }

  /* ---------- chainable options ---------- */

  to(dir)                  { return this._clone({ _dest: dir }); }
  filename(fn)             { return this._clone({ _filenameFn: fn }); }
  fileFilter(fn)           { return this._clone({ _fileFilter: fn }); }
  jsonLimit(bytes)         { return this._clone({ _jsonLimit: bytes }); }
  sniffMimetype(on = true) { return this._clone({ _sniff: !!on }); }

  limits(opts = {}) {
    return this._clone({
      _maxSize:   opts.fileSize  ?? this._maxSize,
      _maxCount:  opts.files     ?? this._maxCount,
      _fieldSize: opts.fieldSize ?? this._fieldSize,
    });
  }

  /* ---------- middleware factories ---------- */

  single(field)             { return this._middleware({ mode: 'single', field }); }
  array(field, maxCount=10) { return this._middleware({ mode: 'array', field, maxCount }); }
  any()                     { return this._middleware({ mode: 'any', maxCount: this._maxCount }); }
  none()                    { return this._middleware({ mode: 'none' }); }
  fields(defs)              { return this._middleware({ mode: 'fields', defs }); }

  /* ============================================================
   *                       Middleware
   * ============================================================ */

  _middleware(spec) {
    const self = this;

    return async function uploadMiddleware(req, _res, next) {
      const written = new Set();
      const cleanup = async () => {
        if (written.size === 0) return;
        const paths = [...written];
        written.clear();
        await Promise.all(paths.map((p) => fsp.unlink(p).catch(() => {})));
      };

      try {
        const dest = typeof self._dest === 'function'
          ? self._dest(req)
          : self._dest;
        if (!dest) throw new UploadError('upload: destination not set');

        const ct = (req.headers['content-type'] || '').toLowerCase();

        if (ct.startsWith('multipart/form-data')) {
          await fsp.mkdir(dest, { recursive: true });
          const { fields, files } = await self._parseMultipart(req, {
            dest, written, spec,
          });
          req.body = fields;
          assignResult(req, spec, files);
        } else if (ct.includes('json')) {
          await fsp.mkdir(dest, { recursive: true });
          await self._handleJson(req, dest, spec, written);
        } else {
          return next();
        }

        next();
      } catch (err) {
        await cleanup();
        next(err);
      }
    };
  }

  /* ============================================================
   *                     Multipart (busboy)
   * ============================================================ */

  _parseMultipart(req, { dest, written, spec }) {
    const self = this;

    return new Promise((resolve, reject) => {
      let bb;
      try {
        bb = Busboy({
          headers: req.headers,
          limits: {
            fileSize:  self._maxSize,
            files:     1000,
            fields:    1000,
            fieldSize: self._fieldSize,
            parts:     10000,
            headerPairs: 2000,
          },
        });
      } catch (e) {
        return reject(new UploadError(
          'Multipart: ' + e.message, 'MULTIPART_ERROR', 400,
        ));
      }

      const fields = Object.create(null);
      const rawFiles = [];
      let settled = false;
      let closed = false;
      let pending = 0;

      const fail = (err) => {
        if (settled) return;
        settled = true;
        try { req.unpipe(bb); } catch (_) {}
        try { bb.destroy(); } catch (_) {}
        reject(err);
      };

      const maybeFinish = async () => {
        if (settled || !closed || pending > 0) return;
        try {
          const { files } = await self._finalizeMultipart(
            rawFiles, spec, { dest, written, req },
          );
          if (settled) return;
          settled = true;
          resolve({ fields, files });
        } catch (e) {
          fail(e);
        }
      };

      bb.on('field', (name, val, info) => {
        if (settled) return;
        if (isBadFieldName(name)) return;
        if (info.nameTruncated) return;
        if (info.valueTruncated) {
          return fail(new UploadError(
            `Field "${name}" too large (> ${self._fieldSize})`,
            'LIMIT_FIELD_SIZE', 413,
          ));
        }
        if (name in fields) {
          if (Array.isArray(fields[name])) fields[name].push(val);
          else fields[name] = [fields[name], val];
        } else {
          fields[name] = val;
        }
      });

      bb.on('file', (name, stream, info) => {
        if (settled) { stream.resume(); return; }
        pending++;
        const chunks = [];
        let truncated = false;

        stream.on('data', (c) => chunks.push(c));
        stream.on('limit', () => { truncated = true; });
        stream.on('error', (e) => fail(e));
        stream.on('end', () => {
          if (settled) { pending--; return; }
          rawFiles.push({
            fieldname:    name,
            originalname: info.filename || '',
            mimetype:     info.mimeType || 'application/octet-stream',
            encoding:     info.encoding,
            data:         Buffer.concat(chunks),
            truncated,
          });
          pending--;
          maybeFinish();
        });
      });

      bb.on('error', (e) => fail(e));
      bb.on('close', () => {
        closed = true;
        maybeFinish();
      });

      req.on('aborted', () => fail(new UploadError(
        'Request aborted', 'REQUEST_ABORTED', 499,
      )));
      req.on('error', (e) => fail(e));

      req.pipe(bb);
    });
  }

  async _finalizeMultipart(rawFiles, spec, { dest, written, req }) {
    const self = this;
    const { mode, field, maxCount = self._maxCount, defs } = spec;

    const destFieldSet = mode === 'fields'
      ? new Set(defs.map((d) => d.name))
      : null;
    const destMaxPerField = mode === 'fields'
      ? new Map(defs.map((d) => [d.name, d.maxCount || 1]))
      : null;

    const files = [];
    let totalFiles = 0;

    for (const rf of rawFiles) {
      if (rf.truncated) {
        throw new UploadError(
          `File too large (> ${self._maxSize})`,
          'LIMIT_FILE_SIZE', 413,
        );
      }

      const name = rf.fieldname;
      const isTarget =
        mode === 'any' ||
        (mode === 'array'  && name === field) ||
        (mode === 'single' && name === field) ||
        (mode === 'fields' && destFieldSet.has(name));

      if (!isTarget) continue;

      let mimetype     = rf.mimetype;
      let originalname = safeFilename(rf.originalname || name);

      if (self._sniff) {
        const applied = applySniff(originalname, mimetype, rf.data, true);
        originalname = applied.originalname;
        mimetype     = applied.mimetype;
      }

      const fileInfo = {
        fieldname: name,
        originalname,
        mimetype,
        size: rf.data.length,
      };

      if (self._fileFilter) {
        const ok = await Promise.resolve(self._fileFilter(req, fileInfo));
        if (!ok) {
          throw new UploadError(
            `File "${originalname}" rejected by filter`,
            'LIMIT_UNEXPECTED_FILE', 400,
          );
        }
      }

      const perFieldLimit = destMaxPerField?.get(name) || maxCount;
      const fieldCount = files.reduce(
        (n, f) => n + (f.fieldname === name ? 1 : 0), 0,
      );

      let allowPush = false;
      if (mode === 'single')       allowPush = files.length === 0;
      else if (mode === 'array')   allowPush = fieldCount < maxCount;
      else if (mode === 'fields')  allowPush = fieldCount < perFieldLimit;
      else /* any */               allowPush =
        fieldCount < perFieldLimit && totalFiles < maxCount;

      if (!allowPush) {
        throw new UploadError(
          `Too many files for "${name}"`,
          'LIMIT_FILE_COUNT', 413,
        );
      }

      const saved = await self._saveFile(
        { data: rf.data, mimetype, originalname },
        name, dest, req, written,
      );
      files.push(saved);
      totalFiles++;
    }

    return { files };
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
    const maxDataUrl = Math.max(this._maxSize * 2, 1 << 20);

    if (mode === 'none') {
      req.body = body;
      delete req.file;
      delete req.files;
      return;
    }

    if (mode === 'single') {
      if (isBadFieldName(field) || !(field in body)) {
        req.body = body;
        req.file = null;
        return;
      }
      const f = tryExtractFile(body[field], field, {
        allowPlainBase64: false, maxDataUrl,
      });
      if (!f) throw new UploadError(`upload: field "${field}" is not a valid file`);
      req.file = await save(f, field);
      delete req.files;
      delete body[field];
      req.body = body;
      return;
    }

    if (mode === 'array') {
      if (isBadFieldName(field) || !(field in body)) {
        req.body = body;
        req.files = [];
        return;
      }
      let values = body[field];
      if (isByteArray(values)) values = [values];
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
        const f = tryExtractFile(v, field, {
          allowPlainBase64: false, maxDataUrl,
        });
        if (!f) throw new UploadError(`upload: invalid file in "${field}"`);
        saved.push(await save(f, field));
      }
      req.files = saved;
      delete req.file;
      delete body[field];
      req.body = body;
      return;
    }

    if (mode === 'fields') {
      req.files = {};
      for (const { name, maxCount: mc = 1 } of defs) {
        if (isBadFieldName(name) || !(name in body)) continue;
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
          const f = tryExtractFile(v, name, {
            allowPlainBase64: false, maxDataUrl,
          });
          if (!f) throw new UploadError(`upload: invalid file in "${name}"`);
          saved.push(await save(f, name));
        }
        req.files[name] = saved;
        delete body[name];
      }
      delete req.file;
      req.body = body;
      return;
    }

    // any
    const saved = [];
    for (const key of Object.keys(body)) {
      if (isBadFieldName(key)) continue;
      const value = body[key];

      if (isByteArray(value)) {
        const f = tryExtractFile(value, key, {
          allowPlainBase64: false, maxDataUrl,
        });
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
            const f = tryExtractFile(v, key, {
              allowPlainBase64: false, maxDataUrl,
            });
            if (f) saved.push(await save(f, key));
          }
          delete body[key];
          continue;
        }
        const kept = [];
        for (const v of value) {
          const f = tryExtractFile(v, key, {
            allowPlainBase64: true, maxDataUrl,
          });
          if (f) saved.push(await save(f, key));
          else kept.push(v);
        }
        if (kept.length === 0) delete body[key];
        else body[key] = kept;
        continue;
      }

      const f = tryExtractFile(value, key, {
        allowPlainBase64: true, maxDataUrl,
      });
      if (f) {
        saved.push(await save(f, key));
        delete body[key];
      }
    }
    req.files = saved;
    delete req.file;
    req.body = body;
  }

  async _getJsonBody(req, maxCount) {
    if (req.readableEnded || req.complete || req._uploadBodyRead) {
      return req.body ?? {};
    }

    const limit = this._jsonLimit
      ?? Math.min(
        DEFAULT_JSON_LIMIT,
        Math.max(this._maxSize * Math.max(maxCount || 1, 1) * 2, 64 * 1024),
      );

    const raw = await readBody(req, limit);
    req._uploadBodyRead = true;
    if (raw.length === 0) return {};

    try {
      const parsed = JSON.parse(raw.toString('utf8'));
      req.body = parsed;
      return parsed;
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

    if (this._sniff) {
      const applied = applySniff(originalname, mimetype, data, true);
      originalname = applied.originalname;
      mimetype     = applied.mimetype;
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

    const filename = safeFilename(
      this._filenameFn
        ? this._filenameFn({ originalname, req, fieldname, mimetype })
        : defaultFilename(originalname),
    );
    const filepath = safeJoin(dest, filename);
    written.add(filepath);

    // атомарная запись: tmp → rename
    const tmp = filepath + '.tmp-' + crypto.randomBytes(4).toString('hex');
    try {
      await fsp.writeFile(tmp, data);
      await fsp.rename(tmp, filepath);
    } catch (e) {
      await fsp.unlink(tmp).catch(() => {});
      throw e;
    }

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
    delete req.file;
    delete req.files;
  } else if (mode === 'single') {
    req.file = files[0] || null;
    delete req.files;
  } else if (mode === 'array' || mode === 'any') {
    req.files = files;
    delete req.file;
  } else if (mode === 'fields') {
    const grouped = Object.create(null);
    for (const f of files) {
      if (!grouped[f.fieldname]) grouped[f.fieldname] = [];
      grouped[f.fieldname].push(f);
    }
    req.files = grouped;
    delete req.file;
  }
}

/* ============================================================
 *                          Export
 * ============================================================ */

const defaultInstance = new Upload();
defaultInstance.Upload = Upload;
defaultInstance.UploadError = UploadError;
module.exports = defaultInstance;

