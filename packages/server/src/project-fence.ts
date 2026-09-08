import { sql, type QueryExecutorProvider } from "kysely";

export async function lockProject(executor: QueryExecutorProvider & { readonly isTransaction: boolean }, projectId: string): Promise<void> {
  if (!executor.isTransaction) throw new Error("Project fences require a transaction");
  await sql`select pg_advisory_xact_lock(74102, hashtext(${projectId}))`.execute(executor);
}
