"""Unit normalisation, de-duplication, outlier removal and the circle-rate gap."""
import csv
import math
import re
import statistics

from .config import DATA, slug

CIRCLE_RATES = DATA / 'circle_rates.csv'
CIRCLE_FIELDS = ['locality', 'city', 'rate_inr', 'unit', 'category', 'source_url', 'as_of', 'origin']

SQ_YD_PER_UNIT = {
    'sq yd': 1.0, 'gaj': 1.0,
    'sq ft': 1 / 9,
    'sq m': 1.19599,
    'acre': 4840.0,
    'hectare': 11959.9,
}  # bigha, marla and kanal are left out on purpose: their size differs by state

TO_SQYD = {'per_sqyd': 1.0, 'per_sqft': 9.0, 'per_sqm': 1 / 1.19599}


def norm_unit(unit):
    u = str(unit or '').lower().replace('.', ' ').replace('-', ' ').replace('_', ' ')
    u = re.sub(r'square|sq(?=[a-z])', 'sq ', u)
    u = re.sub(r'\b(yards?|yrds?|yds?)\b', 'yd', u)
    u = re.sub(r'\b(feet|foot|ft)\b', 'ft', u)
    u = re.sub(r'\b(meters?|metres?|mtrs?|mt|m)\b', 'm', u)
    u = re.sub(r'\b(acres?)\b', 'acre', u)
    u = re.sub(r'\b(hectares?|ha)\b', 'hectare', u)
    u = ' '.join(u.split())
    return {'sqyd': 'sq yd', 'sqft': 'sq ft', 'sqm': 'sq m', 'gaz': 'gaj'}.get(u.replace(' ', ''), u)


PRICE_MULT = {'cr': 1e7, 'crore': 1e7, 'crores': 1e7, 'l': 1e5, 'lac': 1e5, 'lacs': 1e5, 'lakh': 1e5,
              'lakhs': 1e5, 'k': 1e3, 'thousand': 1e3}


def parse_price(text):
    """'₹1.30 Cr' -> 13000000, '70 Lac' -> 7000000, '₹ 85,00,000' -> 8500000. Ranges use the lower bound."""
    m = re.search(r'([\d][\d,]*\.?\d*)\s*(crores?|cr|lakhs?|lacs?|l|k|thousand)?\b', str(text or '').lower())
    if not m:
        return None
    n = float(m.group(1).replace(',', ''))
    return n * PRICE_MULT.get(m.group(2) or '', 1)


def parse_area(text):
    """'200 sq.yd' -> (200, 'sq yd'), '1,800 sqft' -> (1800, 'sq ft')."""
    m = re.search(r'([\d][\d,]*\.?\d*)\s*([a-z][a-z. -]*)', str(text or '').lower())
    if not m:
        return None, None
    return float(m.group(1).replace(',', '')), norm_unit(m.group(2))


def _fill_numbers(r):
    """The agent's own numbers win unless they disagree wildly with the text shown on the page."""
    parsed = parse_price(r.get('price_text'))
    total = r.get('total_price_inr')
    if parsed and parsed >= 50000 and (not total or not 0.3 <= float(total) / parsed <= 3.3):
        r['total_price_inr'] = parsed
    if not r.get('area') or not r.get('area_unit'):
        area, unit = parse_area(r.get('area_text'))
        if area:
            r['area'], r['area_unit'] = area, unit


def enrich(rows):
    """Adds area_sqyd and ppsy (price per sq yd). Drops rows that cannot be converted."""
    out, dropped = [], []
    for r in rows:
        _fill_numbers(r)
        factor = SQ_YD_PER_UNIT.get(norm_unit(r.get('area_unit')))
        try:
            area_sqyd = float(r['area']) * factor
            price = float(r['total_price_inr'])
        except (KeyError, TypeError, ValueError):
            dropped.append({**r, 'drop_reason': f"unsupported unit '{r.get('area_unit')}'" if not factor
                            else 'missing area or price'})
            continue
        if not 20 <= area_sqyd <= 50000 or price <= 0:
            dropped.append({**r, 'drop_reason': 'area or price out of range'})
            continue
        r['area_sqyd'] = round(area_sqyd, 1)
        r['ppsy'] = round(price / area_sqyd)
        out.append(r)
    return out, dropped


