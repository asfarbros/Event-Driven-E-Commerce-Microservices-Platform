package com.orderflow.inventory.domain;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface InventoryRepository extends JpaRepository<Inventory, String> {

    /**
     * {@code SELECT ... FROM inventory WHERE product_id = ? FOR UPDATE}.
     *
     * The heart of the concurrency guarantee. PESSIMISTIC_WRITE takes a row
     * lock that every other reserve / confirm / release / adjust for the same
     * product must wait for (or give up on after lock_timeout), so the
     * check-then-decrement that follows can never interleave with another
     * transaction's. Must be called inside a transaction; the lock is held
     * until that transaction commits or rolls back.
     *
     * Callers lock several products by calling this in ASCENDING productId
     * order — see {@code service/LockOrder}.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select i from Inventory i where i.productId = :productId")
    Optional<Inventory> lockByProductId(@Param("productId") String productId);

    /** Bulk read without locks: one query for POST /stock/bulk (no N+1). */
    List<Inventory> findAllByProductIdIn(Collection<String> productIds);
}
