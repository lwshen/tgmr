import { beforeEach, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { MediaDownloader } from '../src/services/downloader.js';
import { getCooldownRemainingMs } from '../src/utils/hostCooldown.js';
import { withRetry } from '../src/utils/retry.js';
import { MediaError } from '../src/utils/mediaError.js';

const downloader = MediaDownloader.getInstance();
const url = 'https://x.com/example/status/123';

beforeEach((t) => {
  assert.ok('mock' in t);
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Offline test: no status available');
  });
});

// Exercise the public API through a real subprocess that exits with code 0,
// without contacting a network or reading gallery-dl configuration/cookies.
// Tests in this file run sequentially because the stub temporarily changes PATH.
async function stubGalleryDl(t: TestContext, stdout: string, stderr = ''): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'tgmr-gallery-test-'));
  const previousPath = process.env.PATH;
  t.after(async () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(
    join(dir, 'gallery-dl'),
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(stdout)});\n` +
      `process.stderr.write(${JSON.stringify(stderr)});\n`,
    { mode: 0o700 },
  );
  process.env.PATH = [dir, dirname(process.execPath), previousPath].filter(Boolean).join(delimiter);
}

test('getMediaInfo rejects gallery-dl error JSON despite a successful exit code', async (t) => {
  await stubGalleryDl(t, JSON.stringify([[-1, { error: 'KeyError', message: "'result'" }]]));
  await assert.rejects(downloader.getMediaInfo(url), {
    message: "gallery-dl extraction failed: KeyError: 'result'",
  });
});

test('getMediaInfo diagnoses a deleted X post and retains the original error without retrying', async (t) => {
  await stubGalleryDl(t, JSON.stringify([[-1, { error: 'KeyError', message: "'result'" }]]));
  const statusCheck = t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          __typename: 'TweetTombstone',
          tombstone: { text: { text: 'This Post was deleted by the Post author. Learn more' } },
        }),
      ),
  );
  let attempts = 0;
  await assert.rejects(
    withRetry(
      () => {
        attempts++;
        return downloader.getMediaInfo(url);
      },
      { maxAttempts: 3, initialDelay: 1 },
    ),
    (error: unknown) => {
      assert.ok(error instanceof MediaError);
      assert.equal(error.code, 'deleted');
      assert.match(error.message, /X reports this post is deleted/);
      assert.ok(error.cause instanceof Error);
      assert.equal(error.cause.message, "gallery-dl extraction failed: KeyError: 'result'");
      return true;
    },
  );
  assert.equal(attempts, 1);
  assert.equal(statusCheck.mock.callCount(), 1);
});

test('getMediaInfo keeps an unconfirmed X KeyError as an extraction failure', async (t) => {
  await stubGalleryDl(t, JSON.stringify([[-1, { error: 'KeyError', message: "'result'" }]]));
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 404 }));
  await assert.rejects(downloader.getMediaInfo(url), (error: unknown) => {
    assert.ok(error instanceof MediaError);
    assert.equal(error.code, 'extraction_failed');
    assert.match(error.message, /KeyError: 'result'/);
    return true;
  });
});

test('getMediaInfo distinguishes inaccessible posts from confirmed deletion', async (t) => {
  await stubGalleryDl(
    t,
    JSON.stringify([[-1, { error: 'AbortExtraction', message: "'Unavailable'" }]]),
  );
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          __typename: 'TweetTombstone',
          tombstone: { text: { text: 'This Post is unavailable.' } },
        }),
      ),
  );
  await assert.rejects(downloader.getMediaInfo(url), (error: unknown) => {
    assert.ok(error instanceof MediaError);
    assert.equal(error.code, 'unavailable');
    return true;
  });
});

test('authentication failures do not query public post status', async (t) => {
  await stubGalleryDl(
    t,
    JSON.stringify([[-1, { error: 'AuthRequired', message: 'Protected Tweet' }]]),
  );
  const statusCheck = t.mock.method(globalThis, 'fetch');
  await assert.rejects(downloader.getMediaInfo(url), (error: unknown) => {
    assert.ok(error instanceof MediaError);
    assert.equal(error.code, 'authentication_required');
    return true;
  });
  assert.equal(statusCheck.mock.callCount(), 0);
});

test('successful extraction does not query public post status', async (t) => {
  await stubGalleryDl(
    t,
    JSON.stringify([[3, 'https://example.com/image.jpg', { extension: 'jpg' }]]),
  );
  const statusCheck = t.mock.method(globalThis, 'fetch');
  await downloader.getMediaInfo(url);
  assert.equal(statusCheck.mock.callCount(), 0);
});

test('getMediaInfo detects extraction errors after partial media output', async (t) => {
  await stubGalleryDl(
    t,
    JSON.stringify([
      [2, { content: 'A post' }],
      [3, 'https://example.com/image.jpg', { extension: 'jpg' }],
      [-1, { error: 'HttpError', message: 'Read timed out' }],
    ]),
  );
  await assert.rejects(downloader.getMediaInfo(url), /HttpError: Read timed out/);
});

test('getMediaInfo preserves stderr alongside an encoded extraction error', async (t) => {
  await stubGalleryDl(
    t,
    JSON.stringify([[-1, { error: 'AuthRequired', message: 'Login required' }]]),
    '[twitter][warning] Authentication is required\n',
  );
  await assert.rejects(downloader.getMediaInfo(url), {
    message:
      'gallery-dl extraction failed: AuthRequired: Login required\n' +
      '[twitter][warning] Authentication is required',
  });
});

test('JSON-encoded rate limits activate the existing host cooldown', async (t) => {
  const host = 'encoded-limit.x.com';
  await stubGalleryDl(
    t,
    JSON.stringify([
      [
        -1,
        {
          error: 'HttpError',
          message: '429 Too Many Requests',
        },
      ],
    ]),
  );
  assert.equal(getCooldownRemainingMs(host), 0);
  await assert.rejects(downloader.getMediaInfo(`https://${host}/example/status/123`), /429/);
  assert.ok(getCooldownRemainingMs(host) > 0);
  assert.ok(getCooldownRemainingMs(host) <= 90_000);
});