def dedupe(rows):
    """Same plot on two portals: same area and a price inside the same Rs 10,000 band."""
    seen, out = {}, []
    for r in rows:
        key = (round(r['area_sqyd']), round(r['total_price_inr'], -4))
        url = (r.get('url') or '').split('?')[0]
        if key in seen or (url and url in seen):
            first = seen.get(key) or seen.get(url)
            first.setdefault('also_on', []).append(r['portal'])
            continue
        seen[key] = r
        if url:
            seen[url] = r
        out.append(r)
    return out


def drop_outliers(rows):
    """Tukey fence on log(price per sq yd). A fixed 0.4x-2.5x band around the median threw away most
    listings in markets with two clusters (e.g. farmhouse land vs villa plots in Noida Sector 150)."""
    if len(rows) < 5:
        return rows, []
    logs = sorted(math.log(r['ppsy']) for r in rows)
    q1, _, q3 = statistics.quantiles(logs, n=4)
    lo, hi = q1 - 1.5 * (q3 - q1), q3 + 1.5 * (q3 - q1)
    keep, gone = [], []
    for r in rows:
        (keep if lo <= math.log(r['ppsy']) <= hi else gone).append(r)
    return keep, [{**r, 'drop_reason': 'price outlier'} for r in gone]


def load_circle_rates():
    rates = {}
    if not CIRCLE_RATES.exists():
        return rates
    with CIRCLE_RATES.open(newline='', encoding='utf-8') as f:
        for row in csv.DictReader(f):
            try:
                rate = float(row['rate_inr'])
            except (TypeError, ValueError):
                continue
            if rate > 0 and row.get('unit') in TO_SQYD:
                rates[slug(f"{row['locality']} {row.get('city', '')}")] = {
                    **row,
                    'rate_inr': rate,
                    'ppsy': round(rate * TO_SQYD[row['unit']]),
                }
    return rates


def save_circle_rate(entry):
    rows = []
    if CIRCLE_RATES.exists():
        with CIRCLE_RATES.open(newline='', encoding='utf-8') as f:
            rows = [r for r in csv.DictReader(f)
                    if slug(f"{r['locality']} {r.get('city', '')}") != slug(f"{entry['locality']} {entry['city']}")]
    rows.append({k: entry.get(k, '') for k in CIRCLE_FIELDS})
    with CIRCLE_RATES.open('w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=CIRCLE_FIELDS)
        w.writeheader()
        w.writerows(rows)


def verdict(gap):
    if gap is None:
        return 'No circle rate on file'
    if gap > 25:
        return 'Well above circle rate'
    if gap > 10:
        return 'Above circle rate'
    if gap >= -10:
        return 'Close to circle rate'
    return 'Below circle rate'


def summarise(rows, circle):
    vals = [r['ppsy'] for r in rows]
    if not vals:
        return {'n': 0, 'median_ppsy': None, 'circle_ppsy': circle['ppsy'] if circle else None,
                'gap_pct': None, 'verdict': 'No usable listings'}
    med = round(statistics.median(vals))
    gap = round((med / circle['ppsy'] - 1) * 100, 1) if circle else None
    for r in rows:
        r['gap_pct'] = round((r['ppsy'] / circle['ppsy'] - 1) * 100, 1) if circle else None
    return {
        'n': len(vals),
        'median_ppsy': med,
        'min_ppsy': min(vals),
        'max_ppsy': max(vals),
        'circle_ppsy': circle['ppsy'] if circle else None,
        'gap_pct': gap,
        'verdict': verdict(gap),
    }
