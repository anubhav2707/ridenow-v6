// Routing port. Production would call OSRM; the MVP ships a deterministic
// Haversine estimator so fares are reproducible in CI (no network, no ML —
// ETA/routing beyond OSRM defaults is explicitly out of scope).
export interface LatLng {
  lat: number;
  lng: number;
}

export interface RouteResult {
  distanceMeters: number;
  durationSeconds: number;
}

export interface RoutingService {
  route(pickup: LatLng, dropoff: LatLng): Promise<RouteResult>;
}

const EARTH_RADIUS_M = 6_371_000;
// ~30 km/h average urban speed; keeps duration a pure function of distance.
const ASSUMED_SPEED_MPS = 8.33;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export class HaversineRouting implements RoutingService {
  async route(pickup: LatLng, dropoff: LatLng): Promise<RouteResult> {
    const distanceMeters = Math.round(haversineMeters(pickup, dropoff));
    const durationSeconds = Math.max(
      1,
      Math.round(distanceMeters / ASSUMED_SPEED_MPS),
    );
    return { distanceMeters, durationSeconds };
  }
}

/** Nest DI token for the active RoutingService. */
export const ROUTING = Symbol('ROUTING');
