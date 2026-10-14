"""Web server: starts TinyFish jobs and streams their events to the browser over SSE.

    python server.py            ->  http://localhost:8000
"""
import asyncio
import json
import os
import time
import uuid

import httpx
from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.responses import StreamingResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from app import agents, clean, pipeline, store  # noqa: E402
from app.config import PORTALS, PRESET_LOCALITIES, STATES, WEB  # noqa: E402

app = FastAPI(title='Plot Price Map')


class Job:
    def __init__(self, kind, label):
        self.id = uuid.uuid4().hex[:10]
        self.kind, self.label = kind, label
        self.events, self.done, self.task = [], False, None
        self.run_ids = set()
        self.started = time.time()
        self._wake = asyncio.Event()

    def emit(self, ev):
        ev['seq'] = len(self.events)
        ev['at'] = round(time.time() - self.started, 1)
        if ev.get('run_id'):
            self.run_ids.add(ev['run_id'])
        self.events.append(ev)
        self._wake.set()
        self._wake = asyncio.Event()

    async def wait(self):
        await self._wake.wait()


JOBS: dict[str, Job] = {}


def start_job(kind, label, coro_fn):
    job = Job(kind, label)
    JOBS[job.id] = job

    async def runner():
        try:
            await coro_fn(job.emit)
        except asyncio.CancelledError:
            job.emit({'type': 'job', 'phase': 'cancelled'})
        except Exception as err:
            job.emit({'type': 'job', 'phase': 'failed', 'message': f'{type(err).__name__}: {err}'})
        finally:
            job.done = True
            job.emit({'type': 'job', 'phase': 'end'})

    job.task = asyncio.create_task(runner())
    return {'job_id': job.id, 'started': job.started}


