import { Buffer } from 'node:buffer';
import { extname } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────────────

export type FileKind = 'text' | 'binary' | 'image' | 'audio' | 'pdf';

export interface MimeInfo {
  mimeType: string;
  kind: FileKind;
}

// ─── Extension Map ──────────────────────────────────────────────────────────
// Maps file extensions to MIME types (80+ common extensions)

const EXT_MAP: Record<string, MimeInfo> = {
  // Text: Web & Markup
  html: { mimeType: 'text/html', kind: 'text' },
  htm: { mimeType: 'text/html', kind: 'text' },
  xml: { mimeType: 'text/xml', kind: 'text' },
  css: { mimeType: 'text/css', kind: 'text' },
  svg: { mimeType: 'image/svg+xml', kind: 'image' },
  md: { mimeType: 'text/markdown', kind: 'text' },
  markdown: { mimeType: 'text/markdown', kind: 'text' },
  mdown: { mimeType: 'text/markdown', kind: 'text' },

  // Text: Programming Languages
  js: { mimeType: 'text/javascript', kind: 'text' },
  mjs: { mimeType: 'text/javascript', kind: 'text' },
  jsx: { mimeType: 'text/jsx', kind: 'text' },
  ts: { mimeType: 'text/typescript', kind: 'text' },
  tsx: { mimeType: 'text/tsx', kind: 'text' },
  py: { mimeType: 'text/x-python', kind: 'text' },
  java: { mimeType: 'text/x-java', kind: 'text' },
  c: { mimeType: 'text/x-c', kind: 'text' },
  cpp: { mimeType: 'text/x-cpp', kind: 'text' },
  cc: { mimeType: 'text/x-cpp', kind: 'text' },
  cxx: { mimeType: 'text/x-cpp', kind: 'text' },
  h: { mimeType: 'text/x-c', kind: 'text' },
  hpp: { mimeType: 'text/x-cpp', kind: 'text' },
  go: { mimeType: 'text/x-go', kind: 'text' },
  rs: { mimeType: 'text/x-rust', kind: 'text' },
  rb: { mimeType: 'text/x-ruby', kind: 'text' },
  php: { mimeType: 'text/x-php', kind: 'text' },
  sh: { mimeType: 'text/x-shellscript', kind: 'text' },
  bash: { mimeType: 'text/x-shellscript', kind: 'text' },
  zsh: { mimeType: 'text/x-shellscript', kind: 'text' },
  ps1: { mimeType: 'text/x-powershell', kind: 'text' },
  sql: { mimeType: 'text/x-sql', kind: 'text' },

  // Text: Data formats
  json: { mimeType: 'application/json', kind: 'text' },
  jsonc: { mimeType: 'application/json', kind: 'text' },
  ndjson: { mimeType: 'application/x-ndjson', kind: 'text' },
  yaml: { mimeType: 'text/yaml', kind: 'text' },
  yml: { mimeType: 'text/yaml', kind: 'text' },
  toml: { mimeType: 'text/toml', kind: 'text' },
  ini: { mimeType: 'text/plain', kind: 'text' },
  cfg: { mimeType: 'text/plain', kind: 'text' },
  conf: { mimeType: 'text/plain', kind: 'text' },
  csv: { mimeType: 'text/csv', kind: 'text' },

  // Text: Diff & Patches
  diff: { mimeType: 'text/x-diff', kind: 'text' },
  patch: { mimeType: 'text/x-diff', kind: 'text' },

  // Text: Documentation
  txt: { mimeType: 'text/plain', kind: 'text' },
  text: { mimeType: 'text/plain', kind: 'text' },
  log: { mimeType: 'text/plain', kind: 'text' },
  rst: { mimeType: 'text/x-rst', kind: 'text' },

  // Image formats
  png: { mimeType: 'image/png', kind: 'image' },
  jpg: { mimeType: 'image/jpeg', kind: 'image' },
  jpeg: { mimeType: 'image/jpeg', kind: 'image' },
  gif: { mimeType: 'image/gif', kind: 'image' },
  webp: { mimeType: 'image/webp', kind: 'image' },
  ico: { mimeType: 'image/x-icon', kind: 'image' },
  bmp: { mimeType: 'image/bmp', kind: 'image' },
  tiff: { mimeType: 'image/tiff', kind: 'image' },
  tif: { mimeType: 'image/tiff', kind: 'image' },

  // Audio formats
  mp3: { mimeType: 'audio/mpeg', kind: 'audio' },
  wav: { mimeType: 'audio/wav', kind: 'audio' },
  flac: { mimeType: 'audio/flac', kind: 'audio' },
  aac: { mimeType: 'audio/aac', kind: 'audio' },
  ogg: { mimeType: 'audio/ogg', kind: 'audio' },
  m4a: { mimeType: 'audio/mp4', kind: 'audio' },

  // PDF
  pdf: { mimeType: 'application/pdf', kind: 'pdf' },

  // Archives
  zip: { mimeType: 'application/zip', kind: 'binary' },
  tar: { mimeType: 'application/x-tar', kind: 'binary' },
  gz: { mimeType: 'application/gzip', kind: 'binary' },
  gzip: { mimeType: 'application/gzip', kind: 'binary' },
  '7z': { mimeType: 'application/x-7z-compressed', kind: 'binary' },
  rar: { mimeType: 'application/x-rar-compressed', kind: 'binary' },
  bz2: { mimeType: 'application/x-bzip2', kind: 'binary' },
  xz: { mimeType: 'application/x-xz', kind: 'binary' },

  // Other binary formats
  wasm: { mimeType: 'application/wasm', kind: 'binary' },
  so: { mimeType: 'application/octet-stream', kind: 'binary' },
  dylib: { mimeType: 'application/octet-stream', kind: 'binary' },
  dll: { mimeType: 'application/octet-stream', kind: 'binary' },
  exe: { mimeType: 'application/octet-stream', kind: 'binary' },
  msi: { mimeType: 'application/octet-stream', kind: 'binary' },
  dmg: { mimeType: 'application/octet-stream', kind: 'binary' },
};

