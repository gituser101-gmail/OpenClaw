import { html, nothing } from "lit";
import { until } from "lit/directives/until.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import {
  openExternalUrlSafe,
  reserveExternalWindowForDeferredNavigation,
  resolveSafeExternalUrl,
} from "../../../lib/open-external-url.ts";
import { resolveAssistantAttachmentAvailability } from "./chat-message-attachments.ts";
import { openResolvedImage } from "./chat-message-image-open.ts";
import {
  buildAssistantAttachmentUrl,
  isLocalAssistantAttachmentSource,
  isLocalAttachmentPreviewAllowed,
} from "./chat-message-local-media.ts";
import {
  cacheManagedImageBlobUrl,
  cacheManagedImageBlobUrlMiss,
  hasRecentManagedImageBlobUrlMiss,
  readManagedImageBlobUrl,
  retainManagedImageBlobUrl,
  type ImageBlock,
  type ImageRenderOptions,
  type RenderableImageBlock,
} from "./chat-message-media.ts";

const MANAGED_OUTGOING_IMAGE_FETCH_TIMEOUT_MS = 30_000;
const managedImageBlobUrlCache = new Map<string, Promise<string | null>>();
type ManagedImageVariant = "full" | "thumbnail";

export function resolveRenderableMessageImages(
  images: ImageBlock[],
  opts?: ImageRenderOptions,
): RenderableImageBlock[] {
  return images.flatMap((img) => {
    const isLocalImage = isLocalAssistantAttachmentSource(img.url);
    const canProxyLocalImage =
      isLocalImage && isLocalAttachmentPreviewAllowed(img.url, opts?.localMediaPreviewRoots ?? []);
    if (isLocalImage && !canProxyLocalImage) {
      return [];
    }
    const availability = canProxyLocalImage
      ? resolveAssistantAttachmentAvailability(
          img.url,
          opts?.localMediaPreviewRoots ?? [],
          opts?.basePath,
          opts?.authToken,
          opts?.onRequestUpdate,
        )
      : { status: "available" as const };
    if (availability.status !== "available") {
      return [];
    }
    const displayUrl = canProxyLocalImage
      ? buildAssistantAttachmentUrl(img.url, opts?.basePath, availability.mediaTicket)
      : img.url;
    return [{ ...img, displayUrl }];
  });
}

export function renderMessageImages(images: RenderableImageBlock[], opts?: ImageRenderOptions) {
  if (images.length === 0) {
    return nothing;
  }

  const openImage = (img: RenderableImageBlock, previewUrl: string) => {
    const title = img.alt?.trim() || t("chat.imageLightbox.untitled");
    const requestVersion = opts?.onRequestOpenImage?.();
    if (!isManagedOutgoingImageSource(img.displayUrl)) {
      openResolvedImage(opts?.onOpenImage, previewUrl, title, undefined, requestVersion);
      return;
    }

    const cacheKey = resolveManagedOutgoingImageBlobUrlCacheKey(
      img.displayUrl,
      opts,
      img.artifactId,
      "full",
    );
    if (!opts?.onOpenImage) {
      const pendingWindow = reserveExternalWindowForDeferredNavigation();
      void resolveManagedOutgoingImageBlobUrl(img.displayUrl, opts, img.artifactId, "full")
        .then((freshUrl) => {
          const release = freshUrl ? retainManagedImageBlobUrl(cacheKey) : undefined;
          const safeUrl = freshUrl
            ? resolveSafeExternalUrl(freshUrl, window.location.href, { allowDataImage: true })
            : null;
          if (!safeUrl) {
            release?.();
            pendingWindow?.close();
          } else if (pendingWindow) {
            pendingWindow.location.replace(safeUrl);
            window.setTimeout(() => release?.(), 30_000);
          } else {
            openExternalUrlSafe(safeUrl, { allowDataImage: true });
            window.setTimeout(() => release?.(), 30_000);
          }
        })
        .catch(() => pendingWindow?.close());
      return;
    }
    void resolveManagedOutgoingImageBlobUrl(img.displayUrl, opts, img.artifactId, "full")
      .then((freshUrl) => {
        if (!freshUrl) {
          return;
        }
        const release = retainManagedImageBlobUrl(cacheKey);
        openResolvedImage(opts.onOpenImage, freshUrl, title, release, requestVersion);
      })
      .catch(() => {});
  };

  const renderImageElement = (img: RenderableImageBlock, previewUrl: string) => {
    const title = img.alt?.trim() || t("chat.imageLightbox.untitled");
    const isManaged = isManagedOutgoingImageSource(img.displayUrl);
    return html`
      <span class="chat-image-frame">
        <button
          type="button"
          class="chat-message-image-button"
          aria-label=${t("chat.imageLightbox.open", { title })}
          @click=${() => openImage(img, previewUrl)}
        >
          <img
            src=${previewUrl}
            alt=${title}
            class="chat-message-image"
            width=${img.width ?? nothing}
            height=${img.height ?? nothing}
          />
        </button>
        ${isManaged
          ? renderManagedImageActions(img, opts, () => openImage(img, previewUrl))
          : nothing}
      </span>
    `;
  };

  const renderImage = (img: RenderableImageBlock) => {
    if (!isManagedOutgoingImageSource(img.displayUrl)) {
      return renderImageElement(img, img.displayUrl);
    }
    const preview = resolveManagedOutgoingImageBlobUrl(
      img.displayUrl,
      opts,
      img.artifactId,
      "thumbnail",
    ).then((previewUrl) => {
      if (!previewUrl) {
        return nothing;
      }
      return renderImageElement(img, previewUrl);
    });
    return until(preview, nothing);
  };

  return html` <div class="chat-message-images">${images.map((img) => renderImage(img))}</div> `;
}

