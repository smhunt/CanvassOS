/*
 * The hero picture: a rural turf being walked. A concession road and a sideroad with houses along
 * both, and a route that marks each door as it passes: knocked, a supporter, a lawn sign placed.
 * Plays once on load; with reduced motion it simply shows the finished turf. Invented geometry,
 * no real addresses.
 */

type Door = {
  x: number;
  y: number;
  at: number;
  state: 'knocked' | 'support' | 'sign' | 'none';
};

const ROUTE_MS = 6500;
// The route: east along the concession road, then south down the sideroad.
const ROAD_Y = 150;
const SIDE_X = 452;
const START_X = 36;
const END_Y = 420;
const LENGTH = SIDE_X - START_X + (END_Y - ROAD_Y);

// A fixed pattern, so the picture is the same on every load.
const PATTERN: Door['state'][] = ['knocked', 'support', 'knocked', 'none', 'sign', 'knocked', 'support', 'knocked'];

function doors(): Door[] {
  const out: Door[] = [];
  let i = 0;
  for (let x = 56; x < SIDE_X - 20; x += 44) {
    const north = i % 2 === 0;
    out.push({
      x,
      y: north ? ROAD_Y - 26 : ROAD_Y + 14,
      at: (x - START_X) / LENGTH,
      state: PATTERN[i % PATTERN.length],
    });
    i++;
  }
  for (let y = ROAD_Y + 40; y < END_Y - 10; y += 46) {
    const west = i % 2 === 0;
    out.push({
      x: west ? SIDE_X - 28 : SIDE_X + 14,
      y,
      at: (SIDE_X - START_X + (y - ROAD_Y)) / LENGTH,
      state: PATTERN[i % PATTERN.length],
    });
    i++;
  }
  return out;
}

const DOORS = doors();
// Houses on the next concession, not on today's route: they stay unknocked.
const LATER = [80, 150, 230, 300, 520, 580].map((x, j) => ({
  x,
  y: j % 2 ? 452 : 412,
}));

export function TurfHero() {
  return (
    <svg
      className="turf-hero"
      viewBox="0 0 640 480"
      role="img"
      aria-label="A rural turf: a concession road and a sideroad with houses along them, and a canvassing route marking doors as knocked, supporters and lawn signs."
    >
      {/* Lot lines: the survey grid every Ontario township is laid out on. */}
      <g className="turf-hero__lots">
        {[100, 200, 300, 400, 500, 600].map((x) => (
          <line key={`v${x}`} x1={x} y1={0} x2={x} y2={480} />
        ))}
        {[60, 250, 330].map((y) => (
          <line key={`h${y}`} x1={0} y1={y} x2={640} y2={y} />
        ))}
      </g>

      {/* The turf boundary. */}
      <path className="turf-hero__turf" d="M18 96 H500 V450 H400 V196 H18 Z" />

      {/* Roads. */}
      <g className="turf-hero__roads">
        <line x1={0} y1={ROAD_Y} x2={640} y2={ROAD_Y} />
        <line x1={SIDE_X} y1={0} x2={SIDE_X} y2={480} />
        <line x1={0} y1={432} x2={640} y2={432} />
      </g>
      <text className="turf-hero__road-name" x={560} y={ROAD_Y - 8}>
        Concession 6
      </text>
      <text className="turf-hero__road-name" x={SIDE_X + 10} y={36} transform={`rotate(90 ${SIDE_X + 10} 36)`}>
        Sideroad 15
      </text>

      {LATER.map((h) => (
        <rect key={`l${h.x}`} className="turf-hero__house" x={h.x} y={h.y} width={14} height={12} rx={2} />
      ))}

      {/* The route walked so far. */}
      <path
        className="turf-hero__route"
        d={`M${START_X} ${ROAD_Y} H${SIDE_X} V${END_Y}`}
        pathLength={1}
        style={{ animationDuration: `${ROUTE_MS}ms` }}
      />

      {DOORS.map((d) => (
        <g
          key={`${d.x}-${d.y}`}
          className={`turf-hero__door turf-hero__door--${d.state}`}
          style={{ animationDelay: `${Math.round(d.at * ROUTE_MS)}ms` }}
        >
          <rect className="turf-hero__house" x={d.x} y={d.y} width={14} height={12} rx={2} />
          {d.state === 'sign' && (
            // Positioned by the outer group: the inner one's CSS animation would override a transform attribute.
            <g transform={`translate(${d.x + 18} ${d.y - 10})`}>
              <g className="turf-hero__sign">
                <line x1={5} y1={9} x2={5} y2={20} />
                <rect x={0} y={0} width={11} height={9} rx={1} />
              </g>
            </g>
          )}
        </g>
      ))}
    </svg>
  );
}
