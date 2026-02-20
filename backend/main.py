from fastapi import FastAPI, File, UploadFile, Query, HTTPException
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from paddleocr import PaddleOCR
import cv2
import numpy as np
import re
import os
import json
import base64
import urllib.request
import urllib.error
import uuid
import sqlite3
import math
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple
from pydantic import BaseModel, Field

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

print("Loading PaddleOCR...")
ocr = PaddleOCR(use_angle_cls=True, lang="en", show_log=False)
print("PaddleOCR Ready! - Waiting for Bill...")


def load_dotenv_file() -> None:
    base_dir = os.path.dirname(__file__)
    env_paths = [
        os.path.join(base_dir, ".env"),
        os.path.join(base_dir, "test_receipts", ".env"),
    ]
    for env_path in env_paths:
        if not os.path.exists(env_path):
            continue
        try:
            with open(env_path, "r", encoding="utf-8") as f:
                for raw in f:
                    line = raw.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, val = line.split("=", 1)
                    key = key.strip()
                    val = val.strip().strip('"').strip("'")
                    if key and key not in os.environ:
                        os.environ[key] = val
        except Exception:
            # .env load failures should not crash API startup.
            continue


load_dotenv_file()

CURRENCY_PATTERN = re.compile(
    r"(?:\u20B9|Rs\.?|INR|\$)?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{2}))?(?!\d)"
)
STRUCTURED_ITEM_QTY_FIRST_PATTERN = re.compile(
    r"^(?P<name>[A-Za-z][A-Za-z0-9 &()/+\-]{1,}?)\s+"
    r"(?P<qty>\d+(?:\.\d{1,3})?)\s+"
    r"(?P<unit>\d+(?:\.\d{1,2})?)\s+"
    r"(?P<total>\d+(?:\.\d{1,2})?)\s*$"
)
STRUCTURED_ITEM_PRICE_FIRST_PATTERN = re.compile(
    r"^(?P<name>[A-Za-z][A-Za-z0-9 &()/+\-]{1,}?)\s+"
    r"(?P<unit>\d+(?:\.\d{1,2})?)\s+"
    r"(?P<qty>\d+(?:\.\d{1,3})?)\s+"
    r"(?P<total>\d+(?:\.\d{1,2})?)\s*$"
)
STRUCTURED_ITEM_QTY_TOTAL_PATTERN = re.compile(
    r"^(?P<name>[A-Za-z][A-Za-z0-9 &()/+\-]{1,}?)\s+"
    r"(?P<qty>\d+(?:\.\d{1,3})?)\s*[*#xX]?\s+"
    r"(?P<total>\d+(?:\.\d{1,2})?)\s*$"
)
STRUCTURED_ITEM_UNIT_TOTAL_PATTERN = re.compile(
    r"^(?P<name>[A-Za-z][A-Za-z0-9 &()/+\-]{1,}?)\s+"
    r"(?P<unit>\d+(?:\.\d{1,2})?)\s+"
    r"(?P<total>\d+(?:\.\d{1,2})?)\s*$"
)
QTY_PATTERN = re.compile(r"(?i)\b(?:qty|quantity)\s*[:=-]?\s*(\d+(?:\.\d+)?)\b")
MULTIPLY_QTY_PATTERN = re.compile(r"(?i)\b(\d+(?:\.\d+)?)\s*[x*]\b")
TRAILING_QTY_X_PATTERN = re.compile(r"(?i)\bx\s*(\d+(?:\.\d+)?)\b")
NON_ITEM_PATTERN = re.compile(
    r"(?i)\b(?:tel|phone|email|@|www|http|invoice|ticket|table|date|time|receipt|"
    r"thank|delivery|address|no[:#]?|pm|am|phnom|cambodia|tin|hrbr|layout|block|cross)\b"
)

HARD_SKIP_WORDS = {
    "total",
    "subtotal",
    "tax",
    "vat",
    "gst",
    "cgst",
    "sgst",
    "service charge",
    "change",
    "cash",
    "visa",
    "mastercard",
    "amex",
    "paid",
    "payment",
    "balance",
}

SOFT_REMOVE_WORDS = {
    "date",
    "time",
    "ticket",
    "invoice",
    "items",
    "price",
    "tel",
    "phone",
    "email",
    "restaurant",
    "server",
    "bill no",
    "bill#",
    "receipt",
}

TABLE_HEADER_PATTERN = re.compile(
    r"(?i)\b(?:item|items|dish|description|name|dty)\b.*"
    r"\b(?:qty|quantity|qty\.?|aty|dty)\b.*"
    r"\b(?:total|tot|amt|amount|amnt)\b"
)
TABLE_END_PATTERN = re.compile(
    r"(?i)\b(?:total quantity|gross total|grand total|gr\.? ?total|net amount|subtotal|total amount|bill amount|"
    r"tax|vat|service|discount|round off)\b"
)
NON_MENU_ITEM_NAME_PATTERN = re.compile(
    r"(?i)\b(?:"
    r"total|tota|subtotal|sub total|total amount|grand total|gr\.? ?total|gross total|net amount|amount due|"
    r"payable|bill total|bill amount|bil amount|"
    r"round off|service charge|service tax|service|discount|gst|cgst|sgst|vat|tax"
    r")\b"
)

GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-1.5-flash")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_TIMEOUT_SEC = float(os.getenv("GEMINI_TIMEOUT_SEC", "12"))
APP_VERSION = "0.4.0"
DB_PATH = os.path.join(os.path.dirname(__file__), "app.db")
FRONTEND_PAGE = os.path.join(os.path.dirname(__file__), "frontend", "index.html")

NON_VEG_KEYWORDS = {
    "chicken",
    "mutton",
    "lamb",
    "fish",
    "prawn",
    "prawns",
    "crab",
    "egg",
    "keema",
    "tikka",
    "kebab",
    "kabab",
    "biryani chicken",
    "biryani mutton",
    "seafood",
    "maas",
    "chx",
}
VEG_KEYWORDS = {
    "paneer",
    "veg",
    "vegetable",
    "dal",
    "roti",
    "naan",
    "chapati",
    "paratha",
    "idli",
    "dosa",
    "vada",
    "poori",
    "pulao",
    "rice",
    "mushroom",
    "gobi",
    "aloo",
    "chana",
    "rajma",
    "kofta",
}
DRINKS_KEYWORDS = {
    "water",
    "coffee",
    "tea",
    "lassi",
    "juice",
    "soda",
    "cola",
    "coke",
    "sprite",
    "pepsi",
    "beer",
    "wine",
    "whisky",
    "whiskey",
    "rum",
    "vodka",
    "cocktail",
    "mocktail",
    "mojito",
    "panna",
}

OTHER_CATEGORY_OPTIONS = [
    "starter",
    "main_course",
    "bread",
    "rice",
    "dessert",
    "snack",
    "side",
]

OTHER_OPTION_HINTS = {
    "starter": {"roll", "soup", "tikka", "kebab", "pakora", "chilli", "manchow", "manchurian"},
    "main_course": {"curry", "masala", "gravy", "kofta", "biryani", "meal", "thali", "paneer"},
    "bread": {"naan", "roti", "chapati", "paratha", "kulcha"},
    "rice": {"rice", "pulao", "biryani", "fried rice"},
    "dessert": {"halwa", "gulab", "jamun", "ice cream", "kheer", "rabdi", "sweet"},
    "snack": {"vada", "idli", "dosa", "bhel", "poori", "chaat"},
    "side": {"water", "papad", "salad", "pickle", "curd", "raita"},
}

LOBBIES: Dict[str, Dict[str, Any]] = {}


