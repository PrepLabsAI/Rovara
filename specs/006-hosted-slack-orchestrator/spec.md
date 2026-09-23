# Feature Specification: Hosted Slack Orchestrator

**Feature Branch**: `mainline`

**Created**: 2026-09-23

**Status**: Draft, awaiting review

**Input**: User description: "Take the hosted direction for the Slack integration. Tie the workspace to the Slack thread: tagging AgentX in a new thread creates a new workspace automatically and starts working; if Bob later asks for more changes in that thread, the same workspace is reused. Acknowledge immediately while a new workspace is being prepared. Each channel is bound to a single project. Retire the local `agentx slack` command. Anybody who is a member of the channel can start a new workspace, but each person can have at most 3 workspaces at once, and the organization at most 20. Archiving idle workspaces and handling unpushed work are backlog items."

**Constitution**: Version 1.2.0. Principle I (orchestration-only clients) and Principle III (Slack thread workspaces) were amended for this feature.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Start Work From a New Slack Thread (Priority: P1)

A member of the project's channel mentions `@AgentX` with a coding request. Within seconds, AgentX replies in the thread that it is setting up a workspace. It prepares a new workspace for that thread, says when the work starts, and posts the result in the same thread. No laptop, terminal, or personal login has to stay active.

**Why this priority**: This is the minimum useful hosted workflow and replaces the retired `agentx slack run`.

**Independent Test**: Mention AgentX in a new thread of a bound channel. Verify the acknowledgement arrives before workspace preparation finishes, a new thread workspace is created, and the result is posted in that thread.

**Acceptance Scenarios**:

1. **Given** a channel bound to a project, **When** a channel member mentions AgentX in a new thread, **Then** AgentX acknowledges in that thread within seconds and prepares a new workspace for it.
2. **Given** the thread's workspace becomes ready, **When** the request starts, **Then** AgentX posts that it has started, and later posts the final response or a safe failure message in the same thread.
3. **Given** workspace preparation fails, **When** AgentX observes the failure, **Then** it says so in the thread, and a later mention in that thread can retry preparation.

---

### User Story 2 - Continue Collaboratively in the Same Thread (Priority: P1)

Pratik starts a thread and AgentX makes a change. Later, Bob, another channel member, mentions AgentX in the same thread and asks for more changes. AgentX continues in the same workspace and with the same thread conversation, so Bob's request builds on the existing changes.

**Why this priority**: The thread-as-workspace model is the core decision of this feature.

**Independent Test**: Send two mentions from different channel members in one thread. Verify both run in the same workspace, in order, and the second request can see the first request's changes.

**Acceptance Scenarios**:

1. **Given** a thread with a workspace, **When** any channel member mentions AgentX in that thread, **Then** the request runs in that workspace with that thread's conversation history.
2. **Given** a request is still running in a thread, **When** another mention arrives in the same thread, **Then** AgentX acknowledges that it is queued and runs it after the current request finishes, in arrival order.
3. **Given** a thread creates or updates a pull request, **When** the pull request is published, **Then** it identifies the Slack users whose requests produced it.

---

### User Story 3 - Enforce Workspace Limits (Priority: P1)

Each thread workspace holds a billable EBS volume. A channel member may have at most 3 thread workspaces at once, counting threads they started. The organization may have at most 20. When a new thread would exceed either limit, AgentX declines to create a workspace and explains why in the thread. Follow-ups in existing threads are not affected.

**Why this priority**: Without limits, open-ended thread creation means unbounded EBS and compute cost.

**Independent Test**: With test limits, have one member start threads until their limit is reached, and have several members approach the organization limit. Verify that the next new thread is declined with the correct reason, that follow-ups in existing threads still run, and that simultaneous new threads never exceed a limit.

**Acceptance Scenarios**:

1. **Given** a member already has 3 thread workspaces, **When** they start a fourth thread, **Then** AgentX creates no workspace and replies that they have reached their limit, listing their existing threads.
2. **Given** the organization has 20 thread workspaces, **When** anyone starts a new thread, **Then** AgentX creates no workspace and replies that the organization limit is reached.
3. **Given** a member is at their limit, **When** they or anyone else mention AgentX in one of their existing threads, **Then** the request runs normally.
4. **Given** two new threads from the same member arrive at the same moment with one slot left, **When** both are processed, **Then** exactly one workspace is created.