test('rate-limit diagnostics on stderr activate cooldown even with empty JSON', async (t) => {
  const host = 'stderr-limit.x.com';
  await stubGalleryDl(t, '[]', '[twitter][warning] 429 Too Many Requests\n');
  assert.equal(getCooldownRemainingMs(host), 0);
  await assert.rejects(downloader.getMediaInfo(`https://${host}/example/status/123`), /429/);
  assert.ok(getCooldownRemainingMs(host) > 0);
});

test('JSON-encoded transient failures reach the caller retry policy', async (t) => {
  await stubGalleryDl(t, JSON.stringify([[-1, { error: 'HttpError', message: 'Read timed out' }]]));
  let attempts = 0;
  await assert.rejects(
    withRetry(
      () => {
        attempts++;
        return downloader.getMediaInfo(url);
      },
      { maxAttempts: 2, initialDelay: 1, maxDelay: 1 },
    ),
    /Read timed out/,
  );
  assert.equal(attempts, 2);
});

for (const [name, output] of [
  ['empty output', []],
  ['directory metadata only', [[2, { content: 'Text-only post' }]]],
  ['queue records only', [[6, 'https://example.com/other', {}]]],
] as const) {
  test(`getMediaInfo rejects ${name} before the download stage`, async (t) => {
    await stubGalleryDl(t, JSON.stringify(output));
    await assert.rejects(downloader.getMediaInfo(url), {
      message: 'No downloadable media found in gallery-dl output',
    });
  });
}

test('getMediaInfo counts only URL messages across multiple directories', async (t) => {
  await stubGalleryDl(
    t,
    JSON.stringify([
      [2, { tweet_text: 'First post' }],
      [
        3,
        'https://example.com/image.jpg',
        {
          extension: 'jpg',
          display_url: 'https://example.com/preview.jpg',
        },
      ],
      [2, { content: 'Second post' }],
      [3, 'https://example.com/video.mp4', { extension: 'MP4' }],
      [6, 'https://example.com/other', {}],
    ]),
  );
  const info = await downloader.getMediaInfo(url);
  assert.equal(info.title, 'First post');
  assert.equal(info.format, 'video');
  assert.deepEqual(info.contentCounts, { images: 1, videos: 1 });
  assert.deepEqual(info.mediaTypes, [
    { extension: 'jpg', url: 'https://example.com/preview.jpg' },
    { extension: 'MP4', url: 'https://example.com/video.mp4' },
  ]);
});

test('getMediaInfo retains a first URL message when directory metadata is absent', async (t) => {
  await stubGalleryDl(
    t,
    JSON.stringify([
      [3, 'https://example.com/image.jpg', { extension: 'jpg', description: 'An image' }],
    ]),
  );
  const info = await downloader.getMediaInfo(url);
  assert.equal(info.title, 'An image');
  assert.equal(info.format, 'image');
  assert.deepEqual(info.contentCounts, { images: 1, videos: 0 });
});

for (const [name, stdout, error] of [
  ['invalid JSON', 'not JSON', /Failed to parse gallery-dl JSON output/],
  ['non-array output', '{}', /expected array/],
  ['invalid message', '[null]', /expected message arrays/],
  ['missing media URL', '[[3,null,{"extension":"jpg"}]]', /Unexpected gallery-dl media record/],
  [
    'missing media metadata',
    '[[3,"https://example.com/image.jpg",null]]',
    /Unexpected gallery-dl media record/,
  ],
] as const) {
  test(`getMediaInfo rejects ${name}`, async (t) => {
    await stubGalleryDl(t, stdout);
    await assert.rejects(downloader.getMediaInfo(url), error);
  });
}
