"""Real-time event channel (Phase 17).

REST stays the way the UI fetches data. This channel only announces *events* —
a station's state changed, a GRAP escalation was recorded, the engine came up —
so the frontend can refresh immediately instead of waiting for its next poll.

The engine's observers write into plain dicts, so the broadcaster diffs a small
fingerprint of that state on a server-side tick and pushes only what changed.
"""

import asyncio
import contextlib
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from . import engine
from .serialization import engine_mode, to_jsonable

log = logging.getLogger("aree.ws")
router = APIRouter()

TICK_SECONDS = 2.0

# Fields whose change is worth waking the UI for.
_FINGERPRINT_FIELDS = (
    "aqi",
    "cpcb_band",
    "grap_stage",
    "consecutive_windows",
    "remaining_windows",
    "eri_score",
    "transport_score",
    "transport_label",
    "confidence_score",
    "ingestion_status",
    "firms_status",
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _fingerprint(state: Dict[str, Any]) -> tuple:
    return tuple(state.get(field) for field in _FINGERPRINT_FIELDS)


def _summary(station: str, state: Dict[str, Any]) -> Dict[str, Any]:
    try:
        cfg = engine.config()
        mode = engine_mode(
            state.get("aqi"), state.get("consecutive_windows"),
            cfg.HIGH_AQI_THRESHOLD, cfg.PERSISTENCE_THRESHOLD,
        )
    except Exception:  # noqa: BLE001
        mode = None

    return {
        "station": station,
        "aqi": state.get("aqi"),
        "cpcb_band": state.get("cpcb_band"),
        "grap_stage": state.get("grap_stage"),
        "consecutive_windows": state.get("consecutive_windows"),
        "remaining_windows": state.get("remaining_windows"),
        "eri_score": state.get("eri_score"),
        "eri_category": state.get("eri_category"),
        "transport_score": state.get("transport_score"),
        "transport_label": state.get("transport_label"),
        "confidence_score": state.get("confidence_score"),
        "ingestion_status": state.get("ingestion_status"),
        "engine_mode": mode,
    }


class ConnectionManager:
    """Tracks live sockets and runs one shared broadcaster task."""

    def __init__(self) -> None:
        self._connections: Set[WebSocket] = set()
        self._filters: Dict[WebSocket, Optional[str]] = {}
        self._lock = asyncio.Lock()
        self._task: Optional[asyncio.Task] = None
        self._fingerprints: Dict[str, tuple] = {}
        self._escalation_count = 0
        self._engine_loaded = False

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._connections.add(websocket)
            self._filters[websocket] = None
            if self._task is None or self._task.done():
                self._task = asyncio.create_task(self._broadcast_loop())

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._connections.discard(websocket)
            self._filters.pop(websocket, None)
            if not self._connections and self._task is not None:
                self._task.cancel()
                self._task = None

    async def set_filter(self, websocket: WebSocket, station: Optional[str]) -> None:
        async with self._lock:
            if websocket in self._filters:
                self._filters[websocket] = station

    async def send(self, websocket: WebSocket, message: Dict[str, Any]) -> None:
        try:
            await websocket.send_json(message)
        except Exception:  # noqa: BLE001 - the socket is gone; drop it
            await self.disconnect(websocket)

    async def broadcast(self, message: Dict[str, Any], station: Optional[str] = None) -> None:
        async with self._lock:
            targets = [
                ws
                for ws in self._connections
                # A socket filtered to one station only hears about that station;
                # global events (station=None) always go through.
                if station is None or self._filters.get(ws) in (None, station)
            ]

        for ws in targets:
            await self.send(ws, message)

    def snapshot(self) -> Dict[str, Any]:
        if not engine.is_loaded():
            st = engine.status()
            return {
                "type": "status",
                "server_time": _now(),
                "payload": {
                    "engine_loaded": False,
                    "engine_error": st.get("error"),
                    "stations": [],
                },
            }

        active = engine.active_states()
        return {
            "type": "snapshot",
            "server_time": _now(),
            "payload": {
                "engine_loaded": True,
                "engine_error": None,
                "stations": [_summary(name, state) for name, state in active.items()],
                "escalations_recorded": len(engine.escalation_log()),
            },
        }

    async def _broadcast_loop(self) -> None:
        log.info("WebSocket broadcaster started.")
        try:
            while True:
                await asyncio.sleep(TICK_SECONDS)
                try:
                    await self._tick()
                except Exception:  # noqa: BLE001 - never kill the loop
                    log.exception("WebSocket broadcast tick failed")
        except asyncio.CancelledError:
            log.info("WebSocket broadcaster stopped.")
            raise

    async def _tick(self) -> None:
        loaded = engine.is_loaded()

        if loaded != self._engine_loaded:
            self._engine_loaded = loaded
            await self.broadcast({
                "type": "status",
                "server_time": _now(),
                "payload": {
                    "engine_loaded": loaded,
                    "engine_error": engine.status().get("error"),
                },
            })
            if loaded:
                await self.broadcast(self.snapshot())

        if not loaded:
            return

        # Station state changes
        states = engine.active_states()
        for name, state in states.items():
            fingerprint = _fingerprint(state)
            if self._fingerprints.get(name) != fingerprint:
                self._fingerprints[name] = fingerprint
                await self.broadcast(
                    {
                        "type": "station_update",
                        "station": name,
                        "server_time": _now(),
                        "payload": _summary(name, state),
                    },
                    station=name,
                )

        # New escalation events (the log is append-left, newest first)
        events: List[Dict[str, Any]] = engine.escalation_log()
        if len(events) > self._escalation_count:
            fresh = events[: len(events) - self._escalation_count]
            self._escalation_count = len(events)
            for event in reversed(fresh):
                await self.broadcast({
                    "type": "escalation",
                    "station": event.get("city"),
                    "server_time": _now(),
                    "payload": to_jsonable(event),
                })


manager = ConnectionManager()


@router.websocket("/ws/live")
async def live_channel(websocket: WebSocket) -> None:
    """Live event channel.

    Client → server: {"action": "subscribe", "station": "<key>"} to scope
    station_update events, {"action": "subscribe"} (no station) for all,
    {"action": "snapshot"} to re-request the current state.
    """
    await manager.connect(websocket)
    await manager.send(websocket, manager.snapshot())

    try:
        while True:
            message = await websocket.receive_json()
            action = (message or {}).get("action")

            if action == "subscribe":
                await manager.set_filter(websocket, message.get("station") or None)
                await manager.send(websocket, {
                    "type": "status",
                    "server_time": _now(),
                    "payload": {"subscribed": message.get("station") or "all"},
                })
            elif action == "snapshot":
                await manager.send(websocket, manager.snapshot())
            elif action == "ping":
                await manager.send(websocket, {
                    "type": "status",
                    "server_time": _now(),
                    "payload": {"pong": True},
                })
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001 - malformed frame, treat as disconnect
        log.debug("WebSocket closed with an error", exc_info=True)
    finally:
        await manager.disconnect(websocket)
        with contextlib.suppress(Exception):
            await websocket.close()
