import type { HeldPermit } from "../runs/run-model.js";

export interface ResourceState {
  resourceId: string;
  capacity: number;
  held: number;
  healthy: boolean;
  reason: string;
}

export interface ResourceStore {
  list(): Promise<ResourceState[]>;
  held(): Promise<HeldPermit[]>;
  findHeld(permitId: string): Promise<HeldPermit | null>;
  release(permitId: string): Promise<boolean>;
}

export interface ReleaseSweep {
  released: string[];
  kept: number;
}
