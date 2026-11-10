# IMM simulator

Injection moulding machine (IMM) simulator: a 3D Autodesk Fusion script and a standalone browser page.

| Path | What it is |
|---|---|
| `IMM_Simulator/` | Fusion script (`.py` + `.manifest`, same name as the folder). Builds a toggle-clamp machine, animates the cycle, estimates cycle time, SEC (kWh/kg) for conventional / servo-hydraulic / all-electric drives, defect risks and maintenance alerts, and logs runs to `Documents\IMM_Simulator\IMM_runs.csv`. |
| `imm_cycle_simulator.html` | Single-file page (open in a browser) with an animated 2D machine view, results, defect checks, cycle breakdown and scenario comparison. Fonts load from Google Fonts. |
| `tests/mock_run.py` | Runs the Fusion script against a mocked `adsk` API to catch Python/logic errors. Does not prove the real Fusion API calls work. |

## Use in Fusion
In Fusion press Shift+S, click **+** next to My Scripts, choose **Script or add-in from device** and pick the `IMM_Simulator` folder. Or create a script named `IMM_Simulator` and paste in `IMM_Simulator.py`.

## Test
```bash
python simulators/imm/tests/mock_run.py
```

## Caveats
Material constants, drive efficiencies and catalogue presets are generic rules of thumb. Replace them with plant data and metered SEC (EUROMAP 60.1 style, machine only) before relying on the numbers.
