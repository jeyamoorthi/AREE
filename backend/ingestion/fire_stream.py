import requests
import os
from datetime import datetime, timezone
from dotenv import load_dotenv

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
load_dotenv(os.path.join(_PROJECT_ROOT, ".env"))
load_dotenv()

FIRMS_API_KEY = os.getenv("FIRMS_API_KEY")

FIRMS_URL = (
    f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/"
    f"{FIRMS_API_KEY}/VIIRS_SNPP_NRT/"
    f"74.0,28.0,78.5,32.5/1"
)

def fetch_fire_count():
    try:
        response = requests.get(FIRMS_URL, timeout=15)

        if response.status_code != 200:
            print("FIRMS error:", response.status_code)
            return None

        lines = response.text.strip().split("\n")

        # First line is header
        fire_count = max(len(lines) - 1, 0)

        return {
            "timestamp": datetime.now(timezone.utc),
            "fire_count": fire_count
        }

    except Exception as e:
        print("Fire fetch error:", e)
        return None
