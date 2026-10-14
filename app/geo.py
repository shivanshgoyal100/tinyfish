"""Geocoding (Nominatim) and nearby amenities (Overpass). Both cached on disk."""
import asyncio
import json
import math
import re
import time

import httpx

from .config import DATA, UA

GEOCACHE = DATA / 'geocache.json'
AMENITY_CACHE = DATA / 'amenity_cache.json'
OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']
AMENITY_TTL = 7 * 24 * 3600

QUERY = '''[out:json][timeout:60];
(
  nwr(around:{r},{lat},{lon})[amenity~'^(school|college|university|hospital|clinic|doctors|bank|marketplace)$'];
  nwr(around:{r},{lat},{lon})[shop~'^(supermarket|mall|convenience)$'];
  nwr(around:{r},{lat},{lon})[leisure=park];
  nwr(around:{r},{lat},{lon})[highway=bus_stop];
  nwr(around:{r},{lat},{lon})[railway=station];
  nwr(around:{r},{lat},{lon})[station=subway];
);
out center tags;'''

_nominatim_lock = asyncio.Lock()
_last_nominatim = 0.0


def _load(path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding='utf-8')


async def _nominatim(text, limit):
    global _last_nominatim
    async with _nominatim_lock:
        wait = 1.1 - (time.monotonic() - _last_nominatim)
        if wait > 0:
            await asyncio.sleep(wait)
        try:
            async with httpx.AsyncClient(headers=UA, timeout=30) as http:
                r = await http.get('https://nominatim.openstreetmap.org/search',
                                   params={'q': text, 'format': 'json', 'limit': limit, 'countrycodes': 'in'})
            hits = r.json() if r.status_code == 200 else []
        except (httpx.HTTPError, ValueError):
            hits = []
        _last_nominatim = time.monotonic()
    return [{'lat': float(h['lat']), 'lon': float(h['lon']), 'text': h['display_name']} for h in hits]


async def _photon(text, near):
    params = {'q': text, 'limit': 8}
    if near:
        params.update(lat=near[0], lon=near[1])
    try:
        async with httpx.AsyncClient(headers=UA, timeout=30) as http:
            r = await http.get('https://photon.komoot.io/api/', params=params)
        feats = r.json().get('features', []) if r.status_code == 200 else []
    except (httpx.HTTPError, ValueError):
        feats = []
    out = []
    for f in feats:
        p, (lon, lat) = f['properties'], f['geometry']['coordinates']
        if p.get('countrycode', 'IN') != 'IN':
            continue
        text_ = ', '.join(str(p[k]) for k in ('name', 'street', 'district', 'city', 'county', 'state') if p.get(k))
        out.append({'lat': lat, 'lon': lon, 'text': text_})
    return out


async def geocode(text):
    """[lat, lon] of the top Nominatim hit, cached. Used for listing locality text (pins are approximate)."""
    cache = _load(GEOCACHE)
    if text in cache:
        return cache[text]
    hits = await _nominatim(text, 1)
    point = [hits[0]['lat'], hits[0]['lon']] if hits else None
    cache = _load(GEOCACHE)
    cache[text] = point
    _save(GEOCACHE, cache)
    return point


GENERIC = {'sector', 'sec', 'phase', 'block', 'pocket', 'india', 'road', 'city', 'new', 'old', 'nagar'}


def _matches(hit_text, name, city):
    """Nominatim fuzzy-matches 'Sector 150' to 'Sector 18', so a hit must contain the locality's own
    numbers (as whole numbers) and, for names without numbers, its distinctive words."""
    t = hit_text.lower()
    nums = re.findall(r'\d+', name)
    if nums:
        return all(re.search(rf'(?<!\d){n}(?!\d)', t) for n in nums)
    words = [w for w in re.findall(r'[a-z]+', name.lower()) if len(w) > 2 and w not in GENERIC]
    return bool(words) and all(w in t for w in words)


async def geocode_locality(name, city, state, city_fallback=True):
    """Returns ([lat, lon], how) for the locality. Validates every hit and stays near the city."""
    key = f'LOCALITY|{name}|{city}|{state}'
    cache = _load(GEOCACHE)
    if cache.get(key):
        return cache[key]['point'], cache[key]['how']

    city_pt = await geocode(f'{city}, {state}, India') or await geocode(f'{city}, India')

    def pick(hits, source):
        for h in hits:
            near_city = not city_pt or dist_m(city_pt[0], city_pt[1], h['lat'], h['lon']) < 45000
            if near_city and _matches(h['text'], name, city):
                return [h['lat'], h['lon']], f"{source}: {h['text'][:90]}"
        return None

    variants = [f'{name}, {city}, {state}, India', f'{name}, {city}']
    hyphen = re.sub(r'(?i)\b(sector|sec|phase|block)\s+(\d+)', r'\1-\2', name)
    if hyphen != name:
        variants.append(f'{hyphen}, {city}')
    found = None
    for q in variants:
        found = pick(await _nominatim(q, 10), 'OpenStreetMap')
        if found:
            break
    if not found:
        found = pick(await _photon(f'{name} {city}', city_pt), 'Photon/OSM')
    if not found and city_pt and city_fallback:
        found = city_pt, f'city centre of {city} (locality not found on OpenStreetMap)'
    cache = _load(GEOCACHE)
    cache[key] = {'point': found[0], 'how': found[1]} if found else None
    _save(GEOCACHE, cache)
    return found or (None, None)


