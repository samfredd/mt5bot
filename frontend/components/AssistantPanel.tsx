"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import { IconMessageCircle, IconShield, IconX } from "@/components/icons";
import { SCALPING_NAV_ID, type NavId } from "@/components/Sidebar";
import { FormattedAssistantMessage } from "@/components/FormattedAssistantMessage";

interface Reply {
  message: string;
  provider?: string;
  confirmation?: { token: string; summary: string; expiresAt: string };
  navigation?: string;
}
interface Message { id: string; role: "user" | "assistant"; text: string; confirmation?: Reply["confirmation"]; }

export type AssistantContextPage = NavId | typeof SCALPING_NAV_ID;

const PAGE_SUGGESTIONS: Partial<Record<AssistantContextPage, string[]>> = {
  Overview: ["Explain what needs attention on this page", "Summarize today's trading", "Why has the bot not taken a trade?"],
  Trades: ["Explain my open positions", "Which recent trades were blocked and why?", "Summarize today's closed and floating P/L"],
  Strategies: ["Explain the enabled strategies", "Which strategy needs attention?", "How do these strategies affect new trades?"],
  Performance: ["Explain the performance figures", "What is driving the current P/L?", "Highlight risk or drawdown concerns"],
  Activity: ["Explain the latest activity", "Why were recent trades blocked?", "Summarize system errors and warnings"],
  "Paper Trades": ["Summarize paper-trade results", "Which paper trades can be considered for promotion?", "Explain the latest paper trade"],
  "Strategy Lab": ["Explain the latest validation run", "Why did the candidate fail?", "What should I test next?"],
  Backtest: ["Explain the latest backtest", "Are these results reliable?", "Highlight overfitting risks"],
  "Copy Trading": ["Explain my copy traders", "Which copy source is highest risk?", "Summarize copy-trading activity"],
  Journal: ["Summarize recent lessons", "Find repeated trading mistakes", "Which trades need journal notes?"],
  News: ["Explain upcoming market risk", "Which events affect my open positions?", "Should the bot pause for news?"],
  Evidence: ["Explain the latest validation evidence", "Which safety gates are failing?", "Summarize execution quality"],
  Settings: ["Explain the settings on this page", "Check my current risk configuration", "Which settings are blocking trading?"],
  "Scalping Mode": ["Explain the scalping status", "Why were recent scalps blocked?", "Review the current scalping risk settings"],
};

function suggestionsFor(page: AssistantContextPage) {
  return PAGE_SUGGESTIONS[page] ?? ["Summarize my account and today's trading", "Why has the bot not taken a trade?", "Show my current risk settings"];
}

