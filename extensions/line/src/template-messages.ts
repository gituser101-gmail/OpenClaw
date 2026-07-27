// Line plugin module implements template messages behavior.
import type { messagingApi } from "@line/bot-sdk";
import {
  messageAction,
  normalizeLineAction,
  postbackAction,
  uriAction,
  type Action,
} from "./actions.js";
import type { LineTemplateMessagePayload } from "./types.js";

type TemplateMessage = messagingApi.TemplateMessage;
type TextMessage = messagingApi.TextMessage;
type ConfirmTemplate = messagingApi.ConfirmTemplate;
type ButtonsTemplate = messagingApi.ButtonsTemplate;
type CarouselTemplate = messagingApi.CarouselTemplate;
type CarouselColumn = messagingApi.CarouselColumn;
type ImageCarouselTemplate = messagingApi.ImageCarouselTemplate;
type ImageCarouselColumn = messagingApi.ImageCarouselColumn;

const COMPACT_TEMPLATE_TEXT_LIMIT = 60;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type TemplatePayloadAction = {
  type?: "uri" | "postback" | "message";
  uri?: string;
  data?: string;
  label: string;
};

function buildTemplatePayloadAction(action: TemplatePayloadAction): Action {
  if (action.type === "uri" && action.uri) {
    return uriAction(action.label, action.uri);
  }
  if (action.type === "postback" && action.data) {
    return postbackAction(action.label, action.data, action.label);
  }
  return messageAction(action.label, action.data ?? action.label);
}

function resolveTemplateTextLimit(params: {
  title?: string;
  thumbnailImageUrl?: string;
  textOnlyLimit: number;
}): number {
  return params.title !== undefined || params.thumbnailImageUrl !== undefined
    ? COMPACT_TEMPLATE_TEXT_LIMIT
    : params.textOnlyLimit;
}

function truncateTemplateText(text: string, limit: number): string {
  let result = "";
  for (const { segment } of graphemeSegmenter.segment(text)) {
    if (result.length + segment.length > limit) {
      // A pathological grapheme can exceed LINE's whole field limit. Preserve
      // graphemes normally, but keep required text non-empty without splitting
      // a surrogate pair when the first grapheme alone cannot fit.
      if (!result) {
        for (const codePoint of segment) {
          if (result.length + codePoint.length > limit) {
            break;
          }
          result += codePoint;
        }
      }
      break;
    }
    result += segment;
  }
  return result;
}

function truncateOptionalTemplateText(
  value: string | undefined,
  limit: number,
): string | undefined {
  return value === undefined ? undefined : truncateTemplateText(value, limit);
}

function formatProductCarouselText(description: string, price?: string): string {
  if (!price) {
    return description;
  }
  const priceText = truncateTemplateText(price, COMPACT_TEMPLATE_TEXT_LIMIT);
  const descriptionLimit = Math.max(0, COMPACT_TEMPLATE_TEXT_LIMIT - priceText.length - 1);
  const descriptionText = truncateTemplateText(description, descriptionLimit);
  return descriptionText ? `${descriptionText}\n${priceText}` : priceText;
}

function normalizeCarouselColumnActions(column: CarouselColumn): CarouselColumn {
  return {
    ...column,
    actions: column.actions.map((action) => normalizeLineAction(action)),
    defaultAction:
      column.defaultAction === undefined ? undefined : normalizeLineAction(column.defaultAction),
  };
}

function normalizeImageCarouselColumnAction(column: ImageCarouselColumn): ImageCarouselColumn {
  return {
    ...column,
    action: normalizeLineAction(column.action, 12),
  };
}

// Template buttons render their label; LINE rejects the whole message when a
// template action's label is empty.
function hasRenderableLabel(action: Action): boolean {
  return Boolean(action.label);
}

