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

## The technician's view

On a ticket's page a **Procedures** panel shows each attached procedure with its steps. **Add procedure** (for the assigned engineer or provider, and dispatch) lists the published procedures for the machine's type. For each step the panel shows the safety callout, instruction, specification, parts, the measurement and limits expected, and the expected time. Once the job is accepted:

- **Record** opens the step: enter the measured value, add the photo if one is required, and add a note or a deviation. A value outside the limits is refused until a deviation note is written.
- **Skip** (only for steps that are not mandatory) asks why.
- **Undo** reopens a step and clears what was recorded.

Under each step the panel shows what was recorded: the value and whether it was in range, the photo, the note, the deviation, who did it, when, and how long it took. Customers and dispatchers who can see the ticket see the same record. The panel shows how many required steps are done.

## Not built yet

- A procedure editor. Procedures are written through the API (see `API.md`).
- The offline field app does not show procedures. The web workspace needs a connection to record a step.
- German texts and a help-page entry.
- Procedures per company, linking a procedure to the training it needs, and linking a step's parts to stock.
