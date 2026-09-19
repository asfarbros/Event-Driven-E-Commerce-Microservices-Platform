import { useEffect, useState } from "react";
import { useAuth } from "@clerk/clerk-react";
import {
  Loader,
  AlertTriangle,
  ShoppingBag,
  Trash2,
  CreditCard,
  ArrowLeft,
} from "lucide-react";
import { Link } from "react-router-dom";
import api from "../lib/api";

interface CartItem {
  productId: string;
  quantity: number;
}

export default function CartPage() {
  const { getToken, isSignedIn } = useAuth();
  const [items, setItems] = useState<CartItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (isSignedIn) {
      fetchCart();
    } else {
      setLoading(false);
    }
  }, [isSignedIn]);

  async function fetchCart() {
    try {
      setLoading(true);
      setError(null);
      const token = await getToken();
      const res = await api.get("/api/cart", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      setItems(res.data.items || []);
    } catch (err: any) {
      setError(err.message || "Failed to load cart");
    } finally {
      setLoading(false);
    }
  }

  async function handleClear() {
    try {
      setClearing(true);
      const token = await getToken();
      await api.delete("/api/cart", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      setItems([]);
      showToast("Cart cleared!");
    } catch {
      showToast("Failed to clear cart");
    } finally {
      setClearing(false);
    }
  }

  function handleCheckout() {
    showToast("Checkout coming soon — POST /api/orders");
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  /* ─── Not Signed In ────────────────────────────── */
  if (!isSignedIn && !loading) {
    return (
      <div className="flex flex-col items-center justify-center py-32 gap-4">
        <div className="bg-brutal-orange border-3 border-brutal-black p-6 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]">
          <ShoppingBag className="w-10 h-10 text-brutal-black" />
        </div>
        <p className="text-lg font-bold uppercase">Sign in to view your cart</p>
      </div>
    );
  }

  /* ─── Loading ──────────────────────────────────── */
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-32 gap-4">
        <div className="bg-brutal-lilac border-3 border-brutal-black p-6 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]">
          <Loader className="w-10 h-10 text-brutal-black animate-spin" />
        </div>
        <p className="text-lg font-bold uppercase">Loading cart...</p>
      </div>
    );
  }

  /* ─── Error ────────────────────────────────────── */
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-32 gap-4">
        <div className="bg-brutal-pink border-3 border-brutal-black p-6 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]">
          <AlertTriangle className="w-10 h-10 text-brutal-black" />
        </div>
        <p className="text-lg font-bold uppercase">Error</p>
        <p className="text-sm text-brutal-black/70">{error}</p>
        <button
          onClick={fetchCart}
          className="
            mt-2 bg-brutal-yellow px-6 py-3 font-bold uppercase
            border-3 border-brutal-black
            shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]
            hover:translate-x-[2px] hover:translate-y-[2px]
            hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]
            transition-all duration-100 cursor-pointer
          "
        >
          Retry
        </button>
      </div>
    );
  }

  /* ─── Cart View ────────────────────────────────── */
  return (
    <>
      {/* Header */}
      <div className="mb-8 flex items-end justify-between">
        <div>
          <h1 className="text-5xl font-bold uppercase tracking-tighter text-brutal-black">
            Your Cart
          </h1>
          <div className="mt-2 h-2 w-32 bg-brutal-black" />
        </div>
        <Link
          to="/"
          className="
            flex items-center gap-2 px-4 py-2
            font-bold uppercase text-sm text-brutal-black
            bg-white border-3 border-brutal-black no-underline
            shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]
            hover:translate-x-[2px] hover:translate-y-[2px]
            hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]
            transition-all duration-100
          "
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Catalog
        </Link>
      </div>

      {/* Empty State */}
      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 gap-4">
          <div className="bg-brutal-yellow border-3 border-brutal-black p-6 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]">
            <ShoppingBag className="w-10 h-10 text-brutal-black" />
          </div>
          <p className="text-lg font-bold uppercase">Your cart is empty</p>
          <Link
            to="/"
            className="
              mt-2 bg-brutal-green px-6 py-3 font-bold uppercase
              text-brutal-black no-underline
              border-3 border-brutal-black
              shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]
              hover:translate-x-[2px] hover:translate-y-[2px]
              hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]
              transition-all duration-100
            "
          >
            Browse Products
          </Link>
        </div>
      ) : (
        <>
          {/* Cart Items Table */}
          <div className="bg-white border-3 border-brutal-black shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] mb-6">
            {/* Table Header */}
            <div className="grid grid-cols-3 border-b-3 border-brutal-black bg-brutal-blue px-6 py-3">
              <span className="font-bold uppercase text-sm">Product ID</span>
              <span className="font-bold uppercase text-sm text-center">
                Quantity
              </span>
              <span className="font-bold uppercase text-sm text-right">
                Status
              </span>
            </div>

            {/* Table Rows */}
            {items.map((item, idx) => (
              <div
                key={item.productId}
                className={`
                  grid grid-cols-3 px-6 py-4 items-center
                  ${idx < items.length - 1 ? "border-b-3 border-brutal-black" : ""}
                `}
              >
                <span className="font-mono text-sm font-semibold truncate pr-4">
                  {item.productId}
                </span>
                <span className="text-center">
                  <span className="inline-block bg-brutal-yellow border-3 border-brutal-black px-4 py-1 font-bold text-lg shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]">
                    {item.quantity}
                  </span>
                </span>
                <span className="text-right">
                  <span className="inline-block bg-brutal-green border-2 border-brutal-black px-3 py-1 text-xs font-bold uppercase">
                    In Cart
                  </span>
                </span>
              </div>
            ))}
          </div>

          {/* Actions Row */}
          <div className="flex flex-col sm:flex-row gap-4 justify-between">
            {/* Clear Cart Button */}
            <button
              onClick={handleClear}
              disabled={clearing}
              className="
                flex items-center justify-center gap-2
                bg-brutal-pink px-6 py-4 font-bold uppercase
                text-brutal-black
                border-3 border-brutal-black
                shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]
                hover:translate-x-[2px] hover:translate-y-[2px]
                hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]
                active:translate-x-[4px] active:translate-y-[4px]
                active:shadow-none
                transition-all duration-100 cursor-pointer
                disabled:opacity-50
              "
            >
              <Trash2 className="w-5 h-5" />
              {clearing ? "Clearing..." : "Clear Cart"}
            </button>

            {/* ─── CHECKOUT PLACEHOLDER ──────────────── */}
            <button
              onClick={handleCheckout}
              className="
                flex items-center justify-center gap-3
                bg-brutal-yellow px-10 py-5 font-bold uppercase text-xl
                text-brutal-black
                border-4 border-brutal-black
                shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]
                hover:translate-x-[3px] hover:translate-y-[3px]
                hover:shadow-[5px_5px_0px_0px_rgba(0,0,0,1)]
                active:translate-x-[8px] active:translate-y-[8px]
                active:shadow-none
                transition-all duration-100 cursor-pointer
              "
            >
              <CreditCard className="w-7 h-7" />
              Checkout
            </button>
          </div>
        </>
      )}

      {/* Toast */}
      {toast && (
        <div
          className="
            fixed bottom-6 right-6 z-50
            bg-brutal-black text-white px-6 py-3
            font-bold uppercase text-sm
            border-3 border-brutal-yellow
            shadow-[4px_4px_0px_0px_rgba(255,229,102,0.8)]
            animate-bounce
          "
        >
          {toast}
        </div>
      )}
    </>
  );
}