// LINE rejects the whole carousel unless every column keeps at least one
// labeled action and title, thumbnail, and action count usage match across
// columns.
function normalizeCarouselColumns(columns: CarouselColumn[]): CarouselColumn[] {
  const deliverable = columns
    .map((column) => {
      const normalized = normalizeCarouselColumnActions(column);
      normalized.actions = normalized.actions.filter(hasRenderableLabel);
      return normalized;
    })
    .filter((column) => column.actions.length > 0);
  if (deliverable.length === 0) {
    return [];
  }
  const actionCount = Math.min(...deliverable.map((column) => column.actions.length));
  const foldTitles = deliverable.some((column) => column.title === undefined);
  const dropThumbnails = deliverable.some((column) => column.thumbnailImageUrl === undefined);
  return deliverable.map((column) => {
    const title = foldTitles ? undefined : column.title;
    const thumbnailImageUrl = dropThumbnails ? undefined : column.thumbnailImageUrl;
    // A title dropped for cross-column consistency is folded into the text so
    // its content still reaches the user; the text limit is re-resolved because
    // it depends on title and thumbnail presence.
    const text =
      foldTitles && column.title !== undefined ? `${column.title}: ${column.text}` : column.text;
    return Object.assign(column, {
      title,
      text: truncateTemplateText(
        text,
        resolveTemplateTextLimit({ title, thumbnailImageUrl, textOnlyLimit: 120 }),
      ),
      thumbnailImageUrl,
      actions: column.actions.slice(0, actionCount),
    });
  });
}

/**
 * Create a confirm template (yes/no style dialog)
 */
export function createConfirmTemplate(
  text: string,
  confirmAction: Action,
  cancelAction: Action,
  altText?: string,
): TemplateMessage {
  const template: ConfirmTemplate = {
    type: "confirm",
    text: truncateTemplateText(text, 240), // LINE limit
    actions: [normalizeLineAction(confirmAction), normalizeLineAction(cancelAction)],
  };

  return {
    type: "template",
    altText: truncateOptionalTemplateText(altText, 400) ?? truncateTemplateText(text, 400),
    template,
  };
}

/**
 * Create a button template with title, text, and action buttons
 */
export function createButtonTemplate(
  title: string | undefined,
  text: string,
  actions: Action[],
  options?: {
    thumbnailImageUrl?: string;
    imageAspectRatio?: "rectangle" | "square";
    imageSize?: "cover" | "contain";
    imageBackgroundColor?: string;
    defaultAction?: Action;
    altText?: string;
  },
): TemplateMessage {
  const normalizedTitle = title || undefined;
  const textLimit = resolveTemplateTextLimit({
    title: normalizedTitle,
    thumbnailImageUrl: options?.thumbnailImageUrl,
    textOnlyLimit: 160,
  });
  const template: ButtonsTemplate = {
    type: "buttons",
    ...(normalizedTitle ? { title: truncateTemplateText(normalizedTitle, 40) } : {}), // LINE limit
    text: truncateTemplateText(text, textLimit),
    actions: actions
      .map((action) => normalizeLineAction(action))
      .filter(hasRenderableLabel)
      .slice(0, 4), // LINE limit: max 4 actions
    thumbnailImageUrl: options?.thumbnailImageUrl,
    imageAspectRatio: options?.imageAspectRatio ?? "rectangle",
    imageSize: options?.imageSize ?? "cover",
    imageBackgroundColor: options?.imageBackgroundColor,
    defaultAction:
      options?.defaultAction === undefined ? undefined : normalizeLineAction(options.defaultAction),
  };

  return {
    type: "template",
    altText:
      truncateOptionalTemplateText(options?.altText, 400) ??
      truncateTemplateText(normalizedTitle ? `${normalizedTitle}: ${text}` : text, 400),
    template,
  };
}

/**
 * Create a carousel template with multiple columns
 */
export function createTemplateCarousel(
  columns: CarouselColumn[],
  options?: {
    imageAspectRatio?: "rectangle" | "square";
    imageSize?: "cover" | "contain";
    altText?: string;
  },
): TemplateMessage {
  const template: CarouselTemplate = {
    type: "carousel",
    columns: normalizeCarouselColumns(columns.slice(0, 10)), // LINE limit: max 10 columns
    imageAspectRatio: options?.imageAspectRatio ?? "rectangle",
    imageSize: options?.imageSize ?? "cover",
  };

  return {
    type: "template",
    altText: truncateOptionalTemplateText(options?.altText, 400) ?? "View carousel",
    template,
  };
}

