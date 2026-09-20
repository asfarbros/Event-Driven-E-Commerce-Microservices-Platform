package com.orderflow.inventory.domain;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ReservationRepository extends JpaRepository<Reservation, UUID> {

    Optional<Reservation> findByOrderId(String orderId);

    /**
     * Row-locks the reservation header so two state transitions for the same
     * hold (confirm vs. sweeper, release vs. release) are serialised. The
     * second one sees the status the first one committed and becomes a no-op.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select r from Reservation r where r.orderId = :orderId")
    Optional<Reservation> lockByOrderId(@Param("orderId") String orderId);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select r from Reservation r where r.id = :id")
    Optional<Reservation> lockById(@Param("id") UUID id);

    /**
     * Sweeper, step 1: candidate ids (no locks, uses the partial index
     * reservation_held_expires_idx). Oldest expiry first.
     */
    @Query(value = """
            select id from reservation
            where status = 'HELD' and expires_at <= :now
            order by expires_at
            limit :limit
            """, nativeQuery = true)
    List<UUID> findExpiredHeldIds(@Param("now") Instant now, @Param("limit") int limit);

    /**
     * Sweeper, step 2: re-check and lock ONE candidate.
     * <ul>
     *   <li>{@code FOR UPDATE} — nobody else can confirm/release it while we work.</li>
     *   <li>{@code SKIP LOCKED} — if another sweeper instance (or a concurrent
     *       release/confirm) already holds the row we skip it instead of
     *       queueing; that transaction will finish the job.</li>
     *   <li>The status / expires_at predicates are re-evaluated under the lock,
     *       so a hold confirmed between step 1 and step 2 is not touched.</li>
     * </ul>
     * Together these make it impossible for a reservation to be released twice.
     */
    @Query(value = """
            select * from reservation
            where id = :id and status = 'HELD' and expires_at <= :now
            for update skip locked
            """, nativeQuery = true)
    Optional<Reservation> lockExpiredHeld(@Param("id") UUID id, @Param("now") Instant now);
}
