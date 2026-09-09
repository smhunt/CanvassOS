import maplibregl, { type GeoJSONSource, type LngLatBoundsLike, type MapGeoJSONFeature, type MapMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { FeatureCollection } from 'geojson';
import type { Meta, PointProps, PointsCollection } from '../api/types';
import type { BaseLayer, ColourMode } from './palette';
import { EMPTY_FC, applyTurfHighlight, buildStyle, clusterColourExpression, colourExpression, setBaseLayer } from './style';

export interface ViewportStats {
  doors: number;
  voters: number;
  zoom: number;
}

export interface MapViewHandle {
  /**
   * `padding` is the chrome covering the canvas — the door sheet, mostly. MapLibre centres within
   * the padded box, so passing it is what stops "Centre on map" putting the door underneath the
   * sheet that asked for it.
   */
  flyTo(lon: number, lat: number, zoom?: number, padding?: { top?: number; bottom?: number; left?: number; right?: number }): void;
  fitBounds(bounds: [number, number, number, number], padding?: number): void;
  getZoom(): number;
}

/**
 * One turf drawn over the municipality: the ids to keep bright, the points to ring, and the drawn
 * boundary. The boundary is what marks the turf at overview zoom — a per-door ring cannot, because
 * a village turf's doors are closer together on screen than the ring is wide (see turfStrokeWidth).
 */
export interface TurfHighlight {
  ids: string[];
  points: FeatureCollection;
  outline: FeatureCollection;
}

interface Props {
  points: PointsCollection | undefined;
  boundary: Meta['boundary'] | undefined;
  colourMode: ColourMode;
  communities: string[];
  base: BaseLayer;
  selectedId: string | null;
  /** A turf opened via /map?turf=<id>, or null for the normal map. */
  turfHighlight?: TurfHighlight | null;
  /** While true the map drops its own click handling: no selection, no cluster zoom, crosshair cursor. */
  drawing?: boolean;
  /**
   * Lawn signs and outstanding sign requests, drawn over the doors. Each feature carries `id` and
   * `kind` ('placed' | 'requested' | ...); clicking one calls onSelectSign instead of onSelect.
   */
  signs?: FeatureCollection | null;
  /** Every turf this user may see, as polygons carrying `name` and `mine`. Null hides the overlay. */
  turfShapes?: FeatureCollection | null;
  /** Id of the sign to ring, or null. */
  selectedSignId?: string | null;
  onSelectSign?: (id: string, lngLat: [number, number]) => void;
  onSelect: (props: PointProps, lngLat: [number, number]) => void;
  onViewport: (stats: ViewportStats) => void;
  /** Handed the live map once its style is parsed, and null when the map is torn down. */
  onMapReady?: (map: maplibregl.Map | null) => void;
}

/** Middlesex Centre, roughly centred; replaced by a fitBounds once the boundary arrives. */
const INITIAL_CENTER: [number, number] = [-81.39, 43.03];
const INITIAL_ZOOM = 10.2;
const CLICK_PAD = 10;

function polygonBounds(geom: NonNullable<Meta['boundary']>): LngLatBoundsLike | null {
  const rings = geom.type === 'Polygon' ? geom.coordinates : geom.coordinates.flat();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x === undefined || y === undefined) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

export const MapView = forwardRef<MapViewHandle, Props>(function MapView(
  {
    points,
    boundary,
    colourMode,
    communities,
    base,
    selectedId,
    turfHighlight = null,
    drawing = false,
    signs = null,
    turfShapes = null,
    selectedSignId = null,
    onSelect,
    onSelectSign,
    onViewport,
    onMapReady,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);
  const pointsRef = useRef<PointsCollection | undefined>(points);
  const onSelectRef = useRef(onSelect);
  const onViewportRef = useRef(onViewport);
  const fittedRef = useRef(false);
  const baseRef = useRef(base);
  const emitViewportRef = useRef<() => void>(() => undefined);
  const drawingRef = useRef(drawing);
  const onMapReadyRef = useRef(onMapReady);
  const onSelectSignRef = useRef(onSelectSign);
  pointsRef.current = points;
  onSelectRef.current = onSelect;
  onViewportRef.current = onViewport;
  drawingRef.current = drawing;
  onMapReadyRef.current = onMapReady;
  onSelectSignRef.current = onSelectSign;

  useImperativeHandle(ref, () => ({
    flyTo(lon, lat, zoom, padding) {
      const map = mapRef.current;
      if (!map) return;
      map.flyTo({
        center: [lon, lat],
        zoom: zoom ?? Math.max(map.getZoom(), 16),
        speed: 1.4,
        essential: true,
        // MapLibre's PaddingOptions wants all four sides, so the partial is filled in here rather
        // than at every call site.
        ...(padding ? { padding: { top: 0, bottom: 0, left: 0, right: 0, ...padding } } : {}),
      });
    },
    fitBounds(bounds, padding = 48) {
      const map = mapRef.current;
      if (!map) return;
      // Claim the one-time initial fit: the boundary can arrive after this and would otherwise
      // pull the view back out to the whole municipality a moment after we framed the turf.
      fittedRef.current = true;
      // `duration: 0` for the same reason the boundary fit uses it: an eased camera move is driven
      // by requestAnimationFrame, which does not run in a background tab (and stalls when every
      // tile request is failing) — a deep link would then land on the municipality view with the
      // move pending. This is the map's opening position, not a gesture, so it should not animate.
      map.fitBounds(bounds, { padding, maxZoom: 16.5, duration: 0 });
    },
    getZoom() {
      return mapRef.current?.getZoom() ?? INITIAL_ZOOM;
    },
  }));

  // ---- create the map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildStyle(baseRef.current),
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
      minZoom: 8,
      maxZoom: 19,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    map.addControl(new maplibregl.NavigationControl({ showCompass: false, visualizePitch: false }), 'bottom-right');
    map.addControl(
      new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false, showAccuracyCircle: true }),
      'bottom-right',
    );

    // Tile / glyph fetch failures are expected on weak signal; keep them out of the console.
    map.on('error', (e) => {
      const msg = (e as { error?: { message?: string } }).error?.message ?? '';
      const tileish = 'tile' in e || 'sourceId' in e || /tile|fetch|Failed to load|glyph|AJAXError|NetworkError/i.test(msg);
      if (!tileish) console.warn('map:', msg);
    });

    const emitViewport = () => {
      const data = pointsRef.current;
      const b = map.getBounds();
      let doors = 0;
      let voters = 0;
      if (data) {
        const w = b.getWest();
        const e = b.getEast();
        const s = b.getSouth();
        const n = b.getNorth();
        for (const f of data.features) {
          const [x, y] = f.geometry.coordinates;
          if (x !== undefined && y !== undefined && x >= w && x <= e && y >= s && y <= n) {
            doors++;
            voters += f.properties.n;
          }
        }
      }
      onViewportRef.current({ doors, voters, zoom: map.getZoom() });
    };
    map.on('moveend', emitViewport);
    // 'style.load' (not 'load'): with every tile request failing instantly (no signal, or this
    // sandbox), MapLibre never schedules the render frame that fires 'load', but the inline style —
    // and therefore our sources and layers — is ready as soon as the style is parsed.
    const markReady = () => {
      setReady(true);
      emitViewport();
      map.triggerRepaint();
      // Sources and layers can be added from here on, so anything drawing on top of us can start.
      onMapReadyRef.current?.(map);
    };
    map.once('style.load', markReady);
    map.once('load', markReady);
    emitViewportRef.current = emitViewport;

    const hit = (e: MapMouseEvent): MapGeoJSONFeature | null => {
      const feats = map.queryRenderedFeatures(
        [
          [e.point.x - CLICK_PAD, e.point.y - CLICK_PAD],
          [e.point.x + CLICK_PAD, e.point.y + CLICK_PAD],
        ],
        // 'sign-dots' first: a sign is drawn over the doors, so when both are under the finger the
        // sign is what the user aimed at. queryRenderedFeatures returns top-most first per layer,
        // but the order of `layers` is not a priority, so the pick below breaks the tie explicitly.
        { layers: ['sign-dots', 'points', 'clusters'] },
      );
      if (!feats.length) return null;
      let best: MapGeoJSONFeature | null = null;
      let bestD = Infinity;
      let bestIsSign = false;
      for (const f of feats) {
        if (f.geometry.type !== 'Point') continue;
        const isSign = f.layer.id === 'sign-dots';
        // A sign always beats a door, however far away; between two of a kind, nearest wins.
        if (bestIsSign && !isSign) continue;
        const p = map.project(f.geometry.coordinates as [number, number]);
        const d = (p.x - e.point.x) ** 2 + (p.y - e.point.y) ** 2;
        if ((isSign && !bestIsSign) || d < bestD) {
          bestD = d;
          best = f;
          bestIsSign = isSign;
        }
      }
      return best;
    };

    map.on('click', (e) => {
      // Drawing a turf owns the clicks; selecting a household mid-ring would be an accident.
      if (drawingRef.current) return;
      const f = hit(e);
      if (!f || f.geometry.type !== 'Point') return;
      const coords = f.geometry.coordinates as [number, number];
      const props = f.properties as Record<string, unknown>;
      if (f.layer.id === 'sign-dots') {
        onSelectSignRef.current?.(String(props.id), coords);
        return;
      }
      if (props.cluster) {
        const src = map.getSource('households') as GeoJSONSource | undefined;
        if (!src) return;
        void src
          .getClusterExpansionZoom(props.cluster_id as number)
          .then((z) => map.easeTo({ center: coords, zoom: Math.min(z + 0.3, 16), duration: 500 }))
          .catch(() => map.easeTo({ center: coords, zoom: map.getZoom() + 2, duration: 500 }));
        return;
      }
      onSelectRef.current(
        {
          id: String(props.id),
          ward: String(props.ward),
          community: (props.community as string | null) ?? null,
          n: Number(props.n ?? 0),
          inst: props.inst === true || props.inst === 'true',
          nonres: typeof props.nonres === 'number' ? props.nonres : undefined,
          q: props.q as PointProps['q'],
          status: (props.status as string | null | undefined) ?? null,
        },
        coords,
      );
    });
    map.on('mousemove', (e) => {
      if (drawingRef.current) return; // the crosshair is owned by the drawing effect below
      map.getCanvas().style.cursor = hit(e) ? 'pointer' : '';
    });

    mapRef.current = map;
    // Debug handle (used by the Playwright checks and handy in the field): window.__mcMap
    (window as unknown as { __mcMap?: maplibregl.Map }).__mcMap = map;
    return () => {
      onMapReadyRef.current?.(null);
      map.remove();
      mapRef.current = null;
      delete (window as unknown as { __mcMap?: maplibregl.Map }).__mcMap;
      setReady(false);
    };
  }, []);

  // ---- boundary
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('boundary') as GeoJSONSource | undefined;
    if (!src) return;
    if (boundary) {
      src.setData({ type: 'Feature', geometry: boundary, properties: {} });
      if (!fittedRef.current) {
        const b = polygonBounds(boundary);
        if (b) {
          fittedRef.current = true;
          map.fitBounds(b, { padding: 24, duration: 0 });
        }
      }
    } else {
      src.setData(EMPTY_FC);
    }
  }, [boundary, ready]);

  // ---- household points
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('households') as GeoJSONSource | undefined;
    if (!src) return;
    src.setData(points ?? EMPTY_FC);
    emitViewportRef.current();
  }, [points, ready]);

  // ---- colour mode
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !map.getLayer('points')) return;
    map.setPaintProperty('points', 'circle-color', colourExpression(colourMode, communities));
    map.setPaintProperty('clusters', 'circle-color', clusterColourExpression(colourMode));
  }, [colourMode, communities, ready]);

  // ---- base layer
  useEffect(() => {
    baseRef.current = base;
    const map = mapRef.current;
    if (!map || !ready) return;
    setBaseLayer(map, base);
  }, [base, ready]);

  // ---- draw mode: crosshair while it lasts, and the normal hover cursor back when it ends
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.getCanvas().style.cursor = drawing ? 'crosshair' : '';
  }, [drawing, ready]);

  // ---- turf highlight
  // Re-applied whenever the turf changes; colour-mode and base-layer changes write different paint
  // properties (colour, visibility), so neither of them can undo it and it needs no re-run here.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('turf') as GeoJSONSource | undefined;
    if (!src) return;
    src.setData(turfHighlight?.points ?? EMPTY_FC);
    const outline = map.getSource('turf-outline') as GeoJSONSource | undefined;
    outline?.setData(turfHighlight?.outline ?? EMPTY_FC);
    applyTurfHighlight(map, turfHighlight?.ids ?? null);
  }, [turfHighlight, ready]);

  // ---- lawn signs overlay
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('signs') as GeoJSONSource | undefined;
    src?.setData(signs ?? EMPTY_FC);
  }, [signs, ready]);

  // ---- turf overlay
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('turf-shapes') as GeoJSONSource | undefined;
    src?.setData(turfShapes ?? EMPTY_FC);
  }, [turfShapes, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !map.getLayer('sign-selected')) return;
    map.setFilter('sign-selected', ['==', ['get', 'id'], selectedSignId ?? '']);
  }, [selectedSignId, ready]);

  // ---- selection ring
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !map.getLayer('selected')) return;
    map.setFilter('selected', ['all', ['!', ['has', 'point_count']], ['==', ['get', 'id'], selectedId ?? '']]);
  }, [selectedId, ready]);

  return <div ref={containerRef} className="map-canvas" role="application" aria-label="Household map" />;
});
