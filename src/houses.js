import Papa from 'papaparse';

export const STORAGE_KEY = 'alimosho-house-register';

function normalizeHeader(header) {
  return header.trim().replace(/^\uFEFF/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function createHouseId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createSampleHouses(localGovernment = 'Alimosho') {
  const now = Date.now();
  const samples = [
    {
      name: 'Demo Property - Ikotun',
      houseNumber: '12',
      latitude: 6.5528,
      longitude: 3.2689,
      address: 'Demo Market Road',
      area: 'Ikotun',
      street: 'Demo Market Road',
      status: 'Registered',
      daysAgo: 2,
    },
    {
      name: 'Demo Property - Egbeda',
      houseNumber: '8',
      latitude: 6.5918,
      longitude: 3.2896,
      address: 'Demo Avenue',
      area: 'Egbeda',
      street: 'Demo Avenue',
      status: 'Pending',
      daysAgo: 7,
    },
    {
      name: 'Demo Property - Ayobo',
      houseNumber: '24',
      latitude: 6.6026,
      longitude: 3.2445,
      address: 'Demo Crescent',
      area: 'Ayobo',
      street: 'Demo Crescent',
      status: 'Registered',
      daysAgo: 18,
    },
    {
      name: 'Demo Property - Idimu',
      houseNumber: '5',
      latitude: 6.5758,
      longitude: 3.2846,
      address: 'Demo Close',
      area: 'Idimu',
      street: 'Demo Close',
      status: 'Pending',
      daysAgo: 35,
    },
    {
      name: 'Demo Property - Ipaja',
      houseNumber: '31',
      latitude: 6.6101,
      longitude: 3.2679,
      address: 'Demo Street',
      area: 'Ipaja',
      street: 'Demo Street',
      status: 'Registered',
      daysAgo: 3,
    },
  ];

  return samples.map(({ daysAgo, ...house }) => ({
    ...house,
    id: createHouseId(),
    localGovernment,
    addedAt: new Date(now - daysAgo * 86400000).toISOString(),
  }));
}

export function filterHousesToBounds(houses, bounds, localGovernment, selectedArea = '', paddingRatio = 0.15) {
  const [west, south, east, north] = bounds;
  const longitudePadding = (east - west) * paddingRatio;
  const latitudePadding = (north - south) * paddingRatio;
  const areaKey = selectedArea.trim().toLowerCase();

  return houses.filter((house) => {
    if (String(house.localGovernment || 'Alimosho').trim() !== localGovernment) return false;
    if (areaKey && String(house.area || '').trim().toLowerCase() !== areaKey) return false;
    return Number.isFinite(house.longitude)
      && Number.isFinite(house.latitude)
      && house.longitude >= west - longitudePadding
      && house.longitude <= east + longitudePadding
      && house.latitude >= south - latitudePadding
      && house.latitude <= north + latitudePadding;
  });
}

const CSV_FIELD_ALIASES = {
  name: ['name', 'housename', 'propertyname'],
  houseNumber: ['housenumber', 'number', 'propertynumber'],
  latitude: ['latitude', 'lat'],
  longitude: ['longitude', 'long', 'lon', 'lng'],
  address: ['address', 'propertyaddress', 'location'],
  area: ['area', 'neighborhood', 'locality'],
  street: ['street', 'streetname', 'road'],
  status: ['status', 'registrationstatus'],
};

function getColumnMapping(fields, overrides = {}) {
  return Object.fromEntries(Object.entries(CSV_FIELD_ALIASES).map(([key, aliases]) => {
    const override = overrides[key];
    const selected = fields.includes(override)
      ? override
      : fields.find((field) => aliases.includes(normalizeHeader(field))) || '';
    return [key, selected];
  }));
}

export function inspectHouseCsv(text, columnOverrides = {}) {
  const parsed = Papa.parse(text, {
    header: true,
    skipEmptyLines: 'greedy',
  });
  const fields = parsed.meta.fields || [];
  const mapping = getColumnMapping(fields, columnOverrides);

  if (!mapping.latitude || !mapping.longitude) {
    return {
      fields,
      mapping,
      rows: [],
      validCount: 0,
      skipped: 0,
      error: 'Map columns to both latitude and longitude to continue.',
    };
  }

  const rows = parsed.data.map((row, index) => {
    const latitudeText = String(row[mapping.latitude] ?? '').trim();
    const longitudeText = String(row[mapping.longitude] ?? '').trim();
    const latitude = Number(latitudeText);
    const longitude = Number(longitudeText);
    const errors = [];

    if (
      !latitudeText
      || !longitudeText
      || !Number.isFinite(latitude)
      || !Number.isFinite(longitude)
      || latitude < -90
      || latitude > 90
      || longitude < -180
      || longitude > 180
    ) {
      errors.push('Missing or invalid coordinates');
    }

    const values = Object.fromEntries(Object.keys(CSV_FIELD_ALIASES).map((key) => [
      key,
      String(mapping[key] ? row[mapping[key]] ?? '' : '').trim(),
    ]));

    return {
      rowNumber: index + 2,
      values: { ...values, latitude, longitude },
      errors,
      valid: errors.length === 0,
    };
  });

  const validCount = rows.filter((row) => row.valid).length;
  return {
    fields,
    mapping,
    rows,
    validCount,
    skipped: rows.length - validCount,
    error: validCount ? '' : rows.length ? 'No valid rows are ready to import.' : 'The CSV contains no house rows.',
  };
}

export function parseHouseCsv(text, existingCount = 0, columnOverrides = {}) {
  const preview = inspectHouseCsv(text, columnOverrides);
  if (!preview.validCount) {
    return {
      houses: [],
      skipped: preview.skipped,
      error: preview.error,
    };
  }

  const addedAt = new Date().toISOString();
  const houses = preview.rows.filter((row) => row.valid).map(({ values }, index) => ({
    id: createHouseId(),
    name: values.name || values.houseNumber || `House ${String(existingCount + index + 1).padStart(3, '0')}`,
    houseNumber: values.houseNumber,
    latitude: values.latitude,
    longitude: values.longitude,
    address: values.address,
    area: values.area,
    street: values.street,
    status: values.status,
    addedAt,
  }));

  return { houses, skipped: preview.skipped, error: '' };
}