/// <reference types="node" />
import type { RequestHandler, Request } from 'express';

export interface UploadedFile {
  fieldname: string;
  originalname: string;
  filename: string;
  path: string;
  destination: string;
  mimetype: string;
  size: number;
}

export interface Limits {
  fileSize?: number;
  files?: number;
}

export interface UploadOptions {
  dest?: string | ((req: Request) => string);
  limits?: Limits;
  filename?: (file: { originalname: string }) => string;
  fileFilter?: (
    req: Request | null,
    file: Pick<UploadedFile, 'fieldname' | 'originalname' | 'mimetype' | 'size'>,
  ) => boolean | Promise<boolean>;
  jsonBodyLimit?: number;
  sniffMimetype?: boolean;
}

export class UploadError extends Error {
  code: string;
  status: number;
}

export class Upload {
  constructor(options?: UploadOptions);

  to(dir: string | ((req: Request) => string)): Upload;
  limits(opts: Limits): Upload;
  filename(fn: (file: { originalname: string }) => string): Upload;
  fileFilter(
    fn: (
      req: Request | null,
      file: Pick<UploadedFile, 'fieldname' | 'originalname' | 'mimetype' | 'size'>,
    ) => boolean | Promise<boolean>,
  ): Upload;
  jsonLimit(bytes: number): Upload;
  sniffMimetype(on?: boolean): Upload;

  single(field: string): RequestHandler;
  array(field: string, maxCount?: number): RequestHandler;
  any(): RequestHandler;
  none(): RequestHandler;
  fields(defs: Array<{ name: string; maxCount?: number }>): RequestHandler;
}

declare const upload: Upload;
export default upload;

declare module 'express-serve-static-core' {
  interface Request {
    file?: UploadedFile | null;
    files?: UploadedFile[] | Record<string, UploadedFile[]> | null;
  }
}