"""One locality scan: portals in parallel, then clean, compare, score and save.

Used by the web server (events go to the browser) and by run_weekly.py (events go to the console).
"""
import asyncio
import random
import re

from . import agents, clean, geo, store
from .config import PORTALS, slug


def _portal_list(portals, custom_urls):
    out = [(k, PORTALS[k]['label'], PORTALS[k]['url']) for k in portals if k in PORTALS]
    for url in custom_urls or []:
        url = url.strip()
        if not url:
            continue
        if not url.startswith('http'):
            url = 'https://' + url
        host = url.split('/')[2].removeprefix('www.')
        out.append((f'custom-{slug(host)}', host, url))
    return out


async def _place_listings(rows, center, name, city, state):
    """Listings only name a locality, so pins are approximate: geocode distinct locality text when it
    differs from the searched one (validated, within 12 km), then add a small stable jitter."""
    lat0, lon0 = center
    spots = {}
    for text in {(r.get('locality') or '').strip() for r in rows}:
        if not text or slug(text) in (slug(name), slug(f'{name} {city}')) or len(spots) >= 6:
            continue
        part = re.split(r',', text)[0].strip()
        try:
            p, _ = await geo.geocode_locality(part, city, state, city_fallback=False)
        except Exception:
            p = None
        if p and geo.dist_m(lat0, lon0, *p) < 12000:
            spots[text] = p
    for i, r in enumerate(rows):
        base = spots.get((r.get('locality') or '').strip(), center)
        rnd = random.Random(r.get('url') or f"{r['portal']}{r.get('title')}{r.get('price_text')}{i}")
        r['lat'] = base[0] + rnd.uniform(-0.0035, 0.0035)
        r['lon'] = base[1] + rnd.uniform(-0.0035, 0.0035)
        r['pin'] = 'listing locality' if base is not center else 'search area'


def _apply_filters(rows, f):
    lo, hi, budget = f.get('min_area'), f.get('max_area'), f.get('budget')
    for r in rows:
        r['match'] = ((not lo or r['area_sqyd'] >= lo) and (not hi or r['area_sqyd'] <= hi)
                      and (not budget or r['total_price_inr'] <= budget))