def get_db_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with get_db_conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS lobbies (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                passcode TEXT NOT NULL,
                created_at TEXT NOT NULL,
                receipt_image TEXT,
                host_user_id TEXT,
                receipt_totals_json TEXT
            )
            """
        )
        lobby_columns = [row[1] for row in conn.execute("PRAGMA table_info(lobbies)").fetchall()]
        if "receipt_image" not in lobby_columns:
            conn.execute("ALTER TABLE lobbies ADD COLUMN receipt_image TEXT")
        if "host_user_id" not in lobby_columns:
            conn.execute("ALTER TABLE lobbies ADD COLUMN host_user_id TEXT")
        if "receipt_totals_json" not in lobby_columns:
            conn.execute("ALTER TABLE lobbies ADD COLUMN receipt_totals_json TEXT")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS lobby_items (
                lobby_id TEXT NOT NULL,
                item_id TEXT NOT NULL,
                name TEXT NOT NULL,
                quantity REAL NOT NULL,
                unit_price REAL NOT NULL,
                cost REAL NOT NULL,
                category TEXT,
                category_confidence REAL,
                category_source TEXT,
                other_subcategory TEXT,
                other_category_options_json TEXT,
                PRIMARY KEY (lobby_id, item_id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS participants (
                lobby_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                user_name TEXT NOT NULL,
                PRIMARY KEY (lobby_id, user_id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS claims (
                lobby_id TEXT NOT NULL,
                item_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                quantity REAL NOT NULL,
                PRIMARY KEY (lobby_id, item_id, user_id)
            )
            """
        )
        conn.commit()


class ItemPayload(BaseModel):
    id: Optional[str] = None
    name: str
    quantity: float = 1
    unit_price: float = 0
    cost: float
    category: Optional[str] = None
    category_confidence: Optional[float] = None
    other_category_options: Optional[List[str]] = None


class CreateLobbyRequest(BaseModel):
    lobby_name: Optional[str] = None
    lobby_passcode: str = Field(min_length=4, max_length=32)
    items: List[ItemPayload] = Field(default_factory=list)
    receipt_image: Optional[str] = None
    receipt_totals: Optional[Dict[str, Any]] = None


class JoinLobbyRequest(BaseModel):
    user_name: str
    lobby_passcode: str


class ClaimItemRequest(BaseModel):
    user_id: str
    item_id: str
    quantity: float = 1
    lobby_passcode: str


class ClaimItemDirectRequest(BaseModel):
    lobby_id: str
    user_id: str
    item_id: str
    quantity: float = 1
    lobby_passcode: str


class ItemCategoryUpdateRequest(BaseModel):
    item_id: str
    category: str
    other_subcategory: Optional[str] = None
    lobby_passcode: str
    actor_user_id: Optional[str] = None


class LobbyItemUpdateRequest(BaseModel):
    item_id: str
    lobby_passcode: str
    actor_user_id: Optional[str] = None
    name: Optional[str] = None
    quantity: Optional[float] = None
    unit_price: Optional[float] = None
    cost: Optional[float] = None
    category: Optional[str] = None
    other_subcategory: Optional[str] = None


class ClaimResetRequest(BaseModel):
    item_id: str
    lobby_passcode: str
    user_id: Optional[str] = None
    actor_user_id: Optional[str] = None


class AddLobbyItemRequest(BaseModel):
    lobby_passcode: str
    actor_user_id: str
    name: str
    quantity: float = 1
    unit_price: float = 0
    cost: Optional[float] = None
    category: Optional[str] = None
    other_subcategory: Optional[str] = None


init_db()


@app.get("/")
async def home():
    if os.path.exists(FRONTEND_PAGE):
        return FileResponse(FRONTEND_PAGE)
    return {"message": "Frontend not found. Use API endpoints directly."}


@app.get("/join")
async def join_page():
    if os.path.exists(FRONTEND_PAGE):
        return FileResponse(FRONTEND_PAGE)
    return {"message": "Frontend not found. Use API endpoints directly."}


def estimate_line_threshold(boxes: List[Any]) -> float:
    heights: List[float] = []
    for box in boxes:
        pts = box[0]
        ys = [p[1] for p in pts]
        heights.append(max(ys) - min(ys))
    if not heights:
        return 10.0
    median_h = float(np.median(heights))
    return max(8.0, min(20.0, median_h * 0.65))


def cluster_ocr_lines(boxes: List[Any]) -> List[List[Tuple[str, float, float, float]]]:
    words: List[Tuple[str, float, float, float]] = []
    for box in boxes:
        text = box[1][0].strip()
        conf = float(box[1][1])
        if not text or conf < 0.35:
            continue
        pts = box[0]
        x = float(sum(p[0] for p in pts) / 4.0)
        y = float(sum(p[1] for p in pts) / 4.0)
        words.append((text, x, y, conf))

    words.sort(key=lambda item: item[2])
    threshold = estimate_line_threshold(boxes)

    lines: List[List[Tuple[str, float, float, float]]] = []
    current: List[Tuple[str, float, float, float]] = []
    current_y: Optional[float] = None

    for word in words:
        _, _, y, _ = word
        if current_y is None or abs(y - current_y) <= threshold:
            current.append(word)
            current_y = y if current_y is None else (current_y * 0.7 + y * 0.3)
        else:
            current.sort(key=lambda item: item[1])
            lines.append(current)
            current = [word]
            current_y = y

    if current:
        current.sort(key=lambda item: item[1])
        lines.append(current)

    return lines


