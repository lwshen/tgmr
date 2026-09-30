import { after, beforeEach, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { Api, Context } from 'grammy';
import type { MediaMetadata } from '../src/services/downloader.js';

// Keep the full handler/probe path offline, without requiring ffmpeg or media downloads.
const dir = await mkdtemp(join(tmpdir(), 'tgmr-progress-test-'));
const previousTmpDir = process.env.TMP_DIR;
const previousMaxFileSize = process.env.MAX_FILE_SIZE;
const previousPath = process.env.PATH;
process.env.TMP_DIR = dir;
process.env.MAX_FILE_SIZE = String(50 * 1024 * 1024);
const [{ handleMessage, stopCacheEvict }, { MediaDownloader }, { env }, { logger }] =
  await Promise.all([
    import('../src/handlers/message.js'),
    import('../src/services/downloader.js'),
    import('../src/config/env.js'),
    import('../src/utils/logger.js'),
  ]);
if (previousTmpDir === undefined) delete process.env.TMP_DIR;
else process.env.TMP_DIR = previousTmpDir;
if (previousMaxFileSize === undefined) delete process.env.MAX_FILE_SIZE;
else process.env.MAX_FILE_SIZE = previousMaxFileSize;
await writeFile(
  join(dir, 'ffprobe'),
  `#!/usr/bin/env node
const path = process.argv.at(-1);
const size = require('node:fs').statSync(path).size;
const stream = path.endsWith('.ogg')
  ? { codec_type: 'audio', codec_name: 'opus' }
  : { codec_type: 'video', codec_name: path.endsWith('.jpg') ? 'mjpeg' : 'h264', width: 320, height: 240 };
const format = path.includes('no-probe-size') ? {} : { size: String(size) };
process.stdout.write(JSON.stringify({ streams: [stream], format }));
`,
  { mode: 0o700 },
);
process.env.PATH = [dir, dirname(process.execPath), previousPath].filter(Boolean).join(delimiter);
after(async () => {
  stopCacheEvict();
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  await rm(dir, { recursive: true, force: true });
});
beforeEach((t) => {
  assert.ok('mock' in t);
  t.mock.method(logger, 'info', () => {});
  t.mock.method(logger, 'error', () => {});
  t.mock.method(logger, 'warn', () => {});
});

let nextId = 930000;
let nextFile = 0;
const downloader = MediaDownloader.getInstance();
const link = (name: string) => `https://${env.SUPPORTED_DOMAINS[0]}/watch?v=${name}`;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function requestContext(
  url: string,
  options: {
    topic?: boolean;
    failInitialReply?: boolean;
    failEdits?: boolean;
    failDelete?: boolean;
    failUpload?: boolean;
    onStatus?: (text: string) => void;
  } = {},
) {
  const id = nextId++;
  const events: string[] = [];
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const statuses = new Map<number, string>();
  const chat = options.topic
    ? ({ id: -id, type: 'supergroup', title: 'Test' } as const)
    : ({ id, type: 'private', first_name: 'Test' } as const);
  const api = new Api('test:token');
  // Intercept every API method: these tests never send real Telegram messages.
  api.config.use(async (_previous, method, payload) => {
    const data = payload as Record<string, unknown>;
    calls.push({ method, payload: data });
    let result: unknown = true;
    if (method === 'sendMessage' || method === 'editMessageText') {
      const text = data.text as string;
      events.push(text);
      options.onStatus?.(text);
      if (method === 'editMessageText' && options.failEdits) {
        throw new Error('Bad Request: message to edit not found');
      }
      if (method === 'sendMessage' && text === 'Received.' && options.failInitialReply) {
        throw new Error('Cannot send status');
      }
      const messageId =
        method === 'sendMessage' ? id + 100000 + statuses.size : (data.message_id as number);
      statuses.set(messageId, text);
      result = { message_id: messageId, date: 0, chat, text };
    } else if (method === 'deleteMessage') {
      events.push(method);
      assert.equal(data.chat_id, chat.id);
      assert.ok(statuses.has(data.message_id as number), 'only delete the progress message');
      if (options.failDelete) throw new Error('Cannot delete status');
      statuses.delete(data.message_id as number);
    } else if (['sendVideo', 'sendPhoto', 'sendVoice', 'sendMediaGroup'].includes(method)) {
      events.push(method);
      if (method !== 'sendMediaGroup' && options.failUpload) {
        throw new Error('Upload failed: private diagnostic');
      }
      result = { message_id: id + 200000, date: 0, chat };
      if (method === 'sendMediaGroup') result = [result];
    } else {
      assert.equal(method, 'sendChatAction', 'unexpected Telegram method');
    }
    return { ok: true, result: result as never };
  });
  const ctx = new Context(
    {
      update_id: id,
      message: {
        message_id: id,
        date: 0,
        text: url,
        chat,
        from: { id, is_bot: false, first_name: 'Test' },
        ...(options.topic && { is_topic_message: true, message_thread_id: 42 }),
      },
    },
    api,
    {} as Context['me'],
  );
  return { ctx, events, calls, statuses };
}

function stubDownload(
  t: TestContext,
  events: string[],
  options: {
    format?: MediaMetadata['format'];
    count?: number;
    gate?: Promise<void>;
    sizeBytes?: number;
    omitProbeSize?: boolean;
  } = {},
) {
  const format = options.format ?? 'video';
  const info = t.mock.method(downloader, 'getMediaInfo', async (url: string) => {
    events.push('extract');
    return { url, title: 'Test', format };
  });
  const download = t.mock.method(downloader, 'download', async (url: string) => {
    events.push('download');
    await options.gate;
    const extension = { video: 'mp4', image: 'jpg', audio: 'ogg' }[format];
    const filePaths = Array.from({ length: options.count ?? 1 }, () =>
      join(dir, `${nextFile++}${options.omitProbeSize ? '-no-probe-size' : ''}.${extension}`),
    );
    await Promise.all(
      filePaths.map(async (path) => {
        await writeFile(path, 'x');
        if (options.sizeBytes !== undefined) await truncate(path, options.sizeBytes);
      }),
    );
    return { success: true, filePaths, mediaInfo: { url, title: 'Test', format } };
  });
  return { info, download };
}

for (const [format, method] of [
  ['video', 'sendVideo'],
  ['image', 'sendPhoto'],
  ['audio', 'sendVoice'],
] as const) {
  test(`${format} requests edit one reply through each stage before the corresponding work`, async (t) => {
    const request = requestContext(link(`stages-${format}`), { topic: true });
    stubDownload(t, request.events, { format });
    await handleMessage(request.ctx);
    assert.deepEqual(request.events, [
      'Received.',
      'Fetching media info...',
      'extract',
      'Waiting to download...',
      `Downloading ${format}...`,
      'download',
      'Preparing media...',
      'Sending media...',
      method,
      'deleteMessage',
    ]);
    assert.equal(request.statuses.size, 0);
    const replies = request.calls.filter((call) => call.method === 'sendMessage');
    assert.equal(replies.length, 1);
    assert.deepEqual(replies[0].payload.reply_parameters, {
      message_id: request.ctx.message!.message_id,
      allow_sending_without_reply: true,
    });
    assert.equal(replies[0].payload.message_thread_id, 42);
    assert.equal(replies[0].payload.disable_notification, true);
    for (const call of request.calls.filter((call) => call.method === 'editMessageText')) {
      assert.equal(call.payload.chat_id, request.ctx.chat!.id);
      const deletion = request.calls.find((call) => call.method === 'deleteMessage')!;
      assert.equal(call.payload.message_id, deletion.payload.message_id);
    }
  });
}

test('cache hits show their own sending status and upload errors replace it', async (t) => {
  const url = link('cache');
  const first = requestContext(url);
  const { info, download } = stubDownload(t, first.events);
  await handleMessage(first.ctx);
  const cached = requestContext(url);
  await handleMessage(cached.ctx);
  assert.deepEqual(cached.events, ['Received.', 'Sending media...', 'sendVideo', 'deleteMessage']);
  assert.equal(cached.statuses.size, 0);
  const failed = requestContext(url, { failUpload: true });
  await handleMessage(failed.ctx);
  assert.deepEqual(
    [...failed.statuses.values()],
    ['Failed to process media. Please try again later.'],
  );
  assert.ok(!failed.events.includes('deleteMessage'));
  assert.equal(info.mock.callCount(), 1);
  assert.equal(download.mock.callCount(), 1);
});

test(
  'concurrent duplicates each receive progress while sharing one download',
  { timeout: 5000 },
  async (t) => {
    const release = deferred();
    const downloading = deferred();
    const joined = deferred();
    t.after(release.resolve);
    const url = link('shared');
    const first = requestContext(url, {
      onStatus: (text) => {
        if (text === 'Downloading video...') downloading.resolve();
      },
    });
    const second = requestContext(url, {
      onStatus: (text) => {
        if (text === 'Downloading video...') joined.resolve();
      },
    });
    const { info, download } = stubDownload(t, first.events, { gate: release.promise });
    const firstRun = handleMessage(first.ctx);
    await downloading.promise;
    const secondRun = handleMessage(second.ctx);
    await joined.promise;
    release.resolve();
    await Promise.all([firstRun, secondRun]);
    assert.deepEqual(second.events, [
      'Received.',
      'Downloading video...',
      'Preparing media...',
      'Sending media...',
      'sendVideo',
      'deleteMessage',
    ]);
    assert.equal(first.statuses.size, 0);
    assert.equal(second.statuses.size, 0);
    assert.equal(info.mock.callCount(), 1);
    assert.equal(download.mock.callCount(), 1);
  },
);

for (const failure of ['failInitialReply', 'failEdits', 'failDelete'] as const) {
  test(`${failure} does not prevent delivery or send an extra completion message`, async (t) => {
    const request = requestContext(link(failure), { [failure]: true });
    const { download } = stubDownload(t, request.events);
    await handleMessage(request.ctx);
    assert.equal(download.mock.callCount(), 1);
    assert.ok(request.events.includes('sendVideo'));
    assert.ok(!request.events.includes('Sent.'));
    assert.deepEqual(
      [...request.statuses.values()],
      failure === 'failDelete' ? ['Sending media...'] : [],
    );
    const replies = request.calls.filter((call) => call.method === 'sendMessage');
    assert.equal(replies.length, 1);
    assert.equal(
      request.calls.filter((call) => call.method === 'deleteMessage').length,
      failure === 'failInitialReply' ? 0 : 1,
    );
  });
}

test('partial albums finish with the actual count rather than a success status', async (t) => {
  const request = requestContext(link('partial-album'), { failUpload: true });
  stubDownload(t, request.events, { count: 11 });
  await handleMessage(request.ctx);
  assert.deepEqual(
    [...request.statuses.values()],
    ['Sent 10 of 11 items; the rest failed — please retry.'],
  );
  assert.ok(!request.events.includes('Sent.'));
  assert.ok(!request.events.includes('deleteMessage'));
  assert.equal(request.calls.filter((call) => call.method === 'sendMessage').length, 1);
});

test('an empty download replaces the status with a failure and never starts sending', async (t) => {
  const request = requestContext(link('empty'));
  stubDownload(t, request.events, { count: 0 });
  await handleMessage(request.ctx);
  assert.deepEqual(
    [...request.statuses.values()],
    ['Failed to process media. Please try a different URL.'],
  );
  assert.ok(!request.events.includes('Sending media...'));
  assert.ok(!request.events.includes('deleteMessage'));
});

for (const [name, options, expected] of [
  [
    'oversized-file',
    { sizeBytes: Math.round(72.1 * 1024 * 1024) },
    'Media file (72.1MB) exceeds size limit (50MB)',
  ],
  [
    'oversized-file-without-probe-size',
    { sizeBytes: Math.round(72.1 * 1024 * 1024), omitProbeSize: true },
    'Media file (72.1MB) exceeds size limit (50MB)',
  ],
  [
    'oversized-album',
    { sizeBytes: 50 * 1024 * 1024, count: 11 },
    'Album total (550.0MB) exceeds size limit (500MB)',
  ],
] as const) {
  test(`${name} reports actual size and limit in Telegram and cleans up files`, async (t) => {
    const request = requestContext(link(name));
    const { download } = stubDownload(t, request.events, options);
    await handleMessage(request.ctx);
    assert.deepEqual([...request.statuses.values()], [expected]);
    assert.equal(request.calls.filter((call) => call.method === 'sendMessage').length, 1);
    assert.ok(!request.events.includes('Sending media...'));
    assert.ok(!request.events.includes('deleteMessage'));
    const result = await download.mock.calls[0].result;
    assert.ok(result);
    for (const path of result.filePaths) {
      await assert.rejects(access(path), { code: 'ENOENT' });
    }
  });
}

test('a file exactly at the size limit is sent successfully', async (t) => {
  const request = requestContext(link('file-at-size-limit'));
  stubDownload(t, request.events, { sizeBytes: env.MAX_FILE_SIZE });
  await handleMessage(request.ctx);
  assert.ok(request.events.includes('sendVideo'));
  assert.equal(request.statuses.size, 0);
});
