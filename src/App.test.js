import { fireEvent, render, screen } from '@testing-library/react';
import SurveyPanel from './SurveyPanel';
import {
  createSampleHouses,
  filterHousesToBounds,
  inspectHouseCsv,
  parseHouseCsv,
} from './houses';
import { createCustomAreaFeatures, findAreaAtCoordinate } from './customArea';
import { getRoutePointRejectionReason, MAX_ROUTE_ACCURACY_METERS } from './routeTracking';
import {
  countHousesInsideSurveyBoundary,
  createSurveyFeatureCollection,
  getSurveyMetrics,
  isHouseInsideSurveyBoundary,
  readSavedSurveyAreas,
  SURVEY_AREAS_STORAGE_KEY,
  validateSurveyBoundary,
} from './survey';
import ALIMOSHO_AREAS from './alimoshoAreas';
import fs from 'fs';
import path from 'path';

const LAGOS_LOCAL_GOVERNMENTS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../public/lagos-local-governments.geojson'), 'utf8'),
);

test('includes mapped localities inside the Alimosho boundary', () => {
  const names = ALIMOSHO_AREAS.features.map((area) => area.properties.name);

  expect(names).toHaveLength(16);
  expect(names).toEqual(expect.arrayContaining([
    'Abule Egba',
    'Ayobo',
    'Egbeda',
    'Idimu',
    'Igando',
    'Ikotun',
    'Ipaja',
  ]));
  ALIMOSHO_AREAS.features.forEach((area) => {
    const [longitude, latitude] = area.geometry.coordinates;
    expect(longitude).toBeGreaterThanOrEqual(3.1960886);
    expect(longitude).toBeLessThanOrEqual(3.3145752);
    expect(latitude).toBeGreaterThanOrEqual(6.4784701);
    expect(latitude).toBeLessThanOrEqual(6.6904704);
  });
});

test('includes polygon boundaries for all 20 Lagos local governments', () => {
  expect(LAGOS_LOCAL_GOVERNMENTS.features).toHaveLength(20);
  expect(LAGOS_LOCAL_GOVERNMENTS.features.map((feature) => feature.properties.localGovernment)).toEqual(
    expect.arrayContaining(['Alimosho', 'Ikeja', 'Ikorodu', 'Badagry', 'Epe', 'Lagos Island']),
  );
  LAGOS_LOCAL_GOVERNMENTS.features.forEach((feature) => {
    expect(['Polygon', 'MultiPolygon']).toContain(feature.geometry.type);
  });
});

test('creates a closed custom boundary from all entered coordinate pairs', () => {
  const coordinates = [
    { latitude: 6.58, longitude: 3.25 },
    { latitude: 6.59, longitude: 3.26 },
    { latitude: 6.57, longitude: 3.27 },
    { latitude: 6.56, longitude: 3.24 },
  ];
  const features = createCustomAreaFeatures(coordinates);
  const [area, ...vertices] = features.features;
  const ring = area.geometry.coordinates[0];

  expect(area.geometry.type).toBe('Polygon');
  expect(ring).toHaveLength(coordinates.length + 1);
  expect(ring[0]).toEqual(ring[ring.length - 1]);
  expect(ring.slice(0, -1)).toEqual(coordinates.map(({ latitude, longitude }) => [longitude, latitude]));
  expect(vertices.map((vertex) => vertex.geometry.coordinates)).toEqual(
    coordinates.map(({ latitude, longitude }) => [longitude, latitude]),
  );
  expect(vertices.map((vertex) => vertex.properties.kind)).toEqual(
    coordinates.map(() => 'custom-vertex'),
  );
  coordinates.forEach((_, index) => {
    expect(vertices[index].properties.index).toBe(index + 1);
  });
});

