"use client";

export default function DashboardError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <section className="panel max-w-lg text-center">
        <p className="eyebrow">Dashboard unavailable</p>
        <h1 className="mt-2 text-2xl font-semibold">Operational data could not be loaded</h1>
        <p className="mt-3 text-sm text-muted">No trading action was taken. Check service health, then retry.</p>
        <button className="btn-primary mt-5" onClick={reset}>Retry dashboard</button>
      </section>
    </main>
  );
}
