# Training and competencies

MouldCare does not run courses. A learning management system (LMS) owns the courses, and MouldCare keeps the result that matters for maintenance work: who has completed which training, until when, and what that means when a ticket is assigned.

## The rules

- A **requirement** (competency) has a code, a name, the machine types it applies to, an optional validity in months, and an enforcement of **flag** or **block**. The code is what the LMS sends as the course code.
- A completion counts until its expiry: the LMS's own `expiresAt` if it sends one, otherwise the completion date plus the requirement's validity. No validity and no `expiresAt` means it never expires. A newer completion replaces an older one.
- When a ticket is assigned to an **in-house engineer**, the requirements for the machine's type are checked:
  - **Missing or expired, enforcement block:** the engineer is not eligible, and the reason is shown (for example "Hydraulic safety expired on 2026-03-01"). The server refuses the assignment.
  - **Missing or expired, enforcement flag:** the engineer can be assigned, with a warning.
  - **Expiring within 30 days:** a warning, whatever the enforcement.
  - Warnings are shown to the dispatcher, written into the ticket's history and the audit log, and returned by the assign call.
- Service providers are assigned as a whole and are not checked yet. Their engineers' completions are recorded and visible to the provider administrator.

## Connect an LMS

Any LMS that can call a web address when a learner completes a course will do, directly, through its automation features, or through a tool such as Zapier or Make. The call is:

```
POST https://<your service>/api/integrations/lms/completions
X-Integration-Key: <MOULDCARE_INTEGRATION_KEY>
{"completions":[{"email":"alex@example.com","courseCode":"HYD-SAFE","completedAt":"2026-11-10T09:30:00Z","passed":true,"externalId":"lms-attempt-81234"}]}
```

- `email` matches an active engineer or provider engineer in MouldCare. Create the people in both places with the same email.
- `courseCode` must exist as a requirement. Create it first (`POST /competencies`).
- The answer lists one outcome per entry, so one bad row never holds back the others. Sending a completion again is harmless.
- The integration key is the server-wide one, the same as for machine data. Keep it secret and send the call from the LMS's server side only.

## Screens

**Administration → Training & competencies** (platform administrators, dispatchers, service provider staff and engineers):

- **Standing:** who holds each training, as valid, expiring (within 30 days), expired or missing, with a filter by machine type. Dispatchers see every technician, a provider administrator sees their own engineers, and an engineer or provider engineer sees themselves.
- **Requirements:** the list of requirements, how to connect the learning system, and (for the platform administrator and dispatchers) **Add requirement**, **Edit** and **Record completion**.
- **Assigning a ticket:** the assign dialog lists a training warning for any engineer who can still be assigned, and lists the training that makes an engineer ineligible under "Not eligible". The warning is also written to the ticket's history.

## Not built yet

- Alerts before a certificate expires.
- Checking providers by their engineers' training.
- Courses linked from a ticket or checklist.
