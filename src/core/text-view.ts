/**
 * The Text view module (see GLOSSARY.md): the text of a file as a tool judges
 * it. A leading BOM is hidden and an all-CRLF file is shown with LF endings;
 * a file with mixed endings is shown as written. `restore` puts both back, so
 * a write through the view keeps the file's mark and endings.
 */
export interface TextView {
  /** The decoded file as it is on disk. */
  readonly disk: string;
  /** The text a tool judges: no leading BOM; LF endings when `crlf`. */
  readonly text: string;
  readonly bom: boolean;
  readonly crlf: boolean;
  /** Text a client wrote against the file on disk, as the view shows it. */
  accept(text: string): string;
  /** Text produced from `text`, as it goes to disk. */
  restore(text: string): string;
}

const BOM = '﻿';

export function viewText(disk: string): TextView {
  const bom = disk.charCodeAt(0) === 0xfeff;
  const body = bom ? disk.slice(1) : disk;
  const crlf = body.includes('\r\n') && !/(?<!\r)\n|\r(?!\n)/u.test(body);
  return {
    disk,
    text: crlf ? body.replaceAll('\r\n', '\n') : body,
    bom,
    crlf,
    accept(text) {
      const bare = bom && text.startsWith(BOM) ? text.slice(1) : text;
      return crlf ? bare.replaceAll('\r\n', '\n') : bare;
    },
    restore(text) {
      const eol = crlf ? text.replace(/\r?\n/g, '\r\n') : text;
      return bom ? BOM + eol : eol;
    },
  };
}

/** The bytes a byte-level prefilter may test, or undefined when it must not run. */
export function prefilterBytes(bytes: Buffer): Buffer | undefined {
  if (bytes.includes(13)) return undefined;
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  return bom ? bytes.subarray(3) : bytes;
}
