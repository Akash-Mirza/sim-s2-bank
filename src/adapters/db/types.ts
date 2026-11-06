import type { QueryResult, QueryResultRow } from "pg";

/** Anything that can run a parameterised query: a pool or a checked-out client. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}
