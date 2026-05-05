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

// @turf/turf full bundle has an ESM conflict in Node; compose the stub from individual CJS packages.
{
  const _distance = require('@turf/distance').default;
  const _npol     = require('@turf/nearest-point-on-line').default;
  const _helpers  = require('@turf/helpers');
  global.turf = {
    distance:           _distance,
    lineString:         _helpers.lineString,
    point:              _helpers.point,
    nearestPointOnLine: _npol,
  };
}

global.localStorage = { getItem: () => null, setItem: () => {} };

// Minimal Leaflet stub – only what top-level app.js code uses at load time
const _noopLayer = { on: () => _noopLayer, addTo: () => _noopLayer, bindTooltip: () => _noopLayer, remove: () => _noopLayer };
const _mapObj = { on: () => {}, removeLayer: () => {}, fitBounds: () => {} };
_mapObj.setView = () => _mapObj;
global.L = {
  map:          () => _mapObj,
  tileLayer:    () => ({ addTo: () => {} }),
  latLng:       (lat, lng) => ({ lat, lng }),
  polyline:     () => _noopLayer,
  marker:       () => _noopLayer,
  latLngBounds: () => ({ pad: () => ({}) }),
  divIcon:      () => ({}),
  Icon:         { Default: function () {} },
  DomEvent:     { stopPropagation: () => {} },
};

