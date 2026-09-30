import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { assertSafePath } from '../src/utils/pathSafety.js';

test('assertSafePath returns the resolved path for files strictly inside base', () => {
  const base = resolve('/tmp/tgmr-base');
  assert.equal(
    assertSafePath('/tmp/tgmr-base/sub/file.mp4', base),
    resolve('/tmp/tgmr-base/sub/file.mp4'),
  );
});

test('assertSafePath accepts filenames and directories beginning with multiple dots', () => {
  const base = resolve('/tmp/tgmr-base');
  for (const name of ['...-2104536733060861952.mp4', '..video.mp4', '...']) {
    const filePath = join(base, name);
    assert.equal(assertSafePath(filePath, base), filePath);
  }
  const nested = join(base, '..album', 'video.mp4');
  assert.equal(assertSafePath(nested, base), nested);
});

test('assertSafePath rejects the base itself, traversal, and outside paths', () => {
  const base = '/tmp/tgmr-base';
  assert.throws(() => assertSafePath('/tmp/tgmr-base', base), /Path traversal/);
  assert.throws(() => assertSafePath('/tmp/tgmr-base/../etc/passwd', base), /Path traversal/);
  assert.throws(() => assertSafePath('/etc/passwd', base), /Path traversal/);
});

test('assertSafePath rejects the parent directory and siblings sharing the base prefix', () => {
  const base = resolve('/tmp/tgmr-base');
  for (const filePath of [
    resolve(base, '..'),
    resolve(base, '../tgmr-base-other/video.mp4'),
    resolve(base, '..album/../../outside.mp4'),
  ]) {
    assert.throws(() => assertSafePath(filePath, base), /Path traversal/);
  }
});
