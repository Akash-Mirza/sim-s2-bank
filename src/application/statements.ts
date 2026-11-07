import {
  getStatementAccount,
  ledgerCacheSnapshot,
  statementLines,
  statementOpeningMinor,
} from "../adapters/db/statements.js";
import type { Queryable } from "../adapters/db/types.js";
import { DomainError, notFound } from "../domain/errors.js";
import { type Statement, buildStatement, validateStatementRange } from "../domain/statement.js";

export interface StatementRequest {
  tenantId: string;
  accountId: string;
  from: string;
  to: string;
}

/**
 * Read one statement. The repository returns the opening balance and the booked
 * lines; the domain builds the statement and proves that it closes. Independently,
 * the customer ledger is compared with the balance cache so drift fails the request
 * instead of producing a plausible-looking lie.
 */
export async function loadStatement(db: Queryable, input: StatementRequest): Promise<Statement> {
  validateStatementRange(input.from, input.to);

  const account = await getStatementAccount(db, input.tenantId, input.accountId);
  if (account === null) throw notFound("account not found");

  const cache = await ledgerCacheSnapshot(db, input.tenantId, input.accountId);
  if (cache !== null && cache.ledgerMinor !== cache.cacheMinor) {
    throw new DomainError("internal_error", "ledger and balance cache disagree", 500, {
      account_id: input.accountId,
      ledger_minor: cache.ledgerMinor.toString(),
      cache_minor: cache.cacheMinor.toString(),
    });
  }

  const openingMinor = await statementOpeningMinor(db, input.tenantId, input.accountId, input.from);
  const lines = await statementLines(db, input.tenantId, input.accountId, input.from, input.to);

  return buildStatement({
    accountId: account.id,
    iban: account.iban,
    currency: account.currency,
    from: input.from,
    to: input.to,
    openingMinor,
    lines,
  });
}
