import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { prefilterBytes, viewText } from '../src/core/text-view.ts';

const BOM = '\uFEFF';

describe('Text view', () => {
  it('shows an LF file as written', () => {
    const view = viewText('a\nb\n');
    assert.deepEqual([view.text, view.bom, view.crlf], ['a\nb\n', false, false]);
  });

  it('hides a leading BOM and puts it back', () => {
    const view = viewText(`${BOM}a\nb\n`);
    assert.deepEqual([view.text, view.bom], ['a\nb\n', true]);
    assert.equal(view.restore('x\nb\n'), `${BOM}x\nb\n`);
  });

  it('shows an all-CRLF file with LF endings and restores them', () => {
    const view = viewText('a\r\nb\r\n');
    assert.deepEqual([view.text, view.crlf], ['a\nb\n', true]);
    assert.equal(view.restore('a\nx\nb\n'), 'a\r\nx\r\nb\r\n');
  });

  it('restore gives each text its own result when called again', () => {
    const view = viewText('a\r\nb\r\n');
    assert.equal(view.restore('x\n'), 'x\r\n');
    assert.equal(view.restore('x\n'), 'x\r\n');
    assert.equal(view.restore('y\n'), 'y\r\n');
  });

  it('restore does not double a CR a transform wrote', () => {
    assert.equal(viewText('a\r\nb\r\n').restore('a\r\nb\n'), 'a\r\nb\r\n');
  });

  for (const disk of ['a\r\nb\n', 'a\rb\r\n', 'a\r\r\nb\r\n', 'a\r', '', 'no newline']) {
    it(`shows ${JSON.stringify(disk)} as written`, () => {
      const view = viewText(disk);
      assert.deepEqual([view.text, view.crlf], [disk, false]);
    });
  }

  for (const disk of ['a\nb', `${BOM}a\r\nb\r\n`, 'a\r\r\nb\r\n', BOM, 'a\r\nb']) {
    it(`round-trips ${JSON.stringify(disk)}`, () => {
      const view = viewText(disk);
      assert.equal(view.restore(view.text), disk);
    });
  }

  it('accept turns client CRLF text into view text only for a CRLF file', () => {
    assert.equal(viewText('a\r\nb\r\n').accept('a\r\nb'), 'a\nb');
    assert.equal(viewText('a\nb\n').accept('a\r\nb'), 'a\r\nb');
  });

  it('accept keeps a leading U+FEFF', () => {
    assert.equal(viewText(`${BOM}a\n`).accept(`${BOM}a`), `${BOM}a`);
    assert.equal(viewText(`${BOM}a\r\nb\r\n`).accept(`${BOM}a\r\nb`), `${BOM}a\nb`);
  });

  it('locate keeps a typed landing and never retries', async () => {
    const calls: string[] = [];
    const hit = await viewText(`${BOM}a\n`).locate(
      (needle) => {
        calls.push(needle(`${BOM}x`));
        return { value: 'typed', start: 4 };
      },
      [`${BOM}x`],
    );
    assert.deepEqual(hit, { value: 'typed', start: 4 });
    assert.deepEqual(calls, [`${BOM}x`]);
  });

  it('locate retries stripped in a marked file and keeps a landing at the start', async () => {
    const hit = await viewText(`${BOM}a\n`).locate(
      (needle) => (needle(`${BOM}a`) === 'a' ? { value: 'bare', start: 0 } : undefined),
      [`${BOM}a`],
    );
    assert.deepEqual(hit, { value: 'bare', start: 0 });
  });

  it('locate drops a stripped landing past the start', async () => {
    const hit = await viewText(`${BOM}a\nx\n`).locate(
      (needle) => (needle(`${BOM}x`) === 'x' ? { value: 'bare', start: 2 } : undefined),
      [`${BOM}x`],
    );
    assert.equal(hit, undefined);
  });

  it('an unmarked file runs the attempt once', async () => {
    let calls = 0;
    const hit = await viewText('a\n').locate(() => {
      calls += 1;
      return undefined;
    }, [BOM]);
    assert.equal(hit, undefined);
    assert.equal(calls, 1);
  });

  it('locate retries after a typed throw and keeps a landing at the start', async () => {
    const hit = await viewText(`${BOM}a\n`).locate(
      (needle) => {
        if (needle(BOM) === BOM) throw new Error('typed');
        return { value: 'bare', start: 0 };
      },
      [BOM],
    );
    assert.deepEqual(hit, { value: 'bare', start: 0 });
  });

  it('rethrows the typed failure when the retry also fails', async () => {
    const typed = new Error('typed');
    await assert.rejects(
      viewText(`${BOM}a\n`).locate(
        (needle) => {
          throw needle(BOM) === BOM ? typed : new Error('retry');
        },
        [BOM],
      ),
      (e) => e === typed,
    );
  });

  it('locate rethrows an abort from the retry', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    await assert.rejects(
      viewText(`${BOM}a\n`).locate(
        (needle) => {
          if (needle(BOM) === BOM) return undefined;
          throw abort;
        },
        [BOM],
      ),
      (e) => e === abort,
    );
  });

  it('locate skips the retry when no typed text starts with U+FEFF', async () => {
    let calls = 0;
    const hit = await viewText(`${BOM}a\n`).locate(() => {
      calls += 1;
      return undefined;
    }, ['a', 'b']);
    assert.equal(hit, undefined);
    assert.equal(calls, 1);
  });

  it('place drops a leading U+FEFF only at the start of a marked file', () => {
    const marked = viewText(`${BOM}a\n`);
    assert.equal(marked.place(`${BOM}b`, 0), 'b');
    assert.equal(marked.place(`${BOM}${BOM}b`, 0), `${BOM}b`);
    assert.equal(marked.place(`${BOM}b`, 3), `${BOM}b`);
    assert.equal(viewText('a\n').place(`${BOM}b`, 0), `${BOM}b`);
  });

  it('prefilterBytes drops the BOM bytes and refuses bytes holding a CR', () => {
    assert.deepEqual(prefilterBytes(Buffer.from(`${BOM}ab`)), Buffer.from('ab'));
    assert.deepEqual(prefilterBytes(Buffer.from('ab')), Buffer.from('ab'));
    assert.equal(prefilterBytes(Buffer.from('a\r\nb')), undefined);
  });

  it('prefilterBytes keeps CRLF bytes, minus the BOM, for a needle with no line break', () => {
    assert.deepEqual(prefilterBytes(Buffer.from(`${BOM}a\r\nb`), true), Buffer.from('a\r\nb'));
  });
});
