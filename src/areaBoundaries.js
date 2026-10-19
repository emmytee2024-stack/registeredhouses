import { intersect } from '@turf/intersect';
import { voronoi } from '@turf/voronoi';

function collectCoordinates(coordinates, result = []) {
  if (!Array.isArray(coordinates)) return result;
  if (typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number') {
    result.push(coordinates);
    return result;
  }
  coordinates.forEach((coordinate) => collectCoordinates(coordinate, result));
  return result;
}

export function createAreaPolygons(areas, boundary) {
  const boundaryCoordinates = collectCoordinates(boundary.geometry.coordinates);
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  boundaryCoordinates.forEach(([longitude, latitude]) => {
    bbox[0] = Math.min(bbox[0], longitude);
    bbox[1] = Math.min(bbox[1], latitude);
    bbox[2] = Math.max(bbox[2], longitude);
    bbox[3] = Math.max(bbox[3], latitude);
  });
  const uniqueAreas = new Map();
  areas.features.forEach((area) => {
    const coordinates = area.geometry.coordinates;
    if (area.geometry.type !== 'Point' || !coordinates.every(Number.isFinite)) return;
    const key = coordinates.join(',');
    if (!uniqueAreas.has(key)) uniqueAreas.set(key, area);
  });
  const points = { type: 'FeatureCollection', features: Array.from(uniqueAreas.values()) };
  if (points.features.length < 2 || bbox.some((coordinate) => !Number.isFinite(coordinate))) {
    return { type: 'FeatureCollection', features: [] };
  }

  const cells = voronoi(points, { bbox });
  return {
    type: 'FeatureCollection',
    features: cells.features.flatMap((cell, index) => {
      if (!cell) return [];
      const clipped = intersect({
        type: 'FeatureCollection',
        features: [cell, boundary],
      });
      if (!clipped) return [];
      return [{
        ...clipped,
        id: points.features[index].id || points.features[index].properties.osmId,
        properties: {
          ...points.features[index].properties,
          localGovernment: boundary.properties.localGovernment,
        },
      }];
    }),
  };
}
