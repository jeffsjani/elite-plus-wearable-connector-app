import { observationBatchManager } from './ObservationBatchManager'

/** The Build 31 athlete Sync action: delivery only, with no BLE/history request. */
export function runNormalProductionSync() {
  return observationBatchManager.process()
}
