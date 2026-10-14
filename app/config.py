import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / 'data'
WEB = ROOT / 'web'

# Listing portals the agent can search. Users can also add any other portal URL from the UI.
PORTALS = {
    '99acres': {'label': '99acres', 'url': 'https://www.99acres.com', 'default': True},
    'magicbricks': {'label': 'MagicBricks', 'url': 'https://www.magicbricks.com', 'default': True},
    # In testing Housing.com showed a 'Request Blocked' page in both lite and stealth mode.
    'housing': {'label': 'Housing.com', 'url': 'https://housing.com', 'default': False, 'note': 'often blocks bots'},
}

# Per-state starting points for the RERA check and the government land auction tracker.
STATES = {
    'Uttar Pradesh': {
        'rera': 'https://www.up-rera.in/projects',
        'authorities': {
            'Noida Authority': 'https://noidaauthorityonline.in',
            'Greater Noida Authority (GNIDA)': 'https://www.greaternoidaauthority.in',
            'Yamuna Expressway Authority (YEIDA)': 'https://yamunaexpresswayauthority.com',
        },
    },
    'Haryana': {
        'rera': 'https://haryanarera.gov.in',
        'authorities': {
            'HSVP (Haryana Shehri Vikas Pradhikaran)': 'https://hsvphry.org.in',
        },
    },
    'Delhi': {
        'rera': 'https://rera.delhi.gov.in',
        'authorities': {
            'DDA (Delhi Development Authority)': 'https://dda.gov.in',
        },
    },
}

PRESET_LOCALITIES = [
    {'name': 'Sector 150', 'city': 'Noida', 'state': 'Uttar Pradesh'},
    {'name': 'Sector 82', 'city': 'Gurugram', 'state': 'Haryana'},
    {'name': 'Greater Noida West', 'city': 'Greater Noida', 'state': 'Uttar Pradesh'},
]

MAX_LISTINGS_PER_PORTAL = 12
AGENT_MAX_SECONDS = 480
UA = {'User-Agent': 'plot-map-workshop/0.1 (TinyFish x DTU student project)'}


def slug(text):
    return '-'.join(''.join(c if c.isalnum() else ' ' for c in text.lower()).split())
