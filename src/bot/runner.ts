import { run, type RunnerHandle } from '@grammyjs/runner';
import type { Bot, BotError } from 'grammy';
import { env } from '../config/env.js';

export async function startBotRunner(bot: Bot): Promise<RunnerHandle> {
  await bot.init();
  await bot.api.deleteWebhook({ drop_pending_updates: true });

  const concurrency = env.MAX_CONCURRENT_MESSAGES;
  const pending = new Set<Promise<unknown>>();
  const track = <T>(task: Promise<T>): Promise<T> => {
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  };

  const runner = run(
    {
      api: {
        // The runner's first fetch requests 100 updates regardless of the sink
        // limit. Cap that batch too so startup cannot exceed our concurrency.
        getUpdates: (args, signal) =>
          bot.api.getUpdates({ ...args, limit: Math.min(args.limit, concurrency) }, signal),
      },
      handleUpdate: (update) => track(bot.handleUpdate(update)),
      errorHandler: (error: BotError) => track(Promise.resolve(bot.errorHandler(error))),
    },
    { sink: { concurrency } },
  );

  return {
    ...runner,
    stop: async (): Promise<void> => {
      try {
        await runner.stop();
      } finally {
        // runner 2.x stops polling before all handlers have necessarily settled.
        // Keep cleanup services alive until requests and error replies finish.
        while (pending.size > 0) await Promise.allSettled([...pending]);
      }
    },
  };
}
