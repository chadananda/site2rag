# Pipeline Optimizer Report
Generated: 2026-05-07T00:08:28.772Z
Runtime: 373.9 minutes

## Test Corpus
- **english_text_good** (english, 1pp, baseline=83%): `journal_constantinople_1851-08-19_p2.pdf`
- **english_text_good** (english, 1pp, baseline=85%): `journal_constantinople_1851-10-29_p3.pdf`
- **english_scan_ok** (english, 7pp, baseline=95%): `masson_bahai_western_advance_scan.pdf`
- **english_scan_ok** (english, 8pp, baseline=97%): `lindfoot_notes_1933_convention.pdf`
- **french_scan** (french, 1pp, baseline=4%): `journal_constantinople_1851-10-14_p4.pdf`
- **french_scan** (french, 1pp, baseline=9%): `journal_constantinople_1851-08-29_p3.pdf`
- **arabic_scan** (arabic, 7pp, baseline=62%): `kharman_adab_honar_contents_17.pdf`
- **arabic_scan** (arabic, 5pp, baseline=89%): `kharman_adab_honar_contents_16.pdf`
- **persian_scan** (persian, 5pp, baseline=100%): `%d9%86%d9%88%da%af%d8%b1%d8%a7%db%8c%db%8c%20%d8%af%d8%b1%20%d9%86%d9%82%d8%a7%d8%b4%db%8c%20%d8%a7%db%8c%d8%b1%d8%a7%d9%86%20-%20%d8%b9%d8%a8%d8%af%d8%a7%d9%84%d8%ad%d9%85%db%8c%d8%af%20%d8%a7%d8%b4%d8%b1%d8%a7%d9%82(%d8%ae%d9%88%d8%b4%d9%87%20%d9%87%d8%a717).pdf`
- **persian_scan** (persian, 8pp, baseline=100%): `%d8%aa%d8%b1%da%a9%db%8c%d8%a8%20%d8%a7%d9%93%d8%ab%d8%a7%d8%b1%20%d9%87%d9%86%d8%b1%db%8c%20%d9%88%20%d8%aa%d9%86%d8%a7%d8%b3%d8%a8%20%d8%b7%d9%84%d8%a7%d9%8a%d9%94%db%8c%20-%20%d9%87%d9%88%d8%b4%d9%86%da%af%20%d8%b3%db%8c%d8%ad%d9%88%d9%86(%d8%ae%d9%88%d8%b4%d9%87%20%d9%87%d8%a717).pdf`

## Results by Category & Variant
| Category | Language | Variant | Avg Score | Avg Gain | Avg Cost |
|---|---|---|---|---|---|
| english_scan_ok | english | high_res | 48.5% | +1.0% | $0.4651 |
| english_scan_ok | english | high_res_contrast | 48.5% | +1.0% | $0.4657 |
| english_scan_ok | english | contrast_forced | 47.5% | -1.0% | $0.2267 |
| english_scan_ok | english | baseline | 0.0% | -96.0% | $0 |
| english_scan_ok | english | low_escalate | 0.0% | -96.0% | $0 |
| english_scan_ok | english | otsu_only | 0.0% | -96.0% | $0 |
| english_text_good | english | contrast_forced | 84.0% | +0.0% | $0.0012 |
| english_text_good | english | high_res_contrast | 84.0% | +0.0% | $0.0013 |
| english_text_good | english | otsu_only | 84.0% | +0.0% | $0.0011 |
| english_text_good | english | high_res | 42.5% | -41.5% | $0.0006 |
| english_text_good | english | low_escalate | 41.5% | -42.5% | $0.0006 |
| english_text_good | english | baseline | 27.7% | -56.0% | $0.0003 |

## Best Variant Per Category
- **english_scan_ok:english**: `high_res` → 48.5% (+1.0%)
- **english_text_good:english**: `contrast_forced` → 84.0% (+0.0%)

## Vision Analysis Insights
No insights generated yet.

## Recommended Pipeline Config by Document Type
```json
{
  "english_scan_ok:english": "high_res",
  "english_text_good:english": "contrast_forced"
}
```