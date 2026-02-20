"use client";

import {
  AnimatePresence,
  type MotionValue,
  motion,
  useMotionValue,
  useScroll,
  useSpring,
  useTransform,
} from "framer-motion";
import Webcam from "react-webcam";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type TouchEvent as ReactTouchEvent } from "react";

type ScanItem = {
  id: string;
  name: string;
  quantity: number;
  unit_price: number;
  cost: number;
  category?: "veg" | "non_veg" | "drinks" | "other";
  category_source?: string | null;
  other_subcategory?: string | null;
  other_category_options?: string[] | null;
};

type ScanResponse = {
  items: ScanItem[];
  totals?: ReceiptTotals;
  needs_review?: Array<{ line: string; reason: string }>;
  confidence_summary?: {
    quality_score?: number;
    needs_review_count?: number;
  };
};
type JoinResponse = { user_id: string; user_name: string };
type CreateResponse = {
  lobby_id: string;
  items: ScanItem[];
  receipt_totals?: ReceiptTotals;
};

type TaxBreakdownRow = { name: string; amount: number };
type ReceiptTotals = {
  computed_subtotal?: number | null;
  detected_subtotal?: number | null;
  detected_grand_total?: number | null;
  detected_tax_total?: number | null;
  detected_service_charge?: number | null;
  detected_round_off?: number | null;
  detected_tax_breakdown?: TaxBreakdownRow[];
};

type LobbySummary = {
  item_subtotal?: number;
  extra_charges?: number;
  grand_total: number;
  claimed_total: number;
  claimed_base_total?: number;
  unclaimed_total: number;
  claim_progress_pct?: number;
  unclaimed_item_total?: number;
  tax_breakdown?: TaxBreakdownRow[];
  receipt_totals?: ReceiptTotals;
  users: Record<
    string,
    {
      user_name: string;
      base_total?: number;
      extra_share?: number;
      total: number;
      items: { item_id: string; quantity: number; amount: number }[];
    }
  >;
};

type LobbyState = {
  lobby_id: string;
  lobby_name: string;
  items: ScanItem[];
  participants: Record<string, string>;
  claims: Record<string, Record<string, number>>;
  summary: LobbySummary;
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:8000";
const NON_MENU_ITEM_NAME_RE =
  /\b(total|tota|subtotal|sub total|total amount|grand total|gr\.?\s*total|gross total|net amount|amount due|payable|bill total|bill amount|bil amount|round off|service charge|service tax|discount|gst|cgst|sgst|vat|tax)\b/i;
const DEFAULT_OTHER_OPTIONS = ["starter", "main_course", "bread", "rice", "dessert", "snack", "side"];

function asMoney(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : fallback;
}

function buildReviewDraft(items: ScanItem[], totals?: ReceiptTotals): {
  subtotal: string;
  tax: string;
  serviceCharge: string;
  roundOff: string;
  grandTotal: string;
} {
  const computedSubtotal = Number(items.reduce((acc, it) => acc + Number(it.cost || 0), 0).toFixed(2));
  const subtotal = asMoney(totals?.detected_subtotal ?? totals?.computed_subtotal ?? computedSubtotal, computedSubtotal);
  const tax = asMoney(totals?.detected_tax_total, 0);
  const serviceCharge = asMoney(totals?.detected_service_charge, 0);
  const detectedGrand = asMoney(totals?.detected_grand_total, 0);
  const grandTotal = detectedGrand > 0 ? detectedGrand : Number((subtotal + tax).toFixed(2));
  const inferredRound = Number((grandTotal - subtotal - tax).toFixed(2));
  const roundOff = asMoney(totals?.detected_round_off, inferredRound);
  return {
    subtotal: subtotal.toFixed(2),
    tax: tax.toFixed(2),
    serviceCharge: serviceCharge.toFixed(2),
    roundOff: roundOff.toFixed(2),
    grandTotal: grandTotal.toFixed(2),
  };
}

function shouldRequireTotalsReview(scanData: ScanResponse): boolean {
  const quality = Number(scanData?.confidence_summary?.quality_score ?? 1);
  const reviewCount = Number(scanData?.confidence_summary?.needs_review_count ?? scanData?.needs_review?.length ?? 0);
  const computedSubtotal = Number((scanData?.items || []).reduce((acc, it) => acc + Number(it?.cost || 0), 0).toFixed(2));
  const detectedSubtotal = asMoney(scanData?.totals?.detected_subtotal ?? scanData?.totals?.computed_subtotal, 0);
  const subtotal = asMoney(scanData?.totals?.detected_subtotal ?? scanData?.totals?.computed_subtotal, 0);
  const grand = asMoney(scanData?.totals?.detected_grand_total, 0);
  const totalMismatch = subtotal > 0 && grand > 0 && Math.abs(grand - subtotal) > Math.max(3, subtotal * 0.03);
  const itemMismatch = detectedSubtotal > 0 && Math.abs(detectedSubtotal - computedSubtotal) > Math.max(10, detectedSubtotal * 0.08);
  return quality < 0.7 || reviewCount > 2 || totalMismatch || itemMismatch;
}

function mergeItemsById(prev: ScanItem[], incoming: ScanItem[]): ScanItem[] {
  const map = new Map<string, ScanItem>();
  for (const item of prev || []) {
    if (item?.id) map.set(item.id, item);
  }
  for (const item of incoming || []) {
    if (item?.id) map.set(item.id, item);
  }
  const values = Array.from(map.values());
  values.sort((a, b) => {
    const an = Number(String(a.id || "").replace(/^itm_/, ""));
    const bn = Number(String(b.id || "").replace(/^itm_/, ""));
    if (Number.isFinite(an) && Number.isFinite(bn)) return bn - an; // newest first
    return String(b.id || "").localeCompare(String(a.id || ""));
  });
  return values;
}

function CategoryIcon({ category, claimed = false }: { category?: ScanItem["category"]; claimed?: boolean }) {
  const neon = claimed ? "drop-shadow-[0_0_8px_rgba(16,185,129,0.9)]" : "";
  if (category === "veg") {
    return (
      <svg viewBox="0 0 24 24" className={`h-4 w-4 ${neon}`} aria-hidden>
        <path d="M12 3C7.58 3 4 6.58 4 11s3.58 10 8 10 8-5.58 8-10-3.58-8-8-8Z" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.88" />
        <path d="M12 7a4 4 0 1 0 4 4 4 4 0 0 0-4-4Z" fill={claimed ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.4" />
      </svg>
    );
  }
  if (category === "non_veg") {
    return (
      <svg viewBox="0 0 24 24" className={`h-4 w-4 ${neon}`} aria-hidden>
        <path d="M5 13c0-5 4-9 9-9 2.4 0 4.8 1 6.5 2.7L19 8.2A6.7 6.7 0 0 0 14 6c-3.9 0-7 3.1-7 7 0 2.2 1 4.2 2.7 5.5l-1.5 1.5A8.95 8.95 0 0 1 5 13Z" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="14.7" cy="8.3" r="1.6" fill={claimed ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.2" />
      </svg>
    );
  }
  if (category === "drinks") {
    return (
      <svg viewBox="0 0 24 24" className={`h-4 w-4 ${neon}`} aria-hidden>
        <path d="M7 3h10l-1 8a4 4 0 0 1-4 3.5v5.5h3v2H9v-2h3v-5.5A4 4 0 0 1 8 11L7 3Z" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M9.2 5h5.6l-.7 5.5c-.1.9-.9 1.5-1.8 1.5h-.6c-.9 0-1.7-.6-1.8-1.5L9.2 5Z" fill={claimed ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.3" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className={`h-4 w-4 ${neon}`} aria-hidden>
      <path d="M12 2 2 7l10 5 10-5-10-5Z" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="m4 13.5 8 4 8-4v3.3l-8 4-8-4v-3.3Z" fill={claimed ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function categoryClass(category?: ScanItem["category"]): string {
  if (category === "veg") return "category-chip category-veg";
  if (category === "non_veg") return "category-chip category-nonveg";
  if (category === "drinks") return "category-chip category-drinks";
  return "category-chip category-other";
}

function NumberTicker({ value }: { value: number }) {
  const [display, setDisplay] = useState(value);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const from = display;
    const to = value;
    const duration = 400;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(from + (to - from) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return <span className="font-price">Rs {display.toFixed(2)}</span>;
}

async function resizeDataUrlToBlob(dataUrl: string, maxWidth = 1280): Promise<Blob> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("Image decode failed"));
    i.src = dataUrl;
  });
  if (img.width <= maxWidth) return await (await fetch(dataUrl)).blob();
  const scale = maxWidth / img.width;
  const canvas = document.createElement("canvas");
  canvas.width = maxWidth;
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not available");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.9)
  );
  if (!blob) throw new Error("Image compression failed");
  return blob;
}

async function fileToDataUrl(file: File): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read uploaded file"));
    reader.readAsDataURL(file);
  });
}

