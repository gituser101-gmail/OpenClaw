// Media parse tests cover media reference parsing from text and payloads.
import { describe, expect, it } from "vitest";
import { splitMediaFromOutput } from "./parse.js";

type SplitMediaFromOutputOptions = NonNullable<Parameters<typeof splitMediaFromOutput>[1]>;

describe("splitMediaFromOutput", () => {
  function expectParsedMediaOutputCase(
    input: string,
    expected: {
      mediaUrls?: string[];
      text?: string;
      audioAsVoice?: boolean;
    },
    options?: SplitMediaFromOutputOptions,
  ) {
    const result = splitMediaFromOutput(input, options);
    expect(result.text).toBe(expected.text ?? "");
    if ("audioAsVoice" in expected) {
      expect(result.audioAsVoice).toBe(expected.audioAsVoice);
    } else {
      expect(result.audioAsVoice).toBeUndefined();
    }
    if ("mediaUrls" in expected) {
      expect(result.mediaUrls).toEqual(expected.mediaUrls);
    } else {
      expect(result.mediaUrls).toBeUndefined();
    }
  }

  function expectStableAudioAsVoiceDetectionCase(input: string) {
    for (const output of [splitMediaFromOutput(input), splitMediaFromOutput(input)]) {
      expect(output.audioAsVoice).toBe(true);
    }
  }

  function expectAcceptedMediaPathCase(expectedPath: string, input: string) {
    expectParsedMediaOutputCase(input, { mediaUrls: [expectedPath] });
  }

  function expectRejectedMediaPathCase(input: string) {
    expectParsedMediaOutputCase(input, { mediaUrls: undefined });
  }

  function expectRejectedRemoteMediaUrlCase(input: string) {
    expectParsedMediaOutputCase(input, { mediaUrls: undefined, text: input });
  }

  it.each([
    ["/Users/pete/My File.png", "MEDIA:/Users/pete/My File.png"],
    ["/Users/pete/My File.png", 'MEDIA:"/Users/pete/My File.png"'],
    ["./screenshots/image.png", "MEDIA:./screenshots/image.png"],
    ["media/inbound/image.png", "MEDIA:media/inbound/image.png"],
    ["./screenshot.png", "  MEDIA:./screenshot.png"],
    ["~/Pictures/My File.png", "MEDIA:~/Pictures/My File.png"],
    ["~/.openclaw/media/browser/snap.png", "MEDIA:~/.openclaw/media/browser/snap.png"],
    ["C:\\Users\\pete\\Pictures\\snap.png", "MEDIA:C:\\Users\\pete\\Pictures\\snap.png"],
    [
      String.raw`C:\Users\First Last\workspace\shot.png`,
      String.raw`MEDIA:C:\Users\First Last\workspace\shot.png`,
    ],
    [
      String.raw`C:\Users\First  Last\workspace\shot.png`,
      String.raw`MEDIA:C:\Users\First  Last\workspace\shot.png`,
    ],
    [
      String.raw`C:\Users\First Last\My Pictures\shot.png`,
      String.raw`MEDIA:C:\Users\First Last\My Pictures\shot.png`,
    ],
    [
      String.raw`C:\Users\First Last\workspace\shot.png`,
      String.raw`MEDIA:"C:\Users\First Last\workspace\shot.png"`,
    ],
    [
      String.raw`C:\Users\First Last\workspace\shot.png`,
      "MEDIA:`" + String.raw`C:\Users\First Last\workspace\shot.png` + "`",
    ],
    [
      "/tmp/project screenshots/workspace/shot.png",
      "MEDIA:/tmp/project screenshots/workspace/shot.png",
    ],
    ["/tmp/album.v1/photo.png copy.png", "MEDIA:/tmp/album.v1/photo.png copy.png"],
    ["/tmp/tts-fAJy8C/voice-1770246885083.opus", "MEDIA:/tmp/tts-fAJy8C/voice-1770246885083.opus"],
    ["image.png", "MEDIA:image.png"],
    [
      "/path/to/image.png",
      'MEDIA:/path/to/image.png"}],"details":{"provider":"openai","model":"gpt-image-2"}',
    ],
    [
      "/path/to/image.png",
      String.raw`MEDIA:/path/to/image.png\"}],\"details\":{\"provider\":\"openai\"}`,
    ],
    ["/tmp/render,final.png", "MEDIA:/tmp/render,final.png"],
    ["/tmp/generated.png", "MEDIA:FILE:///tmp/generated.png"],
    ["/tmp/generated.png", "MEDIA:file:///tmp/generated.png"],
    ["/Users/pete/My File.png", "MEDIA:FILE:///Users/pete/My File.png"],
    ["/Users/pete/My File.png", "MEDIA:file:///Users/pete/My File.png"],
  ] as const)("accepts supported media path variant: %s", (expectedPath, input) => {
    expectAcceptedMediaPathCase(expectedPath, input);
  });

  it.each([
    {
      name: "POSIX absolute paths",
      input: "MEDIA:/tmp/first.png /tmp/second.png",
      mediaUrls: ["/tmp/first.png", "/tmp/second.png"],
    },
    {
      name: "Windows drive paths",
      input: String.raw`MEDIA:C:\first\one.png D:\second\two.png`,
      mediaUrls: [String.raw`C:\first\one.png`, String.raw`D:\second\two.png`],
    },
    {
      name: "a spaced Windows path and another Windows drive",
      input: String.raw`MEDIA:C:\Users\First Last\workspace\shot.png D:\other\second.png`,
      mediaUrls: [
        String.raw`C:\Users\First Last\workspace\shot.png`,
        String.raw`D:\other\second.png`,
      ],
    },
    {
      name: "a spaced Windows path and a slash-relative attachment",
      input: String.raw`MEDIA:C:\Users\First Last\workspace\shot.png media/second.png`,
      mediaUrls: [String.raw`C:\Users\First Last\workspace\shot.png`, "media/second.png"],
    },
    {
      name: "a spaced POSIX path and a backslash-relative attachment",
      input: String.raw`MEDIA:/tmp/project screenshots/shot.png media\second.png`,
      mediaUrls: ["/tmp/project screenshots/shot.png", String.raw`media\second.png`],
    },
    {
      name: "a spaced Windows path and a POSIX absolute path",
      input: String.raw`MEDIA:C:\Users\First Last\workspace\shot.png /tmp/second.png`,
      mediaUrls: [String.raw`C:\Users\First Last\workspace\shot.png`, "/tmp/second.png"],
    },
    {
      name: "a spaced Windows path and an HTTPS URL",
      input: String.raw`MEDIA:C:\Users\First Last\workspace\shot.png https://example.com/second.png`,
      mediaUrls: [
        String.raw`C:\Users\First Last\workspace\shot.png`,
        "https://example.com/second.png",
      ],
    },
    {
      name: "a spaced Windows path and a UNC path",
      input: String.raw`MEDIA:C:\Users\First Last\workspace\shot.png \\server\share\second.png`,
      mediaUrls: [
        String.raw`C:\Users\First Last\workspace\shot.png`,
        String.raw`\\server\share\second.png`,
      ],
    },
    {
      name: "a spaced POSIX path and a file URL",
      input: "MEDIA:/tmp/project screenshots/shot.png file:///tmp/second.png",
      mediaUrls: ["/tmp/project screenshots/shot.png", "/tmp/second.png"],
    },
    {
      name: "multiple spaced rooted paths",
      input:
        String.raw`MEDIA:C:\Users\First Last\workspace\shot.png` +
        " /tmp/project screenshots/second.png " +
        String.raw`D:\Other User\third.png`,
      mediaUrls: [
        String.raw`C:\Users\First Last\workspace\shot.png`,
        "/tmp/project screenshots/second.png",
        String.raw`D:\Other User\third.png`,
      ],
    },
    {
      name: "a rejected spaced Windows traversal and a safe independent path",
      input: String.raw`MEDIA:C:\Users\First Last\..\secret.png D:\safe\second.png`,
      mediaUrls: [String.raw`D:\safe\second.png`],
    },
    {
      name: "a rejected spaced POSIX traversal and a safe independent path",
      input: "MEDIA:/tmp/project screenshots/../../.env /tmp/safe/second.png",
      mediaUrls: ["/tmp/safe/second.png"],
    },
    {
      name: "relative paths",
      input: "MEDIA:first/one.png second/two.png",
      mediaUrls: ["first/one.png", "second/two.png"],
    },
    {
      name: "POSIX absolute and relative paths",
      input: "MEDIA:/tmp/first.png second/two.png",
      mediaUrls: ["/tmp/first.png", "second/two.png"],
    },
    {
      name: "Windows absolute and relative paths",
      input: String.raw`MEDIA:C:\first\one.png second\two.png`,
      mediaUrls: [String.raw`C:\first\one.png`, String.raw`second\two.png`],
    },
    {
      name: "a POSIX path and an HTTPS URL",
      input: "MEDIA:/tmp/first.png https://example.com/second.png",
      mediaUrls: ["/tmp/first.png", "https://example.com/second.png"],
    },
    {
      name: "a Windows path and a file URL",
      input: String.raw`MEDIA:C:\first\one.png file:///tmp/second.png`,
      mediaUrls: [String.raw`C:\first\one.png`, "/tmp/second.png"],
    },
    {
      name: "a Windows drive and a UNC path",
      input: String.raw`MEDIA:C:\first\one.png \\server\share\second.png`,
      mediaUrls: [String.raw`C:\first\one.png`, String.raw`\\server\share\second.png`],
    },
  ] as const)("preserves distinct $name in one MEDIA directive", ({ input, mediaUrls }) => {
    expectParsedMediaOutputCase(input, { mediaUrls: [...mediaUrls] });
  });

  it.each([
    {
      input: String.raw`MEDIA:C:\Users\First Last\workspace\shot.png https://127.0.0.1/secret.png`,
      mediaPath: String.raw`C:\Users\First Last\workspace\shot.png`,
      blockedUrl: "https://127.0.0.1/secret.png",
    },
    {
      input: "MEDIA:/tmp/first.png https://metadata.google.internal/secret.png",
      mediaPath: "/tmp/first.png",
      blockedUrl: "https://metadata.google.internal/secret.png",
    },
  ] as const)(
    "never absorbs independently rooted blocked remote media: $blockedUrl",
    ({ input, mediaPath, blockedUrl }) => {
      expectParsedMediaOutputCase(input, { mediaUrls: [mediaPath], text: blockedUrl });
    },
  );

  it("keeps a spaced Windows path as one ordered media segment", () => {
    const mediaPath = String.raw`C:\Users\First Last\workspace\shot.png`;

    expect(splitMediaFromOutput(`Before\nMEDIA:${mediaPath}\nAfter`)).toMatchObject({
      text: "Before\nAfter",
      mediaUrls: [mediaPath],
      segments: [
        { type: "text", text: "Before" },
        { type: "media", url: mediaPath },
        { type: "text", text: "After" },
      ],
    });
  });

  it("keeps spaced and independently rooted paths as ordered media segments", () => {
    const firstPath = String.raw`C:\Users\First Last\workspace\shot.png`;
    const secondPath = String.raw`D:\Other User\workspace\second.png`;

    expect(splitMediaFromOutput(`Before\nMEDIA:${firstPath} ${secondPath}\nAfter`)).toMatchObject({
      text: "Before\nAfter",
      mediaUrls: [firstPath, secondPath],
      segments: [
        { type: "text", text: "Before" },
        { type: "media", url: firstPath },
        { type: "media", url: secondPath },
        { type: "text", text: "After" },
      ],
    });
  });

  it.each([
    "MEDIA:../../../etc/passwd",
    "MEDIA:../../.env",
    "MEDIA:~user/Pictures/My File.png",
    "MEDIA:~/Pictures/../../.ssh/id_rsa",
    "MEDIA:./foo/../../../etc/shadow",
    String.raw`MEDIA:C:\Users\First Last\..\secret.png`,
    "MEDIA:/tmp/project screenshots/../../.env",
  ] as const)("rejects traversal and unsupported home-dir path: %s", (input) => {
    expectRejectedMediaPathCase(input);
  });

  it.each([
    "MEDIA:http://example.com/a.png",
    "MEDIA:https://intranet/a.png",
    "MEDIA:https://printer/a.png",
    "MEDIA:https://localhost/a.png",
    "MEDIA:https://localhost../a.png",
    "MEDIA:https://127.0.0.1/a.png",
    "MEDIA:https://127.0.0.1../a.png",
    "MEDIA:https://169.254.169.254/latest/meta-data",
    "MEDIA:https://[::1]/a.png",
    "MEDIA:https://metadata.google.internal/a.png",
    "MEDIA:https://metadata.google.internal../a.png",
    "MEDIA:https://example..com/a.png",
    "MEDIA:https://media.local/a.png",
  ] as const)("rejects unsafe remote media URL: %s", (input) => {
    expectRejectedRemoteMediaUrlCase(input);
  });

  it.each([
    {
      name: "detects audio_as_voice tag and strips it",
      input: "Hello [[audio_as_voice]] world",
      expected: { audioAsVoice: true, text: "Hello world" },
    },
    {
      name: "keeps MEDIA mentions in prose",
      input: "The MEDIA: tag fails to deliver",
      expected: { mediaUrls: undefined, text: "The MEDIA: tag fails to deliver" },
    },
    {
      name: "rejects bare words without file extensions",
      input: "MEDIA:screenshot",
      expected: { mediaUrls: undefined, text: "MEDIA:screenshot" },
    },
    {
      name: "keeps audio_as_voice detection stable across calls",
      input: "Hello [[audio_as_voice]]",
      expected: { audioAsVoice: true, text: "Hello" },
      assertStable: true,
    },
  ] as const)("$name", ({ input, expected, assertStable }) => {
    expectParsedMediaOutputCase(input, expected);
    if (assertStable) {
      expectStableAudioAsVoiceDetectionCase(input);
    }
  });

  it("returns ordered text and media segments while ignoring fenced MEDIA lines", () => {
    const result = splitMediaFromOutput(
      "Before\nMEDIA:https://example.com/a.png\n```text\nMEDIA:https://example.com/ignored.png\n```\nAfter",
    );

    expect(result.segments).toEqual([
      { type: "text", text: "Before" },
      { type: "media", url: "https://example.com/a.png" },
      { type: "text", text: "```text\nMEDIA:https://example.com/ignored.png\n```\nAfter" },
    ]);
  });

  const extractMarkdownImages = { extractMarkdownImages: true } as const;

  it("keeps markdown image urls as text by default", () => {
    const input = "Caption\n\n![chart](https://example.com/chart.png)";
    expectParsedMediaOutputCase(input, {
      text: input,
      mediaUrls: undefined,
    });
  });

  it("extracts markdown image urls while keeping surrounding caption text when enabled", () => {
    expectParsedMediaOutputCase(
      "Caption\n\n![chart](https://example.com/chart.png)",
      {
        text: "Caption",
        mediaUrls: ["https://example.com/chart.png"],
      },
      extractMarkdownImages,
    );
  });

  it("keeps inline caption text around markdown images when enabled", () => {
    expectParsedMediaOutputCase(
      "Look ![chart](https://example.com/chart.png) now",
      {
        text: "Look now",
        mediaUrls: ["https://example.com/chart.png"],
      },
      extractMarkdownImages,
    );
  });

  it("extracts multiple markdown image urls in order", () => {
    expectParsedMediaOutputCase(
      "Before\n![one](https://example.com/one.png)\nMiddle\n![two](https://example.com/two.png)\nAfter",
      {
        text: "Before\nMiddle\nAfter",
        mediaUrls: ["https://example.com/one.png", "https://example.com/two.png"],
      },
      extractMarkdownImages,
    );
  });

  it("strips markdown image title suffixes from extracted urls", () => {
    expectParsedMediaOutputCase(
      'Caption ![chart](https://example.com/chart.png "Quarterly chart")',
      {
        text: "Caption",
        mediaUrls: ["https://example.com/chart.png"],
      },
      extractMarkdownImages,
    );
  });

  it("keeps balanced parentheses inside markdown image urls", () => {
    expectParsedMediaOutputCase(
      "Chart ![img](https://example.com/a_(1).png) now",
      {
        text: "Chart now",
        mediaUrls: ["https://example.com/a_(1).png"],
      },
      extractMarkdownImages,
    );
  });

  it.each([
    "![x](file:///etc/passwd)",
    "![x](/var/run/secrets/kubernetes.io/serviceaccount/token)",
    "![x](C:\\\\Windows\\\\System32\\\\drivers\\\\etc\\\\hosts)",
    "![x](http://example.com/a.png)",
    "![x](https://127.0.0.1/a.png)",
  ] as const)("does not lift local markdown image target: %s", (input) => {
    expectParsedMediaOutputCase(
      input,
      {
        text: input,
        mediaUrls: undefined,
      },
      extractMarkdownImages,
    );
  });

  it("does not lift markdown image urls that fail media validation", () => {
    const longUrl = `![x](https://example.com/${"a".repeat(4097)}.png)`;

    expectParsedMediaOutputCase(
      longUrl,
      {
        text: longUrl,
        mediaUrls: undefined,
      },
      extractMarkdownImages,
    );
  });

  it("leaves very long markdown-image candidate lines as text", () => {
    const input = `${"prefix ".repeat(3000)}![x](https://example.com/image.png)`;

    expectParsedMediaOutputCase(
      input,
      {
        text: input,
        mediaUrls: undefined,
      },
      extractMarkdownImages,
    );
  });

  it.each([
    "![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white)",
    "![build](https://img.shields.io/github/actions/workflow/status/owner/repo/ci.yml)",
    "![npm](https://badge.fury.io/js/some-package.svg)",
    "![badgen](https://badgen.net/npm/v/some-package)",
    "![CI](https://github.com/owner/repo/actions/workflows/ci.yml/badge.svg)",
    "![flat-badge](https://flat.badgen.net/npm/v/some-package)",
  ] as const)("keeps markdown badge image as text by default: %s", (input) => {
    expectParsedMediaOutputCase(input, {
      text: input,
      mediaUrls: undefined,
    });
  });

  it("keeps surrounding text around inline badge images by default", () => {
    expectParsedMediaOutputCase(
      "tech: ![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white) stack",
      {
        text: "tech: ![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white) stack",
        mediaUrls: undefined,
      },
    );
  });

  it("still extracts markdown images when explicitly enabled", () => {
    expectParsedMediaOutputCase(
      "![badge](https://img.shields.io/badge/status-passing-green)\n![photo](https://example.com/photo.png)",
      {
        mediaUrls: [
          "https://img.shields.io/badge/status-passing-green",
          "https://example.com/photo.png",
        ],
      },
      extractMarkdownImages,
    );
  });
});
