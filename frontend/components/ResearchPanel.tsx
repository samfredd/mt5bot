"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/components/ToastProvider";

type Source = { id: string; name: string; slug: string; category: string; accessMethod: string; enabled: boolean; approved: boolean; official: boolean; reliabilityScore: number; pollIntervalMin: number; healthStatus: string; lastFetchedAt: string | null; nextFetchAt: string | null; lastError: string | null; termsNote: string | null; rateLimitRemaining: number | null };
type Item = { id: string; title: string; canonicalUrl: string | null; kind: string; topic: string; factuality: string; verificationStatus: string; expectedImpact: string; credibilityScore: number; relevanceScore: number; promptInjectionDetected: boolean; relatedAssets: string[]; publishedAt: string | null; source: { name: string; official: boolean }; story: { sourceCount: number } | null };
type Knowledge = { id: string; title: string; content: string; confidence: number; verificationStatus: string; status: string; provenance: unknown; relatedAssets: string[]; updatedAt: string; approvalMethod: string | null; approvalDecision: string | null; approvalReason: string | null; approvalConfidence: number | null; approvedBy: string | null; approvedAt: string | null };
type Run = { id: string; status: string; fetchedCount: number; storedCount: number; duplicateCount: number; errorCount: number; error: string | null; startedAt: string; completedAt: string | null; source: { name: string } | null };
type Dashboard = { generatedAt: string; approval: { mode: "manual" | "ai"; minConfidence: number }; sources: Source[]; latest: Item[]; trending: { id: string; title: string; topic: string; verificationStatus: string; sourceCount: number; relatedAssets: string[]; lastSeenAt: string }[]; pendingKnowledge: Knowledge[]; reviewedKnowledge: Knowledge[]; conflicts: Knowledge[]; runs: Run[]; briefs: { id: string; type: string; title: string; content: string; createdAt: string }[]; storage: { items: number; knowledge: number; quarantined: number } };

