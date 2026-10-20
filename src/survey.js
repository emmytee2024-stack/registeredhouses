const EARTH_RADIUS_METERS = 6371008.8;
export const SURVEY_AREAS_STORAGE_KEY = 'lagos-survey-areas-v1';
export const DEFAULT_SURVEY_COLOR = '#ed9a45';

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function distanceBetweenPoints(first, second) {
  const latitudeDifference = toRadians(second.latitude - first.latitude);
  const longitudeDifference = toRadians(second.longitude - first.longitude);
  const firstLatitude = toRadians(first.latitude);
  const secondLatitude = toRadians(second.latitude);
  const haversine = Math.sin(latitudeDifference / 2) ** 2
    + Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDifference / 2) ** 2;

  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function orientation(first, second, third) {
  return (second.longitude - first.longitude) * (third.latitude - first.latitude)
    - (second.latitude - first.latitude) * (third.longitude - first.longitude);
}

function segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
  const firstOrientation = orientation(firstStart, firstEnd, secondStart);
  const secondOrientation = orientation(firstStart, firstEnd, secondEnd);
  const thirdOrientation = orientation(secondStart, secondEnd, firstStart);
  const fourthOrientation = orientation(secondStart, secondEnd, firstEnd);
  const epsilon = 1e-12;
  const onSegment = (start, point, end) => (
    point.longitude >= Math.min(start.longitude, end.longitude) - epsilon
    && point.longitude <= Math.max(start.longitude, end.longitude) + epsilon
    && point.latitude >= Math.min(start.latitude, end.latitude) - epsilon
    && point.latitude <= Math.max(start.latitude, end.latitude) + epsilon
  );

  if (
    Math.abs(firstOrientation) <= epsilon
    && onSegment(firstStart, secondStart, firstEnd)
  ) return true;
  if (
    Math.abs(secondOrientation) <= epsilon
    && onSegment(firstStart, secondEnd, firstEnd)
  ) return true;
  if (
    Math.abs(thirdOrientation) <= epsilon
    && onSegment(secondStart, firstStart, secondEnd)
  ) return true;
  if (
    Math.abs(fourthOrientation) <= epsilon
    && onSegment(secondStart, firstEnd, secondEnd)
  ) return true;
  return firstOrientation * secondOrientation < 0 && thirdOrientation * fourthOrientation < 0;
}

function getSelfIntersection(points) {
  const edgeCount = points.length;
  for (let first = 0; first < edgeCount; first += 1) {
    const firstNext = (first + 1) % edgeCount;
    for (let second = first + 1; second < edgeCount; second += 1) {
      const secondNext = (second + 1) % edgeCount;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (segmentsIntersect(points[first], points[firstNext], points[second], points[secondNext])) {
        return [first + 1, second + 1];
      }
    }
  }
  return null;
}

export function validateSurveyBoundary(points, closed) {
  if (!closed && points.length < 3) return { status: 'open', reason: '' };
  if (points.length < 3) {
    return { status: 'invalid', reason: 'Add at least three boundary points before closing.' };
  }

  const unique = new Set(points.map(({ latitude, longitude }) => `${latitude.toFixed(9)},${longitude.toFixed(9)}`));
  if (unique.size < 3 || unique.size !== points.length) {
    return { status: 'invalid', reason: 'Boundary points must be distinct; remove or move the repeated point.' };
  }

  const crossingEdges = getSelfIntersection(points);
  if (crossingEdges) {
    return {
      status: 'invalid',
      reason: `Boundary edges ${crossingEdges[0]} and ${crossingEdges[1]} cross. Move a point to remove the crossing.`,
    };
  }

  const twiceArea = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.longitude * next.latitude - next.longitude * point.latitude;
  }, 0);
  if (Math.abs(twiceArea) < 1e-14) {
    return { status: 'invalid', reason: 'The boundary has no measurable area. Move the points farther apart.' };
  }

  return { status: closed ? 'closed' : 'open', reason: '' };
}