---

### User Story 4 - Isolate Parallel Threads (Priority: P2)

Two people start separate threads at the same time. Each thread gets its own workspace and conversation, and the two run in parallel without seeing each other's files or history.

**Independent Test**: Start two threads within a minute. Verify both are processed concurrently in different workspaces, and neither can read or change the other's files or conversation.

**Acceptance Scenarios**:

1. **Given** two threads in the same channel, **When** both have requests, **Then** they run concurrently in separate workspaces.
2. **Given** a thread identifier, **When** it is supplied through any path other than a Slack-signed event in that thread, **Then** it grants no access to that thread's workspace.

---

### User Story 5 - Survive Retries and Restarts (Priority: P2)

Slack retries event deliveries, and the hosted service may restart or be redeployed during a long task. No request is lost or run twice, and the result still reaches the thread.

**Independent Test**: Replay the same Slack event several times, and restart the orchestrator while a task runs. Verify exactly one control-plane operation exists and the result is posted once.

**Acceptance Scenarios**:

1. **Given** Slack delivers the same event more than once, **When** AgentX processes the deliveries, **Then** at most one acknowledgement and one operation result from them.
2. **Given** the orchestrator stops while a request is queued or running, **When** it restarts, **Then** it resumes the request without resubmitting accepted work, and posts the result once.

---

### User Story 6 - Administer Channel Bindings (Priority: P3)

An administrator binds a Slack channel to one registered project and can remove the binding. Channel membership, managed in Slack, decides who may use AgentX there. AgentX ignores unbound channels.

**Independent Test**: Register a binding, then mention AgentX from bound and unbound channels. Verify only mentions in the bound channel are processed, and that a binding change applies to the next mention.

**Acceptance Scenarios**:

1. **Given** an administrator, **When** they bind a channel to a project, **Then** mentions from members of that channel are accepted for that project.
2. **Given** a binding changes or is removed, **When** the next mention arrives, **Then** the current binding applies without redeploying the service.

### Edge Cases

- A mention is the top-level message of a thread, or a reply in a thread started by someone else. In both cases, the thread's root message identifies the workspace. For limits, the member whose mention first creates the workspace is its starter.
- A mention contains no request text after the bot mention.
- Messages from bots (including AgentX itself), edited or deleted messages, and direct messages.
- A member of another organization who posts through a shared (Slack Connect) channel.
- A member who started a thread later leaves the channel. The thread remains usable by current members and still counts toward the starter's limit.
- A request that is unsigned, has an invalid signature, or has a timestamp outside Slack's replay window.
- Slack retries because the acknowledgement was slow.
- Several mentions arrive in one thread while workspace preparation is still running.
- Many new threads start at once, near either limit.
- A task runs for hours. The thread receives no final response until completion, so the "started" message must make that clear.
- A response longer than Slack's message limit.
- The Slack bot token or signing secret is rotated.
- The orchestrator is redeployed by the release pipeline while requests are queued or running.
- The Bedrock model call fails, for example because of throttling or invalid model access, and the failure must be reported in the thread.

## Requirements *(mandatory)*

### Functional Requirements

**Slack ingress**

- **FR-001**: AgentX MUST receive Slack `app_mention` events over HTTPS and MUST verify Slack's request signature and timestamp before any other processing.
- **FR-002**: AgentX MUST respond to Slack within Slack's delivery deadline, and MUST do so independently of workspace preparation and task execution.
- **FR-003**: AgentX MUST record each accepted Slack event durably, and MUST treat a repeated event as a duplicate, including after restarts.
- **FR-004**: AgentX MUST process only human `app_mention` events posted in channels bound to a project by members of the bound Slack organization. It MUST ignore all other events without creating operations.

**Threads and workspaces**

