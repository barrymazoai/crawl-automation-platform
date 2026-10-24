# Dherbs agent-route corpus validation — 2026-10-24

Read from the 20 retained page HTML files in `tools/diag-corpus/round9/dherbs/pages`. Classification uses the shared `pageBreadcrumbs` and exact category matching. A `not-supplement` row follows the existing conditional rule: it finishes as not-supplement when Label would otherwise return Review. Image candidates come from the retained `projection.json` files; the after URL is the page-declared Product image selected by the explicit size-token rule. This is a local replay, not a new Mini capture.

| Page | Breadcrumb | Outcome |
| --- | --- | --- |
| alkaline-formula-p-596.html | Home › (All) Herbal Supplements › Alkaline Formula | supplement |
| antiaging-formula-p-638.html | Home › (All) Herbal Supplements › Anti-Aging Formula | supplement |
| antiv-formula-p-6.html | Home › (All) Herbal Supplements › Anti-V Formula | supplement |
| black-seed-rooibos-tea-p-248.html | Home › Teas › Black Seed & Rooibos Tea | supplement |
| cellulite-oil-4-oz-p-371.html | Home › Hygiene And Beauty › Cellulite Oil (4 oz) | not-supplement |
| detox-formula-p-646.html | Home › (All) Herbal Supplements › Detox Formula | supplement |
| female-breast-formula-p-30.html | Home › (All) Herbal Supplements › Female Breast Formula | supplement |
| female-health-tea-p-242.html | Home › Teas › Female Health Tea | supplement |
| full-body-cleanse-companion-ebook-p-227.html | Home › Ebooks › Full Body Cleanse Companion (eBook) | not-supplement |
| garcinia-cambogia-p-254.html | Home › Vitamins and Minerals › Garcinia Cambogia | supplement |
| gift-certificate-50-p-602.html | Home › Gift Certificates › Gift Certificate $50 | not-supplement |
| joint-aid-tea-p-280.html | Home › Teas › Joint Aid Tea | supplement |
| male-hormonal-formula-p-46.html | Home › (All) Herbal Supplements › Male Hormonal Formula | supplement |
| nervecalming-tea-p-237.html | Home › Teas › Nerve-Calming Tea | supplement |
| nerves-cleanse-regimen-p-486.html | Home › Cleanses and Regimens › Nerves Cleanse & Regimen | bundle |
| passion-inhaler-p-124.html | Home › Aromatherapy Inhalers › Passion Inhaler | not-supplement |
| sea-moss-combo-p-835.html | Home › (All) Herbal Supplements › Sea Moss Combo | supplement |
| soothing-tea-p-449.html | Home › Teas › Soothing Tea | supplement |
| the-i-can-home-challenge-p-736.html | Home › Dherbs 180 Challenge › The I Can Home Challenge | bundle |
| weight-release-inhaler-p-268.html | Home › Aromatherapy Inhalers › Weight Release Inhaler | not-supplement |

Counts: 13 supplement, 5 not-supplement, 2 bundle.

## Product image candidates

Every row shows the original retained candidate URL followed by the URL declared in the same page’s Product structured data. Candidate order is unchanged.

### alkaline-formula-p-596.html

| Before | After |
| --- | --- |
| https://d3ixge6icd4njv.cloudfront.net/store/images/resized_600_600_dh_alkaline_formula.jpg | https://d3ixge6icd4njv.cloudfront.net/store/images/resized_1080_1080_dh_alkaline_formula.jpg |
| https://d3ixge6icd4njv.cloudfront.net/store/images/resized_600_600_alkaline-supplement-for-ph-balance-3.jpg | https://d3ixge6icd4njv.cloudfront.net/store/images/resized_1000_1000_alkaline-supplement-for-ph-balance-3.jpg |
| https://d3ixge6icd4njv.cloudfront.net/store/images/resized_600_600_alkaline-supplement-for-ph-balance-4.jpg | https://d3ixge6icd4njv.cloudfront.net/store/images/resized_1000_1000_alkaline-supplement-for-ph-balance-4.jpg |
| https://d3ixge6icd4njv.cloudfront.net/store/images/resized_600_600_alkaline-supplement-for-ph-balance-2.jpg | https://d3ixge6icd4njv.cloudfront.net/store/images/resized_1000_1000_alkaline-supplement-for-ph-balance-2.jpg |
| https://d3ixge6icd4njv.cloudfront.net/store/images/resized_600_600_alkaline-supplement-for-ph-balance-1.jpg | https://d3ixge6icd4njv.cloudfront.net/store/images/resized_1000_1000_alkaline-supplement-for-ph-balance-1.jpg |
| https://d3ixge6icd4njv.cloudfront.net/store/images/resized_600_600_herbal-alkaline-supplement-4.jpg | https://d3ixge6icd4njv.cloudfront.net/store/images/resized_1000_1000_herbal-alkaline-supplement-4.jpg |

### joint-aid-tea-p-280.html

