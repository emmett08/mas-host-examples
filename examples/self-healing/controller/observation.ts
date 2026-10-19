/** A requirements stop can complete before any active-run observation is possible. */
export function requiresDuringRunObservation(events: readonly { type: string; data: Record<string, unknown> }[]): boolean {
  return !(events.length === 2 && events[0]?.type === 'incident.opened'
    && events[1]?.type === 'outcome' && events[1].data.outcome === 'missing_requirements');
}
