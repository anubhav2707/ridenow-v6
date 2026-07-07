import {
  assertTransition,
  IllegalTransitionError,
  TRIP_TRANSITIONS,
  type TripStatus,
} from './dispatch.types';

// The trip state machine is the guard the dispatch flow validates against. Only
// requested-style forward moves (quoted -> offered -> accepted -> in_progress ->
// completed) and cancellation from a live state are legal.
describe('trip state machine transitions', () => {
  const LEGAL: Array<[TripStatus, TripStatus]> = [
    ['quoted', 'offered'],
    ['offered', 'accepted'],
    ['accepted', 'in_progress'],
    ['accepted', 'completed'],
    ['in_progress', 'completed'],
    ['quoted', 'cancelled'],
    ['offered', 'cancelled'],
    ['accepted', 'cancelled'],
    ['in_progress', 'cancelled'],
  ];

  it.each(LEGAL)('permits %s -> %s', (from, to) => {
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  const ILLEGAL: Array<[TripStatus, TripStatus]> = [
    // Cannot skip states.
    ['quoted', 'accepted'],
    ['offered', 'in_progress'],
    ['offered', 'completed'],
    // Cannot move backwards.
    ['accepted', 'offered'],
    ['in_progress', 'accepted'],
    // Terminal states are terminal.
    ['completed', 'in_progress'],
    ['completed', 'cancelled'],
    ['cancelled', 'offered'],
  ];

  it.each(ILLEGAL)('rejects %s -> %s', (from, to) => {
    expect(() => assertTransition(from, to)).toThrow(IllegalTransitionError);
  });

  it('marks completed and cancelled as terminal (no outgoing transitions)', () => {
    expect(TRIP_TRANSITIONS.completed).toHaveLength(0);
    expect(TRIP_TRANSITIONS.cancelled).toHaveLength(0);
  });
});
