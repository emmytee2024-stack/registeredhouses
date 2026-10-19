function isPointOnSegment(point, start, end) {
  const cross = (point[1] - start[1]) * (end[0] - start[0])
    - (point[0] - start[0]) * (end[1] - start[1]);
  if (Math.abs(cross) > 1e-10) return false;

  const dot = (point[0] - start[0]) * (end[0] - start[0])
    + (point[1] - start[1]) * (end[1] - start[1]);
  const lengthSquared = (end[0] - start[0]) ** 2 + (end[1] - start[1]) ** 2;
  if (lengthSquared <= 1e-20) {
    return Math.abs(point[0] - start[0]) <= 1e-10 && Math.abs(point[1] - start[1]) <= 1e-10;
  }
  return dot >= 0 && dot <= lengthSquared;
}

function isPointInRing(point, ring) {
  let isInside = false;

  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const currentCoordinate = ring[index];
    const previousCoordinate = ring[previous];
    if (isPointOnSegment(point, previousCoordinate, currentCoordinate)) return true;

    const crossesLatitude = (currentCoordinate[1] > point[1]) !== (previousCoordinate[1] > point[1]);
    const crossingLongitude = ((previousCoordinate[0] - currentCoordinate[0])
      * (point[1] - currentCoordinate[1]))
      / (previousCoordinate[1] - currentCoordinate[1])
      + currentCoordinate[0];
    if (crossesLatitude && point[0] < crossingLongitude) isInside = !isInside;
  }

  return isInside;
}

function isPointInPolygon(point, rings) {
  return rings.length > 0
    && isPointInRing(point, rings[0])
    && !rings.slice(1).some((ring) => isPointInRing(point, ring));
}

export function findAreaAtCoordinate(latitude, longitude, features) {
  const point = [longitude, latitude];

  return features.find((feature) => {
    const { geometry } = feature;
    if (geometry.type === 'Polygon') return isPointInPolygon(point, geometry.coordinates);
    if (geometry.type === 'MultiPolygon') {
      return geometry.coordinates.some((polygon) => isPointInPolygon(point, polygon));
    }
    return false;
  }) || null;
}

export function createCustomAreaFeatures(coordinates) {
  const ring = coordinates.map(({ latitude, longitude }) => [longitude, latitude]);
  ring.push(ring[0]);

  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { kind: 'custom-area' },
        geometry: { type: 'Polygon', coordinates: [ring] },
      },
      ...coordinates.map(({ latitude, longitude }, index) => ({
        type: 'Feature',
        properties: { kind: 'custom-vertex', index: index + 1 },
        geometry: { type: 'Point', coordinates: [longitude, latitude] },
      })),
    ],
  };
}
