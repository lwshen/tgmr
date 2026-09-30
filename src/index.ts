import { BOT_COMMANDS, createBot } from './bot/index.js';
import { startBotRunner } from './bot/runner.js';
import type { RunnerHandle } from '@grammyjs/runner';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { Cleanup } from './utils/cleanup.js';
import { RateLimiter } from './utils/rateLimit.js';
import { startVersionCheck, stopVersionCheck } from './services/versionCheck.js';
import { stopCacheEvict } from './handlers/message.js';
import { stopPermissionPrune } from './bot/index.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { error: reason });
});
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error });
  process.exit(1);
});

async function main(): Promise<void> {
  try {
    await Cleanup.init();
    Cleanup.startPeriodicCleanup();
    logger.info('Started cleanup service');

    const bot = await createBot();
    logger.info('Starting bot...');

    let runner: RunnerHandle;
    try {
      runner = await startBotRunner(bot);
    } catch (error) {
      if (error instanceof Error && error.message.includes('404: Not Found')) {
        logger.error('Invalid bot token');
        process.exit(1);
      }
      throw error;
    }

    startVersionCheck();

    let isShuttingDown = false;
    const shutdown = async (): Promise<void> => {
      if (isShuttingDown) return; // one-shot: a second signal must not run teardown concurrently
      isShuttingDown = true;
      logger.info('Shutting down...');
      // Hard-exit fallback if graceful shutdown hangs
      const hardExit = setTimeout(() => {
        logger.warn('Shutdown timed out, forcing exit');
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
      hardExit.unref();

      try {
        await runner.stop();
      } catch (error) {
        logger.error('Error stopping bot', { error });
      }
      Cleanup.stop();
      RateLimiter.getInstance().stop();
      stopVersionCheck();
      stopCacheEvict();
      stopPermissionPrune();
      process.exitCode = 0;
    };
    process.on('SIGTERM', () => void shutdown());
    process.on('SIGINT', () => void shutdown());

    logger.info(`Bot @${bot.botInfo.username} is starting...`, {
      concurrency: env.MAX_CONCURRENT_MESSAGES,
    });
    // Menu registration must not delay polling if Telegram is slow.
    void bot.api.setMyCommands(BOT_COMMANDS).catch((error) => {
      logger.error('Failed to update bot command menu', { error });
    });
    await runner.task();
  } catch (error) {
    logger.error('Failed to start bot', { error });
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error('Unhandled error in main', { error });
  process.exit(1);
});
