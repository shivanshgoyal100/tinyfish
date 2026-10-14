"""Everything that talks to TinyFish: Agent (streaming), Search and Fetch.

Each public coroutine takes an `emit` callback and reports progress as small dicts,
so the web UI can show every agent's live browser, its steps and its result.
"""
import datetime as dt
import json
import re
import time

from tinyfish import AgentConfig, AsyncTinyFish, BrowserProfile
from tinyfish import CompleteEvent, ProgressEvent, StartedEvent, StreamingUrlEvent
from tinyfish import PermissionDeniedError

from .config import AGENT_MAX_SECONDS, MAX_LISTINGS_PER_PORTAL

_client = None


def client():
    global _client
    if _client is None:
        _client = AsyncTinyFish()  # reads TINYFISH_API_KEY
    return _client


def _s(nullable=False, description=None):
    # TinyFish output_schema rejects "description" and type arrays, so descriptions stay as code
    # comments only and optional fields use nullable: true.
    return {'type': 'string', 'nullable': True} if nullable else {'type': 'string'}


LISTING_SCHEMA = {
    'type': 'object',
    'properties': {
        'listings': {
            'type': 'array',
            'maxItems': MAX_LISTINGS_PER_PORTAL,
            'items': {
                'type': 'object',
                'properties': {
                    'title': _s(),
                    'area_text': _s(description='Plot area exactly as shown, e.g. "200 sq.yd"'),
                    'area': {'type': 'number', 'nullable': True},
                    'area_unit': _s(nullable=True),
                    'price_text': _s(description='Price exactly as shown, e.g. "₹1.2 Cr"'),
                    'total_price_inr': {'type': 'number', 'nullable': True},
                    'locality': _s(nullable=True),
                    'project': _s(nullable=True),
                    'posted_by': _s(nullable=True),
                    'url': _s(nullable=True),
                    'listed_on': _s(nullable=True),
                },
                # Kept loose on purpose: a strict numeric schema made some portals return an empty list.
                # clean.enrich() parses area_text and price_text when the numbers are missing.
                'required': ['title', 'price_text'],
            },
        },
        'blocked': {'type': 'boolean'},
        'notes': _s(),
    },
    'required': ['listings'],
}

CIRCLE_SCHEMA = {
    'type': 'object',
    'properties': {
        'found': {'type': 'boolean'},
        'rate_inr': {'type': 'number', 'nullable': True},
        'unit': _s(nullable=True, description='per sq m, per sq yd or per sq ft'),
        'category': _s(nullable=True),
        'as_of': _s(nullable=True),
        'evidence': _s(nullable=True, description='The exact row or sentence the rate was read from'),
        'is_government_source': {'type': 'boolean'},
        'notes': _s(),
    },
    'required': ['found'],
}

RERA_SCHEMA = {
    'type': 'object',
    'properties': {
        'found': {'type': 'boolean'},
        'registration_number': _s(nullable=True),
        'project_name': _s(nullable=True),
        'promoter': _s(nullable=True),
        'status': _s(nullable=True),
        'valid_until': _s(nullable=True),
        'page_url': _s(nullable=True),
        'could_not_check': {'type': 'boolean'},
        'notes': _s(),
    },
    'required': ['found'],
}

AUCTION_SCHEMA = {
    'type': 'object',
    'properties': {
        'schemes': {
            'type': 'array',
            'maxItems': 10,
            'items': {
                'type': 'object',
                'properties': {
                    'title': _s(),
                    'kind': _s(description='e-auction, draw scheme, allotment, tender...'),
                    'location': _s(nullable=True),
                    'plot_sizes': _s(nullable=True),
                    'reserve_price_text': _s(nullable=True),
                    'opens_on': _s(nullable=True),
                    'closes_on': _s(nullable=True),
                    'status': _s(nullable=True),
                    'url': _s(nullable=True),
                },
                'required': ['title'],
            },
        },
        'notes': _s(),
    },
    'required': ['schemes'],
}