/**
 * Create a carousel column for use with createTemplateCarousel
 */
export function createCarouselColumn(params: {
  title?: string;
  text: string;
  actions: Action[];
  thumbnailImageUrl?: string;
  imageBackgroundColor?: string;
  defaultAction?: Action;
}): CarouselColumn {
  const normalizedTitle = params.title || undefined;
  const thumbnailImageUrl = params.thumbnailImageUrl || undefined;
  // LINE caps a carousel column's text at 60 chars when the column carries a
  // title or thumbnail image, and 120 chars otherwise. Sending an over-length
  // text makes LINE reject the whole carousel, so mirror the conditional limit
  // the buttons template already applies above.
  const textLimit = resolveTemplateTextLimit({
    title: normalizedTitle,
    thumbnailImageUrl,
    textOnlyLimit: 120,
  });
  return {
    title: truncateOptionalTemplateText(normalizedTitle, 40),
    text: truncateTemplateText(params.text, textLimit),
    actions: params.actions.slice(0, 3).map((action) => normalizeLineAction(action)), // LINE limit: max 3 actions per column
    thumbnailImageUrl,
    imageBackgroundColor: params.imageBackgroundColor,
    defaultAction:
      params.defaultAction === undefined ? undefined : normalizeLineAction(params.defaultAction),
  };
}

/**
 * Create an image carousel template (simpler, image-focused carousel)
 */
export function createImageCarousel(
  columns: ImageCarouselColumn[],
  altText?: string,
): TemplateMessage {
  const template: ImageCarouselTemplate = {
    type: "image_carousel",
    columns: columns.slice(0, 10).map(normalizeImageCarouselColumnAction), // LINE limit: max 10 columns
  };

  return {
    type: "template",
    altText: truncateOptionalTemplateText(altText, 400) ?? "View images",
    template,
  };
}

/**
 * Create an image carousel column for use with createImageCarousel
 */
export function createImageCarouselColumn(imageUrl: string, action: Action): ImageCarouselColumn {
  return {
    imageUrl,
    action: normalizeLineAction(action, 12),
  };
}

/**
 * Create a simple yes/no confirmation dialog
 */
export function createYesNoConfirm(
  question: string,
  options?: {
    yesText?: string;
    noText?: string;
    yesData?: string;
    noData?: string;
    altText?: string;
  },
): TemplateMessage {
  const yesAction: Action = options?.yesData
    ? postbackAction(options.yesText ?? "Yes", options.yesData, options.yesText ?? "Yes")
    : messageAction(options?.yesText ?? "Yes");

  const noAction: Action = options?.noData
    ? postbackAction(options.noText ?? "No", options.noData, options.noText ?? "No")
    : messageAction(options?.noText ?? "No");

  return createConfirmTemplate(question, yesAction, noAction, options?.altText);
}

/**
 * Create a button menu with simple text buttons
 */
export function createButtonMenu(
  title: string,
  text: string,
  buttons: Array<{ label: string; text?: string }>,
  options?: {
    thumbnailImageUrl?: string;
    altText?: string;
  },
): TemplateMessage {
  const actions = buttons.slice(0, 4).map((btn) => messageAction(btn.label, btn.text));

  return createButtonTemplate(title, text, actions, {
    thumbnailImageUrl: options?.thumbnailImageUrl,
    altText: options?.altText,
  });
}

/**
 * Create a button menu with URL links
 */
export function createLinkMenu(
  title: string,
  text: string,
  links: Array<{ label: string; url: string }>,
  options?: {
    thumbnailImageUrl?: string;
    altText?: string;
  },
): TemplateMessage {
  const actions = links.slice(0, 4).map((link) => uriAction(link.label, link.url));

  return createButtonTemplate(title, text, actions, {
    thumbnailImageUrl: options?.thumbnailImageUrl,
    altText: options?.altText,
  });
}

/**
 * Create a simple product/item carousel
 */
