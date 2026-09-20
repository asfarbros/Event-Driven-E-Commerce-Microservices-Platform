package com.orderflow.payment.domain;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface PaymentTransactionRepository extends JpaRepository<PaymentTransaction, UUID> {

    Optional<PaymentTransaction> findByOrderId(String orderId);

    /** Row lock so two state transitions for one order (webhook vs reconciliation vs refund) serialise. */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select p from PaymentTransaction p where p.orderId = :orderId")
    Optional<PaymentTransaction> lockByOrderId(@Param("orderId") String orderId);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select p from PaymentTransaction p where p.razorpayOrderId = :razorpayOrderId")
    Optional<PaymentTransaction> lockByRazorpayOrderId(@Param("razorpayOrderId") String razorpayOrderId);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select p from PaymentTransaction p where p.razorpayPaymentId = :razorpayPaymentId")
    Optional<PaymentTransaction> lockByRazorpayPaymentId(@Param("razorpayPaymentId") String razorpayPaymentId);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select p from PaymentTransaction p where p.id = :id")
    Optional<PaymentTransaction> lockById(@Param("id") UUID id);

    /**
     * Reconciliation candidates: unsettled rows that have not changed for a
     * while (uses the partial index payment_unsettled_updated_idx). No locks —
     * each candidate is re-locked and re-checked in its own transaction.
     */
    @Query(value = """
            select id from payment_transaction
            where status in ('CREATED', 'PENDING', 'REFUND_PENDING') and updated_at <= :before
            order by updated_at
            limit :limit
            """, nativeQuery = true)
    List<UUID> findStuckIds(@Param("before") Instant before, @Param("limit") int limit);

    /** Re-lock ONE candidate, skipping rows another worker holds. */
    @Query(value = """
            select * from payment_transaction
            where id = :id and status in ('CREATED', 'PENDING', 'REFUND_PENDING')
            for update skip locked
            """, nativeQuery = true)
    Optional<PaymentTransaction> lockStuck(@Param("id") UUID id);
}
