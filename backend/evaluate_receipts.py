import json
import re
import argparse
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np

import main


@dataclass
class MatchResult:
    gt_idx: int
    pred_idx: int
    score: float


def normalize_name(name: str) -> str:
    text = name.upper()
    text = re.sub(r"[^A-Z0-9 ]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def safe_float(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def name_similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, normalize_name(a), normalize_name(b)).ratio()


def item_match_score(gt: Dict, pred: Dict) -> float:
    name_score = name_similarity(gt["name"], pred["name"])
    gt_cost = safe_float(gt.get("cost"), 0.0)
    pr_cost = safe_float(pred.get("cost"), 0.0)
    if gt_cost <= 0 and pr_cost <= 0:
        cost_score = 1.0
    else:
        cost_diff = abs(gt_cost - pr_cost)
        cost_score = max(0.0, 1.0 - (cost_diff / max(1.0, gt_cost)))
    gt_qty = safe_float(gt.get("quantity", 1), 1.0)
    pr_qty = safe_float(pred.get("quantity", 1), 1.0)
    qty_diff = abs(gt_qty - pr_qty)
    qty_score = 1.0 if qty_diff < 0.001 else max(0.0, 1.0 - (qty_diff / max(1.0, gt_qty)))
    return 0.65 * name_score + 0.25 * cost_score + 0.10 * qty_score


def greedy_match(gt_items: List[Dict], pred_items: List[Dict], min_score: float = 0.62) -> List[MatchResult]:
    candidates: List[MatchResult] = []
    for gi, gt in enumerate(gt_items):
        for pi, pred in enumerate(pred_items):
            score = item_match_score(gt, pred)
            if score >= min_score:
                candidates.append(MatchResult(gi, pi, score))
    candidates.sort(key=lambda x: x.score, reverse=True)

    used_gt = set()
    used_pred = set()
    matches: List[MatchResult] = []
    for cand in candidates:
        if cand.gt_idx in used_gt or cand.pred_idx in used_pred:
            continue
        used_gt.add(cand.gt_idx)
        used_pred.add(cand.pred_idx)
        matches.append(cand)
    return matches


def load_json(path: Path) -> Dict:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def evaluate_one(image_path: Path, label_path: Path, use_hybrid: bool = False) -> Dict:
    label = load_json(label_path)
    gt_items = label.get("items", [])
    gt_subtotal = safe_float(label.get("totals", {}).get("subtotal"), 0.0)
    gt_grand_total = safe_float(label.get("totals", {}).get("grand_total"), 0.0)
    gt_total = gt_subtotal if gt_subtotal > 0 else gt_grand_total

    image = cv2.imdecode(np.fromfile(str(image_path), dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        return {"error": "Invalid image"}

    image_data = np.fromfile(str(image_path), dtype=np.uint8).tobytes()
    pred_items, needs_review, _ = main.run_paddle_pipeline(image)
    source = "paddle"
    quality_score = main.compute_quality_score(pred_items, needs_review)
    if use_hybrid and main.GEMINI_API_KEY:
        weak = len(pred_items) < 2 or quality_score < 0.52 or len(needs_review) > max(3, len(pred_items))
        if weak:
            gemini = main.call_gemini_fallback(image_data)
            if gemini and gemini.get("items"):
                g_items = gemini["items"]
                g_review = gemini.get("needs_review", [])
                g_score = main.compute_quality_score(g_items, g_review)
                if g_score >= quality_score:
                    pred_items = g_items
                    source = "gemini_fallback"

    matches = greedy_match(gt_items, pred_items)
    tp = len(matches)
    fp = max(0, len(pred_items) - tp)
    fn = max(0, len(gt_items) - tp)

    matched_gt = {m.gt_idx for m in matches}
    matched_pred = {m.pred_idx for m in matches}

    qty_correct = 0
    cost_correct = 0
    matched_pairs = []
    for m in matches:
        gt = gt_items[m.gt_idx]
        pred = pred_items[m.pred_idx]
        qty_equal = False
        cost_equal = False
        gt_qty = safe_float(gt.get("quantity", 1), 1.0)
        pr_qty = safe_float(pred.get("quantity", 1), 1.0)
        if abs(gt_qty - pr_qty) < 0.001:
            qty_correct += 1
            qty_equal = True

        gt_cost = safe_float(gt.get("cost", 0), 0.0)
        pr_cost = safe_float(pred.get("cost", 0), 0.0)
        if abs(gt_cost - pr_cost) <= max(0.05, 0.01 * max(1.0, gt_cost)):
            cost_correct += 1
            cost_equal = True

        matched_pairs.append(
            {
                "gt_item": gt,
                "pred_item": pred,
                "score": round(m.score, 4),
                "name_similarity": round(name_similarity(gt["name"], pred["name"]), 4),
                "qty_equal": qty_equal,
                "cost_equal": cost_equal,
            }
        )

    unmatched_gt = [gt_items[i] for i in range(len(gt_items)) if i not in matched_gt]
    unmatched_pred = [pred_items[i] for i in range(len(pred_items)) if i not in matched_pred]

    pred_total = round(sum(safe_float(i.get("cost"), 0.0) for i in pred_items), 2)
    total_match = gt_total > 0 and abs(pred_total - gt_total) <= max(1.0, 0.01 * gt_total)

    return {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "matched": len(matches),
        "qty_correct": qty_correct,
        "cost_correct": cost_correct,
        "pred_total": pred_total,
        "gt_total": gt_total,
        "gt_total_basis": "subtotal" if gt_subtotal > 0 else "grand_total",
        "total_match": total_match,
        "pred_count": len(pred_items),
        "gt_count": len(gt_items),
        "matched_pairs": matched_pairs,
        "unmatched_gt": unmatched_gt,
        "unmatched_pred": unmatched_pred,
        "source": source,       
    }


def pct(n: float, d: float) -> float:
    if d <= 0:
        return 0.0
    return (100.0 * n) / d


def run_eval(use_hybrid: bool = False) -> Dict[str, Any]:
    root = Path(__file__).resolve().parent
    image_dir = root / "test_receipts" / "images"
    label_dir = root / "test_receipts" / "labels"

    image_paths = sorted([p for p in image_dir.glob("r*.*") if p.suffix.lower() in {".jpg", ".jpeg", ".png"}])
    if not image_paths:
        print("No images found.")
        return

    totals = {
        "tp": 0,
        "fp": 0,
        "fn": 0,
        "matched": 0,
        "qty_correct": 0,
        "cost_correct": 0,
        "total_match_receipts": 0,
        "receipt_count": 0,
        "skipped": 0,
    }
    hard_cases: List[Tuple[str, str]] = []
    per_receipt: List[Dict] = []

    for img in image_paths:
        label_path = label_dir / f"{img.stem}.json"
        if not label_path.exists():
            totals["skipped"] += 1
            hard_cases.append((img.name, "missing label"))
            continue

        metrics = evaluate_one(img, label_path, use_hybrid=use_hybrid)
        if "error" in metrics:
            totals["skipped"] += 1
            hard_cases.append((img.name, metrics["error"]))
            continue

        totals["receipt_count"] += 1
        totals["tp"] += metrics["tp"]
        totals["fp"] += metrics["fp"]
        totals["fn"] += metrics["fn"]
        totals["matched"] += metrics["matched"]
        totals["qty_correct"] += metrics["qty_correct"]
        totals["cost_correct"] += metrics["cost_correct"]
        totals["total_match_receipts"] += 1 if metrics["total_match"] else 0

        per_receipt.append(
            {
                "image": img.name,
                "label": label_path.name,
                "metrics": {
                    "tp": metrics["tp"],
                    "fp": metrics["fp"],
                    "fn": metrics["fn"],
                    "pred_count": metrics["pred_count"],
                    "gt_count": metrics["gt_count"],
                    "pred_total": metrics["pred_total"],
                    "gt_total": metrics["gt_total"],
                    "gt_total_basis": metrics["gt_total_basis"],
                    "total_match": metrics["total_match"],
                },
                "unmatched_gt": metrics["unmatched_gt"],
                "unmatched_pred": metrics["unmatched_pred"],
                "matched_pairs": metrics["matched_pairs"],
            }
        )

        if metrics["fn"] > 0 or metrics["fp"] > 0 or not metrics["total_match"]:
            reason = f"fn={metrics['fn']}, fp={metrics['fp']}, total_match={metrics['total_match']}"
            hard_cases.append((img.name, reason))

    precision = pct(totals["tp"], totals["tp"] + totals["fp"])
    recall = pct(totals["tp"], totals["tp"] + totals["fn"])
    f1 = 0.0
    if precision + recall > 0:
        f1 = 2 * precision * recall / (precision + recall)
    qty_acc = pct(totals["qty_correct"], totals["matched"])
    cost_acc = pct(totals["cost_correct"], totals["matched"])
    total_match_rate = pct(totals["total_match_receipts"], totals["receipt_count"])

    mode_label = "Hybrid" if use_hybrid else "Paddle-only"
    print(f"=== Receipt Evaluation ({mode_label}) ===")
    print(f"Receipts evaluated: {totals['receipt_count']}")
    print(f"Receipts skipped:   {totals['skipped']}")
    print("---")
    print(f"Item Precision:     {precision:.2f}%")
    print(f"Item Recall:        {recall:.2f}%")
    print(f"Item F1:            {f1:.2f}%")
    print(f"Quantity Accuracy:  {qty_acc:.2f}% (matched items)")
    print(f"Cost Accuracy:      {cost_acc:.2f}% (matched items)")
    print(f"Total Match Rate:   {total_match_rate:.2f}% (receipt-level)")
    print("---")
    print(f"TP={totals['tp']} FP={totals['fp']} FN={totals['fn']}")

    if hard_cases:
        print("\nReceipts needing attention:")
        for name, reason in hard_cases[:20]:
            print(f"- {name}: {reason}")

    report_dir = root / "test_receipts" / "reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    summary = {
        "mode": mode_label,
        "receipts_evaluated": totals["receipt_count"],
        "receipts_skipped": totals["skipped"],
        "item_precision_pct": round(precision, 2),
        "item_recall_pct": round(recall, 2),
        "item_f1_pct": round(f1, 2),
        "quantity_accuracy_pct": round(qty_acc, 2),
        "cost_accuracy_pct": round(cost_acc, 2),
        "total_match_rate_pct": round(total_match_rate, 2),
        "tp": totals["tp"],
        "fp": totals["fp"],
        "fn": totals["fn"],
    }
    report = {"summary": summary, "hard_cases": hard_cases, "per_receipt": per_receipt}
    report_file = "evaluation_report_hybrid.json" if use_hybrid else "evaluation_report_paddle.json"
    report_path = report_dir / report_file
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\nDetailed report written to: {report_path}")
    return summary


def main_eval() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--compare-hybrid", action="store_true", help="Run paddle-only and hybrid back-to-back")
    args = parser.parse_args()

    paddle_summary = run_eval(use_hybrid=False)
    if args.compare_hybrid:
        print("\n")
        if not main.GEMINI_API_KEY:
            print("GEMINI_API_KEY not set; hybrid mode will effectively match paddle-only.")
        hybrid_summary = run_eval(use_hybrid=True)
        print("\n=== Comparison ===")
        print(
            f"Precision: {paddle_summary['item_precision_pct']}% -> {hybrid_summary['item_precision_pct']}% | "
            f"Recall: {paddle_summary['item_recall_pct']}% -> {hybrid_summary['item_recall_pct']}%"
        )
        print(
            f"F1: {paddle_summary['item_f1_pct']}% -> {hybrid_summary['item_f1_pct']}% | "
            f"Total Match: {paddle_summary['total_match_rate_pct']}% -> {hybrid_summary['total_match_rate_pct']}%"
        )


if __name__ == "__main__":
    main_eval()