def listing_goal(name, city, portal_label):
    return (
        f'Find residential plots / land for sale in {name}, {city} on {portal_label}.\n'
        '1. Close any cookie, login, location or app-download popups.\n'
        '2. Use the site search: choose Buy, pick Plot / Residential Land as the property type if offered, '
        f'type "{name} {city}" and choose the matching suggestion.\n'
        f'3. On the results page read the first {MAX_LISTINGS_PER_PORTAL} plot listings and put every one of them '
        'in the listings array of your answer. For each return: title, the area text exactly as shown, '
        'plot area as a number, area unit (sq yd, sq ft, sq m, acre, marla, bigha), '
        'the price text exactly as shown, total price in rupees as a plain number (1 lakh = 100000, 1 crore = 10000000), '
        'locality, project or society name if shown, who posted it (owner/dealer/builder) if shown, '
        'the full listing URL (the link of the listing card), and the listed date if shown.\n'
        'Skip listings with no price and anything that is not a plot or land.\n'
        'Do not click contact, enquiry, call, chat or login buttons and never type personal details.\n'
        'If an access-denied, CAPTCHA or blank page appears, set blocked to true and return what you have.'
    )


def circle_goal(name, city, state):
    return (
        f'This page may list circle rates (government guideline / collector / DLC rates) for {city}, {state}. '
        f'Find the circle rate for RESIDENTIAL land or plots in {name}, {city}. '
        'If this is a documents or notices page, open the newest circle rate list (it may be titled Circle Rate, '
        'सर्किल रेट, Collector Rate, DLC Rate or Guideline Value). '
        'If the page is a list, table or PDF, scroll or search within it for that locality or sector. '
        'Return the rate as a number in rupees, its unit (per sq m, per sq yd or per sq ft), the land category, '
        'the effective date or year, and the exact row or sentence you read it from as evidence. '
        'Say whether the page is an official government source (.gov.in / .nic.in / a district or registration '
        'department site). If the rate for that exact locality is not on the page, set found to false. '
        'Do not guess and do not average nearby values.'
    )


def rera_goal(project, promoter, locality):
    who = f' by the promoter {promoter}' if promoter else ''
    near = f' in or near {locality}' if locality else ''
    return (
        f'Use the project search on this RERA portal. Search for the project named "{project}"{who}{near}. '
        'Return the registration number, project status, validity date and promoter name from the first '
        'matching result, plus the page URL. If there is no match, set found to false. '
        'If the search needs a CAPTCHA, OTP or login, stop and set could_not_check to true. '
        'Do not submit any personal details.'
    )


def auction_goal(authority, place):
    where = f' Focus on schemes in or near {place}.' if place else ''
    return (
        f'This is the website of {authority}. Find current or recent residential plot schemes, e-auctions '
        'or allotment schemes for plots / land (look for menus such as Schemes, Auction, E-Auction, '
        f'Public Notices, Tenders or Plot Allotment).{where} For each scheme (up to 10) return the title, '
        'kind (e-auction, draw, allotment...), location, plot sizes, reserve or base price as shown, '
        'opening and closing dates, status, and a link. Prefer the newest. Do not register, log in or '
        'apply for anything.'
    )


def parse_result(result):
    """The Agent API returns a JSON object directly; a list or text answer arrives under result.result."""
    if isinstance(result, dict) and set(result) == {'result'}:
        result = result['result']
    if isinstance(result, str):
        start, end = result.find('{'), result.rfind('}')
        if start == -1:
            start, end = result.find('['), result.rfind(']')
        try:
            result = json.loads(result[start:end + 1])
        except ValueError:
            return {'raw_text': result}
    if isinstance(result, list):
        return {'listings': result}
    return result if isinstance(result, dict) else {}