@app.get('/api/jobs/{job_id}/events')
async def job_events(job_id: str, after: int = -1):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, 'unknown job')

    async def gen():
        i = after + 1
        while True:
            while i < len(job.events):
                yield f'data: {json.dumps(job.events[i], default=str)}\n\n'
                i += 1
            if job.done and i >= len(job.events):
                return
            try:
                await asyncio.wait_for(job.wait(), timeout=15)
            except asyncio.TimeoutError:
                yield ': keepalive\n\n'

    return StreamingResponse(gen(), media_type='text/event-stream',
                             headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@app.post('/api/jobs/{job_id}/cancel')
async def cancel_job(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, 'unknown job')
    if job.task and not job.done:
        job.task.cancel()
    # Also stop the remote browsers so they do not keep running (and billing) after Stop.
    async with httpx.AsyncClient(timeout=15, headers={'X-API-Key': os.environ.get('TINYFISH_API_KEY', '')}) as http:
        for rid in job.run_ids:
            try:
                await http.post(f'https://agent.tinyfish.ai/v1/runs/{rid}/cancel')
            except httpx.HTTPError:
                pass
    return {'cancelled': len(job.run_ids)}


@app.get('/api/jobs')
async def list_jobs():
    return [{'id': j.id, 'kind': j.kind, 'label': j.label, 'done': j.done, 'started': j.started}
            for j in sorted(JOBS.values(), key=lambda j: -j.started)][:20]


@app.get('/api/config')
async def config():
    return {
        'portals': [{'key': k, **v} for k, v in PORTALS.items()],
        'states': STATES,
        'presets': PRESET_LOCALITIES,
        'watchlist': store.load_watchlist(),
        'has_key': bool(os.environ.get('TINYFISH_API_KEY')),
    }


@app.get('/api/localities')
async def localities():
    return store.latest_runs()


class ScanIn(BaseModel):
    name: str = Field(min_length=2)
    city: str = Field(min_length=2)
    state: str = 'Uttar Pradesh'
    portals: list[str] = [k for k, v in PORTALS.items() if v.get('default')]
    custom_urls: list[str] = []
    stealth: bool = False
    auto_circle: bool = True
    min_area: float | None = None
    max_area: float | None = None
    budget: float | None = None


@app.post('/api/scan')
async def scan(p: ScanIn):
    if not p.portals and not any(u.strip() for u in p.custom_urls):
        raise HTTPException(400, 'Pick at least one portal')
    filters = {'min_area': p.min_area, 'max_area': p.max_area, 'budget': p.budget}
    return start_job('scan', f'{p.name}, {p.city}', lambda emit: pipeline.scan(
        emit, name=p.name, city=p.city, state=p.state, portals=p.portals, custom_urls=p.custom_urls,
        stealth=p.stealth, auto_circle=p.auto_circle, filters=filters))


class ReraIn(BaseModel):
    project: str = Field(min_length=2)
    promoter: str = ''
    locality: str = ''
    state: str = 'Uttar Pradesh'
    stealth: bool = False


@app.post('/api/rera')
async def rera(p: ReraIn):
    url = STATES.get(p.state, {}).get('rera')
    if not url:
        raise HTTPException(400, f'No RERA portal configured for {p.state}')

    async def work(emit):
        emit({'type': 'job', 'phase': 'start', 'kind': 'rera', 'label': p.project,
              'agents': [{'id': 'rera', 'label': f'{p.state} RERA', 'url': url, 'role': 'rera'}]})
        res = await agents.run_agent(emit, 'rera', url=url, goal=agents.rera_goal(p.project, p.promoter, p.locality),
                                     schema=agents.RERA_SCHEMA, stealth=p.stealth, max_seconds=300)
        badge = ('could not check' if not res or res.get('could_not_check')
                 else 'verified' if res.get('found') else 'not found')
        emit({'type': 'rera', 'badge': badge, 'result': res, 'project': p.project, 'state': p.state})

    return start_job('rera', p.project, work)


class AuctionIn(BaseModel):
    state: str = 'Delhi'
    authority: str = ''
    url: str = ''
    place: str = ''
    stealth: bool = False


@app.post('/api/auctions')
async def auctions(p: AuctionIn):
    auths = STATES.get(p.state, {}).get('authorities', {})
    url = p.url.strip() or auths.get(p.authority)
    name = p.authority or url
    if not url:
        raise HTTPException(400, 'Pick an authority or give a URL')

    async def work(emit):
        emit({'type': 'job', 'phase': 'start', 'kind': 'auction', 'label': name,
              'agents': [{'id': 'auction', 'label': name, 'url': url, 'role': 'auction'}]})
        res = await agents.run_agent(emit, 'auction', url=url, goal=agents.auction_goal(name, p.place),
                                     schema=agents.AUCTION_SCHEMA, stealth=p.stealth)
        emit({'type': 'auctions', 'authority': name, 'url': url, 'schemes': (res or {}).get('schemes', []),
              'notes': (res or {}).get('notes'), 'ok': res is not None})

    return start_job('auction', name, work)


class CustomIn(BaseModel):
    url: str = Field(min_length=4)
    goal: str = Field(min_length=5)
    stealth: bool = False


@app.post('/api/agent')
async def custom_agent(p: CustomIn):
    url = p.url if p.url.startswith('http') else 'https://' + p.url

    async def work(emit):
        emit({'type': 'job', 'phase': 'start', 'kind': 'custom', 'label': p.goal[:60],
              'agents': [{'id': 'custom', 'label': url.split('/')[2], 'url': url, 'role': 'custom'}]})
        await agents.run_agent(emit, 'custom', url=url, goal=p.goal, stealth=p.stealth)

    return start_job('custom', p.goal[:60], work)


class CircleIn(BaseModel):
    locality: str
    city: str
    rate_inr: float = Field(gt=0)
    unit: str = Field(pattern='^per_(sqm|sqyd|sqft)$')
    category: str = 'residential'
    source_url: str = ''
    as_of: str = ''
    origin: str = 'manual'


@app.post('/api/circle-rate')
async def save_circle(p: CircleIn):
    clean.save_circle_rate(p.model_dump())
    updated = pipeline.resummarise(store.locality_id(p.locality, p.city))
    return {'saved': True, 'locality': updated}


class WatchIn(BaseModel):
    name: str
    city: str
    state: str
    on: bool = True


@app.post('/api/watch')
async def watch(p: WatchIn):
    return store.set_watch(p.model_dump(), p.on)


app.mount('/', StaticFiles(directory=WEB, html=True), name='web')

if __name__ == '__main__':
    import uvicorn
    uvicorn.run('server:app', host='127.0.0.1', port=int(os.environ.get('PORT', 8000)))
