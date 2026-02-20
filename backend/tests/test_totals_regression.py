import unittest

import main


class TotalsRegressionTests(unittest.TestCase):
    def test_little_china_pattern(self) -> None:
        raw_lines = [
            "Items 5 Bill Total : 610.00",
            "Service Tax @4.94% : 30.16",
            "*VAT @ 12.50% : 71.26",
            "**VAT @ 20.00% : 8.00",
            "R. Off: -0.42",
            "Net To Pay 719.00",
        ]
        totals = main.detect_bill_totals(raw_lines)
        self.assertEqual(totals["detected_subtotal"], 610.00)
        self.assertEqual(totals["detected_grand_total"], 719.00)
        self.assertAlmostEqual(totals["detected_tax_total"], 109.42, places=2)
        self.assertEqual(totals["detected_round_off"], -0.42)
        self.assertGreaterEqual(len(totals["detected_tax_breakdown"]), 3)

    def test_amount_payable_pattern(self) -> None:
        raw_lines = [
            "Sub Total 450.00",
            "CGST 9% 40.50",
            "SGST 9% 40.50",
            "Amount Payable 531.00",
        ]
        totals = main.detect_bill_totals(raw_lines)
        self.assertEqual(totals["detected_subtotal"], 450.00)
        self.assertEqual(totals["detected_tax_total"], 81.00)
        self.assertEqual(totals["detected_grand_total"], 531.00)

    def test_grand_total_fallback_when_missing(self) -> None:
        raw_lines = [
            "Bill Total 300.00",
            "GST 18% 54.00",
            "Round Off 1.00",
        ]
        totals = main.detect_bill_totals(raw_lines)
        self.assertEqual(totals["detected_subtotal"], 300.00)
        self.assertEqual(totals["detected_tax_total"], 54.00)
        self.assertEqual(totals["detected_round_off"], 1.00)
        self.assertEqual(totals["detected_grand_total"], 355.00)

    def test_ignores_footer_tax_declarations_without_amounts(self) -> None:
        raw_lines = [
            "Bill Total : 610.00",
            "Service Tax @4.94% : 30.16",
            "*VAT @ 12.50% : 71.26",
            "**VAT @ 20.00% : 8.00",
            "VAT ON FOOD @ 12.5%",
            "VAT ON BEVERAGES @ 20%",
            "SERVICE TAX @ 4.944% PAID",
            "Net To Pay 719.00",
        ]
        totals = main.detect_bill_totals(raw_lines)
        self.assertEqual(totals["detected_tax_total"], 109.42)
        self.assertEqual(len(totals["detected_tax_breakdown"]), 3)

    def test_gross_amount_and_service_charge(self) -> None:
        raw_lines = [
            "Sub Total 3750.00",
            "SERVICE CHARGE 10 % 375.00",
            "SGST 2.5% 103.13",
            "CGST 2.5% 103.13",
            "Gross Amount 4331.00",
        ]
        totals = main.detect_bill_totals(raw_lines)
        self.assertEqual(totals["detected_subtotal"], 3750.00)
        self.assertEqual(totals["detected_service_charge"], 375.00)
        self.assertEqual(totals["detected_tax_total"], 206.26)
        self.assertEqual(totals["detected_grand_total"], 4331.00)

    def test_gstin_line_not_counted_as_tax_amount(self) -> None:
        raw_lines = [
            "Sub Total (RS) : 1523.0",
            "SGST 9.00% (RS) : 137.1",
            "CGST 9.00% (RS) : 137.1",
            "Total (RS) : 1797.1",
            "GST:27AABCC1926B1Z8",
            "Gr.Total (RS) : 1797",
        ]
        totals = main.detect_bill_totals(raw_lines)
        self.assertEqual(totals["detected_tax_total"], 274.2)
        self.assertEqual(len(totals["detected_tax_breakdown"]), 2)
        self.assertEqual(totals["detected_grand_total"], 1797.0)

    def test_total_amount_and_bill_amount_patterns(self) -> None:
        raw_lines = [
            "Total Amount 1315.00",
            "CGST 2.5% 32.88",
            "SGST 2.5% 32.88",
            "Bill Amount 1381.00",
        ]
        totals = main.detect_bill_totals(raw_lines)
        self.assertEqual(totals["detected_subtotal"], 1315.00)
        self.assertEqual(totals["detected_tax_total"], 65.76)
        self.assertEqual(totals["detected_grand_total"], 1381.00)

    def test_waterfall_largest_bottom_total_wins(self) -> None:
        raw_lines = [
            "Sub Total : 235.00",
            "CGST 2.5% : 5.88",
            "SGST 2.5% : 5.88",
            "Total : 246.76",
            "Grand Total : 247.00",
        ]
        totals = main.detect_bill_totals(raw_lines)
        self.assertEqual(totals["detected_subtotal"], 235.00)
        self.assertEqual(totals["detected_grand_total"], 247.00)


if __name__ == "__main__":
    unittest.main()