def dist_m(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 6371000 * 2 * math.asin(math.sqrt(a))


def classify(tags):
    amenity = tags.get('amenity')
    if amenity in ('school', 'college', 'university'):
        return 'school'
    if amenity in ('hospital', 'clinic', 'doctors'):
        return 'health'
    if amenity in ('bank', 'marketplace') or tags.get('shop') in ('supermarket', 'mall', 'convenience'):
        return 'daily'
    if tags.get('leisure') == 'park':
        return 'park'
    if tags.get('highway') == 'bus_stop':
        return 'bus'
    if tags.get('railway') == 'station' or tags.get('station') == 'subway':
        return 'metro'
    return None


async def fetch_amenities(lat, lon, radius=2000):
    key = f'{lat:.4f},{lon:.4f},{radius}'
    cache = _load(AMENITY_CACHE)
    hit = cache.get(key)
    if hit and time.time() - hit['at'] < AMENITY_TTL:
        return hit['items']
    query = QUERY.format(r=radius, lat=lat, lon=lon)
    last_err = None
    async with httpx.AsyncClient(headers=UA, timeout=75) as http:
        # The public servers return 429/504 when busy, so retry the main one before trying a mirror.
        for endpoint in (OVERPASS[0], OVERPASS[0], OVERPASS[1]):
            try:
                r = await http.post(endpoint, data={'data': query})
                r.raise_for_status()
                elements = r.json().get('elements', [])
                break
            except (httpx.HTTPError, ValueError) as err:
                last_err = f'{type(err).__name__} {err}'.strip()
                await asyncio.sleep(3)
        else:
            raise RuntimeError(f'Overpass unavailable ({last_err})')
    items = []
    for el in elements:
        tags = el.get('tags', {})
        cat = classify(tags)
        pos = el if 'lat' in el else el.get('center')
        if not cat or not pos:
            continue
        items.append({'cat': cat, 'name': tags.get('name') or tags.get('name:en') or cat,
                      'lat': pos['lat'], 'lon': pos['lon'],
                      'dist_m': round(dist_m(lat, lon, pos['lat'], pos['lon']))})
    items.sort(key=lambda i: i['dist_m'])
    cache = _load(AMENITY_CACHE)
    cache[key] = {'at': time.time(), 'items': items}
    _save(AMENITY_CACHE, cache)
    return items


def score(items):
    """Heuristic score out of 10. Metro distance has the largest weight (see section 13.1 of the spec)."""
    def near(cat, radius):
        return [i for i in items if i['cat'] == cat and i['dist_m'] <= radius]

    metro = sorted(i['dist_m'] for i in items if i['cat'] == 'metro')
    m = metro[0] if metro else None
    parts = {
        'metro': 3 if m is not None and m <= 500 else 2 if m is not None and m <= 1000 else 1 if m is not None and m <= 2000 else 0,
        'school': min(len(near('school', 1000)), 2) * 1.0,
        'health': 2 if near('health', 1000) else 0,
        'daily': 1.5 if near('daily', 1000) else 0,
        'park': 1 if near('park', 1000) else 0,
        'bus': 0.5 if len(near('bus', 1000)) >= 2 else 0,
    }
    counts = {c: len(near(c, 1000)) for c in ('school', 'health', 'daily', 'park', 'bus', 'metro')}
    return {
        'score': round(sum(parts.values()), 1),
        'parts': parts,
        'counts_1km': counts,
        'nearest_metro_m': m,
    }


def verdict_line(summary, amen):
    """One sentence such as '12% above circle rate, 4 schools and a metro station within 1 km.'"""
    bits = []
    gap = summary.get('gap_pct')
    if gap is not None:
        bits.append(f"{abs(gap):.0f}% {'above' if gap >= 0 else 'below'} circle rate")
    elif summary.get('median_ppsy'):
        bits.append(f"median Rs {summary['median_ppsy']:,} per sq yd")
    c = amen['counts_1km']
    near = []
    if c['school']:
        near.append(f"{c['school']} school{'s' if c['school'] != 1 else ''}")
    if c['health']:
        near.append(f"{c['health']} health facilit{'ies' if c['health'] != 1 else 'y'}")
    if amen['nearest_metro_m'] is not None and amen['nearest_metro_m'] <= 1000:
        near.append('a metro/rail station')
    if near:
        tail = ', '.join(near[:-1]) + (' and ' if len(near) > 1 else '') + near[-1]
        bits.append(f'{tail} within 1 km')
    elif amen['nearest_metro_m'] is not None:
        bits.append(f"nearest metro/rail {amen['nearest_metro_m'] / 1000:.1f} km")
    s = ', '.join(bits)
    return (s[:1].upper() + s[1:] + '.') if s else ''
