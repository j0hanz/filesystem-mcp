const WORK_LIMIT = 10_000_000;
const CONTEXT_LINES = 2;
const MAX_REGION_LINES = 30;
const MAX_LINE_CHARS = 500;

interface Grams {
  grams: Map<string, number>;
  size: number;
}

/** A line's character bigrams with all whitespace removed. */
function lineGrams(line: string): Grams {
  const text = line.replace(/\s+/gu, '').toLowerCase();
  const grams = new Map<string, number>();
  if (text.length === 1) grams.set(text, 1);
  for (let i = 0; i < text.length - 1; i++) {
    const gram = text.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  let size = 0;
  for (const count of grams.values()) size += count;
  return { grams, size };
}

/** Dice similarity: 1 for two blank lines, 0 for nothing shared. */
function similarity(a: Grams, b: Grams): number {
  if (a.size + b.size === 0) return 1;
  let shared = 0;
  for (const [gram, count] of a.grams) shared += Math.min(count, b.grams.get(gram) ?? 0);
  return (2 * shared) / (a.size + b.size);
}

function cutLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  let cutAt = MAX_LINE_CHARS;
  const high = line.charCodeAt(cutAt - 1);
  const low = line.charCodeAt(cutAt);
  if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) cutAt -= 1;
  return `${line.slice(0, cutAt)} [... cut: the line has ${line.length} characters]`;
}

function firstDifference(
  oldLines: readonly string[],
  fileLines: readonly string[],
  best: number,
  lineCount: number,
  trailingNewlineMismatch: boolean,
): string {
  let differs = oldLines.findIndex(
    (line, j) => best + j >= lineCount || line.trim() !== (fileLines[best + j] ?? '').trim(),
  );
  if (differs === -1) {
    differs = oldLines.findIndex((line, j) => line !== (fileLines[best + j] ?? ''));
  }
  if (differs === -1 && trailingNewlineMismatch) {
    return `oldText line ${oldLines.length + 1} ("") runs past the end of the file, which ends at line ${lineCount}.`;
  }
  const index = differs === -1 ? 0 : differs;
  const oldDiff = cutLine(oldLines[index] ?? '');
  return best + index >= lineCount
    ? `oldText line ${index + 1} (${JSON.stringify(oldDiff)}) runs past the end of the file, which ends at line ${lineCount}.`
    : `First difference, oldText line ${index + 1} against file line ${best + index + 1}:\n  oldText: ${JSON.stringify(oldDiff)}\n  file:    ${JSON.stringify(cutLine(fileLines[best + index] ?? ''))}`;
}

/**
 * Finds the run of lines in `content` most similar to `oldText` and formats a
 * bounded diagnostic block with 1-based line numbers and the first differing line.
 */
export function closestLines(content: string, oldText: string): string {
  const fileLines = content.split('\n');
  const lineCount =
    content === '' ? 0 : content.endsWith('\n') ? fileLines.length - 1 : fileLines.length;
  if (lineCount === 0) return 'The file is empty.';

  const oldLines =
    oldText === ''
      ? []
      : oldText.endsWith('\n')
        ? oldText.slice(0, -1).split('\n')
        : oldText.split('\n');
  const oldGrams = oldLines.map(lineGrams);
  let perLineWork = 0;
  for (const g of oldGrams) perLineWork += g.size + 1;
  if (fileLines.length * perLineWork > WORK_LIMIT) {
    return `The file has ${lineCount} lines, too many to search for the closest text. Read the file and copy oldText from it exactly.`;
  }

  const fileGrams = fileLines.slice(0, lineCount).map(lineGrams);
  let best = 0;
  let bestScore = 0;
  for (let i = 0; i < lineCount; i++) {
    const span = Math.min(oldGrams.length, lineCount - i);
    let score = 0;
    for (let j = 0; j < span; j++) {
      const a = oldGrams[j];
      const b = fileGrams[i + j];
      if (a && b) score += similarity(a, b);
    }
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }

  if (bestScore === 0) {
    return 'No line of the file resembles oldText. Read the file and copy oldText from it exactly.';
  }

  const start = Math.max(0, best - CONTEXT_LINES);
  const end = Math.min(lineCount, best + oldLines.length + CONTEXT_LINES, start + MAX_REGION_LINES);
  const regionLines = [`Closest text in the file (lines ${start + 1}-${end} of ${lineCount}):`];
  for (let i = start; i < end; i++) {
    regionLines.push(`${i + 1}: ${cutLine(fileLines[i] ?? '')}`);
  }

  const diffParagraph = firstDifference(
    oldLines,
    fileLines,
    best,
    lineCount,
    oldText.endsWith('\n') && !content.endsWith('\n') && best + oldLines.length === lineCount,
  );

  return [
    regionLines.join('\n'),
    diffParagraph,
    'Retry with oldText copied exactly from the file, without the line-number prefixes.',
  ].join('\n\n');
}
