import { describeFields } from '../core/fields';
import type { Manipulation } from '../core/manipulation';
import { bubblingAcid } from './bubbling-acid';
import { crack } from './crack';
import { goo } from './goo';
import { grass } from './grass';
import { gridWarp } from './grid-warp';
import { shoot } from './shoot';
import { eatingAcid } from './eating-acid';
import { skew } from './skew';
import { tear } from './tear';

export const MANIPULATIONS: Manipulation[] = [goo, skew, shoot, bubblingAcid, eatingAcid, tear, gridWarp, grass, crack];

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