test('finds the named locality containing a coordinate and respects polygon holes', () => {
  const features = [
    {
      type: 'Feature',
      properties: { name: 'Central Area' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
          [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { name: 'Eastern Area' },
      geometry: {
        type: 'MultiPolygon',
        coordinates: [[[[20, 0], [30, 0], [30, 10], [20, 10], [20, 0]]]],
      },
    },
  ];

  expect(findAreaAtCoordinate(2, 2, features).properties.name).toBe('Central Area');
  expect(findAreaAtCoordinate(5, 5, features)).toBeNull();
  expect(findAreaAtCoordinate(5, 25, features).properties.name).toBe('Eastern Area');
  expect(findAreaAtCoordinate(12, 12, features)).toBeNull();
});

test('parses named houses and coordinate-only rows', () => {
  const result = parseHouseCsv(
    'Name,Lat,Lng,Neighborhood,Street\nAdewale House,6.62,3.28,Ikotun,Market Road\n,6.63,3.29,Egbeda,Sample Avenue',
  );

  expect(result.error).toBe('');
  expect(result.houses).toHaveLength(2);
  expect(result.houses[0]).toMatchObject({
    name: 'Adewale House',
    latitude: 6.62,
    longitude: 3.28,
    area: 'Ikotun',
    street: 'Market Road',
  });
  expect(result.houses[1].name).toBe('House 002');
});

test('creates clearly labeled demo records with searchable Alimosho areas', () => {
  const houses = createSampleHouses();

  expect(houses).toHaveLength(5);
  expect(new Set(houses.map((house) => house.id)).size).toBe(5);
  expect(houses.every((house) => house.name.startsWith('Demo Property'))).toBe(true);
  expect(houses.map((house) => house.area)).toEqual(expect.arrayContaining(['Ikotun', 'Egbeda', 'Ayobo']));
  expect(houses.every((house) => house.localGovernment === 'Alimosho' && house.addedAt)).toBe(true);
});

test('limits rendered house features to the padded viewport, LGA, and selected area', () => {
  const houses = [
    { id: 'visible', localGovernment: 'Alimosho', area: 'Ikotun', longitude: 3.25, latitude: 6.58 },
    { id: 'padding', localGovernment: 'Alimosho', area: 'Ikotun', longitude: 3.31, latitude: 6.58 },
    { id: 'outside', localGovernment: 'Alimosho', area: 'Ikotun', longitude: 4, latitude: 7 },
    { id: 'wrong-area', localGovernment: 'Alimosho', area: 'Egbeda', longitude: 3.25, latitude: 6.58 },
    { id: 'wrong-lga', localGovernment: 'Ikeja', area: 'Ikotun', longitude: 3.25, latitude: 6.58 },
  ];

  expect(filterHousesToBounds(houses, [3.2, 6.5, 3.3, 6.6], 'Alimosho', 'Ikotun').map((house) => house.id))
    .toEqual(['visible', 'padding']);
});

test('reduces a 5,000-house dataset to the current padded viewport', () => {
  const houses = Array.from({ length: 5000 }, (_, index) => ({
    id: `house-${index}`,
    localGovernment: 'Alimosho',
    longitude: 3.2 + (index % 100) / 1000,
    latitude: 6.5 + Math.floor(index / 100) / 1000,
  }));
  const visibleHouses = filterHousesToBounds(houses, [3.24, 6.52, 3.26, 6.54], 'Alimosho');

  expect(visibleHouses.length).toBeGreaterThan(0);
  expect(visibleHouses.length).toBeLessThan(houses.length);
  expect(visibleHouses.every((house) => house.longitude >= 3.237 && house.longitude <= 3.263)).toBe(true);
});

test('skips rows with missing or out-of-range coordinates', () => {
  const result = parseHouseCsv(
    'latitude,longitude\n6.62,3.28\n,3.29\n91,3.30\n6.64,181',
  );

  expect(result.houses).toHaveLength(1);
  expect(result.skipped).toBe(3);
  expect(result.error).toBe('');
});

test('rejects CSV files without coordinate columns', () => {
  const result = parseHouseCsv('name,address\nAdewale House,Ikotun');

  expect(result.houses).toHaveLength(0);
  expect(result.error).toMatch(/latitude and longitude/i);
});

test('recognizes coordinate headers with an Excel byte-order mark', () => {
  const result = parseHouseCsv('\uFEFFlatitude,longitude\n6.62,3.28');

  expect(result.error).toBe('');
  expect(result.houses).toHaveLength(1);
});

test('recognizes the common Long header for longitude', () => {
  const result = parseHouseCsv('Street Name,House Number,Area,Lat,Long\nDemo Road,12,Ikotun,6.62,3.28');

  expect(result.error).toBe('');
  expect(result.houses[0]).toMatchObject({
    street: 'Demo Road',
    houseNumber: '12',
    area: 'Ikotun',
    latitude: 6.62,
    longitude: 3.28,
  });
});

test('previews mapped CSV columns and flags invalid coordinate rows', () => {
  const csv = 'House Number,Street Name,Latitude,Longitude,Area,Status\n12,Broad Street,6.62,3.28,Ayobo,Registered\n,Side Road,91,3.28,Ayobo,Pending';
  const preview = inspectHouseCsv(csv);

  expect(preview.mapping).toMatchObject({
    houseNumber: 'House Number',
    street: 'Street Name',
    latitude: 'Latitude',
    longitude: 'Longitude',
    area: 'Area',
    status: 'Status',
  });
  expect(preview.validCount).toBe(1);
  expect(preview.skipped).toBe(1);
  expect(preview.rows[1].errors).toContain('Missing or invalid coordinates');

  const result = parseHouseCsv(csv, 0, preview.mapping);
  expect(result.houses).toHaveLength(1);
  expect(result.houses[0]).toMatchObject({
    houseNumber: '12',
    street: 'Broad Street',
    area: 'Ayobo',
    status: 'Registered',
  });
  expect(result.houses[0].addedAt).toBeTruthy();
});

test('allows manual mapping for nonstandard CSV coordinate headers', () => {
  const csv = 'Property Label,Northing,Easting\nCorner House,6.62,3.28';
  const unmapped = inspectHouseCsv(csv);
  const mapped = inspectHouseCsv(csv, {
    name: 'Property Label',
    latitude: 'Northing',
    longitude: 'Easting',
  });

  expect(unmapped.error).toMatch(/map columns/i);
  expect(mapped.validCount).toBe(1);
  expect(parseHouseCsv(csv, 0, mapped.mapping).houses[0]).toMatchObject({
    name: 'Corner House',
    latitude: 6.62,
    longitude: 3.28,
  });
});

test('accepts the first accurate route point and subsequent chronological movement', () => {
  const first = { latitude: 6.58, longitude: 3.25, accuracy: 8, timestamp: 1000 };
  const next = { latitude: 6.5802, longitude: 3.25, accuracy: 10, timestamp: 11000 };

  expect(getRoutePointRejectionReason(null, first)).toBe('');
  expect(getRoutePointRejectionReason(first, next)).toBe('');
});

test('filters inaccurate, duplicate, out-of-order, and implausible GPS readings', () => {
  const first = { latitude: 6.58, longitude: 3.25, accuracy: 8, timestamp: 10000 };

  expect(getRoutePointRejectionReason(null, { ...first, accuracy: MAX_ROUTE_ACCURACY_METERS + 1 })).toBe('inaccurate');
  expect(getRoutePointRejectionReason(null, { ...first, accuracy: MAX_ROUTE_ACCURACY_METERS })).toBe('');
  expect(getRoutePointRejectionReason(first, { ...first, timestamp: 11000 })).toBe('duplicate');
  expect(getRoutePointRejectionReason(first, { ...first, timestamp: 9000 })).toBe('duplicate');
  expect(getRoutePointRejectionReason(first, {
    latitude: 6.59,
    longitude: 3.25,
    accuracy: 8,
    timestamp: 11000,
  })).toBe('jump');
  expect(getRoutePointRejectionReason(first, {
    ...first,
    latitude: 91,
    timestamp: 11000,
  })).toBe('invalid');
});

test('validates, measures, and classifies houses against a closed survey boundary', () => {
  const points = [
    { latitude: 6.58, longitude: 3.25 },
    { latitude: 6.58, longitude: 3.251 },
    { latitude: 6.581, longitude: 3.251 },
    { latitude: 6.581, longitude: 3.25 },
  ];
  const metrics = getSurveyMetrics(points, true);

  expect(validateSurveyBoundary(points, false)).toEqual({ status: 'open', reason: '' });
  expect(validateSurveyBoundary(points, true)).toEqual({ status: 'closed', reason: '' });
  expect(metrics.area).toBeGreaterThan(5000);
  expect(metrics.perimeter).toBeGreaterThan(350);
  expect(isHouseInsideSurveyBoundary({ latitude: 6.5805, longitude: 3.2505 }, points)).toBe(true);
  expect(isHouseInsideSurveyBoundary({ latitude: 6.582, longitude: 3.2505 }, points)).toBe(false);
  expect(countHousesInsideSurveyBoundary([
    { latitude: 6.5805, longitude: 3.2505 },
    { latitude: 6.582, longitude: 3.2505 },
  ], points)).toBe(1);
});

test('explains repeated points and self-crossing survey polygons', () => {
  const repeated = [
    { latitude: 6.58, longitude: 3.25 },
    { latitude: 6.58, longitude: 3.251 },
    { latitude: 6.581, longitude: 3.251 },
    { latitude: 6.58, longitude: 3.25 },
  ];
  const crossing = [
    { latitude: 6.58, longitude: 3.25 },
    { latitude: 6.581, longitude: 3.251 },
    { latitude: 6.58, longitude: 3.251 },
    { latitude: 6.581, longitude: 3.25 },
  ];

  expect(validateSurveyBoundary(repeated, true).reason).toMatch(/distinct/i);
  expect(validateSurveyBoundary(crossing, true).reason).toMatch(/cross/i);
  expect(getSurveyMetrics(crossing, true)).toEqual({ area: null, perimeter: null });
});

test('keeps multiple saved survey areas separate and restores persisted areas', () => {
  const points = [
    { latitude: 6.58, longitude: 3.25 },
    { latitude: 6.58, longitude: 3.251 },
    { latitude: 6.581, longitude: 3.251 },
  ];
  const savedAreas = [
    { id: 'one', name: 'Block one', points, closed: true },
    { id: 'two', name: 'Block two', points: points.map((point) => ({ ...point, longitude: point.longitude + 0.01 })), closed: true },
  ];
  const collection = createSurveyFeatureCollection(savedAreas, null);
  const storage = {
    getItem: (key) => (key === SURVEY_AREAS_STORAGE_KEY ? JSON.stringify(savedAreas) : null),
  };

  expect(collection.features.filter((feature) => feature.geometry.type === 'Polygon')).toHaveLength(2);
  expect(collection.features.find((feature) => feature.properties.kind === 'survey-area' && feature.properties.id === 'one')
    .properties.color).toBe('#ed9a45');
  const coloredCollection = createSurveyFeatureCollection([
    { ...savedAreas[0], color: '#23aabb' },
  ], null);
  expect(coloredCollection.features.find((feature) => feature.properties.kind === 'survey-area').properties.color)
    .toBe('#23aabb');
  expect(readSavedSurveyAreas(storage)).toEqual(savedAreas);
});

test('provides an explicit plot-area action after capturing three boundary points', () => {
  const onPlotArea = jest.fn();
  const onCaptureMovementAsBoundaryChange = jest.fn();
  render(
    <SurveyPanel
      activeAreaId={null}
      area={null}
      boundaryReason=""
      boundaryStatus="open"
      captureMovementAsBoundary={false}
      collapsed={false}
      houseCount={0}
      housesInside={null}
      housesOutside={null}
      isBoundaryClosed={false}
      isCapturingGps={false}
      isTracking={false}
      locationError=""
      mapMode="idle"
      onCaptureGps={jest.fn()}
      onCaptureMovementAsBoundaryChange={onCaptureMovementAsBoundaryChange}
      onMapModeChange={jest.fn()}
      onOpenBoundary={jest.fn()}
      onPlotArea={onPlotArea}
      onPointIndexToMove={jest.fn()}
      onRemoveAllPoints={jest.fn()}
      onRemovePoint={jest.fn()}
      onSaveBoundary={jest.fn()}
      onSelectSavedArea={jest.fn()}
      onStartNew={jest.fn()}
      onStartTracking={jest.fn()}
      onSurveyColorChange={jest.fn()}
      onSurveyNameChange={jest.fn()}
      onToggleCollapsed={jest.fn()}
      perimeter={null}
      pointIndexToMove={null}
      points={[
        { latitude: 6.58, longitude: 3.25 },
        { latitude: 6.58, longitude: 3.251 },
        { latitude: 6.581, longitude: 3.251 },
      ]}
      saveError=""
      savedAreas={[]}
      surveyColor="#ed9a45"
      surveyName=""
      trackingStatus=""
      userLocation={null}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: /Plot area/ }));
  expect(onPlotArea).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('checkbox', { name: /Capture walking track as boundary points/ }));
  expect(onCaptureMovementAsBoundaryChange).toHaveBeenCalledWith(true);
});
