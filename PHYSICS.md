# Physics / Engineering Model

This document describes exactly what the simulator computes, the
simplifications it makes, and what it deliberately does **not** model. It is
written so the tool can be trusted for what it is: an educational sandbox.

## 1. Analysis method

2D **linear static frame analysis** by the **direct stiffness method**.

- Each node has 3 degrees of freedom: `ux`, `uy`, `θ` (rotation).
- Beam and column members are standard **Euler-Bernoulli 2D frame elements**
  with the 6×6 local stiffness matrix:

  | term | value |
  |---|---|
  | axial | `EA/L` |
  | shear coupling | `12EI/L³` |
  | shear–moment coupling | `6EI/L²` |
  | rotational (near/far end) | `4EI/L`, `2EI/L` |

  The local matrix is transformed to global axes by the usual rotation
  matrix `T(cos, sin)` as `K_g = Tᵀ K_l T` and assembled into the global
  stiffness matrix.
- **Cables** are axial-only elements (`EA/L` along the member axis). They
  have no bending or transverse stiffness.
- `K·u = F` is solved with a hand-written **Gaussian elimination with
  partial pivoting** (no libraries). If a pivot below `1e-11 × max|K|` is
  encountered, the matrix is declared singular and the structure is
  reported as a **"mechanism / unstable structure"** — the solver never
  throws.

## 2. Supports

Supports are applied by **DOF elimination** (not penalty springs):
constrained DOFs are removed from the system before solving; reactions are
recovered afterwards as `R = K·u − F` at the constrained DOFs.

- **fixed**: `ux`, `uy`, `θ` constrained
- **pinned**: `ux`, `uy` constrained (rotation free)
- **roller**: `uy` constrained only (rolls along x)

A free DOF that ends up with a (near-)zero diagonal — for example the
rotation of a node connected only to cables — is auto-constrained (its
value is set to zero). This is necessary because cable elements contribute
no rotational stiffness; without it such a node would make `K` trivially
singular. It has no effect on member forces.

## 3. Materials and sections

| Material | E | Strength | Density |
|---|---|---|---|
| Steel | 200 GPa | 250 MPa (yield) | 7850 kg/m³ |
| Concrete | 30 GPa | 30 MPa (compressive) | 2400 kg/m³ |
| Wood | 11 GPa | 30 MPa (yield) | 550 kg/m³ |

Rectangular sections are used (`A = b·h`, `I = b·h³/12`, extreme fiber
`c = h/2`). Defaults (medium): beam 0.20×0.30 m, column 0.30×0.30 m; thin
and thick variants scale from there. Cables are round-area-only
(thin 0.001 m², medium 0.004 m², thick 0.01 m²).

## 4. Member failure check

For each beam/column member:

- **Combined stress** at both ends: `σ = |N|/A + |M|·c/I`, compared against
  the material strength. The same strength value is used in tension and
  compression (a simplification — real concrete is far weaker in tension).
- **Euler buckling** for members in compression: `Pcr = π²EI/(KL)²` with
  `K = 1` (pin-ended effective length — truss-like assumption, unconservative
  for cantilevered members, conservative for fully restrained ones).
- `stressRatio = max(σ/strength, |N|/Pcr)`.

For cables:

- Tension check `N/(A·strength)`.
- **Compression ⇒ slack**: a cable in compression is treated as failed
  (it carries nothing), removed from the model, and the structure is
  re-solved.

## 5. Loads

All loads are **lumped to nodes**. Distributed member loads are split half
to each end node. There are **no fixed-end moments** from distributed loads
(the consistent-load vector is not used). This is exact for nodal loads and
for nodal displacements in general, but slightly underestimates member end
moments compared with a consistent formulation.

- **Self-weight**: `ρ·A·L·g` per member, half to each end (`g = 9.81 m/s²`).
- **Point weights**: user-assigned mass on a node, `F = m·g` downward.
- **Wind**: dynamic pressure `q = ½·1.225·v²` (v in m/s; the UI enters km/h,
  so `100 km/h ≈ 472.6 Pa`). The horizontal force on a member is
  `q × (projected length normal to the wind = |Δy|) × (exposed width =
  section depth h)`, direction selectable. Horizontal members catch no wind
  in this model.
- **Rain**: members within 20° of horizontal collect extra gravity mass:
  `intensity × 1000 kg/m³ × section width b × 0.10 m` of water depth at
  100 % intensity (a film/ponding model).

## 6. Progressive collapse

After each solve, if any member has `stressRatio ≥ 1` (or a cable is slack):

1. Slack cables are removed first, then
2. the **single most overloaded** member is removed,
3. loads are re-assembled (failed members no longer contribute self-weight,
   wind, or rain) and the structure is re-solved,
4. up to 20 removals are recorded as an ordered **failure sequence**;
   the loop stops early if the structure becomes a mechanism.

## 7. Status thresholds

`maxRatio` is the worst demand/capacity ratio of the **intact** structure.

| Status | Condition |
|---|---|
| SAFE | `maxRatio < 0.5` |
| WARNING | `0.5 ≤ maxRatio < 0.85` |
| CRITICAL | `0.85 ≤ maxRatio < 1.0` |
| COLLAPSE | any member failure, slack cable, or mechanism |

The reported **minimum safety factor** is `1/maxRatio` of the intact
structure.

## 8. Deliberate modeling choices

- **Truck preset**: one of the four wheels is *pinned*, the other three are
  rollers. Four pure rollers would be a lateral rigid-body mechanism in 2D;
  the pinned wheel stands in for tire friction/braking.
- **Suspension bridge preset**: the left deck abutment is pinned (not a
  roller) because vertical hangers give the deck no lateral restraint —
  a real deck bearing does. The deck is also deliberately **not** connected
  to the tower columns: sharing that node makes the continuous deck hog
  over the tower and lifts the nearest hangers into compression, which a
  real deck/tower bearing detail avoids. Backstay cables anchor each tower
  top to the deck ends, as in a real bridge.
- **Cables in linear statics**: a chain of axial-only elements has no
  first-order transverse stiffness (that comes from geometric stiffness,
  which this solver does not include). Every cable node therefore needs a
  third, non-collinear attachment (e.g. a hanger), or the solver will —
  honestly — report a mechanism.

## 9. What is NOT modeled

- **Geometric nonlinearity / P-delta / second-order effects** — deformations
  do not feed back into equilibrium. Cable stayed systems in particular are
  stiffer in reality than this model shows (missing tension stiffening).
- **Dynamics** — no vibration, resonance, gusts, impact factors, or moving
  loads. Wind is a static pressure.
- **Material nonlinearity** — no cracking, plasticity, creep, or ductile
  redistribution. Members are elastic until they vanish.
- **Real failure modes** — no joint/connection failure, no fatigue, no
  local buckling of thin-walled sections, no foundation settlement.
- **3D behavior** — no lateral-torsional buckling, no out-of-plane loads.
- **Code compliance** — no load factors, resistance factors, or
  combinations from any building code. Demand/capacity ratios are raw.

**Do not use this tool to assess any real structure.**
