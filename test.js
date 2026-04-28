'use strict';

// ═══════════════════════════════════════════
// TEST HARNESS
// ═══════════════════════════════════════════

const assert = require('assert');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (e) {
    console.error(`  \u2717 ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

function group(name, fn) {
  console.log(`\n${name}`);
  fn();
}

/**
 * Assert that two numbers are within `delta` of each other.
 * Always provide an explicit delta for geographic-distance comparisons;
 * the default of 1 is only suitable for near-exact floating-point checks.
 */
function assertClose(a, b, delta, msg) {
  if (delta === undefined) delta = 1;
  assert(
    Math.abs(a - b) <= delta,
    msg || `Expected ${a} \u2248 ${b} (\u00b1${delta})`,
  );
}

// ═══════════════════════════════════════════
// BROWSER GLOBALS STUB
// (must be set before requiring app.js)
// ═══════════════════════════════════════════

global.turf = require('@turf/turf');

global.localStorage = { getItem: () => null, setItem: () => {} };

// Minimal Leaflet stub – only what top-level app.js code uses at load time
const _mapObj = { on: () => {} };
_mapObj.setView = () => _mapObj;
global.L = {
  map:       () => _mapObj,
  tileLayer: () => ({ addTo: () => {} }),
  latLng:    (lat, lng) => ({ lat, lng }),
};

// Minimal jQuery stub – document-ready callbacks are ignored; all DOM
// selector calls return a chainable no-op object so the $(function(){…})
// block at the bottom of app.js does not execute.
global.$ = function (arg) {
  if (typeof arg === 'function') return; // document-ready: skip
  const chain = {};
  [
    'empty', 'append', 'text', 'val', 'addClass', 'removeClass',
    'toggleClass', 'show', 'hide', 'on', 'off', 'css', 'attr',
    'find', 'is', 'closest', 'remove', 'trigger', 'html',
    'prepend', 'before', 'after',
  ].forEach(m => { chain[m] = () => chain; });
  chain.length = 0;
  return chain;
};
global.$.fn = {};

// DOM with SVG namespace support for buildMetroLineSvg / buildMetroVerticalSvg
const { DOMImplementation } = require('@xmldom/xmldom');
global.document = new DOMImplementation().createDocument(
  'http://www.w3.org/2000/svg', null, null,
);

// ═══════════════════════════════════════════
// LOAD APP
// ═══════════════════════════════════════════

const {
  fmtDist,
  fmtEta,
  decodeCompactTrip,
  encodeTripCompact,
  encodeTripForUrl,
  decodeTripFromParam,
  decodeTripFromText,
  computeSegmentDistances,
  buildMetroLineSvg,
  buildMetroVerticalSvg,
} = require('./js/app.js');

// ═══════════════════════════════════════════
// FIXTURE DATA
// ═══════════════════════════════════════════

// London → Folkestone → Paris (3 named waypoints)
const TRIP_LONDON_PARIS = {
  name: 'London to Paris',
  waypoints: [
    { lat: 51.5074, lng: -0.1278, name: 'London',     desc: 'Start' },
    { lat: 51.0924, lng:  1.1697, name: 'Folkestone', desc: 'Channel crossing' },
    { lat: 48.8566, lng:  2.3522, name: 'Paris',      desc: 'End' },
  ],
};

// Two waypoints on the equator, 1° apart in longitude
const TRIP_AB = {
  name: 'A to B',
  waypoints: [
    { lat: 0, lng: 0, name: 'A', desc: '' },
    { lat: 0, lng: 1, name: 'B', desc: '' },
  ],
};

// Helper: collect SVG child elements by tag from a parent element
function svgEls(parent, tag) {
  const list = parent.getElementsByTagNameNS('http://www.w3.org/2000/svg', tag);
  return Array.from(list);
}

// ═══════════════════════════════════════════
// 1. DISTANCE CALCULATIONS
// ═══════════════════════════════════════════

group('1. Distance calculations', () => {

  test('fmtDist – sub-kilometre values', () => {
    assert.strictEqual(fmtDist(0),   '0\u202fm');
    assert.strictEqual(fmtDist(500), '500\u202fm');
    assert.strictEqual(fmtDist(999), '999\u202fm');
  });

  test('fmtDist – kilometre-scale values', () => {
    assert.strictEqual(fmtDist(1000),  '1.0\u202fkm');
    assert.strictEqual(fmtDist(1500),  '1.5\u202fkm');
    assert.strictEqual(fmtDist(10000), '10.0\u202fkm');
  });

  test('fmtEta – null / invalid input', () => {
    assert.strictEqual(fmtEta(0),        null);
    assert.strictEqual(fmtEta(-1),       null);
    assert.strictEqual(fmtEta(Infinity), null);
  });

  test('fmtEta – sub-minute', () => {
    assert.strictEqual(fmtEta(10), '<1\u202fmin');
  });

  test('fmtEta – minutes', () => {
    assert.strictEqual(fmtEta(60),   '1\u202fmin');
    assert.strictEqual(fmtEta(1800), '30\u202fmin');
    assert.strictEqual(fmtEta(3540), '59\u202fmin');
  });

  test('fmtEta – hours and hours+minutes', () => {
    assert.strictEqual(fmtEta(3600), '1\u202fh');
    assert.strictEqual(fmtEta(5400), '1\u202fh\u202f30\u202fmin');
    assert.strictEqual(fmtEta(7200), '2\u202fh');
  });

  test('computeSegmentDistances – single segment at equator', () => {
    const { segDists, cumDist, totalDist } = computeSegmentDistances(TRIP_AB.waypoints);
    assert.strictEqual(segDists.length, 1);
    // 1° of longitude at the equator ≈ 111 320 m; allow ±1 500 m (~1.3%) for
    // any minor variation in the geodesic model used by the turf version.
    assertClose(segDists[0], 111320, 1500, 'segment length at equator');
    assertClose(totalDist, segDists[0], 0.001, 'totalDist equals single segment');
    assert.strictEqual(cumDist[0], 0, 'cumDist starts at 0');
    assertClose(cumDist[1], segDists[0], 0.001, 'cumDist[1] equals segment length');
  });

  test('computeSegmentDistances – multi-segment London → Paris', () => {
    const { segDists, totalDist } = computeSegmentDistances(TRIP_LONDON_PARIS.waypoints);
    assert.strictEqual(segDists.length, 2);
    // London → Folkestone ≈ 101 km
    assertClose(segDists[0], 101000, 3000, 'London → Folkestone distance');
    // Folkestone → Paris ≈ 263 km
    assertClose(segDists[1], 263000, 5000, 'Folkestone → Paris distance');
    // Total ≈ 364 km
    assertClose(totalDist, 364000, 6000, 'total London → Paris distance');
  });

  test('computeSegmentDistances – trivial single-waypoint list', () => {
    const { segDists, cumDist, totalDist } = computeSegmentDistances([
      { lat: 0, lng: 0, name: '', desc: '' },
    ]);
    assert.strictEqual(segDists.length, 0);
    assert.strictEqual(totalDist, 0);
    assert.deepStrictEqual(cumDist, [0]);
  });

});

// ═══════════════════════════════════════════
// 2. PATH IMPORT / EXPORT
// ═══════════════════════════════════════════

group('2. Path import / export', () => {

  test('encodeTripCompact round-trips through decodeCompactTrip', () => {
    const json    = encodeTripCompact(TRIP_LONDON_PARIS);
    const decoded = decodeCompactTrip(JSON.parse(json));
    assert.strictEqual(decoded.name, TRIP_LONDON_PARIS.name);
    assert.strictEqual(decoded.waypoints.length, 3);
    assertClose(decoded.waypoints[0].lat, 51.5074, 0.00001);
    assertClose(decoded.waypoints[0].lng, -0.1278, 0.00001);
    assert.strictEqual(decoded.waypoints[0].name, 'London');
    assert.strictEqual(decoded.waypoints[0].desc, 'Start');
  });

  test('encodeTripCompact – coordinates are rounded to 5 decimal places', () => {
    const trip = {
      name: 'Precision test',
      waypoints: [{ lat: 51.123456789, lng: -0.123456789, name: '', desc: '' }],
    };
    const obj = JSON.parse(encodeTripCompact(trip));
    assert.strictEqual(obj.w[0][0],  51.12346);
    assert.strictEqual(obj.w[0][1], -0.12346);
  });

  test('encodeTripForUrl produces a v2_-prefixed string', () => {
    const encoded = encodeTripForUrl(TRIP_LONDON_PARIS);
    assert(encoded.startsWith('v2_'), `Expected v2_ prefix, got: ${encoded.slice(0, 10)}`);
  });

  test('encodeTripForUrl / decodeTripFromParam round-trip', () => {
    const param   = encodeTripForUrl(TRIP_LONDON_PARIS);
    const decoded = decodeTripFromParam(param);
    assert.strictEqual(decoded.name, TRIP_LONDON_PARIS.name);
    assert.strictEqual(decoded.waypoints.length, 3);
    assertClose(decoded.waypoints[2].lat, 48.8566, 0.00001);
    assertClose(decoded.waypoints[2].lng,  2.3522, 0.00001);
  });

  test('decodeTripFromParam – invalid input returns null', () => {
    assert.strictEqual(decodeTripFromParam('not_valid_base64!!!'), null);
    assert.strictEqual(decodeTripFromParam('v2_!!!invalid!!!'),    null);
  });

  test('decodeTripFromText – accepts compact JSON string', () => {
    const text    = encodeTripCompact(TRIP_LONDON_PARIS);
    const decoded = decodeTripFromText(text);
    assert.strictEqual(decoded.name, TRIP_LONDON_PARIS.name);
    assert.strictEqual(decoded.waypoints.length, 3);
  });

  test('decodeTripFromText – accepts a full share URL', () => {
    const param   = encodeTripForUrl(TRIP_LONDON_PARIS);
    const url     = `https://example.com/app?trip=${param}`;
    const decoded = decodeTripFromText(url);
    assert.strictEqual(decoded.name, TRIP_LONDON_PARIS.name);
    assert.strictEqual(decoded.waypoints.length, 3);
  });

  test('decodeTripFromText – rejects garbage', () => {
    assert.strictEqual(decodeTripFromText('not json at all'), null);
    assert.strictEqual(decodeTripFromText('{}'),              null);
    assert.strictEqual(decodeTripFromText('{"x":1}'),         null);
  });

  test('decodeCompactTrip – null / malformed input returns null', () => {
    assert.strictEqual(decodeCompactTrip(null),      null);
    assert.strictEqual(decodeCompactTrip({}),         null);
    assert.strictEqual(decodeCompactTrip({ n: 'X' }), null);
  });

});