| Before | After |
| --- | --- |
| https://d3ixge6icd4njv.cloudfront.net/store/images/resized_600_600_dh_joint_aid_tea.jpg | https://d3ixge6icd4njv.cloudfront.net/store/images/resized_1500_1500_dh_joint_aid_tea.jpg |
| https://d3ixge6icd4njv.cloudfront.net/store/images/resized_600_600_herbal-joint-health-tea-1getg.jpg | https://d3ixge6icd4njv.cloudfront.net/store/images/resized_1000_1000_herbal-joint-health-tea-1getg.jpg |
| https://d3ixge6icd4njv.cloudfront.net/store/images/resized_600_600_herbal-joint-health-tea-1asgar.jpg | https://d3ixge6icd4njv.cloudfront.net/store/images/resized_1000_1000_herbal-joint-health-tea-1asgar.jpg |
| https://d3ixge6icd4njv.cloudfront.net/store/images/resized_600_600_herbal-joint-health-tea-1sdfg5.jpg | https://d3ixge6icd4njv.cloudfront.net/store/images/resized_1000_1000_herbal-joint-health-tea-1sdfg5.jpg |
| https://d3ixge6icd4njv.cloudfront.net/store/images/resized_600_600_herbal-joint-health-tea-1awfgfsdg.jpg | https://d3ixge6icd4njv.cloudfront.net/store/images/resized_1000_1000_herbal-joint-health-tea-1awfgfsdg.jpg |
| https://d3ixge6icd4njv.cloudfront.net/store/images/resized_600_600_herbal-joint-health-tea-1fgs.jpg | https://d3ixge6icd4njv.cloudfront.net/store/images/resized_1000_1000_herbal-joint-health-tea-1fgs.jpg |
| https://d3ixge6icd4njv.cloudfront.net/store/images/resized_600_600_herbal-joint-health-tea-1gsst.jpg | https://d3ixge6icd4njv.cloudfront.net/store/images/resized_1000_1000_herbal-joint-health-tea-1gsst.jpg |
| https://d3ixge6icd4njv.cloudfront.net/store/images/resized_600_600_Joint-Aid-Tea-6.jpg | https://d3ixge6icd4njv.cloudfront.net/store/images/resized_1000_1000_Joint-Aid-Tea-6.jpg |
| https://d3ixge6icd4njv.cloudfront.net/store/images/resized_600_600_Joint-Aid-Tea-5.jpg | https://d3ixge6icd4njv.cloudfront.net/store/images/resized_1000_1000_Joint-Aid-Tea-5.jpg |
| https://d3ixge6icd4njv.cloudfront.net/store/images/resized_600_600_Joint-Aid-Tea-4.jpg | https://d3ixge6icd4njv.cloudfront.net/store/images/resized_1000_1000_Joint-Aid-Tea-4.jpg |
| https://d3ixge6icd4njv.cloudfront.net/store/images/resized_600_600_Joint-Aid-Tea-2.jpg | https://d3ixge6icd4njv.cloudfront.net/store/images/resized_1000_1000_Joint-Aid-Tea-2.jpg |
| https://d3ixge6icd4njv.cloudfront.net/store/images/resized_600_600_Joint-Aid-Tea-1.jpg | https://d3ixge6icd4njv.cloudfront.net/store/images/resized_1000_1000_Joint-Aid-Tea-1.jpg |
| https://d3ixge6icd4njv.cloudfront.net/store/images/resized_600_600_Joint-Aid-Tea-3.jpg | https://d3ixge6icd4njv.cloudfront.net/store/images/resized_1000_1000_Joint-Aid-Tea-3.jpg |

### soothing-tea-p-449.html

| Before | After |
| --- | --- |
| https://d3ixge6icd4njv.cloudfront.net/store/images/resized_600_600_dh_soothing_tea.jpg | https://d3ixge6icd4njv.cloudfront.net/store/images/resized_1500_1500_dh_soothing_tea.jpg |
| https://d3ixge6icd4njv.cloudfront.net/store/images/resized_600_600_stomach-soothe-tea-1sdgdf.jpg | https://d3ixge6icd4njv.cloudfront.net/store/images/resized_1000_1000_stomach-soothe-tea-1sdgdf.jpg |
| https://d3ixge6icd4njv.cloudfront.net/store/images/resized_600_600_stomach-soothe-tea-1dfs.jpg | https://d3ixge6icd4njv.cloudfront.net/store/images/resized_1000_1000_stomach-soothe-tea-1dfs.jpg |
| https://d3ixge6icd4njv.cloudfront.net/store/images/resized_600_600_Soothing-Tea-4.jpg | https://d3ixge6icd4njv.cloudfront.net/store/images/resized_1000_1000_Soothing-Tea-4.jpg |
| https://d3ixge6icd4njv.cloudfront.net/store/images/resized_600_600_stomach-soothe-tea-1zfg.jpg | https://d3ixge6icd4njv.cloudfront.net/store/images/resized_1000_1000_stomach-soothe-tea-1zfg.jpg |
| https://d3ixge6icd4njv.cloudfront.net/store/images/resized_600_600_Soothing-Tea-3.jpg | https://d3ixge6icd4njv.cloudfront.net/store/images/resized_1000_1000_Soothing-Tea-3.jpg |
| https://d3ixge6icd4njv.cloudfront.net/store/images/resized_600_600_stomach-soothe-tea-1sdg.jpg | https://d3ixge6icd4njv.cloudfront.net/store/images/resized_1000_1000_stomach-soothe-tea-1sdg.jpg |
| https://d3ixge6icd4njv.cloudfront.net/store/images/resized_600_600_stomach-soothe-tea-1sgsad.jpg | https://d3ixge6icd4njv.cloudfront.net/store/images/resized_1000_1000_stomach-soothe-tea-1sgsad.jpg |
| https://d3ixge6icd4njv.cloudfront.net/store/images/resized_600_600_Soothing-Tea-2.jpg | https://d3ixge6icd4njv.cloudfront.net/store/images/resized_1000_1000_Soothing-Tea-2.jpg |
| https://d3ixge6icd4njv.cloudfront.net/store/images/resized_600_600_Soothing-Tea-5.jpg | https://d3ixge6icd4njv.cloudfront.net/store/images/resized_1000_1000_Soothing-Tea-5.jpg |