async def run_agent(emit, agent_id, *, url, goal, schema=None, stealth=False, max_seconds=AGENT_MAX_SECONDS):
    """Runs one streaming TinyFish agent and forwards its events. Returns the parsed result dict."""
    t0 = time.monotonic()
    profile = BrowserProfile.STEALTH if stealth else None
    emit({'type': 'agent', 'id': agent_id, 'phase': 'queued', 'url': url, 'goal': goal,
          'stealth': stealth, 'schema': schema is not None})

    async def _stream(output_schema):
        async with client().agent.stream(
            url=url, goal=goal, output_schema=output_schema, browser_profile=profile,
            agent_config=AgentConfig(max_duration_seconds=max_seconds),
        ) as stream:
            steps = 0
            async for ev in stream:
                t = round(time.monotonic() - t0, 1)
                if isinstance(ev, StartedEvent):
                    emit({'type': 'agent', 'id': agent_id, 'phase': 'started', 'run_id': ev.run_id, 't': t})
                elif isinstance(ev, StreamingUrlEvent):
                    emit({'type': 'agent', 'id': agent_id, 'phase': 'live', 'streaming_url': ev.streaming_url, 't': t})
                elif isinstance(ev, ProgressEvent):
                    steps += 1
                    emit({'type': 'agent', 'id': agent_id, 'phase': 'step', 'purpose': ev.purpose, 'n': steps, 't': t})
                elif isinstance(ev, CompleteEvent):
                    return ev, steps
        return None, 0

    try:
        try:
            ev, steps = await _stream(schema)
        except PermissionDeniedError:
            # output_schema is a beta feature; without it the goal still asks for JSON.
            emit({'type': 'agent', 'id': agent_id, 'phase': 'step', 'purpose': 'Structured output not enabled, retrying with plain JSON goal', 't': 0})
            ev, steps = await _stream(None)
    except Exception as err:  # network, auth, rate limit: report it on the card instead of crashing the job
        emit({'type': 'agent', 'id': agent_id, 'phase': 'error', 'message': f'{type(err).__name__}: {err}',
              't': round(time.monotonic() - t0, 1)})
        return None

    t = round(time.monotonic() - t0, 1)
    if ev is None:
        emit({'type': 'agent', 'id': agent_id, 'phase': 'error', 'message': 'Stream ended without a result', 't': t})
        return None
    if ev.status != 'COMPLETED':
        msg = ev.error.message if ev.error else ev.status
        emit({'type': 'agent', 'id': agent_id, 'phase': 'error', 'message': msg, 'status': str(ev.status), 't': t})
        return None
    parsed = parse_result(ev.result_json)
    emit({'type': 'agent', 'id': agent_id, 'phase': 'done', 'status': 'COMPLETED', 'steps': steps,
          'result': parsed, 't': t})
    return parsed


# --------------------------------------------------------------------------- circle rate

GOV_HINTS = ('.gov.in', '.nic.in', 'igrsup', 'jamabandi', 'revenue', 'registration', 'collector')