// ═══════════════════════════════════════════
// 3. SVG RENDERINGS
// ═══════════════════════════════════════════

group('3. SVG renderings – horizontal metro line (buildMetroLineSvg)', () => {

  test('returns an SVG element', () => {
    const svg = buildMetroLineSvg(TRIP_LONDON_PARIS, null);
    assert.strictEqual(svg.tagName, 'svg');
  });

  test('SVG has the correct viewBox', () => {
    const svg = buildMetroLineSvg(TRIP_LONDON_PARIS, null);
    assert.strictEqual(svg.getAttribute('viewBox'), '0 0 280 106');
  });

  test('contains a background track line with correct stroke colour', () => {
    const svg   = buildMetroLineSvg(TRIP_LONDON_PARIS, null);
    const lines = svgEls(svg, 'line');
    assert(lines.length >= 1, 'Expected at least one <line> for the background track');
    assert.strictEqual(lines[0].getAttribute('stroke'), '#cbd5e1');
  });

  test('contains one dot per named endpoint/waypoint (all 3 named)', () => {
    const svg     = buildMetroLineSvg(TRIP_LONDON_PARIS, null);
    const circles = svgEls(svg, 'circle');
    assert.strictEqual(circles.length, 3, `Expected 3 waypoint circles, got ${circles.length}`);
  });

  test('waypoint dots are white (not passed) when no position info', () => {
    const svg     = buildMetroLineSvg(TRIP_LONDON_PARIS, null);
    const circles = svgEls(svg, 'circle');
    circles.forEach(c => {
      assert.strictEqual(c.getAttribute('fill'), '#fff', 'Unpassed dot should be white');
    });
  });

  test('with position info: adds a progress line and position indicator', () => {
    const info = {
      distAlong: 107000,
      totalDist: 474000,
      segIdx:    1,
      segT:      0,
      cumDist:   [0, 107000, 474000],
    };
    const svg   = buildMetroLineSvg(TRIP_LONDON_PARIS, info);
    const lines = svgEls(svg, 'line');
    // background track + completed-portion line
    assert(lines.length >= 2, 'Expected background + progress lines');
    assert.strictEqual(lines[1].getAttribute('stroke'), '#2563eb', 'Progress line should be blue');
    // 3 waypoint dots + 2 position-indicator circles (ring + filled dot)
    const circles = svgEls(svg, 'circle');
    assert(circles.length >= 5, 'Expected waypoint dots + indicator circles');
  });

  test('unnamed intermediate waypoints are skipped (no dot)', () => {
    const trip = {
      name: 'Test',
      waypoints: [
        { lat: 0,   lng: 0,   name: 'Start', desc: '' },
        { lat: 0.5, lng: 0.5, name: '',      desc: '' }, // unnamed – should be skipped
        { lat: 1,   lng: 1,   name: 'End',   desc: '' },
      ],
    };
    const svg     = buildMetroLineSvg(trip, null);
    const circles = svgEls(svg, 'circle');
    // Only the two named endpoints should get dots
    assert.strictEqual(circles.length, 2, `Expected 2 endpoint dots, got ${circles.length}`);
  });

});

