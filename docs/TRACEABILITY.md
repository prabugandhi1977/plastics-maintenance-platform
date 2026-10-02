# Traceability: requirements and how they are met

The traceability suite covers the whole chain:

```
MATERIAL ─▶ PRODUCTION ─▶ QUALITY GATES ─▶ PACKING ─▶ DISPATCH ─▶ FIELD
lots, CoA     batch: machine,   first article,     box / part      delivery note,   complaints,
supplier,     mould, operator,  in-process,        serials (QR),   customer,        warranty claims,
FIFO          settings, live    final QC,          pallets         channel          field failures
              readings, SPC     packaging
```

One search (any label, batch, lot, delivery note or return reference) shows the whole chain backward and forward. It is built after the practice of leading MES traceability products: Siemens Opcenter, Rockwell Plex, Critical Manufacturing, iTAC and Tulip. That means genealogy as the backbone, process windows with SPC, quality gates that block release, scan-verified dispatch, and closed-loop field returns.

Status: **Built** means built and tested in this repository. **Partial** means part of it is built and the rest is described. **Next** means not built yet. **Site** means it needs your systems or decisions.

## Forward traceability (recalls and warranty)

| Requirement | How it is met | Status |
| --- | --- | --- |
| Serial number tracking to customer delivery | Box labels and part serials with QR codes. Pallets group boxes. Each label is scanned onto a delivery note, and *Trace search* shows label → shipment → customer | Built |
| Distribution channel visibility | Every shipment has a customer and a channel (OEM, Tier-1, distributor, aftermarket, internal) and a destination. Recall scope and authentication show them | Built |
| Field performance correlation | Field returns are linked to their batch. Returns per 1,000 shipped are ranked by material lot, supplier, machine, mould, operator, product and process setting, with "× average" | Built |
| Warranty claim authentication | Each claim is checked against the label: printed by us, from a released batch, shipped, to this customer, within the product's warranty, not claimed before. Result: genuine, suspicious or not found (counterfeit or typing error) | Built |
| Targeted recalls | *Recall scope* of a lot or batch lists the affected batches, labels still in stock, and quantities at each customer and on each delivery note, compared with recalling all production of the product. *Quarantine lot* holds exactly those batches | Built |

## Backward traceability (root cause and supplier quality)

| Requirement | How it is met | Status |
| --- | --- | --- |
| Raw material lot genealogy | Lots (supplier, certificate/CoA, quantity) → batches. Forward ("where used") and backward ("what went in") | Built |
| FIFO validation with mismatch alerts | A batch that skips an older lot of the same material with stock left is refused, unless a reason is given. The override is stored with the batch and shown in the chain. Dispatch warns when older finished stock of the same part is still in the warehouse | Built |
| Component supplier tracking | Supplier scorecard: lots, kg, quarantines, batches held, deviations and field returns caused by their material, score and rating A/B/C | Built |
| Process parameter recording | Start settings are mandatory per machine type. Live readings per setting are stored with the batch | Built |
| Operator and machine identification | Machine, mould, operator name and the **signed-in user** who started the batch, signed the gates and released it | Built |
| Operator authentication by biometrics or face recognition | Not used. People sign in to the platform, and badge/RFID login can be added at the station. Face recognition is deliberately left out for privacy reasons, as in Vision AI | Next (badge login) |

## Real-time process traceability (proactive quality)

| Requirement | How it is met | Status |
| --- | --- | --- |
| Live process parameter monitoring | Machine readings arrive through the machine-data intake (`process` events, e.g. from an OPC UA / Euromap 77 gateway) or by hand. Control charts show the readings with UCL/LCL and the window | Built (platform); the machine gateway at site |
| Instant deviation alerts | A reading outside the product's validated window opens a deviation and an alert (critical when the product holds on deviation). The deviation closes when readings return, and a manager accepts or rejects it with evidence | Built |
| Quality gate enforcement | Gates (first article, in-process, final QC, packaging) with digital check sheets: OK/Not OK items and measured values with limits. A batch is released only when every gate passed, every deviation is decided (none rejected) and no lot is quarantined. Dispatch re-checks this when each label is scanned and again at shipping | Built |
| Digital check sheets and SPC | Check sheets per product and gate, signed by the user. Cp and Cpk per setting, with a capability rating (≥ 1.33 / ≥ 1.67) | Built |
| Digital work-instruction compliance | Gates and check sheets give compliance per step, and *compliance readiness* shows what keeps batches from a complete record. Step-by-step instructions with pictures at the station are not built | Partial |

## Integration and data capture

| Requirement | How it is met | Status |
| --- | --- | --- |
| QR/barcode batch and serial tracking | Labels are generated and printed (A4 sheet, QR + part number, quantity, batch, serial, customer). Scanning works with a handheld scanner (keyboard wedge), the phone camera, or typing | Built |
| PLC and machine data | The machine-data intake takes state, counts, condition, energy, vision results and process settings | Built |
| ERP (SAP, Odoo) | The REST API carries lots, batches, shipments and returns. An ERP connector (goods receipt → lots, production orders → batches, deliveries → shipments) is built per customer | Site |
| OCR of codes and labels | Not built. It fits the Vision AI edge node as an OCR module (reading DMC/lot codes and printed labels) | Next |
| Centralised dashboards, alerts and reports | Traceability figures, deviation and gate alerts in the platform's alert centre, printable delivery notes and labels, audit trail of every decision | Built |

## Measuring the results

The results promised for traceability programmes are measured on these pages, not assumed:

| Promise | Measured as |
| --- | --- |
| Faster issue resolution and root-cause analysis | *Trace search* answers in milliseconds (`traceMs`), and *Field correlation* ranks candidate causes |
| Smaller recall scope through precise lot tracking | *Recall scope*: affected quantity versus all production of the product (headline: *recall scope narrowed*) |
| First-time quality from real-time process validation | *First-time quality*: batches whose gates all passed first time with no deviation or hold |
| Audit readiness (IATF 16949, ISO 9001, FDA 21 CFR 820) | *Compliance readiness*: batches with lots, settings, operator, all gates and decided deviations, plus the list of what is missing |
| Less scrap, rework and warranty cost | Field ppm, suspicious claims refused, and batches held before shipping |

## Open for the next round

1. **ERP:** which system (SAP S/4HANA, Odoo, other), and which documents (goods receipt, production order, delivery) should create lots, batches and shipments?
2. **Labels:** the customer's label standard (VDA 4902 / GTL, Odette, AIAG B-10), printers (Zebra ZPL?), and whether parts get a DMC.
3. **Machine gateway:** OPC UA (Euromap 77) on the moulding machines, or the PLC tags to read for the process settings.
4. **Operator login at the station:** badge (RFID) or PIN.
