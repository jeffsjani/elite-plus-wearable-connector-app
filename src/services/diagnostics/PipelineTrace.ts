import { IS_ENGINEERING_BUILD } from '../../buildMode'

export interface PipelineEvent {
  stage: 'ACQUIRED' | 'PARSE_ERROR' | 'ENQUEUE_ATTEMPT' | 'ENQUEUE_RESULT' | 'ENQUEUE_ERROR' | 'SEND' | 'RESPONSE' | 'ACK' | 'PURGE'
  at: string
  evidence: Record<string, unknown>
}

const listeners = new Set<(event: PipelineEvent) => void>()

export function tracePipeline(stage: PipelineEvent['stage'], evidence: PipelineEvent['evidence']): void {
  if (!IS_ENGINEERING_BUILD) return
  const event = { stage, at: new Date().toISOString(), evidence }
  for (const listener of listeners) {
    try { listener(event) } catch (error) { console.error('Pipeline diagnostic observer failed', error) }
  }
}

export function subscribePipeline(listener: (event: PipelineEvent) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