group('3. SVG renderings – vertical metro strip (buildMetroVerticalSvg)', () => {

  test('returns an object with svg, dotY, SVG_H, posY, and cumDist', () => {
    const result = buildMetroVerticalSvg(TRIP_LONDON_PARIS, null);
    assert(result.svg,             'Missing svg');
    assert(Array.isArray(result.dotY),   'Missing dotY array');
    assert(typeof result.SVG_H === 'number', 'Missing SVG_H number');
    assert('posY' in result,       'Missing posY');
    assert(Array.isArray(result.cumDist), 'Missing cumDist array');
  });

  test('SVG element has correct width attribute', () => {
    const { svg } = buildMetroVerticalSvg(TRIP_LONDON_PARIS, null);
    assert.strictEqual(svg.tagName, 'svg');
    assert.strictEqual(svg.getAttribute('width'), '36');
  });

  test('dotY has one entry per waypoint', () => {
    const { dotY } = buildMetroVerticalSvg(TRIP_LONDON_PARIS, null);
    assert.strictEqual(dotY.length, TRIP_LONDON_PARIS.waypoints.length);
  });

  test('first dot is positioned above the last dot', () => {
    const { dotY } = buildMetroVerticalSvg(TRIP_LONDON_PARIS, null);
    assert(dotY[0] < dotY[dotY.length - 1], 'First dot should be above last dot');
  });

  test('posY is null when no position info is provided', () => {
    const { posY } = buildMetroVerticalSvg(TRIP_LONDON_PARIS, null);
    assert.strictEqual(posY, null);
  });

  test('posY is a positive number when position info is provided', () => {
    const info = {
      distAlong: 107000,
      totalDist: 474000,
      segIdx:    1,
      segT:      0,
      cumDist:   [0, 107000, 474000],
    };
    const { posY } = buildMetroVerticalSvg(TRIP_LONDON_PARIS, info);
    assert(typeof posY === 'number' && posY > 0, `posY should be a positive number, got ${posY}`);
  });

  test('SVG contains one dot per waypoint (no position indicator when posY is null)', () => {
    const { svg } = buildMetroVerticalSvg(TRIP_LONDON_PARIS, null);
    const circles = svgEls(svg, 'circle');
    assert.strictEqual(circles.length, 3, `Expected 3 waypoint circles, got ${circles.length}`);
  });

  test('SVG_H grows with more waypoints', () => {
    const tripShort = {
      name: 'Short',
      waypoints: [
        { lat: 0, lng: 0, name: 'A', desc: '' },
        { lat: 1, lng: 1, name: 'B', desc: '' },
      ],
    };
    const tripLong = {
      name: 'Long',
      waypoints: [
        { lat: 0, lng: 0, name: 'A', desc: '' },
        { lat: 1, lng: 1, name: 'B', desc: '' },
        { lat: 2, lng: 2, name: 'C', desc: '' },
        { lat: 3, lng: 3, name: 'D', desc: '' },
      ],
    };
    const { SVG_H: h2 } = buildMetroVerticalSvg(tripShort, null);
    const { SVG_H: h4 } = buildMetroVerticalSvg(tripLong,  null);
    assert(h4 > h2, `More waypoints should give a taller SVG (${h4} > ${h2})`);
  });

  test('with position info: SVG contains waypoint dots + position indicator circles', () => {
    const info = {
      distAlong: 107000,
      totalDist: 474000,
      segIdx:    1,
      segT:      0,
      cumDist:   [0, 107000, 474000],
    };
    const { svg } = buildMetroVerticalSvg(TRIP_LONDON_PARIS, info);
    const circles = svgEls(svg, 'circle');
    // 3 waypoint dots + 2 position-indicator circles (ring + filled dot)
    assert(circles.length >= 5, `Expected ≥5 circles with position info, got ${circles.length}`);
  });

});

// ═══════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════

console.log(`\n${'─'.repeat(44)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
