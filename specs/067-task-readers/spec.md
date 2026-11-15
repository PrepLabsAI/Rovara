# Spec 067: task readers

## Why

Rovara Cloud is moving onto Rovara's developer API (PrepLabsAI/Rovara-cloud#1). Its session page shares a session with a
person, and shows who follows it and who is viewing it. Each needs that person to read the task. Until now
`GET /v1/dev/tasks/{id}` answered only the task's owner, and Code's task roles (spec 061) cover only people in a task's
shared Slack thread. A task stays private until its owner shares it with a named person: there is no project-wide
visibility. Issue PrepLabsAI/Rovara#620.

## Requirements

- **FR-001 (share):** `PUT /v1/dev/tasks/{taskId}/readers/{developerId}` with `{ requestId, role: "viewer" }` makes that
  person a reader of the task. Only the task's owner may. The person must be registered, not removed, and hold a grant on
  the task's project (a developer or an administrator of it); otherwise the answer is the same `CONFIG_INVALID` either way,
  so it does not say who is registered. Sharing again answers `already: true`. A task has at most 50 readers. The owner
  can't share with themselves. Closed tasks can be shared.
- **FR-002 (unshare):** `DELETE /v1/dev/tasks/{taskId}/readers/{developerId}` removes a reader, by the owner only, and
  answers whether one was removed.
- **FR-003 (list):** `GET /v1/dev/tasks/{taskId}/readers` lists the readers for the owner, oldest first, each with their
  name now and whether they are still a member of the project.
- **FR-004 (read):** a reader gets `GET /v1/dev/tasks/{taskId}` and `GET /v1/dev/tasks/{taskId}/events` as the task page
  shows them to a viewer. They read only while they are still registered and a member of the project, checked on every
  read. A reader's read writes nothing (no close completion, no index update).
- **FR-005 (nothing else):** every other task route keeps its owner-only check, so for a reader the task reads as not
  found there. Sharing, unsharing and listing answer a reader `FORBIDDEN` ("only the task's owner can share it").
- **FR-006 (no leaks):** for anyone who is not the owner or a current reader, the task reads as not found, with the same
  `TASK_NOT_FOUND` as an unshared task.
- **FR-007 (audit):** `developer.task_reader_granted` and `developer.task_reader_revoked` are logged with the task, the
  owner and the reader; a read refused for a reader who lost the project logs `developer.task_reader_refused`.

`role` has one value (`viewer`), so commenter can be added later without a new route.

## Security

- **Who decides:** only the owner shares; the reader set is stored on the task (`DEVTASK#<taskId>` / `READER#<developerId>`).
- **Least access:** a reader reads; they never cancel, close, decide, continue, publish, retry or change people.
- **Revocation:** unsharing, removing the person from the project, or removing the person ends their reading at once,
  because each read checks all three.
- **Fails closed:** without the person lookup (a deployment that doesn't wire it), no task can be shared and no one but the
  owner reads.

## Out of scope

Listing tasks shared with me in `GET /v1/dev/tasks`, MCP tools, Slack, changing spec 061's Slack roles, and take-over of a
task that was not shared in Slack.

## Proof

`tests/contract/task-readers.test.ts`.
