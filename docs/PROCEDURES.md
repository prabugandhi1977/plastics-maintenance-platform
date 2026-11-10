# Work procedures

A procedure tells a technician exactly what to do on a work order, and records how it went. It is the step between the work order ("what work, on which machine, by when") and the closed ticket: the ticket closes with the measurements, photos and deviations in place of a bare timestamp.

## What a procedure holds

- A **code** (for example `IMM-TIEBAR`), a title, and the machine types it is for.
- Ordered **steps**. Each step has a title and optionally: an instruction, a **safety callout**, a specification (for example "M36 nuts, 1450 Nm"), the **parts** it uses, a **measurement** (name, unit, lower and upper limit), a required **photo**, whether it is **mandatory** (the default), and an expected time in minutes.
- A **version**. Only a draft can be edited. Publishing a draft makes it active and retires the previous active version of the same code. To change a published procedure, create a new version (post the same code again).

## On a work order

1. A procedure is attached to the ticket by the assigned engineer or provider (or dispatch), or automatically when the job is accepted, for procedures marked auto-attach for the machine's type. Its steps are copied, so later edits never change a finished record.
2. The technician records each step as done, skipped or reopened:
   - A measured step needs its value. A value outside the limits needs a **deviation note**; it is recorded as out of range.
   - A step that requires a photo needs a photo uploaded to this ticket (`POST /attachments`, kind `photo`).
   - A mandatory step cannot be skipped. A step that is not mandatory can be skipped with a reason.
3. The run is complete when no mandatory step is pending. Reopening a step reopens the run.
4. **A ticket cannot be completed while a mandatory step is pending.**

The ticket shows each run with who did each step, the values, the photos, the deviations, and the time each step took (counted from the previous step, or from attaching for the first).

## Analytics

`GET /procedures/by-code/:code/analytics` shows per step how often it was done, skipped, out of range or noted with a deviation, and its average time against the expected time. Steps with a high deviation or out-of-range rate, or that always run over the expected time, are where the procedure or the training needs attention. Step times are from the previous step, so a break between steps counts.

## Not built yet

- Screens: a procedure editor and the step-by-step view for technicians. Until then everything is through the API (see `API.md`).
- The field app (offline) does not show procedures yet. The step route accepts offline replay like the other field actions, but the app does not call it.
- Procedures are the same for every customer. Procedures per company, links from a procedure to the training it needs, and linking a step's parts to stock are not done.
