import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import { bezierSpline } from '@turf/bezier-spline';
import {
  CircleHelp,
  Download,
  LocateFixed,
  Map as MapIcon,
  MapPin,
  MapPinned,
  PanelLeftClose,
  PanelLeftOpen,
  Satellite,
  Search,
  Upload,
  X,
} from 'lucide-react';
import 'maplibre-gl/dist/maplibre-gl.css';
import './App.css';
import ALIMOSHO_AREAS from './alimoshoAreas';
import { createAreaPolygons } from './areaBoundaries';
import { createCustomAreaFeatures, findAreaAtCoordinate } from './customArea';
import {
  createSampleHouses,
  filterHousesToBounds,
  inspectHouseCsv,
  parseHouseCsv,
  STORAGE_KEY,
} from './houses';
import { getRoutePointRejectionReason, MAX_ROUTE_ACCURACY_METERS } from './routeTracking';
import SurveyPanel from './SurveyPanel';
import {
  countHousesInsideSurveyBoundary,
  createSurveyFeatureCollection,
  DEFAULT_SURVEY_COLOR,
  getSurveyMetrics,
  readSavedSurveyAreas,
  SURVEY_AREAS_STORAGE_KEY,
  validateSurveyBoundary,
} from './survey';

maplibregl.setWorkerUrl('/maplibre-gl-worker.mjs');

const INITIAL_CENTER = [3.2575876, 6.5843883];
const ALIMOSHO_BOUNDS = [[3.1960886, 6.4784701], [3.3145752, 6.6904704]];
const ROAD_LABEL_LAYERS = ['roadname_minor', 'roadname_sec', 'roadname_pri', 'roadname_major'];
const EMPTY_FEATURE_COLLECTION = { type: 'FeatureCollection', features: [] };

function getHouseLocalGovernment(house) {
  return String(house.localGovernment || 'Alimosho').trim();
}
const CSV_FIELD_CONFIG = [
  { key: 'name', label: 'House name' },
  { key: 'houseNumber', label: 'House number' },
  { key: 'latitude', label: 'Latitude', required: true },
  { key: 'longitude', label: 'Longitude', required: true },
  { key: 'address', label: 'Address' },
  { key: 'area', label: 'Area' },
  { key: 'street', label: 'Street' },
  { key: 'status', label: 'Registration status' },
];

function normalizeStreetName(name) {
  return name.toLowerCase().replace(/[\s-]+/g, '');
}

function sortAreaNames(first, second) {
  return first.localeCompare(second, undefined, { sensitivity: 'base', numeric: true });
}

function mergeStreetLists(first, second) {
  const streets = new Map();
  [...first, ...second].forEach((street) => {
    const key = normalizeStreetName(street.name);
    if (!streets.has(key) || (!streets.get(key).center && street.center)) streets.set(key, street);
  });
  return Array.from(streets.values()).sort((firstStreet, secondStreet) => firstStreet.name.localeCompare(secondStreet.name));
}

function collectLineCoordinates(coordinates, result = []) {
  if (!Array.isArray(coordinates)) return result;
  if (typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number') {
    result.push(coordinates);
    return result;
  }
  coordinates.forEach((coordinate) => collectLineCoordinates(coordinate, result));
  return result;
}

function getStreetCenter(feature) {
  const coordinates = collectLineCoordinates(feature.geometry.coordinates);
  if (coordinates.length === 0) return null;

  const longitudes = coordinates.map(([longitude]) => longitude);
  const latitudes = coordinates.map(([, latitude]) => latitude);
  return [
    (Math.min(...longitudes) + Math.max(...longitudes)) / 2,
    (Math.min(...latitudes) + Math.max(...latitudes)) / 2,
  ];
}

function fitMapToArea(map, area, padding = 72, maxZoom = 16) {
  const coordinates = collectLineCoordinates(area.geometry.coordinates);
  if (coordinates.length === 0) return;

  const bounds = new maplibregl.LngLatBounds();
  coordinates.forEach((coordinate) => bounds.extend(coordinate));
  map.fitBounds(bounds, { padding, maxZoom, duration: 700 });
}

function getVisibleStreetNames(map) {
  const layers = ROAD_LABEL_LAYERS.filter((layer) => map.getLayer(layer));
  if (layers.length === 0) return [];

  const streets = new Map();
  map.queryRenderedFeatures(undefined, { layers }).forEach((feature) => {
    const name = String(feature.properties?.name || feature.properties?.name_en || '').trim();
    if (!name) return;
    const key = normalizeStreetName(name);
    if (!streets.has(key)) streets.set(key, { name, center: getStreetCenter(feature) });
  });

  return Array.from(streets.values()).sort((first, second) => first.name.localeCompare(second.name));
}

function enhanceRoadContrast(map) {
  const roadColors = {
    mot: '#b27d1e',
    trunk: '#b28b3c',
    pri: '#9e8c58',
    sec: '#748278',
  };
  const roadWidths = {
    mot: [1.6, 3.6],
    trunk: [1.4, 3.1],
    pri: [1.2, 2.7],
    sec: [0.8, 1.6],
  };
  map.getStyle().layers.forEach((layer) => {
    const roadType = layer.id.match(/^road_(mot|trunk|pri|sec)_fill_/i)?.[1];
    if (roadType && layer.type === 'line') {
      map.setPaintProperty(layer.id, 'line-color', roadColors[roadType]);
      map.setPaintProperty(layer.id, 'line-opacity', 0.88);
      map.setPaintProperty(layer.id, 'line-width', [
        'interpolate', ['linear'], ['zoom'],
        9, roadWidths[roadType][0],
        14, roadWidths[roadType][1],
      ]);
    }
  });

  const labelColors = {
    roadname_minor: '#58675d',
    roadname_sec: '#46574b',
    roadname_pri: '#354a3a',
    roadname_major: '#243c2b',
  };
  Object.entries(labelColors).forEach(([layer, color]) => {
    if (!map.getLayer(layer)) return;
    map.setPaintProperty(layer, 'text-color', color);
    map.setPaintProperty(layer, 'text-halo-color', '#f7f6f0');
    map.setPaintProperty(layer, 'text-halo-width', 1.25);
  });
}

function updateAreaLabelFilter(map, selectedArea = '', selectedGovernment = 'Alimosho') {
  const localityLabelLayer = 'lagos-locality-labels';

  if (map.getLayer('alimosho-area-labels')) {
    const zoom = map.getZoom();
    if (zoom >= 14) {
      map.setFilter('alimosho-area-labels', selectedArea
        ? ['any', ['==', ['get', 'name'], selectedArea], ['==', ['get', 'priority'], 3]]
        : ['==', ['get', 'priority'], 3]);
    } else if (zoom >= 12) {
      map.setFilter('alimosho-area-labels', selectedArea
        ? ['any', ['==', ['get', 'name'], selectedArea], ['>=', ['get', 'priority'], 2]]
        : ['>=', ['get', 'priority'], 2]);
    } else {
      map.setFilter('alimosho-area-labels', null);
    }
  }

  if (!map.getLayer(localityLabelLayer)) return;
  const localityFilter = selectedGovernment
    ? ['==', ['get', 'localGovernment'], selectedGovernment]
    : ['==', ['get', 'localGovernment'], ''];

  if (!selectedArea || selectedGovernment === 'Alimosho') {
    map.setFilter(localityLabelLayer, localityFilter);
    return;
  }

  const zoom = map.getZoom();
  if (zoom >= 11) {
    map.setFilter(localityLabelLayer, ['all', localityFilter, ['==', ['get', 'name'], selectedArea]]);
  } else {
    map.setFilter(localityLabelLayer, null);
  }
}

function readSavedHouses() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function createFeatureCollection(houses) {
  return {
    type: 'FeatureCollection',
    features: houses.map((house) => ({
      type: 'Feature',
      properties: {
        id: house.id,
        name: house.name,
        houseNumber: house.houseNumber,
        area: house.area,
        status: house.status,
        localGovernment: getHouseLocalGovernment(house),
      },
      geometry: {
        type: 'Point',
        coordinates: [house.longitude, house.latitude],
      },
    })),
  };
}

function createSmoothAreaOutline(area) {
  const polygons = area.geometry.type === 'Polygon'
    ? [area.geometry.coordinates]
    : area.geometry.coordinates;

  return {
    type: 'FeatureCollection',
    features: polygons.flatMap((rings) => rings.map((coordinates) => ({
      ...bezierSpline({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates },
      }, { sharpness: 0.35 }),
      properties: area.properties,
    }))),
  };
}

function createPopupContent(house) {
  const content = document.createElement('div');
  content.className = 'house-popup';

  const title = document.createElement('strong');
  title.textContent = house.name;
  content.appendChild(title);

  const details = [house.houseNumber && `No. ${house.houseNumber}`, house.status, house.area, house.street, house.address]
    .filter(Boolean)
    .join(' / ');
  if (details) {
    const detailLine = document.createElement('span');
    detailLine.textContent = details;
    content.appendChild(detailLine);
  }

  const coordinates = document.createElement('span');
  coordinates.className = 'popup-coordinates';
  coordinates.textContent = `${house.latitude.toFixed(5)}, ${house.longitude.toFixed(5)}`;
  content.appendChild(coordinates);
  return content;
}

function fitMapToHouses(map, houses) {
  if (!map || houses.length === 0) return;

  if (houses.length === 1) {
    map.flyTo({
      center: [houses[0].longitude, houses[0].latitude],
      zoom: 15,
      duration: 700,
    });
    return;
  }

  const bounds = new maplibregl.LngLatBounds();
  houses.forEach((house) => bounds.extend([house.longitude, house.latitude]));
  map.fitBounds(bounds, { padding: 88, maxZoom: 15, duration: 700 });
}

function downloadTemplate() {
  const csv = 'name,houseNumber,latitude,longitude,address,area,street,status\n';
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'alimosho-houses-template.csv';
  link.click();
  URL.revokeObjectURL(url);
}

