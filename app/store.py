"""Run storage: one JSON file per scan, a history CSV for trends, and a watchlist for the weekly run."""
import csv
import datetime as dt
import json

from .config import DATA, slug

RUNS = DATA / 'runs'
HISTORY = DATA / 'history.csv'
WATCHLIST = DATA / 'watchlist.json'
HISTORY_FIELDS = ['date', 'locality_id', 'locality', 'n', 'median_ppsy', 'circle_ppsy', 'gap_pct']


def locality_id(name, city):
    return slug(f'{name} {city}')


def read_history():
    if not HISTORY.exists():
        return []
    with HISTORY.open(newline='', encoding='utf-8') as f:
        return list(csv.DictReader(f))


def write_history_row(row):
    """One row per locality per day: a second run on the same day replaces the first."""
    rows = [h for h in read_history()
            if not (h['date'] == row['date'] and h['locality_id'] == row['locality_id'])]
    rows.append({k: row.get(k, '') for k in HISTORY_FIELDS})
    rows.sort(key=lambda h: (h['locality_id'], h['date']))
    HISTORY.parent.mkdir(parents=True, exist_ok=True)
    with HISTORY.open('w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=HISTORY_FIELDS)
        w.writeheader()
        w.writerows(rows)


def trend(loc_id):
    return [{'date': h['date'], 'median': int(float(h['median_ppsy']))}
            for h in read_history() if h['locality_id'] == loc_id and h['median_ppsy']]


def run_files(loc_id):
    d = RUNS / loc_id
    return sorted(d.glob('*.json')) if d.exists() else []


def previous_run(loc_id, before_date):
    for p in reversed(run_files(loc_id)):
        if p.stem[:10] < before_date:
            return json.loads(p.read_text(encoding='utf-8'))
    return None


def digest(current, previous):
    """New listings and price drops compared with the last run on an earlier day."""
    if not previous:
        return {'compared_to': None, 'new': [], 'price_drops': [], 'median_change_pct': None}

    def key(x):
        return (x.get('url') or '').split('?')[0] or f"{round(x['area_sqyd'])}|{x['portal']}"

    before = {key(x): x for x in previous.get('listings', [])}
    new, drops = [], []
    for x in current['listings']:
        old = before.get(key(x))
        if old is None:
            new.append(x)
        elif x['total_price_inr'] < old['total_price_inr']:
            drops.append({**x, 'old_price': old['total_price_inr'],
                          'drop_pct': round((1 - x['total_price_inr'] / old['total_price_inr']) * 100, 1)})
    change = None
    if previous.get('median_ppsy') and current.get('median_ppsy'):
        change = round((current['median_ppsy'] / previous['median_ppsy'] - 1) * 100, 1)
    return {'compared_to': previous['generated'][:10], 'new': new, 'price_drops': drops,
            'median_change_pct': change}


def save_run(result):
    d = RUNS / result['id']
    d.mkdir(parents=True, exist_ok=True)
    stamp = result['generated'].replace(':', '-')[:19]
    (d / f'{stamp}.json').write_text(json.dumps(result, indent=1), encoding='utf-8')
    write_history_row({
        'date': result['generated'][:10], 'locality_id': result['id'], 'locality': result['label'],
        'n': result['n'], 'median_ppsy': result['median_ppsy'] or '',
        'circle_ppsy': result['circle_ppsy'] or '', 'gap_pct': '' if result['gap_pct'] is None else result['gap_pct'],
    })


def latest_runs():
    out = []
    if not RUNS.exists():
        return out
    for d in sorted(RUNS.iterdir()):
        files = sorted(d.glob('*.json'))
        if files:
            r = json.loads(files[-1].read_text(encoding='utf-8'))
            r['trend'] = trend(r['id'])
            out.append(r)
    return out


def load_watchlist():
    try:
        return json.loads(WATCHLIST.read_text(encoding='utf-8'))
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def set_watch(loc, on):
    items = [w for w in load_watchlist() if locality_id(w['name'], w['city']) != locality_id(loc['name'], loc['city'])]
    if on:
        items.append({k: loc[k] for k in ('name', 'city', 'state')})
    WATCHLIST.parent.mkdir(parents=True, exist_ok=True)
    WATCHLIST.write_text(json.dumps(items, indent=1), encoding='utf-8')
    return items


def now_iso():
    return dt.datetime.now().isoformat(timespec='seconds')
