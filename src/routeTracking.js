export const MAX_ROUTE_ACCURACY_METERS = 100;
const MIN_ROUTE_POINT_DISTANCE_METERS = 2;
const MAX_ROUTE_SPEED_METERS_PER_SECOND = 55;

function distanceBetweenPoints(first, second) {
  const earthRadiusMeters = 6371000;
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const latitudeDifference = toRadians(second.latitude - first.latitude);
  const longitudeDifference = toRadians(second.longitude - first.longitude);
  const firstLatitude = toRadians(first.latitude);
  const secondLatitude = toRadians(second.latitude);
  const haversine = Math.sin(latitudeDifference / 2) ** 2
    + Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDifference / 2) ** 2;

  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

export function getRoutePointRejectionReason(previousPoint, point) {
  if (
    !Number.isFinite(point.latitude)
    || point.latitude < -90
    || point.latitude > 90
    || !Number.isFinite(point.longitude)
    || point.longitude < -180
    || point.longitude > 180
    || !Number.isFinite(point.accuracy)
  ) return 'invalid';
  if (point.accuracy > MAX_ROUTE_ACCURACY_METERS) return 'inaccurate';
  if (!previousPoint) return '';

  const elapsedSeconds = (point.timestamp - previousPoint.timestamp) / 1000;
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return 'duplicate';

  const distanceMeters = distanceBetweenPoints(previousPoint, point);
  if (distanceMeters < MIN_ROUTE_POINT_DISTANCE_METERS) return 'duplicate';
  if (distanceMeters / elapsedSeconds > MAX_ROUTE_SPEED_METERS_PER_SECOND) return 'jump';
  return '';
}
