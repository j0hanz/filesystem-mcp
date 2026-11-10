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

  it('accept drops a leading BOM only for a BOM file', () => {
    assert.equal(viewText(`${BOM}a\n`).accept(`${BOM}a`), 'a');
    assert.equal(viewText('a\n').accept(`${BOM}a`), `${BOM}a`);
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
