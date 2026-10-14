"""Weekly run: scans every locality on the watchlist (star it in the UI) and saves the results.

    python run_weekly.py                 # watchlist, or the preset localities if the watchlist is empty
    python run_weekly.py --stealth       # use the stealth browser profile for every agent

Schedule it weekly. Windows Task Scheduler (Monday 08:00):
    schtasks /Create /SC WEEKLY /D MON /ST 08:00 /TN PlotScoutWeekly ^
      /TR "\"%CD%\\.venv\\Scripts\\python.exe\" \"%CD%\\run_weekly.py\""
Linux / macOS cron:
    0 8 * * 1 cd /path/to/plot-map && .venv/bin/python run_weekly.py
"""
import argparse
import asyncio
import os
import sys

from dotenv import load_dotenv

os.chdir(os.path.dirname(os.path.abspath(__file__)))
load_dotenv()

from app import pipeline, store  # noqa: E402
from app.config import PORTALS, PRESET_LOCALITIES  # noqa: E402


def console(ev):
    t = ev.get('type')
    if t == 'agent':
        if ev['phase'] == 'step':
            print(f"  [{ev['id']:<22}] {ev.get('t', 0):6.1f}s  {ev['purpose']}")
        elif ev['phase'] in ('started', 'done', 'error'):
            extra = ev.get('message') or ''
            if ev['phase'] == 'done':
                extra = f"{len((ev.get('result') or {}).get('listings') or [])} listings" if ev['id'].startswith('portal') else 'ok'
            print(f"  [{ev['id']:<22}] {ev['phase'].upper()} {extra}")
    elif t == 'circle' and ev['phase'] in ('on_file', 'found', 'not_found', 'error'):
        print(f"  [circle-rate] {ev['phase']} {ev.get('message', '')}")
    elif t == 'warn':
        print('  WARN', ev['message'])


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--stealth', action='store_true')
    ap.add_argument('--no-circle', action='store_true', help='do not look up missing circle rates')
    args = ap.parse_args()

    locs = store.load_watchlist() or PRESET_LOCALITIES
    print(f'Weekly run for {len(locs)} localities')
    failures = 0
    # One locality at a time: the portals of each locality still run in parallel.
    for loc in locs:
        print(f"\n== {loc['name']}, {loc['city']}")
        try:
            r = await pipeline.scan(console, name=loc['name'], city=loc['city'], state=loc['state'],
                                    portals=[k for k, v in PORTALS.items() if v.get('default')], stealth=args.stealth, auto_circle=not args.no_circle)
            print(f"  -> {r['n']} listings, median Rs {r['median_ppsy'] or 0:,}/sq yd, {r['verdict']}")
            d = r['digest']
            if d['compared_to']:
                change = '' if d['median_change_pct'] is None else f", median {d['median_change_pct']:+.1f}%"
                print(f"  -> since {d['compared_to']}: {len(d['new'])} new, {len(d['price_drops'])} price drops{change}")
        except Exception as err:  # log and continue with the next locality
            failures += 1
            print(f'  FAILED: {type(err).__name__}: {err}')
    sys.exit(1 if failures == len(locs) else 0)


if __name__ == '__main__':
    asyncio.run(main())
