import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { getYtDlpOutputArgs } from '../src/utils/ytDlpFilename.js';

const execFileAsync = promisify(execFile);

test('yt-dlp uses no title for empty sanitized titles and preserves meaningful titles', async (t) => {
  try {
    await execFileAsync('yt-dlp', ['--ignore-config', '--version']);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      t.skip('Requires the yt-dlp runtime dependency');
      return;
    }
    throw error;
  }

  const dir = await mkdtemp(join(tmpdir(), 'tgmr-filename-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cases: Array<[string | undefined, string]> = [
    ['🧦 - 中文正文...', 'no_title'],
    ['...', 'no_title'],
    ['', 'no_title'],
    [undefined, 'no_title'],
    ['   ', 'no_title'],
    ['中文', 'no_title'],
    ['🧦', 'no_title'],
    ['---___!!!', 'no_title'],
    ['Hello world', 'Hello_world'],
    ['...Intro', '...Intro'],
    ['é', 'e'],
    ['１２３', '123'],
    ['ＡＢＣ', 'ABC'],
    ['中文 OpenAI 教程', 'OpenAI'],
  ];
  const fixture = join(dir, 'media.json');
  await writeFile(
    fixture,
    JSON.stringify(
      cases.map(([title], index) => ({
        id: `media${index}`,
        title,
        extractor: 'generic',
        extractor_key: 'Generic',
        webpage_url: `https://example.invalid/media${index}`,
        url: `https://example.invalid/media${index}.mp4`,
        ext: 'mp4',
      })),
    ),
  );
  // Load synthetic metadata and simulate only: no network, cookies, or downloads.
  const { stdout } = await execFileAsync(
    'yt-dlp',
    [
      '--ignore-config',
      '--no-plugin-dirs',
      '--no-cache-dir',
      '--simulate',
      '--load-info-json',
      fixture,
      ...getYtDlpOutputArgs(dir),
      '--print',
      '%(.{id,title,filename})j',
    ],
    { timeout: 30_000 },
  );
  const entries = stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(entries.length, cases.length);
  entries.forEach((entry, index) => {
    const [title, filenameTitle] = cases[index];
    if (title) assert.equal(entry.title, title, 'The original title must remain intact');
    assert.equal(basename(entry.filename), `${filenameTitle}-media${index}.mp4`);
  });
});
