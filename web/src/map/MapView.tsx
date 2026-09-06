import maplibregl, { type GeoJSONSource, type LngLatBoundsLike, type MapGeoJSONFeature, type MapMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Meta, PointProps, PointsCollection } from '../api/types';
import type { BaseLayer, ColourMode } from './palette';
import { EMPTY_FC, buildStyle, clusterColourExpression, colourExpression, setBaseLayer } from './style';

export interface ViewportStats {
  doors: number;
  voters: number;
  zoom: number;
}

export interface MapViewHandle {
  flyTo(lon: number, lat: number, zoom?: number): void;
  getZoom(): number;
}

interface Props {
  points: PointsCollection | undefined;
  boundary: Meta['boundary'] | undefined;
  colourMode: ColourMode;
  communities: string[];
  base: BaseLayer;
  selectedId: string | null;
  onSelect: (props: PointProps, lngLat: [number, number]) => void;
  onViewport: (stats: ViewportStats) => void;
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
  { points, boundary, colourMode, communities, base, selectedId, onSelect, onViewport },
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
  pointsRef.current = points;
  onSelectRef.current = onSelect;
  onViewportRef.current = onViewport;

  useImperativeHandle(ref, () => ({
    flyTo(lon, lat, zoom) {
      const map = mapRef.current;
      if (!map) return;
      map.flyTo({ center: [lon, lat], zoom: zoom ?? Math.max(map.getZoom(), 16), speed: 1.4, essential: true });
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
        { layers: ['points', 'clusters'] },
      );
      if (!feats.length) return null;
      let best: MapGeoJSONFeature | null = null;
      let bestD = Infinity;
      for (const f of feats) {
        if (f.geometry.type !== 'Point') continue;
        const p = map.project(f.geometry.coordinates as [number, number]);
        const d = (p.x - e.point.x) ** 2 + (p.y - e.point.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = f;
        }
      }
      return best;
    };

    map.on('click', (e) => {
      const f = hit(e);
      if (!f || f.geometry.type !== 'Point') return;
      const coords = f.geometry.coordinates as [number, number];
      const props = f.properties as Record<string, unknown>;
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
      map.getCanvas().style.cursor = hit(e) ? 'pointer' : '';
    });

    mapRef.current = map;
    // Debug handle (used by the Playwright checks and handy in the field): window.__mcMap
    (window as unknown as { __mcMap?: maplibregl.Map }).__mcMap = map;
    return () => {
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

  // ---- selection ring
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !map.getLayer('selected')) return;
    map.setFilter('selected', ['all', ['!', ['has', 'point_count']], ['==', ['get', 'id'], selectedId ?? '']]);
  }, [selectedId, ready]);

  return <div ref={containerRef} className="map-canvas" role="application" aria-label="Household map" />;
});
