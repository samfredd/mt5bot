import { Fragment, type ReactNode } from "react";

function inlineContent(text: string, keyPrefix: string): ReactNode[] {
  const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|\*[^*\n]+\*)/g;
  const parts: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;
    if (token.startsWith("**")) parts.push(<strong key={key} className="font-semibold text-ink">{token.slice(2, -2)}</strong>);
    else if (token.startsWith("`")) parts.push(<code key={key} className="rounded bg-bg px-1.5 py-0.5 font-mono text-[0.9em] text-accent">{token.slice(1, -1)}</code>);
    else if (token.startsWith("[")) {
      const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
      parts.push(link ? <a key={key} href={link[2]} target="_blank" rel="noreferrer" className="text-accent underline decoration-accent/40 underline-offset-2">{link[1]}</a> : token);
    } else parts.push(<em key={key}>{token.slice(1, -1)}</em>);
    cursor = pattern.lastIndex;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function tableCells(line: string) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

/** Small, dependency-free Markdown renderer for trusted assistant text. React escapes all raw content. */
export function FormattedAssistantMessage({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      blocks.push(<pre key={`code-${index}`} className="my-3 overflow-x-auto rounded-xl border border-line bg-bg p-3 font-mono text-xs leading-relaxed text-ink-dim"><code>{code.join("\n")}</code></pre>);
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line) && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1])) {
      const headers = tableCells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) rows.push(tableCells(lines[index++]));
      blocks.push(<div key={`table-${index}`} className="my-3 overflow-x-auto rounded-xl border border-line"><table className="min-w-full text-left text-xs"><thead className="bg-bg text-ink"><tr>{headers.map((cell, cellIndex) => <th key={cellIndex} className="border-b border-line px-3 py-2 font-semibold">{inlineContent(cell, `th-${index}-${cellIndex}`)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex} className="border-b border-line/60 last:border-0">{row.map((cell, cellIndex) => <td key={cellIndex} className="px-3 py-2 align-top text-ink-dim">{inlineContent(cell, `td-${index}-${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) {
      const size = heading[1].length <= 2 ? "text-base" : "text-sm";
      blocks.push(<h3 key={`heading-${index}`} className={`mb-1 mt-3 font-semibold text-ink first:mt-0 ${size}`}>{inlineContent(heading[2], `heading-${index}`)}</h3>);
      index += 1;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) items.push(lines[index++].replace(/^\s*[-*+]\s+/, ""));
      blocks.push(<ul key={`ul-${index}`} className="my-2 space-y-1.5 pl-5 text-ink-dim">{items.map((item, itemIndex) => <li key={itemIndex} className="list-disc pl-1 marker:text-primary">{inlineContent(item, `ul-${index}-${itemIndex}`)}</li>)}</ul>);
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) items.push(lines[index++].replace(/^\s*\d+[.)]\s+/, ""));
      blocks.push(<ol key={`ol-${index}`} className="my-2 space-y-1.5 pl-5 text-ink-dim">{items.map((item, itemIndex) => <li key={itemIndex} className="list-decimal pl-1 marker:font-semibold marker:text-primary">{inlineContent(item, `ol-${index}-${itemIndex}`)}</li>)}</ol>);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^\s*>\s?/, ""));
      blocks.push(<blockquote key={`quote-${index}`} className="my-2 border-l-2 border-primary pl-3 text-ink-dim">{inlineContent(quote.join(" "), `quote-${index}`)}</blockquote>);
      continue;
    }

    const paragraph: string[] = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|```|>\s?|\|.*\|\s*$)/.test(lines[index])) paragraph.push(lines[index++].trim());
    blocks.push(<p key={`paragraph-${index}`} className="my-2 leading-relaxed text-ink-dim first:mt-0 last:mb-0">{inlineContent(paragraph.join(" "), `paragraph-${index}`)}</p>);
  }

  return <Fragment>{blocks}</Fragment>;
}
