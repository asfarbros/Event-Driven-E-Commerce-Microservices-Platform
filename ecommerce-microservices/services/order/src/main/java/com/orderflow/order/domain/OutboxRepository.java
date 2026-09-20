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

public interface OutboxRepository extends JpaRepository<OutboxEvent, UUID> {

    /** Relay step 1: unpublished ids, oldest first (partial index outbox_unpublished_idx). */
    @Query(value = """
            select id from outbox_event
            where published_at is null
            order by created_at
            limit :limit
            """, nativeQuery = true)
    List<UUID> findUnpublishedIds(@Param("limit") int limit);

    /** Relay step 2: lock ONE row, skipping rows another relay instance holds. */
    @Query(value = """
            select * from outbox_event
            where id = :id and published_at is null
            for update skip locked
            """, nativeQuery = true)
    Optional<OutboxEvent> lockUnpublished(@Param("id") UUID id);

    List<OutboxEvent> findByOrderIdOrderByCreatedAt(String orderId);

    long countByPublishedAtIsNull();

    boolean existsByMessageId(String messageId);
}
