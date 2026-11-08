import type { PoolClient } from "pg";
import type { ScenarioKind, ScenarioStatus } from "../../domain/scenario.js";
import type { Queryable } from "./types.js";

export interface ScenarioRecord {
  id: string;
  tenantId: string;
  accountId: string;
  payoutId: string;
  kind: ScenarioKind;
  shortfallMinor: bigint | null;
  status: ScenarioStatus;
  armedAt: string;
  consumedAt: string | null;
  createdAt: string;
}

interface ScenarioRow {
  id: string;
  tenant_id: string;
  account_id: string;
  payout_id: string;
  kind: ScenarioKind;
  shortfall_minor: string | null;
  status: ScenarioStatus;
  armed_at: Date;
  consumed_at: Date | null;
  created_at: Date;
}

const SCENARIO_COLUMNS = `id, tenant_id, account_id, payout_id, kind, shortfall_minor, status,
  armed_at, consumed_at, created_at`;

function mapScenario(row: ScenarioRow): ScenarioRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    accountId: row.account_id,
    payoutId: row.payout_id,
    kind: row.kind,
    shortfallMinor: row.shortfall_minor === null ? null : BigInt(row.shortfall_minor),
    status: row.status,
    armedAt: row.armed_at.toISOString(),
    consumedAt: row.consumed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export async function insertScenario(
  client: PoolClient,
  input: {
    tenantId: string;
    accountId: string;
    payoutId: string;
    kind: ScenarioKind;
    shortfallMinor?: bigint | null;
  },
): Promise<ScenarioRecord> {
  const result = await client.query<ScenarioRow>(
    `INSERT INTO simulator_scenarios (tenant_id, account_id, payout_id, kind, shortfall_minor)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${SCENARIO_COLUMNS}`,
    [
      input.tenantId,
      input.accountId,
      input.payoutId,
      input.kind,
      input.shortfallMinor === undefined || input.shortfallMinor === null
        ? null
        : input.shortfallMinor.toString(),
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("scenario insert returned no row");
  return mapScenario(row);
}

/** The armed scenario for a payout, locked for the duration of the money transaction. */
export async function findArmedScenarioForUpdate(
  client: PoolClient,
  tenantId: string,
  payoutId: string,
): Promise<ScenarioRecord | null> {
  const result = await client.query<ScenarioRow>(
    `SELECT ${SCENARIO_COLUMNS} FROM simulator_scenarios
      WHERE tenant_id = $1 AND payout_id = $2 AND status = 'armed'
      ORDER BY armed_at ASC
      LIMIT 1
      FOR UPDATE`,
    [tenantId, payoutId],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapScenario(row);
}

export async function setScenarioStatus(
  client: PoolClient,
  scenarioId: string,
  status: ScenarioStatus,
): Promise<ScenarioRecord> {
  const result = await client.query<ScenarioRow>(
    `UPDATE simulator_scenarios
        SET status = $2,
            consumed_at = CASE WHEN $2 = 'consumed' THEN now() ELSE consumed_at END,
            updated_at = now()
      WHERE id = $1
      RETURNING ${SCENARIO_COLUMNS}`,
    [scenarioId, status],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("scenario update returned no row");
  return mapScenario(row);
}

export async function getScenario(
  db: Queryable,
  tenantId: string,
  scenarioId: string,
): Promise<ScenarioRecord | null> {
  const result = await db.query<ScenarioRow>(
    `SELECT ${SCENARIO_COLUMNS} FROM simulator_scenarios WHERE id = $1 AND tenant_id = $2`,
    [scenarioId, tenantId],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapScenario(row);
}

export async function listScenarios(
  db: Queryable,
  tenantId: string,
  options: { status?: ScenarioStatus; limit: number },
): Promise<ScenarioRecord[]> {
  const result = await db.query<ScenarioRow>(
    `SELECT ${SCENARIO_COLUMNS} FROM simulator_scenarios
      WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2)
      ORDER BY created_at DESC
      LIMIT $3`,
    [tenantId, options.status ?? null, options.limit],
  );
  return result.rows.map(mapScenario);
}

/** Ops-side list: the console inspects every tenant's armed faults. */
export async function listAllScenarios(
  db: Queryable,
  options: { status?: ScenarioStatus; limit: number },
): Promise<ScenarioRecord[]> {
  const result = await db.query<ScenarioRow>(
    `SELECT ${SCENARIO_COLUMNS} FROM simulator_scenarios
      WHERE ($1::text IS NULL OR status = $1)
      ORDER BY created_at DESC
      LIMIT $2`,
    [options.status ?? null, options.limit],
  );
  return result.rows.map(mapScenario);
}
