import { useEffect, useState } from "react";
import { useAuth } from "@clerk/clerk-react";
import { Loader, AlertTriangle, PackageSearch } from "lucide-react";
import api from "../lib/api";
import ProductCard from "../components/ProductCard";

interface Product {
  _id: string;
  name: string;
  description: string;
  price: number;
}

export default function CatalogPage() {
  const { getToken } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    fetchProducts();
  }, []);

  async function fetchProducts() {
    try {
      setLoading(true);
      setError(null);
      const res = await api.get("/api/catalog");
      setProducts(res.data.products || []);
    } catch (err: any) {
      setError(err.message || "Failed to load products");
    } finally {
      setLoading(false);
    }
  }

  async function handleAddToCart(productId: string) {
    try {
      setAddingId(productId);
      const token = await getToken();
      await api.post(
        "/api/cart",
        { productId, quantity: 1 },
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );
      showToast("Added to cart!");
    } catch {
      showToast("Failed to add – are you signed in?");
    } finally {
      setAddingId(null);
    }
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  /* ─── Loading State ────────────────────────────── */
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-32 gap-4">
        <div className="bg-brutal-yellow border-3 border-brutal-black p-6 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]">
          <Loader className="w-10 h-10 text-brutal-black animate-spin" />
        </div>
        <p className="text-lg font-bold uppercase">Loading products...</p>
      </div>
    );
  }

  /* ─── Error State ──────────────────────────────── */
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-32 gap-4">
        <div className="bg-brutal-pink border-3 border-brutal-black p-6 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]">
          <AlertTriangle className="w-10 h-10 text-brutal-black" />
        </div>
        <p className="text-lg font-bold uppercase">Error</p>
        <p className="text-sm text-brutal-black/70">{error}</p>
        <button
          onClick={fetchProducts}
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

  /* ─── Empty State ──────────────────────────────── */
  if (products.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-32 gap-4">
        <div className="bg-brutal-blue border-3 border-brutal-black p-6 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]">
          <PackageSearch className="w-10 h-10 text-brutal-black" />
        </div>
        <p className="text-lg font-bold uppercase">No products found</p>
      </div>
    );
  }

  /* ─── Product Grid ─────────────────────────────── */
  return (
    <>
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-5xl font-bold uppercase tracking-tighter text-brutal-black">
          Catalog
        </h1>
        <div className="mt-2 h-2 w-32 bg-brutal-black" />
      </div>

      {/* Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {products.map((product) => (
          <ProductCard
            key={product._id}
            product={product}
            onAddToCart={handleAddToCart}
            isAdding={addingId === product._id}
          />
        ))}
      </div>

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
