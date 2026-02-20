"use client";

import { motion, useMotionValue, useSpring } from "framer-motion";
import { Suspense, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";

type ScanItem = {
  id: string;
  name: string;
  quantity: number;
  unit_price: number;
  cost: number;
  category?: "veg" | "non_veg" | "drinks" | "other";
};

type Summary = {
  grand_total: number;
  claimed_total: number;
  unclaimed_total: number;
  users: Record<
    string,
    {
      user_name: string;
      total: number;
      items: { item_id: string; quantity: number; amount: number; name: string }[];
    }
  >;
};

type LobbyStateResponse = {
  receipt_image?: string | null;
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:8000";

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
    if (Number.isFinite(an) && Number.isFinite(bn)) return bn - an;
    return String(b.id || "").localeCompare(String(a.id || ""));
  });
  return values;
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
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
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

function categoryClass(category?: ScanItem["category"]): string {
  if (category === "veg") return "category-chip category-veg";
  if (category === "non_veg") return "category-chip category-nonveg";
  if (category === "drinks") return "category-chip category-drinks";
  return "category-chip category-other";
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

function JoinPageContent() {
  const search = useSearchParams();
  const [lobbyId, setLobbyId] = useState(search.get("lobby_id") || "");
  const [passcode, setPasscode] = useState(search.get("passcode") || "");
  const [userName, setUserName] = useState("");
  const [userId, setUserId] = useState("");
  const [joined, setJoined] = useState(false);
  const [items, setItems] = useState<ScanItem[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [status, setStatus] = useState("Join lobby to start claiming");
  const [itemFilter, setItemFilter] = useState<"all" | "unclaimed" | "partial" | "claimed">("all");
  const [billImage, setBillImage] = useState<string | null>(null);
  const [isBillViewerOpen, setIsBillViewerOpen] = useState(false);
  const [showAddItem, setShowAddItem] = useState(false);
  const [addDraft, setAddDraft] = useState({
    name: "",
    quantity: "1",
    unit_price: "0",
    cost: "0",
    category: "other",
    other_subcategory: "",
  });

  const claimsByItem = useMemo(() => {
    const map: Record<string, { total: number; mine: number; others: string[] }> = {};
    if (!summary) return map;
    for (const [uid, u] of Object.entries(summary.users || {})) {
      for (const row of u.items || []) {
        if (!map[row.item_id]) map[row.item_id] = { total: 0, mine: 0, others: [] };
        map[row.item_id].total += Number(row.quantity || 0);
        if (uid === userId) {
          map[row.item_id].mine += Number(row.quantity || 0);
        } else if (!map[row.item_id].others.includes(u.user_name)) {
          map[row.item_id].others.push(u.user_name);
        }
      }
    }
    return map;
  }, [summary, userId]);

  const myTotal = useMemo(() => {
    if (!summary || !userId) return 0;
    return Number(summary.users?.[userId]?.total || 0);
  }, [summary, userId]);

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (itemFilter === "all") return true;
      const claim = claimsByItem[item.id] || { total: 0, mine: 0, others: [] };
      const qty = Number(item.quantity || 0);
      const claimed = Number(claim.total || 0);
      if (itemFilter === "unclaimed") return claimed <= 0;
      if (itemFilter === "claimed") return claimed >= qty && qty > 0;
      return claimed > 0 && claimed < qty;
    });
  }, [items, itemFilter, claimsByItem]);

  async function loadItems() {
    if (!lobbyId || !passcode) return;
    const ts = Date.now();
    const res = await fetch(
      `${API_BASE}/lobby/${lobbyId}/items?lobby_passcode=${encodeURIComponent(passcode)}&t=${ts}`,
      { cache: "no-store" }
    );
    if (!res.ok) return;
    const data = await res.json();
    setItems((prev) => mergeItemsById(prev, data.items || []));
  }

  async function loadLobbyState() {
    if (!lobbyId || !passcode) return;
    const ts = Date.now();
    const res = await fetch(
      `${API_BASE}/lobby/${lobbyId}?lobby_passcode=${encodeURIComponent(passcode)}&t=${ts}`,
      { cache: "no-store" }
    );
    if (!res.ok) return;
    const data = (await res.json()) as LobbyStateResponse;
    setBillImage(data.receipt_image || null);
  }

  async function refreshSummary() {
    if (!lobbyId || !passcode) return;
    const ts = Date.now();
    const res = await fetch(
      `${API_BASE}/lobby/${lobbyId}/summary?lobby_passcode=${encodeURIComponent(passcode)}&t=${ts}`,
      { cache: "no-store" }
    );
    if (!res.ok) return;
    const data = (await res.json()) as Summary;
    setSummary(data);
  }

  async function joinLobby() {
    if (!lobbyId || !passcode || !userName.trim()) {
      setStatus("Enter lobby ID, passcode, and your name");
      return;
    }
    const res = await fetch(`${API_BASE}/lobby/${lobbyId}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_name: userName.trim(), lobby_passcode: passcode }),
    });
    if (!res.ok) {
      setStatus("Join failed");
      return;
    }
    const data = await res.json();
    setUserId(data.user_id);
    setJoined(true);
    setStatus(`Joined as ${data.user_name}`);
    localStorage.setItem(`slice_join_user_${lobbyId}`, JSON.stringify(data));
    await loadItems();
    await refreshSummary();
    await loadLobbyState();
  }

  async function claimItem(item: ScanItem) {
    if (!lobbyId || !passcode || !userId) return;
    const now = claimsByItem[item.id] || { total: 0, mine: 0, others: [] };
    const next = now.mine >= item.quantity ? 0 : Math.min(now.mine + 1, item.quantity);
    const actionLabel = next === 0 ? "unclaim" : `set claim to ${next}`;
    if (!window.confirm(`Confirm ${actionLabel} for "${item.name}"?`)) return;
    if ("vibrate" in navigator) navigator.vibrate(10);

    const res = await fetch(`${API_BASE}/claim-item`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lobby_id: lobbyId,
        user_id: userId,
        item_id: item.id,
        quantity: next,
        lobby_passcode: passcode,
      }),
    });
    if (!res.ok) {
      setStatus("Claim failed");
      return;
    }
    setStatus(`${item.name}: ${next}/${item.quantity}`);
    await refreshSummary();
  }

  async function addMissingItem() {
    if (!lobbyId || !passcode || !userId) return;
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
      setItems((prev) => {
        const without = prev.filter((it) => it.id !== data.item.id);
        return [data.item, ...without];
      });
    }
    setAddDraft({
      name: "",
      quantity: "1",
      unit_price: "0",
      cost: "0",
      category: "other",
      other_subcategory: "",
    });
    setShowAddItem(false);
    setStatus("Missing item added");
    await loadItems();
    await refreshSummary();
  }

  useEffect(() => {
    const pLobby = search.get("lobby_id");
    const pPass = search.get("passcode");
    if (pLobby && !lobbyId) setLobbyId(pLobby);
    if (pPass && !passcode) setPasscode(pPass);
    if (pPass && typeof window !== "undefined") {
      const u = new URL(window.location.href);
      u.searchParams.delete("passcode");
      window.history.replaceState({}, "", u.toString());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!lobbyId || !passcode) return;
    loadItems();
    refreshSummary();
    loadLobbyState();
    const saved = localStorage.getItem(`slice_join_user_${lobbyId}`);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setUserId(parsed.user_id || "");
        setUserName(parsed.user_name || "");
        setJoined(Boolean(parsed.user_id));
      } catch {
        // ignore parse errors
      }
    }
    const t = setInterval(() => {
      if (document.visibilityState === "visible") {
        refreshSummary();
      }
    }, 4000);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        refreshSummary();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobbyId, passcode]);

  return (
    <main className={`mx-auto max-w-3xl p-4 md:p-6 ${joined ? "pb-24 md:pb-6" : ""}`}>
      <header className="glass mb-4 flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white md:text-2xl">Slice Lobby</h1>
          <p className="text-sm text-slate-300">Participant view: join and claim your items</p>
        </div>
        <div className="status-pill">{status}</div>
      </header>

      {!joined ? (
        <section className="glass mb-4 space-y-3 p-4">
          <input
            className="field-input"
            placeholder="Lobby ID"
            value={lobbyId}
            onChange={(e) => setLobbyId(e.target.value)}
          />
          <input
            className="field-input"
            placeholder="Passcode"
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
          />
          <input
            className="field-input"
            placeholder="Your name"
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
          />
          <MagneticButton onClick={joinLobby} className="btn-primary w-full">
            Join Lobby
          </MagneticButton>
        </section>
      ) : (
        <section className="glass mb-4 flex items-center justify-between p-3 text-sm">
          <div className="text-slate-200">
            Joined as <span className="font-semibold">{userName}</span>
          </div>
          <button
            type="button"
            className="btn-secondary rounded-full px-3 py-1 text-xs"
            onClick={() => {
              setJoined(false);
              setUserId("");
              setStatus("Switch user if needed");
            }}
          >
            Switch User
          </button>
        </section>
      )}

      <section className="mb-4 grid grid-cols-3 gap-2 text-center text-xs">
        <div className="glass p-3">
          <p className="text-slate-500">Grand</p>
          <p className="font-semibold">Rs {(summary?.grand_total || 0).toFixed(2)}</p>
        </div>
        <div className="glass p-3">
          <p className="text-slate-500">Claimed</p>
          <p className="font-semibold">Rs {(summary?.claimed_total || 0).toFixed(2)}</p>
        </div>
        <div className="glass p-3">
          <p className="text-slate-500">Left</p>
          <p className="font-semibold">Rs {(summary?.unclaimed_total || 0).toFixed(2)}</p>
        </div>
      </section>

      <div className="mb-3 flex flex-wrap gap-2">
        {[
          { key: "all", label: "All" },
          { key: "unclaimed", label: "Unclaimed" },
          { key: "partial", label: "Partially Claimed" },
          { key: "claimed", label: "Fully Claimed" },
        ].map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setItemFilter(tab.key as "all" | "unclaimed" | "partial" | "claimed")}
            className={
              itemFilter === tab.key
                ? "rounded-full border border-emerald-300/60 bg-emerald-500/20 px-3 py-1 text-xs font-semibold text-emerald-200"
                : "rounded-full border border-white/10 bg-slate-900/60 px-3 py-1 text-xs text-slate-300"
            }
          >
            {tab.label}
          </button>
        ))}
      </div>

      {joined && (
        <section className="glass mb-3 p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-100">Add Missing Item</p>
            <button
              type="button"
              className="btn-secondary rounded-full px-3 py-1 text-xs"
              onClick={() => setShowAddItem((v) => !v)}
            >
              {showAddItem ? "Close" : "Add"}
            </button>
          </div>
          {showAddItem && (
            <div className="grid grid-cols-2 gap-2">
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
                  const c =
                    Number.isFinite(q) && Number.isFinite(u) && q > 0
                      ? String(Number((q * u).toFixed(2)))
                      : addDraft.cost;
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
                  const c =
                    Number.isFinite(q) && Number.isFinite(u) && q > 0
                      ? String(Number((q * u).toFixed(2)))
                      : addDraft.cost;
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
                  <option value="starter">starter</option>
                  <option value="main_course">main_course</option>
                  <option value="bread">bread</option>
                  <option value="rice">rice</option>
                  <option value="dessert">dessert</option>
                  <option value="snack">snack</option>
                  <option value="side">side</option>
                </select>
              )}
              <button
                type="button"
                className="btn-primary col-span-2"
                onClick={addMissingItem}
                disabled={!addDraft.name.trim()}
              >
                Add Item
              </button>
            </div>
          )}
        </section>
      )}

      <section className="grid gap-2">
        {filteredItems.length === 0 && (
          <div className="glass rounded-2xl p-3 text-sm text-slate-300">
            No items in this view. Try another tab.
          </div>
        )}
        {filteredItems.map((item) => {
          const claim = claimsByItem[item.id] || { total: 0, mine: 0, others: [] };
          const available = Math.max(0, item.quantity - claim.total + claim.mine);
          const blockedByOthers = available <= 0 && claim.mine <= 0;
          return (
            <motion.div
              key={item.id}
              whileTap={{ scale: 0.97 }}
              className={`glass w-full rounded-2xl p-3 text-left transition ${
                blockedByOthers ? "opacity-45" : "hover:border-emerald-300"
              }`}
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <p className="truncate text-sm font-semibold">{item.name}</p>
                <span className={categoryClass(item.category)}>
                  {item.category || "other"}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs text-slate-600">
                <span>
                  Qty {item.quantity} | Rs {item.cost}
                </span>
                <span>
                  You: {claim.mine}/{item.quantity}
                </span>
              </div>
              {claim.others.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {claim.others.map((name) => (
                    <span
                      key={name}
                      className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] text-slate-700"
                    >
                      {name}
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-2">
                <MagneticButton
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    claimItem(item);
                  }}
                  className="btn-primary rounded-full px-3 py-1 text-xs"
                >
                  {claim.mine > 0 ? "Update/Unclaim" : "Claim"}
                </MagneticButton>
              </div>
            </motion.div>
          );
        })}
      </section>

      {billImage && (
        <section className="glass mt-4 p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-100">Captured Bill</p>
            <button
              className="btn-secondary rounded-full px-3 py-1 text-xs"
              onClick={() => setIsBillViewerOpen(true)}
            >
              View Fullscreen
            </button>
          </div>
          <div
            className="h-56 w-full cursor-zoom-in overflow-hidden rounded-xl border border-white/10 bg-slate-950/60 p-2"
            onDoubleClick={() => setIsBillViewerOpen(true)}
            title="Double tap to view fullscreen"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={billImage} alt="Receipt preview" className="h-full w-full object-contain" />
          </div>
        </section>
      )}

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
          >
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs text-slate-300">Captured Bill Viewer</div>
              <button
                className="btn-primary rounded-full px-3 py-1 text-xs"
                onClick={() => setIsBillViewerOpen(false)}
              >
                Close
              </button>
            </div>
            <div className="flex h-[calc(95vh-56px)] items-center justify-center overflow-auto rounded-xl border border-white/10 bg-black/50">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={billImage} alt="Bill Fullscreen" className="max-h-full max-w-full object-contain" />
            </div>
          </motion.div>
        </motion.div>
      )}

      {joined && (
        <div className="fixed inset-x-3 bottom-3 z-40 rounded-2xl border border-white/10 bg-slate-950/85 p-3 shadow-lg backdrop-blur md:hidden">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="text-slate-300">My Total</span>
            <span className="font-semibold text-emerald-300">Rs {myTotal.toFixed(2)}</span>
          </div>
          <button
            type="button"
            className="btn-secondary w-full"
            onClick={async () => {
              await loadItems();
              await refreshSummary();
              await loadLobbyState();
              setStatus("Synced");
            }}
          >
            Sync
          </button>
        </div>
      )}
    </main>
  );
}

export default function JoinPage() {
  return (
    <Suspense fallback={<main className="mx-auto max-w-3xl p-4 md:p-6 text-sm text-slate-300">Loading lobby...</main>}>
      <JoinPageContent />
    </Suspense>
  );
}
