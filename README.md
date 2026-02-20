# Slice Receipt Splitter

Slice is a receipt OCR and bill-splitting project with:

- A FastAPI backend for receipt parsing, lobby management, and claim tracking
- A Next.js frontend for scanning receipts, creating lobbies, and splitting costs

## Quick Start

Run backend and frontend in separate terminals.

### Backend

```powershell
cd backend
.\venv\Scripts\Activate.ps1
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

Backend docs: `http://127.0.0.1:8000/docs`

### Frontend

```powershell
cd frontend
npm run dev
```

Frontend: `http://localhost:3000`

## Environment Notes

Frontend API base is controlled by `frontend/.env.local`:

```env
NEXT_PUBLIC_API_BASE=http://127.0.0.1:8000
```

If using phone + hotspot/Wi-Fi, replace `127.0.0.1` with your current laptop IPv4 and restart frontend.

## Evaluation

Run evaluation from backend:

```powershell
cd backend
.\venv\Scripts\Activate.ps1
python evaluate_receipts.py
python evaluate_receipts.py --compare-hybrid
```

Reports are written to:

- `backend/test_receipts/reports/evaluation_report_paddle.json`
- `backend/test_receipts/reports/evaluation_report_hybrid.json`

Regression tests for hard total patterns:

```powershell
cd backend
.\venv\Scripts\Activate.ps1
python -m unittest tests.test_totals_regression
```

## Analysis

### 1. Problem Context

Receipt understanding for bill-splitting is hard because OCR text can be noisy, line items can be merged, and totals are expressed in many formats (`Bill Total`, `Net To Pay`, VAT/service lines, round-off). A correct split requires both item extraction and reliable total interpretation.

### 2. Approach

The pipeline is hybrid:

- **Primary extraction**: PaddleOCR + rule-based parsing for item rows (`name`, `quantity`, `unit_price`, `cost`)
- **Fallback path**: optional Gemini fallback when OCR quality is weak
- **Post-processing**:
  - non-item filtering
  - category enrichment
  - totals detection (`subtotal`, `grand_total`, `tax_total`, `service`, `round_off`)
  - subtotal/grand-total sanity checks

### 3. Evaluation Protocol

Evaluation uses labeled receipts in:

- `backend/test_receipts/images`
- `backend/test_receipts/labels`

Modes:

- Paddle-only
- Hybrid (Paddle + fallback)

### 4. Metrics

- Item Precision
- Item Recall
- Item F1
- Quantity Accuracy (matched items)
- Cost Accuracy (matched items)
- Receipt-level Total Match Rate

### 5. Key Findings

- Hybrid mode improves robustness when OCR confidence is low or parsed item count is small.
- Rule-based extraction performs well on clean printed receipts.
- Most financial errors come from total-line interpretation, not item-line OCR.

### 6. Failure Analysis

Observed failure patterns:

- subtotal interpreted as grand total when payable line is missed
- tax/service lines not carried into final total
- OCR token merge/split causing incorrect qty/unit/amount alignment

### 7. Fixes Implemented

Recent fixes in this codebase:

- Improved totals parser to detect:
  - `Bill Total` as subtotal
  - `Net To Pay` / `Amount Payable` as grand total
  - signed round-off (e.g., `R. Off: -0.42`)
- Added tax breakdown capture from VAT/GST/service lines.
- Persisted parsed `receipt_totals` at lobby creation and used them in summary calculations so `grand_total` includes extra charges beyond item subtotal.

### 8. Limitations and Next Steps

Current limitations:

- blurry/low-light images
- severe OCR line fragmentation
- uncommon layouts and mixed-language bills

Planned improvements:

- confidence-weighted total selection
- stronger table-structure recovery
- tax-line classifier
- larger edge-case labeled dataset

## Judge Summary (Short Version)

- **Problem**: OCR-based bill splitting fails when totals/taxes are parsed inconsistently.
- **Solution**: Hybrid OCR extraction + rule-based post-processing + totals sanity logic.
- **Validation**: Automated evaluation script reports item-level and total-level metrics for paddle-only vs hybrid.
- **Impact**: Improved financial correctness by preserving and applying detected receipt totals (including tax and round-off) in lobby summary.
