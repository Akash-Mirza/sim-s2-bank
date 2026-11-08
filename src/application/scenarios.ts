import type { Pool, PoolClient } from "pg";
import { loadPayoutForUpdate } from "../adapters/db/payouts.js";
import {
  type ScenarioRecord,
  findArmedScenarioForUpdate,
  getScenario,
  insertScenario,
  listAllScenarios,
  listScenarios,
  setScenarioStatus,
} from "../adapters/db/scenarios.js";
import { DomainError, notFound, validationError } from "../domain/errors.js";
import { type PayoutStatus, isTerminalPayoutStatus } from "../domain/payout.js";
import {
  SCENARIO_KINDS,
  type ScenarioKind,
  type ScenarioResolution,
  type ScenarioStatus,
  assertShortfall,
  defaultShortfallMinor,
  resolveScenario,
} from "../domain/scenario.js";

async function auditScenario(
  client: PoolClient,
  input: {
    tenantId: string;
    actor: string;
    action: string;
    scenario: ScenarioRecord;
    before?: unknown;
    after?: unknown;
    requestId?: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (tenant_id, actor, action, entity_type, entity_id, before, after, request_id)
     VALUES ($1, $2, $3, 'scenario', $4, $5, $6, $7)`,
    [
      input.tenantId,
      input.actor,
      input.action,
      input.scenario.id,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      input.requestId ?? null,
    ],
  );
}

/**
 * Arm one failure scenario against one payout.
 *
 * The payout row is locked first so two concurrent arms cannot both pass the
 * terminal-state check; the partial unique index is the final guard.
 */
export async function armScenarioTx(
  client: PoolClient,
  input: {
    tenantId: string;
    payoutId: string;
    kind: ScenarioKind;
    shortfallMinor?: bigint;
    actor: string;
    requestId?: string;
  },
): Promise<ScenarioRecord> {
  const payout = await loadPayoutForUpdate(client, input.tenantId, input.payoutId);
  if (payout === null) {
    throw notFound("payout not found");
  }
  if (isTerminalPayoutStatus(payout.status)) {
    throw validationError(
      `payout is already ${payout.status}; a scenario cannot change its outcome`,
      { status: payout.status },
    );
  }

  let shortfallMinor: bigint | null = null;
  if (input.kind === "underpaid") {
    shortfallMinor = input.shortfallMinor ?? defaultShortfallMinor(payout.amountMinor);
    assertShortfall(payout.amountMinor, shortfallMinor);
  } else if (input.shortfallMinor !== undefined) {
    throw validationError(`shortfall only applies to underpaid, not ${input.kind}`);
  }

  let scenario: ScenarioRecord;
  try {
    scenario = await insertScenario(client, {
      tenantId: payout.tenantId,
      accountId: payout.accountId,
      payoutId: payout.id,
      kind: input.kind,
      shortfallMinor,
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      if ((error as { code?: string }).code === "23505") {
        throw new DomainError(
          "scenario_conflict",
          "a failure scenario is already armed for this payout",
          409,
        );
      }
    }
    throw error;
  }

  await auditScenario(client, {
    tenantId: payout.tenantId,
    actor: input.actor,
    action: "scenario.armed",
    scenario,
    after: {
      kind: scenario.kind,
      payout_id: scenario.payoutId,
      shortfall_minor: scenario.shortfallMinor?.toString() ?? null,
    },
    requestId: input.requestId,
  });

  return scenario;
}

export async function disarmScenarioTx(
  client: PoolClient,
  input: { tenantId: string; scenarioId: string; actor: string; requestId?: string },
): Promise<ScenarioRecord> {
  const current = await getScenario(client, input.tenantId, input.scenarioId);
  if (current === null) {
    throw notFound("scenario not found");
  }
  if (current.status === "consumed") {
    throw new DomainError(
      "invalid_state_transition",
      "a consumed scenario cannot be disarmed",
      409,
      { from: current.status, to: "disarmed", allowed: ["armed"] },
    );
  }

  const scenario = await setScenarioStatus(client, current.id, "disarmed");

  await auditScenario(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    action: "scenario.disarmed",
    scenario,
    before: { status: current.status },
    after: { status: scenario.status },
    requestId: input.requestId,
  });

  return scenario;
}

export async function listTenantScenarios(
  db: Pool,
  tenantId: string,
  options: { status?: ScenarioStatus; limit: number },
): Promise<ScenarioRecord[]> {
  return listScenarios(db, tenantId, options);
}

export async function listEveryScenario(
  db: Pool,
  options: { status?: ScenarioStatus; limit: number },
): Promise<ScenarioRecord[]> {
  return listAllScenarios(db, options);
}

export interface PayoutScenarioOutcome extends ScenarioResolution {
  scenario: ScenarioRecord | null;
}

/**
 * Resolve the armed scenario (if any) for the transition a payout is about to make.
 * Called inside the money transaction, after the payout row is locked.
 */
export async function resolvePayoutScenarioTx(
  client: PoolClient,
  input: {
    tenantId: string;
    payoutId: string;
    from: PayoutStatus;
    to: PayoutStatus;
    amountMinor: bigint;
  },
): Promise<PayoutScenarioOutcome> {
  const armed = await findArmedScenarioForUpdate(client, input.tenantId, input.payoutId);

  if (armed === null) {
    return {
      to: input.to,
      settleMinor: input.to === "settled" ? input.amountMinor : null,
      block: null,
      consumes: false,
      applied: null,
      scenario: null,
    };
  }

  const resolution = resolveScenario({
    kind: armed.kind,
    from: input.from,
    to: input.to,
    amountMinor: input.amountMinor,
    shortfallMinor: armed.shortfallMinor,
  });

  if (resolution.consumes) {
    await setScenarioStatus(client, armed.id, "consumed");
  }

  return { ...resolution, scenario: armed };
}

export function parseScenarioKind(value: string): ScenarioKind {
  if (!(SCENARIO_KINDS as readonly string[]).includes(value)) {
    throw validationError(`unknown scenario kind ${value}`, { allowed: SCENARIO_KINDS });
  }
  return value as ScenarioKind;
}
