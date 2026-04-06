/**
 * Execution presets — common execution phase configurations.
 *
 * ServerExecution: Full pipeline for domain entities.
 * InternalExecution: No emit, for framework/operational entities.
 * TransportExecution: Minimal, handler-driven.
 */

import type { StorageStrategy } from './storage-strategies';
import { Parse, type ParseConfig } from './capability-constructors';
import { Validate, type ValidateConfig } from './capability-constructors';
import { Emit, type EmitConfig } from './capability-constructors';
import { Respond, type RespondConfig } from './capability-constructors';

export interface ServerExecutionConfig {
  readonly parse: ParseConfig;
  readonly validate: ValidateConfig;
  readonly persist: StorageStrategy;
  readonly emit: EmitConfig;
  readonly respond: RespondConfig;
}

export interface InternalExecutionConfig {
  readonly parse: ParseConfig;
  readonly validate: ValidateConfig;
  readonly persist: StorageStrategy;
  readonly respond: RespondConfig;
}

export interface TransportExecutionConfig {
  readonly parse: ParseConfig;
  readonly respond: RespondConfig;
}

/** Full server entity — standard execution capabilities. */
export function ServerExecution(persist: StorageStrategy): ServerExecutionConfig {
  return {
    parse: Parse(),
    validate: Validate(),
    persist,
    emit: Emit(),
    respond: Respond(),
  };
}

/** Internal entity — no emit. Used for framework/operational entities. */
export function InternalExecution(persist: StorageStrategy): InternalExecutionConfig {
  return {
    parse: Parse(),
    validate: Validate(),
    persist,
    respond: Respond(),
  };
}

/** Transport entity — minimal, handler-driven. */
export function TransportExecution(): TransportExecutionConfig {
  return {
    parse: Parse(),
    respond: Respond(),
  };
}
