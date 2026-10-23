import type { ComponentProps } from 'react'
import { JCVitalV8Panel as ProductionPanel } from './ElitePlusV8Panel'
import { V8PipelineDiagnosticView } from './V8PipelineDiagnosticView'

export function JCVitalV8Panel(props: ComponentProps<typeof ProductionPanel>) {
  return <>
    <section aria-label="Connection"><ProductionPanel {...props} /></section>
    <V8PipelineDiagnosticView ownerUserId={props.ownerUserId} />
  </>
}
