import { after, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { MediaMetadata } from '../src/services/downloader.js';

const root = await mkdtemp(join(tmpdir(), 'tgmr-remnants-test-'));
const mediaDir = join(root, 'media');
const previousTmp = process.env.TMP_DIR;
process.env.TMP_DIR = mediaDir;
const { MediaDownloader } = await import('../src/services/downloader.js');
if (previousTmp === undefined) delete process.env.TMP_DIR;
else process.env.TMP_DIR = previousTmp;
after(() => rm(root, { recursive: true, force: true }));
const downloader = MediaDownloader.getInstance();
const options = { format: 'video' as const, maxFileSize: 50 * 1024 * 1024, timeout: 5 };

function metadata(url: string, images = 0, videos = 1): MediaMetadata {
  return { url, title: 'Test', format: 'video', contentCounts: { images, videos } };
}

// Real subprocesses write outputs using the requested filename templates.
// This covers files that never reach stdout, including actual process timeouts.
async function stubDownloads(t: TestContext): Promise<void> {
  await mkdir(mediaDir, { recursive: true });
  const bin = await mkdtemp(join(root, 'bin-'));
  const previousPath = process.env.PATH;
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const gallery = args.includes('--dest');
const mode = new URL(args.at(-1)).searchParams.get('mode');
const output = gallery
  ? path.join(value('--dest'), 'site', 'author', value('--filename')
      .replace('{filename}', 'native-id').replace('{extension}', 'jpg'))
  : value('--output').replace('%(tgmr_filename_title|no title)s', 'native')
      .replace('%(id)s', 'id').replace('%(ext)s', 'mp4');
fs.mkdirSync(path.dirname(output), { recursive: true });
const stem = output.replace(/\\.[^.]+$/, '');
for (const suffix of ['.mp4.part', '.mp4.ytdl', '.f137.mp4', '.temp.mp4', '.jpg']) {
  fs.writeFileSync(stem + suffix, 'remnant');
}
if (mode === 'timeout') {
  fs.writeFileSync(${JSON.stringify(join(root, 'timeout-started'))}, 'ready');
  setInterval(() => {}, 1000);
} else if (mode === 'fail' || (mode === 'fail-video' && !gallery)) {
  // A completed but unreported file must also be removed on total failure.
  fs.writeFileSync(output, 'unreported');
  process.stderr.write('Download failed');
  process.exitCode = 1;
} else if (mode !== 'empty') {
  fs.writeFileSync(output, 'completed');
  if (!gallery) fs.writeFileSync(stem + '.jpg', 'thumbnail');
  if (mode === 'wait') {
    fs.writeFileSync(${JSON.stringify(join(root, 'waiting'))}, 'ready');
    const timer = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(join(root, 'release'))})) {
        clearInterval(timer);
        process.stdout.write(output + '\\n');
      }
    }, 20);
  } else {
    process.stdout.write(output + '\\n');
    if (mode === 'partial') {
      fs.writeFileSync(stem + '-second.mp4.part', 'partial second video');
      fs.writeFileSync(stem + '-second.jpg', 'unused thumbnail');
      process.exitCode = 1;
    }
  }
}
`;
  await Promise.all(
    ['yt-dlp', 'gallery-dl'].map((tool) => writeFile(join(bin, tool), script, { mode: 0o700 })),
  );
  process.env.PATH = [bin, dirname(process.execPath), previousPath].filter(Boolean).join(delimiter);
  t.after(async () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(mediaDir, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
  });
}

async function files(dir = mediaDir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    }),
  );
  return nested.flat().sort();
}

for (const domain of ['youtube.com', 'x.com']) {
  for (const mode of ['fail', 'timeout', 'empty']) {
    test(`${domain}: cleans ${mode} remnants without touching unrelated files`, async (t) => {
      await stubDownloads(t);
      const existing = ['cached.mp4', 'cached.jpg', 'other-request.mp4.part'].map((name) =>
        join(mediaDir, name),
      );
      await Promise.all(existing.map((path) => writeFile(path, 'keep')));
      const url = `https://${domain}/example?mode=${mode}`;
      const download = downloader.download(
        url,
        { ...options, timeout: mode === 'timeout' ? 1 : 5 },
        metadata(url, domain === 'x.com' ? 1 : 0, domain === 'x.com' ? 0 : 1),
      );
      if (mode === 'empty') {
        assert.equal((await download).success, false);
      } else {
        await assert.rejects(download, (error: unknown) => {
          assert.ok(error instanceof Error);
          if (mode === 'timeout') assert.equal((error as Error & { killed: boolean }).killed, true);
          else assert.match(error.message, /Download failed/);
          return true;
        });
        if (mode === 'timeout') {
          await access(join(root, 'timeout-started'));
          await rm(join(root, 'timeout-started'));
        }
      }
      assert.deepEqual(await files(), existing.sort());
    });
  }
}

test('partial video success retains the completed video and thumbnail only', async (t) => {
  await stubDownloads(t);
  const url = 'https://x.com/example?mode=partial';
  const result = await downloader.download(url, options, metadata(url, 0, 2));
  assert.equal(result.success, true);
  assert.equal(result.filePaths.length, 1);
  const [path] = result.filePaths;
  assert.deepEqual(await files(), [path, path.replace(/\.[^.]+$/, '.jpg')].sort());
});

test('failed carousel videos leave successful gallery images available', async (t) => {
  await stubDownloads(t);
  const url = 'https://x.com/example?mode=fail-video';
  const result = await downloader.download(url, options, metadata(url, 1, 1));
  assert.equal(result.success, true);
  assert.equal(result.filePaths.length, 1);
  assert.deepEqual(await files(), result.filePaths);
});

test('failure cleanup preserves another active download with the same native filename', async (t) => {
  await stubDownloads(t);
  const url = 'https://youtube.com/example?mode=wait';
  const active = downloader.download(url, options, metadata(url));
  try {
    // Wait until the other process has files on disk but has not returned paths.
    let started = false;
    for (let i = 0; i < 100; i++) {
      try {
        await access(join(root, 'waiting'));
        started = true;
        break;
      } catch {
        await delay(20);
      }
    }
    assert.equal(started, true);
    const activeFiles = await files();
    const failingUrl = 'https://youtube.com/example?mode=fail';
    await assert.rejects(
      downloader.download(failingUrl, options, metadata(failingUrl)),
      /Download failed/,
    );
    assert.deepEqual(await files(), activeFiles);
  } finally {
    await writeFile(join(root, 'release'), 'ready');
    const result = await active;
    assert.equal(result.success, true);
    assert.deepEqual(
      await files(),
      result.filePaths.flatMap((path) => [path, path.replace(/\.[^.]+$/, '.jpg')]).sort(),
    );
  }
});
