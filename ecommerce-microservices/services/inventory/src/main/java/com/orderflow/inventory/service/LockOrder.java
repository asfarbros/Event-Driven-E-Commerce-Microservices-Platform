package com.orderflow.inventory.service;

import java.util.Collection;
import java.util.List;
import java.util.function.Function;

/**
 * DETERMINISTIC LOCK ORDERING — the deadlock guard.
 *
 * <p>Two transactions that each need locks on products A and B deadlock if one
 * takes A then B while the other takes B then A: each waits forever for the
 * row the other holds (PostgreSQL would detect it after a second and kill one
 * with 40P01, but that is a failed checkout, not a design).
 *
 * <p>The fix is a global order: EVERY transaction in this service acquires
 * inventory row locks in ascending {@code productId} order, whatever order the
 * caller listed the items in. With a single total order, a transaction can
 * only ever wait for rows that sort AFTER the ones it already holds, so no
 * cycle of waits can form. Two concurrent multi-item orders for {A, B} and
 * {B, A} both lock A first; one of them simply waits.
 *
 * <p>The reservation header row, when a path locks one (confirm / release /
 * expiry), is always taken BEFORE any inventory rows and only one per
 * transaction, which keeps the global order consistent across both tables.
 */
public final class LockOrder {

    private LockOrder() {
    }

    /** Returns the elements sorted by their product id, ascending (natural String order). */
    public static <T> List<T> sorted(Collection<T> items, Function<T, String> productId) {
        return items.stream()
                .sorted((a, b) -> productId.apply(a).compareTo(productId.apply(b)))
                .toList();
    }

    /** Convenience for plain id collections. */
    public static List<String> sortedIds(Collection<String> productIds) {
        return productIds.stream().sorted().toList();
    }
}
