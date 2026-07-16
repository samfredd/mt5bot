# Market intelligence and long-term knowledge

## Architecture

```text
Structured source adapters
  RSS | licensed API | YouTube Data API | X API | GitHub API | authorized bot/webhook
        ↓
Untrusted-content boundary
  sanitize markup → detect prompt injection → preserve raw metadata
        ↓
Normalization and provenance
  content hash → story fingerprint → entities/assets/topics → local embedding
        ↓
Verification and relevance
  source reliability + independent agreement + recency + impact + open-position match
        ↓
Raw intelligence       Versioned knowledge          Trading awareness
PostgreSQL + FTS   →    pending human approval  →    confirmed/official items only
        ↓                       ↓                         ↓
Research dashboard       assistant retrieval             risk-size reduction
```

External content is always data, never instructions. It cannot call tools, change settings, write approved knowledge, or place a trade. New strategy ideas continue through source evaluation, verification, backtesting, out-of-sample validation, risk review, paper trading, and human approval.

## Source catalogue and access restrictions

| Source | Access method | Default | Restriction |
| --- | --- | --- | --- |
| Federal Reserve | Official RSS | Enabled and approved | Public structured publication; preserve attribution and URL. |
| European Central Bank | Official RSS/MID | Enabled and approved | Public structured publication with source authenticity. |
| Economic calendar | Configured structured JSON | Enabled | Existing operator-configured source; scheduled event data remains authoritative for trading pauses. |
| Reuters | Reuters Connect licensed API | Disabled | Requires a Reuters content/API licence. Page scraping is not used. |
| Associated Press | AP Media API | Disabled | Requires AP Newsroom/Media API licensed entitlement. |
| Bloomberg | Enterprise licensed feed/API | Disabled | Requires Bloomberg commercial data rights. |
| Financial Times | Licensed content/API | Disabled | Requires commercial reuse rights. |
| Wall Street Journal / Dow Jones | Licensed API/Factiva | Disabled | Requires Dow Jones content licence. |
| BBC | Licensed RSS for business use | Disabled | Commercial RSS/metadata reuse requires permission or a metadata licence. |
| Al Jazeera, CNBC, MarketWatch and other publishers | Approved RSS or licensed feed | Disabled unless operator-approved | Confirm syndication terms before enabling; metadata-only where full content is not licensed. |
| YouTube | YouTube Data API v3 | Disabled | API key and quota required. Public API supplies metadata; captions/transcripts are processed only when legally available and authorized. No title-only prediction is treated as fact. |
| X | Official X API v2 | Disabled | Paid/approved API access and bearer token required. No scraping. X content is community opinion and cannot become approved knowledge without corroboration. |
| Reddit | Official Data API/OAuth | Disabled | Current Reddit terms, OAuth, and applicable data licence required. No private subreddit access. |
| Discord | Installed Discord bot | Disabled | Bot must be invited and granted channel/history permissions. No private-community bypass. |
| GitHub | Public REST API | Disabled | Optional token raises limits. Stars and popularity are not correctness evidence. |
| MQL5, Forex Factory, TradingView, Elite Trader, public quant communities | Approved API/RSS/webhook or licensed access | Disabled | No fragile or terms-violating scraping. Add a source only when a permitted structured method exists. |

Credentials are encrypted in the database and managed from **Settings → Operational configuration**. No new `.env` values are required. Deployment bootstrap variables (`DATABASE_URL`, `JWT_SECRET`, `CREDENTIALS_ENC_KEY`, and Redis connectivity) remain infrastructure secrets and are not market-source settings.

## Confidence and verification

### Knowledge approval modes

Settings → Operational configuration exposes two database-backed modes:

- `manual`: candidates remain pending until an administrator or manager approves or rejects them.
- `ai` (default): the selected AI provider automatically evaluates eligible pending candidates after ingestion and during maintenance. The action-confidence threshold is configurable from 50% to 99%.

AI review is fail-closed. Missing providers, invalid output, weak provenance, unconfirmed claims, low confidence, or ambiguity leave the candidate pending. Prompt-injection evidence is rejected by deterministic security policy before model review. Every AI or human action records the method, decision, reason, confidence, actor, time, audit event, and knowledge version. AI approval applies only to research knowledge; it cannot approve source licences, change settings, authorize live trading, or bypass the risk engine.

