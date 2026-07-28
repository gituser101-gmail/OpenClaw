// Telegram's sendPhoto endpoint rejects uploads above 10 MiB; larger images
// must use sendDocument in both outbound delivery funnels.
export const TELEGRAM_MAX_PHOTO_BYTES = 10 * 1024 * 1024;
