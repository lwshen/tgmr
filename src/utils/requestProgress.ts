import type { Context } from 'grammy';
import { logger } from './logger.js';
import { withTelegramFlood } from './telegramFlood.js';

/** One editable reply per request. Status failures must not abort media delivery. */
export class RequestProgress {
  private statusMessageId?: number;
  private lastText?: string;
  private lastLoggedText?: string;
  private disabled = false;
  private pending = Promise.resolve();

  constructor(
    private readonly ctx: Context,
    private readonly chatId: number,
    private readonly sourceMessageId: number,
    private readonly logCtx: Record<string, unknown>,
  ) {}

  update(text: string, final = false): Promise<void> {
    // Keep tracking stages even if Telegram status updates are disabled.
    // The handler already logs final errors with their diagnostic details.
    if (!final && text !== this.lastLoggedText) {
      logger.info(text, this.logCtx);
      this.lastLoggedText = text;
    }
    // Shared downloads can publish a new stage while a previous edit is pending.
    // Serialize edits so an older stage cannot overwrite the final result.
    this.pending = this.pending.then(() => this.write(text, final));
    return this.pending;
  }

  remove(): Promise<void> {
    this.pending = this.pending.then(async () => {
      if (this.statusMessageId === undefined) return;
      try {
        await withTelegramFlood(() =>
          this.ctx.api.deleteMessage(this.chatId, this.statusMessageId!),
        );
        this.statusMessageId = undefined;
      } catch (error) {
        logger.debug('Failed to delete request progress', { ...this.logCtx, error });
      }
    });
    return this.pending;
  }

  private async write(text: string, final: boolean): Promise<void> {
    if ((!final && this.disabled) || text === this.lastText) return;

    if (this.statusMessageId !== undefined) {
      try {
        await withTelegramFlood(() =>
          this.ctx.api.editMessageText(this.chatId, this.statusMessageId!, text, {
            business_connection_id: this.ctx.businessConnectionId,
          }),
        );
        this.lastText = text;
        return;
      } catch (error) {
        if (error instanceof Error && /message is not modified/i.test(error.message)) {
          this.lastText = text;
          return;
        }
        this.disabled = true;
        logger.debug('Failed to edit request progress', { ...this.logCtx, error });
        if (!final) return;
        // A deleted/uneditable status must not hide an error or partial result.
      }
    }

    try {
      const message = await withTelegramFlood(() =>
        this.ctx.reply(text, {
          reply_parameters: {
            message_id: this.sourceMessageId,
            allow_sending_without_reply: true,
          },
          disable_notification: true,
        }),
      );
      this.statusMessageId = message.message_id;
      this.lastText = text;
    } catch (error) {
      this.disabled = true;
      logger.debug('Failed to send request progress', { ...this.logCtx, error });
    }
  }
}
