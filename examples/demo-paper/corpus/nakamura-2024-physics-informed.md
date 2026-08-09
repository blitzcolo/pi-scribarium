---
note: >
  SYNTHETIC EXAMPLE. This is not a real paper. It exists so the demo pipeline
  runs anywhere without shipping binary PDFs. A real corpus is a directory of
  PDFs downloaded from the journal you intend to submit to.
---

# Physics-Informed Losses Improve Out-of-Distribution Emulator Accuracy

Nakamura, S., Ferreira, L. (2024).
*Journal of Atmospheric Emulation* 12(1), 33–58. DOI 10.1234/jae.2024.033

## Abstract

We show that adding a monotonicity constraint on optical depth to the training
loss improves out-of-distribution accuracy by 31% relative to an unconstrained
baseline, at no inference cost. The gain concentrates in profiles unlike the
training distribution, which is precisely where emulators have been weakest.

## 1. Introduction

Emulators interpolate well and extrapolate badly. We ask whether encoding a
known physical constraint recovers some of the lost accuracy.

## 2. Method

We train a 6-layer residual network on 1.2 million ERA5 profiles. The loss adds
a penalty term for any predicted optical-depth profile that is not monotonically
non-decreasing with path length. We hold architecture and data fixed across
conditions so the loss term is the only variable.

## 3. Results

Table 1 reports in-distribution and out-of-distribution error. In distribution,
the constrained and unconstrained models are indistinguishable (0.40 K vs
0.41 K). Out of distribution, the constrained model attains 0.71 K against
1.03 K. Figure 2 shows the gap widening with distance from the training
manifold.

## 4. Discussion

The constraint costs nothing at inference and is trivially implemented. We
suspect similar gains are available from other conservation properties.

## 5. Limitations

We evaluate a single architecture, and our out-of-distribution set is
constructed rather than observed. We did not test cloudy scenes.

## 6. Conclusion

Physical constraints are cheap regularisers for atmospheric emulators.

## References

[1] Hale, M. et al. (2023). Benchmarking learned emulators.
[2] Hersbach, H. et al. (2020). The ERA5 global reanalysis.