export function getSurveyMetrics(points, closed, validation = validateSurveyBoundary(points, closed)) {
  if (validation.status !== 'closed') return { area: null, perimeter: null };

  const perimeter = points.reduce((sum, point, index) => (
    sum + distanceBetweenPoints(point, points[(index + 1) % points.length])
  ), 0);

  const meanLatitudeDegrees = points.reduce((sum, point) => sum + point.latitude, 0) / points.length;
  const meanLatitude = toRadians(meanLatitudeDegrees);
  const meanLongitude = points.reduce((sum, point) => sum + point.longitude, 0) / points.length;
  const projected = points.map((point) => ({
    x: EARTH_RADIUS_METERS * toRadians(point.longitude - meanLongitude) * Math.cos(meanLatitude),
    y: EARTH_RADIUS_METERS * toRadians(point.latitude - meanLatitudeDegrees),
  }));
  const area = Math.abs(projected.reduce((sum, point, index) => {
    const next = projected[(index + 1) % projected.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0)) / 2;

  return { area, perimeter };
}

function isPointOnSegment(point, start, end) {
  const cross = (point.longitude - start.longitude) * (end.latitude - start.latitude)
    - (point.latitude - start.latitude) * (end.longitude - start.longitude);
  if (Math.abs(cross) > 1e-10) return false;
  return point.longitude >= Math.min(start.longitude, end.longitude) - 1e-10
    && point.longitude <= Math.max(start.longitude, end.longitude) + 1e-10
    && point.latitude >= Math.min(start.latitude, end.latitude) - 1e-10
    && point.latitude <= Math.max(start.latitude, end.latitude) + 1e-10;
}

export function isHouseInsideSurveyBoundary(house, points, closed = true) {
  if (validateSurveyBoundary(points, closed).status !== 'closed') return false;
  return isPointInsideSurveyBoundary(house, points);
}

function isPointInsideSurveyBoundary(house, points) {
  const point = { latitude: house.latitude, longitude: house.longitude };
  let inside = false;

  for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
    const currentPoint = points[index];
    const previousPoint = points[previous];
    if (isPointOnSegment(point, previousPoint, currentPoint)) return true;
    const crossesLatitude = (currentPoint.latitude > point.latitude) !== (previousPoint.latitude > point.latitude);
    const crossingLongitude = ((previousPoint.longitude - currentPoint.longitude)
      * (point.latitude - currentPoint.latitude))
      / (previousPoint.latitude - currentPoint.latitude)
      + currentPoint.longitude;
    if (crossesLatitude && point.longitude < crossingLongitude) inside = !inside;
  }
  return inside;
}

export function countHousesInsideSurveyBoundary(houses, points, closed = true) {
  if (validateSurveyBoundary(points, closed).status !== 'closed') return null;
  return houses.reduce((count, house) => count + Number(isPointInsideSurveyBoundary(house, points)), 0);
}

function createSurveyFeaturesForArea(area, active = false) {
  const valid = validateSurveyBoundary(area.points, area.closed).status === 'closed';
  const coordinates = area.points.map(({ longitude, latitude }) => [longitude, latitude]);
  const color = /^#[\da-f]{6}$/i.test(area.color || '') ? area.color : DEFAULT_SURVEY_COLOR;
  const features = [];

  if (area.points.length >= 2 && (!active || area.closed)) {
    const lineCoordinates = area.closed ? [...coordinates, coordinates[0]] : coordinates;
    features.push({
      type: 'Feature',
      properties: { kind: 'survey-line', id: area.id, active, color },
      geometry: { type: 'LineString', coordinates: lineCoordinates },
    });
  }
  if (valid) {
    features.push({
      type: 'Feature',
      properties: { kind: 'survey-area', id: area.id, active, color },
      geometry: { type: 'Polygon', coordinates: [[...coordinates, coordinates[0]]] },
    });
  }
  area.points.forEach((point, index) => {
    features.push({
      type: 'Feature',
      properties: { kind: 'survey-vertex', id: area.id, index, active, color },
      geometry: { type: 'Point', coordinates: [point.longitude, point.latitude] },
    });
  });
  return features;
}

export function createSurveyFeatureCollection(savedAreas, activeArea) {
  const activeId = activeArea?.id || null;
  const areas = savedAreas.filter((area) => area.id !== activeId);
  if (activeArea?.points.length) areas.push(activeArea);
  return {
    type: 'FeatureCollection',
    features: areas.flatMap((area) => createSurveyFeaturesForArea(area, area.id === activeId)),
  };
}

export function readSavedSurveyAreas(storage) {
  try {
    const savedStorage = storage || window.localStorage;
    const saved = JSON.parse(savedStorage.getItem(SURVEY_AREAS_STORAGE_KEY) || '[]');
    if (!Array.isArray(saved)) return [];
    return saved.filter((area) => (
      typeof area.id === 'string'
      && typeof area.name === 'string'
      && Array.isArray(area.points)
      && area.points.every((point) => (
        Number.isFinite(point.latitude)
        && point.latitude >= -90
        && point.latitude <= 90
        && Number.isFinite(point.longitude)
        && point.longitude >= -180
        && point.longitude <= 180
      ))
    ));
  } catch (error) {
    console.warn('Unable to read saved survey boundaries.', error);
    return [];
  }
}
