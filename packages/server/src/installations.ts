import type { InstallationStore } from "@galinum/core";
import { authorizeOperation, invokeOperation, keyAuthenticator } from "./authorization.js";
import { installationDomainHandlers } from "./installation-domain.js";
import { resolveOperation, type OperationHandlers } from "./router.js";
export type { InstallationAccess, InstallationRecord, InstallationReplay, InstallationSession } from "@galinum/core";
export { INSTALLATION_REPLAY_LIMIT, INSTALLATION_SDK_OPERATIONS, installationState, invalidateInstallationToken } from "./installation-domain.js";

export function installationHandlers(store: InstallationStore, options: { publishableKey: string; secretKey: string; projectId?: string; now: () => number }): OperationHandlers {
  const projectId = options.projectId ?? "local";
  const handlers = installationDomainHandlers(store, options);
  const authenticate = keyAuthenticator({ ...options, projectId });
  return Object.fromEntries(Object.keys(handlers).map((id) => [id, async (request: Request) => {
    const operation = resolveOperation(request);
    if (operation instanceof Response) return operation;
    if (operation.operationId !== id) return Response.json({ error: "Operation binding mismatch" }, { status: 400 });
    const grant = await authorizeOperation(operation, request, authenticate);
    return grant instanceof Response ? grant : invokeOperation(operation, request, grant, { projectId, handlers });
  }]));
}
