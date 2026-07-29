import { describe, expect, it } from "vitest";
import { resolveClickClackMentionFacts } from "./mention-facts.js";

describe("resolveClickClackMentionFacts", () => {
  it("direct message: canDetectMention: false, wasMentioned: false", () => {
    const result = resolveClickClackMentionFacts({
      isDirect: true,
      body: "hello",
      mentionPatterns: ["@bot"],
    });
    expect(result.canDetectMention).toBe(false);
    expect(result.wasMentioned).toBe(false);
    expect(result.hasAnyMention).toBeUndefined();
  });

  it("group message with no body: canDetectMention true, wasMentioned false", () => {
    const result = resolveClickClackMentionFacts({
      isDirect: false,
      body: "",
      mentionPatterns: [],
    });
    expect(result.canDetectMention).toBe(true);
    expect(result.wasMentioned).toBe(false);
    expect(result.hasAnyMention).toBe(false);
  });

  it("group message without patterns: wasMentioned false", () => {
    const result = resolveClickClackMentionFacts({
      isDirect: false,
      body: "hello everyone",
      mentionPatterns: [],
    });
    expect(result.canDetectMention).toBe(true);
    expect(result.wasMentioned).toBe(false);
    expect(result.hasAnyMention).toBe(false);
  });

  it("matches configured pattern", () => {
    const result = resolveClickClackMentionFacts({
      isDirect: false,
      body: "hey @bot help me",
      mentionPatterns: ["@bot"],
    });
    expect(result.wasMentioned).toBe(true);
    expect(result.hasAnyMention).toBe(true);
  });

  it("matches native ClickClack mention syntax when botUserId provided", () => {
    const result = resolveClickClackMentionFacts({
      isDirect: false,
      body: "hey <@usr_abc123> check this",
      mentionPatterns: [],
      botUserId: "usr_abc123",
    });
    expect(result.wasMentioned).toBe(true);
  });

  it("does not match other bot user id", () => {
    const result = resolveClickClackMentionFacts({
      isDirect: false,
      body: "<@usr_other> hello",
      mentionPatterns: [],
      botUserId: "usr_abc123",
    });
    expect(result.wasMentioned).toBe(false);
  });

  it("non-matching pattern returns wasMentioned false", () => {
    const result = resolveClickClackMentionFacts({
      isDirect: false,
      body: "just a message",
      mentionPatterns: ["@bot", "@assistant"],
    });
    expect(result.wasMentioned).toBe(false);
  });

  it("plain display name does not count unless configured as a pattern", () => {
    const result = resolveClickClackMentionFacts({
      isDirect: false,
      body: "Blackbird can you help?",
      mentionPatterns: ["<@usr_abc>"],
      botUserId: "usr_def",
    });
    expect(result.wasMentioned).toBe(false);
  });

  it("invalid regex pattern is ignored", () => {
    const result = resolveClickClackMentionFacts({
      isDirect: false,
      body: "hello",
      mentionPatterns: ["[invalid"],
    });
    expect(result.wasMentioned).toBe(false);
  });

  it("multiple patterns: matches one pattern", () => {
    const result = resolveClickClackMentionFacts({
      isDirect: false,
      body: "@firstbot please",
      mentionPatterns: ["@firstbot", "@secondbot"],
    });
    expect(result.wasMentioned).toBe(true);
  });
});
