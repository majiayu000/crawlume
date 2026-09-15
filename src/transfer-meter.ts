import { AsyncLocalStorage } from "node:async_hooks";

type TransferStore = { bytes: number };

const transferStore = new AsyncLocalStorage<TransferStore>();

export async function runWithTransferMeter<T>(
  operation: () => Promise<T>,
): Promise<{ result: T; bytes: number }> {
  const store: TransferStore = { bytes: 0 };
  const result = await transferStore.run(store, operation);
  return { result, bytes: store.bytes };
}

export function addTransferBytes(bytes: number): void {
  const store = transferStore.getStore();
  if (store === undefined || !Number.isFinite(bytes) || bytes <= 0) {
    return;
  }
  store.bytes += bytes;
}
