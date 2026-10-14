"""Phase 0 check: confirms the API key works and shows the streaming event flow.

    python smoke_test.py
"""
import json
import time

from dotenv import load_dotenv
from tinyfish import TinyFish

load_dotenv()
client = TinyFish()

SCHEMA = {
    'type': 'object',
    'properties': {'headlines': {'type': 'array', 'items': {'type': 'string'}, 'maxItems': 3}},
    'required': ['headlines'],
}

t0 = time.time()
with client.agent.stream(
    url='https://news.ycombinator.com',
    goal='Return the titles of the top 3 stories as JSON with key headlines.',
    output_schema=SCHEMA,
) as stream:
    for ev in stream:
        data = ev.model_dump(mode='json', by_alias=True)
        print(f'{time.time() - t0:6.1f}s', json.dumps(data)[:300])