// Minimal jQuery stub – document-ready callbacks are ignored; all DOM
// selector calls return a chainable no-op object so the $(function(){…})
// block at the bottom of app.js does not execute.
global.$ = function (arg) {
  if (typeof arg === 'function') return; // document-ready: skip
  const chain = {};
  [
    'empty', 'append', 'text', 'val', 'addClass', 'removeClass',
    'toggleClass', 'show', 'hide', 'on', 'off', 'css', 'attr', 'prop',
    'find', 'is', 'closest', 'remove', 'trigger', 'html',
    'prepend', 'before', 'after', 'appendTo',
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
  encodeTripV3,
  decodeTripFromParam,
  decodeTripFromText,
  computeSegmentDistances,
  computeMetroLayout,
  buildMetroLineSvg,
  buildMetroVerticalSvg,
  duplicateTrip,
  snapshotEditTrip,
  undoEdit,
  redoEdit,
  getEditTrip,
} = require('./js/app.js');

const app = require('./js/app.js');

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

// Tokyo → Lima (3 named waypoints)
const TRIP_TOKYO_LIMA = {
  name: 'Tokyo to Lima',
  waypoints: [
    { lat: 35.6895, lng: 139.6917, name: '東京',     desc: 'Start' },
    { lat: 0.0000,  lng: -79.0000, name: 'Equator',   desc: 'Crossing' },
    { lat: -12.0464, lng: -77.0428, name: 'Lima',      desc: 'End' },
  ],
};

const TRIP_POLES = {
  name: 'Extremes',
  waypoints: [
    { lat: -33.8688, lng: 151.2093, name: 'Sydney',      desc: '' },
    { lat:  90,      lng:   0,      name: 'North Pole',  desc: '' },
    { lat: -90,      lng: 180,      name: 'South Pole',  desc: '' },
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

group('2a. Path import / export', () => {

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

  test('decodeTripFromText – unicode characters', () => {
    const param   = encodeTripForUrl(TRIP_TOKYO_LIMA);
    const url     = `https://example.com/app?trip=${param}`;
    const decoded = decodeTripFromText(url);
    assert.strictEqual(decoded.waypoints.length, 3);
    assert.strictEqual(decoded.waypoints[0].name, TRIP_TOKYO_LIMA.waypoints[0].name);
  });

});

// ═══════════════════════════════════════════
// 2b. v3 EXPORT / IMPORT
// ═══════════════════════════════════════════

group('2b. v3 export / import', () => {

  test('encodeTripV3 produces a v3;-prefixed string', () => {
    const encoded = encodeTripV3(TRIP_LONDON_PARIS);
    assert(encoded.startsWith('v3;'), `Expected v3; prefix, got: ${encoded.slice(0, 10)}`);
  });

  test('encodeTripV3 – second segment is the safe-encoded trip name', () => {
    const encoded = encodeTripV3(TRIP_LONDON_PARIS);
    const parts   = encoded.split(';');
    assert.strictEqual(parts[1], 'London to Paris');
  });

  test('encodeTripV3 – one semicolon-separated segment per waypoint', () => {
    const encoded = encodeTripV3(TRIP_LONDON_PARIS);
    const parts   = encoded.split(';');
    // parts[0] = "v3", parts[1] = name, parts[2..4] = 3 waypoints
    assert.strictEqual(parts.length, 5, `Expected 5 parts, got ${parts.length}`);
  });

  test('encodeTripV3 / decodeTripFromParam round-trip – name preserved', () => {
    const encoded = encodeTripV3(TRIP_LONDON_PARIS);
    const decoded = decodeTripFromParam(encoded);
    assert.strictEqual(decoded.name, TRIP_LONDON_PARIS.name);
  });

  test('encodeTripV3 / decodeTripFromParam round-trip – waypoint count', () => {
    const encoded = encodeTripV3(TRIP_LONDON_PARIS);
    const decoded = decodeTripFromParam(encoded);
    assert.strictEqual(decoded.waypoints.length, 3);
  });

  test('encodeTripV3 / decodeTripFromParam round-trip – coordinates within 1 m', () => {
    const encoded = encodeTripV3(TRIP_LONDON_PARIS);
    const decoded = decodeTripFromParam(encoded);
    assertClose(decoded.waypoints[0].lat,  51.5074,  0.00001, 'London lat');
    assertClose(decoded.waypoints[0].lng,  -0.1278,  0.00001, 'London lng');
    assertClose(decoded.waypoints[1].lat,  51.0924,  0.00001, 'Folkestone lat');
    assertClose(decoded.waypoints[1].lng,   1.1697,  0.00001, 'Folkestone lng');
    assertClose(decoded.waypoints[2].lat,  48.8566,  0.00001, 'Paris lat');
    assertClose(decoded.waypoints[2].lng,   2.3522,  0.00001, 'Paris lng');
  });

  test('encodeTripV3 / decodeTripFromParam round-trip – waypoint names and descs', () => {
    const encoded = encodeTripV3(TRIP_LONDON_PARIS);
    const decoded = decodeTripFromParam(encoded);
    assert.strictEqual(decoded.waypoints[0].name, 'London');
    assert.strictEqual(decoded.waypoints[0].desc, 'Start');
    assert.strictEqual(decoded.waypoints[1].name, 'Folkestone');
    assert.strictEqual(decoded.waypoints[1].desc, 'Channel crossing');
    assert.strictEqual(decoded.waypoints[2].name, 'Paris');
    assert.strictEqual(decoded.waypoints[2].desc, 'End');
  });

  test('encodeTripV3 – coordinates are rounded to 5 decimal places', () => {
    const trip = {
      name: 'Precision test',
      waypoints: [{ lat: 51.123456789, lng: -0.123456789, name: 'A', desc: '' }],
    };
    const encoded = encodeTripV3(trip);
    const decoded = decodeTripFromParam(encoded);
    assertClose(decoded.waypoints[0].lat,  51.12346, 0.000005, 'lat rounded to 5dp');
    assertClose(decoded.waypoints[0].lng,  -0.12346, 0.000005, 'lng rounded to 5dp');
  });

  test('encodeTripV3 – special characters in name are safely encoded', () => {
    const trip = {
      name: 'München → Zürich',
      waypoints: [
        { lat: 48.1375, lng: 11.575,  name: 'München', desc: 'Bavaria; "capital"' },
        { lat: 47.3769, lng:  8.5417, name: 'Zürich',  desc: '' },
      ],
    };
    const encoded = encodeTripV3(trip);
    const decoded = decodeTripFromParam(encoded);
    assert.strictEqual(decoded.name,                    trip.name);
    assert.strictEqual(decoded.waypoints[0].name, 'München');
    assert.strictEqual(decoded.waypoints[0].desc, 'Bavaria; "capital"');
    assert.strictEqual(decoded.waypoints[1].name, 'Zürich');
  });

  test('decodeTripFromParam – v3 prefix is detected and dispatched correctly', () => {
    const encoded = encodeTripV3(TRIP_AB);
    assert(encoded.startsWith('v3;'), 'encoded must start with v3;');
    const decoded = decodeTripFromParam(encoded);
    assert.strictEqual(decoded.name,              TRIP_AB.name);
    assert.strictEqual(decoded.waypoints.length,  2);
  });

  test('decodeTripFromText – accepts a raw v3 string', () => {
    const encoded = encodeTripV3(TRIP_AB);
    const decoded = decodeTripFromText(encoded);
    assert.strictEqual(decoded.name,             TRIP_AB.name);
    assert.strictEqual(decoded.waypoints.length, 2);
  });

  test('decodeTripFromText – accepts a URL with a v3 trip param', () => {
    const encoded = encodeTripV3(TRIP_LONDON_PARIS);
    const url     = `https://example.com/app?trip=${encodeURIComponent(encoded)}`;
    const decoded = decodeTripFromText(url);
    assert.strictEqual(decoded.name,             TRIP_LONDON_PARIS.name);
    assert.strictEqual(decoded.waypoints.length, 3);
  });

  test('decodeTripFromParam – negative and near-180° longitudes round-trip', () => {
    const decoded = decodeTripFromParam(encodeTripV3(TRIP_POLES));
    assertClose(decoded.waypoints[0].lat, TRIP_POLES.waypoints[0].lat, 0.00001, 'Sydney lat');
    assertClose(decoded.waypoints[0].lng, TRIP_POLES.waypoints[0].lng, 0.00001, 'Sydney lng');
    assertClose(decoded.waypoints[1].lat, TRIP_POLES.waypoints[1].lat, 0.00001, 'North Pole lat');
    assertClose(decoded.waypoints[1].lng, TRIP_POLES.waypoints[1].lng, 0.00001, 'North Pole lng');
    assertClose(decoded.waypoints[2].lat, TRIP_POLES.waypoints[2].lat, 0.00001, 'South Pole lat');
    assertClose(decoded.waypoints[2].lng, TRIP_POLES.waypoints[2].lng, 0.00001, 'South Pole lng');
  });

  test('decodeTripFromParam – malformed v3 string returns null', () => {
    assert.strictEqual(decodeTripFromParam('v3;'),                null);
    assert.strictEqual(decodeTripFromParam('v3;JustAName'),       null);
    assert.strictEqual(decodeTripFromParam('v3;Name;BADINPUT'),   null);
  });

  test('decodeTripFromText – unicode characters', () => {
    const decoded = decodeTripFromParam(encodeTripV3(TRIP_TOKYO_LIMA));
    assert.strictEqual(decoded.waypoints.length, 3);
    assert.strictEqual(decoded.waypoints[0].name, TRIP_TOKYO_LIMA.waypoints[0].name);
  });

});

// ═══════════════════════════════════════════
// 3. SVG RENDERINGS
// ═══════════════════════════════════════════

group('3a. SVG renderings – horizontal metro line (buildMetroLineSvg)', () => {

  const SD = computeSegmentDistances(TRIP_LONDON_PARIS.waypoints);
  const layout = computeMetroLayout('even', TRIP_LONDON_PARIS.waypoints, SD.segDists, null);

  test('returns an SVG element', () => {
    const svg = buildMetroLineSvg(layout, null);
    assert.strictEqual(svg.tagName, 'svg');
  });

  test('SVG has the correct viewBox', () => {
    const svg = buildMetroLineSvg(layout, null);
    assert.strictEqual(svg.getAttribute('viewBox'), '0 0 280 106');
  });

  test('contains a background track line with correct stroke colour', () => {
    const svg   = buildMetroLineSvg(layout, null);
    const lines = svgEls(svg, 'line');
    assert(lines.length >= 1, 'Expected at least one <line> for the background track');
    assert.strictEqual(lines[0].getAttribute('stroke'), '#cbd5e1');
  });

  test('contains one dot per named endpoint/waypoint (all 3 named)', () => {
    const svg     = buildMetroLineSvg(layout, null);
    const circles = svgEls(svg, 'circle');
    assert.strictEqual(circles.length, 3, `Expected 3 waypoint circles, got ${circles.length}`);
  });

  test('waypoint dots are white (not passed) when no position info', () => {
    const svg     = buildMetroLineSvg(layout, null);
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
    const layoutWithInfo = computeMetroLayout('even', TRIP_LONDON_PARIS.waypoints, SD.segDists, info);
    const svg   = buildMetroLineSvg(layoutWithInfo, info);
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
    const sd        = computeSegmentDistances(trip.waypoints);
    const tripLayout = computeMetroLayout('even', trip.waypoints, sd.segDists, null);
    const svg     = buildMetroLineSvg(tripLayout, null);
    const circles = svgEls(svg, 'circle');
    // Only the two named endpoints should get dots
    assert.strictEqual(circles.length, 2, `Expected 2 endpoint dots, got ${circles.length}`);
  });

});

group('3b. SVG renderings – vertical metro strip (buildMetroVerticalSvg)', () => {

  const SD     = computeSegmentDistances(TRIP_LONDON_PARIS.waypoints);
  const layout = computeMetroLayout('even', TRIP_LONDON_PARIS.waypoints, SD.segDists, null);

  test('returns an object with svg, dotY, SVG_H, posY, collCumDist, visIdx, and visWps', () => {
    const result = buildMetroVerticalSvg(layout, null);
    assert(result.svg,                         'Missing svg');
    assert(Array.isArray(result.dotY),         'Missing dotY array');
    assert(typeof result.SVG_H === 'number',   'Missing SVG_H number');
    assert('posY' in result,                   'Missing posY');
    assert(Array.isArray(result.collCumDist),  'Missing collCumDist array');
    assert(Array.isArray(result.visIdx),       'Missing visIdx array');
    assert(Array.isArray(result.visWps),       'Missing visWps array');
  });

  test('SVG element has correct width attribute', () => {
    const { svg } = buildMetroVerticalSvg(layout, null);
    assert.strictEqual(svg.tagName, 'svg');
    assert.strictEqual(svg.getAttribute('width'), '36');
  });

  test('dotY has one entry per visible waypoint', () => {
    const { dotY, visWps } = buildMetroVerticalSvg(layout, null);
    assert.strictEqual(dotY.length, visWps.length);
    assert.strictEqual(dotY.length, TRIP_LONDON_PARIS.waypoints.length); // all 3 are named
  });

  test('first dot is positioned above the last dot', () => {
    const { dotY } = buildMetroVerticalSvg(layout, null);
    assert(dotY[0] < dotY[dotY.length - 1], 'First dot should be above last dot');
  });

  test('posY is null when no position info is provided', () => {
    const { posY } = buildMetroVerticalSvg(layout, null);
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
    const layoutWithInfo = computeMetroLayout('even', TRIP_LONDON_PARIS.waypoints, SD.segDists, info);
    const { posY } = buildMetroVerticalSvg(layoutWithInfo, info);
    assert(typeof posY === 'number' && posY > 0, `posY should be a positive number, got ${posY}`);
  });

  test('SVG contains one dot per waypoint (no position indicator when posY is null)', () => {
    const { svg } = buildMetroVerticalSvg(layout, null);
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
    const sdShort   = computeSegmentDistances(tripShort.waypoints);
    const sdLong    = computeSegmentDistances(tripLong.waypoints);
    const { SVG_H: h2 } = buildMetroVerticalSvg(computeMetroLayout('even', tripShort.waypoints, sdShort.segDists, null), null);
    const { SVG_H: h4 } = buildMetroVerticalSvg(computeMetroLayout('even', tripLong.waypoints,  sdLong.segDists,  null), null);
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
    const layoutWithInfo = computeMetroLayout('even', TRIP_LONDON_PARIS.waypoints, SD.segDists, info);
    const { svg } = buildMetroVerticalSvg(layoutWithInfo, info);
    const circles = svgEls(svg, 'circle');
    // 3 waypoint dots + 2 position-indicator circles (ring + filled dot)
    assert(circles.length >= 5, `Expected ≥5 circles with position info, got ${circles.length}`);
  });

  test('unnamed intermediate waypoints are collapsed: dotY and visWps lengths match (label alignment bug)', () => {
    // A trip where the middle waypoint is unnamed — it must be invisible.
    // dotY and visWps must both have length 2 (start + end only), so that
    // dotY[vi] aligns correctly with visWps[vi] in renderMetroVertical.
    const trip = {
      name: 'Collapse test',
      waypoints: [
        { lat: 0, lng: 0,  name: 'Start', desc: '' },
        { lat: 1, lng: 1,  name: '',      desc: '' },  // unnamed – must be collapsed
        { lat: 2, lng: 2,  name: 'End',   desc: '' },
      ],
    };
    const sd         = computeSegmentDistances(trip.waypoints);
    const tripLayout = computeMetroLayout('even', trip.waypoints, sd.segDists, null);
    const { dotY, visWps, visIdx } = buildMetroVerticalSvg(tripLayout, null);
    assert.strictEqual(visWps.length, 2, `Expected 2 visible waypoints, got ${visWps.length}`);
    assert.strictEqual(dotY.length,   2, `Expected dotY length 2, got ${dotY.length}`);
    assert.strictEqual(visIdx[0], 0, 'First visible waypoint should be original index 0');
    assert.strictEqual(visIdx[1], 2, 'Second visible waypoint should be original index 2 (end)');
  });

});

// ═══════════════════════════════════════════
// 5. DUPLICATE TRIP
// ═══════════════════════════════════════════

group('4. duplicateTrip', () => {

  test('waypoints are in the same order as the source', () => {
    const result = duplicateTrip(TRIP_LONDON_PARIS, 'Test copy');
    assert.strictEqual(result.waypoints.length, 3);
    assert.strictEqual(result.waypoints[0].name, 'London');
    assert.strictEqual(result.waypoints[1].name, 'Folkestone');
    assert.strictEqual(result.waypoints[2].name, 'Paris');
  });

  test('coordinates match source waypoints', () => {
    const result = duplicateTrip(TRIP_LONDON_PARIS, 'Test copy');
    assert.strictEqual(result.waypoints[0].lat, TRIP_LONDON_PARIS.waypoints[0].lat);
    assert.strictEqual(result.waypoints[0].lng, TRIP_LONDON_PARIS.waypoints[0].lng);
    assert.strictEqual(result.waypoints[2].lat, TRIP_LONDON_PARIS.waypoints[2].lat);
    assert.strictEqual(result.waypoints[2].lng, TRIP_LONDON_PARIS.waypoints[2].lng);
  });

  test('name and desc are preserved from source waypoints', () => {
    const result = duplicateTrip(TRIP_LONDON_PARIS, 'Test copy');
    assert.strictEqual(result.waypoints[0].desc, 'Start');
    assert.strictEqual(result.waypoints[2].desc, 'End');
  });

  test('trip name is set to the provided name', () => {
    const result = duplicateTrip(TRIP_LONDON_PARIS, 'London to Paris (copy)');
    assert.strictEqual(result.name, 'London to Paris (copy)');
  });

  test('each waypoint gets a fresh id (string, non-empty)', () => {
    const result = duplicateTrip(TRIP_LONDON_PARIS, 'Test copy');
    result.waypoints.forEach(wp => {
      assert.strictEqual(typeof wp.id, 'string');
      assert(wp.id.length > 0, 'id should be non-empty');
    });
  });

  test('fresh ids differ from source waypoint ids', () => {
    const sourceIds = new Set(TRIP_LONDON_PARIS.waypoints.map(w => w.id).filter(Boolean));
    const result    = duplicateTrip(TRIP_LONDON_PARIS, 'Test copy');
    result.waypoints.forEach(wp => {
      assert(!sourceIds.has(wp.id), `id ${wp.id} should be fresh, not from the source`);
    });
  });

  test('does not modify the original trip', () => {
    const originalOrder = TRIP_LONDON_PARIS.waypoints.map(w => w.name);
    duplicateTrip(TRIP_LONDON_PARIS, 'Test copy');
    const afterOrder = TRIP_LONDON_PARIS.waypoints.map(w => w.name);
    assert.deepStrictEqual(afterOrder, originalOrder, 'Original trip waypoints should be unchanged');
  });

  test('single-waypoint trip duplicates to itself', () => {
    const singleWp = { name: 'Solo', waypoints: [{ lat: 10, lng: 20, name: 'A', desc: 'only' }] };
    const result   = duplicateTrip(singleWp, 'Solo (copy)');
    assert.strictEqual(result.waypoints.length, 1);
    assert.strictEqual(result.waypoints[0].name, 'A');
    assert.strictEqual(result.waypoints[0].lat,  10);
  });

  test('empty waypoints trip duplicates to empty', () => {
    const empty  = { name: 'Empty', waypoints: [] };
    const result = duplicateTrip(empty, 'Empty (copy)');
    assert.strictEqual(result.waypoints.length, 0);
  });

});

// ═══════════════════════════════════════════
// 9. UNDO HISTORY
// ═══════════════════════════════════════════

group('5a. Undo history', () => {

  /** Helper: set up a fresh trip as the active edit trip. */
  function setupEditTrip(waypoints) {
    const trip = {
      id: 'test-trip-undo',
      name: 'Undo Test',
      waypoints: waypoints.map((w, i) => ({ id: `wp${i}`, ...w })),
    };
    app.trips = [trip];
    app.editTripId = trip.id;
    app.editUndoHistory = [];
    app.editRedoHistory = [];
    return trip;
  }

  test('snapshotEditTrip pushes a deep copy of waypoints', () => {
    const trip = setupEditTrip([{ lat: 1, lng: 2, name: 'A', desc: '' }]);
    snapshotEditTrip();
    assert.strictEqual(app.editUndoHistory.length, 1);
    // Mutating the trip should not affect the snapshot
    trip.waypoints[0].lat = 99;
    assert.strictEqual(app.editUndoHistory[0].waypoints[0].lat, 1);
  });

  test('undoEdit restores previous waypoints', () => {
    const trip = setupEditTrip([
      { lat: 1, lng: 2, name: 'A', desc: '' },
      { lat: 3, lng: 4, name: 'B', desc: '' },
    ]);
    snapshotEditTrip();          // snapshot before change
    trip.waypoints.push({ id: 'wp2', lat: 5, lng: 6, name: 'C', desc: '' });
    assert.strictEqual(trip.waypoints.length, 3);
    undoEdit();
    assert.strictEqual(trip.waypoints.length, 2, 'undo should restore two waypoints');
    assert.strictEqual(trip.waypoints[1].name, 'B');
  });

  test('undoEdit does nothing when history is empty', () => {
    const trip = setupEditTrip([{ lat: 1, lng: 2, name: 'A', desc: '' }]);
    assert.doesNotThrow(() => undoEdit());
    assert.strictEqual(trip.waypoints.length, 1, 'waypoints unchanged with empty history');
  });

  test('multiple snapshots accumulate and undo in LIFO order', () => {
    const trip = setupEditTrip([{ lat: 0, lng: 0, name: 'Origin', desc: '' }]);
    snapshotEditTrip();
    trip.waypoints.push({ id: 'wp1', lat: 1, lng: 1, name: 'P1', desc: '' });
    snapshotEditTrip();
    trip.waypoints.push({ id: 'wp2', lat: 2, lng: 2, name: 'P2', desc: '' });
    assert.strictEqual(trip.waypoints.length, 3);
    undoEdit(); // undo second push
    assert.strictEqual(trip.waypoints.length, 2);
    undoEdit(); // undo first push
    assert.strictEqual(trip.waypoints.length, 1);
    assert.strictEqual(trip.waypoints[0].name, 'Origin');
  });

  test(`history is capped at EDIT_UNDO_LIMIT (${app.EDIT_UNDO_LIMIT})`, () => {
    const trip = setupEditTrip([{ lat: 0, lng: 0, name: 'X', desc: '' }]);
    for (let i = 0; i < app.EDIT_UNDO_LIMIT + 5; i++) {
      snapshotEditTrip();
    }
    assert.strictEqual(app.editUndoHistory.length, app.EDIT_UNDO_LIMIT);
  });

  test('snapshotEditTrip clears redo history', () => {
    const trip = setupEditTrip([{ lat: 1, lng: 1, name: 'A', desc: '' }]);
    snapshotEditTrip();
    undoEdit(); // populates redo
    assert.strictEqual(app.editRedoHistory.length, 1);
    snapshotEditTrip(); // new action — redo should be cleared
    assert.strictEqual(app.editRedoHistory.length, 0, 'redo history should be cleared after new snapshot');
  });

});

// ═══════════════════════════════════════════
// 10. REDO HISTORY
// ═══════════════════════════════════════════

group('5b. Redo history', () => {

  /** Helper: set up a fresh trip as the active edit trip. */
  function setupEditTrip(waypoints) {
    const trip = {
      id: 'test-trip-redo',
      name: 'Redo Test',
      waypoints: waypoints.map((w, i) => ({ id: `wp${i}`, ...w })),
    };
    app.trips = [trip];
    app.editTripId = trip.id;
    app.editUndoHistory = [];
    app.editRedoHistory = [];
    return trip;
  }

  test('undoEdit pushes current state onto redo stack', () => {
    const trip = setupEditTrip([{ lat: 1, lng: 2, name: 'A', desc: '' }]);
    snapshotEditTrip();
    trip.waypoints[0].name = 'A-modified';
    undoEdit();
    assert.strictEqual(app.editRedoHistory.length, 1, 'redo stack should have one entry after undo');
  });

  test('redoEdit restores the undone state', () => {
    const trip = setupEditTrip([{ lat: 1, lng: 2, name: 'A', desc: '' }]);
    snapshotEditTrip();
    trip.waypoints.push({ id: 'wp1', lat: 3, lng: 4, name: 'B', desc: '' });
    undoEdit();
    assert.strictEqual(trip.waypoints.length, 1, 'after undo: one waypoint');
    redoEdit();
    assert.strictEqual(trip.waypoints.length, 2, 'after redo: two waypoints restored');
    assert.strictEqual(trip.waypoints[1].name, 'B');
  });

  test('redoEdit does nothing when redo stack is empty', () => {
    const trip = setupEditTrip([{ lat: 1, lng: 2, name: 'A', desc: '' }]);
    assert.doesNotThrow(() => redoEdit());
    assert.strictEqual(trip.waypoints.length, 1, 'waypoints unchanged with empty redo stack');
  });

  test('redoEdit pushes current state back onto undo stack', () => {
    const trip = setupEditTrip([{ lat: 1, lng: 2, name: 'A', desc: '' }]);
    snapshotEditTrip();
    trip.waypoints[0].name = 'A-modified';
    undoEdit();
    redoEdit();
    assert.strictEqual(app.editUndoHistory.length, 1, 'undo stack should have an entry after redo');
  });

  test('undo then redo then undo round-trips correctly', () => {
    const trip = setupEditTrip([{ lat: 0, lng: 0, name: 'X', desc: '' }]);
    snapshotEditTrip();
    trip.waypoints.push({ id: 'wp1', lat: 1, lng: 1, name: 'Y', desc: '' });
    undoEdit();
    assert.strictEqual(trip.waypoints.length, 1);
    redoEdit();
    assert.strictEqual(trip.waypoints.length, 2);
    undoEdit();
    assert.strictEqual(trip.waypoints.length, 1);
    assert.strictEqual(trip.waypoints[0].name, 'X');
  });

  test('redo stack is capped at EDIT_UNDO_LIMIT', () => {
    const trip = setupEditTrip([{ lat: 0, lng: 0, name: 'X', desc: '' }]);
    // Fill the undo stack to the limit, then undo all entries to populate redo
    for (let i = 0; i < app.EDIT_UNDO_LIMIT; i++) {
      snapshotEditTrip();
    }
    const undoCount = app.editUndoHistory.length; // should be EDIT_UNDO_LIMIT
    for (let i = 0; i < undoCount; i++) {
      undoEdit();
    }
    assert.strictEqual(app.editRedoHistory.length, app.EDIT_UNDO_LIMIT, 'redo history should be exactly at the cap');
  });

});

console.log(`\n${'─'.repeat(44)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