export function ResearchPanel() {
  const toast = useToast();
  const [data, setData] = useState<Dashboard | null>(null);
  const [busy, setBusy] = useState("");
  const [view, setView] = useState<"intelligence" | "sources" | "knowledge" | "jobs">("intelligence");
  const load = useCallback(async () => { try { setData(await api<Dashboard>("/api/intelligence/dashboard")); } catch (error) { toast.error("Research dashboard unavailable", error instanceof Error ? error.message : "Could not load intelligence data."); } }, [toast]);
  useEffect(() => { void load(); }, [load]);
  const highImpact = data?.latest.filter((item) => item.expectedImpact === "HIGH").length ?? 0;

  async function refresh() {
    setBusy("refresh");
    try { await api("/api/intelligence/refresh", { method: "POST", body: {} }); toast.success("Intelligence refreshed", "Due approved sources were processed."); await load(); }
    catch (error) { toast.error("Refresh failed", error instanceof Error ? error.message : "Sources could not be processed."); }
    finally { setBusy(""); }
  }
  async function patchSource(source: Source, patch: Partial<Source>) {
    setBusy(source.id);
    try { await api(`/api/intelligence/sources/${source.id}`, { method: "PATCH", body: patch }); await load(); }
    catch (error) { toast.error("Source update failed", error instanceof Error ? error.message : "Could not update source."); }
    finally { setBusy(""); }
  }
  async function runSource(source: Source) {
    setBusy(source.id);
    try { await api(`/api/intelligence/sources/${source.id}/run`, { method: "POST", body: {} }); toast.success("Source processed", source.name); await load(); }
    catch (error) { toast.error("Source run failed", error instanceof Error ? error.message : source.name); }
    finally { setBusy(""); }
  }
  async function reviewKnowledge(item: Knowledge, action: "APPROVE" | "REJECT") {
    const reason = window.prompt(`${action === "APPROVE" ? "Why is this knowledge trusted?" : "Why should this be rejected?"}`)?.trim();
    if (!reason) return;
    setBusy(item.id);
    try { await api(`/api/intelligence/knowledge/${item.id}`, { method: "PATCH", body: { action, reason } }); toast.success("Knowledge reviewed", `${item.title} was ${action.toLowerCase()}d.`); await load(); }
    catch (error) { toast.error("Review failed", error instanceof Error ? error.message : "Could not review knowledge."); }
    finally { setBusy(""); }
  }
  async function runAiReview() {
    setBusy("ai-review");
    try {
      const result = await api<{ reviewed: number; approved: number; rejected: number; deferred: number; skipped: number; reason?: string }>("/api/intelligence/knowledge/ai-review", { method: "POST", body: {} });
      toast.success("AI review completed", result.reason ?? `${result.approved} approved, ${result.rejected} rejected, ${result.deferred} deferred.`);
      await load();
    } catch (error) { toast.error("AI review failed", error instanceof Error ? error.message : "Knowledge could not be reviewed."); }
    finally { setBusy(""); }
  }

  if (!data) return <section className="card"><p className="text-sm text-ink-dim">Loading market intelligence…</p></section>;
  const tabs = [["intelligence", "Intelligence"], ["sources", "Sources"], ["knowledge", `Knowledge (${data.pendingKnowledge.length})`], ["jobs", "Jobs & health"]] as const;
  return <div className="space-y-4">
    <section className="card">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="eyebrow">Research</p><h2 className="text-lg font-semibold">Market intelligence & knowledge</h2><p className="mt-1 max-w-3xl text-xs text-ink-dim">Structured, source-traceable evidence. Community and video content remains unverified until independently corroborated; external content cannot change settings or place trades.</p></div><button type="button" disabled={busy === "refresh"} onClick={() => void refresh()} className="btn-primary">{busy === "refresh" ? "Refreshing…" : "Refresh due sources"}</button></div>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4"><Metric label="Collected items" value={data.storage.items} /><Metric label="High impact" value={highImpact} /><Metric label="Pending knowledge" value={data.pendingKnowledge.length} /><Metric label="Quarantined" value={data.storage.quarantined} /></div>
      <div className="mt-4 flex gap-2 overflow-x-auto">{tabs.map(([id, label]) => <button key={id} type="button" onClick={() => setView(id)} className={view === id ? "btn-primary btn-sm" : "btn-ghost btn-sm"}>{label}</button>)}</div>
    </section>

    {view === "intelligence" && <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
      <section className="card"><h3 className="section-title">Prioritised intelligence</h3><div className="space-y-2">{data.latest.slice(0, 30).map((item) => <article key={item.id} className={`rounded-xl border p-3 ${item.promptInjectionDetected ? "border-red-900 bg-red-950/20" : "border-line bg-bg"}`}><div className="flex flex-wrap items-center gap-2 text-[11px]"><Badge value={item.verificationStatus} /><Badge value={item.factuality} /><span className={item.expectedImpact === "HIGH" ? "text-warn" : "text-ink-faint"}>{item.expectedImpact} impact</span><span className="ml-auto tnum text-ink-faint">relevance {Math.round(item.relevanceScore * 100)}%</span></div><h4 className="mt-2 text-sm font-medium text-ink">{item.canonicalUrl ? <a href={item.canonicalUrl} target="_blank" rel="noreferrer" className="hover:text-primary hover:underline">{item.title}</a> : item.title}</h4><div className="mt-1 flex flex-wrap gap-2 text-xs text-ink-faint"><span>{item.source.name}</span><span>·</span><span>{item.topic.replaceAll("_", " ")}</span>{item.story && <><span>·</span><span>{item.story.sourceCount} source(s)</span></>}{item.relatedAssets?.length > 0 && <><span>·</span><span>{item.relatedAssets.join(", ")}</span></>}</div>{item.promptInjectionDetected && <p className="mt-2 text-xs text-down">Quarantined: possible prompt-injection language detected.</p>}</article>)}</div></section>
      <section className="card"><h3 className="section-title">Developing stories</h3><div className="space-y-2">{data.trending.map((story) => <div key={story.id} className="rounded-xl bg-bg p-3"><div className="flex items-center justify-between gap-2"><Badge value={story.verificationStatus} /><span className="text-[11px] text-ink-faint">{story.sourceCount} independent source(s)</span></div><p className="mt-2 text-sm text-ink">{story.title}</p><p className="mt-1 text-xs text-ink-faint">{story.topic.replaceAll("_", " ")} · {(story.relatedAssets ?? []).join(", ") || "broad market"}</p></div>)}</div></section>
    </div>}

    {view === "sources" && <section className="card"><h3 className="section-title">Source catalogue and restrictions</h3><div className="space-y-2">{data.sources.map((source) => <div key={source.id} className="rounded-xl border border-line bg-bg p-3"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-medium">{source.name}</h4>{source.official && <Badge value="OFFICIAL" />}<Badge value={source.healthStatus} /></div><p className="mt-1 text-xs text-ink-faint">{source.accessMethod} · reliability {Math.round(source.reliabilityScore * 100)}% · every {source.pollIntervalMin} min</p><p className="mt-1 max-w-3xl text-xs text-ink-dim">{source.termsNote}</p>{source.lastError && <p className="mt-1 text-xs text-down">{source.lastError}</p>}</div><div className="flex flex-wrap gap-2"><label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={source.approved} disabled={busy === source.id} onChange={(event) => void patchSource(source, { approved: event.target.checked })} /> trusted access</label><label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={source.enabled} disabled={busy === source.id || !source.approved} onChange={(event) => void patchSource(source, { enabled: event.target.checked })} /> enabled</label><button type="button" disabled={busy === source.id || !source.enabled || !source.approved} onClick={() => void runSource(source)} className="btn-ghost btn-sm">Run</button></div></div></div>)}</div></section>}

        {view === "knowledge" && <div className="space-y-4"><section className="card"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="section-title">Knowledge approval</h3><p className="text-xs text-ink-dim">Mode: <strong>{data.approval.mode === "ai" ? "AI automatic review" : "Manual review"}</strong>{data.approval.mode === "ai" && ` · ${Math.round(data.approval.minConfidence * 100)}% action threshold`}. Source licences and trading permission always remain outside this automation.</p></div>{data.approval.mode === "ai" && <button type="button" disabled={busy === "ai-review"} onClick={() => void runAiReview()} className="btn-primary btn-sm">{busy === "ai-review" ? "Reviewing…" : "Run AI review now"}</button>}</div><div className="mt-4 space-y-2">{data.pendingKnowledge.length === 0 && <p className="text-sm text-ink-faint">Nothing is awaiting review.</p>}{data.pendingKnowledge.map((item) => <article key={item.id} className="rounded-xl border border-line bg-bg p-3"><div className="flex flex-wrap items-center gap-2"><Badge value={item.verificationStatus} /><span className="text-xs text-ink-faint">confidence {Math.round(item.confidence * 100)}%</span>{item.approvalDecision === "DEFER" && <Badge value="AI DEFERRED" />}</div><h4 className="mt-2 text-sm font-medium">{item.title}</h4><p className="mt-1 line-clamp-4 text-xs leading-relaxed text-ink-dim">{item.content}</p>{item.approvalDecision === "DEFER" && <p className="mt-2 text-xs text-warn">Last AI review: {item.approvalReason}</p>}{data.approval.mode === "manual" && <div className="mt-3 flex gap-2"><button type="button" disabled={busy === item.id} onClick={() => void reviewKnowledge(item, "APPROVE")} className="btn-primary btn-sm">Approve</button><button type="button" disabled={busy === item.id} onClick={() => void reviewKnowledge(item, "REJECT")} className="btn-danger btn-sm">Reject</button></div>}{data.approval.mode === "ai" && item.approvalDecision !== "DEFER" && <p className="mt-2 text-xs text-ink-faint">The next ingestion cycle will review this automatically; uncertain decisions stay pending.</p>}</article>)}</div></section><section className="card"><h3 className="section-title">Recent approval decisions</h3><div className="space-y-2">{data.reviewedKnowledge.length === 0 && <p className="text-sm text-ink-faint">No recorded decisions yet.</p>}{data.reviewedKnowledge.map((item) => <article key={item.id} className="rounded-xl border border-line bg-bg p-3"><div className="flex flex-wrap items-center gap-2"><Badge value={item.status} /><Badge value={item.approvalMethod ?? "UNKNOWN"} /><span className="text-xs text-ink-faint">{item.approvalConfidence == null ? "" : `${Math.round(item.approvalConfidence * 100)}% decision confidence`}</span></div><h4 className="mt-2 text-sm font-medium">{item.title}</h4><p className="mt-1 text-xs leading-relaxed text-ink-dim">{item.approvalReason}</p><p className="mt-2 text-[11px] text-ink-faint">{item.approvedBy}{item.approvedAt ? ` · ${new Date(item.approvedAt).toLocaleString()}` : ""}</p></article>)}</div></section></div>}

    {view === "jobs" && <section className="card"><h3 className="section-title">Ingestion jobs</h3><div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="text-ink-faint"><tr><th className="pb-2">Source</th><th>Status</th><th>Fetched</th><th>Stored</th><th>Duplicates</th><th>Started</th></tr></thead><tbody>{data.runs.map((run) => <tr key={run.id} className="border-t border-line"><td className="py-2 pr-3">{run.source?.name ?? "Maintenance"}</td><td><Badge value={run.status} /></td><td className="tnum">{run.fetchedCount}</td><td className="tnum">{run.storedCount}</td><td className="tnum">{run.duplicateCount}</td><td className="text-ink-faint">{new Date(run.startedAt).toLocaleString()}</td></tr>)}</tbody></table></div></section>}
  </div>;
}

function Metric({ label, value }: { label: string; value: number }) { return <div className="rounded-xl bg-bg p-3"><p className="text-[11px] text-ink-faint">{label}</p><p className="tnum mt-1 text-xl font-semibold">{value}</p></div>; }
function Badge({ value }: { value: string }) { const good = /CONFIRMED|OFFICIAL|HEALTHY|SUCCEEDED|APPROVED/.test(value); const bad = /FAILED|RUMOUR|REJECTED|CONFLICT|QUARANTIN/.test(value); return <span className={`chip ${good ? "bg-emerald-950 text-up" : bad ? "bg-red-950 text-down" : "bg-surface-3 text-ink-dim"}`}>{value.replaceAll("_", " ").toLowerCase()}</span>; }