function App() {
  const [initialSurveyState] = useState(() => {
    const areas = readSavedSurveyAreas();
    const activeArea = areas[areas.length - 1] || null;
    return { areas, activeArea };
  });
  const [houses, setHouses] = useState(readSavedHouses);
  const [search, setSearch] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all');
  const [areaFilter, setAreaFilter] = useState('all');
  const [dateFilter, setDateFilter] = useState('any');
  const [isImportOpen, setImportOpen] = useState(false);
  const [isCustomDialogOpen, setCustomDialogOpen] = useState(false);
  const [customCoordinates, setCustomCoordinates] = useState([]);
  const [customCoordinateError, setCustomCoordinateError] = useState('');
  const [customArea, setCustomArea] = useState(null);
  const [savedSurveyAreas, setSavedSurveyAreas] = useState(initialSurveyState.areas);
  const [activeSurveyId, setActiveSurveyId] = useState(initialSurveyState.activeArea?.id || null);
  const [activeSurveyPoints, setActiveSurveyPoints] = useState(initialSurveyState.activeArea?.points || []);
  const [surveyClosed, setSurveyClosed] = useState(Boolean(initialSurveyState.activeArea?.closed));
  const [surveyName, setSurveyName] = useState(initialSurveyState.activeArea?.name || '');
  const [surveyColor, setSurveyColor] = useState(initialSurveyState.activeArea?.color || DEFAULT_SURVEY_COLOR);
  const [captureMovementAsBoundary, setCaptureMovementAsBoundary] = useState(false);
  const [surveyMapMode, setSurveyMapMode] = useState('idle');
  const [selectedSurveyPointIndex, setSelectedSurveyPointIndex] = useState(null);
  const [isSurveyPanelCollapsed, setSurveyPanelCollapsed] = useState(false);
  const [isCapturingSurveyGps, setCapturingSurveyGps] = useState(false);
  const [surveySaveError, setSurveySaveError] = useState('');
  const [surveyStorageError, setSurveyStorageError] = useState('');
  const [csvDraft, setCsvDraft] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedArea, setSelectedArea] = useState('');
  const [mapStreetNames, setMapStreetNames] = useState([]);
  const [globalStreetNames, setGlobalStreetNames] = useState([]);
  const [streetLookupComplete, setStreetLookupComplete] = useState(false);
  const [importMessage, setImportMessage] = useState('');
  const [mapReady, setMapReady] = useState(false);
  const [isMapRecentering, setMapRecentering] = useState(false);
  const [userLocation, setUserLocation] = useState(null);
  const [isTrackingLocation, setTrackingLocation] = useState(false);
  const [routePoints, setRoutePoints] = useState([]);
  const [isFollowingLocation, setFollowingLocation] = useState(true);
  const [trackingStatus, setTrackingStatus] = useState('');
  const [locationError, setLocationError] = useState('');
  const [isCsvParsing, setCsvParsing] = useState(false);
  const [isSidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mapStyleMode, setMapStyleMode] = useState('street');
  const [localGovernments, setLocalGovernments] = useState([]);
  const [localGovernmentAreaPoints, setLocalGovernmentAreaPoints] = useState(new Map());
  const [selectedLocalGovernment, setSelectedLocalGovernment] = useState('Alimosho');
  const [areaOverlayColor, setAreaOverlayColor] = useState(() => {
    try {
      const saved = window.localStorage.getItem('areaOverlayColor')
        || window.localStorage.getItem('areaBoundaryColor');
      return /^#[\da-f]{6}$/i.test(saved || '') ? saved : '#9bdfa5';
    } catch {
      return '#9bdfa5';
    }
  });
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const userLocationMarkerRef = useRef(null);
  const routePointsRef = useRef([]);
  const locationWatchIdRef = useRef(null);
  const locationStartPendingRef = useRef(false);
  const baseStyleLayersRef = useRef([]);
  const localGovernmentBoundariesRef = useRef(null);
  const localGovernmentAreaPointsRef = useRef(new Map());
  const housesRef = useRef(houses);
  const popupRef = useRef(null);
  const customCoordinatePopupRef = useRef(null);
  const fileInputRef = useRef(null);
  const streetRequestRef = useRef(0);
  const handleAreaSelectRef = useRef(null);
  const handleImportedAreaSelectRef = useRef(null);
  const handleLocalGovernmentSelectRef = useRef(null);
  const selectedAreaRef = useRef(selectedArea);
  const selectedLocalGovernmentRef = useRef(selectedLocalGovernment);
  const customAreaRef = useRef(customArea);
  const areaOverlayColorRef = useRef(areaOverlayColor);
  const areaPolygonsRef = useRef(null);
  const areaPolygonsByGovernmentRef = useRef(new Map());
  const updateHouseSourceRef = useRef(null);
  const csvParseRequestRef = useRef(0);
  const surveyMapModeRef = useRef('idle');
  const activeSurveyPointsRef = useRef([]);
  const activeSurveyIdRef = useRef(null);
  const selectedSurveyPointIndexRef = useRef(null);
  const surveyMapClickHandlersRef = useRef({});
  const captureMovementAsBoundaryRef = useRef(false);
  selectedAreaRef.current = selectedArea;
  selectedLocalGovernmentRef.current = selectedLocalGovernment;
  customAreaRef.current = customArea;
  areaOverlayColorRef.current = areaOverlayColor;
  surveyMapModeRef.current = surveyMapMode;
  activeSurveyPointsRef.current = activeSurveyPoints;
  activeSurveyIdRef.current = activeSurveyId;
  selectedSurveyPointIndexRef.current = selectedSurveyPointIndex;
  captureMovementAsBoundaryRef.current = captureMovementAsBoundary;

  function updateSurveyPoints(points) {
    activeSurveyPointsRef.current = points;
    setActiveSurveyPoints(points);
  }

  function changeSurveyMapMode(mode) {
    surveyMapModeRef.current = mode;
    setSurveyMapMode(mode);
    if (mode === 'add') {
      selectedSurveyPointIndexRef.current = null;
      setSelectedSurveyPointIndex(null);
    }
  }

  function addSurveyPoint(point) {
    updateSurveyPoints([...activeSurveyPointsRef.current, point]);
    setSurveyClosed(false);
    setSurveySaveError('');
  }

  function updateSelectedSurveyPoint(index) {
    selectedSurveyPointIndexRef.current = index;
    setSelectedSurveyPointIndex(index);
    changeSurveyMapMode(index === null ? 'idle' : 'move');
  }

  surveyMapClickHandlersRef.current = { addSurveyPoint, updateSurveyPoint: updateSurveyPoints, updateSelectedSurveyPoint };

  function captureSurveyGpsPoint() {
    if (!navigator.geolocation || !window.isSecureContext) {
      setLocationError('GPS capture requires browser location support and a secure connection (HTTPS or localhost).');
      return;
    }

    setCapturingSurveyGps(true);
    setLocationError('');
    try {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const point = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
            timestamp: Number.isFinite(position.timestamp) ? position.timestamp : Date.now(),
            source: 'gps',
          };
          if (
            !Number.isFinite(point.latitude)
            || point.latitude < -90
            || point.latitude > 90
            || !Number.isFinite(point.longitude)
            || point.longitude < -180
            || point.longitude > 180
            || !Number.isFinite(point.accuracy)
            || point.accuracy < 0
          ) {
            setLocationError('The device returned an invalid GPS reading. No boundary point was added.');
            setCapturingSurveyGps(false);
            return;
          }
          setUserLocation(point);
          addSurveyPoint(point);
          setCapturingSurveyGps(false);
        },
        (error) => {
          const messages = {
            1: 'Location permission was denied. Allow location access for this site in your browser settings.',
            2: 'Your current location is unavailable. Check device location services and try again.',
            3: 'GPS capture timed out. Move to an open area and try again.',
          };
          setLocationError(messages[error.code] || error.message || 'Unable to capture the device GPS location.');
          setCapturingSurveyGps(false);
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
      );
    } catch (error) {
      setLocationError(error.message || 'Unable to request the device GPS location.');
      setCapturingSurveyGps(false);
    }
  }

  function removeSurveyPoint(index) {
    updateSurveyPoints(activeSurveyPointsRef.current.filter((_, pointIndex) => pointIndex !== index));
    if (selectedSurveyPointIndexRef.current === index) updateSelectedSurveyPoint(null);
    else if (selectedSurveyPointIndexRef.current > index) {
      updateSelectedSurveyPoint(selectedSurveyPointIndexRef.current - 1);
    }
  }

  function saveSurveyBoundary() {
    const validation = validateSurveyBoundary(activeSurveyPoints, surveyClosed);
    if (validation.status !== 'closed') {
      setSurveySaveError(validation.reason || 'Close a valid boundary before saving.');
      return;
    }
    const id = activeSurveyId || `survey-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const area = {
      id,
      name: surveyName.trim() || `Survey area ${savedSurveyAreas.length + (activeSurveyId ? 0 : 1)}`,
      points: activeSurveyPoints,
      color: surveyColor,
      closed: true,
      savedAt: new Date().toISOString(),
    };
    setSavedSurveyAreas((current) => (
      current.some((savedArea) => savedArea.id === id)
        ? current.map((savedArea) => (savedArea.id === id ? area : savedArea))
        : [...current, area]
    ));
    activeSurveyIdRef.current = id;
    setActiveSurveyId(id);
    setSurveyName(area.name);
    setSurveySaveError('');
  }

  function plotSurveyArea() {
    setSurveyClosed(true);
    setSurveySaveError('');
    changeSurveyMapMode('idle');

    if (activeSurveyPoints.length >= 2) {
      const coordinates = activeSurveyPoints.map(({ longitude, latitude }) => [longitude, latitude]);
      fitMapToArea(mapRef.current, {
        geometry: {
          type: 'LineString',
          coordinates: [...coordinates, coordinates[0]],
        },
      }, 80, 18);
    }
  }

  function selectSavedSurveyArea(id) {
    if (!id) {
      if (activeSurveyPointsRef.current.length && !activeSurveyIdRef.current
        && !window.confirm('Discard the current unsaved boundary and start a blank draft?')) return;
      activeSurveyIdRef.current = null;
      setActiveSurveyId(null);
      updateSurveyPoints([]);
      setSurveyClosed(false);
      setSurveyName('');
      setSurveyColor(DEFAULT_SURVEY_COLOR);
      updateSelectedSurveyPoint(null);
      return;
    }
    const area = savedSurveyAreas.find((savedArea) => savedArea.id === id);
    if (!area) return;
    if (
      activeSurveyPointsRef.current.length
      && !activeSurveyIdRef.current
      && !window.confirm('Discard the current unsaved boundary and open this saved area?')
    ) return;
    activeSurveyIdRef.current = area.id;
    setActiveSurveyId(area.id);
    updateSurveyPoints(area.points);
    setSurveyClosed(area.closed);
    setSurveyName(area.name);
    setSurveyColor(/^#[\da-f]{6}$/i.test(area.color || '') ? area.color : DEFAULT_SURVEY_COLOR);
    updateSelectedSurveyPoint(null);
    setSurveySaveError('');
  }

  function startNewSurvey() {
    if (activeSurveyPointsRef.current.length && !activeSurveyIdRef.current) {
      setSurveySaveError('Save the current boundary or clear its points before starting a new survey.');
      return;
    }
    activeSurveyIdRef.current = null;
    setActiveSurveyId(null);
    updateSurveyPoints([]);
    setSurveyClosed(false);
    setSurveyName('');
    setSurveyColor(DEFAULT_SURVEY_COLOR);
    setSurveySaveError('');
    updateSelectedSurveyPoint(null);
    changeSurveyMapMode('add');
  }

  function toggleUserLocation() {
    if (locationStartPendingRef.current) {
      locationStartPendingRef.current = false;
      setTrackingLocation(false);
      setTrackingStatus('Location tracking cancelled.');
      return;
    }

    if (locationWatchIdRef.current !== null) {
      navigator.geolocation.clearWatch(locationWatchIdRef.current);
      locationWatchIdRef.current = null;
      setTrackingLocation(false);
      setTrackingStatus('Tracking paused. Recorded route points are preserved.');
      return;
    }

    if (!navigator.geolocation || !window.isSecureContext) {
      setLocationError('Location access requires a secure connection and browser geolocation support.');
      return;
    }

    setLocationError('');
    setTrackingStatus('Checking location permission…');
    setTrackingLocation(true);
    locationStartPendingRef.current = true;

    const startWatching = () => {
      if (!locationStartPendingRef.current) return;
      locationStartPendingRef.current = false;
      setTrackingStatus('Waiting for a GPS fix from this device…');
      try {
        locationWatchIdRef.current = navigator.geolocation.watchPosition(
        (position) => {
          const point = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
            timestamp: Number.isFinite(position.timestamp) ? position.timestamp : Date.now(),
          };
          if (
            !Number.isFinite(point.latitude)
            || point.latitude < -90
            || point.latitude > 90
            || !Number.isFinite(point.longitude)
            || point.longitude < -180
            || point.longitude > 180
            || !Number.isFinite(point.accuracy)
            || point.accuracy < 0
          ) {
            setLocationError('The device returned an invalid location reading. Waiting for a valid GPS fix.');
            setTrackingStatus('Invalid GPS fix received. Waiting for another reading.');
            return;
          }
          setUserLocation(point);
          const lastRoutePoint = routePointsRef.current[routePointsRef.current.length - 1];
          const rejectionReason = getRoutePointRejectionReason(lastRoutePoint, point);
          if (!rejectionReason) {
            const updatedPoints = [...routePointsRef.current, point];
            routePointsRef.current = updatedPoints;
            setRoutePoints(updatedPoints);
            if (captureMovementAsBoundaryRef.current) {
              surveyMapClickHandlersRef.current.addSurveyPoint({ ...point, source: 'gps-track' });
            }
            setTrackingStatus(lastRoutePoint
              ? `Movement recorded · GPS updated ${new Date(point.timestamp).toLocaleTimeString()}.`
              : `GPS fix received · route started ${new Date(point.timestamp).toLocaleTimeString()}.`);
          } else if (rejectionReason === 'inaccurate') {
            setTrackingStatus(`GPS is updating, but accuracy is ±${Math.round(point.accuracy)} m. Route points need accuracy of ${MAX_ROUTE_ACCURACY_METERS} m or better.`);
          } else if (rejectionReason === 'jump') {
            setTrackingStatus('GPS is updating, but an implausible jump was ignored. Waiting for a stable reading.');
          } else {
            setTrackingStatus(`GPS updated ${new Date(point.timestamp).toLocaleTimeString()} · waiting for measurable movement.`);
          }
          setLocationError('');
        },
        (error) => {
          const messages = {
            1: 'Location permission was denied. Allow location access for this site in your browser settings, then retry.',
            2: 'Your current location is unavailable. Check your device location settings and try again.',
            3: 'Finding your location timed out. Try again in a moment.',
          };
          setLocationError(messages[error.code] || error.message || 'Unable to access your location.');
          setTrackingStatus('');
          if (locationWatchIdRef.current !== null) {
            navigator.geolocation.clearWatch(locationWatchIdRef.current);
            locationWatchIdRef.current = null;
          }
          setTrackingLocation(false);
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
      );
      } catch (error) {
        setLocationError(error.message || 'Unable to start location tracking.');
        setTrackingStatus('');
        setTrackingLocation(false);
      }
    };

    if (navigator.permissions?.query) {
      navigator.permissions.query({ name: 'geolocation' })
        .then((permission) => {
          if (permission.state === 'denied') {
            locationStartPendingRef.current = false;
            setLocationError('Location access is blocked for this site. Allow location in the browser site settings and check that device location services are on.');
            setTrackingStatus('');
            setTrackingLocation(false);
            return;
          }
          startWatching();
        }, startWatching);
      return;
    }
    startWatching();
  }

  function centerOnCurrentLocation() {
    if (!userLocation || !mapRef.current) return;
    mapRef.current.flyTo({
      center: [userLocation.longitude, userLocation.latitude],
      zoom: 16,
      duration: 700,
    });
  }

  function fitRecordedRoute() {
    const map = mapRef.current;
    if (!map || routePoints.length === 0) return;
    if (routePoints.length === 1) {
      map.flyTo({
        center: [routePoints[0].longitude, routePoints[0].latitude],
        zoom: 16,
        duration: 700,
      });
      return;
    }
    const bounds = new maplibregl.LngLatBounds();
    routePoints.forEach((point) => bounds.extend([point.longitude, point.latitude]));
    map.fitBounds(bounds, { padding: 80, maxZoom: 16, duration: 700 });
  }

  function getAreaPolygonsForGovernment(localGovernment) {
    const cached = areaPolygonsByGovernmentRef.current.get(localGovernment);
    if (cached) return cached;

    const boundary = localGovernmentBoundariesRef.current?.features.find(
      (feature) => feature.properties.localGovernment === localGovernment,
    );
    if (!boundary) return null;
    const areas = localGovernment === 'Alimosho'
      ? ALIMOSHO_AREAS
      : {
        type: 'FeatureCollection',
        features: localGovernmentAreaPointsRef.current.get(localGovernment) || [],
      };
    if (areas.features.length < 2) return null;

    const polygons = createAreaPolygons(areas, boundary);
    if (!polygons.features.length) return null;
    areaPolygonsByGovernmentRef.current.set(localGovernment, polygons);
    return polygons;
  }

  function handleAreaSelect(area, map = mapRef.current) {
    const areaName = area.properties.name;
    const requestId = streetRequestRef.current + 1;
    streetRequestRef.current = requestId;
    setSelectedArea(areaName);
    setMapStreetNames([]);
    setStreetLookupComplete(false);
    setMapRecentering(Boolean(map));
    mapContainerRef.current?.closest('.map-frame')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!map) {
      setStreetLookupComplete(true);
      setMapRecentering(false);
      return;
    }

    updateAreaLabelFilter(map, areaName, selectedLocalGovernmentRef.current);
    const selectedPolygon = areaPolygonsRef.current?.features.find(
      (feature) => feature.properties.name === areaName,
    );
    if (selectedPolygon) {
      map.getSource('selected-area-fill-data')?.setData({
        type: 'FeatureCollection',
        features: [selectedPolygon],
      });
      map.getSource('selected-area-outline-data')?.setData(createSmoothAreaOutline(selectedPolygon));
      fitMapToArea(map, selectedPolygon);
    } else {
      map.getSource('selected-area-fill-data')?.setData(EMPTY_FEATURE_COLLECTION);
      map.getSource('selected-area-outline-data')?.setData({ type: 'FeatureCollection', features: [] });
      map.flyTo({ center: area.geometry.coordinates, zoom: 14, duration: 700 });
    }
    map.once('idle', () => {
      setMapRecentering(false);
      if (streetRequestRef.current !== requestId) return;
      const visibleStreets = getVisibleStreetNames(map);
      setMapStreetNames(visibleStreets);
      setGlobalStreetNames((current) => mergeStreetLists(current, visibleStreets));
      setStreetLookupComplete(true);
    });
  }
  handleAreaSelectRef.current = handleAreaSelect;

  function handleAllAreas() {
    streetRequestRef.current += 1;
    setSelectedArea('');
    setMapStreetNames([]);
    setStreetLookupComplete(false);
    if (mapRef.current) updateAreaLabelFilter(mapRef.current, '', selectedLocalGovernmentRef.current);
    mapRef.current?.getSource('selected-area-fill-data')?.setData(EMPTY_FEATURE_COLLECTION);
    mapRef.current?.getSource('selected-area-outline-data')?.setData({ type: 'FeatureCollection', features: [] });
    const selectedBoundary = localGovernmentBoundariesRef.current?.features.find(
      (feature) => feature.properties.localGovernment === selectedLocalGovernmentRef.current,
    );
    if (selectedBoundary) {
      setMapRecentering(true);
      mapRef.current?.once('idle', () => setMapRecentering(false));
      fitMapToArea(mapRef.current, selectedBoundary);
    }
    else if (selectedLocalGovernmentRef.current === 'Alimosho') {
      mapRef.current?.fitBounds(ALIMOSHO_BOUNDS, { padding: 48, maxZoom: 11.5, duration: 700 });
    }
  }

  function handleLocalGovernmentSelect(localGovernment) {
    if (!localGovernment || localGovernment === selectedLocalGovernmentRef.current) return;
    selectedLocalGovernmentRef.current = localGovernment;
    setSelectedLocalGovernment(localGovernment);
    setSelectedArea('');
    setMapStreetNames([]);
    setGlobalStreetNames([]);
    setStreetLookupComplete(false);
    setSearch('');
    setStatusFilter('all');
    setAreaFilter('all');
    setDateFilter('any');

    const map = mapRef.current;
    if (!map) return;
    setMapRecentering(true);

    const filter = ['==', ['get', 'localGovernment'], localGovernment];
    ['alimosho-boundary-fill', 'alimosho-boundary-outline'].forEach((layer) => {
      if (map.getLayer(layer)) map.setFilter(layer, filter);
    });
    const isAlimosho = localGovernment === 'Alimosho';
    if (map.getLayer('alimosho-area-labels')) {
      map.setLayoutProperty('alimosho-area-labels', 'visibility', isAlimosho ? 'visible' : 'none');
    }
    ['locality-area-fill', 'locality-area-boundaries'].forEach((layer) => {
      if (map.getLayer(layer)) map.setLayoutProperty(layer, 'visibility', 'visible');
    });
    if (map.getLayer('lagos-locality-labels')) {
      map.setFilter('lagos-locality-labels', filter);
      map.setLayoutProperty('lagos-locality-labels', 'visibility', isAlimosho ? 'none' : 'visible');
    }
    areaPolygonsRef.current = getAreaPolygonsForGovernment(localGovernment);
    map.getSource('locality-area-polygons')?.setData(areaPolygonsRef.current || EMPTY_FEATURE_COLLECTION);
    map.getSource('selected-area-fill-data')?.setData(EMPTY_FEATURE_COLLECTION);
    map.getSource('selected-area-outline-data')?.setData(EMPTY_FEATURE_COLLECTION);

    const selectedBoundary = localGovernmentBoundariesRef.current?.features.find(
      (feature) => feature.properties.localGovernment === localGovernment,
    );
    if (selectedBoundary) {
      map.once('idle', () => setMapRecentering(false));
      fitMapToArea(map, selectedBoundary);
    } else {
      setMapRecentering(false);
    }
  }
  handleLocalGovernmentSelectRef.current = handleLocalGovernmentSelect;

  function handleImportedAreaSelect(areaName) {
    const locality = (localGovernmentAreaPointsRef.current.get(selectedLocalGovernmentRef.current) || [])
      .find((feature) => feature.properties.name.toLowerCase() === areaName.toLowerCase());
    if (locality) {
      handleAreaSelect(locality);
      return;
    }

    setSelectedArea(areaName);
    setMapStreetNames([]);
    setStreetLookupComplete(true);
    const areaHouses = housesRef.current.filter((house) => getHouseLocalGovernment(house) === selectedLocalGovernmentRef.current
      && String(house.area || '').trim().toLowerCase() === areaName.toLowerCase());
    if (areaHouses.length > 0) {
      setMapRecentering(true);
      mapRef.current?.once('idle', () => setMapRecentering(false));
      fitMapToHouses(mapRef.current, areaHouses);
      return;
    }
  }
  handleImportedAreaSelectRef.current = handleImportedAreaSelect;

  function openCustomDialog() {
    setCustomCoordinates(customArea
      ? customArea.coordinates.map(({ latitude, longitude }) => ({
        latitude: String(latitude),
        longitude: String(longitude),
      }))
      : Array.from({ length: 3 }, () => ({ latitude: '', longitude: '' })));
    setCustomCoordinateError('');
    setCustomDialogOpen(true);
  }

  function closeCustomDialog() {
    setCustomDialogOpen(false);
    setCustomCoordinateError('');
  }

  function submitCustomArea(event) {
    event.preventDefault();
    if (customCoordinates.length < 3) {
      setCustomCoordinateError('Enter at least three coordinate pairs to create a boundary.');
      return;
    }

    const coordinates = customCoordinates.map(({ latitude, longitude }) => ({
      latitude: Number(latitude),
      longitude: Number(longitude),
    }));
    if (customCoordinates.some(({ latitude, longitude }, index) => (
      !latitude.trim()
      || !longitude.trim()
      || !Number.isFinite(coordinates[index].latitude)
      || !Number.isFinite(coordinates[index].longitude)
      || coordinates[index].latitude < -90
      || coordinates[index].latitude > 90
      || coordinates[index].longitude < -180
      || coordinates[index].longitude > 180
    ))) {
      setCustomCoordinateError('Enter valid latitudes (-90 to 90) and longitudes (-180 to 180) for every point.');
      return;
    }

    const uniqueCoordinates = new Set(coordinates.map(({ latitude, longitude }) => `${latitude},${longitude}`));
    const area = coordinates.reduce((total, coordinate, index) => {
      const next = coordinates[(index + 1) % coordinates.length];
      return total + coordinate.longitude * next.latitude - next.longitude * coordinate.latitude;
    }, 0);
    if (uniqueCoordinates.size < 3 || Math.abs(area) < 1e-10) {
      setCustomCoordinateError('Use at least three distinct points that form a boundary.');
      return;
    }

    setSelectedArea('');
    selectedAreaRef.current = '';
    setMapStreetNames([]);
    setStreetLookupComplete(false);
    const map = mapRef.current;
    if (map) {
      updateAreaLabelFilter(map, '', selectedLocalGovernmentRef.current);
      map.getSource('selected-area-fill-data')?.setData(EMPTY_FEATURE_COLLECTION);
      map.getSource('selected-area-outline-data')?.setData(EMPTY_FEATURE_COLLECTION);
    }
    setCustomArea({
      coordinates,
      areaName: '',
      localGovernment: '',
      areaLookupComplete: false,
    });
    closeCustomDialog();
  }

  function clearCustomArea() {
    setCustomArea(null);
    mapRef.current?.getSource('custom-area-data')?.setData(EMPTY_FEATURE_COLLECTION);
  }

  useEffect(() => {
    housesRef.current = houses;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(houses));
    } catch {
      setImportMessage('This browser could not save the imported records.');
    }
  }, [houses]);

  useEffect(() => {
    if (!mapContainerRef.current) return undefined;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
      center: INITIAL_CENTER,
      zoom: 11,
      attributionControl: false,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.AttributionControl({
      compact: true,
      customAttribution: 'LGA boundaries: geoBoundaries / GRID3, CC BY 4.0',
    }), 'bottom-right');

    map.on('load', () => {
      map.getStyle().layers
        .filter((layer) => layer.id.startsWith('place_'))
        .forEach((layer) => map.setLayoutProperty(layer.id, 'visibility', 'none'));
      enhanceRoadContrast(map);
      baseStyleLayersRef.current = map.getStyle().layers.map((layer) => ({
        id: layer.id,
        visibility: map.getLayoutProperty(layer.id, 'visibility') || 'visible',
      }));

      map.addSource('location-route-data', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      });
      map.addLayer({
        id: 'location-route-line',
        type: 'line',
        source: 'location-route-data',
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#2478d0', 'line-width': 4, 'line-opacity': 0.88 },
      });
      map.addLayer({
        id: 'location-route-start',
        type: 'circle',
        source: 'location-route-data',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 7,
          'circle-color': '#2e8050',
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 2,
        },
      });

      map.addSource('alimosho-boundary', {
        type: 'geojson',
        data: '/alimosho-boundary.geojson',
      });
      map.addSource('lagos-local-governments', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      });
      map.addLayer({
        id: 'lagos-lga-context',
        type: 'line',
        source: 'lagos-local-governments',
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-color': '#718778',
          'line-opacity': 0.42,
          'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.6, 12, 1.1],
        },
      });
      map.addLayer({
        id: 'alimosho-boundary-fill',
        type: 'fill',
        source: 'lagos-local-governments',
        filter: ['==', ['get', 'localGovernment'], 'Alimosho'],
        paint: {
          'fill-color': '#397d53',
          'fill-opacity': 0.16,
        },
      });
      map.addLayer({
        id: 'alimosho-boundary-outline',
        type: 'line',
        source: 'lagos-local-governments',
        filter: ['==', ['get', 'localGovernment'], 'Alimosho'],
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-color': '#9bdfa5',
          'line-opacity': 0.96,
          'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.25, 14, 2.25],
        },
      });
      map.addSource('alimosho-areas', {
        type: 'geojson',
        data: ALIMOSHO_AREAS,
      });
      map.addSource('lagos-locality-points', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      });
      map.addSource('locality-area-polygons', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'locality-area-fill',
        type: 'fill',
        source: 'locality-area-polygons',
        paint: {
          'fill-color': '#9bdfa5',
          'fill-opacity': 0.07,
        },
      });
      map.addSource('selected-area-fill-data', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      });
      map.addLayer({
        id: 'selected-area-fill',
        type: 'fill',
        source: 'selected-area-fill-data',
        paint: {
          'fill-color': '#9bdfa5',
          'fill-opacity': 0.3,
        },
      });
      map.addLayer({
        id: 'locality-area-boundaries',
        type: 'line',
        source: 'locality-area-polygons',
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-color': '#9bdfa5',
          'line-opacity': 0.56,
          'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.6, 14, 1],
          'line-dasharray': [2, 2],
        },
      });
      map.addSource('selected-area-outline-data', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'selected-area-outline',
        type: 'line',
        source: 'selected-area-outline-data',
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-color': '#a56e00',
          'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.25, 14, 2],
          'line-dasharray': [2, 2],
          'line-opacity': 1,
        },
      });
      map.addSource('custom-area-data', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      });
      map.addLayer({
        id: 'custom-area-fill',
        type: 'fill',
        source: 'custom-area-data',
        filter: ['==', ['get', 'kind'], 'custom-area'],
        paint: {
          'fill-color': areaOverlayColorRef.current,
          'fill-opacity': 0.42,
        },
      });
      map.addLayer({
        id: 'custom-area-outline',
        type: 'line',
        source: 'custom-area-data',
        filter: ['==', ['get', 'kind'], 'custom-area'],
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-color': areaOverlayColorRef.current,
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 14, 5],
          'line-opacity': 1,
        },
      });
      map.addLayer({
        id: 'custom-area-vertices',
        type: 'circle',
        source: 'custom-area-data',
        filter: ['==', ['get', 'kind'], 'custom-vertex'],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 6, 14, 9],
          'circle-color': areaOverlayColorRef.current,
          'circle-stroke-color': '#fffdf5',
          'circle-stroke-width': 2.5,
        },
      });
      map.addSource('survey-boundaries', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      });
      map.addLayer({
        id: 'survey-area-fill',
        type: 'fill',
        source: 'survey-boundaries',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: {
          'fill-color': ['coalesce', ['get', 'color'], DEFAULT_SURVEY_COLOR],
          'fill-opacity': 0.3,
        },
      });
      map.addLayer({
        id: 'survey-boundary-lines',
        type: 'line',
        source: 'survey-boundaries',
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['coalesce', ['get', 'color'], DEFAULT_SURVEY_COLOR],
          'line-width': ['case', ['get', 'active'], 4, 2.5],
          'line-opacity': 0.95,
        },
      });
      map.addLayer({
        id: 'survey-boundary-vertices',
        type: 'circle',
        source: 'survey-boundaries',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': ['case', ['get', 'active'], 8, 6],
          'circle-color': ['coalesce', ['get', 'color'], DEFAULT_SURVEY_COLOR],
          'circle-stroke-color': '#fffdf5',
          'circle-stroke-width': 2.5,
        },
      });
      map.addLayer({
        id: 'alimosho-area-labels',
        type: 'symbol',
        source: 'alimosho-areas',
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Open Sans Semibold', 'Arial Unicode MS Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10, 13, 13],
          'text-offset': [0, 0.7],
          'text-allow-overlap': false,
          'symbol-sort-key': ['-', ['get', 'priority']],
        },
        paint: {
          'text-color': '#1d3d28',
          'text-halo-color': '#f7f6f0',
          'text-halo-width': 1.6,
        },
      });
      map.addLayer({
        id: 'lagos-locality-labels',
        type: 'symbol',
        source: 'lagos-locality-points',
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Open Sans Semibold', 'Arial Unicode MS Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 8, 9, 12, 12],
          'text-offset': [0, 0.7],
          'text-allow-overlap': false,
          'symbol-sort-key': ['-', ['get', 'priority']],
          'visibility': 'none',
        },
        paint: {
          'text-color': '#173f2b',
          'text-halo-color': '#f7f6f0',
          'text-halo-width': 1.3,
        },
      });
      map.on('zoomend', () => updateAreaLabelFilter(map, selectedAreaRef.current, selectedLocalGovernmentRef.current));
      const rebuildAreaPolygons = () => {
        areaPolygonsRef.current = getAreaPolygonsForGovernment(selectedLocalGovernmentRef.current);
        map.getSource('locality-area-polygons')?.setData(areaPolygonsRef.current || EMPTY_FEATURE_COLLECTION);

        const selectedPolygon = areaPolygonsRef.current?.features.find(
          (feature) => feature.properties.name === selectedAreaRef.current,
        );
        map.getSource('selected-area-outline-data')?.setData(
          selectedPolygon ? createSmoothAreaOutline(selectedPolygon) : EMPTY_FEATURE_COLLECTION,
        );
        map.getSource('selected-area-fill-data')?.setData(
          selectedPolygon
            ? { type: 'FeatureCollection', features: [selectedPolygon] }
            : EMPTY_FEATURE_COLLECTION,
        );
      };
      map.addSource('houses', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
        cluster: true,
        clusterMaxZoom: 15,
        clusterRadius: 38,
      });

      map.addLayer({
        id: 'house-clusters',
        type: 'circle',
        source: 'houses',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': '#285b49',
          'circle-radius': ['step', ['get', 'point_count'], 17, 25, 21, 100, 26],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      });
      map.addLayer({
        id: 'house-cluster-count',
        type: 'symbol',
        source: 'houses',
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['get', 'point_count_abbreviated'],
          'text-font': ['Open Sans Semibold', 'Arial Unicode MS Regular'],
          'text-size': 12,
        },
        paint: { 'text-color': '#ffffff' },
      });
      map.addLayer({
        id: 'house-points',
        type: 'circle',
        source: 'houses',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': '#d56f4b',
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 5, 15, 9],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      });
      const updateHouseSource = () => {
        const source = map.getSource('houses');
        if (!source) return;

        const bounds = map.getBounds();
        const visibleHouses = filterHousesToBounds(
          housesRef.current,
          [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
          selectedLocalGovernmentRef.current,
          selectedAreaRef.current,
        );
        source.setData(createFeatureCollection(visibleHouses));
      };
      updateHouseSourceRef.current = updateHouseSource;
      map.on('moveend', updateHouseSource);
      map.on('resize', updateHouseSource);

      map.on('click', 'house-clusters', (event) => {
        const features = map.queryRenderedFeatures(event.point, { layers: ['house-clusters'] });
        const clusterId = features[0]?.properties?.cluster_id;
        const source = map.getSource('houses');
        if (clusterId === undefined || !source) return;
        source.getClusterExpansionZoom(clusterId, (error, zoom) => {
          if (error) return;
          map.easeTo({ center: features[0].geometry.coordinates, zoom });
        });
      });

      map.on('click', 'alimosho-area-labels', (event) => {
        const feature = map.queryRenderedFeatures(event.point, { layers: ['alimosho-area-labels'] })[0];
        const area = ALIMOSHO_AREAS.features.find((item) => item.properties.name === feature?.properties?.name);
        if (!area) return;
        handleAreaSelectRef.current?.(area, map);
      });
      map.on('click', 'lagos-locality-labels', (event) => {
        const feature = map.queryRenderedFeatures(event.point, { layers: ['lagos-locality-labels'] })[0];
        const areaName = feature?.properties?.name;
        if (!areaName) return;
        handleImportedAreaSelectRef.current?.(areaName);
      });

      fetch('/lagos-local-governments.geojson')
        .then((response) => {
          if (!response.ok) throw new Error('Failed to load Lagos local government boundaries.');
          return response.json();
        })
        .then((boundaries) => {
          localGovernmentBoundariesRef.current = boundaries;
          setLocalGovernments(boundaries.features
            .map((feature) => feature.properties.localGovernment)
            .sort((first, second) => first.localeCompare(second)));
          map.getSource('lagos-local-governments')?.setData(boundaries);
          const selectedBoundary = boundaries.features.find(
            (feature) => feature.properties.localGovernment === selectedLocalGovernmentRef.current,
          );
          if (selectedBoundary && !customAreaRef.current) fitMapToArea(map, selectedBoundary);
          rebuildAreaPolygons();
        })
        .catch((error) => console.error('Unable to load Lagos local government boundaries.', error));

      fetch('/lagos-locality-points.geojson')
        .then((response) => {
          if (!response.ok) throw new Error('Failed to load Lagos locality points.');
          return response.json();
        })
        .then((localities) => {
          const grouped = new Map();
          localities.features.forEach((feature) => {
            const localGovernment = feature.properties?.localGovernment;
            if (!localGovernment) return;
            const group = grouped.get(localGovernment) || [];
            group.push(feature);
            grouped.set(localGovernment, group);
          });
          localGovernmentAreaPointsRef.current = grouped;
          setLocalGovernmentAreaPoints(grouped);
          map.getSource('lagos-locality-points')?.setData(localities);
          if (selectedLocalGovernmentRef.current !== 'Alimosho') {
            map.setFilter('lagos-locality-labels', ['==', ['get', 'localGovernment'], selectedLocalGovernmentRef.current]);
            map.setLayoutProperty('lagos-locality-labels', 'visibility', 'visible');
          }
          rebuildAreaPolygons();
        })
        .catch((error) => console.error('Unable to load Lagos locality points.', error));

      map.on('click', 'house-points', (event) => {
        const feature = map.queryRenderedFeatures(event.point, { layers: ['house-points'] })[0];
        const id = feature?.properties?.id;
        const house = housesRef.current.find((record) => String(record.id) === String(id));
        if (!house) return;
        setSelectedId(house.id);
        popupRef.current?.remove();
        popupRef.current = new maplibregl.Popup({ closeButton: true, offset: 13 })
          .setLngLat([house.longitude, house.latitude])
          .setDOMContent(createPopupContent(house))
          .addTo(map);
      });

      const showCustomCoordinatePopup = (event) => {
        const feature = event.features?.[0];
        if (!feature) return;
        const [longitude, latitude] = feature.geometry.coordinates;
        const content = document.createElement('div');
        content.className = 'custom-coordinate-popup';
        content.textContent = `Point ${feature.properties.index} · Lat ${latitude.toFixed(5)}, Lng ${longitude.toFixed(5)}`;

        if (!customCoordinatePopupRef.current) {
          customCoordinatePopupRef.current = new maplibregl.Popup({
            closeButton: false,
            closeOnClick: false,
            closeOnMove: false,
            offset: 12,
          });
        }
        customCoordinatePopupRef.current
          .setLngLat([longitude, latitude])
          .setDOMContent(content)
          .addTo(map);
      };
      map.on('mouseenter', 'custom-area-vertices', (event) => {
        map.getCanvas().style.cursor = 'pointer';
        showCustomCoordinatePopup(event);
      });
      map.on('mousemove', 'custom-area-vertices', showCustomCoordinatePopup);
      map.on('mouseleave', 'custom-area-vertices', () => {
        map.getCanvas().style.cursor = '';
        customCoordinatePopupRef.current?.remove();
        customCoordinatePopupRef.current = null;
      });

      map.on('click', (event) => {
        const mode = surveyMapModeRef.current;
        if (mode === 'add') {
          surveyMapClickHandlersRef.current.addSurveyPoint({
            latitude: event.lngLat.lat,
            longitude: event.lngLat.lng,
            source: 'map',
          });
          return;
        }
        if (mode === 'move' && selectedSurveyPointIndexRef.current !== null) {
          const pointIndex = selectedSurveyPointIndexRef.current;
          const points = activeSurveyPointsRef.current.map((point, index) => (
            index === pointIndex
              ? { latitude: event.lngLat.lat, longitude: event.lngLat.lng, source: 'map' }
              : point
          ));
          surveyMapClickHandlersRef.current.updateSurveyPoint(points);
          surveyMapClickHandlersRef.current.updateSelectedSurveyPoint(null);
          setSurveySaveError('');
        }
      });

      ['house-clusters', 'house-points', 'alimosho-area-labels', 'lagos-locality-labels'].forEach((layer) => {
        map.on('mouseenter', layer, () => {
          map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', layer, () => {
          map.getCanvas().style.cursor = '';
        });
      });
      map.fitBounds(ALIMOSHO_BOUNDS, { padding: 48, maxZoom: 11.5, duration: 0 });
      updateAreaLabelFilter(map, selectedAreaRef.current, selectedLocalGovernmentRef.current);
      map.once('idle', () => setGlobalStreetNames(getVisibleStreetNames(map)));
      map.once('idle', updateHouseSource);
      setMapReady(true);
    });

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => map.resize());
    if (resizeObserver) resizeObserver.observe(mapContainerRef.current);

    return () => {
      resizeObserver?.disconnect();
      if (locationWatchIdRef.current !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(locationWatchIdRef.current);
      }
      locationWatchIdRef.current = null;
      userLocationMarkerRef.current?.remove();
      userLocationMarkerRef.current = null;
      popupRef.current?.remove();
      customCoordinatePopupRef.current?.remove();
      map.remove();
      mapRef.current = null;
      updateHouseSourceRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !userLocation) return;

    if (!userLocationMarkerRef.current) {
      const markerElement = document.createElement('div');
      markerElement.className = 'user-location-marker';
      markerElement.setAttribute('aria-label', 'Your current location');
      userLocationMarkerRef.current = new maplibregl.Marker({
        element: markerElement,
        anchor: 'center',
      }).setLngLat([userLocation.longitude, userLocation.latitude]).addTo(map);
    }
    userLocationMarkerRef.current.setLngLat([userLocation.longitude, userLocation.latitude]);

    if (isFollowingLocation) {
      map.flyTo({ center: [userLocation.longitude, userLocation.latitude], zoom: 16, duration: 700 });
    }
  }, [isFollowingLocation, mapReady, userLocation]);

  useEffect(() => {
    const routeSource = mapRef.current?.getSource('location-route-data');
    if (!mapReady || !routeSource) return;

    const features = [];
    if (routePoints.length > 1) {
      features.push({
        type: 'Feature',
        properties: { kind: 'route' },
        geometry: {
          type: 'LineString',
          coordinates: routePoints.map((point) => [point.longitude, point.latitude]),
        },
      });
    }
    if (routePoints.length > 0) {
      const startingPoint = routePoints[0];
      features.push({
        type: 'Feature',
        properties: { kind: 'start' },
        geometry: {
          type: 'Point',
          coordinates: [startingPoint.longitude, startingPoint.latitude],
        },
      });
    }
    routeSource.setData({ type: 'FeatureCollection', features });
  }, [mapReady, routePoints]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !customArea) return;

    const features = createCustomAreaFeatures(customArea.coordinates);
    map.getSource('custom-area-data')?.setData(features);
    setMapRecentering(true);
    map.once('idle', () => setMapRecentering(false));
    const localGovernmentBoundary = customArea.areaLookupComplete
      ? localGovernmentBoundariesRef.current?.features.find(
        (feature) => feature.properties.localGovernment === customArea.localGovernment,
      )
      : null;
    fitMapToArea(map, localGovernmentBoundary || features.features[0], 24, 18);
  }, [customArea, mapReady]);

  useEffect(() => {
    if (!customArea || !localGovernments.length || localGovernmentAreaPoints.size === 0) return;

    const boundary = findAreaAtCoordinate(
      customArea.coordinates[0].latitude,
      customArea.coordinates[0].longitude,
      localGovernmentBoundariesRef.current?.features || [],
    );
    const localGovernment = boundary?.properties.localGovernment || '';
    const areaPolygons = localGovernment ? getAreaPolygonsForGovernment(localGovernment) : null;
    const area = areaPolygons
      ? findAreaAtCoordinate(
        customArea.coordinates[0].latitude,
        customArea.coordinates[0].longitude,
        areaPolygons.features,
      )
      : null;
    const areaName = area?.properties.name || '';

    if (localGovernment) handleLocalGovernmentSelectRef.current?.(localGovernment);

    if (
      customArea.areaLookupComplete
      && customArea.localGovernment === localGovernment
      && customArea.areaName === areaName
    ) return;

    setCustomArea((current) => current && current.coordinates === customArea.coordinates
      ? { ...current, areaName, localGovernment, areaLookupComplete: true }
      : current);
  }, [customArea, localGovernments, localGovernmentAreaPoints]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;

    if (mapStyleMode === 'satellite') {
      baseStyleLayersRef.current.forEach(({ id }) => {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
      });
      if (!map.getSource('satellite-imagery')) {
        map.addSource('satellite-imagery', {
          type: 'raster',
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
          tileSize: 256,
          attribution: 'Tiles &copy; Esri',
        });
        map.addLayer({ id: 'satellite-imagery-layer', type: 'raster', source: 'satellite-imagery' }, 'alimosho-boundary-fill');
        map.addSource('satellite-reference', {
          type: 'raster',
          tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
          tileSize: 256,
          attribution: 'Labels &copy; Esri',
        });
        map.addLayer({ id: 'satellite-reference-layer', type: 'raster', source: 'satellite-reference' }, 'alimosho-boundary-fill');
      }
      return;
    }

    ['satellite-reference-layer', 'satellite-imagery-layer'].forEach((layer) => {
      if (map.getLayer(layer)) map.removeLayer(layer);
    });
    ['satellite-reference', 'satellite-imagery'].forEach((source) => {
      if (map.getSource(source)) map.removeSource(source);
    });
    baseStyleLayersRef.current.forEach(({ id, visibility }) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
    });
  }, [mapReady, mapStyleMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;

    if (map.getLayer('selected-area-fill')) {
      map.setPaintProperty('selected-area-fill', 'fill-color', areaOverlayColor);
    }
    if (map.getLayer('custom-area-fill')) {
      map.setPaintProperty('custom-area-fill', 'fill-color', areaOverlayColor);
    }
    if (map.getLayer('custom-area-outline')) {
      map.setPaintProperty('custom-area-outline', 'line-color', areaOverlayColor);
    }
    if (map.getLayer('custom-area-vertices')) {
      map.setPaintProperty('custom-area-vertices', 'circle-color', areaOverlayColor);
    }
    try {
      window.localStorage.setItem('areaOverlayColor', areaOverlayColor);
    } catch (error) {
      console.warn('Unable to save the selected area overlay color preference.', error);
    }
  }, [areaOverlayColor, mapReady]);

  useEffect(() => {
    updateHouseSourceRef.current?.();
  }, [houses, selectedArea, selectedLocalGovernment]);

  useEffect(() => {
    if (!activeSurveyId) return;
    setSavedSurveyAreas((current) => {
      const savedArea = current.find((area) => area.id === activeSurveyId);
      if (!savedArea) return current;
      if (
        savedArea.name === (surveyName.trim() || savedArea.name)
        && savedArea.closed === surveyClosed
        && savedArea.color === surveyColor
        && JSON.stringify(savedArea.points) === JSON.stringify(activeSurveyPoints)
      ) return current;
      return current.map((area) => (area.id === activeSurveyId
        ? {
          ...area,
          name: surveyName.trim() || area.name,
          points: activeSurveyPoints,
          color: surveyColor,
          closed: surveyClosed,
        }
        : area));
    });
  }, [activeSurveyId, activeSurveyPoints, surveyClosed, surveyName, surveyColor]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SURVEY_AREAS_STORAGE_KEY, JSON.stringify(savedSurveyAreas));
      setSurveyStorageError('');
    } catch (error) {
      console.error('Unable to persist saved survey boundaries.', error);
      setSurveyStorageError('This browser could not save survey areas. Check available storage and try again.');
    }
  }, [savedSurveyAreas]);

  useEffect(() => {
    const source = mapRef.current?.getSource('survey-boundaries');
    if (!mapReady || !source) return;
    const activeArea = activeSurveyPoints.length ? {
      id: activeSurveyId || 'current-draft',
      name: surveyName,
      points: activeSurveyPoints,
      color: surveyColor,
      closed: surveyClosed,
    } : null;
    source.setData(createSurveyFeatureCollection(savedSurveyAreas, activeArea));
  }, [activeSurveyId, activeSurveyPoints, mapReady, savedSurveyAreas, surveyClosed, surveyName, surveyColor]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !activeSurveyId || activeSurveyPoints.length < 2) return;
    const coordinates = activeSurveyPoints.map(({ longitude, latitude }) => [longitude, latitude]);
    fitMapToArea(map, {
      geometry: {
        type: 'LineString',
        coordinates: surveyClosed ? [...coordinates, coordinates[0]] : coordinates,
      },
    }, 80, 18);
  }, [activeSurveyId, activeSurveyPoints, mapReady, surveyClosed]);

  const normalizedSearch = search.trim().toLowerCase();
  const normalizedSelectedArea = selectedArea.trim().toLowerCase();
  const localGovernmentAreaNames = selectedLocalGovernment === 'Alimosho'
    ? ALIMOSHO_AREAS.features.map((area) => area.properties.name).sort(sortAreaNames)
    : Array.from(new Set((localGovernmentAreaPoints.get(selectedLocalGovernment) || [])
      .map((feature) => feature.properties.name)))
      .sort(sortAreaNames);
  const localGovernmentHouses = houses.filter(
    (house) => getHouseLocalGovernment(house) === selectedLocalGovernment,
  );
  const surveyValidation = validateSurveyBoundary(activeSurveyPoints, surveyClosed);
  const savedActiveSurvey = Boolean(activeSurveyId && savedSurveyAreas.some((area) => area.id === activeSurveyId));
  const surveyBoundaryStatus = surveyValidation.status === 'closed' && savedActiveSurvey && !surveyStorageError
    ? 'saved'
    : surveyValidation.status;
  const surveyMetrics = getSurveyMetrics(activeSurveyPoints, surveyClosed, surveyValidation);
  const surveyHouseCount = houses.length;
  const surveyHousesInside = surveyValidation.status === 'closed'
    ? countHousesInsideSurveyBoundary(houses, activeSurveyPoints, surveyClosed)
    : null;
  const surveyHousesOutside = surveyHousesInside === null ? null : surveyHouseCount - surveyHousesInside;
  const selectedAreaHouses = normalizedSelectedArea
    ? localGovernmentHouses.filter((house) => String(house.area || '').trim().toLowerCase() === normalizedSelectedArea)
    : [];
  const houseCountsByArea = localGovernmentHouses.reduce((counts, house) => {
    const areaKey = String(house.area || '').trim().toLowerCase();
    if (areaKey) counts.set(areaKey, (counts.get(areaKey) || 0) + 1);
    return counts;
  }, new Map());
  const namedAreaKeys = selectedLocalGovernment === 'Alimosho'
    ? new Set(ALIMOSHO_AREAS.features.map((area) => area.properties.name.toLowerCase()))
    : new Set(localGovernmentAreaNames.map((area) => area.toLowerCase()));
  const coveredAreaKeys = new Set(Array.from(houseCountsByArea.keys()).filter((area) => namedAreaKeys.has(area)));
  const coveragePercent = selectedLocalGovernment === 'Alimosho'
    ? Math.round((coveredAreaKeys.size / namedAreaKeys.size) * 100)
    : Math.round((coveredAreaKeys.size / Math.max(namedAreaKeys.size, 1)) * 100);
  const recentCutoff = Date.now() - 30 * 86400000;
  const recentHouses = localGovernmentHouses.filter((house) => Number.isFinite(Date.parse(house.addedAt || ''))
    && Date.parse(house.addedAt) >= recentCutoff);
  const recentlyUpdatedAreaCount = new Set(recentHouses
    .map((house) => String(house.area || '').trim().toLowerCase())
    .filter(Boolean)).size;
  const areaOptions = Array.from(new Set([
    ...localGovernmentAreaNames,
    ...localGovernmentHouses.map((house) => String(house.area || '').trim()).filter(Boolean),
  ])).sort(sortAreaNames);
  const statusOptions = Array.from(new Set(localGovernmentHouses.map((house) => String(house.status || '').trim()).filter(Boolean)))
    .sort((first, second) => first.localeCompare(second));
  const activeFilterChips = [
    areaFilter !== 'all' && {
      key: 'area',
      label: `Area: ${areaOptions.find((area) => area.toLowerCase() === areaFilter.toLowerCase()) || areaFilter}`,
    },
    statusFilter !== 'all' && {
      key: 'status',
      label: `Status: ${statusOptions.find((status) => status.toLowerCase() === statusFilter.toLowerCase()) || statusFilter}`,
    },
    dateFilter !== 'any' && {
      key: 'date',
      label: dateFilter === '30' ? 'Last 30 days' : dateFilter === '365' ? 'Last year' : 'Date unknown',
    },
  ].filter(Boolean);
  const visibleHouses = localGovernmentHouses.filter((house) => {
    const houseArea = String(house.area || '').trim().toLowerCase();
    const addedAt = Date.parse(house.addedAt || '');
    const matchesSearch = [
      house.name,
      house.houseNumber,
      house.address,
      house.area,
      house.street,
      house.status,
    ].some((value) => String(value || '').toLowerCase().includes(normalizedSearch));
    const matchesAreaContext = normalizedSearch || !normalizedSelectedArea || houseArea === normalizedSelectedArea;
    const matchesStatus = statusFilter === 'all' || String(house.status || '').toLowerCase() === statusFilter.toLowerCase();
    const matchesAreaFilter = areaFilter === 'all' || houseArea === areaFilter.toLowerCase();
    const matchesDate = dateFilter === 'any'
      || (dateFilter === 'undated' && !Number.isFinite(addedAt))
      || (dateFilter === '30' && Number.isFinite(addedAt) && addedAt >= Date.now() - 30 * 86400000)
      || (dateFilter === '365' && Number.isFinite(addedAt) && addedAt >= Date.now() - 365 * 86400000);
    return matchesSearch && matchesAreaContext && matchesStatus && matchesAreaFilter && matchesDate;
  });
  const searchSuggestions = normalizedSearch ? [
    ...houses.filter((house) => [house.name, house.houseNumber, house.address, house.area, house.street]
      .some((value) => String(value || '').toLowerCase().includes(normalizedSearch)))
      .slice(0, 4)
      .map((house) => ({
        key: `house-${house.id}`,
        label: house.houseNumber ? `${house.name} · ${house.houseNumber}` : house.name,
        detail: [house.street, house.area, house.address].filter(Boolean).join(' · ') || 'Registered house',
        house,
      })),
    ...localGovernmentAreaNames
      .filter((areaName) => areaName.toLowerCase().includes(normalizedSearch))
      .slice(0, 3)
      .map((areaName) => ({ key: `area-${areaName}`, label: areaName, detail: 'Area', areaName })),
    ...Array.from(new Map([
      ...houses.map((house) => [house.street, house.area].filter(Boolean).length ? {
        name: house.street || house.address,
        area: house.area,
      } : null).filter(Boolean),
      ...[...globalStreetNames, ...mapStreetNames].map((street) => ({
        name: street.name,
        area: selectedArea,
        center: street.center,
      })),
    ].filter((street) => street?.name)
      .map((street) => [normalizeStreetName(street.name), street])).values())
      .filter((street) => street.name.toLowerCase().includes(normalizedSearch))
      .slice(0, 3)
      .map((street) => ({
        key: `street-${normalizeStreetName(street.name)}`,
        label: street.name,
        detail: [street.area, 'Street'].filter(Boolean).join(' · '),
        street,
      })),
  ].slice(0, 8) : [];
  const streetGroupsByName = new Map(mapStreetNames.map((street) => [normalizeStreetName(street.name), {
    key: normalizeStreetName(street.name),
    label: street.name,
    type: 'map',
    count: 0,
    house: null,
    center: street.center,
  }]));
  selectedAreaHouses.forEach((house) => {
    const street = String(house.street || '').trim();
    const address = String(house.address || '').trim();
    const label = street || address;
    if (!label) return;

    const type = street ? 'street' : 'address';
    const key = normalizeStreetName(label);
    const existing = streetGroupsByName.get(key);
    if (existing) {
      existing.count += 1;
      existing.house = existing.house || house;
      if (existing.type === 'map') existing.type = type;
    } else {
      streetGroupsByName.set(key, { key, label, type, count: 1, house, center: null });
    }
  });
  const streetGroups = Array.from(streetGroupsByName.values()).sort((first, second) => first.label.localeCompare(second.label));
  function handleHouseSelect(house) {
    setSelectedId(house.id);
    if (getHouseLocalGovernment(house) !== selectedLocalGovernmentRef.current) {
      handleLocalGovernmentSelect(getHouseLocalGovernment(house));
    }
    const map = mapRef.current;
    if (!map) return;

    setMapRecentering(true);
    map.once('idle', () => setMapRecentering(false));
    map.flyTo({
      center: [house.longitude, house.latitude],
      zoom: Math.max(map.getZoom(), 14),
      duration: 700,
    });
    popupRef.current?.remove();
    popupRef.current = new maplibregl.Popup({ closeButton: true, offset: 13 })
      .setLngLat([house.longitude, house.latitude])
      .setDOMContent(createPopupContent(house))
      .addTo(map);
  }

  function handleSearchSuggestionSelect(suggestion) {
    setSearchFocused(false);
    if (suggestion.area) {
      setSearch('');
      handleAreaSelect(suggestion.area);
    } else if (suggestion.areaName) {
      setSearch('');
      handleImportedAreaSelect(suggestion.areaName);
    } else if (suggestion.house) {
      setSearch(suggestion.label);
      handleHouseSelect(suggestion.house);
    } else if (suggestion.street?.center) {
      setSearch(suggestion.label);
      setMapRecentering(true);
      mapRef.current?.once('idle', () => setMapRecentering(false));
      mapRef.current?.flyTo({ center: suggestion.street.center, zoom: 16, duration: 700 });
    } else if (suggestion.street?.area) {
      setSearch(suggestion.label);
      const area = ALIMOSHO_AREAS.features.find(
        (feature) => feature.properties.name.toLowerCase() === suggestion.street.area.toLowerCase(),
      );
      if (area) handleAreaSelect(area);
    }
  }

  function handleFileChange(event) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    setImportMessage('');
    const requestId = csvParseRequestRef.current + 1;
    csvParseRequestRef.current = requestId;
    setCsvParsing(true);
    setCsvDraft(null);
    setImportOpen(true);
    file.text().then((text) => {
      window.requestAnimationFrame(() => {
        if (csvParseRequestRef.current !== requestId) return;
        try {
          setCsvDraft({ fileName: file.name, text, preview: inspectHouseCsv(text) });
          setCsvParsing(false);
        } catch (error) {
          setCsvParsing(false);
          setImportMessage(`The CSV file could not be parsed: ${error.message}`);
        }
      });
    }).catch(() => {
      if (csvParseRequestRef.current !== requestId) return;
      setCsvParsing(false);
      setImportMessage('The CSV file could not be read.');
    });
  }

  function openImportDialog() {
    setImportMessage('');
    setImportOpen(true);
  }

  function closeImportDialog() {
    csvParseRequestRef.current += 1;
    setImportOpen(false);
    setCsvParsing(false);
    setCsvDraft(null);
  }

  function updateCsvMapping(field, value) {
    setCsvDraft((current) => {
      if (!current) return current;
      const mapping = { ...current.preview.mapping, [field]: value };
      return { ...current, preview: inspectHouseCsv(current.text, mapping) };
    });
  }

  function confirmCsvImport() {
    if (!csvDraft) return;
    const result = parseHouseCsv(csvDraft.text, housesRef.current.length, csvDraft.preview.mapping);
    if (result.error) {
      setImportMessage(result.error);
      return;
    }

    const importedHouses = result.houses.map((house) => ({
      ...house,
      localGovernment: selectedLocalGovernmentRef.current,
    }));
    setHouses((current) => [...current, ...importedHouses]);
    setSelectedId(null);
    setImportMessage(
      `${result.houses.length} ${result.houses.length === 1 ? 'house' : 'houses'} added${result.skipped ? `; ${result.skipped} invalid ${result.skipped === 1 ? 'row' : 'rows'} skipped` : ''}.`,
    );
    setMapRecentering(true);
    mapRef.current?.once('idle', () => setMapRecentering(false));
    fitMapToHouses(mapRef.current, importedHouses);
    closeImportDialog();
  }

  function loadSampleData() {
    if (localGovernmentHouses.length > 0 || selectedLocalGovernment !== 'Alimosho') return;

    const sampleHouses = createSampleHouses(selectedLocalGovernment);
    setHouses((current) => [...current, ...sampleHouses]);
    setImportMessage('Demo sample records loaded. These are fictional examples for exploring the map and search.');
    setMapRecentering(true);
    mapRef.current?.once('idle', () => setMapRecentering(false));
    fitMapToHouses(mapRef.current, sampleHouses);
  }

  function clearAllFilters() {
    setSearch('');
    setAreaFilter('all');
    setStatusFilter('all');
    setDateFilter('any');
    if (selectedAreaRef.current) handleAllAreas();
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark"><MapPinned aria-hidden="true" size={21} /></span>
          <span className="brand-copy">
            <span className="brand-name">Lagos</span>
            <span className="brand-caption">HOUSE REGISTER</span>
          </span>
        </div>
        <div className="global-search" onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setSearchFocused(false);
        }}>
          <label className="global-search-field">
            <Search aria-hidden="true" size={17} />
            <input
              aria-label="Search all houses, streets, addresses, or areas"
              aria-controls="global-search-suggestions"
              aria-expanded={searchFocused && searchSuggestions.length > 0}
              aria-autocomplete="list"
              aria-haspopup="listbox"
              autoComplete="off"
              onChange={(event) => setSearch(event.target.value)}
              onFocus={() => setSearchFocused(true)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && searchSuggestions[0]) {
                  event.preventDefault();
                  handleSearchSuggestionSelect(searchSuggestions[0]);
                }
              }}
              placeholder={`Search streets, house numbers, or areas in ${selectedLocalGovernment}`}
              role="combobox"
              type="search"
              value={search}
            />
          </label>
          {activeFilterChips.length > 0 && (
            <div className="active-filter-chips" aria-label="Active filters">
              {activeFilterChips.map((chip) => (
                <button
                  className="filter-chip"
                  key={chip.key}
                  onClick={() => {
                    if (chip.key === 'area') setAreaFilter('all');
                    if (chip.key === 'status') setStatusFilter('all');
                    if (chip.key === 'date') setDateFilter('any');
                  }}
                  type="button"
                >
                  {chip.label}<X aria-hidden="true" size={11} />
                </button>
              ))}
              <button className="clear-filters-button" onClick={clearAllFilters} type="button">
                Clear all
              </button>
            </div>
          )}
          {searchFocused && searchSuggestions.length > 0 && (
            <div className="search-suggestions" id="global-search-suggestions" role="listbox">
              {searchSuggestions.map((suggestion) => (
                <button
                  aria-label={`${suggestion.label}, ${suggestion.detail}`}
                  aria-selected="false"
                  key={suggestion.key}
                  onClick={() => handleSearchSuggestionSelect(suggestion)}
                  role="option"
                  type="button"
                >
                  <span>{suggestion.label}</span>
                  <small>{suggestion.detail}</small>
                </button>
              ))}
            </div>
          )}
        </div>
        <label className="location-label local-government-picker">
          <span className="location-dot" />
          <select
            aria-label="Switch local government"
            disabled={!localGovernments.length}
            onChange={(event) => handleLocalGovernmentSelect(event.target.value)}
            value={selectedLocalGovernment}
          >
            {localGovernments.map((localGovernment) => (
              <option key={localGovernment} value={localGovernment}>{localGovernment}</option>
            ))}
          </select>
        </label>
        <div className="header-actions">
          <details className="csv-help">
            <summary aria-label="CSV format help" title="CSV format help">
              <CircleHelp aria-hidden="true" size={17} />
            </summary>
            <div className="csv-help-popover" role="note">
              <strong>CSV columns</strong>
              <p>Typical headers: <code>Street Name, House Number, Area, Lat, Long</code>. Coordinates are required; other columns are optional.</p>
              <button className="template-button" onClick={downloadTemplate} type="button">
                <Download aria-hidden="true" size={13} /> Download template
              </button>
            </div>
          </details>

          <button className="button button-primary top-import" onClick={openImportDialog} type="button">
            <Upload aria-hidden="true" size={16} />
            <span>Import CSV</span>
          </button>
        </div>
      </header>

      <main className={`workspace${isSidebarCollapsed ? ' is-sidebar-collapsed' : ''}`}>
        <aside
          aria-label="House register"
          className="registry-panel"
          hidden={isSidebarCollapsed}
          id="house-register-panel"
        >
          <div className="panel-heading">
            <div className="panel-heading-copy">
              <p className="eyebrow">PROPERTY INDEX <span> / </span> {selectedLocalGovernment.toUpperCase()}</p>
              <h1>Registered<br />houses</h1>
              <p className="district-label">{selectedLocalGovernment} Local Government Area</p>
            </div>
            <button
              aria-controls="house-register-panel"
              aria-expanded={!isSidebarCollapsed}
              aria-label="Collapse property index"
              className="sidebar-toggle"
              onClick={() => setSidebarCollapsed(true)}
              title="Collapse property index"
              type="button"
            >
              <PanelLeftClose aria-hidden="true" size={16} />
              <span>Hide index</span>
            </button>
          </div>

          {customArea?.areaLookupComplete && (
            <section aria-label="Custom boundary location" className="custom-area-location">
              <span>Custom boundary LGA</span>
              <strong>{customArea.localGovernment || 'Not identified'}</strong>
              <small>Based on the first coordinate</small>
            </section>
          )}

          <div className="summary-row" aria-label="Register summary">
            <div className="summary-item">
              <span className="summary-value">{localGovernmentHouses.length.toLocaleString()}</span>
              <span className="summary-label">Houses indexed</span>
              <span className="summary-detail">{recentHouses.length} added in 30 days</span>
            </div>
            <div className="summary-item">
              <span className="summary-value">{selectedLocalGovernment === 'Alimosho'
                ? `${coveredAreaKeys.size}/${ALIMOSHO_AREAS.features.length}`
                : areaOptions.length}</span>
              <span className="summary-label">{selectedLocalGovernment === 'Alimosho'
                ? `Areas covered · ${coveragePercent}%`
                : 'Imported area tags'}</span>
              {selectedLocalGovernment === 'Alimosho' && (
                <span aria-label={`${coveragePercent}% area coverage`} className="coverage-track">
                  <span style={{ width: `${coveragePercent}%` }} />
                </span>
              )}
              <span className="summary-detail">{recentlyUpdatedAreaCount} areas updated in 30 days</span>
            </div>
          </div>

          <section className="area-section" aria-label={`Areas in ${selectedLocalGovernment}`}>
            <div className="directory-heading area-heading">
              <h2>{selectedLocalGovernment === 'Alimosho' ? 'Areas in Alimosho' : `Areas in ${selectedLocalGovernment}`}</h2>
              <span>{selectedLocalGovernment === 'Alimosho' ? ALIMOSHO_AREAS.features.length : areaOptions.length}</span>
            </div>
            <div className="area-list">
              {selectedLocalGovernment === 'Alimosho' ? ALIMOSHO_AREAS.features.map((area) => (
                <button
                  aria-pressed={selectedArea === area.properties.name}
                  className={`area-button${selectedArea === area.properties.name ? ' is-selected' : ''}`}
                  key={area.id}
                  onClick={() => handleAreaSelect(area)}
                  type="button"
                >
                  <MapPin aria-hidden="true" size={12} />
                  <span className="area-button-name">{area.properties.name}</span>
                  <span className="area-house-count">{houseCountsByArea.get(area.properties.name.toLowerCase()) || 0}</span>
                </button>
              )) : areaOptions.length ? areaOptions.map((areaName) => (
                <button
                  aria-pressed={selectedArea === areaName}
                  className={`area-button${selectedArea === areaName ? ' is-selected' : ''}`}
                  key={areaName}
                  onClick={() => handleImportedAreaSelect(areaName)}
                  type="button"
                >
                  <MapPin aria-hidden="true" size={12} />
                  <span className="area-button-name">{areaName}</span>
                  <span className="area-house-count">{houseCountsByArea.get(areaName.toLowerCase()) || 0}</span>
                </button>
              )) : (
                <p className="area-data-empty">Import records with area names to build this LGA’s area list.</p>
              )}
            </div>
          </section>

          {selectedArea && (
            <section className="selected-area-panel" aria-label={`${selectedArea} details`}>
              <div className="selected-area-heading">
                <h2>{selectedArea}</h2>
                <button className="area-clear-button" onClick={handleAllAreas} type="button">
                  All {selectedLocalGovernment}
                </button>
              </div>
              <div className="selected-area-subheading">
                <h3>Nearby streets and addresses</h3>
                <span>{streetGroups.length}</span>
              </div>
              {streetGroups.length > 0 ? (
                <div className="selected-street-list">
                  {streetGroups.map((street) => (
                    <button
                      className="selected-street-row"
                      key={street.key}
                      onClick={() => {
                        if (street.house) {
                          handleHouseSelect(street.house);
                        } else if (street.center) {
                          mapRef.current?.flyTo({ center: street.center, zoom: 16, duration: 700 });
                        }
                      }}
                      type="button"
                    >
                      <span className="selected-street-copy">
                        <span>{street.label}</span>
                        <small>{street.type === 'address' ? 'Address' : street.type === 'map' ? 'On map' : 'Street'}</small>
                      </span>
                      {street.count > 0 && <span className="street-house-count">{street.count}</span>}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="area-data-empty">
                  {streetLookupComplete ? 'No mapped street names visible in this map view.' : 'Loading nearby street names...'}
                </p>
              )}
              <div className="selected-area-subheading houses-subheading">
                <h3>Registered houses</h3>
                <span>{selectedAreaHouses.length}</span>
              </div>
              {selectedAreaHouses.length === 0 && (
                <p className="area-data-empty">No registered houses in {selectedArea} yet.</p>
              )}
            </section>
          )}

          <div className="directory-heading">
            <h2>{selectedArea ? `Houses in ${selectedArea}` : 'House directory'}</h2>
            <span>{visibleHouses.length.toLocaleString()}</span>
          </div>

          <div className="filter-row" aria-label="Filter houses">
            <select aria-label="Filter by area" onChange={(event) => setAreaFilter(event.target.value)} value={areaFilter}>
              <option value="all">All areas</option>
              {areaOptions.map((area) => <option key={area} value={area}>{area}</option>)}
            </select>
            <select aria-label="Filter by registration status" onChange={(event) => setStatusFilter(event.target.value)} value={statusFilter}>
              <option value="all">All statuses</option>
              {statusOptions.map((status) => <option key={status} value={status}>{status}</option>)}
            </select>
            <select aria-label="Filter by date added" onChange={(event) => setDateFilter(event.target.value)} value={dateFilter}>
              <option value="any">Any date</option>
              <option value="30">Last 30 days</option>
              <option value="365">Last year</option>
              <option value="undated">Date unknown</option>
            </select>
          </div>

          <div className="directory-list" aria-live="polite">
            {visibleHouses.length > 0 ? visibleHouses.map((house) => (
              <button
                aria-pressed={selectedId === house.id}
                className={`house-row${selectedId === house.id ? ' is-selected' : ''}`}
                key={house.id}
                onClick={() => handleHouseSelect(house)}
                type="button"
              >
                <span className="house-row-pin"><MapPinned aria-hidden="true" size={17} /></span>
                <span className="house-row-copy">
                  <span className="house-row-name">{house.name}</span>
                  <span className="house-row-detail">{house.area || house.address || `${house.latitude.toFixed(4)}, ${house.longitude.toFixed(4)}`}</span>
                </span>
                <span className="house-row-coordinate">{house.latitude.toFixed(3)}</span>
              </button>
            )) : (
              <div className={`empty-state${localGovernmentHouses.length === 0 ? ' is-empty' : ''}`}>
                <span className="empty-icon"><MapPinned aria-hidden="true" size={20} /></span>
                <p>{localGovernmentHouses.length === 0
                  ? `No house records in ${selectedLocalGovernment} yet.`
                  : selectedArea && selectedAreaHouses.length === 0
                    ? `No registered houses in ${selectedArea} yet`
                    : 'No matching houses'}</p>
                {localGovernmentHouses.length === 0 && (
                  <span className="empty-detail">
                    Select an area or upload a batch via Import CSV to populate this local register.
                  </span>
                )}
                {(selectedArea && selectedAreaHouses.length === 0) || localGovernmentHouses.length === 0 ? (
                  <>
                    <button className="button button-outline" onClick={openImportDialog} type="button">
                      <Upload aria-hidden="true" size={15} />
                      {localGovernmentHouses.length === 0 ? 'Import CSV' : 'Add First House'}
                    </button>
                    {localGovernmentHouses.length === 0 && selectedLocalGovernment === 'Alimosho' && (
                      <button className="button button-sample" onClick={loadSampleData} type="button">
                        Load sample data
                      </button>
                    )}
                  </>
                ) : (
                  <span className="empty-detail">Try changing the search or filters.</span>
                )}
              </div>
            )}
          </div>

          <div className="panel-footer">
            <button className="template-button" onClick={downloadTemplate} type="button">
              <Download aria-hidden="true" size={15} />
              Download CSV template
            </button>
            <span className="coordinate-note">WGS 84 coordinates</span>
          </div>
          <input
            accept=".csv,text/csv"
            aria-label="Import house coordinates from CSV"
            className="visually-hidden"
            onChange={handleFileChange}
            ref={fileInputRef}
            type="file"
          />
          <p aria-live="polite" className={`import-message${importMessage.includes('could not') || importMessage.includes('must include') || importMessage.includes('No valid coordinates') || importMessage.includes('no house rows') ? ' is-error' : ''}`}>
            {importMessage}
          </p>
        </aside>

        <section className="map-column" aria-label={`Map of ${selectedLocalGovernment} registered houses`}>
          <div className="map-frame">
            <div aria-label={`Map showing registered houses in ${selectedLocalGovernment}`} className="map-canvas" ref={mapContainerRef} />
            <SurveyPanel
              activeAreaId={activeSurveyId}
              area={surveyMetrics.area}
              boundaryReason={surveyValidation.reason}
              boundaryStatus={surveyBoundaryStatus}
              collapsed={isSurveyPanelCollapsed}
              houseCount={surveyHouseCount}
              housesInside={surveyHousesInside}
              housesOutside={surveyHousesOutside}
              isBoundaryClosed={surveyClosed}
              isCapturingGps={isCapturingSurveyGps}
              isTracking={isTrackingLocation}
              captureMovementAsBoundary={captureMovementAsBoundary}
              onCaptureMovementAsBoundaryChange={setCaptureMovementAsBoundary}
              locationError={locationError}
              mapMode={surveyMapMode}
              onCaptureGps={captureSurveyGpsPoint}
              onPlotArea={plotSurveyArea}
              onMapModeChange={changeSurveyMapMode}
              onOpenBoundary={() => {
                setSurveyClosed(false);
                setSurveySaveError('');
              }}
              onPointIndexToMove={updateSelectedSurveyPoint}
              onRemoveAllPoints={() => {
                updateSurveyPoints([]);
                setSurveyClosed(false);
                updateSelectedSurveyPoint(null);
              }}
              onRemovePoint={removeSurveyPoint}
              onSaveBoundary={saveSurveyBoundary}
              onSelectSavedArea={selectSavedSurveyArea}
              onStartNew={startNewSurvey}
              onStartTracking={toggleUserLocation}
              onSurveyNameChange={setSurveyName}
              surveyColor={surveyColor}
              onSurveyColorChange={setSurveyColor}
              onToggleCollapsed={() => setSurveyPanelCollapsed((collapsed) => !collapsed)}
              perimeter={surveyMetrics.perimeter}
              pointIndexToMove={selectedSurveyPointIndex}
              points={activeSurveyPoints}
              saveError={surveySaveError || surveyStorageError}
              savedAreas={savedSurveyAreas}
              surveyName={surveyName}
              trackingStatus={trackingStatus}
              userLocation={userLocation}
            />
            {isSidebarCollapsed && (
              <button
                aria-controls="house-register-panel"
                aria-expanded={false}
                className="sidebar-reopen-button"
                onClick={() => setSidebarCollapsed(false)}
                type="button"
              >
                <PanelLeftOpen aria-hidden="true" size={16} />
                <span>Show property index</span>
              </button>
            )}
            <div className="map-style-toggle" role="group" aria-label="Map style">
              <button
                aria-pressed={mapStyleMode === 'street'}
                className={mapStyleMode === 'street' ? 'is-active' : ''}
                onClick={() => setMapStyleMode('street')}
                type="button"
              >
                <MapIcon aria-hidden="true" size={14} /> Street
              </button>
              <button
                aria-pressed={mapStyleMode === 'satellite'}
                className={mapStyleMode === 'satellite' ? 'is-active' : ''}
                onClick={() => setMapStyleMode('satellite')}
                type="button"
              >
                <Satellite aria-hidden="true" size={14} /> Satellite
              </button>
            </div>
            <label className="map-boundary-color-control">
              <span>Selected area overlay</span>
              <input
                type="color"
                value={areaOverlayColor}
                onChange={(event) => setAreaOverlayColor(event.target.value)}
                aria-label="Change selected area overlay color"
              />
            </label>
            <button className="map-custom-button" onClick={openCustomDialog} type="button">
              <MapPin aria-hidden="true" size={14} />
              Custom
            </button>
            {customArea && (
              <button className="map-custom-clear-button" onClick={clearCustomArea} type="button">
                Clear custom area
              </button>
            )}
            {customArea && (
              <div aria-live="polite" className="map-custom-area-label">
                <MapPin aria-hidden="true" size={13} />
                <span>
                  {!customArea.areaLookupComplete
                    ? 'Identifying area…'
                    : customArea.areaName
                      ? `${customArea.areaName} · ${customArea.localGovernment}`
                      : 'Area not identified in locality data'}
                </span>
              </div>
            )}
            {!mapReady && <div className="map-loading"><span className="loading-mark" />Loading map</div>}
            {isMapRecentering && mapReady && (
              <div className="map-transition-status" aria-live="polite" role="status">
                <span className="skeleton map-status-skeleton" />
                <span>Re-centering map</span>
              </div>
            )}
            <button
              aria-pressed={isTrackingLocation}
              className={`map-locate-button${isTrackingLocation ? ' is-tracking' : ''}`}
              onClick={toggleUserLocation}
              type="button"
            >
              <LocateFixed aria-hidden="true" size={14} />
              {isTrackingLocation ? 'Stop tracking' : 'Start tracking'}
            </button>
            {(userLocation || locationError || isTrackingLocation || trackingStatus) && (
              <div className={`map-user-location${locationError ? ' has-error' : ''}`} aria-live="polite" role="status">
                {userLocation && (
                  <>
                    <strong>{isTrackingLocation ? 'Live location' : 'Last location'}</strong>
                    <span>Lat {userLocation.latitude.toFixed(6)} · Lng {userLocation.longitude.toFixed(6)}</span>
                    <small>Accuracy ±{Math.round(userLocation.accuracy)} m</small>
                    <small>GPS updated {new Date(userLocation.timestamp).toLocaleTimeString()}</small>
                  </>
                )}
                {isTrackingLocation && !userLocation && <span>Waiting for your location…</span>}
                {trackingStatus && <small className="map-tracking-status">{trackingStatus}</small>}
                {locationError && <span role="alert">{locationError}</span>}
              </div>
            )}
            <div className="map-route-panel" aria-label="Live movement tracking">
              <div className="map-route-actions">
                <button
                  aria-pressed={isFollowingLocation}
                  onClick={() => setFollowingLocation((following) => !following)}
                  type="button"
                >
                  {isFollowingLocation ? 'Follow: on' : 'Follow: off'}
                </button>
                <button disabled={!userLocation} onClick={centerOnCurrentLocation} type="button">
                  Return to location
                </button>
                <button disabled={routePoints.length === 0} onClick={fitRecordedRoute} type="button">
                  Fit full route
                </button>
              </div>
              <strong>{routePoints.length} recorded {routePoints.length === 1 ? 'point' : 'points'}</strong>
              {routePoints.length > 0 && (
                <>
                  <small>
                    Start {routePoints[0].latitude.toFixed(5)}, {routePoints[0].longitude.toFixed(5)}
                    {' · '}
                    Latest route point {routePoints[routePoints.length - 1].latitude.toFixed(5)}, {routePoints[routePoints.length - 1].longitude.toFixed(5)}
                  </small>
                  <ol className="map-route-history" aria-label="Recorded route history">
                    {routePoints.map((point, index) => (
                      <li key={`${point.timestamp}-${index}`}>
                        <span>Point {index + 1}</span>
                        <span>{point.latitude.toFixed(5)}, {point.longitude.toFixed(5)}</span>
                        <small>±{Math.round(point.accuracy)} m · {new Date(point.timestamp).toLocaleTimeString()}</small>
                      </li>
                    ))}
                  </ol>
                </>
              )}
              <small>Route filters readings over {MAX_ROUTE_ACCURACY_METERS} m accuracy, duplicate points, and implausible GPS jumps.</small>
            </div>
            <div className="map-location-badge">
              <span className="map-badge-dot" />
              <span>{selectedLocalGovernment.toUpperCase()} LGA</span>
              <span className="badge-divider" />
              <span>{localGovernmentHouses.length.toLocaleString()} {localGovernmentHouses.length === 1 ? 'HOUSE' : 'HOUSES'}</span>
            </div>
            <div className="map-legend" aria-label="Map legend">
              <span><i className="legend-boundary" />Boundary</span>
              <span><i className="legend-road" />Road names</span>
              <span><i className="legend-house" />Registered houses</span>
            </div>
            <div className="map-caption">{localGovernmentHouses.length
              ? `${selectedLocalGovernment} registered house coordinates`
              : `${selectedLocalGovernment} boundary highlighted`}</div>
          </div>
        </section>
      </main>
      {isCustomDialogOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeCustomDialog();
          }}
        >
          <section
            aria-labelledby="custom-area-title"
            aria-modal="true"
            className="custom-area-dialog"
            onKeyDown={(event) => {
              if (event.key === 'Escape') closeCustomDialog();
            }}
            role="dialog"
          >
            <header className="import-dialog-header">
              <div>
                <p className="eyebrow">MAP SPACE</p>
                <h2 id="custom-area-title">Create a custom area</h2>
              </div>
              <button aria-label="Close custom area dialog" className="icon-button" onClick={closeCustomDialog} type="button">
                <X aria-hidden="true" size={18} />
              </button>
            </header>
            <form onSubmit={submitCustomArea}>
              <p className="custom-area-description">
                Enter at least three coordinate pairs to define the boundary. The last point connects back to the first.
              </p>
              <div className="custom-coordinate-list">
                {customCoordinates.map((coordinate, index) => (
                  <div className="custom-coordinate-row" key={`coordinate-${index + 1}`}>
                    <label className="csv-mapping-field">
                      <span>Point {index + 1} · Latitude</span>
                      <input
                        aria-label={`Custom area point ${index + 1} latitude`}
                        max="90"
                        min="-90"
                        onChange={(event) => setCustomCoordinates((current) => current.map((item, itemIndex) => (
                          itemIndex === index ? { ...item, latitude: event.target.value } : item
                        )))}
                        placeholder="e.g. 6.5844"
                        required
                        step="any"
                        type="number"
                        value={coordinate.latitude}
                      />
                    </label>
                    <label className="csv-mapping-field">
                      <span>Point {index + 1} · Longitude</span>
                      <input
                        aria-label={`Custom area point ${index + 1} longitude`}
                        max="180"
                        min="-180"
                        onChange={(event) => setCustomCoordinates((current) => current.map((item, itemIndex) => (
                          itemIndex === index ? { ...item, longitude: event.target.value } : item
                        )))}
                        placeholder="e.g. 3.2576"
                        required
                        step="any"
                        type="number"
                        value={coordinate.longitude}
                      />
                    </label>
                    {customCoordinates.length > 3 && (
                      <button
                        aria-label={`Remove point ${index + 1}`}
                        className="custom-coordinate-remove"
                        onClick={() => setCustomCoordinates((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                        type="button"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                ))}
                <button
                  className="custom-coordinate-add"
                  onClick={() => setCustomCoordinates((current) => [...current, { latitude: '', longitude: '' }])}
                  type="button"
                >
                  + Add coordinate
                </button>
              </div>
              {customCoordinateError && <p className="custom-coordinate-error" role="alert">{customCoordinateError}</p>}
              <footer className="import-dialog-actions">
                {customArea && (
                  <button className="button button-outline" onClick={clearCustomArea} type="button">
                    Clear current area
                  </button>
                )}
                <button className="button button-outline" onClick={closeCustomDialog} type="button">Cancel</button>
                <button className="button button-primary" type="submit">Highlight area</button>
              </footer>
            </form>
          </section>
        </div>
      )}
      {isImportOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeImportDialog();
          }}
        >
          <section
            aria-labelledby="csv-import-title"
            aria-modal="true"
            className="import-dialog"
            onKeyDown={(event) => {
              if (event.key === 'Escape') closeImportDialog();
            }}
            role="dialog"
          >
            <header className="import-dialog-header">
              <div>
                <p className="eyebrow">DATA MANAGEMENT</p>
                <h2 id="csv-import-title">Import house records</h2>
              </div>
              <button aria-label="Close import dialog" className="icon-button" onClick={closeImportDialog} type="button">
                <X aria-hidden="true" size={18} />
              </button>
            </header>
            {isCsvParsing ? (
              <div className="csv-parsing-skeleton" aria-live="polite" role="status">
                <span className="csv-skeleton-title skeleton" />
                <span className="csv-skeleton-copy skeleton" />
                <div className="csv-skeleton-grid">
                  {Array.from({ length: 8 }, (_, index) => (
                    <span className="csv-skeleton-field skeleton" key={index} />
                  ))}
                </div>
                <div className="csv-skeleton-table">
                  {Array.from({ length: 4 }, (_, index) => (
                    <span className="csv-skeleton-row skeleton" key={index} />
                  ))}
                </div>
                <span className="visually-hidden">Reading and validating CSV rows…</span>
              </div>
            ) : !csvDraft ? (
              <div className="import-pick-file">
                <p>Choose a CSV file to preview and validate before adding records.</p>
                <button className="button button-primary" onClick={() => fileInputRef.current?.click()} type="button">
                  <Upload aria-hidden="true" size={16} /> Choose CSV file
                </button>
              </div>
            ) : (
              <>
                <div className="csv-file-name">{csvDraft.fileName}</div>
                <div className="csv-mapping-grid">
                  {CSV_FIELD_CONFIG.map((field) => (
                    <label className="csv-mapping-field" key={field.key}>
                      <span>{field.label}{field.required ? ' *' : ''}</span>
                      <select
                        aria-label={`Map ${field.label}`}
                        onChange={(event) => updateCsvMapping(field.key, event.target.value)}
                        value={csvDraft.preview.mapping[field.key]}
                      >
                        <option value="">Not mapped</option>
                        {csvDraft.preview.fields.map((column) => (
                          <option key={column} value={column}>{column.replace(/^\uFEFF/, '').trim()}</option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
                <div className="csv-preview-summary" aria-live="polite">
                  <span>{csvDraft.preview.validCount} ready</span>
                  <span>{csvDraft.preview.skipped} need attention</span>
                  {csvDraft.preview.error && <strong>{csvDraft.preview.error}</strong>}
                </div>
                <div className="csv-preview-table-wrap">
                  <table className="csv-preview-table">
                    <thead>
                      <tr><th>Row</th><th>House</th><th>Area / street</th><th>Coordinates</th><th>Validation</th></tr>
                    </thead>
                    <tbody>
                      {csvDraft.preview.rows.slice(0, 8).map((row) => (
                        <tr className={row.valid ? '' : 'is-invalid'} key={row.rowNumber}>
                          <td>{row.rowNumber}</td>
                          <td>{row.values.name || row.values.houseNumber || row.values.address || 'Unnamed'}</td>
                          <td>{[row.values.area, row.values.street].filter(Boolean).join(' · ') || '—'}</td>
                          <td>{Number.isFinite(row.values.latitude) && Number.isFinite(row.values.longitude)
                            ? `${row.values.latitude}, ${row.values.longitude}`
                            : '—'}</td>
                          <td>{row.valid ? 'Ready' : row.errors.join('; ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {csvDraft.preview.rows.length > 8 && (
                    <p className="csv-preview-more">Showing 8 of {csvDraft.preview.rows.length} rows.</p>
                  )}
                </div>
              </>
            )}
            <footer className="import-dialog-actions">
              {csvDraft && (
                <button className="button button-outline" onClick={() => fileInputRef.current?.click()} type="button">
                  Choose another file
                </button>
              )}
              <button className="button button-outline" onClick={closeImportDialog} type="button">Cancel</button>
              {csvDraft && (
                <button
                  className="button button-primary"
                  disabled={!csvDraft.preview.validCount}
                  onClick={confirmCsvImport}
                  type="button"
                >
                  Import {csvDraft.preview.validCount} {csvDraft.preview.validCount === 1 ? 'house' : 'houses'}
                </button>
              )}
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}

export default App;