function isManagedOutgoingImageSource(source: string): boolean {
  const trimmed = source.trim();
  if (trimmed.startsWith("/api/chat/media/outgoing/")) {
    return true;
  }
  try {
    const parsed = new URL(trimmed, window.location.origin);
    return (
      parsed.origin === window.location.origin &&
      parsed.pathname.startsWith("/api/chat/media/outgoing/")
    );
  } catch {
    return false;
  }
}

function resolveManagedOutgoingImageRequesterSessionKey(source: string): string | null {
  try {
    const parsed = new URL(source, window.location.origin);
    const parts = parsed.pathname.split("/");
    const encodedSessionKey = parts[5];
    return encodedSessionKey ? decodeURIComponent(encodedSessionKey) : null;
  } catch {
    return null;
  }
}

function resolveManagedOutgoingImageBlobUrlCacheKey(
  source: string,
  opts?: ImageRenderOptions,
  artifactId?: string,
  variant: ManagedImageVariant = "thumbnail",
): string {
  const authToken = opts?.authToken?.trim() ?? "";
  return `${buildManagedOutgoingImageVariantUrl(source, variant)}::${authToken}::${artifactId?.trim() ?? ""}`;
}

async function resolveManagedOutgoingImageBlobUrl(
  source: string,
  opts?: ImageRenderOptions,
  artifactId?: string,
  variant: ManagedImageVariant = "thumbnail",
): Promise<string | null> {
  const cacheKey = resolveManagedOutgoingImageBlobUrlCacheKey(source, opts, artifactId, variant);
  const cached = readManagedImageBlobUrl(cacheKey);
  if (cached) {
    return cached;
  }
  if (hasRecentManagedImageBlobUrlMiss(cacheKey)) {
    return null;
  }
  let pending = managedImageBlobUrlCache.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const blob = await fetchManagedOutgoingImageBlob(source, opts, artifactId, variant);
      if (blob) {
        const blobUrl = URL.createObjectURL(blob);
        cacheManagedImageBlobUrl(cacheKey, blobUrl);
        return blobUrl;
      }
      cacheManagedImageBlobUrlMiss(cacheKey);
      return null;
    })().finally(() => {
      managedImageBlobUrlCache.delete(cacheKey);
    });
    managedImageBlobUrlCache.set(cacheKey, pending);
  }
  return pending;
}

function buildManagedOutgoingImageVariantUrl(source: string, variant: ManagedImageVariant): string {
  try {
    const parsed = new URL(source, window.location.origin);
    parsed.pathname = parsed.pathname.replace(/\/(?:full|thumbnail)$/u, `/${variant}`);
    return source.startsWith("http") ? parsed.toString() : `${parsed.pathname}${parsed.search}`;
  } catch {
    return source.replace(/\/(?:full|thumbnail)(?=$|\?)/u, `/${variant}`);
  }
}

