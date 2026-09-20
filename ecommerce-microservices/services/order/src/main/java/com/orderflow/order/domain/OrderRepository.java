package com.orderflow.order.domain;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.LockModeType;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface OrderRepository extends JpaRepository<Order, UUID> {

    /** OWNERSHIP: every user-facing read filters by user — someone else's order is simply "not found". */
    Optional<Order> findByIdAndUserId(UUID id, String userId);

    Page<Order> findByUserId(String userId, Pageable pageable);

    Optional<Order> findByUserIdAndIdempotencyKey(String userId, String idempotencyKey);

    /** Row lock so two transitions for one order (event vs. user vs. reconciliation) serialise. */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select o from Order o where o.id = :id")
    Optional<Order> lockById(@Param("id") UUID id);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select o from Order o where o.id = :id and o.userId = :userId")
    Optional<Order> lockByIdAndUserId(@Param("id") UUID id, @Param("userId") String userId);

    /** Reconciliation candidates (partial index orders_awaiting_payment_idx); each is re-locked individually. */
    @Query(value = """
            select id from orders
            where status = 'AWAITING_PAYMENT' and updated_at <= :before
            order by updated_at
            limit :limit
            """, nativeQuery = true)
    List<UUID> findStuckAwaitingPayment(@Param("before") Instant before, @Param("limit") int limit);

    @Query(value = """
            select * from orders
            where id = :id and status = 'AWAITING_PAYMENT'
            for update skip locked
            """, nativeQuery = true)
    Optional<Order> lockStuck(@Param("id") UUID id);
}
