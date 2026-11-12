/**
 * The Text view module (see GLOSSARY.md): the text of a file as a tool judges
 * it. A leading BOM is hidden and an all-CRLF file is shown with LF endings;
 * a file with mixed endings is shown as written. `restore` puts both back, so
 * a write through the view keeps the file's mark and endings.
 */
/** Where an attempt landed: `start` 0 is the file start. */
interface Landing<T> {
  value: T;
  start: number;
}

export interface TextView {
  /** The decoded file as it is on disk. */
  readonly disk: string;
  /** The text a tool judges: no leading BOM; LF endings when `crlf`. */
  readonly text: string;
  readonly bom: boolean;
  readonly crlf: boolean;
  /** Text a client wrote, with the view's line endings. A leading U+FEFF is kept. */
  accept(text: string): string;
  /**
   * The Mark rule (GLOSSARY). Runs `attempt` with client text as typed
   * (`needle` is the identity). In a marked file, when that misses (returns
   * undefined or throws) and one of the `typed` texts the needle will see
   * starts with U+FEFF, runs it once more with `needle` removing a leading
   * U+FEFF, and keeps that landing only when `start === 0`. Otherwise the
   * typed outcome stands: its landing, undefined, or its thrown error. An
   * abort during the retry is rethrown. An attempt that never returns
   * undefined gets a landing or a throw.
   */
  locate<T>(
    attempt: (needle: (text: string) => string) => Landing<T> | Promise<Landing<T>>,
    typed: readonly string[],
  ): Promise<Landing<T>>;
  locate<T>(
    attempt: (
      needle: (text: string) => string,
    ) => Landing<T> | undefined | Promise<Landing<T> | undefined>,
    typed: readonly string[],
  ): Promise<Landing<T> | undefined>;
  /** `text` as placed at `start`: at the start of a marked file, without its leading U+FEFF. */
  place(text: string, start: number): string;
  /** Text produced from `text`, as it goes to disk. */
  restore(text: string): string;
}

const BOM = '\uFEFF';

export function viewText(disk: string): TextView {
  const bom = disk.charCodeAt(0) === 0xfeff;
  const body = bom ? disk.slice(1) : disk;
  const crlf = body.includes('\r\n') && !/(?<!\r)\n|\r(?!\n)/u.test(body);
  // The last restore: replace_text's size check and the Rewrite's write restore the same text.
  let last: { text: string; disk: string } | undefined;
  const unmark = (text: string): string => (bom && text.startsWith(BOM) ? text.slice(1) : text);
  return {
    disk,
    text: crlf ? body.replaceAll('\r\n', '\n') : body,
    bom,
    crlf,
    accept(text) {
      return crlf ? text.replaceAll('\r\n', '\n') : text;
    },
    locate: (async <T>(
      attempt: (
        needle: (text: string) => string,
      ) => Landing<T> | undefined | Promise<Landing<T> | undefined>,
      typed: readonly string[],
    ): Promise<Landing<T> | undefined> => {
      // A retry that would strip nothing repeats the typed attempt exactly.
      const retry = bom && typed.some((text) => text.startsWith(BOM));
      let typedError: { error: unknown } | undefined;
      try {
        const landing = await attempt((text) => text);
        if (landing !== undefined || !retry) return landing;
      } catch (error) {
        if (!retry) throw error;
        typedError = { error };
      }
      try {
        const landing = await attempt(unmark);
        if (landing?.start === 0) return landing;
      } catch (error) {
        if ((error as { name?: unknown } | null)?.name === 'AbortError') throw error;
        // The typed failure is what the client sent; the retry's is not reported.
      }
      if (typedError) throw typedError.error;
      return undefined;
    }) as TextView['locate'],
    place(text, start) {
      return start === 0 ? unmark(text) : text;
    },
    restore(text) {
      if (last?.text === text) return last.disk;
      const eol = crlf ? text.replace(/\r?\n/g, '\r\n') : text;
      last = { text, disk: bom ? BOM + eol : eol };
      return last.disk;
    },
  };
}

/**
 * The bytes a byte-level prefilter may test, or undefined when it must not run.
 * A CR hides a match only from a needle that holds a line break, so `crSafe`
 * (a needle with no CR or LF) lets bytes holding a CR through.
 */
export function prefilterBytes(bytes: Buffer, crSafe = false): Buffer | undefined {
  if (!crSafe && bytes.includes(13)) return undefined;
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  return bom ? bytes.subarray(3) : bytes;
}