// ─── Helper Functions ───────────────────────────────────────────────────────

export const MIME_SAMPLE_SIZE = 512;

// Every non-text kind is binary for read purposes, except SVG — an image kind
// whose bytes are text, and which the read path must not fast-path as binary.
// EXT_MAP covers the extensions it knows (image/audio/pdf/binary kinds all
// become binary here, image-kind SVG excepted); EXTRA_BINARY_EXTENSIONS lists
// the rest that EXT_MAP does not carry but the read path must still treat as
// binary. The two tables had drifted; this derivation resolves the drift toward
// binary (only changes whether a file skips its content probe).
const EXTRA_BINARY_EXTENSIONS = [
  'mov',
  'avi',
  'mkv',
  'webm',
  'ttf',
  'otf',
  'woff',
  'woff2',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'sqlite',
  'db',
  'bin',
  'dat',
  'mp4',
];

const KNOWN_BINARY_EXTENSIONS: ReadonlySet<string> = new Set(
  [
    ...Object.entries(EXT_MAP)
      .filter(([, v]) => v.kind !== 'text')
      .map(([k]) => k),
    ...EXTRA_BINARY_EXTENSIONS,
  ]
    .filter((ext) => ext !== 'svg')
    .map((ext) => `.${ext}`),
);

export function isKnownBinaryExtension(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return KNOWN_BINARY_EXTENSIONS.has(ext);
}

export function hasUtf16Bom(slice: Buffer): boolean {
  return (
    slice.length >= 2 &&
    ((slice[0] === 0xff && slice[1] === 0xfe) || (slice[0] === 0xfe && slice[1] === 0xff))
  );
}

/**
 * True when `slice` is valid UTF-8 *as a prefix*: `stream: true` parks a
 * multi-byte sequence cut by the sample boundary in the decoder's buffer
 * instead of reporting it, while `fatal: true` still throws on invalid bytes.
 */
function isUtf8Prefix(slice: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(slice, { stream: true });
    return true;
  } catch {
    return false;
  }
}

/** Single binary-vs-text verdict, shared by `detectMimeType` and the read path. */
export function isBinarySample(slice: Buffer): boolean {
  if (slice.length === 0) return false;
  if (hasUtf16Bom(slice)) return false;
  if (slice.includes(0)) return true;
  return !isUtf8Prefix(slice);
}

export function detectMimeType(path: string, sample?: Buffer): MimeInfo {
  const lastDot = path.lastIndexOf('.');
  const ext = lastDot > -1 ? path.slice(lastDot + 1).toLowerCase() : '';

  if (ext && Object.hasOwn(EXT_MAP, ext)) {
    const entry = EXT_MAP[ext];
    if (entry !== undefined) {
      return entry;
    }
  }

  // No known extension: fall back to a binary/text probe of the content.
  if (sample) {
    return isBinarySample(sample.subarray(0, MIME_SAMPLE_SIZE))
      ? { mimeType: 'application/octet-stream', kind: 'binary' }
      : { mimeType: 'text/plain', kind: 'text' };
  }

  return { mimeType: 'application/octet-stream', kind: 'binary' };
}

export function detectMimeFromContent(path: string, content: string | Buffer): MimeInfo {
  return detectMimeType(
    path,
    Buffer.isBuffer(content)
      ? content.subarray(0, MIME_SAMPLE_SIZE)
      : Buffer.from(content.slice(0, MIME_SAMPLE_SIZE)),
  );
}
