import { ShoppingCart, Package } from "lucide-react";

interface Product {
  _id: string;
  name: string;
  description: string;
  price: number;
}

interface ProductCardProps {
  product: Product;
  onAddToCart: (productId: string) => void;
  isAdding: boolean;
}

const CARD_COLORS = [
  "bg-brutal-pink",
  "bg-brutal-blue",
  "bg-brutal-green",
  "bg-brutal-orange",
  "bg-brutal-lilac",
  "bg-brutal-yellow",
];

export default function ProductCard({
  product,
  onAddToCart,
  isAdding,
}: ProductCardProps) {
  const colorClass = CARD_COLORS[Math.abs(hashCode(product._id)) % CARD_COLORS.length];

  return (
    <div
      className={`
        ${colorClass} border-3 border-brutal-black p-6
        shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]
        hover:shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]
        hover:-translate-x-[1px] hover:-translate-y-[1px]
        transition-all duration-150
        flex flex-col justify-between
      `}
    >
      {/* ─── Icon Badge ──────────────────────────── */}
      <div className="mb-4">
        <div className="inline-block bg-brutal-black p-2 border-3 border-brutal-black shadow-[3px_3px_0px_0px_rgba(0,0,0,0.3)]">
          <Package className="w-5 h-5 text-white" />
        </div>
      </div>

      {/* ─── Content ─────────────────────────────── */}
      <div className="flex-1">
        <h3 className="text-xl font-bold text-brutal-black uppercase tracking-tight mb-2">
          {product.name}
        </h3>
        <p className="text-sm text-brutal-black/80 mb-4 leading-relaxed">
          {product.description}
        </p>
      </div>

      {/* ─── Footer ──────────────────────────────── */}
      <div className="mt-4 flex items-end justify-between gap-3">
        <div>
          <div className="text-3xl font-bold text-brutal-black">
            ${product.price.toFixed(2)}
          </div>
        </div>

        <button
          onClick={() => onAddToCart(product._id)}
          disabled={isAdding}
          className="
            bg-brutal-black text-white px-4 py-3
            font-bold uppercase text-sm
            border-3 border-brutal-black
            shadow-[4px_4px_0px_0px_rgba(107,107,107,0.5)]
            hover:translate-x-[2px] hover:translate-y-[2px]
            hover:shadow-[2px_2px_0px_0px_rgba(107,107,107,0.5)]
            active:translate-x-[4px] active:translate-y-[4px]
            active:shadow-none
            transition-all duration-100
            cursor-pointer disabled:opacity-50
            flex items-center gap-2
          "
        >
          <ShoppingCart className="w-4 h-4" />
          {isAdding ? "Adding..." : "Add"}
        </button>
      </div>
    </div>
  );
}

/** Simple string hash for deterministic color assignment */
function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}
