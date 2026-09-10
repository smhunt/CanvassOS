import type { FeatureCollection, Polygon } from 'geojson';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { EMPTY_FILTERS, useMeta, usePoints, useTurfDoorsForMap, useTurfShapes, type PointFilters } from '../api/hooks';
import type { PointProps } from '../api/types';
import { isOrganizer } from '../auth';
import { useUser } from '../components/Shell';
import { ErrorBox, Spinner, n } from '../components/ui';
import { DrawPolygon } from '../map/DrawPolygon';
import { FiltersDrawer, countActive } from '../map/FiltersDrawer';
import { HouseholdCard, type Selection } from '../map/HouseholdCard';
import { LegalList } from '../map/LegalList';
import { Legend } from '../map/Legend';
import { MapView, type MapViewHandle, type TurfHighlight, type ViewportStats } from '../map/MapView';
import { BASE_LAYERS, COLOUR_MODES, type BaseLayer, type ColourMode } from '../map/palette';
import { SearchBox, type SearchPick } from '../map/SearchBox';
import { TurfBanner } from '../map/TurfBanner';

const LS_BASE = 'mc.map.base';
const LS_MODE = 'mc.map.mode';
const LS_TURFS = 'mc.map.turfs';

function readLS<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeLS(key: string, v: string): void {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* private mode etc. */
  }
}