- **FR-005**: A thread MUST be identified by the Slack team, the channel, and the thread's root message timestamp.
- **FR-006**: The first accepted mention in a thread MUST create a new workspace for that thread, using the project and revision named in the channel's binding, subject to FR-011 through FR-014.
- **FR-007**: Later mentions in the same thread, from any channel member, MUST use that thread's workspace and conversation.
- **FR-008**: Requests within a thread MUST run one at a time in arrival order. Requests in different threads MUST NOT wait for each other.
- **FR-009**: A thread workspace MUST be accessible only through the hosted orchestrator for Slack-signed events in that thread. Personal logins, other threads, and other clients MUST NOT access it.
- **FR-010**: The control plane MUST support multiple thread workspaces per project, in addition to the existing single personal workspace per owner and project.

**Workspace limits**

- **FR-011**: Each thread workspace MUST record its starter: the Slack user whose mention created it.
- **FR-012**: A member MUST NOT be the starter of more than 3 existing thread workspaces. The organization MUST NOT have more than 20 existing thread workspaces. A thread workspace counts from its creation until its volume is deleted.
- **FR-013**: Limit checks and workspace creation MUST be atomic, so concurrent new threads can never exceed either limit.
- **FR-014**: When a new thread would exceed a limit, AgentX MUST create no workspace and no operation. It MUST reply in the thread with the limit reached and, for the member limit, links to the member's existing threads.
- **FR-015**: Both limits MUST be deployment configuration, so administrators can change them without a code change.

**Orchestration and replies**

- **FR-016**: The hosted orchestrator MUST expose exactly the orchestration tools available to the local orchestrator, and no repository, file, or shell access (Principle I).
- **FR-017**: AgentX MUST post in the thread: an acknowledgement on acceptance; a "preparing workspace" notice when a new workspace is being created; a "started" notice when a request begins; and the final response or a safe failure message. It MUST post a "queued" notice when a request waits behind another in the same thread.
- **FR-018**: A thread's conversation history MUST persist across orchestrator restarts and releases (Principle IV).
- **FR-019**: Only the text of the mention is the request. AgentX MUST NOT read other thread or channel messages.
- **FR-020**: Responses longer than Slack's message limit MUST be split into ordered messages in the thread.
- **FR-021**: Pull requests created or updated from a thread MUST identify the Slack users whose requests produced them.

**Reliability**

- **FR-022**: One Slack event MUST produce at most one control-plane operation, across Slack retries, queue redelivery, and orchestrator restarts.
- **FR-023**: A request whose operation is already running or finished MUST be resumed by polling that operation, never resubmitted.
- **FR-024**: Accepted requests MUST survive orchestrator restarts and releases without being lost.

**Identity and security**

- **FR-025**: The hosted orchestrator MUST call the control plane with a service identity that can act only on thread workspaces of bound channels. The service identity MUST NOT depend on any person's login or local credentials.
- **FR-026**: Every operation from a thread MUST record the requesting Slack user.
- **FR-027**: The Slack signing secret and bot token MUST be stored as secrets. They MUST NOT be written to logs, project files, or code, and rotating them MUST NOT require a code change.
- **FR-028**: Logs MUST include delivery, filtering, limit, queueing, and task lifecycle events, and MUST NOT include tokens, prompt text, or response text.

**Administration**

- **FR-029**: Administrators MUST be able to bind a channel to exactly one registered project revision, re-bind it to a newer revision, and remove the binding. Only administrators may change bindings. Existing thread workspaces keep the revision they were created with.
- **FR-030**: Binding changes MUST take effect for the next mention without a redeployment.

**Retiring local Slack mode**

- **FR-031**: The CLI MUST remove `agentx slack run`, `agentx slack configure`, and `agentx slack login`, along with their Socket Mode code and dependency.
- **FR-032**: `agentx slack logout` MUST remain, so people can delete Slack tokens stored by the retired mode from their OS credential store.
- **FR-033**: The README MUST replace the local Slack section with the hosted setup: Slack app configuration for the Events API, channel binding, limits, and thread behavior.

**Delivery**

