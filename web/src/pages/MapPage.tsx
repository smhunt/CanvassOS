import type { Map as MapLibreMap } from 'maplibre-gl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EMPTY_FILTERS, useMeta, usePoints, type PointFilters } from '../api/hooks';
import type { PointProps } from '../api/types';
import { isOrganizer } from '../auth';
import { useUser } from '../components/Shell';
import { ErrorBox, Spinner, n } from '../components/ui';
import { DrawPolygon } from '../map/DrawPolygon';
import { FiltersDrawer, countActive } from '../map/FiltersDrawer';
import { HouseholdCard, type Selection } from '../map/HouseholdCard';
import { LegalList } from '../map/LegalList';
import { Legend } from '../map/Legend';
import { MapView, type MapViewHandle, type ViewportStats } from '../map/MapView';
import { BASE_LAYERS, COLOUR_MODES, type BaseLayer, type ColourMode } from '../map/palette';
import { SearchBox, type SearchPick } from '../map/SearchBox';

const LS_BASE = 'mc.map.base';
const LS_MODE = 'mc.map.mode';

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
  const [legendOpen, setLegendOpen] = useState(() => (typeof window !== 'undefined' ? window.matchMedia('(min-width: 720px)').matches : true));
  const [selection, setSelection] = useState<Selection | null>(null);
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

  const flyTo = useCallback((lon: number, lat: number) => {
    mapRef.current?.flyTo(lon, lat, 16.5);
  }, []);

  const onSearchPick = useCallback(
    (pick: SearchPick) => {
      const c = coordIndex.get(pick.householdId);
      if (c) flyTo(c[0], c[1]);
      setSelection({ id: pick.householdId });
    },
    [coordIndex, flyTo],
  );

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
        {organizer && <SearchBox onPick={onSearchPick} />}
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
        drawing={drawing}
        onSelect={onSelectPoint}
        onViewport={onViewport}
        onMapReady={onMapReady}
      />

      <div className="map-bottomleft">
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

      {points.isError && (
        <div className="map-error">
          <ErrorBox title="Could not load households" error={points.error} onRetry={() => void points.refetch()} compact />
        </div>
      )}
      {meta.isError && !points.isError && (
        <div className="map-error">
          <ErrorBox title="Could not load wards and communities" error={meta.error} onRetry={() => void meta.refetch()} compact />
        </div>
      )}

      <FiltersDrawer open={filtersOpen} onClose={closeFilters} meta={meta.data} filters={filters} onChange={setFilters} organizer={organizer} />
      {selection && <HouseholdCard selection={selection} user={user} onClose={closeCard} onFly={flyTo} />}
      {organizer && <LegalList open={legalOpen} onClose={closeLegal} meta={meta.data} onPick={onLegalPick} />}
    </div>
  );
}

function FilterIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="3 5 21 5 14 13 14 20 10 20 10 13 3 5" />
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
