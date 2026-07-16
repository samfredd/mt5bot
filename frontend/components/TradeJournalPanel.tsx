"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/components/ToastProvider";

interface Trade { id: string; symbol: string; direction: string; status: string; createdAt: string; }
interface Entry { id: string; tradeId: string; notes: string; tags: string[]; lessons: string; rating: number | null; trade: { symbol: string; direction: string; profit: number | null }; }

export function TradeJournalPanel() {
  const toast = useToast();
  const [trades, setTrades] = useState<Trade[]>([]);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [tradeId, setTradeId] = useState("");
  const [notes, setNotes] = useState("");
  const [tags, setTags] = useState("");
  const [lessons, setLessons] = useState("");
  const [rating, setRating] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { const [allTrades, journal] = await Promise.all([api<Trade[]>("/api/trades?limit=100&account=all"), api<Entry[]>("/api/journal")]); setTrades(allTrades); setEntries(journal); setTradeId((current) => current || allTrades[0]?.id || ""); setError(""); } catch (err) { setError(String(err)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const save = async () => {
    if (!tradeId) return;
    try {
      await api(`/api/trades/${tradeId}/journal`, { method: "PUT", body: { notes, lessons, tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean), rating: rating ? Number(rating) : null } });
      setNotes(""); setTags(""); setLessons(""); setRating("");
      await load();
      toast.success("Journal entry saved", "Your trade notes and review were updated.");
    } catch (err) {
      toast.error("Journal entry not saved", err instanceof Error ? err.message : "The journal update failed.");
    }
  };
  return <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,.7fr)]"><section className="panel"><p className="eyebrow">Review</p><h2 className="mb-4 text-lg font-semibold">Trade journal</h2>{error && <p className="text-sm text-down">Could not load journal: {error}</p>}{!error && entries === null && <p className="text-sm text-ink-faint">Loading journal...</p>}{!error && entries?.length === 0 && <p className="text-sm text-ink-faint">No journal entries yet.</p>}<div className="space-y-2">{entries?.map((entry) => <article className="card !p-3" key={entry.id}><div className="flex justify-between"><strong className="text-sm">{entry.trade.direction} {entry.trade.symbol}</strong><span className="text-xs text-ink-faint">{entry.rating ? `${entry.rating}/5` : "unrated"}</span></div><p className="mt-2 text-xs text-ink-dim">{entry.notes || "No notes"}</p>{entry.lessons && <p className="mt-1 text-xs text-ink-faint">Lesson: {entry.lessons}</p>}<div className="mt-2 flex flex-wrap gap-1">{entry.tags.map((tag) => <span className="chip bg-surface-3" key={tag}>{tag}</span>)}</div></article>)}</div></section>
    <section className="panel"><p className="eyebrow">Add or update</p><h2 className="mb-4 text-lg font-semibold">Journal entry</h2><label className="label">Trade<select className="input mt-1 w-full" value={tradeId} onChange={(event) => setTradeId(event.target.value)}>{trades.map((trade) => <option value={trade.id} key={trade.id}>{trade.direction} {trade.symbol} · {trade.status}</option>)}</select></label><label className="label mt-3">Notes<textarea className="input mt-1 min-h-24 w-full" value={notes} onChange={(event) => setNotes(event.target.value)} /></label><label className="label mt-3">Tags, comma separated<input className="input mt-1 w-full" value={tags} onChange={(event) => setTags(event.target.value)} /></label><label className="label mt-3">Lessons<textarea className="input mt-1 min-h-20 w-full" value={lessons} onChange={(event) => setLessons(event.target.value)} /></label><label className="label mt-3">Rating<select className="input mt-1 w-full" value={rating} onChange={(event) => setRating(event.target.value)}><option value="">Unrated</option>{[1,2,3,4,5].map((value) => <option value={value} key={value}>{value}/5</option>)}</select></label><button className="btn-primary mt-4 w-full" disabled={!tradeId} onClick={() => void save()}>Save journal entry</button></section></div>;
}
