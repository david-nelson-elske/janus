/**
 * StepConfig — universal base interface for all pipeline step configurations.
 *
 * Every slot in every lifecycle phase (inbound, execution, outbound) is a step.
 * This is the shared shape.
 */

/** Universal step config base. */
export interface StepConfig {
  /** Does this step run inside the store transaction? */
  readonly transactional: boolean;
  /** Which adapter implementation handles this step? */
  readonly adapter?: string;
  /** Sequencing order within a phase. Lower runs first. */
  readonly order: number;
}

/**
 * Create a frozen step constructor from defaults.
 * Returns a function that merges user config with the step's defaults.
 */
export function createStepConstructor<T extends StepConfig>(
  defaults: T,
): (config?: Partial<Omit<T, 'transactional'>>) => T {
  return (config) => Object.freeze({ ...defaults, ...config }) as T;
}
