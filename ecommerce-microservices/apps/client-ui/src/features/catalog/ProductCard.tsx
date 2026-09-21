import { Link } from 'react-router';
import type { Product } from '@/api/types';
import { ProductImage } from '@/components/ui/States';
import { Price } from '@/components/ui/Price';

/** Minimal card: image, name, price. The whole card is the link; a gentle lift on hover. */
export function ProductCard({ product, priority = false }: { product: Product; priority?: boolean }) {
  return (
    <Link to={`/products/${product.id}`} className="group flex flex-col gap-3 rounded-lg focus-visible:shadow-focus">
      <div className="overflow-hidden rounded-lg transition-transform duration-(--duration-base) ease-(--ease-out-soft) group-hover:-translate-y-0.5">
        <ProductImage src={product.imageUrl} alt={product.name} priority={priority} sizes="(min-width: 1024px) 25vw, (min-width: 640px) 33vw, 50vw"
          className="transition-[filter] duration-(--duration-base) group-hover:brightness-[0.97]" />
      </div>
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-lg leading-snug text-ink group-hover:text-accent">{product.name}</h2>
        <Price paise={product.priceInPaise} currency={product.currency} />
      </div>
    </Link>
  );
}
