import { randomInt } from "node:crypto";
import type { Pool } from "pg";
import { BANK_CODE, BIC, CURRENCY } from "../domain/constants.js";
import { buildUaeIban } from "../domain/iban.js";

export interface Account {
  id: string;
  tenantId: string;
  accountNumber: string;
  iban: string;
  bic: string;
  currency: string;
  productCode: string;
  status: "open" | "restricted" | "closed";
  openedAt: string;
}

export interface CreateAccountInput {
  tenantId: string;
  productCode?: string;
  actor: string;
  requestId?: string;
}

interface AccountRow {
  id: string;
  tenant_id: string;
  account_number: string;
  iban: string;
  bic: string;
  currency: string;
  product_code: string;
  status: "open" | "restricted" | "closed";
  opened_at: Date;
}

export function mapAccount(row: AccountRow): Account {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    accountNumber: row.account_number.trimEnd(),
    iban: row.iban.trim(),
    bic: row.bic.trim(),
    currency: row.currency,
    productCode: row.product_code,
    status: row.status,
    openedAt: row.opened_at.toISOString(),
  };
}

function generateAccountNumber(): string {
  let digits = "1";
  for (let index = 0; index < 15; index += 1) {
    digits += String(randomInt(0, 10));
  }
  return digits;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}

/** Create the account row and its zeroed balance cache in one transaction. */
export async function createAccount(db: Pool, input: CreateAccountInput): Promise<Account> {
  const productCode = input.productCode ?? "corporate_current";
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    let account: Account | undefined;
    for (let attempt = 0; attempt < 5 && account === undefined; attempt += 1) {
      const accountNumber = generateAccountNumber();
      const iban = buildUaeIban(BANK_CODE, accountNumber);
      try {
        const inserted = await client.query<AccountRow>(
          `INSERT INTO accounts (tenant_id, account_number, iban, bic, currency, product_code, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'open')
           RETURNING id, tenant_id, account_number, iban, bic, currency, product_code, status, opened_at`,
          [input.tenantId, accountNumber, iban, BIC, CURRENCY, productCode],
        );
        const row = inserted.rows[0];
        if (row !== undefined) account = mapAccount(row);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }

    if (account === undefined) {
      throw new Error("could not allocate a unique account number");
    }

    await client.query(
      `INSERT INTO account_balances (account_id, available_minor, pending_minor, held_minor, ledger_minor)
       VALUES ($1, 0, 0, 0, 0)`,
      [account.id],
    );

    await client.query(
      `INSERT INTO audit_log (tenant_id, actor, action, entity_type, entity_id, after, request_id)
       VALUES ($1, $2, 'account.opened', 'account', $3, $4, $5)`,
      [
        input.tenantId,
        input.actor,
        account.id,
        JSON.stringify({ iban: account.iban, product_code: account.productCode }),
        input.requestId ?? null,
      ],
    );

    await client.query("COMMIT");
    return account;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
