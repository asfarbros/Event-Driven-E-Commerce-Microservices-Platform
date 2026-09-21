import { useEffect, useId, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useCategories, useProducts } from '@/api/queries';
import type { ProductSort } from '@/api/types';
import { Container } from '@/components/layout/Shell';
import { ProductCard } from '@/features/catalog/ProductCard';
import { ProductCardSkeleton } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { cn } from '@/lib/cn';

const PAGE_SIZE = 12;
const SORTS: Array<{ value: ProductSort; label: string }> = [
  { value: 'newest', label: 'Newest' }, { value: 'price_asc', label: 'Price: low to high' },
  { value: 'price_desc', label: 'Price: high to low' }, { value: 'name_asc', label: 'Name A–Z' },
];
const pretty = (slug: string) => slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' & ');

/** Product listing — fully public. Filters live in the URL so a page can be shared and refreshed. */
export function ProductListPage() {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page') || 1));
  const category = params.get('category') || undefined;
  const q = params.get('q') || undefined;
  const sort = (params.get('sort') as ProductSort) || (q ? 'relevance' : 'newest');
  const [search, setSearch] = useState(q ?? '');
  const searchId = useId();
  useEffect(() => setSearch(q ?? ''), [q]);

  const set = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    if (!('page' in patch)) next.delete('page');
    setParams(next);
  };

  const products = useProducts({ page, limit: PAGE_SIZE, category, q, sort });
  const categories = useCategories();
  const list = products.data;

  return (
    <Container className="py-8 sm:py-12">
      <header className="flex flex-col gap-6">
        <div>
          <p className="eyebrow">Shop</p>
          <h1 className="mt-1 text-3xl sm:text-4xl">{category ? pretty(category) : 'Everything'}</h1>
        </div>

        <form role="search" className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); set({ q: search.trim() || undefined, sort: undefined }); }}>
          <div className="flex-1">
            <Input id={searchId} type="search" label="Search" placeholder="Search products" value={search} onChange={(e) => setSearch(e.target.value)} autoComplete="off" />
          </div>
          <div className="w-full sm:w-52">
            <Select label="Sort by" value={sort} onChange={(e) => set({ sort: e.target.value })}>
              {q && <option value="relevance">Relevance</option>}
              {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </Select>
          </div>
          <Button type="submit" variant="secondary" className="sm:w-auto">Search</Button>
        </form>

        <nav aria-label="Categories" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <ul className="flex gap-2">
            {[undefined, ...(categories.data ?? [])].map((c) => {
              const active = (c ?? '') === (category ?? '');
              return (
                <li key={c ?? 'all'}>
                  <button type="button" onClick={() => set({ category: c })} aria-pressed={active}
                    className={cn('whitespace-nowrap rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors duration-(--duration-fast)',
                      active ? 'border-accent bg-accent-soft text-accent' : 'border-border-strong bg-surface text-ink hover:bg-surface-2')}>
                    {c ? pretty(c) : 'All'}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      </header>

      <section aria-label="Products" aria-busy={products.isFetching || undefined} className="mt-8">
        {products.isPending ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => <ProductCardSkeleton key={i} />)}
          </div>
        ) : products.isError ? (
          <ErrorState error={products.error} onRetry={() => products.refetch()} />
        ) : list && list.items.length === 0 ? (
          <EmptyState title={q ? `No results for “${q}”` : 'Nothing here yet'}
            description={q ? 'Try a different word, or browse a category.' : 'Check back soon.'}
            action={(q || category) ? <Button variant="secondary" onClick={() => set({ q: undefined, category: undefined })}>Show everything</Button> : undefined} />
        ) : list ? (
          <>
            <p className="text-sm text-muted tabular" aria-live="polite">
              {list.pagination.total} product{list.pagination.total === 1 ? '' : 's'}{q ? ` for “${q}”` : ''}
            </p>
            <div className={cn('mt-4 grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4 transition-opacity duration-(--duration-fast)', products.isFetching && 'opacity-60')}>
              {list.items.map((p, i) => <ProductCard key={p.id} product={p} priority={i < 4} />)}
            </div>
            {list.pagination.totalPages > 1 && (
              <nav aria-label="Pagination" className="mt-10 flex items-center justify-center gap-3">
                <Button variant="secondary" size="sm" disabled={!list.pagination.hasPrev} onClick={() => set({ page: String(page - 1) })}>Previous</Button>
                <span className="text-sm text-muted tabular">Page {list.pagination.page} of {list.pagination.totalPages}</span>
                <Button variant="secondary" size="sm" disabled={!list.pagination.hasNext} onClick={() => set({ page: String(page + 1) })}>Next</Button>
              </nav>
            )}
          </>
        ) : null}
      </section>
    </Container>
  );
}
