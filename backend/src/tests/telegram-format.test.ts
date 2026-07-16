import { describe, expect, it } from "vitest";
import { formatTelegramHtml, splitTelegramMarkdown } from "../modules/telegram/format.js";

describe("Telegram message formatting", () => {
  it("converts headings, emphasis, code and lists to safe Telegram HTML", () => {
    const formatted = formatTelegramHtml("# Status\n\n- **Bot:** running\n- Command: `/status`\n\n<script>alert(1)</script>");

    expect(formatted).toContain("<b>Status</b>");
    expect(formatted).toContain("• <b>Bot:</b> running");
    expect(formatted).toContain("<code>/status</code>");
    expect(formatted).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(formatted).not.toContain("<script>");
  });

  it("renders legacy markdown tables as readable preformatted blocks", () => {
    const formatted = formatTelegramHtml("| Pair | P/L |\n| --- | ---: |\n| EURUSD | 12.30 |");

    expect(formatted).toContain("<pre>");
    expect(formatted).toContain("EURUSD");
    expect(formatted).not.toContain("---");
  });

  it("splits long responses before Telegram's message limit", () => {
    const chunks = splitTelegramMarkdown(`${"a".repeat(2000)}\n\n${"b".repeat(2000)}`, 2500);

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.length <= 2500)).toBe(true);
  });
});
