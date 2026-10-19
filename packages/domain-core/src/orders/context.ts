import type { PricingPort } from './ports.js';

/** Everything a reducer needs besides the state and the command. Keeps reducers pure and deterministic. */
export interface CommandContext {
  /** ISO instant of the command. */
  readonly now: string;
  readonly actorId: string | null;
  readonly deviceId?: string | null;
  /** UUID source (UUIDv7 in the API, a counter in tests). */
  readonly newId: () => string;
  readonly pricing: PricingPort;
}
