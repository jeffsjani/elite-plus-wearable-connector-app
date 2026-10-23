import { saveValidationJson } from './CertificationJsonExport'
import { productionSyncReceiptFilename, type ProductionSyncReceipt } from './ProductionV8Sync'

export async function exportProductionSyncReceipt(receipt: ProductionSyncReceipt): Promise<string> {
  const json = JSON.stringify(receipt, null, 2)
  const filename = productionSyncReceiptFilename(receipt)
  await saveValidationJson(filename, json, 'Elite+ V8 production sync receipt', 'Share your Elite+ V8 sync receipt')
  return 'Sync receipt shared'
}
