const places = [
  { name: 'Abule Egba', place: 'town', coordinates: [3.3046224, 6.6478943], osmId: 501527950 },
  { name: 'Akesan', place: 'suburb', coordinates: [3.2233622, 6.5377715], osmId: 14161687529 },
  { name: 'Alagbado', place: 'suburb', coordinates: [3.2557698, 6.6597047], osmId: 14168934942 },
  { name: 'Alimosho', place: 'suburb', coordinates: [3.2782319, 6.630026], osmId: 501517933 },
  { name: 'Ashipa', place: 'village', coordinates: [3.255278, 6.582778], osmId: 501379075 },
  { name: 'Ayobo', place: 'suburb', coordinates: [3.2437944, 6.6020338], osmId: 14161650370 },
  { name: 'Egbe', place: 'suburb', coordinates: [3.2782278, 6.5437484], osmId: 14161650366 },
  { name: 'Egbeda', place: 'suburb', coordinates: [3.288964, 6.5912072], osmId: 14161651106 },
  { name: 'Idimu', place: 'suburb', coordinates: [3.2839038, 6.5752564], osmId: 501496440 },
  { name: 'Igando', place: 'town', coordinates: [3.231, 6.548657], osmId: 501496544 },
  { name: 'Ijagemo', place: 'village', coordinates: [3.225138, 6.5050405], osmId: 501397437 },
  { name: 'Ije Ododo', place: 'village', coordinates: [3.2486964, 6.4991209], osmId: 7352827282 },
  { name: 'Ijegun', place: 'suburb', coordinates: [3.254866, 6.516155], osmId: 501463453 },
  { name: 'Ikotun', place: 'town', coordinates: [3.2682658, 6.5522982], osmId: 14161650365 },
  { name: 'Ipaja', place: 'suburb', coordinates: [3.2672941, 6.609549], osmId: 14161650371 },
  { name: 'Iyana Ipaja', place: 'suburb', coordinates: [3.2973386, 6.6173097], osmId: 14161627785 },
];

const priorityByPlaceType = {
  town: 3,
  suburb: 2,
  village: 1,
};

const ALIMOSHO_AREAS = {
  type: 'FeatureCollection',
  features: places.map((place) => ({
    type: 'Feature',
    id: place.osmId,
    properties: {
      name: place.name,
      place: place.place,
      priority: priorityByPlaceType[place.place],
      osmId: place.osmId,
    },
    geometry: {
      type: 'Point',
      coordinates: place.coordinates,
    },
  })),
};

export default ALIMOSHO_AREAS;