async function fetchManagedOutgoingImageBlob(
  source: string,
  opts: ImageRenderOptions | undefined,
  artifactId: string | undefined,
  variant: ManagedImageVariant,
): Promise<Blob | null> {
  const requesterSessionKey = resolveManagedOutgoingImageRequesterSessionKey(source);
  const artifactDownload =
    requesterSessionKey && artifactId && opts?.resolveArtifactDownload
      ? await opts
          .resolveArtifactDownload({ sessionKey: requesterSessionKey, artifactId })
          .catch(() => null)
      : null;
  const requestUrl = buildManagedOutgoingImageVariantUrl(artifactDownload?.url ?? source, variant);
  const headers = new Headers({ Accept: "image/*" });
  const authToken = opts?.authToken?.trim();
  if (!artifactDownload && authToken) {
    headers.set("Authorization", `Bearer ${authToken}`);
  }
  if (!artifactDownload && requesterSessionKey) {
    headers.set("x-openclaw-requester-session-key", requesterSessionKey);
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => {
    controller.abort(new DOMException("managed outgoing image fetch timed out", "TimeoutError"));
  }, MANAGED_OUTGOING_IMAGE_FETCH_TIMEOUT_MS);
  try {
    // Managed media is a Gateway API at the origin root. Rebasing it under
    // the Control UI mount path serves the HTML shell instead of image bytes.
    const res = await fetch(requestUrl, {
      method: "GET",
      headers,
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (!res.ok) {
      return null;
    }
    const blob = await res.blob();
    return blob.type.startsWith("image/") ? blob : null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

function imageExtensionForMimeType(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/avif":
      return "avif";
    default:
      return "png";
  }
}

function sanitizeImageFileName(value: string): string {
  const invalidCharacters = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"]);
  let sanitized = "";
  for (const character of value) {
    sanitized += character.charCodeAt(0) < 32 || invalidCharacters.has(character) ? "_" : character;
  }
  return sanitized;
}

function imageDownloadFileName(img: RenderableImageBlock, blob: Blob): string {
  const rawName = sanitizeImageFileName(img.alt?.trim() || "generated-image");
  const stem = rawName.replace(/\.[a-z0-9]{2,5}$/iu, "") || "generated-image";
  return `${stem}.${imageExtensionForMimeType(blob.type || "image/png")}`;
}

function downloadBlob(blob: Blob, fileName: string) {
  const blobUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = fileName;
  anchor.rel = "noreferrer";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
}

async function convertImageBlobToPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png" || typeof createImageBitmap !== "function") {
    return blob;
  }
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return blob;
    }
    ctx.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((pngBlob) => {
        if (pngBlob) {
          resolve(pngBlob);
        } else {
          reject(new Error("Could not convert image for clipboard"));
        }
      }, "image/png");
    });
  } finally {
    bitmap.close();
  }
}

function renderManagedImageActions(
  img: RenderableImageBlock,
  opts: ImageRenderOptions | undefined,
  onOpen: () => void,
) {
  const title = img.alt?.trim() || t("chat.imageLightbox.untitled");
  const download = async () => {
    try {
      const blob = await fetchManagedOutgoingImageBlob(
        img.displayUrl,
        opts,
        img.artifactId,
        "full",
      );
      if (blob) {
        downloadBlob(blob, imageDownloadFileName(img, blob));
      }
    } catch {
      // Image actions are optional UI affordances; keep the message usable.
    }
  };
  const copy = async () => {
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
        return;
      }
      const fetched = await fetchManagedOutgoingImageBlob(
        img.displayUrl,
        opts,
        img.artifactId,
        "full",
      );
      if (!fetched) {
        return;
      }
      const blob = await convertImageBlobToPng(fetched);
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
    } catch {
      // Clipboard support varies by browser and secure-context policy.
    }
  };
  return html`
    <span class="chat-image-actions">
      <button
        type="button"
        class="chat-image-action"
        title=${t("chat.imageLightbox.openOriginal")}
        aria-label=${t("chat.imageLightbox.open", { title })}
        @click=${onOpen}
      >
        ${icons.externalLink}
      </button>
      <button
        type="button"
        class="chat-image-action"
        title=${t("chat.toolCards.downloadFile")}
        aria-label=${t("chat.toolCards.downloadFile")}
        @click=${() => void download()}
      >
        ${icons.download}
      </button>
      <button
        type="button"
        class="chat-image-action"
        title=${t("common.copy")}
        aria-label=${t("common.copy")}
        @click=${() => void copy()}
      >
        ${icons.copy}
      </button>
    </span>
  `;
}
