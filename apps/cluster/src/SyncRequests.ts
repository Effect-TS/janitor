import type { SyncGeneration, SyncScope } from "@janitor/domain/GitHub/Sync"
import { syncScopeKey } from "@janitor/domain/GitHub/Sync"
import type { OutboxRequest } from "./WorkflowOutbox.ts"

export const DISCOVER_INSTALLATIONS_TAG = "Janitor/DiscoverInstallationsV1"

export const SYNC_INSTALLATION_INVENTORY_TAG = "Janitor/SyncInstallationInventoryV1"
export const SYNC_REPOSITORY_TRACK_TAG = "Janitor/SyncRepositoryTrackV1"
export const REFRESH_ENTITY_TAG = "Janitor/RefreshEntityV1"

export const workflowTagForScope = (scope: SyncScope): string => {
  switch (scope._tag) {
    case "AppInventory":
      return DISCOVER_INSTALLATIONS_TAG
    case "InstallationInventory":
      return SYNC_INSTALLATION_INVENTORY_TAG
    case "RepositoryTrack":
      return SYNC_REPOSITORY_TRACK_TAG
    case "Entity":
      return REFRESH_ENTITY_TAG
  }
}

/**
 * The outbox request for one scope generation. The execution key includes
 * the generation so a follow-up after completion is a new execution, while
 * a lost submission resubmits the identical payload.
 */
export const syncRequest = (scope: SyncScope, generation: SyncGeneration): OutboxRequest => ({
  workflowTag: workflowTagForScope(scope),
  executionKey: `${syncScopeKey(scope)}:${generation}`,
  payload: { scope, generation },
})
