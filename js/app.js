'use strict';

// ═══════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════

/** Format metres → human-readable string. */
function fmtDist(m) {
  if (m < 1000) return Math.round(m) + '\u202fm';
  return (m / 1000).toFixed(1) + '\u202fkm';
}

/** Format seconds → human-readable duration string (e.g. "2 min", "1 h 15 min"). */
function fmtEta(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return null;
  const mins = Math.round(seconds / 60);
  if (mins < 1)  return '<1\u202fmin';
  if (mins < 60) return `${mins}\u202fmin`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}\u202fh\u202f${m}\u202fmin` : `${h}\u202fh`;
}

/**
 * Compute the current speed in m/s from the last 10 seconds of GPS history
 * stored in driveState.gpsHistory. Returns null if there is not enough data.
 */
function computeSpeed() {
  if (!driveState || !driveState.gpsHistory || driveState.gpsHistory.length < 2) return null;
  const history = driveState.gpsHistory;
  const latest  = history[history.length - 1].ts;
  const cutoff  = latest - 10000; // 10 seconds before the most recent sample
  const recent  = history.filter(p => p.ts >= cutoff);
  if (recent.length < 2) return null;
  const first = recent[0];
  const last  = recent[recent.length - 1];
  const dt = (last.ts - first.ts) / 1000; // seconds
  if (dt < 0.5) return null;
  const dist = turf.distance(
    [first.lng, first.lat],
    [last.lng,  last.lat],
    { units: 'meters' },
  );
  return dist / dt; // m/s
}

/** Generate a small collision-free unique ID. */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ═══════════════════════════════════════════
// STORAGE
// ═══════════════════════════════════════════

function loadTrips() {
  try { return JSON.parse(localStorage.getItem('trippy_trips') || '[]'); }
  catch (e) { return []; }
}

function saveTrips(trips) {
  localStorage.setItem('trippy_trips', JSON.stringify(trips));
}

// ═══════════════════════════════════════════
// EXPORT / IMPORT
// ═══════════════════════════════════════════

/**
 * Decode a compact (v2) trip object { n, w } into the standard { name, waypoints } shape.
 */
function decodeCompactTrip(compact) {
  if (!compact || typeof compact.n !== 'string' || !Array.isArray(compact.w)) return null;
  return {
    name: compact.n,
    waypoints: compact.w.map(item => {
      if (!Array.isArray(item) || item.length < 2) return null;
      return {
        lat:  typeof item[0] === 'number' ? item[0] : 0,
        lng:  typeof item[1] === 'number' ? item[1] : 0,
        name: typeof item[2] === 'string' ? item[2] : '',
        desc: typeof item[3] === 'string' ? item[3] : '',
      };
    }).filter(Boolean),
  };
}

/**
 * Build a compact JSON string for a trip (v2 format).
 * Waypoints are encoded as arrays [lat, lng, name, desc] to minimise size.
 * Coordinates are rounded to 5 decimal places (~1 m precision).
 */
function encodeTripCompact(trip) {
  return JSON.stringify({
    n: trip.name,
    w: trip.waypoints.map(wp => [
      parseFloat(wp.lat.toFixed(5)),
      parseFloat(wp.lng.toFixed(5)),
      wp.name || '',
      wp.desc || '',
    ]),
  });
}

/**
 * Encode a trip as a URL-safe base64url string (v2 compact format).
 * Produces roughly half the bytes of the old verbose JSON base64 encoding.
 */
function encodeTripForUrl(trip) {
  const bytes  = new TextEncoder().encode(encodeTripCompact(trip));
  let binary   = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  // base64url: replace '+' → '-', '/' → '_', strip '=' padding
  return 'v2_' + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode a trip from a URL parameter.
 * Supports the current compact base64url (v2) format and the legacy base64-JSON format.
 * Returns the parsed { name, waypoints } object, or null on failure.
 */
function decodeTripFromParam(param) {
  try {
    if (param.startsWith('v2_')) {
      // Compact format: base64url-encoded compact JSON
      const b64    = param.slice(3).replace(/-/g, '+').replace(/_/g, '/');
      const binary = atob(b64);
      const bytes  = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return decodeCompactTrip(JSON.parse(new TextDecoder().decode(bytes)));
    }
    // Legacy format: plain base64-encoded full JSON.
    // URLSearchParams decodes '+' as space, so restore before calling atob().
    const fixed  = param.replace(/ /g, '+');
    const binary = atob(fixed);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    return null;
  }
}

/**
 * Decode a trip from pasted plain text.
 * Accepts the compact v2 JSON format, the legacy full-JSON format, or a
 * full share URL (so users can paste either the text or the URL into the box).
 * Returns the parsed { name, waypoints } object, or null on failure.
 */
function decodeTripFromText(text) {
  const trimmed = text.trim();
  // If the text looks like a URL, extract the trip param and decode it.
  if (trimmed.includes('?trip=') || trimmed.includes('&trip=')) {
    try {
      const url     = new URL(trimmed);
      const encoded = url.searchParams.get('trip');
      if (encoded) return decodeTripFromParam(encoded);
    } catch (e) { /* fall through */ }
  }
  // Otherwise try parsing as JSON (compact v2 or legacy).
  try {
    const obj = JSON.parse(trimmed);
    if (!obj) return null;
    if (typeof obj.n === 'string'    && Array.isArray(obj.w))         return decodeCompactTrip(obj);
    if (typeof obj.name === 'string' && Array.isArray(obj.waypoints)) return obj;
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Build a shareable URL for the given trip.
 */
function buildExportUrl(trip) {
  return window.location.origin + window.location.pathname + '?trip=' + encodeTripForUrl(trip);
}

/**
 * Open the share modal for the currently-edited trip, populated with both
 * the compact share URL and the plain-text compact JSON.
 */
function exportCurrentTrip() {
  const trip = getEditTrip();
  if (!trip) return;
  const url  = buildExportUrl(trip);
  const text = encodeTripCompact(trip);
  $('#share-url-input').val(url);
  $('#share-url-note').toggleClass('hidden', url.length <= 2000);
  $('#share-text-input').val(text);
  $('#share-modal').removeClass('hidden');
}

/**
 * Return a trip name that does not conflict with any existing trip name.
 * If baseName already exists, appends -1, -2, … until unique.
 */
function uniqueTripName(baseName) {
  const names = new Set(trips.map(t => t.name));
  if (!names.has(baseName)) return baseName;
  let i = 1;
  while (names.has(baseName + '-' + i)) i += 1;
  return baseName + '-' + i;
}

/**
 * Validate and extract only the expected fields from an imported waypoint object.
 * A fresh ID is always generated for each waypoint to prevent ID collisions.
 */
function sanitizeWaypoint(w) {
  return {
    id:   uid(),
    lat:  typeof w.lat  === 'number' ? w.lat  : 0,
    lng:  typeof w.lng  === 'number' ? w.lng  : 0,
    name: typeof w.name === 'string' ? w.name : '',
    desc: typeof w.desc === 'string' ? w.desc : '',
  };
}

/** Pending import data while the import modal is open. */
let pendingImport = null;

/**
 * Check the current URL for a ?trip= parameter.  If found, decode the trip
 * and open the import-confirmation modal so the user can decide what to do.
 */
function importTripFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const encoded = params.get('trip');
  if (!encoded) return;

  const data = decodeTripFromParam(encoded);
  if (!data || typeof data.name !== 'string' || !data.name.trim() ||
      !Array.isArray(data.waypoints) || data.waypoints.length === 0) {
    alert('Could not read the trip from the URL – the link may be invalid or corrupted.');
    return;
  }

  const n = data.waypoints.length;
  const existing = trips.find(t => t.name === data.name);
  const renamedTo = uniqueTripName(data.name);
  pendingImport = { data, existing, renamedTo };

  if (existing) {
    $('#import-modal-desc').text(
      `A trip named "${data.name}" (${n} waypoint${n !== 1 ? 's' : ''}) already exists in your list.`
    );
    $('#import-modal-add').hide();
    $('#import-modal-overwrite').show().text(`Overwrite "${existing.name}"`);
    $('#import-modal-rename').show().text(`Import as "${renamedTo}"`);
  } else {
    $('#import-modal-desc').text(
      `Import trip "${data.name}" with ${n} waypoint${n !== 1 ? 's' : ''}?`
    );
    $('#import-modal-add').show();
    $('#import-modal-overwrite').hide();
    $('#import-modal-rename').hide();
  }

  $('#import-modal').removeClass('hidden');
}

/** Perform the actual import once the user has confirmed their choice. */
function doImport(name, existingId) {
  const data = pendingImport.data;
  pendingImport = null;

  // Strip the query string from the address bar now that the user has confirmed.
  window.history.replaceState({}, '', window.location.pathname);

  if (existingId) {
    // Overwrite: replace waypoints (and name) of the existing trip, keep its id.
    const existing = trips.find(t => t.id === existingId);
    if (existing) {
      existing.name = name;
      existing.waypoints = data.waypoints.map(sanitizeWaypoint);
      saveTrips(trips);
      renderTripList();
      $('#import-modal').addClass('hidden');
      return;
    }
  }

  // New trip
  const trip = {
    id:        uid(),
    name,
    waypoints: data.waypoints.map(sanitizeWaypoint),
  };
  trips.push(trip);
  saveTrips(trips);
  renderTripList();
  $('#import-modal').addClass('hidden');
}

// ═══════════════════════════════════════════
// APPLICATION STATE
// ═══════════════════════════════════════════

let trips       = loadTrips();
let mode        = 'edit';  // 'edit' | 'drive'
let editTripId  = null;    // ID of trip currently open in edit mode
let driveState  = null;    // { tripId, watchId, posLatLng, lastInfo }
let metroProp   = true;    // true = proportional spacing, false = even spacing

// ── Layout / geometry constants ────────────────────────────
/** Tolerance in metres: a waypoint is considered "passed" when distAlong is within this of its cumDist. */
const WAYPOINT_PROXIMITY_THRESHOLD = 1;
/** Minimum horizontal pixel span between two waypoints before a distance label is drawn. */
const MIN_LABEL_WIDTH_PX = 24;

// ═══════════════════════════════════════════
// MAP SETUP
// ═══════════════════════════════════════════

const map = L.map('map').setView([51.505, -0.09], 5);

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

// Edit-mode layers
let editMarkers  = [];
let editPolyline = null;

// Drive-mode layers
let drivePolyline       = null;
let driveWpMarkers      = [];
let drivePosMarker      = null;
let driveNearestMarker  = null;

// ═══════════════════════════════════════════
// GEOMETRY — nearest point on path
// ═══════════════════════════════════════════

/**
 * Given a Leaflet LatLng and an array of waypoint objects {lat, lng, …},
 * returns:
 *   nearestLatLng   – L.LatLng of the closest point on any segment
 *   distAlong       – metres along the path to that point
 *   totalDist       – total path length in metres
 *   segIdx          – index of the closest segment (segment i → i+1)
 *   segT            – parametric t ∈ [0,1] along that segment
 *   distFromPath    – perpendicular distance from position to path (m)
 *   cumDist         – array of cumulative distances to each waypoint
 *   upcomingIndices – waypoint indices whose cumDist > distAlong
 *
 * Uses turf.js for accurate geospatial calculations on great-circle paths.
 */
function nearestOnPath(posLatLng, waypoints) {
  if (!waypoints || waypoints.length < 2) return null;

  const n = waypoints.length;

  // Cumulative distances to each waypoint (using turf.js for accuracy)
  const segLengths = [];
  const cumDist    = [0];
  for (let i = 0; i < n - 1; i++) {
    const d = turf.distance(
      [waypoints[i].lng, waypoints[i].lat],
      [waypoints[i + 1].lng, waypoints[i + 1].lat],
      { units: 'meters' }
    );
    segLengths.push(d);
    cumDist.push(cumDist[i] + d);
  }
  const totalDist = cumDist[n - 1];

  // Build a GeoJSON LineString (turf.js uses [lng, lat] order)
  const lineCoords = waypoints.map(w => [w.lng, w.lat]);
  const line = turf.lineString(lineCoords);
  const point = turf.point([posLatLng.lng, posLatLng.lat]);

  // Find the nearest point on the line using turf.js
  const nearest = turf.nearestPointOnLine(line, point);
  const distFromPath = nearest.properties.dist * 1000; // turf returns km, convert to metres

  // Determine which segment the nearest point lies on
  let bestSeg = 0;
  let bestT   = 0;
  let distAlong = 0;

  // nearest.properties.index tells us which segment
  if (nearest.properties.index !== undefined) {
    bestSeg = Math.min(nearest.properties.index || 0, n - 2);
    // Calculate t within the segment using the location property
    const nearestCoords = nearest.geometry.coordinates;
    const segStart = lineCoords[bestSeg];
    const segEnd = lineCoords[bestSeg + 1];

    // Calculate parametric t by projecting nearest onto segment
    const [sx, sy] = segStart;
    const [ex, ey] = segEnd;
    const [nx, ny] = nearestCoords;

    const dx = ex - sx;
    const dy = ey - sy;
    const lenSq = dx * dx + dy * dy;

    if (lenSq > 0) {
      bestT = ((nx - sx) * dx + (ny - sy) * dy) / lenSq;
      bestT = Math.max(0, Math.min(1, bestT));
    }

    // Calculate distance along path up to this point
    distAlong = cumDist[bestSeg] + bestT * segLengths[bestSeg];
  }

  // Waypoints whose cumulative distance is strictly ahead of our position
  const upcomingIndices = [];
  for (let i = 1; i < n; i++) {
    if (cumDist[i] > distAlong + WAYPOINT_PROXIMITY_THRESHOLD && waypoints[i].name) upcomingIndices.push(i);
  }

  return {
    nearestLatLng:  L.latLng(nearest.geometry.coordinates[1], nearest.geometry.coordinates[0]),
    distAlong,
    totalDist,
    segIdx:         bestSeg,
    segT:           bestT,
    distFromPath:   distFromPath,
    cumDist,
    upcomingIndices,
  };
}

// ═══════════════════════════════════════════
// EDIT MODE — map rendering
// ═══════════════════════════════════════════

function getEditTrip() {
  return trips.find(t => t.id === editTripId) || null;
}

function clearEditLayers() {
  editMarkers.forEach(m => map.removeLayer(m));
  editMarkers = [];
  if (editPolyline) { map.removeLayer(editPolyline); editPolyline = null; }
}

function renderEditMap(rezoom=true) {
  clearEditLayers();
  const trip = getEditTrip();
  if (!trip) return;

  const lls = trip.waypoints.map(w => [w.lat, w.lng]);

  if (lls.length >= 2) {
    editPolyline = L.polyline(lls, {
      color: '#2563eb', weight: 4, opacity: 0.8,
    }).addTo(map);

    editPolyline.on('click', e => {
      L.DomEvent.stopPropagation(e);
      const trip = getEditTrip();
      if (!trip) return;
      const info = nearestOnPath(e.latlng, trip.waypoints);
      if (!info) return;
      const wp = { id: uid(), lat: info.nearestLatLng.lat, lng: info.nearestLatLng.lng, name: '', desc: '' };
      trip.waypoints.splice(info.segIdx + 1, 0, wp);
      saveTrips(trips);
      renderWaypointList();
      renderEditMap(false);
      //openWaypointModal(wp.id);
    });
  }

  trip.waypoints.forEach((wp, idx) => {
    const marker = L.marker([wp.lat, wp.lng], {
      draggable: true,
      title:     wp.name || `Waypoint ${idx + 1}`,
      icon: wp.name ? new L.Icon.Default() : L.divIcon({ html: `<div class="edit-marker"></div>` }),
    }).addTo(map);

    const tipName = $('<span>').text(wp.name || 'Waypoint ' + (idx + 1)).html();
    const tipDesc = wp.desc ? '<br>' + $('<span>').text(wp.desc).html() : '';
    marker.bindTooltip(
      `<b>${tipName}</b>${tipDesc}`,
      { permanent: false },
    );

    marker.on('dragend', () => {
      const ll = marker.getLatLng();
      wp.lat = ll.lat;
      wp.lng = ll.lng;
      saveTrips(trips);
      renderEditMap(false); // don't rezoom when dragging a waypoint
      renderWaypointList();
    });

    marker.on('click', () => openWaypointModal(wp.id));
    editMarkers.push(marker);
  });

  // rezoom
  if (rezoom && lls.length > 0) {
    map.fitBounds(L.latLngBounds(lls).pad(0.2));
  }
}

// ═══════════════════════════════════════════
// EDIT MODE — sidebar
// ═══════════════════════════════════════════

function renderTripList() {
  // Kept for backward compatibility (called by import handlers); delegates to populateTripSelector.
  populateTripSelector();
}

function renderWaypointList() {
  const trip  = getEditTrip();
  const $list = $('#waypoint-list').empty();
  if (!trip) return;
  trip.waypoints.forEach((wp, idx) => {
    const $name = wp.name
      ? $('<span class="wp-name">').text(wp.name)
      : $('<span class="wp-name">').append($('<em>').text('unnamed'));
    const $info = $('<div class="wp-info">').append($name);
    if (wp.desc) $info.append($('<span class="wp-desc">').text(wp.desc));
    $('<li class="wp-item">')
      .append(`<span class="wp-num">${idx + 1}</span>`)
      .append($info)
      .append(`<span class="wp-coords">${wp.lat.toFixed(4)}, ${wp.lng.toFixed(4)}</span>`)
      .on('click', () => openWaypointModal(wp.id))
      .appendTo($list);
  });
}

function openTripEdit(id) {
  editTripId = id;
  const trip = getEditTrip();
  if (!trip) {
    closeTripEdit();
    return;
  }

  $('#edit-no-trip-msg').addClass('hidden');
  $('#trip-edit-section').removeClass('hidden');
  $('#trip-edit-title').text(trip.name || 'Unnamed Trip');
  $('#trip-name-input').val(trip.name || '');
  $('#trip-selector').val(id);
  renderWaypointList();
  renderEditMap(true); // DO rezoom when opening a trip, to frame all its waypoints nicely
}

function closeTripEdit() {
  editTripId = null;
  clearEditLayers();
  $('#trip-edit-section').addClass('hidden');
  $('#edit-no-trip-msg').removeClass('hidden');
  populateTripSelector();
}

// ═══════════════════════════════════════════
// WAYPOINT MODAL
// ═══════════════════════════════════════════

let wpModalId = null;

function openWaypointModal(wpId) {
  const trip = getEditTrip();
  if (!trip) return;
  const wp = trip.waypoints.find(w => w.id === wpId);
  if (!wp) return;

  wpModalId = wpId;
  const idx = trip.waypoints.indexOf(wp);
  $('#wp-modal-title').text(`Waypoint ${idx + 1}`);
  $('#wp-name-input').val(wp.name || '');
  $('#wp-desc-input').val(wp.desc || '');
  $('#wp-modal').removeClass('hidden');
}

function closeWaypointModal() {
  wpModalId = null;
  $('#wp-modal').addClass('hidden');
}

function saveWaypointModal() {
  const trip = getEditTrip();
  if (!trip || !wpModalId) return;
  const wp = trip.waypoints.find(w => w.id === wpModalId);
  if (!wp) return;
  wp.name = $('#wp-name-input').val().trim();
  wp.desc = $('#wp-desc-input').val().trim();
  saveTrips(trips);
  renderWaypointList();
  renderEditMap(false); // don't rezoom when editing waypoint details
  closeWaypointModal();
}

function deleteWaypointInModal() {
  const trip = getEditTrip();
  if (!trip || !wpModalId) return;
  trip.waypoints = trip.waypoints.filter(w => w.id !== wpModalId);
  saveTrips(trips);
  renderWaypointList();
  renderEditMap(false);
  closeWaypointModal();
}

// ═══════════════════════════════════════════
// DRIVE MODE — map
// ═══════════════════════════════════════════

function clearDriveLayers() {
  driveWpMarkers.forEach(m => map.removeLayer(m));
  driveWpMarkers = [];
  if (drivePolyline)      { map.removeLayer(drivePolyline);      drivePolyline      = null; }
  if (drivePosMarker)     { map.removeLayer(drivePosMarker);     drivePosMarker     = null; }
  if (driveNearestMarker) { map.removeLayer(driveNearestMarker); driveNearestMarker = null; }
}

function renderDriveMap(trip) {
  clearDriveLayers();
  const lls = trip.waypoints.map(w => [w.lat, w.lng]);

  if (lls.length >= 2) {
    drivePolyline = L.polyline(lls, {
      color: '#2563eb', weight: 5, opacity: 0.85,
    }).addTo(map);
  }

  trip.waypoints.forEach((wp, idx) => {
    if (!wp.name) return; // skip unnamed waypoints to reduce clutter
    const m = L.circleMarker([wp.lat, wp.lng], {
      radius:      7,
      color:       '#1d4ed8',
      fillColor:   '#93c5fd',
      fillOpacity: 1,
      weight:      2,
    }).addTo(map).bindTooltip(
      `<b>${wp.name || 'WP ' + (idx + 1)}</b>${wp.desc ? '<br>' + wp.desc : ''}`,
    );
    driveWpMarkers.push(m);
  });

  if (lls.length > 0) {
    map.fitBounds(L.latLngBounds(lls).pad(0.15));
  }
}

// ═══════════════════════════════════════════
// DRIVE MODE — logic
// ═══════════════════════════════════════════

function populateTripSelector() {
  const $sel = $('#trip-selector');
  const prevVal = $sel.val();
  $sel.empty().append('<option value="">-- select a trip --</option>');
  trips.forEach(trip => {
    const n = trip.waypoints.length;
    $sel.append(
      `<option value="${trip.id}">${trip.name || 'Unnamed Trip'} ` +
      `(${n} waypoint${n !== 1 ? 's' : ''})</option>`,
    );
  });
  // Restore previous selection if the trip still exists.
  if (prevVal && trips.find(t => t.id === prevVal)) {
    $sel.val(prevVal);
  }
}

function updateDriveIdleSection() {
  const tripId = $('#trip-selector').val();
  const trip   = trips.find(t => t.id === tripId);
  let msg = null;
  if (!tripId || !trip) {
    msg = 'Select a trip above to start driving.';
  } else if (trip.waypoints.length < 2) {
    msg = 'This trip needs at least 2 waypoints to drive.';
  }
  if (msg !== null) {
    $('#drive-idle-msg').text(msg).removeClass('hidden');
    $('#btn-start-drive').addClass('hidden');
  } else {
    $('#drive-idle-msg').addClass('hidden');
    $('#btn-start-drive').removeClass('hidden');
  }
}

function startDrive() {
  const tripId = $('#trip-selector').val();
  if (!tripId) return;
  const trip = trips.find(t => t.id === tripId);
  if (!trip || trip.waypoints.length < 2) return;

  driveState = { tripId, watchId: null, posLatLng: null, lastInfo: null, testMode: false, gpsHistory: [] };

  $('#drive-idle-section').addClass('hidden');
  $('#drive-status-section').removeClass('hidden');
  $('#drive-trip-name').text(trip.name || 'Unnamed Trip');
  $('#btn-test-mode').text('🧪 Test mode: Off').addClass('secondary');
  $('#gps-label').text('Acquiring GPS…');
  $('#progress-card').addClass('hidden');
  $('#upcoming-waypoints').addClass('hidden');
  $('#metro-section').addClass('hidden');

  renderDriveMap(trip);

  // Draw the metro line straight away (without position info)
  renderMetroLine(trip, null);
  $('#metro-section').removeClass('hidden');

  if (!navigator.geolocation) {
    $('#gps-label').text('GPS not supported by this browser.');
    return;
  }

  driveState.watchId = navigator.geolocation.watchPosition(
    pos  => onGpsUpdate(pos),
    err  => { $('#gps-label').text('GPS error: ' + err.message); },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
  );
}

function stopDrive() {
  if (driveState && driveState.watchId !== null) {
    navigator.geolocation.clearWatch(driveState.watchId);
  }
  driveState = null;
  clearDriveLayers();

  $('#btn-test-mode').text('🧪 Test mode: Off').addClass('secondary');
  $('#drive-status-section').addClass('hidden');
  $('#metro-section').addClass('hidden');
  $('#metro-line-container').empty();

  if (mode === 'drive') {
    $('#drive-idle-section').removeClass('hidden');
    updateDriveIdleSection();
  }
}

function onGpsUpdate(geoPos, fromTest = false) {
  if (!driveState) return;
  // When test mode is active, ignore real GPS updates so the test position sticks
  if (driveState.testMode && !fromTest) return;
  const trip = trips.find(t => t.id === driveState.tripId);
  if (!trip) return;

  const posLL = L.latLng(geoPos.coords.latitude, geoPos.coords.longitude);
  driveState.posLatLng = posLL;

  // ── Update GPS history for speed calculation (keep last 15 s)
  const now = Date.now();
  driveState.gpsHistory.push({ ts: now, lat: posLL.lat, lng: posLL.lng });
  driveState.gpsHistory = driveState.gpsHistory.filter(p => now - p.ts <= 15000);

  // ── GPS label
  const acc = geoPos.coords.accuracy;
  if (fromTest) {
    $('#gps-label').html(
      `<span class="test-badge">🧪</span> ` +
      `${posLL.lat.toFixed(5)}, ${posLL.lng.toFixed(5)}`,
    );
  } else {
    $('#gps-label').html(
      `${posLL.lat.toFixed(5)}, ${posLL.lng.toFixed(5)} ` +
      `<small style="color:var(--muted)">±${Math.round(acc)}\u202fm</small>`,
    );
  }

  // ── Position marker on map
  if (!drivePosMarker) {
    const icon = L.divIcon({
      className: '', html: '<div class="pos-marker"></div>',
      iconSize: [20, 20], iconAnchor: [10, 10],
    });
    drivePosMarker = L.marker(posLL, { icon, zIndexOffset: 1000 }).addTo(map);
  } else {
    drivePosMarker.setLatLng(posLL);
  }

  // ── Geometry
  const info = nearestOnPath(posLL, trip.waypoints);
  if (!info) return;
  driveState.lastInfo = info;

  // Nearest-point marker
  if (!driveNearestMarker) {
    driveNearestMarker = L.circleMarker(info.nearestLatLng, {
      radius: 5, color: '#f59e0b', fillColor: '#fbbf24', fillOpacity: 1, weight: 2,
    }).addTo(map);
  } else {
    driveNearestMarker.setLatLng(info.nearestLatLng);
  }

  // ── Speed
  const speedMs  = computeSpeed(); // m/s or null
  const speedKmh = speedMs !== null ? speedMs * 3.6 : null;

  // ── Progress stats
  const pct       = info.totalDist > 0 ? (info.distAlong / info.totalDist) * 100 : 0;
  const remaining = info.totalDist - info.distAlong;

  $('#progress-card').removeClass('hidden');
  $('#stat-progress').text(fmtDist(info.distAlong));
  $('#stat-remaining').text(fmtDist(remaining));
  $('#stat-total').text(fmtDist(info.totalDist));
  $('#stat-speed').text(speedKmh !== null ? `${Math.round(speedKmh)}\u202fkm/h` : '—');
  $('#progress-bar').css('width', pct.toFixed(1) + '%');

  // ── Upcoming waypoints (up to 3)
  const upcoming = info.upcomingIndices.slice(0, 3).map(i => ({
    wp:   trip.waypoints[i],
    dist: info.cumDist[i] - info.distAlong,
  }));

  if (upcoming.length > 0) {
    const $list = $('#upcoming-list').empty();
    upcoming.forEach(({ wp, dist }) => {
      const $li = $('<li class="upcoming-item">')
        .append(`<span class="up-name">${wp.name || 'Waypoint'}</span>`)
        .append(`<span class="up-dist">in ${fmtDist(dist)}</span>`);
      if (speedMs !== null && speedMs > 0.5) {
        const etaStr = fmtEta(dist / speedMs);
        if (etaStr) $li.append(`<span class="up-eta">ETA: ${etaStr}</span>`);
      }
      if (wp.desc) $li.append(`<span class="up-desc">${wp.desc}</span>`);
      $list.append($li);
    });
    $('#upcoming-waypoints').removeClass('hidden');
  } else {
    $('#upcoming-waypoints').addClass('hidden');
  }

  // ── Metro line
  renderMetroLine(trip, info);
}

/**
 * Simulates a GPS position update from a map click in test mode.
 * Constructs a synthetic position object and forwards it to onGpsUpdate.
 */
function onTestPositionClick(latlng) {
  if (!driveState || !driveState.testMode) return;
  onGpsUpdate({
    coords: {
      latitude: latlng.lat, longitude: latlng.lng, accuracy: 0,
      altitude: null, altitudeAccuracy: null, heading: null, speed: null,
    },
  }, true);
}

// ═══════════════════════════════════════════
// METRO LINE
// ═══════════════════════════════════════════

/**
 * Renders an SVG "metro-line" style progress strip into #metro-line-container.
 *
 * @param {object}      trip  – the trip object (with waypoints)
 * @param {object|null} info  – result of nearestOnPath(), or null if no GPS yet
 */
function renderMetroLine(trip, info) {
  const $container = $('#metro-line-container');

  if (!trip || trip.waypoints.length < 2) {
    $container.empty();
    return;
  }

  const wps = trip.waypoints;
  const n   = wps.length;

  // ── Segment distances ──────────────────────────────────────
  const segDists = [];
  for (let i = 0; i < n - 1; i++) {
    segDists.push(turf.distance(
      [wps[i].lng, wps[i].lat],
      [wps[i + 1].lng, wps[i + 1].lat],
      { units: 'meters' }
    ));
  }
  const totalDist = segDists.reduce((s, d) => s + d, 0);

  // Cumulative distance to each waypoint, normalised to [0, 1]
  const cumDistNorm = [0];
  for (let i = 0; i < n - 1; i++) {
    cumDistNorm.push(cumDistNorm[i] + (totalDist > 0 ? segDists[i] / totalDist : 0));
  }

  // Fraction for each waypoint along the visual track
  const fractions = metroProp
    ? cumDistNorm                              // proportional to real distance
    : wps.map((_, i) => i / (n - 1));         // evenly spaced

  // ── Layout constants ───────────────────────────────────────
  // Two rows of labels, above and below the track
  const SVG_W   = 280;
  const PAD_H   = 28;   // horizontal padding so end-labels don't clip
  const TRACK_W = SVG_W - PAD_H * 2;
  const TRACK_Y = 52;   // y of the track line
  const DOT_R   = 7;    // waypoint circle radius
  const SVG_H   = 106;  // total SVG height
  const DIST_LABEL_Y = TRACK_Y + DOT_R + 13; // y for inter-segment distance labels

  // Progress fraction (0–1) along the track for current position.
  // In even mode the visual segments are equal-width, so we map the GPS
  // position using the segment index + intra-segment parameter rather than
  // the raw distance ratio.
  const progressFrac = info
    ? (metroProp
        ? (info.totalDist > 0 ? info.distAlong / info.totalDist : 0)
        : (n > 1 ? (info.segIdx + info.segT) / (n - 1) : 0))
    : null;

  // Has a waypoint been passed?
  function isPassed(idx) {
    return info !== null && info.cumDist && info.cumDist[idx] <= info.distAlong + WAYPOINT_PROXIMITY_THRESHOLD;
  }

  // ── Build SVG ─────────────────────────────────────────────
  const NS   = 'http://www.w3.org/2000/svg';

  function el(tag, attrs, text) {
    const e = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
    if (text !== undefined) e.textContent = text;
    return e;
  }

  const svg = el('svg', {
    width: '100%', viewBox: `0 0 ${SVG_W} ${SVG_H}`,
    style: 'display:block; overflow:visible',
  });

  // ── Background track ──
  svg.appendChild(el('line', {
    x1: PAD_H, y1: TRACK_Y, x2: PAD_H + TRACK_W, y2: TRACK_Y,
    stroke: '#cbd5e1', 'stroke-width': 5, 'stroke-linecap': 'round',
  }));

  // ── Completed portion ──
  if (progressFrac !== null) {
    svg.appendChild(el('line', {
      x1: PAD_H, y1: TRACK_Y,
      x2: PAD_H + TRACK_W * progressFrac, y2: TRACK_Y,
      stroke: '#2563eb', 'stroke-width': 5, 'stroke-linecap': 'round',
    }));
  }

  // ── Inter-segment distance labels (proportional mode only) ──
  if (metroProp) {
    for (let i = 0; i < n - 1; i++) {
      const x1 = PAD_H + TRACK_W * fractions[i];
      const x2 = PAD_H + TRACK_W * fractions[i + 1];
      const mx = (x1 + x2) / 2;
      // Only draw if there's reasonable horizontal room
      if (x2 - x1 > MIN_LABEL_WIDTH_PX) {
        svg.appendChild(el('text', {
          x: mx, y: DIST_LABEL_Y + 2,
          'text-anchor': 'middle', 'font-size': 8,
          fill: '#94a3b8', 'font-family': 'system-ui,sans-serif',
        }, fmtDist(segDists[i])));
      }
    }
  }

  // ── Waypoint dots + labels ──
  fractions.forEach((frac, idx) => {
    const cx      = PAD_H + TRACK_W * frac;
    const passed  = isPassed(idx);

    if (!wps[idx].name) return; // skip dots and labels for unnamed waypoints to reduce clutter

    // Dot
    svg.appendChild(el('circle', {
      cx, cy: TRACK_Y, r: DOT_R,
      fill:         passed ? '#93c5fd' : '#fff',
      stroke:       passed ? '#2563eb' : '#94a3b8',
      'stroke-width': 2.5,
    }));

    // Label: even indices above, odd below
    const above   = idx % 2 === 0;
    const labelY  = above
      ? TRACK_Y - DOT_R - 6
      : TRACK_Y + DOT_R + 14;
    const label   = wps[idx].name || `WP ${idx + 1}`;

    svg.appendChild(el('text', {
      x: cx, y: labelY,
      'text-anchor': 'middle', 'font-size': 9.5,
      fill: passed ? '#2563eb' : '#64748b',
      'font-weight': passed ? '600' : '400',
      'font-family': 'system-ui,sans-serif',
    }, label.length > 10 ? label.slice(0, 9) + '…' : label));
  });

  // ── Position indicator (filled circle + blinking ring) ──
  if (progressFrac !== null) {
    const px = PAD_H + TRACK_W * progressFrac;

    // Ring
    svg.appendChild(el('circle', {
      cx: px, cy: TRACK_Y, r: DOT_R + 5,
      fill: 'none', stroke: '#f59e0b', 'stroke-width': 2, opacity: 0.5,
    }));

    // Filled dot
    svg.appendChild(el('circle', {
      cx: px, cy: TRACK_Y, r: DOT_R - 1,
      fill: '#f59e0b', stroke: '#fff', 'stroke-width': 2,
    }));

    // Small "you are here" label
    svg.appendChild(el('text', {
      x: px, y: TRACK_Y - DOT_R - 9,
      'text-anchor': 'middle', 'font-size': 8.5,
      fill: '#b45309', 'font-weight': '600',
      'font-family': 'system-ui,sans-serif',
    }, '▼ you'));
  }

  $container.empty().append(svg);
}

// ═══════════════════════════════════════════
// METRO SPACING TOGGLE
// ═══════════════════════════════════════════

function refreshMetroLine() {
  if (!driveState) return;
  const trip = trips.find(t => t.id === driveState.tripId);
  renderMetroLine(trip, driveState.lastInfo);
}

// ═══════════════════════════════════════════
// EVENT BINDINGS  (runs after DOM is ready)
// ═══════════════════════════════════════════

$(function () {

  // ── Mode tabs ──────────────────────────────────────────────
  $('#btn-edit-mode').on('click', () => {
    if (driveState) stopDrive();
    mode = 'edit';
    $('#btn-edit-mode').addClass('active');
    $('#btn-drive-mode').removeClass('active');
    $('#edit-panel').removeClass('hidden');
    $('#drive-panel').addClass('hidden');
    // Open the selected trip in edit view (if any)
    const tripId = $('#trip-selector').val();
    if (tripId) {
      openTripEdit(tripId);
    }
  });

  $('#btn-drive-mode').on('click', () => {
    if (driveState) return; // already driving
    mode = 'drive';
    $('#btn-drive-mode').addClass('active');
    $('#btn-edit-mode').removeClass('active');
    $('#drive-panel').removeClass('hidden');
    $('#edit-panel').addClass('hidden');
    clearEditLayers();
    // Auto-start driving if a valid trip is selected
    const tripId = $('#trip-selector').val();
    const trip   = trips.find(t => t.id === tripId);
    if (tripId && trip && trip.waypoints.length >= 2) {
      startDrive();
    } else {
      $('#drive-status-section').addClass('hidden');
      $('#drive-idle-section').removeClass('hidden');
      updateDriveIdleSection();
    }
  });

  // ── Edit — new trip ────────────────────────────────────────
  $('#btn-new-trip').on('click', () => {
    const trip = { id: uid(), name: 'New Trip', waypoints: [] };
    trips.push(trip);
    saveTrips(trips);
    populateTripSelector();
    // Switch to edit mode for the new trip
    if (driveState) stopDrive();
    mode = 'edit';
    $('#btn-edit-mode').addClass('active');
    $('#btn-drive-mode').removeClass('active');
    $('#edit-panel').removeClass('hidden');
    $('#drive-panel').addClass('hidden');
    openTripEdit(trip.id);
  });

  // ── Edit — export trip ────────────────────────────────────
  $('#btn-export-trip').on('click', exportCurrentTrip);

  // ── Share modal ───────────────────────────────────────────
  function copyWithFeedback($btn, text, label, $target) {
    if (window.isSecureContext && navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        $btn.text('Copied!');
        setTimeout(() => $btn.text(label), 2000);
      }).catch(() => {
        if ($target) $target[0].select();
      });
    } else {
      if ($target) $target[0].select();
    }
  }

  $('#btn-copy-url').on('click', function () {
    copyWithFeedback($(this), $('#share-url-input').val(), 'Copy', $('#share-url-input'));
  });

  $('#btn-copy-text').on('click', function () {
    copyWithFeedback($(this), $('#share-text-input').val(), '📋 Copy text', $('#share-text-input'));
  });

  $('#share-modal-close').on('click', () => $('#share-modal').addClass('hidden'));

  $('#share-modal').on('click', function (e) {
    if ($(e.target).is('#share-modal')) $('#share-modal').addClass('hidden');
  });

  // ── Import from text ──────────────────────────────────────
  $('#btn-import-text').on('click', () => {
    $('#import-text-input').val('');
    $('#import-text-modal').removeClass('hidden');
  });

  $('#btn-import-text-go').on('click', () => {
    const text = $('#import-text-input').val().trim();
    if (!text) return;
    const data = decodeTripFromText(text);
    if (!data || typeof data.name !== 'string' || !data.name.trim() ||
        !Array.isArray(data.waypoints) || data.waypoints.length === 0) {
      alert('Could not read the trip from the text – the data may be invalid or corrupted.');
      return;
    }
    $('#import-text-modal').addClass('hidden');

    // Reuse the import confirmation modal.
    const n         = data.waypoints.length;
    const existing  = trips.find(t => t.name === data.name);
    const renamedTo = uniqueTripName(data.name);
    pendingImport = { data, existing, renamedTo };

    if (existing) {
      $('#import-modal-desc').text(
        `A trip named "${data.name}" (${n} waypoint${n !== 1 ? 's' : ''}) already exists in your list.`,
      );
      $('#import-modal-add').hide();
      $('#import-modal-overwrite').show().text(`Overwrite "${existing.name}"`);
      $('#import-modal-rename').show().text(`Import as "${renamedTo}"`);
    } else {
      $('#import-modal-desc').text(
        `Import trip "${data.name}" with ${n} waypoint${n !== 1 ? 's' : ''}?`,
      );
      $('#import-modal-add').show();
      $('#import-modal-overwrite').hide();
      $('#import-modal-rename').hide();
    }
    $('#import-modal').removeClass('hidden');
  });

  $('#btn-import-text-cancel').on('click', () => $('#import-text-modal').addClass('hidden'));

  $('#import-text-modal').on('click', function (e) {
    if ($(e.target).is('#import-text-modal')) $('#import-text-modal').addClass('hidden');
  });

  // ── Import modal ──────────────────────────────────────────
  $('#import-modal-add').on('click', () => {
    if (!pendingImport) return;
    doImport(pendingImport.data.name, null);
  });

  $('#import-modal-overwrite').on('click', () => {
    if (!pendingImport || !pendingImport.existing) return;
    doImport(pendingImport.data.name, pendingImport.existing.id);
  });

  $('#import-modal-rename').on('click', () => {
    if (!pendingImport) return;
    doImport(pendingImport.renamedTo, null);
  });

  $('#import-modal-cancel').on('click', () => {
    pendingImport = null;
    $('#import-modal').addClass('hidden');
  });

  // Click outside the import modal box to dismiss
  $('#import-modal').on('click', function (e) {
    if ($(e.target).is('#import-modal')) {
      pendingImport = null;
      $('#import-modal').addClass('hidden');
    }
  });

  // ── Edit — delete ─────────────────────────────────────────
  $('#btn-delete-trip').on('click', () => {
    if (!editTripId) return;
    if (!confirm('Delete this trip and all its waypoints?')) return;
    trips = trips.filter(t => t.id !== editTripId);
    saveTrips(trips);
    closeTripEdit();
    // Clear selector since the trip is now gone
    $('#trip-selector').val('');
  });

  // ── Edit — trip name ───────────────────────────────────────
  $('#trip-name-input').on('input', function () {
    const trip = getEditTrip();
    if (!trip) return;
    trip.name = $(this).val().trim();
    $('#trip-edit-title').text(trip.name || 'Unnamed Trip');
    saveTrips(trips);
    populateTripSelector();
    // Restore selection after repopulating
    $('#trip-selector').val(editTripId);
  });

  // ── Edit — click map to add waypoint ──────────────────────
  map.on('click', e => {
    // In drive test mode, a click repositions the simulated GPS location
    if (mode === 'drive' && driveState && driveState.testMode) {
      onTestPositionClick(e.latlng);
      return;
    }
    if (mode !== 'edit' || !editTripId) return;
    const trip = getEditTrip();
    if (!trip) return;
    const wp = { id: uid(), lat: e.latlng.lat, lng: e.latlng.lng, name: '', desc: '' };
    trip.waypoints.push(wp);
    saveTrips(trips);
    renderWaypointList();
    renderEditMap(false); // don't rezoom when adding a new waypoint
    //openWaypointModal(wp.id);
  });

  // ── Waypoint modal ────────────────────────────────────────
  $('#wp-modal-save').on('click',   saveWaypointModal);
  $('#wp-modal-cancel').on('click', closeWaypointModal);
  $('#wp-modal-delete').on('click', deleteWaypointInModal);

  // Click outside modal box to dismiss
  $('#wp-modal').on('click', function (e) {
    if ($(e.target).is('#wp-modal')) closeWaypointModal();
  });

  // ── Drive ─────────────────────────────────────────────────
  $('#trip-selector').on('change', function () {
    const tripId = $(this).val();
    if (mode === 'edit') {
      if (tripId) {
        openTripEdit(tripId);
      } else {
        closeTripEdit();
      }
    } else if (mode === 'drive') {
      if (driveState) stopDrive();
      const trip = trips.find(t => t.id === tripId);
      if (tripId && trip && trip.waypoints.length >= 2) {
        startDrive();
      } else {
        $('#drive-idle-section').removeClass('hidden');
        updateDriveIdleSection();
      }
    }
  });

  $('#btn-start-drive').on('click', startDrive);
  $('#btn-stop-drive').on('click',  stopDrive);

  // ── Drive — test mode ─────────────────────────────────────
  $('#btn-test-mode').on('click', function () {
    if (!driveState) return;
    driveState.testMode = !driveState.testMode;
    if (driveState.testMode) {
      $(this).text('🧪 Test mode: On').removeClass('secondary');
      $('#gps-label').text('Click the map to set a test position…');
    } else {
      $(this).text('🧪 Test mode: Off').addClass('secondary');
      $('#gps-label').text('Acquiring GPS…');
    }
  });

  // ── Metro spacing toggle ──────────────────────────────────
  $('#btn-metro-proportional').on('click', function () {
    if (metroProp) return;
    metroProp = true;
    $(this).addClass('active');
    $('#btn-metro-even').removeClass('active');
    refreshMetroLine();
  });

  $('#btn-metro-even').on('click', function () {
    if (!metroProp) return;
    metroProp = false;
    $(this).addClass('active');
    $('#btn-metro-proportional').removeClass('active');
    refreshMetroLine();
  });

  // ── Initialise ────────────────────────────────────────────
  populateTripSelector();
  importTripFromUrl();
});