- **FR-034**: The hosted orchestrator MUST be released by the production release pipeline (feature 005). The pipeline's trigger paths and change detection MUST include the orchestrator's inputs.
- **FR-035**: Automated contract, integration, and infrastructure tests MUST cover signature verification, filtering, duplicate events, limits under concurrency, per-thread ordering, cross-thread isolation, restart recovery, and least-privilege IAM.

### Key Entities

- **Channel Binding**: A Slack team and channel, and the one registered project it is bound to. Administrator-managed.
- **Thread Workspace**: A workspace owned by a Slack thread, identified by team, channel, and root timestamp. It records its starter and is shared by the channel members who post in the thread.
- **Workspace Allocation**: Counts of existing thread workspaces per starter and for the organization, checked atomically against the configured limits (3 and 20).
- **Slack Request**: One accepted `app_mention` event, with its event ID, thread, requesting user, request text, and processing state.
- **Thread Conversation**: The persisted orchestrator history for one thread.

## Success Criteria *(mandatory)*

- **SC-001**: 95% of accepted mentions receive an acknowledgement in their thread within 5 seconds.
- **SC-002**: In automated tests, every follow-up runs in its own thread's workspace and never in another thread's.
- **SC-003**: Replaying any accepted Slack event creates zero additional operations and zero additional acknowledgements.
- **SC-004**: Restarting the orchestrator during a task loses zero accepted requests, creates zero duplicate operations, and still posts the result once.
- **SC-005**: Two threads started within the same minute run concurrently, each in its own workspace.
- **SC-006**: Unsigned, stale, unbound-channel, other-organization, bot, and direct-message events create zero operations.
- **SC-007**: Under concurrent new threads, no member ever exceeds 3 existing thread workspaces and the organization never exceeds 20.
- **SC-008**: The service runs for seven consecutive days with no personal credential or developer machine involved.

## Assumptions and Scope

- Production uses the `instances-ebs` deployment. Each thread workspace is a per-session EBS volume on the production capacity provider. The retired `demo-microvm` deployment is out of scope.
- **Organization** means the Slack organization (team) bound to AgentX. The 20-workspace limit counts thread workspaces across all bound channels. Personal CLI workspaces are not counted.
- Channel membership is decided in Slack: a member of a channel can post a mention in it. Members of other organizations in shared (Slack Connect) channels are not accepted. Guests of the bound organization are treated as members.
- Every mention, including follow-ups, must tag AgentX. Other thread messages are not read.
- Each worker task still starts a fresh remote Pi session. Follow-ups get context from the thread conversation and the workspace files. Remote session continuity is tracked separately in issue #1.
- Archiving and deleting workspaces after 7 idle days is backlog issue #3. Preserving unpushed work before archiving is backlog issue #4.
- **Workspaces are never deleted by this feature.** Deleting a workspace is irreversible, so deletion is deferred and will be designed later, together with issues #3 and #4. Consequence, accepted on 2026-09-23: once a member has 3 thread workspaces, or the organization has 20, new threads are declined with an explanation until deletion exists. Administrators can raise the limits as configuration in the meantime (FR-015).
- The hosted orchestrator uses a Bedrock model configured at deployment, defaulting to the model the local orchestrator uses today (`amazon.nova-pro-v1:0`).

## Agreed Design Direction (for the plan)

These were decided in discussion and belong in `plan.md`. They are recorded here so they are not lost.

- Slack Events API into the existing HTTP API, via a new unauthenticated route verified by Slack's signature. A small ingress Lambda acknowledges within the deadline and records events for duplicate detection.
- An SQS FIFO queue whose message group is the thread, giving per-thread ordering and parallelism across threads ([SQS message group ID](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/using-messagegroupid-property.html)).
- An always-on ECS Fargate (ARM) service that runs the existing Pi orchestrator and AgentX tools as a queue consumer. It keeps thread conversations in durable storage and uses an IAM role for Bedrock.
- Workspace preparation stays asynchronous. The control plane already returns `202` with a `PREPARING` workspace and an operation that the orchestrator follows to `READY`.
- Limits are enforced in the control plane with a conditional transaction on per-starter and organization counters, so concurrent requests cannot exceed them.