async def scan(emit, *, name, city, state, portals, custom_urls=(), stealth=False,
               auto_circle=True, filters=None):
    name, city = name.strip(), city.strip()
    loc_id = store.locality_id(name, city)
    label = f'{name}, {city}'
    plist = _portal_list(portals, custom_urls)
    emit({'type': 'job', 'phase': 'start', 'kind': 'scan', 'id': loc_id, 'label': label,
          'agents': [{'id': f'portal:{k}', 'label': lbl, 'url': url, 'role': 'listings'} for k, lbl, url in plist]})

    center, q = await geo.geocode_locality(name, city, state)
    if center:
        emit({'type': 'geo', 'lat': center[0], 'lon': center[1], 'how': q, 'label': label})
        if q.startswith('city centre'):
            emit({'type': 'warn', 'message': f'"{name}" is not on OpenStreetMap, so the map uses the {city} city centre. Amenities are for that point.'})
    else:
        emit({'type': 'warn', 'message': f'Could not geocode "{label}" on OpenStreetMap; the map will skip it.'})

    async def amenities_task():
        if not center:
            return []
        try:
            items = await geo.fetch_amenities(*center)
            emit({'type': 'amenities', 'items': items, 'score': geo.score(items)})
            return items
        except Exception as err:
            emit({'type': 'warn', 'message': f'Amenities unavailable: {err}'})
            return []

    rates = clean.load_circle_rates()
    circle = rates.get(loc_id)

    async def circle_task():
        if circle:
            emit({'type': 'circle', 'phase': 'on_file', 'rate': circle})
            return circle
        if not auto_circle:
            emit({'type': 'circle', 'phase': 'skipped'})
            return None
        found = await agents.find_circle_rate(emit, name, city, state, stealth=stealth)
        if found and found.get('unit') in clean.TO_SQYD:
            return {'rate_inr': found['rate_inr'], 'unit': found['unit'], 'category': found.get('category') or '',
                    'source_url': found['source_url'], 'as_of': found.get('as_of') or '',
                    'origin': 'agent (verify)', 'evidence': found.get('evidence'), 'gov': found.get('gov'),
                    'ppsy': round(found['rate_inr'] * clean.TO_SQYD[found['unit']])}
        return None

    portal_status = {}

    async def portal_task(key, lbl, url):
        res = await agents.run_agent(emit, f'portal:{key}', url=url, goal=agents.listing_goal(name, city, lbl),
                                     schema=agents.LISTING_SCHEMA, stealth=stealth)
        found = (res or {}).get('listings') or []
        for item in found:
            item.update(portal=lbl, portal_key=key, query_locality=label)
        portal_status[key] = {'label': lbl, 'url': url, 'ok': res is not None, 'count': len(found),
                              'blocked': bool((res or {}).get('blocked')), 'notes': (res or {}).get('notes')}
        good, _ = clean.enrich([dict(x) for x in found])
        if center and good:
            await _place_listings(good, center, name, city, state)
            emit({'type': 'listings', 'portal': lbl, 'rows': good})
        return found

    gathered = await asyncio.gather(amenities_task(), circle_task(),
                                    *(portal_task(*p) for p in plist))
    items, circle, raw_lists = gathered[0], gathered[1], gathered[2:]
    if center and not items:
        # Public Overpass servers are often busy; the agents took minutes, so one more try is cheap.
        emit({'type': 'warn', 'message': 'Retrying OpenStreetMap amenities…'})
        items = await amenities_task()
    raw = [x for lst in raw_lists for x in lst]

    rows, dropped = clean.enrich(raw)
    rows = clean.dedupe(rows)
    rows, outliers = clean.drop_outliers(rows)
    dropped += outliers
    if center:
        await _place_listings(rows, center, name, city, state)
    _apply_filters(rows, filters or {})
    summary = clean.summarise(rows, circle)
    amen = geo.score(items)

    result = {
        'id': loc_id, 'label': label, 'name': name, 'city': city, 'state': state,
        'lat': center[0] if center else None, 'lon': center[1] if center else None, 'geo_how': q,
        'generated': store.now_iso(), **summary,
        'circle': circle, 'amenity': amen, 'amenities': items,
        'verdict_line': geo.verdict_line(summary, amen),
        'listings': rows, 'dropped': dropped, 'portals': portal_status, 'filters': filters or {},
    }
    result['digest'] = store.digest(result, store.previous_run(loc_id, result['generated'][:10]))
    result['saved'] = bool(rows)
    if rows:
        store.save_run(result)
    result['trend'] = store.trend(loc_id)
    emit({'type': 'result', 'result': result})
    return result


def resummarise(loc_id):
    """After a circle rate is saved or corrected, recompute the gap on the latest run for that locality."""
    files = store.run_files(loc_id)
    if not files:
        return None
    import json
    r = json.loads(files[-1].read_text(encoding='utf-8'))
    circle = clean.load_circle_rates().get(loc_id)
    if circle:
        circle = {**circle, 'origin': circle.get('origin') or 'manual'}
    r.update(clean.summarise(r['listings'], circle))
    r['circle'] = circle
    r['verdict_line'] = geo.verdict_line(r, r['amenity'])
    files[-1].write_text(json.dumps(r, indent=1), encoding='utf-8')
    store.write_history_row({'date': r['generated'][:10], 'locality_id': loc_id, 'locality': r['label'],
                             'n': r['n'], 'median_ppsy': r['median_ppsy'] or '',
                             'circle_ppsy': r['circle_ppsy'] or '',
                             'gap_pct': '' if r['gap_pct'] is None else r['gap_pct']})
    r['trend'] = store.trend(loc_id)
    return r
