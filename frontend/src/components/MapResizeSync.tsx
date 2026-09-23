"use client";

/**
 * Keeps a Leaflet map in step with its own container.
 *
 * Leaflet measures its container ONCE, at initialisation, and caches the size. Every
 * later resize of that box — collapsing the sidebar, rotating a phone, crossing the
 * 1024px breakpoint where a three-column grid becomes one column — leaves the map
 * believing it is still the old size. What that looks like is a map drawn at the
 * wrong scale with grey bands where tiles were never requested, and markers that no
 * longer sit over the places they describe. A map that lies about where a monitor is
 * is worse than no map.
 *
 * `invalidateSize` is the fix Leaflet provides for exactly this; the observer is what
 * makes it automatic rather than something every caller has to remember.
 *
 * The call is deferred into a frame because a ResizeObserver callback that changes
 * layout synchronously re-enters the observer ("ResizeObserver loop completed with
 * undelivered notifications"), and because the sidebar animates its width over 200ms
 * — coalescing the burst into one resize per frame keeps that transition smooth.
 */

import { useEffect } from "react";
import { useMap } from "react-leaflet";

export default function MapResizeSync() {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();
    let frame = 0;

    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // The map can be torn down between the observation and the frame.
        if (!map.getContainer()?.isConnected) return;
        map.invalidateSize({ animate: false });
      });
    };

    const observer = new ResizeObserver(sync);
    observer.observe(container);

    /* iOS reports the new viewport a beat after orientationchange, and the container
       may not have changed size yet when the observer last fired. */
    window.addEventListener("orientationchange", sync);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("orientationchange", sync);
    };
  }, [map]);

  return null;
}