function FloatingBlobs({
  parallaxX,
  parallaxY,
}: {
  parallaxX: MotionValue<number>;
  parallaxY: MotionValue<number>;
}) {
  const driftAX = useTransform(parallaxX, [-24, 24], [-16, 16]);
  const driftAY = useTransform(parallaxY, [-24, 24], [-10, 10]);
  const driftBX = useTransform(parallaxX, [-24, 24], [18, -18]);
  const driftBY = useTransform(parallaxY, [-24, 24], [12, -12]);
  const driftCX = useTransform(parallaxX, [-24, 24], [-12, 12]);
  const driftCY = useTransform(parallaxY, [-24, 24], [9, -9]);
  return (
    <div className="blob-bg" aria-hidden>
      <motion.div
        className="absolute -left-24 top-8 h-80 w-80 animate-pulse rounded-full bg-amber-400/20 blur-3xl"
        style={{ x: driftAX, y: driftAY }}
        animate={{ x: [0, 60, -20, 0], y: [0, 30, 70, 0], scale: [1, 1.12, 0.96, 1] }}
        transition={{ duration: 18, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute right-8 top-20 h-96 w-96 animate-pulse rounded-full bg-rose-400/20 blur-3xl"
        style={{ x: driftBX, y: driftBY }}
        animate={{ x: [0, -50, 25, 0], y: [0, 40, -10, 0], scale: [1, 0.94, 1.08, 1] }}
        transition={{ duration: 20, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute bottom-12 left-1/3 h-72 w-72 animate-pulse rounded-full bg-amber-300/15 blur-3xl"
        style={{ x: driftCX, y: driftCY }}
        animate={{ x: [0, 45, -30, 0], y: [0, -25, 20, 0], scale: [1, 1.08, 0.9, 1] }}
        transition={{ duration: 22, repeat: Infinity, ease: "easeInOut" }}
      />
    </div>
  );
}

function MagneticCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const rx = useSpring(useTransform(my, [-45, 45], [6, -6]), { stiffness: 140, damping: 14 });
  const ry = useSpring(useTransform(mx, [-45, 45], [-6, 6]), { stiffness: 140, damping: 14 });
  const tx = useSpring(mx, { stiffness: 120, damping: 13 });
  const ty = useSpring(my, { stiffness: 120, damping: 13 });

  return (
    <motion.div
      className={className}
      style={{ rotateX: rx, rotateY: ry, x: tx, y: ty, transformStyle: "preserve-3d" }}
      onMouseMove={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        mx.set((e.clientX - (r.left + r.width / 2)) * 0.12);
        my.set((e.clientY - (r.top + r.height / 2)) * 0.12);
      }}
      onMouseLeave={() => {
        mx.set(0);
        my.set(0);
      }}
      onPointerMove={(e) => {
        if (e.pointerType !== "touch") return;
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        mx.set((e.clientX - (r.left + r.width / 2)) * 0.08);
        my.set((e.clientY - (r.top + r.height / 2)) * 0.08);
      }}
      onPointerUp={() => {
        mx.set(0);
        my.set(0);
      }}
    >
      {children}
    </motion.div>
  );
}

function MagneticButton({
  children,
  className = "",
  onClick,
  disabled,
  type = "button",
  title,
}: {
  children: ReactNode;
  className?: string;
  onClick?: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  title?: string;
}) {
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const sx = useSpring(mx, { stiffness: 220, damping: 18 });
  const sy = useSpring(my, { stiffness: 220, damping: 18 });
  const [pulseTick, setPulseTick] = useState(0);
  return (
    <motion.button
      type={type}
      title={title}
      disabled={disabled}
      className={className}
      style={{ x: sx, y: sy }}
      whileTap={{ scale: 0.95 }}
      animate={{ scale: pulseTick > 0 ? [1, 0.95, 1.05, 1] : 1 }}
      transition={{ duration: 0.28 }}
      onMouseMove={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        mx.set((e.clientX - (r.left + r.width / 2)) * 0.08);
        my.set((e.clientY - (r.top + r.height / 2)) * 0.08);
      }}
      onMouseLeave={() => {
        mx.set(0);
        my.set(0);
      }}
      onClick={(e) => {
        setPulseTick((v) => v + 1);
        onClick?.(e);
      }}
    >
      {children}
    </motion.button>
  );
}

function WheelItem({ index, children }: { index: number; children: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: "easeOut", delay: Math.min(index * 0.015, 0.12) }}
      className=""
    >
      {children}
    </motion.div>
  );
}

function resolveItemCost(qtyRaw: string | number, unitRaw: string | number, costRaw: string | number): number {
  const qty = Number(qtyRaw);
  const unit = Number(unitRaw);
  const explicitCost = Number(costRaw);
  if (Number.isFinite(qty) && Number.isFinite(unit) && qty > 0 && unit > 0) {
    return Number((qty * unit).toFixed(2));
  }
  if (Number.isFinite(explicitCost) && explicitCost > 0) {
    return Number(explicitCost.toFixed(2));
  }
  return 0;
}

