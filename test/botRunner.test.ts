import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Bot } from 'grammy';
import type { Update } from 'grammy/types';

const previousConcurrency = process.env.MAX_CONCURRENT_MESSAGES;
process.env.MAX_CONCURRENT_MESSAGES = '2';
const { startBotRunner } = await import('../src/bot/runner.js');
if (previousConcurrency === undefined) delete process.env.MAX_CONCURRENT_MESSAGES;
else process.env.MAX_CONCURRENT_MESSAGES = previousConcurrency;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function offlineBot(count: number) {
  const bot = new Bot('test:token');
  const methods: string[] = [];
  const polls: { limit: number; offset: number }[] = [];
  const polling = deferred();
  const aborted = deferred();
  const updates: Update[] = Array.from({ length: count }, (_, index) => ({
    update_id: index + 1,
    message: {
      message_id: index + 1,
      date: 0,
      text: `request ${index + 1}`,
      chat: { id: 42, type: 'private', first_name: 'Test' },
      from: { id: 42, is_bot: false, first_name: 'Test' },
    },
  }));
  // Intercept all API calls, including long polling: never contact Telegram.
  bot.api.config.use(async (_previous, method, payload, signal) => {
    methods.push(method);
    if (method === 'getMe') {
      return {
        ok: true,
        result: { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' } as never,
      };
    }
    if (method === 'deleteWebhook') {
      assert.deepEqual(payload, { drop_pending_updates: true });
      return { ok: true, result: true as never };
    }
    assert.equal(method, 'getUpdates');
    const args = payload as { limit: number; offset: number };
    polls.push(args);
    const batch = updates.filter((update) => update.update_id >= args.offset).slice(0, args.limit);
    if (batch.length > 0) return { ok: true, result: batch as never };
    assert.ok(signal);
    polling.resolve();
    return new Promise<never>((_resolve, reject) => {
      const abort = () => {
        aborted.resolve();
        reject(new Error('Polling aborted'));
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  });
  return { bot, methods, polls, polling, aborted };
}

test(
  'same-chat messages overlap within the configured cap, including the first batch',
  { timeout: 5000 },
  async (t) => {
    const { bot, methods, polls, polling } = offlineBot(5);
    const gates = Array.from({ length: 5 }, deferred);
    const started = Array.from({ length: 5 }, deferred);
    const finished: number[] = [];
    let active = 0;
    let peak = 0;
    bot.on('message:text', async (ctx) => {
      const index = ctx.update.update_id - 1;
      active++;
      peak = Math.max(peak, active);
      started[index].resolve();
      await gates[index].promise;
      finished.push(index + 1);
      active--;
    });
    const runner = await startBotRunner(bot);
    t.after(async () => {
      gates.forEach((gate) => gate.resolve());
      await runner.stop();
    });

    await Promise.all([started[0].promise, started[1].promise]);
    assert.equal(active, 2);
    assert.equal(finished.length, 0);
    assert.deepEqual(methods.slice(0, 3), ['getMe', 'deleteWebhook', 'getUpdates']);
    assert.equal(polls[0].limit, 2);

    // A free slot starts the next batch while the first request is still blocked.
    for (let index = 1; index < 4; index++) {
      gates[index].resolve();
      await started[index + 1].promise;
      assert.equal(active, 2);
      assert.ok(!finished.includes(1));
    }
    gates[4].resolve();
    gates[0].resolve();
    await polling.promise;
    await runner.stop();
    assert.equal(peak, 2);
    assert.equal(active, 0);
    assert.deepEqual([...finished].sort(), [1, 2, 3, 4, 5]);
    assert.ok(polls.every(({ limit }) => limit <= 2));
    assert.deepEqual(
      polls.slice(0, 4).map(({ offset }) => offset),
      [0, 3, 4, 5],
    );
  },
);

test(
  'shutdown aborts polling and waits for an unfinished message',
  { timeout: 5000 },
  async (t) => {
    const { bot, polling, aborted, polls } = offlineBot(1);
    const gate = deferred();
    let finished = false;
    bot.on('message:text', async () => {
      await gate.promise;
      finished = true;
    });
    const runner = await startBotRunner(bot);
    t.after(async () => {
      gate.resolve();
      await runner.stop();
    });
    await polling.promise;
    let stopped = false;
    const stopping = runner.stop().then(() => {
      stopped = true;
    });
    await aborted.promise;
    await setImmediate();
    assert.equal(stopped, false);
    assert.equal(finished, false);
    const pollCount = polls.length;
    gate.resolve();
    await stopping;
    assert.equal(finished, true);
    assert.equal(polls.length, pollCount);
  },
);

test(
  'a failed message uses bot.catch without blocking other messages and drains its error handler',
  { timeout: 5000 },
  async (t) => {
    const { bot, polling } = offlineBot(3);
    const errorReply = deferred();
    const errorStarted = deferred();
    const failure = new Error('Request failed');
    const processed: number[] = [];
    bot.on('message:text', (ctx) => {
      if (ctx.update.update_id === 1) throw failure;
      processed.push(ctx.update.update_id);
    });
    bot.catch(async (error) => {
      assert.equal(error.error, failure);
      assert.equal(error.ctx.update.update_id, 1);
      errorStarted.resolve();
      await errorReply.promise;
    });
    const runner = await startBotRunner(bot);
    t.after(async () => {
      errorReply.resolve();
      await runner.stop();
    });
    await Promise.all([errorStarted.promise, polling.promise]);
    assert.deepEqual(processed, [2, 3]);
    let stopped = false;
    const stopping = runner.stop().then(() => {
      stopped = true;
    });
    await setImmediate();
    assert.equal(stopped, false);
    errorReply.resolve();
    await stopping;
    assert.equal(stopped, true);
  },
);

const execFileAsync = promisify(execFile);
const configUrl = new URL('../src/config/env.js', import.meta.url).href;
async function configuredConcurrency(raw?: string): Promise<number> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { env } from ${JSON.stringify(configUrl)}; console.log(env.MAX_CONCURRENT_MESSAGES);`,
    ],
    {
      env: {
        BOT_TOKEN: 'test:token',
        ...(raw === undefined ? {} : { MAX_CONCURRENT_MESSAGES: raw }),
      },
      timeout: 5000,
    },
  );
  return Number(stdout.trim());
}

test('message concurrency defaults to 3 and accepts a positive integer including 1', async () => {
  assert.equal(await configuredConcurrency(), 3);
  assert.equal(await configuredConcurrency('1'), 1);
  assert.equal(await configuredConcurrency('20'), 20);
});

test('message concurrency rejects malformed, nonpositive and unsafe values', async () => {
  await Promise.all(
    ['0', '-1', '1.5', '10oops', 'NaN', 'Infinity', '9007199254740992'].map((raw) =>
      assert.rejects(
        configuredConcurrency(raw),
        /MAX_CONCURRENT_MESSAGES must be a positive integer/,
      ),
    ),
  );
});
