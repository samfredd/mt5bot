import type { Context } from "grammy";

type ReplyOptions = Parameters<Context["reply"]>[1];

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatInline(value: string): string {
  const code: string[] = [];
  let text = value.replace(/`([^`\n]+)`/g, (_match, content: string) => {
    const index = code.push(`<code>${escapeHtml(content)}</code>`) - 1;
    return `\u0000CODE${index}\u0000`;
  });
  text = escapeHtml(text)
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+)__/g, "<b>$1</b>")
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?])/g, "$1<i>$2</i>");
  return text.replace(/\u0000CODE(\d+)\u0000/g, (_match, index: string) => code[Number(index)] ?? "");
}

/** Convert the restrained Markdown emitted by the assistant into Telegram-safe HTML. */
export function formatTelegramHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").trim().split("\n");
  const output: string[] = [];
  let inCode = false;
  let codeLines: string[] = [];
  let tableLines: string[] = [];

  const flushTable = () => {
    if (!tableLines.length) return;
    const rows = tableLines.filter((line) => !/^\s*\|?\s*:?-{3,}/.test(line));
    if (rows.length) output.push(`<pre>${escapeHtml(rows.join("\n"))}</pre>`);
    tableLines = [];
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flushTable();
      if (inCode) {
        output.push(`<pre>${escapeHtml(codeLines.join("\n"))}</pre>`);
        codeLines = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      tableLines.push(line.trim());
      continue;
    }
    flushTable();
    if (!line.trim()) {
      output.push("");
      continue;
    }
    const heading = line.match(/^\s*#{1,6}\s+(.+)$/);
    if (heading) {
      output.push(`<b>${formatInline(heading[1])}</b>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    if (bullet) {
      output.push(`• ${formatInline(bullet[1])}`);
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      output.push(`<blockquote>${formatInline(quote[1])}</blockquote>`);
      continue;
    }
    output.push(formatInline(line));
  }
  flushTable();
  if (inCode && codeLines.length) output.push(`<pre>${escapeHtml(codeLines.join("\n"))}</pre>`);
  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function splitTelegramMarkdown(markdown: string, maxLength = 3400): string[] {
  const text = markdown.trim();
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n{2,}/)) {
    if (paragraph.length > maxLength) {
      if (current) chunks.push(current.trim());
      current = "";
      for (let offset = 0; offset < paragraph.length; offset += maxLength) chunks.push(paragraph.slice(offset, offset + maxLength));
    } else if (!current || current.length + paragraph.length + 2 <= maxLength) {
      current += `${current ? "\n\n" : ""}${paragraph}`;
    } else {
      chunks.push(current.trim());
      current = paragraph;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
}

export async function replyTelegram(ctx: Context, markdown: string, options?: ReplyOptions): Promise<void> {
  const chunks = splitTelegramMarkdown(markdown);
  for (let index = 0; index < chunks.length; index += 1) {
    await ctx.reply(formatTelegramHtml(chunks[index]), {
      ...(index === 0 ? options : undefined),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  }
}

/** Keep Telegram's typing state alive for operations that may take longer than five seconds. */
export async function withTelegramTyping<T>(ctx: Context, operation: () => Promise<T>): Promise<T> {
  const sendTyping = () => ctx.replyWithChatAction("typing").catch(() => undefined);
  await sendTyping();
  const timer = setInterval(sendTyping, 4_000);
  try {
    return await operation();
  } finally {
    clearInterval(timer);
  }
}
