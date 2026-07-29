import { describe, expect, it } from "vitest";
import { isChitchatSummary, normalizeActiveSummary } from "./prompt.js";

describe("isChitchatSummary", () => {
  it("rejects Chinese greetings with help offers", () => {
    expect(isChitchatSummary("您好！请问有什么可以帮助您的吗？")).toBe(true);
    expect(isChitchatSummary("你好！请问有什么可以帮助你的吗？")).toBe(true);
    expect(isChitchatSummary("您好！如果需要帮助，请随时告诉我。")).toBe(true);
  });

  it("rejects Chinese 'message cut off' boilerplate", () => {
    expect(isChitchatSummary("看起来您的消息可能没有包含具体问题或请求...")).toBe(true);
    expect(isChitchatSummary("似乎您的消息被截断了，能否提供更多详细信息？")).toBe(true);
  });

  it("rejects Chinese time/date announcements with help offers", () => {
    expect(isChitchatSummary("当前日期和时间是2026年7月29日。如果您需要任何帮助，请告诉我！")).toBe(
      true,
    );
  });

  it("rejects Chinese model metadata restatement with help offer", () => {
    expect(
      isChitchatSummary(
        "当前模型是 bigmodel/glm-4-flash-250414。如果您有任何问题或需要帮助，请告诉我！",
      ),
    ).toBe(true);
  });

  it("rejects English greetings with help offers", () => {
    expect(isChitchatSummary("Hello! How can I help you today?")).toBe(true);
    expect(isChitchatSummary("Hi there! What can I do for you?")).toBe(true);
    expect(isChitchatSummary("Hey, let me know if you need help!")).toBe(true);
  });

  it("rejects bare English greetings", () => {
    expect(isChitchatSummary("Hello!")).toBe(true);
    expect(isChitchatSummary("Hi!")).toBe(true);
  });

  it("rejects English 'message cut off' boilerplate", () => {
    expect(
      isChitchatSummary(
        "It seems like your message got cut off. Could you please provide more details?",
      ),
    ).toBe(true);
    expect(isChitchatSummary("Your message didn't come through. Can you repeat that?")).toBe(true);
  });

  it("rejects English generic help offers", () => {
    expect(isChitchatSummary("I'm here to help!")).toBe(true);
    expect(isChitchatSummary("I'm happy to help with that.")).toBe(true);
    expect(isChitchatSummary("Please let me know if you need any help.")).toBe(true);
  });

  it("accepts valid factual memory summaries", () => {
    expect(isChitchatSummary("User's favorite food is ramen; tacos also come up often.")).toBe(
      false,
    );
    expect(
      isChitchatSummary("User prefers aisle seats and extra buffer over tight connections."),
    ).toBe(false);
    expect(isChitchatSummary("User works at Acme Corp and uses Python daily.")).toBe(false);
  });

  it("accepts Chinese factual memory summaries", () => {
    expect(isChitchatSummary("用户最喜欢的食物是拉面，也经常吃塔可。")).toBe(false);
    expect(isChitchatSummary("用户偏好靠走道的座位，转机时间留宽裕。")).toBe(false);
  });
});

describe("normalizeActiveSummary", () => {
  it("returns null for chitchat input", () => {
    expect(
      normalizeActiveSummary(
        "您好！请问有什么可以帮助您的吗？如果您有任何问题或需要帮助，请随时告诉我。",
      ),
    ).toBeNull();
    expect(normalizeActiveSummary("Hello! How can I help you today?")).toBeNull();
    expect(
      normalizeActiveSummary(
        "It seems like your message got cut off. Could you please provide more details?",
      ),
    ).toBeNull();
  });

  it("returns null for NONE and empty values", () => {
    expect(normalizeActiveSummary("NONE")).toBeNull();
    expect(normalizeActiveSummary("none")).toBeNull();
    expect(normalizeActiveSummary("")).toBeNull();
    expect(normalizeActiveSummary("  ")).toBeNull();
  });

  it("returns null for timeout boilerplate", () => {
    expect(normalizeActiveSummary("the llm request timed out")).toBeNull();
    expect(normalizeActiveSummary("active-memory timeout after 30000ms")).toBeNull();
  });

  it("returns trimmed summary for valid factual recall", () => {
    expect(normalizeActiveSummary("User's favorite food is ramen")).toBe(
      "User's favorite food is ramen",
    );
    expect(normalizeActiveSummary("  User prefers aisle seats  ")).toBe("User prefers aisle seats");
  });

  it("returns null for chitchat with model metadata restatement", () => {
    expect(
      normalizeActiveSummary(
        "当前模型是 bigmodel/glm-4-flash-250414。如果您有任何问题或需要帮助，请告诉我！",
      ),
    ).toBeNull();
  });

  it("returns null for Chinese greeting variants from issue report", () => {
    expect(normalizeActiveSummary("您好！看起来您的消息可能没有包含具体问题或请求...")).toBeNull();
    expect(
      normalizeActiveSummary(
        "你好！请问有什么可以帮助你的吗？如果你有任何问题或需要帮助，请随时告诉我。",
      ),
    ).toBeNull();
  });
});
