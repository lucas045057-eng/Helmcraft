import type { Orchestrator } from '../services/orchestrator.js'
import type { WorkerGateway } from '../services/workers.js'
import type { AuthService } from '../services/auth.js'
import type { PolicyService } from '../services/policy.js'
import type { StoredEvent, TaskStore } from '../services/store.js'
import type { HttpService } from '../services/http.js'
import type { Clock } from '@agent-hub/common/clock'
import type { WorkspacePointerView, HubSystemStatus, RunView, TaskTransition, TaskView, WorkerView } from '@agent-hub/protocol'
import type {} from '../../node_modules/cordis/lib/context.d.ts'
import type {} from '../../node_modules/cordis/lib/events.d.ts'

// rc.13 exports these declarations through a barrel. Augment their source
// modules so the re-exports and Cordis's internal declarations share the types.
declare module '../../node_modules/cordis/lib/context.d.ts' {
  interface Context {
    clock: Clock
    http: HttpService
    store: TaskStore
    policy: PolicyService
    auth: AuthService
    workers: WorkerGateway
    orchestrator: Orchestrator
    feishu?: { status(): Exclude<HubSystemStatus['feishu']['state'], 'disabled'> }
  }
}

declare module '../../node_modules/cordis/lib/events.d.ts' {
  interface Events {
    'task/created'(task: TaskView): void
    'task/transitioned'(transition: TaskTransition): void
    'run/updated'(run: RunView): void
    'run/events'(runId: string, taskId: string, events: StoredEvent[]): void
    'workspace/pointer'(view: WorkspacePointerView): void
    'worker/updated'(worker: WorkerView, previous: WorkerView | null): void
    'worker/connected'(workerId: string, epoch: number): void
    'worker/disconnected'(workerId: string, reason: string): void
    'auth/revoked'(credentialHash: string): void
    'hub/status'(status: HubSystemStatus): void
    'retention/level'(): void
    'feishu/status'(status: HubSystemStatus['feishu']): void
    'task/result-delivery'(taskId: string): void
    'hub/drain'(): Promise<void>
    'hub/config-rejected'(section: string, error: string): void
  }
}
