export async function physicalFinalizationRead<T>(operation: Promise<T>, label: string, timeoutMs = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out`), {
          code: 'PHYSICAL_FINALIZATION_TIMEOUT',
        })), timeoutMs)
      }),
    ])
  } finally { clearTimeout(timer) }
}