export function createProductCarousel(
  products: Array<{
    title: string;
    description: string;
    imageUrl?: string;
    price?: string;
    actionLabel?: string;
    actionUrl?: string;
    actionData?: string;
  }>,
  altText?: string,
): TemplateMessage {
  const columns = products.slice(0, 10).map((product) => {
    const actions: Action[] = [];

    if (product.actionUrl) {
      actions.push(uriAction(product.actionLabel ?? "View", product.actionUrl));
    } else if (product.actionData) {
      actions.push(postbackAction(product.actionLabel ?? "Select", product.actionData));
    } else {
      actions.push(messageAction(product.actionLabel ?? "Select", product.title));
    }

    return createCarouselColumn({
      title: product.title,
      text: formatProductCarouselText(product.description, product.price),
      thumbnailImageUrl: product.imageUrl,
      actions,
    });
  });

  return createTemplateCarousel(columns, { altText });
}

// A template that lost every button still carries user-visible content; LINE
// defines altText as exactly that textual representation, so deliver it as a
// plain text message instead of dropping the reply.
function templateTextFallback(text: string): TextMessage | null {
  return text ? { type: "text", text } : null;
}

/**
 * Convert a TemplateMessagePayload from ReplyPayload to a LINE TemplateMessage,
 * or to its textual fallback when LINE cannot render the template at all.
 */
export function buildTemplateMessageFromPayload(
  payload: LineTemplateMessagePayload,
): TemplateMessage | TextMessage | null {
  switch (payload.type) {
    case "confirm": {
      // Confirm templates require exactly two labeled actions; a blank label
      // makes LINE reject the whole message.
      if (!payload.confirmLabel || !payload.cancelLabel) {
        return templateTextFallback(truncateTemplateText(payload.altText || payload.text, 400));
      }

      const confirmAction = payload.confirmData.startsWith("http")
        ? uriAction(payload.confirmLabel, payload.confirmData)
        : payload.confirmData.includes("=")
          ? postbackAction(payload.confirmLabel, payload.confirmData, payload.confirmLabel)
          : messageAction(payload.confirmLabel, payload.confirmData);

      const cancelAction = payload.cancelData.startsWith("http")
        ? uriAction(payload.cancelLabel, payload.cancelData)
        : payload.cancelData.includes("=")
          ? postbackAction(payload.cancelLabel, payload.cancelData, payload.cancelLabel)
          : messageAction(payload.cancelLabel, payload.cancelData);

      return createConfirmTemplate(payload.text, confirmAction, cancelAction, payload.altText);
    }

    case "buttons": {
      const actions: Action[] = payload.actions.map((action) => buildTemplatePayloadAction(action));

      const message = createButtonTemplate(payload.title, payload.text, actions, {
        thumbnailImageUrl: payload.thumbnailImageUrl,
        altText: payload.altText,
      });
      if (message.template.type === "buttons" && message.template.actions.length === 0) {
        return templateTextFallback(
          truncateTemplateText(
            payload.altText || (payload.title ? `${payload.title}: ${payload.text}` : payload.text),
            400,
          ),
        );
      }
      return message;
    }

    case "carousel": {
      const columns: CarouselColumn[] = payload.columns.slice(0, 10).map((col) => {
        const colActions: Action[] = col.actions
          .slice(0, 3)
          .map((action) => buildTemplatePayloadAction(action));

        return createCarouselColumn({
          title: col.title,
          text: col.text,
          thumbnailImageUrl: col.thumbnailImageUrl,
          actions: colActions,
        });
      });

      const message = createTemplateCarousel(columns, { altText: payload.altText });
      if (message.template.type === "carousel" && message.template.columns.length === 0) {
        return templateTextFallback(
          payload.altText
            ? truncateTemplateText(payload.altText, 400)
            : columns
                .map((col) => (col.title ? `${col.title}: ${col.text}` : col.text))
                .filter(Boolean)
                .join("\n"),
        );
      }
      return message;
    }

    default:
      return null;
  }
}

export type {
  TemplateMessage,
  ConfirmTemplate,
  ButtonsTemplate,
  CarouselTemplate,
  CarouselColumn,
  ImageCarouselTemplate,
  ImageCarouselColumn,
};