def _snippet(text, words, width=220):
    """Fallback when Fetch highlights (beta) are not available: first window that mentions a keyword."""
    low = (text or '').lower()
    for w in words:
        i = low.find(w.lower())
        if i != -1:
            s = max(0, i - width // 2)
            return ' '.join(text[s:s + width].split())
    return None


async def find_circle_rate(emit, name, city, state, stealth=False):
    """Search API finds candidate pages, Fetch API reads them, then an Agent extracts the rate."""
    year = dt.date.today().year
    query = f'{city} circle rate {year} residential plot {name}'
    emit({'type': 'circle', 'phase': 'search', 'query': query})
    purpose = f'Find the official government circle rate (guideline value) for residential land in {name}, {city}, {state}.'
    results, seen = [], set()
    # Two searches: one open, one limited to government domains, where the official lists are published.
    for kwargs in ({}, {'include_domains': 'gov.in,nic.in'}):
        try:
            res = await client().search.query(query if not kwargs else f'{city} {state} circle rate list residential',
                                              location='India', language='en', purpose=purpose, **kwargs)
        except Exception as err:
            emit({'type': 'circle', 'phase': 'search', 'query': query, 'message': f'Search failed: {err}'})
            continue
        for r in res.results[:6]:
            if r.url not in seen:
                seen.add(r.url)
                results.append(r)

    words = [w for w in re.findall(r'\w+', name) if len(w) > 2 or w.isdigit()] + [city]
    cands = []
    for r in results:
        gov = any(h in r.url.lower() for h in GOV_HINTS)
        text = (r.title + ' ' + r.snippet).lower()
        mentions = sum(w.lower() in text for w in words) + (2 if 'circle' in text or 'collector' in text else 0)
        cands.append({'url': r.url, 'title': r.title, 'site': r.site_name, 'snippet': r.snippet,
                      'gov': gov, 'score': mentions + (3 if gov else 0)})
    emit({'type': 'circle', 'phase': 'results', 'results': cands})
    if not cands:
        emit({'type': 'circle', 'phase': 'error', 'message': 'Search returned no pages'})
        return None

    # Fetch the top pages and look for the locality inside them.
    ranked = sorted(cands, key=lambda c: -c['score'])
    top = ([c for c in ranked if c['gov']][:2] + [c for c in ranked if not c['gov']])[:4]
    try:
        hl_query = f'{name} {city} residential circle rate per sq m'
        try:
            fetched = await client().fetch.get_contents(
                [c['url'] for c in top], format='markdown', per_url_timeout_ms=20000,
                highlights={'query': hl_query, 'max_snippets': 2})
            hl = True
        except PermissionDeniedError:
            fetched = await client().fetch.get_contents([c['url'] for c in top], format='markdown', per_url_timeout_ms=20000)
            hl = False
        by_url = {f.url: f for f in fetched.results}
        for c in top:
            f = by_url.get(c['url'])
            if not f:
                c['fetch'] = 'failed'
                continue
            snip = (f.highlights[0].text if hl and f.highlights else _snippet(f.text, words))
            c['fetch'] = 'ok'
            c['evidence_snippet'] = snip
            if snip and any(w.lower() in snip.lower() for w in words[:-1]):
                c['score'] += 2
        emit({'type': 'circle', 'phase': 'fetched', 'results': top})
    except Exception as err:
        emit({'type': 'circle', 'phase': 'fetched', 'results': top, 'message': f'Fetch skipped: {err}'})

    ranked = sorted(top, key=lambda c: -c['score'])
    gov_first = [c for c in ranked if c['gov']][:1]
    picks = gov_first + [c for c in ranked if c not in gov_first][:2 - len(gov_first)]
    for i, c in enumerate(picks):
        emit({'type': 'circle', 'phase': 'agent', 'url': c['url'], 'attempt': i + 1})
        out = await run_agent(emit, 'circle-rate', url=c['url'], goal=circle_goal(name, city, state),
                              schema=CIRCLE_SCHEMA, stealth=stealth, max_seconds=300)
        if out and out.get('found') and out.get('rate_inr'):
            unit = normalise_rate_unit(out.get('unit'))
            found = {**out, 'unit': unit, 'source_url': c['url'], 'source_title': c['title'],
                     'gov': bool(out.get('is_government_source')) or c['gov']}
            emit({'type': 'circle', 'phase': 'found', 'rate': found})
            return found
    emit({'type': 'circle', 'phase': 'not_found'})
    return None


def normalise_rate_unit(unit):
    u = (unit or '').lower().replace('.', '').replace(' ', '')
    if 'yd' in u or 'yard' in u or 'gaj' in u:
        return 'per_sqyd'
    if 'ft' in u or 'feet' in u:
        return 'per_sqft'
    if 'm' in u or 'metre' in u or 'meter' in u:
        return 'per_sqm'
    return None
