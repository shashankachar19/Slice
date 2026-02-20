# Labeling Guide

Use this format for every file in `backend/test_receipts/labels`.

## Item format
Each item in `items` must include:
- `name` (string, uppercase preferred)
- `quantity` (number)
- `cost` (number, line total)

Example item:
```json
{ "name": "VEG FRIED RICE", "quantity": 1, "cost": 180.00 }
```

## Fill order
1. Fill all `items`.
2. Fill `totals.grand_total` from receipt net/grand total.
3. Update checklist flags:
- `items_done`: true
- `grand_total_done`: true
- `double_checked`: true
4. Set `meta.status` to `done`.

## Notes
- Keep names as printed (minor OCR spelling differences are okay in labels only if bill is unclear).
- `cost` is the final line amount for that item, not unit price.
