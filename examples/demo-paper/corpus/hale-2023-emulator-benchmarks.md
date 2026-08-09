---
note: >
  SYNTHETIC EXAMPLE. This is not a real paper. It exists so the demo pipeline
  runs anywhere without shipping binary PDFs. A real corpus is a directory of
  PDFs downloaded from the journal you intend to submit to.
---

# Benchmarking Learned Emulators for Atmospheric Radiative Transfer

Hale, M., Okonkwo, A., Reyes, D. (2023).
*Journal of Atmospheric Emulation* 11(2), 187–214. DOI 10.1234/jae.2023.187

## Abstract

We benchmark seven learned emulators for shortwave radiative transfer against a
line-by-line reference. We find that reported accuracy is not comparable across
papers because evaluation profiles differ, and we propose a fixed evaluation
suite. On our suite, the best emulator attains 0.38 K mean absolute error, while
the spread across published methods is 4.1 K.

## 1. Introduction

Learned emulators promise order-of-magnitude speedups over line-by-line codes.
Reported accuracies, however, span an order of magnitude, and the field lacks a
shared evaluation set. We argue this is the central obstacle to adoption.

## 2. Related Work

Prior benchmarks evaluate on author-selected profiles. We are aware of no study
that holds the evaluation set fixed across methods.

## 3. Evaluation Suite

We assemble 40,000 profiles stratified by season, latitude band, and cloud
fraction. Profiles are drawn from ERA5 and held fixed for all methods.

## 4. Results

Table 2 reports mean absolute error per method. Figure 3 shows error against
cloud fraction; every method degrades above 0.6 cloud fraction, and three
degrade sharply. We note that two published accuracies could not be reproduced
within a factor of two.

## 5. Discussion

The spread we observe is dominated by evaluation-set choice rather than by
architecture. This suggests the field has been optimising against different
targets while reporting a single number.

## 6. Limitations

Our suite excludes aerosol-loaded profiles, and we evaluate only shortwave.

## 7. Conclusion

We release the suite and recommend it as a common baseline.

## References

[1] Clough, S. et al. (2005). Atmospheric radiative transfer modeling.
[2] Hersbach, H. et al. (2020). The ERA5 global reanalysis.