function messageId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function AssistantPanel({ onNavigate, contextPage = "Assistant", compact = false }: { onNavigate?: (id: NavId) => void; contextPage?: AssistantContextPage; compact?: boolean }) {
  const [messages, setMessages] = useState<Message[]>([{ id: "welcome", role: "assistant", text: "I can explain live account activity, trades, P/L, strategies and configuration. I can also prepare settings or bot-control changes; nothing is changed until you confirm it." }]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(text = input) {
    const clean = text.trim(); if (!clean || busy) return;
    setInput(""); setBusy(true);
    setMessages((current) => [...current, { id: messageId(), role: "user", text: clean }]);
    try {
      const reply = await api<Reply>("/api/assistant/chat", { method: "POST", body: { message: clean, context: { page: contextPage } } });
      setMessages((current) => [...current, { id: messageId(), role: "assistant", text: reply.message, confirmation: reply.confirmation }]);
      if (reply.navigation && onNavigate) onNavigate(reply.navigation as NavId);
    } catch (error) {
      setMessages((current) => [...current, { id: messageId(), role: "assistant", text: error instanceof Error ? error.message : "The assistant request failed." }]);
    } finally { setBusy(false); }
  }

  async function decide(targetMessageId: string, confirmation: NonNullable<Reply["confirmation"]>, approve: boolean) {
    setMessages((current) => current.map((item) => item.id === targetMessageId ? { ...item, confirmation: undefined } : item));
    if (!approve) {
      try {
        const reply = await api<Reply>("/api/assistant/chat", { method: "POST", body: { cancelToken: confirmation.token } });
        setMessages((current) => [...current, { id: messageId(), role: "assistant", text: reply.message }]);
      } catch (error) {
        setMessages((current) => [...current, { id: messageId(), role: "assistant", text: error instanceof Error ? error.message : "The confirmation could not be cancelled." }]);
      }
      return;
    }
    setBusy(true);
    try {
      const reply = await api<Reply>("/api/assistant/chat", { method: "POST", body: { confirmToken: confirmation.token } });
      setMessages((current) => [...current, { id: messageId(), role: "assistant", text: reply.message }]);
    } catch (error) {
      setMessages((current) => [...current, { id: messageId(), role: "assistant", text: error instanceof Error ? error.message : "The change could not be applied." }]);
    } finally { setBusy(false); }
  }

  return (
    <div className={`${compact ? "flex h-[min(68dvh,38rem)] w-full flex-col" : "mx-auto flex min-h-[calc(100dvh-10rem)] max-w-4xl flex-col rounded-2xl border border-line"} overflow-hidden bg-surface`}>
      <div className="flex items-center justify-between border-b border-line px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary-dim text-primary"><IconMessageCircle size={18} /></span><div className="min-w-0"><h2 className="truncate font-semibold">{compact ? `Help with ${contextPage}` : "System Assistant"}</h2><p className="truncate text-xs text-ink-faint">Grounded in live system data · viewing {contextPage}</p></div></div>
        <span className="hidden items-center gap-1 text-[11px] text-ink-faint sm:flex"><IconShield size={13} /> Changes require confirmation</span>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
        {messages.map((message) => <div key={message.id} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
          <div className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${message.role === "user" ? "bg-primary text-white" : "border border-line bg-surface-2 text-ink"}`}>
            {message.role === "assistant" ? <FormattedAssistantMessage text={message.text} /> : <p className="whitespace-pre-wrap">{message.text}</p>}
            {message.confirmation && <div className="mt-3 rounded-xl border border-amber-800 bg-amber-950/30 p-3"><p className="text-xs font-medium text-amber-200">{message.confirmation.summary}</p><p className="mt-1 text-[10px] text-amber-300/70">One-time confirmation · expires in 5 minutes</p><div className="mt-3 flex gap-2"><button type="button" disabled={busy} onClick={() => void decide(message.id, message.confirmation!, true)} className="btn-primary btn-sm">Confirm change</button><button type="button" disabled={busy} onClick={() => void decide(message.id, message.confirmation!, false)} className="btn-ghost btn-sm">Cancel</button></div></div>}
          </div>
        </div>)}
        {busy && <div className="flex justify-start"><div className="flex items-center gap-2 rounded-2xl border border-line bg-surface-2 px-4 py-3 text-sm text-ink-dim" role="status" aria-label="Assistant is typing"><span>Checking the live system</span><span className="flex gap-1" aria-hidden="true"><i className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.3s]" /><i className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.15s]" /><i className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary" /></span></div></div>}
      </div>
      {messages.length <= 2 && <div className="flex gap-2 overflow-x-auto px-4 pb-3 sm:px-6">{suggestionsFor(contextPage).map((suggestion) => <button type="button" key={suggestion} onClick={() => void send(suggestion)} className="shrink-0 rounded-full border border-line bg-surface-2 px-3 py-1.5 text-xs text-ink-dim hover:text-ink">{suggestion}</button>)}</div>}
      <form onSubmit={(event) => { event.preventDefault(); void send(); }} className="flex gap-2 border-t border-line p-3 sm:p-4">
        <label htmlFor="assistant-message" className="sr-only">Message the system assistant</label>
        <textarea id="assistant-message" rows={1} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder="Ask about trades, activity, or change a setting…" className="input min-h-11 flex-1 resize-none" />
        <button type="submit" disabled={busy || !input.trim()} className="btn-primary self-end">Send</button>
      </form>
    </div>
  );
}

export function FloatingAssistant({ contextPage, onNavigate }: { contextPage: AssistantContextPage; onNavigate?: (id: NavId) => void }) {
  const [open, setOpen] = useState(false);
  return <div className="fixed bottom-[5.25rem] right-3 z-[45] sm:right-5 lg:bottom-6 lg:right-6">
    {open && <div className="mb-3 w-[min(25rem,calc(100vw-1.5rem))] overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl shadow-black/50">
      <div className="flex items-center justify-between border-b border-line px-3 py-2 text-xs text-ink-dim">
        <span>Context: <strong className="text-ink">{contextPage}</strong></span>
        <div className="flex items-center gap-1">{onNavigate && <button type="button" className="btn-ghost btn-sm" onClick={() => { setOpen(false); onNavigate("Assistant"); }}>Open full</button>}<button type="button" className="btn-ghost !p-2" onClick={() => setOpen(false)} aria-label="Close assistant"><IconX size={16} /></button></div>
      </div>
      <AssistantPanel compact contextPage={contextPage} onNavigate={onNavigate} />
    </div>}
    {!open && <button type="button" onClick={() => setOpen(true)} aria-label={`Ask AI about ${contextPage}`} className="group flex items-center gap-2 rounded-full bg-primary px-4 py-3 text-sm font-semibold text-white shadow-xl shadow-black/40 transition hover:-translate-y-0.5 hover:brightness-110"><IconMessageCircle size={20} /><span className="hidden sm:inline">Ask AI</span><span className="absolute right-full mr-2 hidden whitespace-nowrap rounded-lg bg-surface px-2 py-1 text-xs font-normal text-ink shadow-lg group-hover:block">Help with {contextPage}</span></button>}
  </div>;
}