def normalize_line_text(line_text: str) -> str:
    # Split glued numeric blocks:
    # 1) "3.003.00" -> "3.00 3.00"
    # 2) "340.002.000" -> "340.00 2.000"
    # Keep standalone qty tokens like "2.000" unchanged.
    text = re.sub(r"(\d+\.\d{2})(?=\d+\.\d{2}\b)", r"\1 ", line_text)
    text = re.sub(r"(\d+\.\d{2})(?=\d+\.\d{3}\b)", r"\1 ", text)
    # Split glued qty+unit before total, e.g. "1110.0 110.0" -> "1 110.0 110.0".
    text = re.sub(r"\b([1-9])(\d{2,4}\.\d{1,2})\b(?=\s+\2\b)", r"\1 \2", text)
    text = re.sub(r"[|]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    for word in SOFT_REMOVE_WORDS:
        text = re.sub(rf"(?i)\b{re.escape(word)}\b", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def should_skip_line(line_text: str, in_item_table: bool = False) -> bool:
    lower = line_text.lower()
    if any(word in lower for word in HARD_SKIP_WORDS):
        return True
    if not in_item_table and NON_ITEM_PATTERN.search(line_text):
        return True
    if line_text.startswith("#"):
        return True
    return False


def parse_money_values(text: str) -> List[float]:
    values: List[float] = []
    for match in CURRENCY_PATTERN.finditer(text):
        whole = match.group(1).replace(",", "")
        frac = match.group(2) if match.group(2) else ""
        number_str = f"{whole}.{frac}" if frac else whole
        try:
            value = float(number_str)
        except ValueError:
            continue
        if 0 < value < 100000:
            values.append(value)
    return values


def parse_last_signed_amount(text: str) -> Optional[float]:
    matches = re.findall(r"(?<!\d)-?\d+(?:,\d{3})*(?:\.\d{1,2})?", text)
    if not matches:
        return None
    try:
        return float(matches[-1].replace(",", ""))
    except ValueError:
        return None


def parse_trailing_amount(text: str) -> Optional[float]:
    # Prefer explicit total amounts at end of line to avoid treating percentages as money.
    cleaned = re.sub(r"\s+", " ", text).strip().rstrip(":;-")
    match = re.search(r"(?<![A-Za-z0-9])(-?\d{1,3}(?:,\d{3})*|-?\d+)(?:\.(\d{1,2}))?\s*$", cleaned)
    if not match:
        return None
    number = match.group(0).replace(",", "").strip()
    if number.endswith("%"):
        return None
    try:
        return float(number)
    except ValueError:
        return None


def infer_quantity(line_text: str, money_values: List[float]) -> float:
    qty_match = QTY_PATTERN.search(line_text)
    if qty_match:
        return float(qty_match.group(1))

    mul_match = MULTIPLY_QTY_PATTERN.search(line_text)
    if mul_match:
        return float(mul_match.group(1))

    trailing_x_match = TRAILING_QTY_X_PATTERN.search(line_text)
    if trailing_x_match:
        return float(trailing_x_match.group(1))

    standalone_numbers = []
    for m in re.finditer(r"\b\d+(?:\.\d+)?\b", line_text):
        val = float(m.group())
        if any(abs(val - money) < 0.001 for money in money_values):
            continue
        standalone_numbers.append(val)

    for val in standalone_numbers:
        if 0 < val <= 20 and float(val).is_integer():
            return val

    return 1.0


def clean_name(line_text: str) -> str:
    text = re.sub(r"(?i)\b(?:qty|quantity)\s*[:=-]?\s*\d+(?:\.\d+)?\b", " ", line_text)
    text = re.sub(r"(?i)\b\d+(?:\.\d+)?\s*[x*]\b", " ", text)
    text = re.sub(r"(?i)\bx\s*\d+(?:\.\d+)?\b", " ", text)
    text = re.sub(r"(?:\u20B9|Rs\.?|INR|\$)?\s*\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?", " ", text)
    text = re.sub(r"[^A-Za-z0-9 &()/+-]", " ", text)
    text = re.sub(r"\s+", " ", text).strip(" -:")
    return text


def parse_structured_item(line_text: str) -> Optional[Dict[str, Any]]:
    match = STRUCTURED_ITEM_QTY_FIRST_PATTERN.match(line_text)
    mode = "qty_first"
    if not match:
        match = STRUCTURED_ITEM_PRICE_FIRST_PATTERN.match(line_text)
        mode = "price_first"
        if not match:
            match = STRUCTURED_ITEM_QTY_TOTAL_PATTERN.match(line_text)
            mode = "qty_total"
            if not match:
                match = STRUCTURED_ITEM_UNIT_TOTAL_PATTERN.match(line_text)
                mode = "unit_total"
                if not match:
                    return None

    name = clean_name(match.group("name"))
    if len(name) < 2:
        return None

    cost = round(float(match.group("total")), 2)
    quantity: Any = 1
    unit_price = 0.0

    def infer_glued_qty_unit(glued_value: float, total_value: float) -> Optional[Tuple[int, float]]:
        # OCR may glue qty+unit (e.g., "2145.00" for "2 145.00") in qty.rate columns.
        g_int = int(round(glued_value))
        t_int = int(round(total_value))
        g_str = str(g_int)
        if len(g_str) < 3:
            return None

        for qty_len in (1, 2):
            if qty_len >= len(g_str):
                continue
            qty_str = g_str[:qty_len]
            unit_str = g_str[qty_len:]
            if not qty_str.isdigit() or not unit_str.isdigit():
                continue
            qty = int(qty_str)
            unit = float(int(unit_str))
            if qty <= 0 or qty > 12 or unit <= 0:
                continue
            if abs((qty * unit) - total_value) <= max(1.0, 0.01 * max(1.0, total_value)):
                return qty, round(unit, 2)

        # Case like 1625 and total 625 => qty=1, unit=625.
        t_str = str(t_int)
        if t_int > 0 and g_str.endswith(t_str):
            prefix = g_str[: len(g_str) - len(t_str)]
            if prefix.isdigit():
                qty = int(prefix)
                if 0 < qty <= 12 and abs((qty * t_int) - total_value) <= max(1.0, 0.01 * max(1.0, total_value)):
                    return qty, float(t_int)
        return None

    if mode in {"qty_first", "price_first"}:
        quantity_raw = float(match.group("qty"))
        if quantity_raw <= 0:
            return None
        quantity = int(round(quantity_raw)) if abs(quantity_raw - round(quantity_raw)) < 0.01 else quantity_raw
        unit_price = round(float(match.group("unit")), 2)
    elif mode == "qty_total":
        quantity_raw = float(match.group("qty"))
        if quantity_raw <= 0:
            return None
        if quantity_raw > 25:
            # This is likely unit+total (e.g., "599.0 1198.0"), not qty+total.
            unit_total_match = STRUCTURED_ITEM_UNIT_TOTAL_PATTERN.match(line_text)
            if not unit_total_match:
                return None
            unit_price = round(float(unit_total_match.group("unit")), 2)
            if unit_price <= 0:
                return None
            inferred_glued = infer_glued_qty_unit(unit_price, cost)
            if inferred_glued is not None:
                quantity, unit_price = inferred_glued
            else:
                inferred_qty = cost / unit_price
                if inferred_qty >= 0.999 and abs(inferred_qty - round(inferred_qty)) < 0.06 and inferred_qty <= 20:
                    quantity = int(round(inferred_qty))
                else:
                    quantity = 1
        else:
            quantity = int(round(quantity_raw)) if abs(quantity_raw - round(quantity_raw)) < 0.01 else quantity_raw
            unit_price = round(cost / float(quantity), 2)
    else:
        unit_price = round(float(match.group("unit")), 2)
        if unit_price <= 0:
            return None
        if unit_price > cost:
            inferred_glued = infer_glued_qty_unit(unit_price, cost)
            if inferred_glued is not None:
                quantity, unit_price = inferred_glued
            else:
                quantity = 1
                unit_price = round(cost, 2)
        inferred_qty = cost / unit_price
        if inferred_qty >= 0.999 and abs(inferred_qty - round(inferred_qty)) < 0.06 and inferred_qty <= 20:
            quantity = int(round(inferred_qty))
        else:
            quantity = 1

    if cost < 0.5:
        return None
    if float(quantity) > 25:
        return None
    if float(quantity) > 15 and unit_price < 10:
        return None

    return {
        "name": name,
        "quantity": quantity,
        "unit_price": unit_price,
        "cost": cost,
    }


def _extract_items_from_lines(
    lines: List[List[Tuple[str, float, float, float]]], require_table_section: bool
) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    inside_item_table = False
    saw_table_header = False

    for line in lines:
        raw_line = " ".join(word[0] for word in line)
        if not raw_line:
            continue

        normalized = normalize_line_text(raw_line)
        if not normalized:
            continue

        if TABLE_HEADER_PATTERN.search(normalized):
            inside_item_table = True
            saw_table_header = True
            continue

        if TABLE_END_PATTERN.search(normalized):
            inside_item_table = False
            continue

        if require_table_section and not inside_item_table:
            continue

        if should_skip_line(normalized, in_item_table=inside_item_table):
            continue

        structured_item = parse_structured_item(normalized)
        if structured_item:
            items.append(structured_item)
            continue

        decimal_tokens = re.findall(r"\b\d+\.\d{2}\b", normalized)
        # In fallback mode, ignore lines that do not look like item price rows.
        if not require_table_section and len(decimal_tokens) < 2:
            continue

        money_values = parse_money_values(normalized)
        if len(money_values) < 2:
            continue

        cost = round(money_values[-1], 2)
        if cost < 0.5:
            continue

        quantity = infer_quantity(normalized, money_values)
        if quantity <= 0:
            quantity = 1.0

        unit_price = round(money_values[-2], 2)
        if abs((unit_price * quantity) - cost) > max(1.0, 0.08 * cost):
            unit_price = round(cost / quantity, 2)
        if quantity > 25 or (quantity > 15 and unit_price < 10):
            continue

        name = clean_name(normalized)
        if len(name) < 2:
            continue

        quantity_out: Any = int(quantity) if float(quantity).is_integer() else quantity

        items.append(
            {
                "name": name,
                "quantity": quantity_out,
                "unit_price": unit_price,
                "cost": cost,
            }
        )

    # If strict table mode was requested but OCR failed to detect header, signal caller to retry.
    if require_table_section and not saw_table_header:
        return []
    return items


def extract_items_from_lines(lines: List[List[Tuple[str, float, float, float]]]) -> List[Dict[str, Any]]:
    # Pass 1: strict mode inside item table.
    items = _extract_items_from_lines(lines, require_table_section=True)
    items = [item for item in items if not NON_MENU_ITEM_NAME_PATTERN.search(str(item.get("name", "")))]
    if items:
        return items
    # Pass 2 fallback: parse globally if table header was not detected.
    fallback_items = _extract_items_from_lines(lines, require_table_section=False)
    return [item for item in fallback_items if not NON_MENU_ITEM_NAME_PATTERN.search(str(item.get("name", "")))]


def categorize_item(name: str) -> Tuple[str, float]:
    lower = name.lower()
    if any(k in lower for k in DRINKS_KEYWORDS):
        return "drinks", 0.9
    if any(k in lower for k in NON_VEG_KEYWORDS):
        return "non_veg", 0.9
    if any(k in lower for k in VEG_KEYWORDS):
        return "veg", 0.82
    return "other", 0.55


def suggest_other_options(name: str) -> List[str]:
    lower = name.lower()
    ranked: List[str] = []
    for option, hints in OTHER_OPTION_HINTS.items():
        if any(h in lower for h in hints):
            ranked.append(option)
    for fallback in OTHER_CATEGORY_OPTIONS:
        if fallback not in ranked:
            ranked.append(fallback)
    return ranked


def enrich_items_with_category(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    enriched: List[Dict[str, Any]] = []
    for idx, item in enumerate(items, start=1):
        category, cat_conf = categorize_item(str(item.get("name", "")))
        updated = dict(item)
        updated["id"] = str(updated.get("id") or f"itm_{idx}")
        updated["category"] = category
        updated["category_confidence"] = round(cat_conf, 2)
        if category == "other":
            updated["other_category_options"] = suggest_other_options(updated.get("name", ""))
        enriched.append(updated)
    return enriched


def build_needs_review(lines: List[List[Tuple[str, float, float, float]]], items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    item_names = [i["name"].lower() for i in items]
    needs_review: List[Dict[str, Any]] = []

    for line in lines:
        raw = " ".join(word[0] for word in line).strip()
        if not raw:
            continue
        normalized = normalize_line_text(raw)
        if not normalized:
            continue
        has_money = bool(re.search(r"\d+\.\d{1,2}", normalized))
        has_alpha = bool(re.search(r"[A-Za-z]", normalized))
        if not (has_money and has_alpha):
            continue
        if should_skip_line(normalized, in_item_table=True):
            continue
        low = normalized.lower()
        if any(name and name in low for name in item_names):
            continue
        needs_review.append({"line": raw, "reason": "unparsed_line"})

    for item in items:
        qty = float(item.get("quantity", 1))
        unit_price = float(item.get("unit_price", 0))
        if qty > 12 and unit_price < 15:
            needs_review.append({"line": item["name"], "reason": "suspicious_quantity"})

    return needs_review[:20]


def compute_quality_score(items: List[Dict[str, Any]], needs_review: List[Dict[str, Any]]) -> float:
    if not items:
        return 0.0
    score = 0.75
    if len(items) >= 3:
        score += 0.1
    if len(items) >= 6:
        score += 0.05
    penalty = min(0.45, 0.06 * len(needs_review))
    score -= penalty
    return max(0.0, min(1.0, score))


def detect_bill_totals(raw_lines: List[str]) -> Dict[str, Any]:
    subtotal_candidates: List[float] = []
    grand_total_candidates: List[float] = []
    total_candidates: List[Tuple[int, float]] = []
    tax_total = 0.0
    service_charge = 0.0
    round_off = 0.0
    tax_breakdown: List[Dict[str, Any]] = []
    for idx, line in enumerate(raw_lines):
        lower = line.lower()
        values = parse_money_values(line)
        amount = parse_trailing_amount(line)
        if amount is None and values:
            amount = values[-1]

        if amount is not None and ("total" in lower or "payable" in lower or "amount" in lower):
            if not re.search(r"\bgst\s*[:#-]?\s*[a-z0-9]{10,}\b", lower) and "total quantity" not in lower:
                total_candidates.append((idx, amount))

        if amount is None and "round" not in lower:
            continue

        if any(k in lower for k in ["sub total", "subtotal", "item total", "total items", "bill total", "total amount"]):
            subtotal_candidates.append(amount)
            continue

        if any(
            k in lower
            for k in [
                "grand total",
                "gr.total",
                "gr total",
                "gross amount",
                "bill amount",
                "net amount",
                "net to pay",
                "amount payable",
                "amount due",
                "pay amount",
                "payable amount",
                "total payable",
            ]
        ):
            grand_total_candidates.append(amount)
            continue

        if "round off" in lower or "r. off" in lower or "roundof" in lower:
            signed = parse_last_signed_amount(line)
            if signed is not None:
                round_off += signed
            continue

        if any(k in lower for k in ["sgst", "cgst", "gst", "vat", "service tax", "tax", "cess"]):
            if "tax id" in lower or "gstin" in lower or "tin" in lower:
                continue
            if re.search(r"\bgst\s*[:#-]?\s*[a-z0-9]{10,}\b", lower):
                continue
            if ("vat on food" in lower) or ("vat on beverages" in lower) or (" paid" in lower):
                continue
            # Footer declaration lines like "VAT ON FOOD @12.5%" should not become charge rows.
            if amount is None:
                continue
            tail_amount = parse_trailing_amount(line)
            if tail_amount is None:
                continue
            amount = tail_amount
            if amount is None:
                continue
            tax_total += amount
            label = re.sub(r"\s+", " ", line).strip()
            tax_breakdown.append({"name": label, "amount": round(amount, 2)})
            if "service charge" in lower or "service tax" in lower:
                service_charge += amount
            continue

        if "service charge" in lower and amount is not None:
            service_charge += amount
            label = re.sub(r"\s+", " ", line).strip()
            tax_breakdown.append({"name": label, "amount": round(amount, 2)})
            continue

    subtotal = subtotal_candidates[-1] if subtotal_candidates else None
    grand_total = grand_total_candidates[-1] if grand_total_candidates else None

    # Waterfall rule: among bottom "total-like" numbers, largest valid amount is grand total.
    if grand_total is None and len(total_candidates) >= 2:
        bottom_cutoff = max(0, len(raw_lines) - 8)
        bottom_amounts = [amt for i, amt in total_candidates if i >= bottom_cutoff]
        pool = bottom_amounts if bottom_amounts else [amt for _, amt in total_candidates]
        if pool:
            if subtotal is not None:
                pool = [p for p in pool if p >= subtotal] or pool
            grand_total = max(pool)

    if grand_total is None and subtotal is not None and (tax_total > 0 or service_charge > 0 or abs(round_off) > 0):
        grand_total = subtotal + tax_total + service_charge + round_off

    return {
        "detected_subtotal": round(subtotal, 2) if subtotal is not None else None,
        "detected_grand_total": round(grand_total, 2) if grand_total is not None else None,
        "detected_tax_total": round(tax_total, 2) if tax_total > 0 else None,
        "detected_service_charge": round(service_charge, 2) if service_charge > 0 else None,
        "detected_round_off": round(round_off, 2) if abs(round_off) > 0 else None,
        "detected_tax_breakdown": tax_breakdown,
    }


def item_name_key(name: str) -> str:
    base = re.sub(r"[^a-z0-9 ]", " ", (name or "").lower())
    base = re.sub(r"\s+", " ", base).strip()
    return base


def merge_unique_items(base_items: List[Dict[str, Any]], extra_items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    merged = list(base_items)
    seen = {item_name_key(i.get("name", "")) for i in base_items}
    for item in extra_items:
        name = str(item.get("name", "")).strip()
        if len(name) < 2:
            continue
        key = item_name_key(name)
        if not key or key in seen:
            continue
        if NON_MENU_ITEM_NAME_PATTERN.search(name):
            continue
        cost = float(item.get("cost", 0) or 0)
        qty = float(item.get("quantity", 0) or 0)
        unit = float(item.get("unit_price", 0) or 0)
        if qty <= 0 or cost <= 0:
            continue
        if unit <= 0:
            unit = round(cost / qty, 2)
            item["unit_price"] = unit
        merged.append(item)
        seen.add(key)
    return merged


def extract_json_block(text: str) -> Optional[Dict[str, Any]]:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?", "", text).strip()
        text = re.sub(r"```$", "", text).strip()
    try:
        return json.loads(text)
    except Exception:
        pass

    match = re.search(r"\{[\s\S]*\}", text)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except Exception:
        return None


def call_gemini_fallback(image_data: bytes) -> Optional[Dict[str, Any]]:
    if not GEMINI_API_KEY:
        return None

    prompt = (
        "Extract receipt line items from the image.\n"
        "Return ONLY JSON with this exact shape:\n"
        "{\n"
        '  "items":[{"name":"...", "quantity":1, "unit_price":10.0, "cost":10.0}],\n'
        '  "needs_review":[{"line":"...", "reason":"..."}]\n'
        "}\n"
        "Rules: quantity numeric, unit_price numeric, cost numeric (line total)."
    )

    payload = {
        "contents": [
            {
                "parts": [
                    {"text": prompt},
                    {
                        "inline_data": {
                            "mime_type": "image/jpeg",
                            "data": base64.b64encode(image_data).decode("utf-8"),
                        }
                    },
                ]
            }
        ]
    }
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
        f"?key={GEMINI_API_KEY}"
    )
    req = urllib.request.Request(
        url=url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=GEMINI_TIMEOUT_SEC) as response:
            body = response.read().decode("utf-8")
    except urllib.error.URLError:
        return None
    except Exception:
        return None

    try:
        parsed = json.loads(body)
        parts = parsed["candidates"][0]["content"]["parts"]
        text = "".join(part.get("text", "") for part in parts)
    except Exception:
        return None

    data = extract_json_block(text)
    if not data or "items" not in data:
        return None

    normalized_items = []
    for item in data.get("items", []):
        try:
            name = str(item.get("name", "")).strip()
            if len(name) < 2:
                continue
            quantity = float(item.get("quantity", 1))
            unit_price = float(item.get("unit_price", 0))
            cost = float(item.get("cost", 0))
            if cost <= 0:
                continue
            normalized_items.append(
                {
                    "name": name,
                    "quantity": int(quantity) if quantity.is_integer() else quantity,
                    "unit_price": round(unit_price, 2),
                    "cost": round(cost, 2),
                }
            )
        except Exception:
            continue

    needs_review = data.get("needs_review", [])
    if not isinstance(needs_review, list):
        needs_review = []

    return {"items": enrich_items_with_category(normalized_items), "needs_review": needs_review}


def run_paddle_pipeline(image: np.ndarray) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], List[str]]:
    result = ocr.ocr(image, cls=True)
    if not result or not result[0]:
        return [], [{"line": "", "reason": "blank_or_unreadable"}], []

    lines = cluster_ocr_lines(result[0])
    items = enrich_items_with_category(extract_items_from_lines(lines))
    needs_review = build_needs_review(lines, items)
    raw_lines = [" ".join(word[0] for word in line) for line in lines]
    return items, needs_review, raw_lines


def normalize_lobby_items(items: List[ItemPayload]) -> List[Dict[str, Any]]:
    raw = []
    for idx, item in enumerate(items, start=1):
        data = item.model_dump() if hasattr(item, "model_dump") else item.dict()
        data["id"] = data.get("id") or f"itm_{idx}"
        if data.get("quantity", 0) <= 0:
            data["quantity"] = 1
        if data.get("unit_price", 0) <= 0 and data.get("cost", 0) > 0:
            data["unit_price"] = round(float(data["cost"]) / float(data["quantity"]), 2)
        raw.append(data)
    return enrich_items_with_category(raw)


def parse_float_or_none(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def sanitize_receipt_totals(raw_totals: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not isinstance(raw_totals, dict):
        return {}
    out: Dict[str, Any] = {}
    for key in [
        "computed_subtotal",
        "detected_subtotal",
        "detected_grand_total",
        "detected_tax_total",
        "detected_service_charge",
        "detected_round_off",
    ]:
        parsed = parse_float_or_none(raw_totals.get(key))
        out[key] = round(parsed, 2) if parsed is not None else None

    breakdown = raw_totals.get("detected_tax_breakdown")
    clean_breakdown: List[Dict[str, Any]] = []
    if isinstance(breakdown, list):
        for row in breakdown:
            if not isinstance(row, dict):
                continue
            name = str(row.get("name", "")).strip()
            amount = parse_float_or_none(row.get("amount"))
            if not name or amount is None:
                continue
            clean_breakdown.append({"name": name, "amount": round(amount, 2)})
    out["detected_tax_breakdown"] = clean_breakdown
    return out


def fetch_lobby(lobby_id: str) -> Optional[sqlite3.Row]:
    with get_db_conn() as conn:
        return conn.execute("SELECT * FROM lobbies WHERE id = ?", (lobby_id,)).fetchone()


def read_lobby_receipt_totals(lobby: sqlite3.Row) -> Dict[str, Any]:
    raw = lobby["receipt_totals_json"] if "receipt_totals_json" in lobby.keys() else None
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def validate_lobby_passcode(lobby_id: str, lobby_passcode: str) -> None:
    lobby = fetch_lobby(lobby_id)
    if not lobby:
        raise HTTPException(status_code=404, detail="Lobby not found")
    if lobby["passcode"] != (lobby_passcode or "").strip():
        raise HTTPException(status_code=401, detail="Invalid lobby passcode")


def validate_host_actor(lobby_id: str, actor_user_id: Optional[str]) -> None:
    lobby = fetch_lobby(lobby_id)
    if not lobby:
        raise HTTPException(status_code=404, detail="Lobby not found")
    host_user_id = (lobby["host_user_id"] or "").strip()
    if not actor_user_id:
        raise HTTPException(status_code=403, detail="Host access required")
    if host_user_id and actor_user_id.strip() != host_user_id:
        raise HTTPException(status_code=403, detail="Only host can edit or reset claims")


def fetch_lobby_items(lobby_id: str) -> List[Dict[str, Any]]:
    with get_db_conn() as conn:
        rows = conn.execute(
            """
            SELECT * FROM lobby_items
            WHERE lobby_id = ?
            ORDER BY CAST(SUBSTR(item_id, 5) AS INTEGER)
            """,
            (lobby_id,),
        ).fetchall()
    items: List[Dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        item["id"] = item.get("item_id")
        opts = item.get("other_category_options_json")
        item["other_category_options"] = json.loads(opts) if opts else None
        item.pop("other_category_options_json", None)
        items.append(item)
    return items


def fetch_participants(lobby_id: str) -> Dict[str, str]:
    with get_db_conn() as conn:
        rows = conn.execute("SELECT user_id, user_name FROM participants WHERE lobby_id = ?", (lobby_id,)).fetchall()
    return {row["user_id"]: row["user_name"] for row in rows}


def fetch_claims(lobby_id: str) -> Dict[str, Dict[str, float]]:
    claims: Dict[str, Dict[str, float]] = {}
    with get_db_conn() as conn:
        rows = conn.execute("SELECT item_id, user_id, quantity FROM claims WHERE lobby_id = ?", (lobby_id,)).fetchall()
    for row in rows:
        claims.setdefault(row["item_id"], {})[row["user_id"]] = float(row["quantity"])
    return claims


def next_item_id(lobby_id: str) -> str:
    items = fetch_lobby_items(lobby_id)
    max_n = 0
    for item in items:
        iid = str(item.get("id", ""))
        m = re.match(r"^itm_(\d+)$", iid)
        if not m:
            continue
        max_n = max(max_n, int(m.group(1)))
    return f"itm_{max_n + 1}"


def validate_participant_actor(lobby_id: str, actor_user_id: str) -> None:
    participants = fetch_participants(lobby_id)
    if actor_user_id not in participants:
        raise HTTPException(status_code=403, detail="Only joined participants can add items")


def compute_lobby_summary(lobby_id: str) -> Dict[str, Any]:
    lobby = fetch_lobby(lobby_id)
    if not lobby:
        raise HTTPException(status_code=404, detail="Lobby not found")
    participants = fetch_participants(lobby_id)
    claims = fetch_claims(lobby_id)
    items = fetch_lobby_items(lobby_id)
    per_user: Dict[str, Dict[str, Any]] = {}
    for user_id, user_name in participants.items():
        per_user[user_id] = {"user_name": user_name, "base_total": 0.0, "extra_share": 0.0, "total": 0.0, "items": []}

    receipt_totals = read_lobby_receipt_totals(lobby)

    unclaimed_item_total = 0.0
    for item in items:
        item_id = item["id"]
        qty_total = float(item.get("quantity", 1))
        line_total = float(item.get("cost", 0))
        unit_cost = line_total / qty_total if qty_total > 0 else line_total
        claimed_map = claims.get(item_id, {})
        claimed_qty_sum = 0.0
        for user_id, qty in claimed_map.items():
            qty_f = float(qty)
            claimed_qty_sum += qty_f
            if user_id not in per_user:
                continue
            amount = round(unit_cost * qty_f, 2)
            per_user[user_id]["base_total"] = round(per_user[user_id]["base_total"] + amount, 2)
            per_user[user_id]["items"].append(
                {"item_id": item_id, "name": item["name"], "quantity": qty_f, "amount": amount}
            )
        remaining = max(0.0, qty_total - claimed_qty_sum)
        unclaimed_item_total = round(unclaimed_item_total + (unit_cost * remaining), 2)

    computed_item_subtotal = round(sum(float(i.get("cost", 0)) for i in items), 2)
    manual_added_total = round(
        sum(float(i.get("cost", 0)) for i in items if str(i.get("category_source", "")).lower() == "user_selected"),
        2,
    )
    detected_subtotal = parse_float_or_none(receipt_totals.get("detected_subtotal"))
    detected_grand_total = parse_float_or_none(receipt_totals.get("detected_grand_total"))
    tax_breakdown = receipt_totals.get("detected_tax_breakdown")
    if not isinstance(tax_breakdown, list):
        tax_breakdown = []

    # Prefer receipt totals as source of truth. Only manual user-added items are added on top.
    if detected_subtotal is not None:
        item_subtotal = round(detected_subtotal + manual_added_total, 2)
    else:
        item_subtotal = computed_item_subtotal
    if detected_grand_total is not None:
        grand_total = round(detected_grand_total + manual_added_total, 2)
    else:
        grand_total = item_subtotal

    extra_charges = max(0.0, round(grand_total - item_subtotal, 2))
    # Proportional distribution of receipt-level extra charges.
    claimed_base_total = round(sum(float(user["base_total"]) for user in per_user.values()), 2)
    extra_share_cents: Dict[str, int] = {uid: 0 for uid in per_user.keys()}
    extra_cents = int(round(extra_charges * 100))
    if extra_cents > 0 and item_subtotal > 0:
        raw_cents: Dict[str, float] = {}
        floor_sum = 0
        for uid, user in per_user.items():
            weight = max(0.0, float(user["base_total"]))
            raw = (extra_cents * weight) / item_subtotal
            base = int(math.floor(raw))
            raw_cents[uid] = raw
            extra_share_cents[uid] = base
            floor_sum += base
        remainder = max(0, extra_cents - floor_sum)
        if remainder > 0:
            by_fraction = sorted(
                per_user.keys(),
                key=lambda uid: (raw_cents.get(uid, 0.0) - extra_share_cents.get(uid, 0)),
                reverse=True,
            )
            for uid in by_fraction[:remainder]:
                extra_share_cents[uid] += 1

    for uid, user in per_user.items():
        extra_share = round(extra_share_cents.get(uid, 0) / 100.0, 2)
        user["extra_share"] = extra_share
        user["total"] = round(float(user["base_total"]) + extra_share, 2)

    claimed_total = round(sum(float(user["total"]) for user in per_user.values()), 2)
    unclaimed_total = round(max(0.0, grand_total - claimed_total), 2)
    claim_progress_base = item_subtotal if item_subtotal > 0 else grand_total
    claim_progress_pct = (
        round(min(100.0, (claimed_base_total / claim_progress_base) * 100.0), 2) if claim_progress_base > 0 else 0.0
    )
    return {
        "lobby_id": lobby["id"],
        "lobby_name": lobby["name"],
        "participant_count": len(participants),
        "item_subtotal": item_subtotal,
        "extra_charges": extra_charges,
        "grand_total": grand_total,
        "claimed_total": claimed_total,
        "claimed_base_total": claimed_base_total,
        "unclaimed_total": unclaimed_total,
        "claim_progress_pct": claim_progress_pct,
        "unclaimed_item_total": round(unclaimed_item_total, 2),
        "tax_breakdown": tax_breakdown,
        "receipt_totals": receipt_totals,
        "users": per_user,
    }


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "time_utc": datetime.now(timezone.utc).isoformat(),
        "gemini_configured": bool(GEMINI_API_KEY),
        "db_path": DB_PATH,
    }


@app.get("/version")
async def version():
    return {
        "app": "slice-backend",
        "version": APP_VERSION,
        "gemini_model": GEMINI_MODEL,
    }


@app.post("/lobby/create")
async def create_lobby(req: CreateLobbyRequest):
    lobby_id = str(uuid.uuid4())[:8]
    lobby_name = req.lobby_name or f"Lobby-{lobby_id}"
    passcode = req.lobby_passcode.strip()
    items = normalize_lobby_items(req.items)
    created_at = datetime.now(timezone.utc).isoformat()
    receipt_image = req.receipt_image if req.receipt_image else None
    receipt_totals = sanitize_receipt_totals(req.receipt_totals)
    with get_db_conn() as conn:
        conn.execute(
            "INSERT INTO lobbies (id, name, passcode, created_at, receipt_image, receipt_totals_json) VALUES (?, ?, ?, ?, ?, ?)",
            (lobby_id, lobby_name, passcode, created_at, receipt_image, json.dumps(receipt_totals)),
        )
        for item in items:
            conn.execute(
                """
                INSERT INTO lobby_items (
                    lobby_id, item_id, name, quantity, unit_price, cost,
                    category, category_confidence, category_source, other_subcategory, other_category_options_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    lobby_id,
                    item["id"],
                    item["name"],
                    float(item.get("quantity", 1)),
                    float(item.get("unit_price", 0)),
                    float(item.get("cost", 0)),
                    item.get("category"),
                    float(item.get("category_confidence", 0)),
                    item.get("category_source"),
                    item.get("other_subcategory"),
                    json.dumps(item.get("other_category_options")) if item.get("other_category_options") else None,
                ),
            )
        conn.commit()
    return {
        "lobby_id": lobby_id,
        "lobby_name": lobby_name,
        "items": items,
        "receipt_image": receipt_image,
        "receipt_totals": receipt_totals,
    }


@app.post("/lobby/{lobby_id}/join")
async def join_lobby(lobby_id: str, req: JoinLobbyRequest):
    validate_lobby_passcode(lobby_id, req.lobby_passcode)
    user_id = str(uuid.uuid4())[:8]
    with get_db_conn() as conn:
        conn.execute(
            "INSERT INTO participants (lobby_id, user_id, user_name) VALUES (?, ?, ?)",
            (lobby_id, user_id, req.user_name.strip()),
        )
        host_row = conn.execute(
            "SELECT host_user_id FROM lobbies WHERE id = ?",
            (lobby_id,),
        ).fetchone()
        if host_row and not (host_row["host_user_id"] or "").strip():
            conn.execute(
                "UPDATE lobbies SET host_user_id = ? WHERE id = ?",
                (user_id, lobby_id),
            )
        conn.commit()
    return {"lobby_id": lobby_id, "user_id": user_id, "user_name": req.user_name.strip()}


@app.post("/lobby/{lobby_id}/claim")
async def claim_item(lobby_id: str, req: ClaimItemRequest):
    validate_lobby_passcode(lobby_id, req.lobby_passcode)
    participants = fetch_participants(lobby_id)
    if req.user_id not in participants:
        raise HTTPException(status_code=400, detail="User not in lobby")
    items = fetch_lobby_items(lobby_id)
    item = next((i for i in items if i["id"] == req.item_id), None)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    if req.quantity < 0:
        raise HTTPException(status_code=400, detail="Quantity must be >= 0")

    item_id = req.item_id
    claims = fetch_claims(lobby_id)
    if item_id not in claims:
        claims[item_id] = {}
    claimed_by_others = sum(float(v) for uid, v in claims[item_id].items() if uid != req.user_id)
    max_allowed = float(item.get("quantity", 1)) - claimed_by_others
    if req.quantity > max_allowed + 1e-6:
        raise HTTPException(status_code=400, detail=f"Max claimable quantity is {round(max_allowed, 3)}")
    with get_db_conn() as conn:
        if req.quantity == 0:
            conn.execute(
                "DELETE FROM claims WHERE lobby_id = ? AND item_id = ? AND user_id = ?",
                (lobby_id, item_id, req.user_id),
            )
        else:
            conn.execute(
                """
                INSERT INTO claims (lobby_id, item_id, user_id, quantity)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(lobby_id, item_id, user_id) DO UPDATE SET quantity=excluded.quantity
                """,
                (lobby_id, item_id, req.user_id, float(req.quantity)),
            )
        conn.commit()
    return {"ok": True, "lobby_id": lobby_id, "item_id": item_id, "user_id": req.user_id, "quantity": req.quantity}


@app.post("/claim-item")
async def claim_item_direct(req: ClaimItemDirectRequest):
    return await claim_item(
        req.lobby_id,
        ClaimItemRequest(
            user_id=req.user_id,
            item_id=req.item_id,
            quantity=req.quantity,
            lobby_passcode=req.lobby_passcode,
        ),
    )


@app.post("/lobby/{lobby_id}/item-category")
async def update_item_category(lobby_id: str, req: ItemCategoryUpdateRequest):
    validate_lobby_passcode(lobby_id, req.lobby_passcode)
    validate_host_actor(lobby_id, req.actor_user_id)
    items = fetch_lobby_items(lobby_id)
    item = next((i for i in items if i["id"] == req.item_id), None)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    allowed_categories = {"veg", "non_veg", "drinks", "other"}
    category = req.category.strip().lower()
    if category not in allowed_categories:
        raise HTTPException(status_code=400, detail=f"Category must be one of {sorted(allowed_categories)}")

    item["category"] = category
    item["category_confidence"] = 1.0
    item["category_source"] = "user_selected"

    if category == "other":
        chosen = (req.other_subcategory or "").strip().lower()
        if chosen:
            if chosen not in OTHER_CATEGORY_OPTIONS:
                raise HTTPException(
                    status_code=400,
                    detail=f"other_subcategory must be one of {OTHER_CATEGORY_OPTIONS}",
                )
            item["other_subcategory"] = chosen
        elif "other_subcategory" in item:
            del item["other_subcategory"]
        item["other_category_options"] = suggest_other_options(item.get("name", ""))
    else:
        item.pop("other_subcategory", None)
        item.pop("other_category_options", None)

    with get_db_conn() as conn:
        conn.execute(
            """
            UPDATE lobby_items
            SET category = ?, category_confidence = ?, category_source = ?,
                other_subcategory = ?, other_category_options_json = ?
            WHERE lobby_id = ? AND item_id = ?
            """,
            (
                item.get("category"),
                float(item.get("category_confidence", 0)),
                item.get("category_source"),
                item.get("other_subcategory"),
                json.dumps(item.get("other_category_options")) if item.get("other_category_options") else None,
                lobby_id,
                req.item_id,
            ),
        )
        conn.commit()

    return {"ok": True, "lobby_id": lobby_id, "item": item}


@app.post("/lobby/{lobby_id}/item-update")
async def update_lobby_item(lobby_id: str, req: LobbyItemUpdateRequest):
    validate_lobby_passcode(lobby_id, req.lobby_passcode)
    validate_host_actor(lobby_id, req.actor_user_id)
    items = fetch_lobby_items(lobby_id)
    item = next((i for i in items if i["id"] == req.item_id), None)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    new_name = (req.name if req.name is not None else item["name"]).strip()
    if len(new_name) < 2:
        raise HTTPException(status_code=400, detail="Item name is too short")

    new_qty = float(req.quantity if req.quantity is not None else item["quantity"])
    if new_qty <= 0:
        raise HTTPException(status_code=400, detail="Quantity must be > 0")

    new_unit = float(req.unit_price if req.unit_price is not None else item["unit_price"])
    if new_unit < 0:
        raise HTTPException(status_code=400, detail="Unit price must be >= 0")

    new_cost = float(req.cost if req.cost is not None else item["cost"])
    if new_cost < 0:
        raise HTTPException(status_code=400, detail="Cost must be >= 0")

    expected_cost = round(new_qty * new_unit, 2)
    if req.cost is not None and req.unit_price is not None and abs(new_cost - expected_cost) > max(1.0, 0.05 * max(1.0, expected_cost)):
        raise HTTPException(
            status_code=400,
            detail=f"Cost mismatch: expected ~{expected_cost} from quantity x unit_price",
        )
    if req.cost is None and req.unit_price is not None:
        new_cost = expected_cost
    if req.unit_price is None and req.cost is not None and new_qty > 0:
        new_unit = round(new_cost / new_qty, 2)

    claims = fetch_claims(lobby_id)
    claimed_total = sum(float(v) for v in claims.get(req.item_id, {}).values())
    if claimed_total > new_qty + 1e-6:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot reduce quantity below already claimed amount ({round(claimed_total, 3)})",
        )

    new_category = (req.category or item.get("category") or "other").strip().lower()
    allowed_categories = {"veg", "non_veg", "drinks", "other"}
    if new_category not in allowed_categories:
        raise HTTPException(status_code=400, detail=f"Category must be one of {sorted(allowed_categories)}")

    other_subcategory = item.get("other_subcategory")
    other_options = item.get("other_category_options")
    if new_category == "other":
        chosen = (req.other_subcategory or other_subcategory or "").strip().lower()
        if chosen and chosen not in OTHER_CATEGORY_OPTIONS:
            raise HTTPException(
                status_code=400,
                detail=f"other_subcategory must be one of {OTHER_CATEGORY_OPTIONS}",
            )
        other_subcategory = chosen or None
        other_options = suggest_other_options(new_name)
    else:
        other_subcategory = None
        other_options = None

    with get_db_conn() as conn:
        conn.execute(
            """
            UPDATE lobby_items
            SET name = ?, quantity = ?, unit_price = ?, cost = ?,
                category = ?, category_confidence = ?, category_source = ?,
                other_subcategory = ?, other_category_options_json = ?
            WHERE lobby_id = ? AND item_id = ?
            """,
            (
                new_name,
                new_qty,
                new_unit,
                new_cost,
                new_category,
                1.0,
                "host_edited",
                other_subcategory,
                json.dumps(other_options) if other_options else None,
                lobby_id,
                req.item_id,
            ),
        )
        conn.commit()

    updated = next((i for i in fetch_lobby_items(lobby_id) if i["id"] == req.item_id), None)
    return {"ok": True, "lobby_id": lobby_id, "item": updated}


@app.post("/lobby/{lobby_id}/claim-reset")
async def reset_claim(lobby_id: str, req: ClaimResetRequest):
    validate_lobby_passcode(lobby_id, req.lobby_passcode)
    validate_host_actor(lobby_id, req.actor_user_id)
    items = fetch_lobby_items(lobby_id)
    item = next((i for i in items if i["id"] == req.item_id), None)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    with get_db_conn() as conn:
        if req.user_id:
            conn.execute(
                "DELETE FROM claims WHERE lobby_id = ? AND item_id = ? AND user_id = ?",
                (lobby_id, req.item_id, req.user_id),
            )
        else:
            conn.execute(
                "DELETE FROM claims WHERE lobby_id = ? AND item_id = ?",
                (lobby_id, req.item_id),
            )
        conn.commit()

    return {"ok": True, "lobby_id": lobby_id, "item_id": req.item_id, "user_id": req.user_id}


@app.post("/lobby/{lobby_id}/item-add")
async def add_lobby_item(lobby_id: str, req: AddLobbyItemRequest):
    validate_lobby_passcode(lobby_id, req.lobby_passcode)
    validate_participant_actor(lobby_id, req.actor_user_id)

    name = req.name.strip()
    if len(name) < 2:
        raise HTTPException(status_code=400, detail="Item name is too short")

    quantity = float(req.quantity)
    unit_price = float(req.unit_price)
    if quantity <= 0:
        raise HTTPException(status_code=400, detail="Quantity must be > 0")
    if unit_price < 0:
        raise HTTPException(status_code=400, detail="Unit price must be >= 0")

    if req.cost is None:
        # No explicit cost: compute from qty x unit, requiring unit price.
        if unit_price <= 0:
            raise HTTPException(status_code=400, detail="Provide unit_price or cost")
        cost = round(quantity * unit_price, 2)
    else:
        # Explicit cost is authoritative for manual corrections.
        cost = float(req.cost)
        if cost <= 0:
            raise HTTPException(status_code=400, detail="Cost must be > 0")
        if unit_price <= 0 and quantity > 0:
            unit_price = round(cost / quantity, 2)
        else:
            expected_cost = round(quantity * unit_price, 2)
            if abs(cost - expected_cost) > max(1.0, 0.05 * max(1.0, expected_cost)):
                # Keep user-entered cost and normalize unit price to avoid reject-on-small-OCR/manual variance.
                unit_price = round(cost / quantity, 2)

    base_item = {
        "id": next_item_id(lobby_id),
        "name": name,
        "quantity": int(quantity) if float(quantity).is_integer() else quantity,
        "unit_price": round(unit_price, 2),
        "cost": round(cost, 2),
    }
    enriched = enrich_items_with_category([base_item])[0]
    if req.category:
        forced = req.category.strip().lower()
        if forced not in {"veg", "non_veg", "drinks", "other"}:
            raise HTTPException(status_code=400, detail="Invalid category")
        enriched["category"] = forced
        enriched["category_confidence"] = 1.0
        enriched["category_source"] = "user_selected"
    if enriched.get("category") == "other":
        chosen = (req.other_subcategory or "").strip().lower()
        if chosen:
            if chosen not in OTHER_CATEGORY_OPTIONS:
                raise HTTPException(status_code=400, detail=f"other_subcategory must be one of {OTHER_CATEGORY_OPTIONS}")
            enriched["other_subcategory"] = chosen
        elif "other_subcategory" in enriched:
            del enriched["other_subcategory"]
        enriched["other_category_options"] = suggest_other_options(enriched["name"])
    else:
        enriched.pop("other_subcategory", None)
        enriched.pop("other_category_options", None)

    with get_db_conn() as conn:
        conn.execute(
            """
            INSERT INTO lobby_items (
                lobby_id, item_id, name, quantity, unit_price, cost,
                category, category_confidence, category_source, other_subcategory, other_category_options_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                lobby_id,
                enriched["id"],
                enriched["name"],
                float(enriched.get("quantity", 1)),
                float(enriched.get("unit_price", 0)),
                float(enriched.get("cost", 0)),
                enriched.get("category"),
                float(enriched.get("category_confidence", 0)),
                enriched.get("category_source"),
                enriched.get("other_subcategory"),
                json.dumps(enriched.get("other_category_options")) if enriched.get("other_category_options") else None,
            ),
        )
        conn.commit()

    return {"ok": True, "lobby_id": lobby_id, "item": enriched}


@app.get("/lobby/{lobby_id}/summary")
async def lobby_summary(lobby_id: str, lobby_passcode: str = Query(...), format: str = Query("full")):
    validate_lobby_passcode(lobby_id, lobby_passcode)
    summary = compute_lobby_summary(lobby_id)
    if format == "compact":
        return {
            "lobby_id": summary["lobby_id"],
            "lobby_name": summary["lobby_name"],
            "item_subtotal": summary.get("item_subtotal", 0.0),
            "extra_charges": summary.get("extra_charges", 0.0),
            "grand_total": summary["grand_total"],
            "claimed_total": summary["claimed_total"],
            "claimed_base_total": summary.get("claimed_base_total", 0.0),
            "unclaimed_total": summary["unclaimed_total"],
            "claim_progress_pct": summary.get("claim_progress_pct", 0.0),
            "unclaimed_item_total": summary.get("unclaimed_item_total", 0.0),
            "tax_breakdown": summary.get("tax_breakdown", []),
            "users": {
                uid: {
                    "user_name": v["user_name"],
                    "base_total": v.get("base_total", 0.0),
                    "extra_share": v.get("extra_share", 0.0),
                    "total": v["total"],
                }
                for uid, v in summary["users"].items()
            },
        }
    return summary


@app.get("/lobby/{lobby_id}")
async def lobby_state(lobby_id: str, lobby_passcode: str = Query(...)):
    validate_lobby_passcode(lobby_id, lobby_passcode)
    lobby = fetch_lobby(lobby_id)
    if not lobby:
        raise HTTPException(status_code=404, detail="Lobby not found")
    return {
        "lobby_id": lobby["id"],
        "lobby_name": lobby["name"],
        "host_user_id": lobby["host_user_id"],
        "receipt_image": lobby["receipt_image"],
        "receipt_totals": read_lobby_receipt_totals(lobby),
        "items": fetch_lobby_items(lobby_id),
        "participants": fetch_participants(lobby_id),
        "claims": fetch_claims(lobby_id),
        "summary": compute_lobby_summary(lobby_id),
    }


@app.get("/lobby/{lobby_id}/items")
async def lobby_items(lobby_id: str, lobby_passcode: str = Query(...)):
    validate_lobby_passcode(lobby_id, lobby_passcode)
    return {"lobby_id": lobby_id, "items": fetch_lobby_items(lobby_id)}


@app.post("/scan-bill")
async def scan_bill(
    file: UploadFile = File(...),
    include_debug: bool = Query(False),
    use_hybrid: bool = Query(True),
    force_fallback: bool = Query(False),
):
    try:
        image_data = await file.read()
        nparr = np.frombuffer(image_data, np.uint8)
        image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if image is None:
            return {"items": [], "error": "Invalid image"}
        items, needs_review, raw_lines = run_paddle_pipeline(image)
        source = "paddle"
        quality_score = compute_quality_score(items, needs_review)
        fallback_attempted = False
        fallback_error = None
        merged_from_gemini = 0

        should_try_fallback = use_hybrid and (
            force_fallback
            or len(items) < 2
            or quality_score < 0.52
            or len(needs_review) > max(3, len(items))
        )
        if should_try_fallback:
            fallback_attempted = True
            try:
                gemini = call_gemini_fallback(image_data)
                if gemini and gemini.get("items"):
                    gemini_items = gemini["items"]
                    gemini_needs_review = gemini.get("needs_review", [])
                    gemini_score = compute_quality_score(gemini_items, gemini_needs_review)
                    if gemini_score >= quality_score:
                        items = gemini_items
                        needs_review = gemini_needs_review
                        quality_score = gemini_score
                        source = "gemini_fallback"
                    elif source == "paddle":
                        before = len(items)
                        items = merge_unique_items(items, gemini_items)
                        merged_from_gemini = max(0, len(items) - before)
                        if merged_from_gemini > 0:
                            source = "hybrid_merged"
                            quality_score = compute_quality_score(items, needs_review)
            except Exception as ex:
                fallback_error = str(ex)

        computed_subtotal = round(sum(float(i.get("cost", 0)) for i in items), 2)
        detected = detect_bill_totals(raw_lines)
        detected_subtotal = detected.get("detected_subtotal")
        detected_grand_total = detected.get("detected_grand_total")
        if detected_subtotal is not None:
            if abs(computed_subtotal - detected_subtotal) > max(2.0, 0.02 * max(1.0, detected_subtotal)):
                needs_review.append(
                    {
                        "line": f"Subtotal mismatch: parsed={computed_subtotal}, detected={detected_subtotal}",
                        "reason": "subtotal_mismatch",
                    }
                )
        elif detected_grand_total is not None and computed_subtotal > detected_grand_total + 1:
            needs_review.append(
                {
                    "line": f"Parsed subtotal exceeds grand total: parsed={computed_subtotal}, grand={detected_grand_total}",
                    "reason": "total_sanity_check_failed",
                }
            )

        response = {
            "items": items,
            "needs_review": needs_review,
            "source": source,
            "totals": {
                "computed_subtotal": computed_subtotal,
                **detected,
            },
            "confidence_summary": {
                "quality_score": round(quality_score, 3),
                "item_count": len(items),
                "needs_review_count": len(needs_review),
                "fallback_attempted": fallback_attempted,
                "force_fallback": force_fallback,
                "gemini_configured": bool(GEMINI_API_KEY),
                "fallback_timeout_sec": GEMINI_TIMEOUT_SEC,
                "fallback_error": fallback_error,
                "merged_from_gemini": merged_from_gemini,
            },
        }
        if include_debug:
            response["debug"] = {"line_count": len(raw_lines), "lines": raw_lines}
        return response
    except Exception as e:
        return {"items": [], "needs_review": [], "error": str(e)}
