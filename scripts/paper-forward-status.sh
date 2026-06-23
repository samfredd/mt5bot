#!/usr/bin/env bash
# Option A — AI-gated paper-forward test status.
# Reports the verdict on whether the live AI gate turns the (backtest-negative)
# mechanical strategies into a real edge. No money is at risk: paperForward
# diverts every AI- and risk-approved proposal to the PaperTrade ledger instead
# of the broker. Run anytime: bash scripts/paper-forward-status.sh
set -euo pipefail

DB_CTR="${DB_CTR:-mt5bot-postgres-1}"
psql() { docker exec "$DB_CTR" psql -U mt5bot -d mt5bot "$@"; }

echo "=== paper-forward switch (must be paperForward:true, status:running) ==="
psql -A -t -c "select value from \"SystemSetting\" where key='bot_state';"

echo
echo "=== OVERALL (closed paper trades) ==="
psql -c "
select
  count(*) filter (where status='CLOSED')                       as closed,
  count(*) filter (where status='OPEN')                         as open,
  count(*) filter (where status='CLOSED' and profit>0)          as wins,
  count(*) filter (where status='CLOSED' and profit<0)          as losses,
  coalesce(round(sum(profit) filter (where status='CLOSED')::numeric,2),0) as net_pnl,
  round((100.0*count(*) filter (where status='CLOSED' and profit>0)
        / nullif(count(*) filter (where status='CLOSED'),0))::numeric,1)   as win_pct,
  round((sum(profit) filter (where status='CLOSED' and profit>0)
        / nullif(abs(sum(profit) filter (where status='CLOSED' and profit<0)),0))::numeric,2) as profit_factor
from \"PaperTrade\";"

echo "=== PER STRATEGY (closed; null = scanner-sourced) ==="
psql -c "
select coalesce(s.name,'(scanner)') as strategy,
       count(*) filter (where p.status='CLOSED')              as closed,
       count(*) filter (where p.status='CLOSED' and p.profit>0) as wins,
       round(sum(p.profit) filter (where p.status='CLOSED')::numeric,2) as net_pnl,
       round((sum(p.profit) filter (where p.status='CLOSED' and p.profit>0)
             / nullif(abs(sum(p.profit) filter (where p.status='CLOSED' and p.profit<0)),0))::numeric,2) as pf
from \"PaperTrade\" p left join \"Strategy\" s on s.id=p.\"strategyId\"
group by 1 order by net_pnl desc nulls last;"

echo "=== AI gate selectivity (last 24h) ==="
psql -A -F $'\t' -c "
select action, count(*) from \"AuditLog\"
where \"createdAt\" > now() - interval '24 hours'
  and action in ('ai_veto','ai_unavailable','paper_trade_opened','trade_blocked')
group by action order by count desc;"
