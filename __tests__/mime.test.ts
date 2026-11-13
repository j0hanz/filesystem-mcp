import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, it } from 'node:test';

import { detectMimeType, isBinarySample, isKnownBinaryExtension } from '../src/core/mime.ts';

const OCTET = { mimeType: 'application/octet-stream', kind: 'binary' };

describe('File class', () => {
  it('treats a UTF-16 byte-order mark as binary, either byte order', () => {
    assert.equal(isBinarySample(Buffer.from([0xff, 0xfe, 0x61, 0x00])), true);
    assert.equal(isBinarySample(Buffer.from([0xfe, 0xff, 0x00, 0x61])), true);
  });

  it('classifies a binary-only extension from the one table, whatever its bytes', () => {
    assert.deepEqual(detectMimeType('archive.bin', Buffer.from('hello')), OCTET);
    assert.deepEqual(detectMimeType('db.sqlite', Buffer.from('hello')), OCTET);
    assert.deepEqual(detectMimeType('clip.mp4'), OCTET);
  });

  it('classifies a text extension holding UTF-16 or NUL bytes as binary', () => {
    assert.deepEqual(detectMimeType('notes.txt', Buffer.from([0xff, 0xfe, 0x61, 0x00])), OCTET);
    assert.deepEqual(detectMimeType('notes.txt', Buffer.from('a\0b')), OCTET);
  });

  it('keeps a text extension text without a sample or with UTF-8 bytes', () => {
    assert.deepEqual(detectMimeType('notes.txt'), { mimeType: 'text/plain', kind: 'text' });
    assert.deepEqual(detectMimeType('notes.txt', Buffer.from('héllo')), {
      mimeType: 'text/plain',
      kind: 'text',
    });
  });

  it('keeps .svg an image for delivery but not a known binary extension', () => {
    assert.deepEqual(detectMimeType('a.svg', Buffer.from('<svg/>')), {
      mimeType: 'image/svg+xml',
      kind: 'image',
    });
    assert.equal(isKnownBinaryExtension('a.svg'), false);
    assert.equal(isKnownBinaryExtension('a.woff2'), true);
  });
});
