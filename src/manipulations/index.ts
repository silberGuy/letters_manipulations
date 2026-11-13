import { describeFields } from '../core/fields';
import type { Manipulation } from '../core/manipulation';
import { goo } from './goo';
import { hole } from './hole';
import { skew } from './skew';

export const MANIPULATIONS: Manipulation[] = [goo, skew, hole];

// Fail at startup, not mid-session, if a Manipulation's schemas are unusable.
for (const m of MANIPULATIONS) {
  describeFields(m.paramsSchema, `${m.id} params`);
  describeFields(m.toolsSchema, `${m.id} tools`);
  m.paramsSchema.parse({});
  m.stateSchema.parse({});
  m.toolsSchema.parse({});
}

export function getManipulation(id: string): Manipulation {
  const m = MANIPULATIONS.find((x) => x.id === id);
  if (!m) throw new Error(`Unknown manipulation "${id}"`);
  return m;
}