function LiquidWaveCircle({ percent }: { percent: number }) {
  const safe = Math.max(0, Math.min(100, percent));
  const cx = 102;
  const cy = 102;
  const r = 72;
  const circumference = 2 * Math.PI * r;
  const strokeLen = (safe / 100) * circumference;
  const dashOffset = circumference - strokeLen;
  const theta = ((safe / 100) * 360 - 90) * (Math.PI / 180);
  const cometX = cx + r * Math.cos(theta);
  const cometY = cy + r * Math.sin(theta);
  const pulseStrength = 6 + safe * 0.08;
  return (
    <div className="relative mx-auto h-40 w-40">
      <svg viewBox="0 0 204 204" className="h-full w-full">
        <defs>
          <linearGradient id="gourmetRing" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#f43f5e" stopOpacity="0.92" />
          </linearGradient>
          <filter id="cometGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.4" result="blurred" />
            <feMerge>
              <feMergeNode in="blurred" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <circle cx={cx} cy={cy} r={88} fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.2)" />
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="12" />
        <motion.circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="url(#gourmetRing)"
          strokeWidth="12"
          strokeLinecap="round"
          transform={`rotate(-90 ${cx} ${cy})`}
          strokeDasharray={circumference}
          animate={{ strokeDashoffset: dashOffset }}
          transition={{ duration: 0.7, ease: [0.37, 0, 0.63, 1] }}
          style={{ filter: "drop-shadow(0 0 10px rgba(245,158,11,0.35))" }}
        />
        <motion.circle
          cx={cometX}
          cy={cometY}
          r="3.6"
          fill="white"
          filter="url(#cometGlow)"
          animate={{ r: [3.2, 4.2, 3.2], opacity: [0.9, 1, 0.9] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
        />
      </svg>
      <motion.div
        className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"
        animate={{
          textShadow: [
            `0 0 ${Math.max(2, pulseStrength - 2)}px rgba(245,158,11,0.25)`,
            `0 0 ${pulseStrength}px rgba(245,158,11,0.52)`,
            `0 0 ${Math.max(2, pulseStrength - 2)}px rgba(245,158,11,0.25)`,
          ],
        }}
        transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
      >
        <span className="text-xs text-stone-300">Claimed</span>
        <span className="font-price text-2xl font-bold text-amber-200">{safe.toFixed(0)}%</span>
      </motion.div>
    </div>
  );
}

export default function Page() {
  const webcamRef = useRef<Webcam>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<"scanner" | "lobby">("scanner");
  const [lobbyName, setLobbyName] = useState("Demo Dinner");
  const [passcode, setPasscode] = useState("1234");
  const [userName, setUserName] = useState("Shashank");
  const [lobbyId, setLobbyId] = useState("");
  const [userId, setUserId] = useState("");
  const [items, setItems] = useState<ScanItem[]>([]);
  const [summary, setSummary] = useState<LobbySummary | null>(null);
  const [status, setStatus] = useState("Ready");
  const [busy, setBusy] = useState(false);
  const [billImage, setBillImage] = useState<string | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string>("");
  const [cameraFacing, setCameraFacing] = useState<"environment" | "user">("user");
  const [cameraDevices, setCameraDevices] = useState<Array<{ id: string; label: string }>>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string>("");
  const [isBillViewerOpen, setIsBillViewerOpen] = useState(false);
  const [isTotalModalOpen, setIsTotalModalOpen] = useState(false);
  const [billZoom, setBillZoom] = useState(1);
  const [successItemId, setSuccessItemId] = useState<string | null>(null);
  const [liveBeat, setLiveBeat] = useState(false);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const [showAddItem, setShowAddItem] = useState(false);
  const [lastAddedItemId, setLastAddedItemId] = useState<string>("");
  const [hoveredItemId, setHoveredItemId] = useState<string>("");
  const [pullDistance, setPullDistance] = useState(0);
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const [scanReview, setScanReview] = useState<{
    previewDataUrl: string;
    items: ScanItem[];
    totals?: ReceiptTotals;
    qualityScore: number;
    needsReviewCount: number;
  } | null>(null);
  const [claimConfirm, setClaimConfirm] = useState<{
    item: ScanItem;
    quantity: number;
    label: string;
  } | null>(null);
  const [reviewDraft, setReviewDraft] = useState<{
    subtotal: string;
    tax: string;
    serviceCharge: string;
    roundOff: string;
    grandTotal: string;
  }>({
    subtotal: "0.00",
    tax: "0.00",
    serviceCharge: "0.00",
    roundOff: "0.00",
    grandTotal: "0.00",
  });
  const [addDraft, setAddDraft] = useState({
    name: "",
    quantity: "1",
    unit_price: "0",
    cost: "0",
    category: "other",
    other_subcategory: "",
  });
  const [editDraft, setEditDraft] = useState<{
    name: string;
    quantity: string;
    unit_price: string;
    cost: string;
    category: string;
    other_subcategory: string;
    other_options: string[];
  } | null>(null);
  const parallaxX = useMotionValue(0);
  const parallaxY = useMotionValue(0);
  const pullStartYRef = useRef<number | null>(null);
  const pullActiveRef = useRef(false);

  const claimsByItem = useMemo(() => {
    const map: Record<string, { total: number; mine: number; others: Array<{ id: string; name: string }> }> = {};
    if (!summary) return map;
    for (const [uid, u] of Object.entries(summary.users || {})) {
      for (const row of u.items || []) {
        if (!map[row.item_id]) map[row.item_id] = { total: 0, mine: 0, others: [] };
        map[row.item_id].total += Number(row.quantity || 0);
        if (uid === userId) map[row.item_id].mine += Number(row.quantity || 0);
        else if (!map[row.item_id].others.some((x) => x.id === uid)) map[row.item_id].others.push({ id: uid, name: u.user_name });
      }
    }
    return map;
  }, [summary, userId]);

  const myTotal = useMemo(() => {
    if (!summary || !userId) return 0;
    return Number(summary.users?.[userId]?.total || 0);
  }, [summary, userId]);
  const myExtraShare = useMemo(() => Number(summary?.users?.[userId]?.extra_share || 0), [summary, userId]);
  const canHostManage = Boolean(userId);

  const visibleItems = useMemo(() => {
    const sorted = [...items];
    sorted.sort((a, b) => {
      const an = Number(String(a.id || "").replace(/^itm_/, ""));
      const bn = Number(String(b.id || "").replace(/^itm_/, ""));
      if (Number.isFinite(an) && Number.isFinite(bn)) return bn - an;
      return String(b.id || "").localeCompare(String(a.id || ""));
    });
    return sorted;
  }, [items]);
  const { scrollY } = useScroll();
  const bubbleY = useTransform(scrollY, [0, 900], [0, -26]);

  const myClaimedItems = useMemo(() => {
    if (!summary || !userId) return [];
    return summary.users?.[userId]?.items || [];
  }, [summary, userId]);
  const recentManualItems = useMemo(() => {
    const list = items.filter((it) => String(it.category_source || "") === "user_selected");
    list.sort((a, b) => {
      const an = Number(String(a.id || "").replace(/^itm_/, ""));
      const bn = Number(String(b.id || "").replace(/^itm_/, ""));
      if (Number.isFinite(an) && Number.isFinite(bn)) return bn - an;
      return 0;
    });
    return list.slice(0, 5);
  }, [items]);
  const claimedPercent = useMemo(() => {
    const serverPct = Number(summary?.claim_progress_pct ?? NaN);
    if (Number.isFinite(serverPct) && serverPct >= 0 && items.length === 0) return Math.min(100, serverPct);
    const base = Number(
      items.reduce((acc, it) => acc + Number(it?.quantity || 0) * Number(it?.unit_price || 0), 0) ||
      summary?.item_subtotal ||
      summary?.grand_total ||
      0
    );
    const claimed = Number(summary?.claimed_total || 0);
    if (base <= 0) return 0;
    return Math.min(100, (claimed / base) * 100);
  }, [summary, items]);
  const uiItemSubtotal = useMemo(
    () =>
      Number(
        items
          .reduce((acc, it) => acc + Number(it?.quantity || 0) * Number(it?.unit_price || 0), 0)
          .toFixed(2)
      ),
    [items]
  );
  const uiExtraCharges = useMemo(() => Number(summary?.extra_charges || 0), [summary]);
  const uiGrandTotal = useMemo(() => Number((uiItemSubtotal + uiExtraCharges).toFixed(2)), [uiItemSubtotal, uiExtraCharges]);
  const hoveredItem = useMemo(() => visibleItems.find((it) => it.id === hoveredItemId) || null, [visibleItems, hoveredItemId]);

  const joinUrl = useMemo(() => {
    if (!lobbyId) return "";
    if (typeof window === "undefined") return "";
    return `${window.location.origin}/join?lobby_id=${encodeURIComponent(lobbyId)}&passcode=${encodeURIComponent(passcode)}`;
  }, [lobbyId, passcode]);

  const joinQrUrl = useMemo(() => {
    if (!joinUrl) return "";
    return `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(joinUrl)}`;
  }, [joinUrl]);

  async function createLobbyFromScan(previewDataUrl: string, filteredItems: ScanItem[], receiptTotals?: ReceiptTotals) {
    const createRes = await fetch(`${API_BASE}/lobby/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lobby_name: lobbyName,
        lobby_passcode: passcode,
        items: filteredItems,
        receipt_image: previewDataUrl,
        receipt_totals: receiptTotals || null,
      }),
    });
    const createData = (await createRes.json()) as CreateResponse;
    if (!createRes.ok) throw new Error("Create lobby failed");

    const joinRes = await fetch(`${API_BASE}/lobby/${createData.lobby_id}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_name: userName, lobby_passcode: passcode }),
    });
    const joinData = (await joinRes.json()) as JoinResponse;
    if (!joinRes.ok) throw new Error("Join lobby failed");

    setLobbyId(createData.lobby_id);
    setUserId(joinData.user_id);
    setItems((prev) => mergeItemsById(prev, createData.items || []));
    setStep("lobby");
    setStatus(`Lobby ${createData.lobby_id} ready`);
    await fetchLobbyState(createData.lobby_id);
  }

  async function loadCameraDevices() {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      const all = await navigator.mediaDevices.enumerateDevices();
      const cams = all
        .filter((d) => d.kind === "videoinput")
        .map((d, i) => ({
          id: d.deviceId,
          label: d.label || `Camera ${i + 1}`,
        }));
      const preferred = cams.find(
        (c) => !/virtual|obs|droidcam|epoccam|ivcam/i.test(c.label)
      );
      setCameraDevices(cams);
      if (!selectedCameraId && cams.length > 0) {
        setSelectedCameraId((preferred || cams[0]).id);
      }
    } catch {
      // ignore device listing errors
    }
  }

  useEffect(() => {
    loadCameraDevices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      parallaxX.set(((e.clientX - cx) / cx) * 24);
      parallaxY.set(((e.clientY - cy) / cy) * 24);
    };
    const onTilt = (e: DeviceOrientationEvent) => {
      if (typeof e.gamma !== "number" || typeof e.beta !== "number") return;
      const gamma = Math.max(-25, Math.min(25, e.gamma));
      const beta = Math.max(-25, Math.min(25, e.beta - 35));
      parallaxX.set(gamma * 0.96);
      parallaxY.set(beta * 0.56);
    };
    const onLeave = () => {
      parallaxX.set(0);
      parallaxY.set(0);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("deviceorientation", onTilt);
    window.addEventListener("mouseleave", onLeave);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("deviceorientation", onTilt);
      window.removeEventListener("mouseleave", onLeave);
    };
  }, [parallaxX, parallaxY]);

  async function fetchLobbyState(forLobbyId?: string) {
    const id = forLobbyId || lobbyId;
    if (!id) return;
    const ts = Date.now();
    const [itemsRes, summaryRes] = await Promise.all([
      fetch(`${API_BASE}/lobby/${id}/items?lobby_passcode=${encodeURIComponent(passcode)}&t=${ts}`, {
        cache: "no-store",
      }),
      fetch(`${API_BASE}/lobby/${id}/summary?lobby_passcode=${encodeURIComponent(passcode)}&t=${ts}`, {
        cache: "no-store",
      }),
    ]);

    if (!itemsRes.ok || !summaryRes.ok) {
      let detail = "Failed to sync lobby";
      try {
        const err = await (itemsRes.ok ? summaryRes : itemsRes).json();
        detail = err.detail || detail;
      } catch {
        // ignore parse error
      }
      setStatus(detail);
      return;
    }

    const itemsData = await itemsRes.json();
    const summaryData = (await summaryRes.json()) as LobbySummary;
    const incomingItems = Array.isArray(itemsData.items) ? (itemsData.items as ScanItem[]) : [];
    setItems((prev) => mergeItemsById(prev, incomingItems));
    setSummary(summaryData || null);
    setLiveBeat(true);
    setTimeout(() => setLiveBeat(false), 650);
  }

  useEffect(() => {
    if (step !== "lobby" || !lobbyId) return;
    fetchLobbyState();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") {
        fetchLobbyState();
      }
    }, 2500);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        fetchLobbyState();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, lobbyId, passcode]);

  async function runScanFlow(previewDataUrl: string) {
    setBillImage(previewDataUrl);
    setBusy(true);
    setStatus("Resizing image...");
    try {
      const resizedBlob = await resizeDataUrlToBlob(previewDataUrl, 1280);
      const fd = new FormData();
      fd.append("file", resizedBlob, "scan.jpg");
      setStatus("Scanning...");
      const scanRes = await fetch(`${API_BASE}/scan-bill?use_hybrid=true`, { method: "POST", body: fd });
      const scanData = (await scanRes.json()) as ScanResponse;
      const filteredItems = (scanData.items || []).filter(
        (it) => !NON_MENU_ITEM_NAME_RE.test(String(it.name || ""))
      );
      if (!scanRes.ok || !filteredItems.length) throw new Error("No items detected");
      if (shouldRequireTotalsReview(scanData)) {
        const qualityScore = Number(scanData.confidence_summary?.quality_score ?? 0);
        const needsReviewCount = Number(scanData.confidence_summary?.needs_review_count ?? scanData.needs_review?.length ?? 0);
        setScanReview({
          previewDataUrl,
          items: filteredItems,
          totals: scanData.totals,
          qualityScore,
          needsReviewCount,
        });
        setReviewDraft(buildReviewDraft(filteredItems, scanData.totals));
        setStatus("Review totals before creating lobby");
        return;
      }

      await createLobbyFromScan(previewDataUrl, filteredItems, scanData.totals);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Flow failed");
    } finally {
      setBusy(false);
    }
  }

  async function onUploadSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await fileToDataUrl(file);
      await runScanFlow(dataUrl);
    } finally {
      if (uploadRef.current) uploadRef.current.value = "";
    }
  }

  async function scanAndCreateLobby() {
    const shot = webcamRef.current?.getScreenshot();
    if (!shot) return setStatus("Camera capture failed");
    await runScanFlow(shot);
  }

  function backToScanner() {
    setStep("scanner");
    setItems([]);
    setSummary(null);
    setScanReview(null);
    setEditingItemId(null);
    setEditDraft(null);
    setSuccessItemId(null);
    setCameraError("");
    setStatus("Ready");
  }

  async function confirmTotalsAndCreateLobby() {
    if (!scanReview) return;
    const subtotal = asMoney(reviewDraft.subtotal, 0);
    const tax = asMoney(reviewDraft.tax, 0);
    const serviceCharge = asMoney(reviewDraft.serviceCharge, 0);
    const roundOff = asMoney(reviewDraft.roundOff, 0);
    const grandTotal = asMoney(reviewDraft.grandTotal, 0);
    const draftTotals: ReceiptTotals = {
      computed_subtotal: Number(scanReview.items.reduce((acc, it) => acc + Number(it.cost || 0), 0).toFixed(2)),
      detected_subtotal: subtotal,
      detected_tax_total: tax,
      detected_service_charge: serviceCharge,
      detected_round_off: roundOff,
      detected_grand_total: grandTotal,
      detected_tax_breakdown: scanReview.totals?.detected_tax_breakdown || [],
    };
    setBusy(true);
    try {
      await createLobbyFromScan(scanReview.previewDataUrl, scanReview.items, draftTotals);
      setScanReview(null);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Create lobby failed");
    } finally {
      setBusy(false);
    }
  }

  function openBillViewer() {
    if (!billImage) return;
    setBillZoom(1);
    setIsBillViewerOpen(true);
  }

  function adjustBillZoom(delta: number) {
    setBillZoom((z) => Math.max(1, Math.min(4, Number((z + delta).toFixed(2)))));
  }

  function toggleCameraFacing() {
    setCameraReady(false);
    setCameraError("");
    setSelectedCameraId("");
    setCameraFacing((prev) => (prev === "user" ? "environment" : "user"));
    setStatus("Switching camera...");
  }

  async function addMissingItem() {
    if (!lobbyId || !userId) return;
    const qty = Number(addDraft.quantity);
    const unit = Number(addDraft.unit_price);
    const cost = resolveItemCost(addDraft.quantity, addDraft.unit_price, addDraft.cost);
    if (!addDraft.name.trim() || !(Number.isFinite(qty) && qty > 0) || cost <= 0) {
      setStatus("Enter valid name, quantity, and price/cost");
      return;
    }
    const res = await fetch(`${API_BASE}/lobby/${lobbyId}/item-add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lobby_passcode: passcode,
        actor_user_id: userId,
        name: addDraft.name,
        quantity: qty,
        unit_price: unit,
        cost,
        category: addDraft.category,
        other_subcategory: addDraft.category === "other" ? (addDraft.other_subcategory || null) : null,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setStatus(err.detail || "Add item failed");
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (data?.item?.id) {
      setLastAddedItemId(data.item.id);
      setItems((prev) => {
        const without = prev.filter((it) => it.id !== data.item.id);
        return [data.item, ...without];
      });
      setStatus(`Missing item added: ${data.item.name}`);
    }
    setShowAddItem(false);
    setAddDraft({
      name: "",
      quantity: "1",
      unit_price: "0",
      cost: "0",
      category: "other",
      other_subcategory: "",
    });
    await fetchLobbyState();
  }

  useEffect(() => {
    if (!lastAddedItemId) return;
    const t = window.setTimeout(() => {
      const el = document.getElementById(`item-card-${lastAddedItemId}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 180);
    return () => window.clearTimeout(t);
  }, [lastAddedItemId, items]);

  async function claimItem(item: ScanItem) {
    if (!lobbyId || !userId) return;
    const now = claimsByItem[item.id] || { total: 0, mine: 0, others: [] };
    const next = now.mine >= item.quantity ? 0 : Math.min(now.mine + 1, item.quantity);
    const label = next === 0 ? "unclaim" : `claim ${next}`;
    setClaimConfirm({ item, quantity: next, label });
  }

  async function confirmClaimAction() {
    if (!claimConfirm || !lobbyId || !userId) return;
    const { item, quantity } = claimConfirm;
    setClaimConfirm(null);
    if ("vibrate" in navigator) navigator.vibrate(10);
    const res = await fetch(`${API_BASE}/claim-item`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lobby_id: lobbyId,
        user_id: userId,
        item_id: item.id,
        quantity,
        lobby_passcode: passcode,
      }),
    });
    if (!res.ok) {
      setStatus("Claim failed");
      return;
    }
    setSuccessItemId(item.id);
    setTimeout(() => setSuccessItemId(null), 900);
    setStatus(`Claim updated for ${item.name}`);
    await fetchLobbyState();
  }

  async function copyJoinLink() {
    if (!joinUrl) return;
    try {
      await navigator.clipboard.writeText(joinUrl);
      setShareCopied(true);
      setStatus("Join link copied");
      setTimeout(() => setShareCopied(false), 1400);
    } catch {
      setStatus("Could not copy link");
    }
  }

  function startEdit(item: ScanItem) {
    setEditingItemId(item.id);
    const otherOptions =
      Array.isArray(item.other_category_options) && item.other_category_options.length > 0
        ? item.other_category_options
        : DEFAULT_OTHER_OPTIONS;
    setEditDraft({
      name: item.name,
      quantity: String(item.quantity),
      unit_price: String(item.unit_price),
      cost: String(item.cost),
      category: item.category || "other",
      other_subcategory: item.other_subcategory || "",
      other_options: otherOptions,
    });
  }

  async function saveEdit(itemId: string) {
    if (!editDraft || !lobbyId || !canHostManage) return;
    const qty = Number(editDraft.quantity);
    const unit = Number(editDraft.unit_price);
    const computedCost = resolveItemCost(editDraft.quantity, editDraft.unit_price, editDraft.cost);
    const res = await fetch(`${API_BASE}/lobby/${lobbyId}/item-update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        item_id: itemId,
        lobby_passcode: passcode,
        actor_user_id: userId,
        name: editDraft.name,
        quantity: qty,
        unit_price: unit,
        cost: computedCost,
        category: editDraft.category,
        other_subcategory: editDraft.category === "other" ? (editDraft.other_subcategory || null) : null,
      }),
    });
    if (!res.ok) {
      const e = await res.json();
      setStatus(e.detail || "Edit failed");
      return;
    }
    setEditingItemId(null);
    setEditDraft(null);
    setStatus("Item updated");
    await fetchLobbyState();
  }

  async function resetClaim(itemId: string, resetUserId?: string) {
    if (!lobbyId || !canHostManage) return;
    if (!window.confirm(resetUserId ? "Reset this user claim?" : "Reset all claims for this item?")) return;
    await fetch(`${API_BASE}/lobby/${lobbyId}/claim-reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        item_id: itemId,
        user_id: resetUserId || null,
        lobby_passcode: passcode,
        actor_user_id: userId,
      }),
    });
    await fetchLobbyState();
  }

  function onMainTouchStart(e: ReactTouchEvent<HTMLElement>) {
    if (step !== "lobby" || pullRefreshing) return;
    if (window.scrollY > 8) return;
    pullStartYRef.current = e.touches[0]?.clientY ?? null;
    pullActiveRef.current = true;
  }

  function onMainTouchMove(e: ReactTouchEvent<HTMLElement>) {
    if (step !== "lobby" || pullRefreshing || !pullActiveRef.current || pullStartYRef.current == null) return;
    const delta = (e.touches[0]?.clientY ?? 0) - pullStartYRef.current;
    if (delta <= 0) {
      setPullDistance(0);
      return;
    }
    const damped = Math.min(120, delta * 0.45);
    setPullDistance(damped);
  }

  async function onMainTouchEnd() {
    if (step !== "lobby") return;
    pullActiveRef.current = false;
    pullStartYRef.current = null;
    if (pullDistance > 80 && !pullRefreshing) {
      setPullRefreshing(true);
      setStatus("Refreshing lobby...");
      await fetchLobbyState();
      setPullRefreshing(false);
    }
    setPullDistance(0);
  }

  function renderItemCard(item: ScanItem) {
    const claim = claimsByItem[item.id] || { total: 0, mine: 0, others: [] };
    const blockedByOthers = claim.total >= item.quantity && claim.mine <= 0;
    const mineClaimed = claim.mine > 0;
    const mineRatio = Math.max(0, Math.min(1, Number(item.quantity) > 0 ? claim.mine / Number(item.quantity) : 0));
    return (
      <MagneticCard className="break-inside-avoid">
        <motion.div
          id={`item-card-${item.id}`}
          initial={false}
          animate={successItemId === item.id ? { scale: [1, 1.03, 1] } : { scale: 1 }}
          style={{ opacity: 1 }}
          className={`plate-card aurora-border relative overflow-hidden p-3 ${
            blockedByOthers ? "opacity-55" : ""
          } ${(successItemId === item.id || lastAddedItemId === item.id) ? "ring-1 ring-amber-300/60" : ""}`}
          onMouseEnter={() => setHoveredItemId(item.id)}
          onMouseLeave={() => setHoveredItemId((prev) => (prev === item.id ? "" : prev))}
        >
          <motion.div
            layoutId={`claim-fill-${item.id}`}
            className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-emerald-400/25 to-transparent"
            initial={false}
            animate={{ height: `${mineRatio * 100}%` }}
            transition={{ duration: 0.42, ease: "easeOut" }}
          />
          <div className="relative mb-1 flex items-center justify-between gap-2">
            <p className="font-item truncate text-base font-extrabold text-slate-100">{item.name}</p>
            <span className={`${categoryClass(item.category)} h-7 w-7 justify-center rounded-full p-0`}>
              <CategoryIcon category={item.category} claimed={mineClaimed} />
              <span className="sr-only">{item.category || "other"}</span>
            </span>
          </div>
          <div className="relative flex items-center justify-between text-xs text-slate-400">
            <span className="font-light">Qty {item.quantity}</span>
            <span className="font-price text-slate-200">Rs {item.cost}</span>
          </div>
          <div className="relative mt-1 flex items-center justify-between text-xs text-amber-200">
            <span>You {claim.mine}/{item.quantity}</span>
            {mineClaimed && (
              <motion.span
                layoutId={`claim-chip-${item.id}`}
                className="rounded-full border border-emerald-300/40 bg-emerald-500/20 px-2 py-0.5 text-[10px] text-emerald-100"
              >
                {claim.mine}x claimed
              </motion.span>
            )}
          </div>

          <div className="relative mt-2 flex flex-wrap gap-2">
            <MagneticButton onClick={() => claimItem(item)} className="btn-primary w-full py-2 text-sm md:w-auto">
              {claim.mine > 0 ? "Update / Unclaim" : "Claim"}
            </MagneticButton>
            {canHostManage && (
              <>
                <MagneticButton onClick={() => startEdit(item)} className="btn-secondary w-full py-2 text-sm md:w-auto">
                  Edit
                </MagneticButton>
                {claim.total > 0 && (
                  <MagneticButton onClick={() => resetClaim(item.id)} className="rounded-2xl bg-rose-500/80 px-4 py-2 text-sm font-semibold text-white">
                    Reset Claims
                  </MagneticButton>
                )}
              </>
            )}
          </div>

          {canHostManage && claim.others.length > 0 && (
            <div className="relative mt-2 flex flex-wrap gap-2">
              {claim.others.map((entry) => (
                <MagneticButton
                  key={entry.id}
                  onClick={() => resetClaim(item.id, entry.id)}
                  className="rounded-full border border-rose-400/40 bg-rose-500/10 px-2 py-1 text-[10px] font-semibold text-rose-300"
                >
                  Reset {entry.name}
                </MagneticButton>
              ))}
            </div>
          )}

          {editingItemId === item.id && editDraft && (
            <div className="relative mt-3 grid grid-cols-2 gap-2 rounded-xl border border-white/10 bg-slate-950/70 p-2">
              <input className="field-input col-span-2" value={editDraft.name} onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })} />
              <input
                className="field-input"
                value={editDraft.quantity}
                onChange={(e) => {
                  const nextQty = e.target.value;
                  const q = Number(nextQty);
                  const u = Number(editDraft.unit_price);
                  const nextCost =
                    Number.isFinite(q) && Number.isFinite(u) && q > 0
                      ? String(Number((q * u).toFixed(2)))
                      : editDraft.cost;
                  setEditDraft({ ...editDraft, quantity: nextQty, cost: nextCost });
                }}
              />
              <input
                className="field-input"
                value={editDraft.unit_price}
                onChange={(e) => {
                  const nextUnit = e.target.value;
                  const q = Number(editDraft.quantity);
                  const u = Number(nextUnit);
                  const nextCost =
                    Number.isFinite(q) && Number.isFinite(u) && q > 0
                      ? String(Number((q * u).toFixed(2)))
                      : editDraft.cost;
                  setEditDraft({ ...editDraft, unit_price: nextUnit, cost: nextCost });
                }}
              />
              <input className="field-input" value={editDraft.cost} onChange={(e) => setEditDraft({ ...editDraft, cost: e.target.value })} />
              <select className="field-input" value={editDraft.category} onChange={(e) => setEditDraft({ ...editDraft, category: e.target.value })}>
                <option value="veg">veg</option>
                <option value="non_veg">non_veg</option>
                <option value="drinks">drinks</option>
                <option value="other">other</option>
              </select>
              {editDraft.category === "other" && (
                <select
                  className="field-input"
                  value={editDraft.other_subcategory}
                  onChange={(e) => setEditDraft({ ...editDraft, other_subcategory: e.target.value })}
                >
                  <option value="">choose other type</option>
                  {editDraft.other_options.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              )}
              <MagneticButton className="btn-primary text-xs" onClick={() => saveEdit(item.id)}>Save</MagneticButton>
              <MagneticButton className="btn-secondary text-xs" onClick={() => { setEditingItemId(null); setEditDraft(null); }}>Cancel</MagneticButton>
            </div>
          )}
          <AnimatePresence>
            {successItemId === item.id && (
              <motion.div
                className="pointer-events-none absolute inset-0 overflow-hidden"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                {Array.from({ length: 12 }).map((_, i) => (
                  <motion.span
                    key={i}
                    className="absolute h-1.5 w-1.5 rounded-full bg-amber-300"
                    style={{
                      left: `${30 + (i % 6) * 8}%`,
                      top: "58%",
                    }}
                    initial={{ y: 0, x: 0, opacity: 1, scale: 1 }}
                    animate={{
                      y: -40 - (i % 5) * 8,
                      x: (i % 2 === 0 ? 1 : -1) * (10 + (i % 4) * 6),
                      opacity: 0,
                      scale: 0.2,
                    }}
                    transition={{ duration: 0.65, ease: "easeOut" }}
                  />
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </MagneticCard>
    );
  }

  return (
    <main
      className="relative mx-auto max-w-7xl p-4 md:p-6"
      onTouchStart={onMainTouchStart}
      onTouchMove={onMainTouchMove}
      onTouchEnd={onMainTouchEnd}
      onTouchCancel={onMainTouchEnd}
    >
      <FloatingBlobs parallaxX={parallaxX} parallaxY={parallaxY} />
      <div className="noise-overlay" aria-hidden />
      <div className="vignette-overlay" aria-hidden />
      {step === "lobby" && (
        <motion.div
          className="pointer-events-none fixed left-1/2 top-5 z-30 h-14 w-14 -translate-x-1/2 rounded-full border-2 border-amber-300/70"
          style={{ opacity: pullDistance > 0 || pullRefreshing ? 1 : 0 }}
          animate={{
            scale: pullRefreshing ? [1, 1.2, 1] : 0.75 + pullDistance / 160,
            borderColor: pullDistance > 70 || pullRefreshing ? "rgba(245,158,11,0.95)" : "rgba(245,158,11,0.45)",
            boxShadow: pullDistance > 0 || pullRefreshing ? "0 0 24px rgba(245,158,11,0.55)" : "0 0 0 rgba(245,158,11,0)",
          }}
          transition={{ duration: pullRefreshing ? 0.8 : 0.2, repeat: pullRefreshing ? Infinity : 0 }}
        />
      )}
      <header className="header-glass mb-4 border-b border-white/10 p-4">
        <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="title-glow text-xl font-black tracking-tight text-white md:text-3xl">Slice Lobby</h1>
          <p className="text-sm font-light text-slate-300">High-Gloss Fintech Bill Split</p>
        </div>
        <div className="flex items-center gap-2">
          {step === "lobby" && (
            <MagneticButton className="btn-ghost rounded-full px-3 py-1 text-xs" onClick={backToScanner}>
              New Scan
            </MagneticButton>
          )}
          <div className="status-pill font-price">{status}</div>
        </div>
        </div>
      </header>

      <AnimatePresence mode="wait">
      {step === "scanner" ? (
        <motion.section
          key="scanner"
          className="grid gap-4 md:grid-cols-2"
          initial={{ opacity: 0, scale: 0.98, filter: "blur(10px)" }}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          exit={{ opacity: 0, scale: 1.02, filter: "blur(12px)" }}
          transition={{ duration: 0.35, ease: "easeOut" }}
        >
          <div className="glass relative overflow-hidden p-3">
            <Webcam
              key={cameraFacing}
              ref={webcamRef}
              className="h-[56vh] w-full rounded-2xl object-cover md:h-[72vh]"
              screenshotFormat="image/jpeg"
              audio={false}
              onUserMedia={() => {
                setCameraReady(true);
                setCameraError("");
                setStatus("Camera ready");
                loadCameraDevices();
              }}
              onUserMediaError={(err) => {
                setCameraReady(false);
                const cameraErr =
                  typeof err === "string"
                    ? err
                    : err && typeof err === "object" && "message" in err
                      ? String(err.message)
                      : "Camera permission denied or camera unavailable";
                setCameraError(cameraErr);
                setStatus("Camera unavailable - use Upload Receipt");
              }}
              videoConstraints={{
                ...(selectedCameraId
                  ? { deviceId: { exact: selectedCameraId } }
                  : { facingMode: cameraFacing === "environment" ? { ideal: "environment" } : "user" }),
                width: { ideal: 1280 },
                height: { ideal: 720 },
              }}
            />
            <div className="pointer-events-none absolute inset-5 rounded-2xl border border-amber-300/60">
              <div className="laser-line" />
            </div>
          </div>
          <div className="glass flex flex-col gap-3 p-4">
            <h2 className="text-lg font-semibold text-white">Scanner Control</h2>
            <input className="field-input" placeholder="Lobby name" value={lobbyName} onChange={(e) => setLobbyName(e.target.value)} />
            <input className="field-input" placeholder="Your name" value={userName} onChange={(e) => setUserName(e.target.value)} />
            <input className="field-input" placeholder="Passcode" value={passcode} onChange={(e) => setPasscode(e.target.value)} />
            <input ref={uploadRef} type="file" accept="image/*" className="hidden" onChange={onUploadSelected} />
            <select
              className="field-input"
              value={selectedCameraId}
              onChange={(e) => {
                setCameraReady(false);
                setCameraError("");
                setSelectedCameraId(e.target.value);
                setStatus("Switching camera device...");
              }}
            >
              <option value="">Auto camera</option>
              {cameraDevices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <MagneticButton type="button" onClick={toggleCameraFacing} className="btn-secondary">
              Switch Camera ({cameraFacing === "user" ? "Front" : "Rear"})
            </MagneticButton>
            <MagneticButton type="button" onClick={loadCameraDevices} className="btn-secondary">
              Reload Devices
            </MagneticButton>
            <MagneticButton type="button" onClick={() => uploadRef.current?.click()} className="btn-secondary">Upload Receipt</MagneticButton>
            <p className="text-xs text-slate-400">Captured/uploaded image is resized to 1280px width before OCR.</p>
            {scanReview && (
              <div className="rounded-xl border border-amber-300/30 bg-amber-500/10 p-3 text-xs text-amber-100">
                <p className="mb-2 font-semibold text-amber-200">Totals Review Required</p>
                <p>Quality: {scanReview.qualityScore.toFixed(2)} | Flags: {scanReview.needsReviewCount}</p>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <input className="field-input" placeholder="Subtotal" value={reviewDraft.subtotal} onChange={(e) => setReviewDraft((d) => ({ ...d, subtotal: e.target.value }))} />
                  <input className="field-input" placeholder="Tax Total" value={reviewDraft.tax} onChange={(e) => setReviewDraft((d) => ({ ...d, tax: e.target.value }))} />
                  <input className="field-input" placeholder="Service" value={reviewDraft.serviceCharge} onChange={(e) => setReviewDraft((d) => ({ ...d, serviceCharge: e.target.value }))} />
                  <input className="field-input" placeholder="Round Off" value={reviewDraft.roundOff} onChange={(e) => setReviewDraft((d) => ({ ...d, roundOff: e.target.value }))} />
                  <input className="field-input col-span-2" placeholder="Grand Total" value={reviewDraft.grandTotal} onChange={(e) => setReviewDraft((d) => ({ ...d, grandTotal: e.target.value }))} />
                </div>
                <div className="mt-2 flex gap-2">
                  <MagneticButton type="button" className="btn-primary w-full" onClick={confirmTotalsAndCreateLobby} disabled={busy}>
                    Confirm & Create Lobby
                  </MagneticButton>
                  <MagneticButton
                    type="button"
                    className="btn-secondary w-full"
                    onClick={() => {
                      setScanReview(null);
                      setStatus("Rescan receipt");
                    }}
                    disabled={busy}
                  >
                    Discard
                  </MagneticButton>
                </div>
              </div>
            )}
            {!cameraReady && (
              <p className="text-xs text-amber-300">
                Camera not ready. Allow browser camera permission, or continue with Upload Receipt.
              </p>
            )}
            {cameraError && <p className="text-xs text-rose-300">{cameraError}</p>}
          </div>
          <MagneticButton
            onClick={scanAndCreateLobby}
            disabled={busy}
            className="btn-primary fab-glow fixed bottom-5 right-5 z-30 rounded-full px-6 py-3 md:static md:col-span-2 md:w-full md:rounded-2xl"
          >
            {busy ? "Processing..." : "Scan Receipt"}
          </MagneticButton>
        </motion.section>
      ) : (
        <motion.section
          key="lobby"
          className="grid gap-4 lg:grid-cols-[0.9fr_1.4fr_0.9fr]"
          initial={{ opacity: 0, scale: 0.97, filter: "blur(12px)" }}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          exit={{ opacity: 0, scale: 1.02, filter: "blur(12px)" }}
          transition={{ duration: 0.35, ease: "easeOut" }}
        >
          <aside className="hidden lg:block lg:sticky lg:top-4 lg:self-start">
            <div className="glass aurora-border p-4">
              <h3 className="mb-2 text-sm font-semibold text-white">Receipt Focus</h3>
              {billImage ? (
                <>
                  <motion.div
                    className="h-[72vh] w-full overflow-hidden rounded-xl border border-white/10 bg-slate-950/60 p-2"
                    animate={{
                      boxShadow: hoveredItem ? "0 0 34px rgba(245,158,11,0.35)" : "0 0 0 rgba(245,158,11,0)",
                      borderColor: hoveredItem ? "rgba(245,158,11,0.75)" : "rgba(255,255,255,0.12)",
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={billImage} alt="Bill" className="h-full w-full object-contain" />
                  </motion.div>
                  <div className="mt-2 rounded-xl border border-amber-300/25 bg-amber-500/10 p-2 text-xs">
                    <p className="text-amber-200">Hovered Item</p>
                    <p className="font-semibold text-amber-100">
                      {hoveredItem ? `${hoveredItem.name}  Rs ${Number(hoveredItem.cost || 0).toFixed(2)}` : "Hover an item card to focus"}
                    </p>
                  </div>
                </>
              ) : (
                <p className="text-xs text-slate-400">No receipt image available</p>
              )}
            </div>
          </aside>

          <div className="space-y-4">
            <div className="glass aurora-border p-4">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-white">Interactive Lobby</h2>
                  <p className="font-price text-xs text-slate-300">Lobby: {lobbyId}</p>
                </div>
                <div className="flex items-center gap-2">
                  <MagneticButton className="btn-ghost rounded-full px-3 py-1 text-xs" onClick={() => setShowAddItem((v) => !v)}>
                    {showAddItem ? "Close Add" : "Add Missing Item"}
                  </MagneticButton>
                  <MagneticButton
                    type="button"
                    className="inline-flex items-center gap-2 rounded-full border border-amber-300/30 bg-amber-500/10 px-3 py-1 text-xs text-amber-200"
                    onClick={() => fetchLobbyState()}
                    title="Live sync status. Tap to refresh now."
                  >
                    <motion.span className="live-dot breathing-glow" animate={liveBeat ? { scale: [1, 1.18, 1] } : { scale: 1 }} transition={{ duration: 0.5 }} />
                    Live
                  </MagneticButton>
                </div>
              </div>
              <p className="mb-2 text-xs text-slate-400">Items visible: {visibleItems.length}</p>
              {recentManualItems.length > 0 && (
                <div className="mb-3 rounded-xl border border-amber-300/30 bg-amber-500/10 p-2">
                  <p className="mb-2 text-xs font-semibold text-amber-200">Recently Added (Manual)</p>
                  <div className="flex flex-wrap gap-2">
                    {recentManualItems.map((it) => (
                      <MagneticButton
                        key={`recent-${it.id}`}
                        type="button"
                        className="rounded-full border border-amber-300/40 bg-amber-500/15 px-2 py-1 text-[11px] text-amber-100"
                        onClick={() => {
                          const el = document.getElementById(`item-card-${it.id}`);
                          if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
                          setLastAddedItemId(it.id);
                        }}
                      >
                        {it.name} ({it.id})
                      </MagneticButton>
                    ))}
                  </div>
                </div>
              )}
              {showAddItem && (
                <div className="mb-3 grid grid-cols-2 gap-2 rounded-xl border border-white/10 bg-slate-950/70 p-2">
                  <input
                    className="field-input col-span-2"
                    placeholder="Item name"
                    value={addDraft.name}
                    onChange={(e) => setAddDraft({ ...addDraft, name: e.target.value })}
                  />
                  <input
                    className="field-input"
                    placeholder="Qty"
                    value={addDraft.quantity}
                    onChange={(e) => {
                      const qText = e.target.value;
                      const q = Number(qText);
                      const u = Number(addDraft.unit_price);
                      const c = Number.isFinite(q) && Number.isFinite(u) && q > 0 ? String(Number((q * u).toFixed(2))) : addDraft.cost;
                      setAddDraft({ ...addDraft, quantity: qText, cost: c });
                    }}
                  />
                  <input
                    className="field-input"
                    placeholder="Unit price"
                    value={addDraft.unit_price}
                    onChange={(e) => {
                      const uText = e.target.value;
                      const q = Number(addDraft.quantity);
                      const u = Number(uText);
                      const c = Number.isFinite(q) && Number.isFinite(u) && q > 0 ? String(Number((q * u).toFixed(2))) : addDraft.cost;
                      setAddDraft({ ...addDraft, unit_price: uText, cost: c });
                    }}
                  />
                  <input
                    className="field-input"
                    placeholder="Cost"
                    value={addDraft.cost}
                    onChange={(e) => setAddDraft({ ...addDraft, cost: e.target.value })}
                  />
                  <select
                    className="field-input"
                    value={addDraft.category}
                    onChange={(e) => setAddDraft({ ...addDraft, category: e.target.value })}
                  >
                    <option value="veg">veg</option>
                    <option value="non_veg">non_veg</option>
                    <option value="drinks">drinks</option>
                    <option value="other">other</option>
                  </select>
                  {addDraft.category === "other" && (
                    <select
                      className="field-input col-span-2"
                      value={addDraft.other_subcategory}
                      onChange={(e) => setAddDraft({ ...addDraft, other_subcategory: e.target.value })}
                    >
                      <option value="">choose other type</option>
                      {DEFAULT_OTHER_OPTIONS.map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  )}
                  <MagneticButton
                    className="btn-primary col-span-2 text-sm"
                    onClick={addMissingItem}
                    disabled={!addDraft.name.trim()}
                  >
                    Add Item
                  </MagneticButton>
                </div>
              )}
              <div className="item-feed">
                {visibleItems.length === 0 && (
                  <div className="rounded-2xl border border-amber-400/30 bg-amber-500/10 p-3 text-sm text-amber-200">
                    No items parsed yet. Tap <b>Live</b> to refresh.
                  </div>
                )}
                <div className="grid gap-3 md:grid-cols-2">
                  {visibleItems.map((item, idx) => (
                    <WheelItem key={item.id} index={idx}>{renderItemCard(item)}</WheelItem>
                  ))}
                </div>
              </div>
            </div>

            <div className="glass aurora-border p-4 lg:hidden">
              <h3 className="mb-2 text-sm font-semibold text-white">Captured Bill</h3>
              {billImage ? (
                <div
                  className="h-[420px] w-full cursor-zoom-in overflow-hidden rounded-xl border border-white/10 bg-slate-950/60 p-2"
                  onDoubleClick={openBillViewer}
                  title="Double click to open fullscreen"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={billImage} alt="Bill" className="h-full w-full object-contain" />
                </div>
              ) : (
                <p className="text-xs text-slate-400">No image preview</p>
              )}
              {billImage && (
                <p className="mt-2 text-xs text-slate-400">
                  Double-click image to view fullscreen and zoom.
                </p>
              )}
            </div>
          </div>

          <aside className="space-y-4 pb-28 lg:sticky lg:top-4 lg:pb-40">
            <div className="glass aurora-border p-4">
              <h3 className="mb-2 text-sm font-semibold text-slate-200">Your Total</h3>
              <p className="text-2xl font-semibold text-emerald-300"><NumberTicker value={myTotal} /></p>
              <p className="mt-1 text-xs text-slate-400">Extra charges share: <NumberTicker value={myExtraShare} /></p>
            </div>
            <div className="glass aurora-border p-4">
              <h3 className="mb-2 text-sm font-semibold text-slate-200">Participant Totals</h3>
              <div className="grid gap-2">
                {Object.entries(summary?.users || {}).map(([uid, u]) => (
                  <div key={uid} className="flex items-center justify-between rounded-xl border border-white/10 bg-slate-900/70 px-3 py-2 text-sm">
                    <span className="text-slate-200">{u.user_name}</span>
                    <span className="font-semibold text-emerald-300"><NumberTicker value={u.total} /></span>
                  </div>
                ))}
              </div>
            </div>
            <div className="glass aurora-border p-4">
              <h3 className="mb-2 text-sm font-semibold text-slate-200">Lobby Summary</h3>
              <div className="grid items-center gap-2 md:grid-cols-[170px_1fr]">
                <LiquidWaveCircle percent={claimedPercent} />
                <div className="grid grid-cols-1 gap-2 text-xs">
                  <div className="shimmer-border rounded-xl border border-white/10 bg-stone-900/60 p-2">
                    <p className="text-stone-400">Item Subtotal</p>
                    <p className="font-semibold text-stone-100"><NumberTicker value={uiItemSubtotal} /></p>
                  </div>
                  <div className="shimmer-border rounded-xl border border-white/10 bg-stone-900/60 p-2">
                    <p className="text-stone-400">Extra Charges</p>
                    <p className="font-semibold text-stone-100"><NumberTicker value={uiExtraCharges} /></p>
                  </div>
                  <div className="shimmer-border rounded-xl border border-white/10 bg-stone-900/60 p-2">
                    <p className="text-stone-400">Grand</p>
                    <p className="font-semibold text-stone-100"><NumberTicker value={uiGrandTotal} /></p>
                  </div>
                  <div className="shimmer-border rounded-xl border border-amber-300/20 bg-amber-500/10 p-2">
                    <p className="text-amber-200">Claimed</p>
                    <p className="font-semibold text-amber-200"><NumberTicker value={summary?.claimed_total || 0} /></p>
                  </div>
                  <div className="shimmer-border rounded-xl border border-rose-300/20 bg-rose-500/10 p-2">
                    <p className="text-rose-200">Items Pending</p>
                    <p className="font-semibold text-rose-200"><NumberTicker value={summary?.unclaimed_item_total || 0} /></p>
                  </div>
                </div>
              </div>
              <p className="mt-2 text-[11px] text-slate-400">
                Unallocated charges: Rs {Math.max(0, Number((summary?.unclaimed_total || 0) - (summary?.unclaimed_item_total || 0))).toFixed(2)}
              </p>
              {(summary?.tax_breakdown || []).length > 0 && (
                <div className="mt-3 rounded-xl border border-white/10 bg-slate-900/50 p-2">
                  <p className="mb-1 text-xs font-semibold text-slate-200">Tax Breakdown</p>
                  <div className="space-y-1">
                    {(summary?.tax_breakdown || []).map((row, idx) => (
                      <div key={`${row.name}-${idx}`} className="flex items-center justify-between text-[11px] text-slate-300">
                        <span className="truncate pr-2">{row.name}</span>
                        <span className="font-price text-amber-200">Rs {Number(row.amount || 0).toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="glass aurora-border p-4">
              <h3 className="mb-2 text-sm font-semibold text-slate-200">Invite</h3>
              <div className="space-y-2">
                <input
                  className="field-input w-full text-xs"
                  value={joinUrl || "Scan first to generate join link"}
                  readOnly
                />
                <MagneticButton
                  type="button"
                  className="btn-secondary w-full"
                  onClick={copyJoinLink}
                  disabled={!joinUrl}
                >
                  {shareCopied ? "Copied" : "Copy Join Link"}
                </MagneticButton>
                {joinQrUrl && (
                  <div className="flex justify-center rounded-xl border border-white/10 bg-slate-900/60 p-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={joinQrUrl} alt="Lobby QR" className="h-40 w-40 rounded-lg object-contain" />
                  </div>
                )}
              </div>
            </div>
          </aside>
        </motion.section>
      )}
      </AnimatePresence>

      {step === "lobby" && (
        <motion.div
          layoutId="total-bubble"
          className="fixed bottom-4 right-4 z-40 hidden w-60 cursor-pointer rounded-3xl border border-white/20 bg-white/10 p-3 shadow-soft backdrop-blur-2xl lg:block"
          style={{ y: bubbleY }}
          onClick={() => setIsTotalModalOpen(true)}
        >
          <p className="text-xs text-slate-300">Your Total</p>
          <p className="font-price text-3xl font-semibold text-emerald-300">Rs {myTotal.toFixed(2)}</p>
          <div className="mt-2 flex flex-wrap gap-1">
            {myClaimedItems.slice(0, 5).map((c) => (
              <motion.span
                key={`${c.item_id}-${c.quantity}`}
                layoutId={`claim-chip-${c.item_id}`}
                className="rounded-full border border-emerald-300/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-200"
              >
                {c.quantity}x
              </motion.span>
            ))}
          </div>
        </motion.div>
      )}
      {step === "lobby" && (
        <button
          type="button"
          onClick={backToScanner}
          className="btn-primary fab-glow fixed bottom-4 left-4 z-40 rounded-full px-5 py-3 text-xs md:hidden"
        >
          Scan
        </button>
      )}

      <AnimatePresence>
        {claimConfirm && (
          <motion.div
            className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setClaimConfirm(null)}
          >
            <motion.div
              className="w-full max-w-sm rounded-3xl border border-white/10 bg-[#0c0a09]/80 p-5 shadow-soft backdrop-blur-2xl"
              initial={{ opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-base font-semibold text-white">Confirm Claim</h3>
              <p className="mt-2 text-sm text-slate-300">
                {`Confirm ${claimConfirm.label} for ${claimConfirm.item.name}?`}
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  className="btn-ghost rounded-xl px-4 py-2"
                  onClick={() => setClaimConfirm(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="rounded-xl bg-[#f59e0b] px-4 py-2 text-sm font-semibold text-stone-950 transition hover:shadow-[0_0_15px_#f59e0b]"
                  onClick={confirmClaimAction}
                >
                  Confirm
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isTotalModalOpen && (
          <motion.div
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setIsTotalModalOpen(false)}
          >
            <motion.div
              layoutId="total-bubble"
              className="w-full max-w-md rounded-3xl border border-white/20 bg-stone-950/80 p-4 shadow-soft backdrop-blur-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-base font-semibold text-white">Your Breakdown</h3>
                <button className="btn-secondary rounded-full px-3 py-1 text-xs" onClick={() => setIsTotalModalOpen(false)}>
                  Close
                </button>
              </div>
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 p-2">
                  <span className="text-slate-300">Subtotal</span>
                  <span className="font-price text-emerald-200">Rs {myTotal.toFixed(2)}</span>
                </div>
                <div className="flex items-center justify-between rounded-xl border border-amber-300/20 bg-amber-500/10 p-2">
                  <span className="text-amber-100">Extra Charges Share</span>
                  <span className="font-price text-amber-200">Rs {myExtraShare.toFixed(2)}</span>
                </div>
                <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 p-2">
                  <span className="text-slate-300">Payable</span>
                  <span className="font-price text-emerald-200">Rs {myTotal.toFixed(2)}</span>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isBillViewerOpen && billImage && (
          <motion.div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 p-3"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setIsBillViewerOpen(false)}
          >
            <motion.div
              className="relative h-[95vh] w-[95vw] rounded-2xl border border-white/10 bg-slate-950/80 p-3"
              initial={{ scale: 0.96, opacity: 0.8 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.96, opacity: 0.8 }}
              onClick={(e) => e.stopPropagation()}
              onWheel={(e) => {
                e.preventDefault();
                adjustBillZoom(e.deltaY < 0 ? 0.15 : -0.15);
              }}
            >
              <div className="mb-2 flex items-center justify-between">
                <div className="text-xs text-slate-300">Captured Bill Viewer</div>
                <div className="flex items-center gap-2">
                  <button className="btn-secondary rounded-full px-3 py-1 text-xs" onClick={() => adjustBillZoom(-0.2)}>
                    -
                  </button>
                  <span className="min-w-[56px] text-center text-xs text-slate-200">
                    {(billZoom * 100).toFixed(0)}%
                  </span>
                  <button className="btn-secondary rounded-full px-3 py-1 text-xs" onClick={() => adjustBillZoom(0.2)}>
                    +
                  </button>
                  <button className="btn-primary rounded-full px-3 py-1 text-xs" onClick={() => setIsBillViewerOpen(false)}>
                    Close
                  </button>
                </div>
              </div>
              <div className="flex h-[calc(95vh-56px)] items-center justify-center overflow-auto rounded-xl border border-white/10 bg-black/50">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={billImage}
                  alt="Bill Fullscreen"
                  className="max-h-full max-w-full select-none object-contain"
                  style={{ transform: `scale(${billZoom})`, transformOrigin: "center center" }}
                  onDoubleClick={() => setBillZoom((z) => (z > 1 ? 1 : 2))}
                />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}