Each source starts with a base reliability score. A rolling score combines:

- base reputation and whether the source is an official institution;
- the fraction of its reports later corroborated by independent sources;
- prompt-injection or unsafe-content frequency;
- source health, timeliness, and structured provenance.

Items are labelled `OFFICIAL`, `CONFIRMED`, `UNCONFIRMED`, `RUMOUR`, or `CONFLICTED`. Content type is separately labelled as report, opinion, rumour, promotion, video, community, or developer research. Two publishers reporting the same event are not assumed independent merely because the headlines differ; story grouping and distinct source IDs are used.

Only `OFFICIAL` or independently `CONFIRMED` high-impact intelligence can influence trading awareness. Even then it can only reduce sizing through the existing news gate. Calendar events remain the only source that can cause the configured deterministic pause. Rumours, community sentiment, videos, repositories, and promotional content never trigger trades or bypass authorization.

## Memory layers

- **Raw-source storage:** `IntelligenceItem` preserves title, content, author, URL, publisher, publication/retrieval time, raw metadata, engagement, and hashes.
- **Short-term memory:** active non-expired items and developing `IntelligenceStory` clusters.
- **Long-term knowledge:** `KnowledgeEntry`, with provenance, confidence, verification, expiry/review dates, related assets, local vector embedding, and human-approval state.
- **Episodic memory:** existing trade memory, audit records, incidents, model decisions, execution comparisons, and research briefs.
- **Semantic memory:** assets, countries, topics, entities, claims, story relationships, full-text search, and local feature-hash vectors.

Every knowledge change creates a `KnowledgeVersion` recording who/what changed it, why, confidence, verification state, and provenance. Automatically extracted knowledge starts as `PENDING`; only an administrator or manager can approve, reject, or correct it.

## Retention

- Community sentiment: 24 hours by default.
- Rumours and opinions: 48 hours unless reviewed.
- Breaking/reporting context: 14 days.
- Video/educational metadata: 180 days, subject to API policy and revalidation.
- Confirmed event outcomes, approved educational concepts, trade lessons, audits, and versions: retained until explicitly reviewed or deleted.
- Expired items are archived, not silently rewritten. Expired knowledge has confidence reduced to zero while historical versions remain.

## Schedules

The five-minute coordinator uses per-source `nextFetchAt` and polling intervals:

- Official/breaking sources: 5–15 minutes.
- Community and new approved videos: hourly by catalogue configuration.
- GitHub/developer research: every three hours by default.
- Daily: retention, source-score maintenance, duplicate consolidation inputs, and daily briefing.
- Weekly on Sunday UTC: weekly research briefing.

Every execution has a unique time-bucket idempotency key, persisted job record, timeout, retry policy, exponential source backoff, rate-limit metadata, audit record, and incident alert after repeated failure.

## APIs

- `GET /api/intelligence/dashboard`
- `GET /api/intelligence/search?q=...`
- `POST /api/intelligence/refresh`
- `POST /api/intelligence/sources/:id/run`
- `PATCH /api/intelligence/sources/:id`
- `PATCH /api/intelligence/knowledge/:id`
- `DELETE /api/intelligence/items/:id`
- `POST /api/intelligence/briefs/daily|weekly`
- MCP resource: `mt5bot://system/intelligence`
- MCP tool: `search_market_intelligence`

## Known limitations and next connectors

- Licensed Reuters/AP/Bloomberg/FT/Dow Jones connectors are represented in the catalogue but cannot operate without customer entitlements and vendor-specific credentials.
- The public YouTube Data API does not provide arbitrary public-video transcript downloads. The adapter stores metadata and an explicit transcript-availability state; an OAuth/authorized-caption or licensed transcript connector is the next extension.
- Reddit and Discord remain disabled until an operator completes OAuth/bot authorization and accepts the applicable platform terms. No unauthorized fallback scraping is implemented.
- Local feature-hash vectors provide deterministic semantic similarity without sending untrusted content to another provider. A production pgvector/managed-embedding index can be added later after privacy, cost, and model-version policies are chosen.
- Current story clustering uses normalized headline fingerprints. A future entity/time-aware clustering service can improve cross-language and heavily paraphrased story grouping.
