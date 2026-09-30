import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Context } from 'grammy';

// Initialize this test process with an actual environment-based exemption list.
// Other test files run in separate processes; restore process.env after imports.
const overrides = {
  RATE_LIMIT: '2',
  COOLDOWN: '60',
  RATE_LIMIT_EXEMPT_USER_IDS: '920001, 920002,1087968824',
};
const previous = Object.keys(overrides).map((key) => [key, process.env[key]] as const);
Object.assign(process.env, overrides);
const [
  { env },
  { handleMessage },
  { MediaDownloader },
  { MediaError, getMediaErrorReply },
  { logger },
  { applyRateLimitFromError },
] = await Promise.all([
  import('../src/config/env.js'),
  import('../src/handlers/message.js'),
  import('../src/services/downloader.js'),
  import('../src/utils/mediaError.js'),
  import('../src/utils/logger.js'),
  import('../src/utils/hostCooldown.js'),
]);
for (const [key, value] of previous) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const execFileAsync = promisify(execFile);
const configUrl = new URL('../src/config/env.js', import.meta.url).href;

async function configuredIds(raw?: string): Promise<number[]> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { env } from ${JSON.stringify(configUrl)}; ` +
        'process.stdout.write(JSON.stringify([...env.RATE_LIMIT_EXEMPT_USER_IDS]));',
    ],
    {
      env: {
        BOT_TOKEN: 'test:token',
        ...(raw === undefined ? {} : { RATE_LIMIT_EXEMPT_USER_IDS: raw }),
      },
      timeout: 5000,
    },
  );
  return JSON.parse(stdout);
}

test('exemption configuration defaults to empty and accepts whitespace, duplicates and large IDs', async () => {
  assert.deepEqual(await configuredIds(), []);
  assert.deepEqual(await configuredIds(''), []);
  assert.deepEqual(await configuredIds(' , '), []);
  assert.deepEqual(await configuredIds(' 123,456,123 ,7000000001,'), [123, 456, 7000000001]);
});

test('exemption configuration rejects malformed or unsafe user IDs at startup', async () => {
  await Promise.all(
    ['123,abc', '123oops', '1.5', '-100', '0', '9007199254740992', '1e3'].map((value) =>
      assert.rejects(configuredIds(value), /RATE_LIMIT_EXEMPT_USER_IDS/),
    ),
  );
});

const host = env.SUPPORTED_DOMAINS[0];
const url = `https://${host}/watch?v=rate-limit-exemption`;
const noMedia = new MediaError('no_media', 'Test extraction stopped before downloading');
let messageId = 1;

function requestContext(
  user: { id: number; username?: string } | undefined,
  chatId: number,
  senderChat = false,
): { ctx: Context; replies: string[] } {
  const replies: string[] = [];
  const chat = { id: chatId, type: chatId < 0 ? 'supergroup' : 'private' };
  const ctx = {
    message: {
      text: url,
      message_id: messageId++,
      ...(senderChat ? { sender_chat: chat } : {}),
    },
    from: user,
    chat,
    api: { sendChatAction: async () => true },
    reply: async (text: string) => {
      replies.push(text);
    },
  } as unknown as Context;
  return { ctx, replies };
}

function stubExtraction(t: TestContext) {
  t.mock.method(logger, 'info', () => {});
  t.mock.method(logger, 'error', () => {});
  return t.mock.method(MediaDownloader.getInstance(), 'getMediaInfo', async () => {
    throw noMedia;
  });
}

test('listed users can exceed the user limit in private chats and groups', async (t) => {
  const extraction = stubExtraction(t);
  for (const chatId of [920001, -100920001]) {
    for (let i = 0; i < 5; i++) {
      const { ctx, replies } = requestContext({ id: 920001 }, chatId);
      await handleMessage(ctx);
      assert.deepEqual(replies, [getMediaErrorReply(noMedia)]);
    }
  }
  assert.equal(extraction.mock.callCount(), 10);
});

for (const { name, user, chatId, senderChat } of [
  { name: 'unlisted user', user: { id: 920010 }, chatId: 920010 },
  { name: 'missing user with a matching chat ID', user: undefined, chatId: 920001 },
  {
    name: 'anonymous administrator',
    user: { id: 1087968824, username: 'GroupAnonymousBot' },
    chatId: -100920011,
  },
  {
    name: 'sender chat with a listed placeholder user ID',
    user: { id: 920002 },
    chatId: -100920012,
    senderChat: true,
  },
]) {
  test(`${name} remains subject to the limit and cooldown`, async (t) => {
    const extraction = stubExtraction(t);
    for (let i = 0; i < 4; i++) {
      const { ctx, replies } = requestContext(user, chatId, senderChat);
      await handleMessage(ctx);
      assert.deepEqual(replies, [
        i < 2
          ? getMediaErrorReply(noMedia)
          : 'You are sending requests too quickly. Please try again later.',
      ]);
    }
    assert.equal(extraction.mock.callCount(), 2);
  });
}

test('listed users still respect site cooldowns', async (t) => {
  const extraction = stubExtraction(t);
  applyRateLimitFromError(host, '429 Too Many Requests');
  const { ctx, replies } = requestContext({ id: 920001 }, 920001);
  await handleMessage(ctx);
  assert.equal(extraction.mock.callCount(), 0);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /is rate-limiting downloads/);
});
