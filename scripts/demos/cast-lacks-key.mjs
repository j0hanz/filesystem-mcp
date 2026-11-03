// Exit 0 only when a cast lacks GEMINI_API_KEY, so a crash here never passes a cast.
// The raw file can split the key across output events, or put control sequences
// inside it, so the scan also covers the output as the terminal would show it.
import { readFileSync } from 'node:fs';

const ESCAPES = new RegExp(
  [
    String.raw`\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)`, // OSC
    String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, // CSI
    String.raw`\u001b[()][0-9A-Za-z]`, // charset
    String.raw`\u001b[@-_=>78]`, // other
  ].join('|'),
  'gu',
);

const key = process.env['GEMINI_API_KEY'] ?? '';
const raw = readFileSync(process.argv[2] ?? '', 'utf8');

let output = '';
for (const line of raw.split('\n').slice(1)) {
  try {
    const [, kind, data] = JSON.parse(line);
    if (kind === 'o') output += data;
  } catch {
    // A killed recorder can leave a partial last line, and the key can end inside it.
    output += line
      .replace(/^\[[^,]*,\s*"o",\s*"/u, '')
      .replaceAll(String.raw`\u001b`, '\u001b')
      .replaceAll(String.raw`\r`, '\r')
      .replaceAll(String.raw`\n`, '\n');
  }
}
const shown = output.replace(ESCAPES, '').replace(/[\r\n]/gu, '');
process.exit(raw.includes(key) || shown.includes(key) ? 1 : 0);