export function MapPage() {
  const user = useUser();
  const organizer = isOrganizer(user);
  const meta = useMeta();
  const [filters, setFilters] = useState<PointFilters>(EMPTY_FILTERS);
  const points = usePoints(filters);
  const mapRef = useRef<MapViewHandle>(null);

  const modes = useMemo(() => COLOUR_MODES.filter((m) => organizer || !m.organizerOnly), [organizer]);
  const [mode, setMode] = useState<ColourMode>(() =>
    readLS(
      LS_MODE,
      modes.map((m) => m.id),
      'ward',
    ),
  );
  // 'streets' (OSM), not 'light': CARTO's basemap CDN now watermarks every tile with
  // "API KEY REQUIRED" for anonymous use. OSM and the Esri satellite layers need no key.
  const [base, setBase] = useState<BaseLayer>(() =>
    readLS(
      LS_BASE,
      BASE_LAYERS.map((b) => b.id),
      'streets',
    ),
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [legalOpen, setLegalOpen] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  // On a phone the search field is a whole row of a screen whose job is the map, and it is used
  // occasionally rather than constantly — so it collapses to an icon and expands over the toolbar.
  // At tablet width and up there is room for both and this state is ignored (see styles.css).
  const [searchOpen, setSearchOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(() => (typeof window !== 'undefined' ? window.matchMedia('(min-width: 720px)').matches : true));
  const [selection, setSelection] = useState<Selection | null>(null);

  // `/map?household=H-KOMOKA-00123` opens straight onto a door, so anything holding a household id
  // — the follow-up queue, a turf door list, a link pasted into Signal — can point at it directly.
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkId = searchParams.get('household');
  const [viewport, setViewport] = useState<ViewportStats>({ doors: 0, voters: 0, zoom: 10 });
  // The turf drawer needs the live map to add its own layers, so MapView hands it over once ready.
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [drawing, setDrawing] = useState(false);
  const layersRef = useRef<HTMLDivElement>(null);

  useEffect(() => writeLS(LS_MODE, mode), [mode]);
  useEffect(() => writeLS(LS_BASE, base), [base]);

  useEffect(() => {
    if (!layersOpen) return;
    const onDown = (e: MouseEvent) => {
      if (layersRef.current && !layersRef.current.contains(e.target as Node)) setLayersOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLayersOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [layersOpen]);

  const communities = useMemo(() => meta.data?.communities.map((c) => c.community) ?? [], [meta.data]);
  const wards = useMemo(() => meta.data?.wards.map((w) => w.ward) ?? [], [meta.data]);

  // id → [lon, lat] for search results and "centre on map"
  const coordIndex = useMemo(() => {
    const m = new Map<string, [number, number]>();
    for (const f of points.data?.features ?? []) {
      const [x, y] = f.geometry.coordinates;
      if (x !== undefined && y !== undefined) m.set(f.properties.id, [x, y]);
    }
    return m;
  }, [points.data]);

  const onSelectPoint = useCallback((props: PointProps) => {
    setSelection({ id: props.id, props });
  }, []);
  const closeCard = useCallback(() => setSelection(null), []);
  const closeFilters = useCallback(() => setFiltersOpen(false), []);
  const closeLegal = useCallback(() => setLegalOpen(false), []);
  const onViewport = useCallback((s: ViewportStats) => setViewport(s), []);
  const onMapReady = useCallback((m: MapLibreMap | null) => setMap(m), []);
  const onDrawActive = useCallback((a: boolean) => {
    setDrawing(a);
    // A household card open over the map would swallow the first corners.
    if (a) setSelection(null);
  }, []);

  /**
   * Centre a door, in the part of the map that is actually visible.
   *
   * The door sheet covers the bottom ~60% of a phone screen (and the right edge on a desktop), so
   * centring on the whole canvas put the door under the very panel that asked for it. The sheet is
   * measured at call time rather than derived from a breakpoint, because it is the same element at
   * a different edge depending on width and its height depends on its content.
   */
  const flyTo = useCallback((lon: number, lat: number) => {
    const canvas = mapRef.current ? document.querySelector('.map-canvas') : null;
    const sheet = document.querySelector('.sheet');
    let padding: { top?: number; bottom?: number; left?: number; right?: number } | undefined;
    if (canvas && sheet) {
      const c = canvas.getBoundingClientRect();
      const s = sheet.getBoundingClientRect();
      // Whichever edge it is anchored to. A 24px breathing gap keeps the pin off the sheet's edge,
      // and the cap stops a tall sheet on a short screen asking for more padding than there is map.
      const cap = (v: number, axis: number) => Math.max(0, Math.min(v, axis * 0.6));
      padding =
        s.top - c.top > c.height * 0.25
          ? { bottom: cap(c.bottom - s.top + 24, c.height) }
          : { right: cap(c.right - s.left + 24, c.width) };
    }
    mapRef.current?.flyTo(lon, lat, 16.5, padding);
  }, []);

  const onSearchPick = useCallback(
    (pick: SearchPick) => {
      const c = coordIndex.get(pick.householdId);
      if (c) flyTo(c[0], c[1]);
      setSelection({ id: pick.householdId });
    },
    [coordIndex, flyTo],
  );

  // Consume the parameter once the points are loaded (we need them to fly to the door), then strip
  // it from the URL so a later manual selection does not get re-overridden on the next render.
  const deepLinkDone = useRef<string | null>(null);
  useEffect(() => {
    if (!deepLinkId || deepLinkDone.current === deepLinkId || !points.data) return;
    deepLinkDone.current = deepLinkId;
    setSelection({ id: deepLinkId });
    const c = coordIndex.get(deepLinkId);
    if (c) flyTo(c[0], c[1]);
    const next = new URLSearchParams(searchParams);
    next.delete('household');
    setSearchParams(next, { replace: true });
  }, [deepLinkId, points.data, coordIndex, flyTo, searchParams, setSearchParams]);

  // `/map?turf=<uuid>` opens the map on one turf: its doors ringed, everything else faded, and a
  // banner naming it. Consumed exactly like ?household above — once, then stripped with a replace,
  // so dismissing the banner (or picking another door) is not undone on the next render.
  const turfParam = searchParams.get('turf');
  const [turfId, setTurfId] = useState<string | null>(null);
  const turfLinkDone = useRef<string | null>(null);
  useEffect(() => {
    if (!turfParam || turfLinkDone.current === turfParam) return;
    turfLinkDone.current = turfParam;
    setTurfId(turfParam);
    const next = new URLSearchParams(searchParams);
    next.delete('turf');
    setSearchParams(next, { replace: true });
  }, [turfParam, searchParams, setSearchParams]);

  // The turf overlay. A preference, remembered, and off by default: the map's first job is the
  // doors, and forty boundaries over them is a choice rather than a default.
  const [turfsOn, setTurfsOn] = useState(() => readLS(LS_TURFS, ['on', 'off'] as const, 'off') === 'on');
  const toggleTurfs = useCallback(() => {
    setTurfsOn((on) => {
      writeLS(LS_TURFS, on ? 'off' : 'on');
      return !on;
    });
  }, []);
  // `enabled` gates the fetch, so a volunteer who never turns it on never asks for it.
  const turfShapesQ = useTurfShapes(turfsOn);
  const turfShapes = useMemo<FeatureCollection | null>(() => {
    if (!turfsOn) return null;
    const rows = turfShapesQ.data ?? [];
    return {
      type: 'FeatureCollection',
      // A street-picked turf has no drawn shape; it is counted below rather than silently missing.
      features: rows
        .filter((t) => t.polygon)
        .map((t) => ({
          type: 'Feature',
          geometry: t.polygon as Polygon,
          properties: { id: t.id, name: t.name, mine: t.mine, approx: t.approx },
        })),
    };
  }, [turfsOn, turfShapesQ.data]);
  const turfsApprox = (turfShapesQ.data ?? []).filter((t) => t.approx).length;
  const turfsWithoutShape = (turfShapesQ.data ?? []).filter((t) => !t.polygon).length;

  const turfDoors = useTurfDoorsForMap(turfId);

  // The rings come off the turf's own doors rather than off `points`, so an active filter (or a
  // door the filter excluded) cannot quietly shrink the turf the organizer was sent to look at.
  const turf = useMemo(() => {
    const data = turfDoors.data;
    if (!turfId || !data) return null;
    const ids: string[] = [];
    const features: PointFeature[] = [];
    for (const d of data.doors) {
      ids.push(d.household_id);
      if (d.lat === null || d.lon === null) continue; // legal description: counted, never drawn
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [d.lon, d.lat] },
        // `n` only: it is what the ring's radius is scaled by, so the ring matches the dot's size.
        properties: { n: d.n_voters },
      });
    }
    // A street-picked turf has no drawn boundary; the outline layers just stay empty for it.
    const poly = data.turf.polygon;
    const outline: TurfHighlight['outline'] = {
      type: 'FeatureCollection',
      features: poly ? [{ type: 'Feature', geometry: poly, properties: {} }] : [],
    };
    return {
      name: data.turf.name,
      doors: data.doors.length,
      unmapped: data.doors.length - features.length,
      highlight: { ids, points: { type: 'FeatureCollection', features }, outline } satisfies TurfHighlight,
    };
  }, [turfId, turfDoors.data]);

  // Frame the turf once, as soon as both its doors and the map exist — but once *per map*, not
  // just per turf: a MapView that is torn down and rebuilt (StrictMode does exactly this in dev)
  // comes back on the municipality's default view, and a turf link that lands there unframed is
  // the whole feature failing quietly.
  const turfFitted = useRef<{ map: MapLibreMap; turfId: string } | null>(null);
  useEffect(() => {
    if (!turfId || !turf || !map) return;
    if (turfFitted.current?.map === map && turfFitted.current.turfId === turfId) return;
    const b = featureBounds(turf.highlight.points.features);
    if (!b) return; // every door is a legal description: nothing to frame, the banner says so
    turfFitted.current = { map, turfId };
    mapRef.current?.fitBounds(b, 56);
  }, [turfId, turf, map]);

  const clearTurf = useCallback(() => {
    setTurfId(null);
    turfFitted.current = null;
  }, []);

  const onLegalPick = useCallback((id: string) => {
    setLegalOpen(false);
    setSelection({ id });
  }, []);

  const active = countActive(filters);
  // Legal-description households have no point: imported total − mapped points (only meaningful unfiltered).
  const legalCount =
    meta.data?.import && points.data && active === 0 ? meta.data.import.n_households - points.data.features.length : null;
  const totalDoors = points.data?.features.length ?? 0;
  const totalVoters = useMemo(() => (points.data?.features ?? []).reduce((s, f) => s + f.properties.n, 0), [points.data]);

  return (
    <div className={`map-page${selection ? ' map-page--card' : ''}`}>
      {/* Toolbar precedes the canvas in DOM order so keyboard users reach it before panning controls. */}
      <div className="map-toolbar">
        <button
          type="button"
          className={`btn btn--map${active ? ' btn--map-active' : ''}`}
          onClick={() => setFiltersOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={filtersOpen}
          aria-label={active ? `Filters (${active} active)` : 'Filters'}
        >
          <FilterIcon />
          <span>Filters</span>
          {active > 0 && <span className="badge">{active}</span>}
        </button>
        {organizer && (
          <>
            <button
              type="button"
              className="btn btn--map map-searchbtn"
              onClick={() => setSearchOpen((o) => !o)}
              aria-expanded={searchOpen}
              aria-label="Search voters and addresses"
            >
              <SearchIcon />
            </button>
            <div className={`search-slot${searchOpen ? ' search-slot--open' : ''}`}>
              <SearchBox onPick={onSearchPick} />
              <button
                type="button"
                className="btn btn--icon search-slot__close"
                onClick={() => setSearchOpen(false)}
                aria-label="Close search"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <line x1="5" y1="5" x2="19" y2="19" />
                  <line x1="19" y1="5" x2="5" y2="19" />
                </svg>
              </button>
            </div>
          </>
        )}
        <label className="select-pill">
          <span className="visually-hidden">Colour by</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as ColourMode)} aria-label="Colour households by">
            {modes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <div className="layers" ref={layersRef}>
          <button
            type="button"
            className="btn btn--map"
            onClick={() => setLayersOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={layersOpen}
            aria-label={`Base layer: ${BASE_LAYERS.find((b) => b.id === base)?.label ?? base}`}
          >
            <LayersIcon />
            <span className="layers__label">{BASE_LAYERS.find((b) => b.id === base)?.label}</span>
          </button>
          {layersOpen && (
            <div className="card menu menu--layers" role="menu" aria-label="Base layer">
              {BASE_LAYERS.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={base === b.id}
                  className={`menu__item${base === b.id ? ' menu__item--active' : ''}`}
                  onClick={() => {
                    setBase(b.id);
                    setLayersOpen(false);
                  }}
                >
                  {b.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          className={`btn btn--map${turfsOn ? ' btn--map-active' : ''}`}
          onClick={toggleTurfs}
          aria-pressed={turfsOn}
          aria-label={organizer ? 'Show turf boundaries' : 'Show my turf boundaries'}
          title={organizer ? 'Show turf boundaries' : 'Show my turf boundaries'}
        >
          <TurfIcon />
          {/* "Boundaries", not "Turfs": the nav already has a Turfs page, and a button that meant
              something else was the reason the map felt like a dead end. */}
          <span>Boundaries</span>
        </button>
        {organizer && map && (
          <DrawPolygon map={map} points={points.data} wards={wards} filtersActive={active > 0} onActiveChange={onDrawActive} />
        )}
      </div>

      <MapView
        ref={mapRef}
        points={points.data}
        boundary={meta.data?.boundary}
        colourMode={mode}
        communities={communities}
        base={base}
        selectedId={selection?.id ?? null}
        turfHighlight={turf?.highlight ?? null}
        turfShapes={turfShapes}
        onSelectTurfShape={(id) => setTurfId(id)}
        drawing={drawing}
        onSelect={onSelectPoint}
        onViewport={onViewport}
        onMapReady={onMapReady}
      />

      <div className="map-bottomleft">
        {/* A dotted shape is a hull round the doors, not a boundary anyone drew, and it can cover
            doors that are not in the turf. The map says so in words as well as in the dash — this
            is the difference between "roughly here" and "these doors". */}
        {turfsOn && turfsApprox > 0 && (
          <div className="pill" role="status">
            {n(turfsApprox)} dotted {turfsApprox === 1 ? 'outline is' : 'outlines are'} approximate — drawn around the
            doors of a turf built from streets, so {turfsApprox === 1 ? 'it' : 'they'} may cover doors that are not in
            it
          </div>
        )}
        {turfsOn && turfsWithoutShape > 0 && (
          <div className="pill" role="status">
            {n(turfsWithoutShape)} {turfsWithoutShape === 1 ? 'turf has' : 'turfs have'} no mapped doors, so{' '}
            {turfsWithoutShape === 1 ? 'it cannot' : 'they cannot'} be outlined at all
          </div>
        )}
        <div className="pill pill--counts" aria-live="polite">
          {points.isPending ? (
            <>
              <Spinner size={14} /> Loading households…
            </>
          ) : points.isError ? (
            <span className="pill__error">Households failed to load</span>
          ) : (
            <>
              <strong>{n(viewport.doors)}</strong> doors · <strong>{n(viewport.voters)}</strong> voters in view
              {active > 0 && (
                <span className="muted">
                  {' '}
                  · {n(totalDoors)} / {n(totalVoters)} match filters
                </span>
              )}
              {points.isFetching && <Spinner size={12} />}
            </>
          )}
        </div>
        <div className={`legend-wrap card${legendOpen ? '' : ' legend-wrap--closed'}`}>
          <button type="button" className="legend-wrap__toggle" onClick={() => setLegendOpen((o) => !o)} aria-expanded={legendOpen}>
            <span>Legend — {modes.find((m) => m.id === mode)?.label}</span>
            <Chevron up={legendOpen} />
          </button>
          {legendOpen && (
            <>
              <Legend mode={mode} meta={meta.data} zoom={viewport.zoom} />
              {organizer && (
                <button type="button" className="linkbtn legend-wrap__legal" onClick={() => setLegalOpen(true)}>
                  {legalCount !== null && legalCount > 0 ? `${n(legalCount)} unmapped parcels` : 'Unmapped parcels'} (legal descriptions)
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {turfId && (
        <TurfBanner
          name={turf?.name ?? null}
          doors={turf?.doors ?? 0}
          unmapped={turf?.unmapped ?? 0}
          loading={turfDoors.isPending}
          error={turfDoors.isError ? turfDoors.error : null}
          onDismiss={clearTurf}
        />
      )}

      {points.isError && (
        <div className="map-error" style={turfId ? { marginTop: 56 } : undefined}>
          <ErrorBox title="Could not load households" error={points.error} onRetry={() => void points.refetch()} compact />
        </div>
      )}
      {meta.isError && !points.isError && (
        <div className="map-error" style={turfId ? { marginTop: 56 } : undefined}>
          <ErrorBox title="Could not load wards and communities" error={meta.error} onRetry={() => void meta.refetch()} compact />
        </div>
      )}

      <FiltersDrawer open={filtersOpen} onClose={closeFilters} meta={meta.data} filters={filters} onChange={setFilters} organizer={organizer} />
      {selection && <HouseholdCard selection={selection} user={user} onClose={closeCard} onFly={flyTo} />}
      {organizer && <LegalList open={legalOpen} onClose={closeLegal} meta={meta.data} onPick={onLegalPick} />}
    </div>
  );
}

type PointFeature = TurfHighlight['points']['features'][number];

/** Bounding box of the turf's doors, or null when it has none to draw. */
function featureBounds(features: PointFeature[]): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const f of features) {
    if (f.geometry.type !== 'Point') continue;
    const [x, y] = f.geometry.coordinates;
    if (x === undefined || y === undefined) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  // A one-door turf is a valid, degenerate box; fitBounds' maxZoom keeps it from zooming to infinity.
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

function FilterIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="3 5 21 5 14 13 14 20 10 20 10 13 3 5" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <line x1="16.5" y1="16.5" x2="21" y2="21" />
    </svg>
  );
}

/** A turf: a drawn boundary with doors inside it. */
function TurfIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7l6-3 6 3 6-3v13l-6 3-6-3-6 3z" />
      <path d="M9 4v13M15 7v13" />
    </svg>
  );
}

function LayersIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="12 3 21 8 12 13 3 8 12 3" />
      <polyline points="3 12 12 17 21 12" />
      <polyline points="3 16 12 21 21 16" />
    </svg>
  );
}

function Chevron({ up }: { up: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {up ? <polyline points="6 15 12 9 18 15" /> : <polyline points="6 9 12 15 18 9" />}
    </svg>
  );
}
