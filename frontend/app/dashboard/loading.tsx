export default function DashboardLoading() {
  return (
    <main className="min-h-dvh p-6" aria-busy="true" aria-label="Loading dashboard">
      <div className="mx-auto max-w-7xl space-y-4">
        <div className="h-10 w-64 animate-pulse rounded-lg bg-white/10" />
        <div className="grid gap-4 md:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((item) => <div key={item} className="h-36 animate-pulse rounded-2xl bg-white/5" />)}
        </div>
      </div>
    </main>
  );
}
