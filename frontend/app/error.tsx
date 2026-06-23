"use client";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <section className="panel max-w-lg text-center">
        <p className="eyebrow">Application error</p>
        <h1 className="mt-2 text-2xl font-semibold">The page could not be rendered</h1>
        <p className="mt-3 text-sm text-muted">The trading service was not changed. Retry the interface or return to login.</p>
        <button className="btn-primary mt-5" onClick={reset}>Retry</button>
      </section>
    </main>
  );
}
